"""Fitness: an LLM judge that answers in language, not just in a number.

**This is the part that makes it GEPA rather than random search.** GEPA's metric
protocol (`GEPAFeedbackMetric`) may return either a bare float or a
`dspy.Prediction(score, feedback)`, and the optimizer reflects on the *feedback*
to decide how to mutate the instruction. A metric that returns only a float
leaves it with nothing to reason about, so it falls back to "this trajectory got
a score of 0.6" — which is resampling with extra steps.

Verified against dspy 3.3.0: the signature is
``(gold, pred, trace, pred_name, pred_trace, program_trace=None)``, and the
extra arguments are how GEPA asks for feedback about one predictor rather than
the whole program.
"""

from __future__ import annotations

from typing import Any

import dspy  # type: ignore[import-not-found]

# Past 90% of the size limit a candidate starts paying, reaching a full 0.3 at
# the limit. A ramp rather than a cliff, so the optimizer can feel the cost
# before it is refused outright by the constraint gate.
PENALTY_FROM = 0.9
MAX_PENALTY = 0.3


class Judge(dspy.Signature):
    """Score a response against what the task expected, and say what to fix.

    Score three dimensions from 0.0 to 1.0, then write feedback that names a
    concrete change to the procedure. Feedback that only restates the score is
    useless; feedback that says which step was missing, ambiguous or misordered
    is what improves the skill.
    """

    task: str = dspy.InputField(desc="What the assistant was asked to do")
    expected: str = dspy.InputField(desc="What a good response looks like")
    response: str = dspy.InputField(desc="What the assistant actually produced")
    skill: str = dspy.InputField(desc="The procedure it was following")

    correctness: float = dspy.OutputField(desc="0.0-1.0: did it address the task correctly?")
    procedure: float = dspy.OutputField(desc="0.0-1.0: did it follow the procedure?")
    conciseness: float = dspy.OutputField(desc="0.0-1.0: appropriately brief without omitting?")
    feedback: str = dspy.OutputField(
        desc="What to change in the procedure, specifically. Name the step."
    )


def _score(value: Any) -> float:
    """Clamp a judged score. Models return '0.8', 0.8, or occasionally prose."""
    if isinstance(value, (int, float)):
        return min(1.0, max(0.0, float(value)))
    try:
        return min(1.0, max(0.0, float(str(value).strip())))
    except (TypeError, ValueError):
        return 0.5


def composite(correctness: float, procedure: float, conciseness: float, penalty: float) -> float:
    """Weighted, then penalised.

    Correctness dominates because a concise procedure that produces wrong
    answers is worthless, while a verbose one that works is merely annoying.
    """
    raw = 0.5 * correctness + 0.3 * procedure + 0.2 * conciseness
    return max(0.0, raw - penalty)


def length_penalty(size: int, limit: int) -> float:
    ratio = size / limit if limit > 0 else 0.0
    if ratio <= PENALTY_FROM:
        return 0.0
    return min(MAX_PENALTY, (ratio - PENALTY_FROM) * (MAX_PENALTY / (1 - PENALTY_FROM)))


class SkillJudge:
    """Holds the judge and the running record of what it said."""

    def __init__(self, limit: int, on_score: Any = None) -> None:
        self.judge = dspy.ChainOfThought(Judge)
        self.limit = limit
        self.on_score = on_score
        self.calls = 0
        # Every breakdown this judge has produced, in order. The metric can only
        # return one number, so this is how a caller measuring a whole program
        # gets the dimensions back rather than just the composite.
        self.recorded: list[dict[str, float]] = []

    def metric(
        self,
        gold: Any,
        pred: Any,
        trace: Any = None,
        pred_name: str | None = None,
        pred_trace: Any = None,
        program_trace: Any = None,
    ) -> Any:
        """The `GEPAFeedbackMetric` GEPA calls, and DSPy's plain metric too.

        Returns a `dspy.Prediction` carrying both, which satisfies both callers:
        DSPy reads `.score` where it wants a float, GEPA reads `.feedback` where
        it wants something to reflect on.
        """
        del trace, pred_name, pred_trace, program_trace  # GEPA's, not needed here

        task = str(getattr(gold, "task", "") or "")
        expected = str(getattr(gold, "expected", "") or "")
        skill = str(getattr(gold, "skill", "") or "")
        response = str(getattr(pred, "response", "") or "")

        if response.strip() == "":
            return dspy.Prediction(
                score=0.0,
                feedback="The procedure produced no response at all. It is probably missing a "
                "statement of what to output.",
            )

        try:
            verdict = self.judge(task=task, expected=expected, response=response, skill=skill)
        except Exception as error:  # noqa: BLE001 - a judge failure must not end the run
            # Neutral rather than zero: a judge that timed out has said nothing
            # about the candidate, and scoring it zero would teach the optimizer
            # that whatever it just tried was catastrophic.
            return dspy.Prediction(score=0.5, feedback=f"The judge could not score this: {error}")

        correctness = _score(verdict.correctness)
        procedure = _score(verdict.procedure)
        conciseness = _score(verdict.conciseness)
        penalty = length_penalty(len(skill.encode("utf-8")), self.limit)
        total = composite(correctness, procedure, conciseness, penalty)
        feedback = str(verdict.feedback or "").strip()

        self.calls += 1
        breakdown = {
            "correctness": correctness,
            "procedureFollowing": procedure,
            "conciseness": conciseness,
            "lengthPenalty": penalty,
            "composite": total,
        }
        self.recorded.append(breakdown)
        if self.on_score is not None:
            self.on_score(breakdown, feedback)

        if penalty > 0:
            feedback = (
                f"{feedback}\n\nThe procedure is also close to the size limit "
                f"({len(skill.encode('utf-8'))} of {self.limit} bytes). Prefer cutting a "
                "redundant step over adding one."
            )

        return dspy.Prediction(score=total, feedback=feedback)
