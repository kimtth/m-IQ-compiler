"""Run the real workflow against a scripted client, so the graph is provable.

No network, no key: the point is that the Agent Framework graph really executes
— planner, parallel researchers, manager, writer, and the round cycle — and
that the event stream the app draws from is what actually came out of it.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from iq_research.protocol import Graph  # noqa: E402
from iq_research.workflow import Request, build  # noqa: E402


class ScriptedAsk:
    """Answers by matching a marker in the prompt. Records what it was asked.

    The workflow takes an `ask` callable rather than a client, so a test needs
    nothing but this — no fake client class, no network, no Copilot CLI.
    """

    def __init__(self) -> None:
        self.prompts: list[str] = []
        self.round = 0

    async def __call__(self, prompt: str) -> str:
        self.prompts.append(prompt)
        if "Decompose this research topic" in prompt:
            return '{"questions":["What is A?","What is B?"]}'
        if "research sub-agent" in prompt:
            # "What is B?" comes back uncited the first time, which is what
            # gives the manager something to send another round after.
            if "What is B?" in prompt and "follow" not in prompt:
                return '{"findings":"unsourced","citations":[]}'
            return '{"findings":"sourced","citations":[{"kind":"url","ref":"https://a.example"}]}'
        if "reviewing round" in prompt:
            self.round += 1
            if self.round == 1:
                return '{"assessment":"B is uncited","followUps":["follow up on B"],"done":false}'
            return '{"assessment":"good","followUps":[],"done":true}'
        if "Write a research report" in prompt:
            return "# Report\n\nBody."
        raise AssertionError(f"unscripted prompt: {prompt[:120]}")


async def main() -> int:
    ask = ScriptedAsk()
    graph = Graph()
    workflow = build(ask, graph)

    outputs: list[dict] = []
    async for event in workflow.run(
        Request(topic="T", max_rounds=2), stream=True, include_status_events=True
    ):
        data = getattr(event, "data", None)
        if isinstance(data, dict) and "narrative" in data:
            outputs.append(data)

    snapshot = graph.snapshot()
    kinds = {n["kind"] for n in snapshot["nodes"]}
    questions = [n for n in snapshot["nodes"] if n["kind"] == "question"]
    rounds = {n["round"] for n in questions}

    checks = {
        "workflow produced a report": bool(outputs and outputs[0]["narrative"]),
        "all four stages are nodes": {"plan", "research", "reflect", "synthesize"} <= kinds,
        "questions became nodes": len(questions) == 3,
        "a second round really ran": rounds == {1, 2},
        "the cycle edge exists": {"from": "reflect", "to": "research"} in snapshot["edges"],
        "uncited answer marked failed": any(
            n["status"] == "failed" and "citation" in n["detail"] for n in questions
        ),
    }

    print(json.dumps({"checks": checks, "nodes": len(snapshot["nodes"])}, indent=2), file=sys.stderr)
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
