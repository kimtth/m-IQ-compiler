"""JSON-lines protocol between the sidecar and the app.

One JSON object per line on **stdout**, and nothing else. Every diagnostic goes
to stderr: a stray ``print`` would land in the middle of the stream and the app
would drop a frame it could not parse. DSPy and LiteLLM are both chatty on
stdout by default, which is why ``quiet_stdout`` exists below — this is not a
theoretical concern, it is the first thing that breaks.
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import threading
from collections.abc import Iterator
from typing import Any

# One lock around stdout. GEPA evaluates candidates on a thread pool, so two
# half-written lines interleaved is a stream the app cannot recover from.
_write_lock = threading.Lock()

# The real stdout, captured before anything is allowed to redirect it.
_stdout = sys.stdout


def emit(event: dict[str, Any]) -> None:
    """Write one event. Flushed immediately — the app is drawing from this live."""
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    with _write_lock:
        _stdout.write(line + "\n")
        _stdout.flush()


def log(message: str, **fields: Any) -> None:
    """Diagnostics, on stderr, where they cannot corrupt the event stream."""
    detail = " ".join(f"{key}={value!r}" for key, value in fields.items())
    print(f"[iq-evolve] {message} {detail}".rstrip(), file=sys.stderr, flush=True)


@contextlib.contextmanager
def quiet_stdout() -> Iterator[None]:
    """Send anything printed by a library to stderr instead of the event stream.

    DSPy prints progress bars and LiteLLM prints warnings, both to stdout. The
    protocol is stdout, so without this the first optimizer call corrupts it.
    Redirecting rather than discarding, because when a run misbehaves that
    output is exactly what explains it.
    """
    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured):
            yield
    finally:
        text = captured.getvalue().strip()
        if text:
            print(text, file=sys.stderr, flush=True)


def status(state: str, detail: str = "") -> None:
    emit({"type": "status", "status": state, "detail": detail})


def candidate(iteration: int, score: dict[str, float], feedback: str) -> None:
    emit({"type": "candidate", "iteration": iteration, "score": score, "feedback": feedback})


def constraint(name: str, passed: bool, message: str = "") -> None:
    emit({"type": "constraint", "name": name, "passed": passed, "message": message})


def done(body: str, best: dict[str, float], baseline: dict[str, float]) -> None:
    emit({"type": "done", "body": body, "best": best, "baseline": baseline})


def failed(problem: str) -> None:
    emit({"type": "error", "problem": problem})
