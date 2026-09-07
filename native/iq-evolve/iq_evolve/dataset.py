"""Building something to evaluate a skill against.

There is no golden dataset for "did this skill work", and inventing one by hand
per skill would mean the feature only ever applies to skills someone has already
written an eval for. So the tasks are generated from the skill's own text: the
model is asked what someone would realistically use this procedure for, and what
a good answer to each would contain.

That is circular in a way worth being honest about, and it is bounded on
purpose: the generated set says what the skill is *for*, and the judge scores
whether a response *followed* it. Neither is a claim that the skill's goals are
the right ones — which is why the output is a proposal a person reads, not an
installed skill.
"""

from __future__ import annotations

import random
from typing import Any

import dspy  # type: ignore[import-not-found]

from .protocol import log


class ProposeTasks(dspy.Signature):
    """Invent realistic tasks for a procedure, and say what a good answer holds.

    Cover the ordinary path and the awkward cases: missing input, an ambiguous
    request, and one where the procedure's own edge case applies. Each expected
    answer describes what a good response must contain, not the response itself.
    """

    skill: str = dspy.InputField(desc="The procedure, as written")
    count: int = dspy.InputField(desc="How many tasks to invent")
    tasks: list[str] = dspy.OutputField(desc="The tasks, each one a realistic user request")
    expectations: list[str] = dspy.OutputField(
        desc="For each task in order, what a good response must contain"
    )


def build(skill_text: str, count: int = 12, seed: int = 0) -> tuple[list[Any], list[Any]]:
    """Generate the evaluation set and split it into train and validation.

    Split rather than reused, because GEPA selects on the validation set: an
    optimizer scored on the same examples it mutated against reports its own
    overfitting as improvement.
    """
    proposer = dspy.Predict(ProposeTasks)
    result = proposer(skill=skill_text, count=count)

    tasks = list(getattr(result, "tasks", []) or [])
    expectations = list(getattr(result, "expectations", []) or [])
    pairs = [
        (str(task), str(expected))
        for task, expected in zip(tasks, expectations)
        if str(task).strip() != ""
    ]
    if not pairs:
        return [], []

    examples = [
        dspy.Example(task=task, expected=expected, skill=skill_text).with_inputs("task")
        for task, expected in pairs
    ]
    random.Random(seed).shuffle(examples)

    # Two thirds to train. With a set this small a validation half would leave
    # too few examples to mutate against, and GEPA needs both to be non-empty.
    cut = max(1, (len(examples) * 2) // 3)
    train, val = examples[:cut], examples[cut:]
    if not val:
        val = train[-1:]
    log("evaluation set built", train=len(train), val=len(val))
    return train, val
