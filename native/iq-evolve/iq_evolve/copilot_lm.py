"""A DSPy language model backed by GitHub Copilot.

DSPy talks to models over the OpenAI API. GitHub Copilot does not expose one —
it is reached through its own CLI, which holds the credential. So this is the
adapter between the two, and it exists for the same reason the research sidecar
drives the same CLI: **the app already holds a Copilot sign-in**, and asking
someone to register a second model somewhere else, with its own key and its own
expiry, to improve a skill is a worse product than using the one they have.

Two facts make it work:

- `dspy.BaseLM` can be subclassed. Declaring ``forward_contract = "typed_lm"``
  and returning an `LMResponse` is the sanctioned path in DSPy 3.3; the older
  contract wants an OpenAI-shaped provider response, which there is nothing here
  to build one from.
- Each call runs in its **own** session, which is what DSPy assumes: every call
  carries its whole message list, and history leaking between calls would
  silently corrupt an optimizer that evaluates the same example many times.

The agent gets **no tools**. This is text completion, not agentic work: the
optimizer is asking a model to follow a procedure and judge the result, and a
model that could read files or fetch pages while doing so would be scoring
something other than the skill.

Sessions are created explicitly and **deleted when the call returns**. Letting
the agent create one implicitly (by omitting `session=`) gives the same
isolation but leaves it on disk: a run is hundreds of model calls, so that is
hundreds of directories under `~/.copilot/session-state`, each titled with the
prompt that made it. The optimizer's traffic is not conversation, and keeping
it as if it were fills a store the user reads for their own work.
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any

import dspy  # type: ignore[import-not-found]
from dspy.core.types import LMResponse  # type: ignore

from .protocol import log

# The CLI's default is a chat-reply budget. A judge turn over a long procedure
# is bigger than that, and the failure mode is a timeout reported as a bad
# candidate — i.e. the optimizer learns from our clock rather than from the
# skill.
DEFAULT_TIMEOUT_SECONDS = 300.0


def _permissions() -> Any:
    """Refuse every permission request.

    The agent is given no tools, so nothing should ask. If something does, the
    honest answer from a headless optimizer is that there is nobody here to ask
    — which the CLI reports to the model as a refusal it can work around rather
    than as a policy judgement.
    """
    from copilot.session import PermissionDecisionUserNotAvailable  # type: ignore

    def decide(request: Any, invocation: dict[str, str]) -> Any:
        log("permission refused", kind=str(getattr(request, "kind", "") or ""))
        return PermissionDecisionUserNotAvailable()

    return decide


def _client(cli_path: str) -> Any:
    """A Copilot client bound to the app's own `copilot` executable.

    This is what makes one sign-in cover both processes. The CLI keeps its
    credential against the binary, so a sidecar left to find `copilot` on PATH
    would either find a different install — with its own, unauthenticated
    credential store — or find nothing, and report "No model available" on a
    machine the user had already signed in on.

    `GitHubCopilotAgent` has no `cli_path` option; passing one through
    `default_options` is accepted into the options bag and silently ignored.
    The executable belongs to the *connection*, which is the level this reaches.

    A client is built even with no `cli_path`, where the agent would otherwise
    make its own: `delete_session` lives on the client, so the one the sessions
    are created through has to be the one this module can reach to clean them
    up afterwards.
    """
    from copilot import CopilotClient, RuntimeConnection  # type: ignore

    return CopilotClient(
        **({"connection": RuntimeConnection.for_stdio(path=cli_path)} if cli_path else {}),
        # Authenticate as the signed-in user rather than with a token. An
        # inherited GITHUB_TOKEN takes priority over the stored device-flow
        # credential and then fails as "No model available", with nothing to say
        # authentication is the cause.
        use_logged_in_user=True,
    )


# Everything the CLI would helpfully bring to a conversation and which has no
# business in a scoring run: the judge is meant to read the procedure under
# test and nothing else. Repository skills, `AGENTS.md`/`copilot-instructions.md`
# and retrieved snippets would all be scored as if they were the skill, and the
# cross-session store would carry one evaluation's context into the next.
QUIET_SESSION: dict[str, Any] = {
    "enable_skills": False,
    "enable_config_discovery": False,
    "skip_custom_instructions": True,
    "skip_embedding_retrieval": True,
    "enable_session_store": False,
}


def _flatten(request: Any) -> str:
    """Turn DSPy's normalized request into one prompt.

    Copilot's agent takes a prompt plus standing instructions, not a role-tagged
    list, so the roles are written into the text. Labelling them rather than
    concatenating blindly matters: DSPy's adapters put the output format in the
    system message and the example in the user message, and a model that cannot
    tell them apart answers in the wrong shape.

    `LMMessage.text` is used rather than reading `parts` by hand — a message can
    carry several content parts, and the property is what knows how they join.
    """
    parts: list[str] = []
    for message in getattr(request, "messages", None) or []:
        role = str(getattr(message, "role", "user"))
        text = str(getattr(message, "text", "") or "").strip()
        if text == "":
            continue
        if role == "system":
            parts.append(f"[instructions]\n{text}")
        elif role == "assistant":
            parts.append(f"[your previous reply]\n{text}")
        else:
            parts.append(text)
    return "\n\n".join(parts)


class CopilotLM(dspy.BaseLM):
    """DSPy's model interface, answered by the Copilot CLI."""

    # DSPy 3.3's typed contract. Without this, returning an `LMResponse` from
    # `forward` is treated as an accident and warns.
    forward_contract = "typed_lm"

    def __init__(self, model: str, cli_path: str, timeout: float = DEFAULT_TIMEOUT_SECONDS, **kwargs: Any) -> None:
        # `model` is the Copilot model ref, or "" to let the CLI choose. Nothing
        # is hardcoded: a name baked in here is one that gets deprecated on
        # somebody else's schedule, which is exactly how the research sidecar
        # came to be rewritten.
        super().__init__(model=model or "copilot/default", **kwargs)
        self._model_ref = model
        self._cli_path = cli_path
        self._timeout = timeout
        self._agent: Any = None
        self._client: Any = None
        self._lock = threading.Lock()

        # One event loop on a daemon thread, for the life of the process.
        # DSPy's call path is synchronous and GEPA evaluates on a pool, so
        # `asyncio.run` per call would create and tear down a loop — and a
        # Copilot client bound to a dead loop is the kind of failure that
        # surfaces as an unrelated timeout much later.
        self._loop = asyncio.new_event_loop()
        thread = threading.Thread(target=self._loop.run_forever, daemon=True, name="copilot-lm")
        thread.start()

    def _ensure_agent(self) -> Any:
        with self._lock:
            if self._agent is not None:
                return self._agent
            from agent_framework.github import GitHubCopilotAgent  # type: ignore

            settings: dict[str, Any] = {
                "on_permission_request": _permissions(),
                "timeout": self._timeout,
                **QUIET_SESSION,
            }
            if self._model_ref:
                settings["model"] = self._model_ref
            client = _client(self._cli_path)
            self._client = client
            log("copilot lm configured", model=self._model_ref or "(cli default)", cli=bool(self._cli_path))

            self._agent = GitHubCopilotAgent(
                name="IQEvolve",
                description="Follows and judges skill procedures for IQ Compiler.",
                client=client,
                instructions=(
                    "You are being used as a language model, not as an agent. "
                    "Answer the prompt directly and completely. "
                    "You have no tools and no file or network access by design, so do not "
                    "attempt them and do not mention them. "
                    "When asked for a specific output format, return exactly that format "
                    "and nothing else — no preamble, no commentary, no code fences."
                ),
                default_options=settings,
            )
            return self._agent

    async def _discard(self, session: Any) -> None:
        """Delete the Copilot session this call ran in.

        Best effort on purpose. A session that cannot be deleted is a directory
        left behind, and failing the evaluation over it would turn a
        housekeeping problem into a bad candidate score — the optimizer would
        learn from our cleanup rather than from the skill.
        """
        session_id = getattr(session, "service_session_id", None)
        client = self._client
        if client is None or not isinstance(session_id, str) or session_id == "":
            return
        try:
            await client.delete_session(session_id)
        except Exception as error:  # noqa: BLE001
            log("session cleanup failed", session=session_id, error=str(error))

    async def _ask(self, prompt: str) -> str:
        agent = self._ensure_agent()
        # An explicit session per call. Isolation is what DSPy assumes, and
        # holding the handle is what makes it possible to delete the session
        # afterwards instead of leaving one behind for every model call.
        session = agent.create_session()
        try:
            reply = await agent.run(prompt, session=session)
            return str(getattr(reply, "text", reply) or "").strip()
        finally:
            await self._discard(session)

    def close(self) -> None:
        """Release the CLI connection and the event loop.

        Without this the run holds a live `copilot` child process and a thread
        after its last evaluation, and the sidecar is a process the app waits
        on — one that does not exit reports a run that never finishes.
        """
        with self._lock:
            client, self._client, self._agent = self._client, None, None
        if client is not None:
            try:
                asyncio.run_coroutine_threadsafe(client.stop(), self._loop).result(timeout=30)
            except Exception as error:  # noqa: BLE001
                log("client shutdown failed", error=str(error))
        self._loop.call_soon_threadsafe(self._loop.stop)

    def forward(self, request: Any) -> LMResponse:
        """Answer one request.

        The **typed** contract: `forward_contract = "typed_lm"` means DSPy
        hands over one normalized `LMRequest` positionally, not the
        `prompt=`/`messages=` pair the legacy contract uses. Writing the legacy
        signature here still type-checks and then fails at run time on the first
        real call, which is exactly how this was found.
        """
        text = _flatten(request)
        if text.strip() == "":
            return LMResponse.from_text("", model=self.model)
        future = asyncio.run_coroutine_threadsafe(self._ask(text), self._loop)
        # A little beyond the CLI's own budget, so its timeout wins and reports
        # itself rather than being masked by ours.
        answer = future.result(timeout=self._timeout + 60)
        return LMResponse.from_text(answer, model=self.model)

    async def aforward(self, request: Any) -> LMResponse:
        text = _flatten(request)
        if text.strip() == "":
            return LMResponse.from_text("", model=self.model)
        return LMResponse.from_text(await self._ask(text), model=self.model)
