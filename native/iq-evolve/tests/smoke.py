"""Smoke tests that need no model.

Run with the sidecar's own interpreter:

    <IQ_HOME>/tools/evolve-py/Scripts/python.exe native/iq-evolve/tests/smoke.py

Everything here is either pure logic or a constructor. The one thing that is
worth proving against the real library is the GEPA call itself: the reference
implementation this was modelled on passes arguments DSPy no longer accepts, and
because it wraps the call in a fallback it never found out.
"""

from __future__ import annotations

import sys

import dspy  # type: ignore
from iq_evolve.constraints import coverage, not_empty, size
from iq_evolve.fitness import composite, length_penalty
from iq_evolve.skill_module import SkillModule, reassemble, split_skill

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        failures.append(name)


print("frontmatter is held aside, so identity and the tool grant cannot be rewritten")
front, body = split_skill("---\nname: x\nallowed-tools: [office]\n---\n\n## Steps\n\n1. Do it.\n")
check("frontmatter parsed", "allowed-tools" in front)
check("body excludes frontmatter", "allowed-tools" not in body)
check("round trips", "allowed-tools" in reassemble(front, body))
check("no frontmatter is tolerated", split_skill("Just a body")[1] == "Just a body")

print("the skill body is the signature's instruction, which is what GEPA mutates")
module = SkillModule("## Steps\n\n1. Read.\n")
check("skill_text reads back", module.skill_text.strip().startswith("## Steps"))

print("length penalty ramps rather than cliffs")
check("under the threshold is free", length_penalty(1000, 15000) == 0.0)
check("at the limit is capped", abs(length_penalty(15000, 15000) - 0.3) < 1e-9)
check("past the limit stays capped", length_penalty(30000, 15000) == 0.3)
check("penalty subtracts", abs(composite(1.0, 1.0, 1.0, 0.3) - 0.7) < 1e-9)

print("gates refuse what scores cannot see")
check("an emptied procedure fails", not not_empty("  ").passed)
check("an oversized one fails", not size("x" * 20000, 15000).passed)
check(
    "dropping most sections fails",
    not coverage("# A\n# B\n# C\n# D\n", "# A\n").passed,
)
check("rewording sections passes", coverage("# A\n# B\n", "# A\n# B\n text").passed)

print("roles survive the flattening into a single Copilot prompt")
from dspy.core.types import LMRequest  # type: ignore
from iq_evolve.copilot_lm import _flatten

request = LMRequest.from_call(
    model="m",
    items=(),
    prompt=None,
    messages=[
        {"role": "system", "content": "Return JSON only."},
        {"role": "user", "content": "Triage this bug."},
    ],
)
flat = _flatten(request)
# Copilot takes a prompt, not a role-tagged list. DSPy's adapters put the output
# format in the system message and the example in the user message, so a
# flattening that lost the distinction would get answers in the wrong shape.
check("system content is carried", "Return JSON only." in flat)
check("user content is carried", "Triage this bug." in flat)
check("the system role is labelled", "[instructions]" in flat)
check("an empty request flattens to nothing", _flatten(LMRequest(model="m", messages=[])) == "")

print("the GEPA call matches the installed DSPy")

def metric(gold, pred, trace=None, pred_name=None, pred_trace=None, program_trace=None):
    return dspy.Prediction(score=1.0, feedback="ok")


try:
    dspy.GEPA(
        metric=metric,
        max_metric_calls=10,
        reflection_lm=dspy.LM("openai/placeholder", api_key="none"),
        candidate_selection_strategy="pareto",
        num_threads=1,
        track_stats=False,
    )
    check("constructs", True)
except Exception as error:  # noqa: BLE001
    check("constructs", False, f"{type(error).__name__}: {error}")

# The reference's call, kept as a guard: if a future DSPy accepts it again this
# fails and the comment explaining why we do not use it can be revisited.
try:
    dspy.GEPA(metric=metric, max_steps=10)
    check("reference's max_steps is still rejected", False, "it was accepted")
except TypeError:
    check("reference's max_steps is still rejected", True)
except Exception as error:  # noqa: BLE001
    check("reference's max_steps is still rejected", True, f"({type(error).__name__})")

print()
if failures:
    print(f"{len(failures)} failed: {', '.join(failures)}")
    sys.exit(1)
print("all smoke tests passed")
