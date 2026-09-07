"""The deep-research workflow, as a Microsoft Agent Framework graph.

Shape taken from the framework's own ``deep_research`` sample (the "Magentic"
orchestration): a planner decomposes the topic, capability agents gather in
parallel, a manager reads the round back and may open another, and a writer
synthesises once. The difference from a hand-rolled loop is that here the
orchestration *is* a graph the framework executes and reports on — which is
also what makes it drawable.

Two decisions worth stating:

*   **The fan-out is inside one executor, not a static set of edges.** A
    ``WorkflowBuilder`` graph is fixed at build time, and the number of
    questions is not known until the planner has run. Rather than pre-declaring
    a maximum width of researcher nodes and leaving most of them idle, the
    ``research`` executor gathers its questions concurrently with
    ``asyncio.gather`` and publishes one graph node per question itself. The
    parallelism is real; only the *declaration* is dynamic.
*   **The round loop is a real cycle in the graph** (``reflect -> research``),
    bounded by ``max_rounds`` inside the executor and by the builder's own
    ``max_iterations``. The manager decides whether to go again; it never
    decides how many times.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from agent_framework import Case, Default, WorkflowBuilder, WorkflowContext, executor

from .protocol import Graph, Node, log

#: How an executor reaches a model. A plain callable rather than a client type
#: because that is genuinely all the workflow needs — and because pinning it to
#: one vendor's client is how a pipeline ends up unable to change model without
#: a rewrite. The entry point supplies GitHub Copilot; a test supplies a script.
Ask = Callable[[str], Awaitable[str]]

MAX_QUESTIONS = 8
MAX_FOLLOW_UPS = 4
MAX_TOTAL_QUESTIONS = 16


@dataclass(slots=True)
class Request:
    topic: str
    questions: list[str] = field(default_factory=list)
    max_rounds: int = 2
    max_parallel: int = 3


@dataclass(slots=True)
class Finding:
    question_id: str
    question: str
    findings: str = ""
    citations: list[dict[str, str]] = field(default_factory=list)
    ok: bool = False
    error: str = ""
    round: int = 1


@dataclass(slots=True)
class State:
    request: Request
    round: int = 1
    findings: list[Finding] = field(default_factory=list)
    pending: list[str] = field(default_factory=list)


def _json_object(raw: str) -> dict[str, Any] | None:
    """First balanced JSON object in a model's reply, or None."""
    start = raw.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(raw)):
        char = raw[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    value = json.loads(raw[start : index + 1])
                except json.JSONDecodeError:
                    return None
                return value if isinstance(value, dict) else None
    return None


def publish_static(graph: Graph) -> None:
    """Publish the fixed half of the graph: the four stages and their edges.

    Separate from :func:`build`, and called before the chat client is even
    resolved, because the shape of the work is knowable before any of it can
    fail. A run that cannot reach a model should still draw as a plan that did
    not start — an empty canvas says the app is broken, which is a different
    claim entirely. Safe to call twice: nodes overwrite and edges de-duplicate.
    """
    for node in (
        Node("plan", "plan", "Plan the questions"),
        Node("research", "research", "Gather in parallel"),
        Node("reflect", "reflect", "Review the round"),
        Node("synthesize", "synthesize", "Write the report"),
    ):
        graph.node(node)
    graph.edge("plan", "research")
    graph.edge("research", "reflect")
    graph.edge("reflect", "synthesize")
    graph.edge("reflect", "research")


def build(ask: Ask, graph: Graph) -> Any:
    """Assemble the workflow. `ask` sends one prompt and returns the reply text."""

    # --- planner ----------------------------------------------------------
    @executor(id="plan", output=State)
    async def plan(request: Request, ctx: WorkflowContext[State]) -> None:
        graph.status("plan", "running")
        questions = list(request.questions)
        if not questions:
            raw = await ask(
                f"Decompose this research topic into 3 to {MAX_QUESTIONS} focused, "
                f"independent questions.\nReturn ONLY a JSON object "
                f'{{"questions":["..."]}} and nothing else.\n\nTOPIC: {request.topic}'
            )
            parsed = _json_object(raw) or {}
            questions = [str(q) for q in parsed.get("questions", []) if str(q).strip()]
        questions = questions[:MAX_QUESTIONS]
        if not questions:
            graph.status("plan", "failed", "the topic could not be decomposed")
            raise RuntimeError("the topic could not be decomposed into questions")

        graph.status("plan", "done", f"{len(questions)} questions")
        await ctx.send_message(State(request=request, pending=questions))

    # --- capability agents, fanned out inside one executor -----------------
    @executor(id="research", output=State)
    async def research(state: State, ctx: WorkflowContext[State]) -> None:
        graph.status("research", "running", f"round {state.round}")
        limit = asyncio.Semaphore(max(1, state.request.max_parallel))

        async def one(index: int, question: str) -> Finding:
            node_id = f"q{state.round}_{index}"
            graph.node(
                Node(
                    id=node_id,
                    kind="question",
                    label=question,
                    status="running",
                    round=state.round,
                )
            )
            graph.edge("research", node_id)
            async with limit:
                try:
                    raw = await ask(
                        f'You are a research sub-agent for: "{state.request.topic}".\n'
                        f'Investigate exactly this question: "{question}".\n'
                        "Every claim MUST carry a citation. If you cannot source a claim, "
                        "leave it out.\nReturn ONLY a JSON object:\n"
                        '{"findings":"...","citations":[{"kind":"url","ref":"...","title":""}]}'
                    )
                except Exception as error:  # noqa: BLE001 - reported, never raised
                    graph.status(node_id, "failed", str(error)[:200])
                    return Finding(node_id, question, error=str(error), round=state.round)

            parsed = _json_object(raw)
            if parsed is None:
                graph.status(node_id, "failed", "unparsable answer")
                return Finding(node_id, question, error="unparsable answer", round=state.round)

            citations = [c for c in parsed.get("citations", []) if isinstance(c, dict)]
            finding = Finding(
                question_id=node_id,
                question=question,
                findings=str(parsed.get("findings", "")),
                citations=citations,
                # Uncited is not answered — the same rule the host applies.
                ok=bool(citations),
                round=state.round,
            )
            graph.status(
                node_id,
                "done" if finding.ok else "failed",
                f"{len(citations)} citations" if finding.ok else "no citation found",
            )
            return finding

        gathered = await asyncio.gather(*(one(i, q) for i, q in enumerate(state.pending)))
        state.findings.extend(gathered)
        state.pending = []
        graph.status("research", "done", f"{len(gathered)} questions gathered")
        await ctx.send_message(state)

    # --- manager ----------------------------------------------------------
    @executor(id="reflect", output=State)
    async def reflect(state: State, ctx: WorkflowContext[State]) -> None:
        graph.status("reflect", "running", f"round {state.round}")

        thin = [f for f in state.findings if not f.ok]
        budget_left = state.round < state.request.max_rounds
        room = MAX_TOTAL_QUESTIONS - len(state.findings)

        if not thin or not budget_left or room <= 0:
            why = (
                "every question came back cited"
                if not thin
                else "the round budget was spent"
                if not budget_left
                else "the question ceiling was reached"
            )
            graph.status("reflect", "done", why)
            state.pending = []
            await ctx.send_message(state)
            return

        ledger = "\n".join(
            f"- {f.question} :: {'cited' if f.ok else (f.error or 'no citation')}"
            for f in state.findings
        )
        raw = await ask(
            f'You are reviewing round {state.round} of research on "{state.request.topic}".\n'
            f"Rounds remaining after this one: {state.request.max_rounds - state.round}.\n"
            "A question is THIN when it is uncited, failed, or unanswered.\n"
            "Judge only what is below; do not add facts.\n\n"
            f"LEDGER\n{ledger}\n\n"
            "Return ONLY a JSON object:\n"
            f'{{"assessment":"one short paragraph","followUps":["at most {MAX_FOLLOW_UPS} '
            'new questions"],"done":false}}'
        )
        verdict = _json_object(raw) or {}
        follow_ups = [str(q) for q in verdict.get("followUps", []) if str(q).strip()]
        follow_ups = follow_ups[: min(MAX_FOLLOW_UPS, room)]

        if verdict.get("done") or not follow_ups:
            graph.status("reflect", "done", "no follow-up raised")
            state.pending = []
            await ctx.send_message(state)
            return

        state.round += 1
        state.pending = follow_ups
        graph.status("reflect", "done", f"{len(follow_ups)} follow-ups, round {state.round}")
        await ctx.send_message(state)

    # --- writer -----------------------------------------------------------
    @executor(id="synthesize", workflow_output=dict)
    async def synthesize(state: State, ctx: WorkflowContext[Any, dict]) -> None:
        graph.status("synthesize", "running")
        sections = "\n\n".join(
            f"### {f.question}\nStatus: {'cited' if f.ok else 'unverified'}\n"
            f"Findings: {f.findings or '(none)'}\n"
            + "\n".join(f"  - {c.get('ref', '')}" for c in f.citations)
            for f in state.findings
        )
        narrative = await ask(
            f'Write a research report in Markdown for: "{state.request.topic}".\n'
            "Use ONLY the findings below. Do not invent facts or citations.\n"
            "Write the body only; a source table is appended automatically.\n\n"
            f"{sections}"
        )
        graph.status("synthesize", "done", f"{len(narrative)} characters")
        await ctx.yield_output(
            {
                "topic": state.request.topic,
                "narrative": narrative,
                "rounds": state.round,
                "findings": [
                    {
                        "id": f.question_id,
                        "question": f.question,
                        "findings": f.findings,
                        "citations": f.citations,
                        "ok": f.ok,
                        "error": f.error,
                        "round": f.round,
                    }
                    for f in state.findings
                ],
            }
        )

    # The static half of the graph, published before anything runs so the app
    # can draw the shape of the work rather than watch it appear.
    publish_static(graph)

    log("workflow built")
    return (
        WorkflowBuilder(start_executor=plan, max_iterations=32)
        .add_edge(plan, research)
        .add_edge(research, reflect)
        # The round loop, as a real branch in the graph rather than a flag read
        # inside an executor: the manager leaving questions pending *is* the
        # edge back to `research`, and an empty queue *is* the edge to the
        # writer. The framework validates both, which is how the first attempt
        # at this — a back-edge from `synthesize` — was caught: it type-checked
        # `Any` against `State` and was refused before anything ran.
        .add_switch_case_edge_group(
            reflect,
            [
                Case(condition=lambda state: bool(getattr(state, "pending", [])), target=research),
                Default(target=synthesize),
            ],
        )
        .build()
    )
