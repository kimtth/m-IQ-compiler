import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionOutcome } from "../packages/shared/src/index.js";
import { ensureAppPaths, resolveAppPaths } from "../packages/core/src/config/paths.js";
import { SessionRepo } from "../packages/core/src/runtime/sessions/fs-repo.js";
import { SessionsService, type SessionsDeps } from "../packages/core/src/runtime/sessions/sessions.js";
import { TurnRepo } from "../packages/core/src/runtime/turns/fs-repo.js";

/**
 * Chat Stop must stop more than the foreground runtime turn. A delegated plan
 * has its own child sessions, so it needs an explicit cancellation handoff once
 * the parent turn has settled.
 */
describe("SessionsService.stopTurn", () => {
  let root: string | null = null;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("cancels the delegated work only after the parent runtime turn settles", async () => {
    root = mkdtempSync(join(tmpdir(), "iq-stop-turn-"));
    const paths = resolveAppPaths(root);
    await ensureAppPaths(paths);

    let runtimeStopped = false;
    const cancelled: Array<{ sessionId: string; turnId: string; reason: string }> = [];
    const service = new SessionsService({
      paths,
      sessionRepo: new SessionRepo(paths),
      turnRepo: new TurnRepo(paths),
      runtime: {
        primeSequence: () => undefined,
        ensureSession: async () => ({}),
        runTurn: async (_session: unknown, input: { signal: AbortSignal }) => {
          await new Promise<void>((resolve) => {
            if (input.signal.aborted) resolve();
            else input.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          runtimeStopped = true;
        },
      },
      toolRegistry: { families: () => [] },
      skills: { resolveSessionSkillConfig: async () => ({ directories: [], disabled: [] }) },
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      publish: () => undefined,
      publishIndex: () => undefined,
      defaultModel: "test",
      cancelDelegatedWork: async (input: { sessionId: string; turnId: string; reason: string; }) => {
        expect(runtimeStopped).toBe(true);
        cancelled.push(input);
      },
    } as unknown as SessionsDeps);

    const sessionId = await service.create();
    const turnId = await service.sendMessage({ sessionId, content: "Delegate this work" });

    await service.stopTurn(turnId, "stopped by user");

    expect(cancelled).toEqual([{ sessionId, turnId, reason: "stopped by user" }]);
  });

  /**
   * The turn that Stop is trying to end was the only thing that could release
   * the approval it was parked on, and it could not do that until it ended.
   * `stopTurn` waited for the turn, the turn waited for the approval, and the
   * approval waited for the cleanup that runs when the turn ends. The IPC call
   * never returned and the chat sat on "Working…" with a dead Stop button.
   */
  it("returns when the turn is parked on an approval nobody answered", async () => {
    root = mkdtempSync(join(tmpdir(), "iq-stop-parked-"));
    const paths = resolveAppPaths(root);
    await ensureAppPaths(paths);

    let broker: SessionsService | null = null;
    let settled: PermissionOutcome | null = null;
    let asked: (() => void) | null = null;
    const askedOnce = new Promise<void>((resolve) => {
      asked = resolve;
    });

    const service = new SessionsService({
      paths,
      sessionRepo: new SessionRepo(paths),
      turnRepo: new TurnRepo(paths),
      runtime: {
        primeSequence: () => undefined,
        ensureSession: async () => ({}),
        // Deliberately does not watch the signal. A tool call already in flight
        // is the case that matters: aborting the turn cannot reach inside it.
        runTurn: async (_session: unknown, input: { sessionId: string; turnId: string }) => {
          settled = await broker!.decide(
            {
              toolCallId: "call-1",
              toolName: "mail.send",
              family: "m365.mail",
              risk: "external",
              summary: "Send a mail",
              requiredScopes: [],
              resources: [],
            },
            { sessionId: input.sessionId, turnId: input.turnId } as never,
          );
        },
      },
      policy: { evaluate: () => ({ decision: "ask", source: "user_prompt", reason: "asks" }) },
      toolRegistry: { families: () => [] },
      skills: { resolveSessionSkillConfig: async () => ({ directories: [], disabled: [] }) },
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      publish: (event: { type: string }) => {
        if (event.type === "turn_suspended") asked?.();
      },
      publishIndex: () => undefined,
      defaultModel: "test",
    } as unknown as SessionsDeps);
    broker = service;

    const sessionId = await service.create();
    const turnId = await service.sendMessage({ sessionId, content: "Send that mail" });

    // Stop only deadlocks once the request is actually parked, so wait for the
    // turn to say it is suspended rather than racing it.
    await askedOnce;

    await service.stopTurn(turnId, "stopped by user");

    expect(settled).toEqual({
      decision: "deny",
      source: "default_deny",
      reason: "stopped by user",
    });  });
});
