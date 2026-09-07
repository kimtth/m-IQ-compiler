"""Sidecar entry point.

Resolved and spawned by the app exactly the way `iq-research` is: a process the
app finds at run time, talks to over stdio, and can live without. `--version`
exists purely as the liveness probe the resolver needs.

Reads one JSON request on stdin, streams events on stdout, exits 0.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

from . import __version__
from .evolve import Request, run
from .protocol import failed, log

# Matches MAX_SKILL_BODY_BYTES in packages/shared/src/evolution.ts. Passed in by
# the app rather than assumed, so the two cannot drift silently.
DEFAULT_LIMIT = 15_000


def _model() -> tuple[Any, Any]:
    """Build the task model and the reflection model.

    Both are GitHub Copilot, driven through the Copilot CLI. That is the whole
    point: the app already holds a Copilot sign-in and already speaks to this
    CLI from TypeScript, so there is no second key to store, no second place to
    configure a model, and no second thing to expire.

    Nothing is hardcoded. With no model set the CLI picks its own current
    default, which is the only choice that stays correct without maintenance --
    a name baked in here is one that gets deprecated on somebody else's
    schedule.

    The CLI path comes from the app, never from PATH: the credential belongs to
    the binary, so a different install would be unauthenticated and report "No
    model available" on a machine the user had already signed in on.
    """
    from .copilot_lm import CopilotLM

    model = os.environ.get("IQ_EVOLVE_MODEL", "").strip()
    cli_path = os.environ.get("IQ_EVOLVE_COPILOT_CLI", "").strip()
    timeout = float(os.environ.get("IQ_EVOLVE_TIMEOUT", "300"))

    task_lm = CopilotLM(model=model, cli_path=cli_path, timeout=timeout)

    # GEPA's reflection model reads the judge's feedback and proposes the
    # rewrite, so it is the one that has to reason well. Same model as the task
    # side: the app registers one Copilot default, and inventing a second would
    # be a setting nobody was offered.
    reflection = CopilotLM(model=model, cli_path=cli_path, timeout=timeout, temperature=1.0)
    log("model configured", model=model or "(cli default)", cli=bool(cli_path))
    return task_lm, reflection


def main() -> int:
    parser = argparse.ArgumentParser(prog="iq-evolve", description="Evolve a skill with GEPA.")
    parser.add_argument("--version", action="store_true", help="print the version and exit")
    args = parser.parse_args()

    if args.version:
        print(f"iq-evolve {__version__}")
        return 0

    raw = sys.stdin.read()
    if raw.strip() == "":
        failed("No request was supplied on stdin.")
        return 0

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        failed(f"The request could not be read: {error}")
        return 0

    request = Request(
        name=str(payload.get("name", "")),
        markdown=str(payload.get("markdown", "")),
        budget=int(payload.get("budget", 40)),
        limit=int(payload.get("limit", DEFAULT_LIMIT)),
    )
    if request.name == "" or request.markdown.strip() == "":
        failed("The request named no skill to evolve.")
        return 0

    try:
        task_lm, reflection_lm = _model()
    except Exception as error:  # noqa: BLE001
        failed(str(error))
        return 0

    try:
        run(request, task_lm, reflection_lm)
    except Exception as error:  # noqa: BLE001
        # Every failure is a reported event, never a traceback on stderr and a
        # non-zero exit: the app is reading a stream, and a run that dies
        # silently leaves its surface saying "evolving" for ever.
        log("run failed", error=str(error))
        failed(f"The evolution run failed: {error}")
    finally:
        # Both models hold a `copilot` child process and a loop thread. A run
        # that ended badly has to release them the same way one that finished
        # does, or the sidecar never exits and the app waits on it for ever.
        for model in (task_lm, reflection_lm):
            try:
                model.close()
            except Exception as error:  # noqa: BLE001
                log("model shutdown failed", error=str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
