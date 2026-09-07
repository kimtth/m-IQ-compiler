"""The gates a candidate must pass before it is proposed at all.

Scores rank candidates; these decide whether the winner is allowed out. The
distinction matters because the failure mode of an optimizer is to win the
metric by breaking something the metric does not measure — a skill that scores
better because it quietly dropped half its procedure has not improved, and no
weighting of correctness against conciseness would catch it.

Every check here is about the *artifact*, not the answers it produced.
"""

from __future__ import annotations

from dataclasses import dataclass

import dspy  # type: ignore[import-not-found]


@dataclass(slots=True)
class Check:
    name: str
    passed: bool
    message: str


def size(body: str, limit: int) -> Check:
    used = len(body.encode("utf-8"))
    return Check(
        name="size",
        passed=used <= limit,
        message=f"{used} of {limit} bytes",
    )


def not_empty(body: str) -> Check:
    stripped = body.strip()
    return Check(
        name="not empty",
        passed=len(stripped) > 40,
        message=f"{len(stripped)} characters"
        if len(stripped) > 40
        else "the evolved procedure is empty or near-empty",
    )


def coverage(baseline: str, evolved: str) -> Check:
    """Did the rewrite keep the structure it started with?

    Headings are the cheapest honest proxy for "the procedure still has its
    steps": they are what a skill's sections are, and an optimizer that deletes
    a section deletes its heading with it. Deliberately not a similarity score —
    a rewrite *should* change the wording, and penalising that would select for
    doing nothing.
    """
    before = {
        line.strip().lstrip("#").strip().lower()
        for line in baseline.splitlines()
        if line.strip().startswith("#")
    }
    if not before:
        return Check(name="section coverage", passed=True, message="the original had no sections")
    after = {
        line.strip().lstrip("#").strip().lower()
        for line in evolved.splitlines()
        if line.strip().startswith("#")
    }
    lost = before - after
    # One dropped section is a rewrite; a third of them is a different document.
    allowed = max(1, len(before) // 3)
    return Check(
        name="section coverage",
        passed=len(lost) <= allowed,
        message=(
            f"kept {len(before) - len(lost)} of {len(before)} sections"
            + (f"; dropped {', '.join(sorted(lost))}" if lost else "")
        ),
    )


class Preserved(dspy.Signature):
    """Decide whether a rewritten procedure still does the same job.

    Wording, ordering and detail are all free to change — that is the point of
    the rewrite. What must not change is the purpose, the scope, and any
    constraint the original stated. Answer false if the rewrite drops a rule,
    widens what the procedure applies to, or changes what it is for.
    """

    original: str = dspy.InputField()
    rewritten: str = dspy.InputField()
    preserved: bool = dspy.OutputField(desc="Does it still do the same job under the same rules?")
    reason: str = dspy.OutputField(desc="One sentence naming what changed, or confirming it held")


def semantics(baseline: str, evolved: str) -> Check:
    """Ask a model whether the rewrite still means the same thing.

    A judgement, not a measurement, and treated as one: it can only *stop* a
    proposal, never approve a skill, and a person still reads whatever gets
    through.
    """
    try:
        verdict = dspy.Predict(Preserved)(original=baseline, rewritten=evolved)
    except Exception as error:  # noqa: BLE001
        # Cannot check is not the same as failed. Say so and let it through to
        # the human review that was always going to happen anyway.
        return Check(
            name="purpose preserved",
            passed=True,
            message=f"could not be checked ({error}) — read the diff closely",
        )
    return Check(
        name="purpose preserved",
        passed=bool(verdict.preserved),
        message=str(verdict.reason or "").strip(),
    )


def all_checks(baseline: str, evolved: str, limit: int) -> list[Check]:
    return [
        not_empty(evolved),
        size(evolved, limit),
        coverage(baseline, evolved),
        semantics(baseline, evolved),
    ]
