"""One evolution run.

The shape is the reference implementation's, with its GEPA call corrected.
**Verified against dspy 3.3.0**, where the reference's
``dspy.GEPA(metric=..., max_steps=n)`` raises ``TypeError`` and falls into its
own MIPROv2 fallback — so the reference never actually runs GEPA. The real
constructor takes a budget as ``auto``/``max_full_evals``/``max_metric_calls``,
requires a ``reflection_lm``, and ``compile`` takes ``trainset``/``valset`` as
keyword arguments.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import dspy  # type: ignore[import-not-found]

from . import constraints, dataset
from .fitness import SkillJudge
from .protocol import (
    candidate,
    constraint,
    done,
    failed,
    log,
    quiet_stdout,
    status,
)
from .skill_module import SkillModule, reassemble, split_skill


@dataclass(slots=True)
class Request:
    name: str
    markdown: str
    budget: int
    limit: int


def _blank_score() -> dict[str, float]:
    return {
        "correctness": 0.0,
        "procedureFollowing": 0.0,
        "conciseness": 0.0,
        "lengthPenalty": 0.0,
        "composite": 0.0,
    }


def _mean(scores: list[dict[str, float]]) -> dict[str, float]:
    if not scores:
        return _blank_score()
    keys = list(scores[0].keys())
    return {key: sum(score[key] for score in scores) / len(scores) for key in keys}


def _measure(module: Any, valset: list[Any], judge: SkillJudge) -> dict[str, float]:
    """Score one program across the validation set.

    Used for both the baseline and the winner, deliberately with the same
    examples and the same judge, because a comparison between numbers produced
    two different ways is not a comparison. The validation split is used rather
    than the training one: the optimizer has been fitting to the latter, so a
    score from it measures memorisation as much as improvement.

    An example that raises is skipped rather than scored zero. A model that
    errored has said nothing about the procedure, and counting that as a
    catastrophic score would make the comparison a measure of flakiness.
    """
    scores: list[dict[str, float]] = []
    with quiet_stdout():
        for example in valset:
            try:
                prediction = module(task=example.task)
            except Exception as error:  # noqa: BLE001
                log("example failed while measuring", error=str(error))
                continue
            before = len(judge.recorded)
            judge.metric(example, prediction)
            # The judge records the full breakdown as it scores; reading it back
            # keeps every dimension rather than only the composite the metric
            # returns.
            if len(judge.recorded) > before:
                scores.append(judge.recorded[-1])
    return _mean(scores)


def run(request: Request, lm: Any, reflection_lm: Any) -> None:
    """Evolve one skill, streaming progress, and emit the result."""
    frontmatter, body = split_skill(request.markdown)
    if body.strip() == "":
        failed("This skill has no procedure to improve — its body is empty.")
        return

    dspy.configure(lm=lm)

    status("preparing", "Inventing tasks to evaluate the skill against")
    with quiet_stdout():
        trainset, valset = dataset.build(body)
    if not trainset:
        failed(
            "No evaluation tasks could be generated for this skill, so there is nothing to "
            "measure an improvement against."
        )
        return

    # Every judged example is reported as it happens. The reading is per
    # example, not per candidate: GEPA does not expose an iteration counter, and
    # inventing one would be a decoration over work whose real unit is the
    # evaluation.
    seen: list[dict[str, float]] = []

    def observe(score: dict[str, float], feedback: str) -> None:
        seen.append(score)
        candidate(len(seen), score, feedback)

    judge = SkillJudge(limit=request.limit, on_score=observe)
    student = SkillModule(body)

    status("baseline", "Scoring the skill as it stands")
    baseline = _measure(student, valset, judge)

    status("evolving", "GEPA is rewriting the procedure and re-scoring it")
    try:
        with quiet_stdout():
            optimizer = dspy.GEPA(
                metric=judge.metric,
                # The budget is the user's, expressed as evaluations. `auto`
                # would let the optimizer decide how much of someone's money to
                # spend, which is not its decision to make.
                max_metric_calls=request.budget,
                # Mandatory: without it the constructor asserts. This is the
                # model that reads the feedback and proposes the rewrite, so it
                # is the one that has to be able to reason.
                reflection_lm=reflection_lm,
                candidate_selection_strategy="pareto",
                # One thread. The app shows this run live and the surface reads
                # better in order; parallelism here buys latency at the cost of
                # a progress reading that jumps around.
                num_threads=1,
                track_stats=False,
                # The fitness function is an LLM judge, so scoring the same
                # candidate twice legitimately gives slightly different numbers.
                # GEPA warns about that because it can also mean a metric is
                # returning predictor-level scores by mistake; here it is the
                # documented benign case, and leaving the warning on puts a
                # paragraph of noise on stderr after most evaluations.
                warn_on_score_mismatch=False,
            )
            evolved_module = optimizer.compile(student, trainset=trainset, valset=valset)
    except Exception as error:  # noqa: BLE001
        # No fallback to a different optimizer. The reference has one, and it is
        # how its GEPA call came to be silently broken for so long: a fallback
        # that runs quietly means nobody finds out the real path never ran.
        failed(f"The optimizer failed: {error}")
        return

    evolved_body = str(getattr(evolved_module, "skill_text", "") or "").strip()
    if evolved_body == "" or evolved_body == body.strip():
        # Not a failure of the machinery: GEPA kept the original because none of
        # the rewrites it tried beat it on the validation set. Say that, with
        # the effort spent, rather than implying something went wrong.
        failed(
            f"GEPA evaluated {len(seen)} responses and kept the original procedure \u2014 none of "
            "the rewrites it tried scored better. Try a larger budget."
        )
        return

    status("validating", "Checking the rewrite against the constraint gates")
    with quiet_stdout():
        checks = constraints.all_checks(body, evolved_body, request.limit)
    for check in checks:
        constraint(check.name, check.passed, check.message)
    blocked = [check for check in checks if not check.passed]
    if blocked:
        failed(
            "The rewrite scored well but did not pass its gates: "
            + "; ".join(f"{check.name} ({check.message})" for check in blocked)
        )
        return

    # **Measured on the same examples as the baseline**, which is the only
    # comparison that means anything. The obvious shortcut -- averaging the
    # scores seen during evolution -- is wrong twice over: GEPA deliberately
    # evaluates bad mutations, so that mean sits below the winner and would
    # reject genuine improvements; and it is computed over the training split,
    # which the optimizer has been fitting to.
    best = _measure(evolved_module, valset, judge)

    # Improvement is measured, not assumed. GEPA returns its best candidate
    # whether or not that beats where it started, and proposing a regression for
    # review wastes the reviewer's attention.
    if best["composite"] <= baseline["composite"]:
        failed(
            f"The best rewrite scored {best['composite']:.2f} against the original's "
            f"{baseline['composite']:.2f}, so there is nothing worth proposing."
        )
        return

    done(reassemble(frontmatter, evolved_body), best, baseline)
