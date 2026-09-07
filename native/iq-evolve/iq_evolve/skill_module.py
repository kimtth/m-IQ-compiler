"""The skill, as something DSPy can optimize.

A skill is a Markdown procedure that goes into the system prompt. DSPy optimizes
*instructions on a signature*, so the bridge is simply this: the skill body is
the signature's instruction text. GEPA then mutates it, and whatever it settles
on is the evolved skill.

That is the whole trick, and it is why nothing here parses or restructures the
skill. A module that rewrote the body into fields would be optimizing its own
representation, and the text that came back out would no longer be the thing the
app puts in a prompt.
"""

from __future__ import annotations

import re
from typing import Any

import dspy  # type: ignore[import-not-found]


class FollowSkill(dspy.Signature):
    """Placeholder. Replaced per-run by the skill body itself."""

    task: str = dspy.InputField(desc="What the user asked for")
    response: str = dspy.OutputField(desc="The answer, produced by following the procedure")


class SkillModule(dspy.Module):
    """Runs a task under a skill's procedure.

    `skill_text` is the live value: GEPA rewrites the signature's instructions,
    so reading it back off the optimized module is how the evolved skill is
    recovered.
    """

    def __init__(self, skill_text: str) -> None:
        super().__init__()
        self.respond = dspy.Predict(FollowSkill.with_instructions(skill_text))

    @property
    def skill_text(self) -> str:
        return str(self.respond.signature.instructions)

    def forward(self, task: str) -> Any:
        return self.respond(task=task)


FRONTMATTER = re.compile(r"^---\r?\n(.*?)\r?\n---\r?\n?", re.DOTALL)


def split_skill(markdown: str) -> tuple[str, str]:
    """Separate the YAML frontmatter from the procedure.

    Only the body is evolved. The frontmatter carries `name`, `description` and
    `allowed-tools` — identity and the tool grant — and letting an optimizer
    rewrite those would let a run widen its own permissions to score better.
    """
    match = FRONTMATTER.match(markdown)
    if not match:
        return "", markdown
    return match.group(1), markdown[match.end() :]


def reassemble(frontmatter: str, body: str) -> str:
    if frontmatter.strip() == "":
        return body
    return f"---\n{frontmatter}\n---\n\n{body.lstrip()}"
