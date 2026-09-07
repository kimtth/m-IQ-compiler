"""Sidecar entry point.

Resolved and spawned by the app exactly the way `iq-audio` is: a process the
app finds at run time, talks to over stdio, and can live without. `--version`
exists purely as the liveness probe the resolver needs.

Reads one JSON request on stdin, streams graph events on stdout, exits 0.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import sys
from typing import Any

from .protocol import Graph, emit, log
from .workflow import Ask, Request, build, publish_static

VERSION = "0.1.0"


def _permissions() -> Any:
    """Decide what the research agent may do, with no human to ask.

    The Copilot CLI **denies every permission request when no handler is
    supplied**, which is the correct default and also the reason the first real
    run produced an honest report saying it had been able to source nothing:
    web fetch, `curl` and repository search were all refused.

    A headless sidecar cannot put a card in front of anyone, so it cannot answer
    "ask" — it has to decide in advance, and the only defensible rule is the one
    the rest of the app already uses: reading the public web is what research
    *is*, and everything else is refused. `url` is allowed; shell, write, read
    of local files, MCP, memory and extension management are not. A research run
    that wants to run a command is a research run that has misunderstood its
    job.
    """
    from copilot.session import PermissionDecisionApproveOnce, PermissionDecisionUserNotAvailable

    def decide(request: Any, invocation: dict[str, str]) -> Any:  # noqa: ARG001
        kind = str(getattr(request, "kind", "") or "")
        if kind == "url":
            log("permission allowed", kind=kind)
            return PermissionDecisionApproveOnce()
        # Not "denied" but "there is nobody here to ask" — which is the truth,
        # and which the CLI reports back to the model as a refusal it can work
        # around rather than as a policy judgement about the request.
        log("permission refused", kind=kind)
        return PermissionDecisionUserNotAvailable()

    return decide


def _client(cli_path: str) -> Any:
    """A Copilot client bound to the app's own `copilot` executable.

    This is what makes one sign-in cover both processes. The CLI keeps its
    credential against the binary, so a sidecar left to find `copilot` on PATH
    would either find a different install — with its own, unauthenticated
    credential store — or find nothing, and report "No model available" on a
    machine the user had already signed in on.

    Passing the path through `default_options` does not work and looked like it
    might: `GitHubCopilotAgent` takes no `cli_path`, so the setting was accepted
    into the options bag and silently ignored. The executable belongs to the
    *connection*, one level down, which is the level this reaches.
    """
    from copilot import CopilotClient, RuntimeConnection

    if not cli_path:
        # No path given: let the SDK use its bundled runtime. Still correct, just
        # not necessarily the same install the app drives.
        return None
    return CopilotClient(
        connection=RuntimeConnection.for_stdio(path=cli_path),
        # Authenticate as the signed-in user rather than with a token. The app
        # deliberately does not forward one — an inherited GITHUB_TOKEN takes
        # priority over the stored device-flow credential and then fails as
        # "No model available", with nothing to say authentication is the cause.
        use_logged_in_user=True,
    )


def _agent() -> Any:
    """The GitHub Copilot agent, driven through the Copilot CLI.

    Chosen over an OpenAI-style client with an API key for two reasons that are
    the same reason: the app already holds a Copilot credential and already
    speaks to this CLI from TypeScript, so there is no second key to store, no
    second place to configure a model, and no second thing to expire. The agent
    authenticates the way the rest of the app does or it does not run.

    The model is whatever the app passes through, and **nothing is hardcoded**.
    A default baked in here is a name that will be deprecated on someone else's
    schedule — `gpt-4.1-mini` was, which is how this came to be rewritten. With
    no model set the CLI picks its own current default, which is the only
    choice that stays correct without maintenance.
    """
    from agent_framework.github import GitHubCopilotAgent

    settings: dict[str, Any] = {
        "on_permission_request": _permissions(),
        # The CLI's default is 60 seconds, which is a budget for a chat reply,
        # not for a research turn: the first run with web access granted spent
        # four page fetches and died with "Timeout after 60.0s waiting for
        # session.idle" — reported as a failed question, which reads as the
        # model's fault rather than the clock's. The budget is wall time with
        # tool calls inside it, so it has to be sized for the tool calls.
        "timeout": float(os.environ.get("IQ_RESEARCH_TIMEOUT", "600")),
    }
    model = os.environ.get("IQ_RESEARCH_MODEL", "").strip()
    if model:
        settings["model"] = model
    client = _client(os.environ.get("IQ_RESEARCH_COPILOT_CLI", "").strip())
    log("agent configured", model=model or "(cli default)", cli=bool(client))

    return GitHubCopilotAgent(
        name="IQResearch",
        description="Plans, gathers and reviews research for IQ Compiler.",
        **({"client": client} if client else {}),
        # Instructions that must hold for every executor's turn. The per-step
        # prompts carry the task; this carries the rules.
        instructions=(
            "You are a research agent. Answer only from evidence you can cite. "
            "Use web fetch to find sources; shell and file access are unavailable "
            "to you by design, so do not attempt them. "
            "When asked for JSON, return JSON and nothing else — no prose, no code fences."
        ),
        default_options=settings,
    )


def _asker(agent: Any) -> Ask:
    """Adapt the agent to the one call the workflow makes."""

    async def ask(prompt: str) -> str:
        reply = await agent.run(prompt)
        return str(getattr(reply, "text", reply) or "").strip()

    return ask


def _executor_of(event: Any) -> str:
    """The executor an event came from, or "" when it did not come from one.

    `getattr(event, "source_executor_id", None)` looks like it handles this and
    does not: `source_executor_id` is a *property* that raises for any event
    that is not request-scoped, and a default only covers a missing attribute,
    never a raising one. Reading it unguarded killed the first real run on its
    very first event — a `started` event, before a single model call.
    """
    try:
        return str(event.source_executor_id or "")
    except Exception:  # noqa: BLE001 - the property's way of saying "not applicable"
        return ""


async def _run(request: Request) -> int:
    graph = Graph()
    emit({"type": "started", "version": VERSION, "topic": request.topic})
    # Before the client, deliberately: the shape of the work is knowable before
    # any of it can fail, and a run that cannot reach a model should still draw
    # as a plan that did not start.
    publish_static(graph)

    agent: Any = None
    try:
        agent = _agent()
        workflow = build(_asker(agent), graph)
    except Exception as error:  # noqa: BLE001 - reported as an event, not a traceback
        emit({"type": "error", "message": str(error), "graph": graph.snapshot()})
        return 1

    result: dict[str, Any] | None = None
    try:
        # `stream=True` turns the run into the framework's own event feed. Its
        # executor_invoked/completed/failed events are mirrored straight onto
        # the graph, so the picture is the framework's account of the run and
        # not our guess at it.
        async for event in workflow.run(request, stream=True, include_status_events=True):
            executor_id = _executor_of(event)
            status = str(getattr(event, "status", "") or "")
            if executor_id and status:
                emit({"type": "trace", "executor": executor_id, "status": status})
            data = getattr(event, "data", None)
            if isinstance(data, dict) and "narrative" in data:
                result = data
    except Exception as error:  # noqa: BLE001
        emit({"type": "error", "message": str(error), "graph": graph.snapshot()})
        return 1
    finally:
        # The agent owns a CLI subprocess; leaving it running would outlive the
        # run that started it.
        stop = getattr(agent, "stop", None)
        if callable(stop):
            with contextlib.suppress(Exception):
                await stop()

    emit({"type": "done", "graph": graph.snapshot(), "result": result})
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="iq-research", description=__doc__)
    parser.add_argument("--version", action="store_true", help="print the version and exit")
    parser.add_argument("--topic", default="", help="research topic; otherwise read from stdin")
    args = parser.parse_args()

    if args.version:
        print(f"iq-research {VERSION}")
        return 0

    if args.topic:
        payload: dict[str, Any] = {"topic": args.topic}
    else:
        raw = sys.stdin.read().strip()
        if not raw:
            emit({"type": "error", "message": "no request was supplied on stdin"})
            return 2
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as error:
            emit({"type": "error", "message": f"the request was not JSON: {error}"})
            return 2

    request = Request(
        topic=str(payload.get("topic", "")).strip(),
        questions=[str(q) for q in payload.get("questions", []) if str(q).strip()],
        max_rounds=int(payload.get("maxRounds", 2)),
        max_parallel=int(payload.get("maxParallel", 3)),
    )
    if not request.topic:
        emit({"type": "error", "message": "the request carried no topic"})
        return 2

    log("starting", topic=request.topic, rounds=request.max_rounds)
    return asyncio.run(_run(request))


if __name__ == "__main__":
    raise SystemExit(main())
