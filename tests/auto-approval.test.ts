import { describe, expect, it } from "vitest";
import { normalizeSdkPermission } from "@iq/core";
import { isAutoApprovable, reduceTurn, type TurnEvent } from "@iq/shared";

/**
 * What "auto-approve read-only tools" answers for.
 *
 * The setting used to be decided in renderer code by a hand-written list of six
 * Microsoft family names. It knew nothing about the SDK's own built-ins, so
 * every `copilot.*` request fell through it: the mode that says it answers on
 * your behalf did not, the approval card was hidden anyway, and the turn sat
 * until `Timeout after 300000ms waiting for session.idle`.
 *
 * Three things have to hold for that to stay fixed, and each is pinned here:
 * the runtime assigns a risk to every SDK request, the fold carries that risk
 * to the surface, and the rule is written against the risk rather than against
 * a list of names.
 */

const sdk = (kind: string, extra: Record<string, unknown> = {}): unknown => ({ kind, ...extra });

describe("the SDK risk table", () => {
  it("calls a file read a read", () => {
    const request = normalizeSdkPermission(sdk("read", { fileName: "notes.md" }) as never);
    expect(request.risk).toBe("read");
    expect(isAutoApprovable(request.risk)).toBe(true);
  });

  it("calls a URL fetch external, not read", () => {
    // The one a user is most likely to expect auto-approval to cover, and the
    // reason the label says "read-only": fetching reaches the public internet.
    // It prompts, and "Allow for this conversation" is the control for the
    // repeats.
    const request = normalizeSdkPermission(sdk("url", { url: "https://example.com" }) as never);
    expect(request.family).toBe("copilot.url");
    expect(request.risk).toBe("external");
    expect(isAutoApprovable(request.risk)).toBe(false);
  });

  it("never lets a shell command or an MCP call through the fast path", () => {
    expect(isAutoApprovable(normalizeSdkPermission(sdk("shell") as never).risk)).toBe(false);
    expect(isAutoApprovable(normalizeSdkPermission(sdk("mcp") as never).risk)).toBe(false);
    expect(isAutoApprovable(normalizeSdkPermission(sdk("write") as never).risk)).toBe(false);
  });

  it("treats an unrecognised kind as destructive rather than guessing", () => {
    // A new SDK release must not be able to add a permission kind that is
    // auto-approved by default.
    const request = normalizeSdkPermission(sdk("something-new") as never);
    expect(request.risk).toBe("destructive");
    expect(isAutoApprovable(request.risk)).toBe(false);
  });
});

describe("the fold carries the risk to the surface", () => {
  const requested = (family: string, risk: string): TurnEvent[] => [
    {
      type: "turn_created",
      turnId: "t1",
      seq: 0,
      at: "2026-07-31T10:00:00.000Z",
      sessionId: "s1",
      agentId: "iq-compiler",
      snapshot: {
        model: "m",
        skills: [],
        toolFamilies: [],
        mode: "chat",
        subMode: "conversation",
        projectId: null,
      },
      correlationId: "c1",
    },
    {
      type: "tool_call_requested",
      turnId: "t1",
      seq: 1,
      at: "2026-07-31T10:00:01.000Z",
      request: {
        toolCallId: "tc1",
        toolName: "fetch",
        family,
        risk,
        summary: "Fetch URL https://example.com",
        requiredScopes: [],
        resources: [],
      },
    } as unknown as TurnEvent,
  ];

  it("puts the risk on the pending approval, so the surface need not guess", () => {
    const state = reduceTurn(requested("copilot.url", "external"));
    expect(state.pendingApprovals[0]?.risk).toBe("external");
  });

  it("is what makes a read auto-approvable and a fetch not", () => {
    const read = reduceTurn(requested("m365.mail.read", "read"));
    const fetch = reduceTurn(requested("copilot.url", "external"));

    expect(read.pendingApprovals.map((a) => isAutoApprovable(a.risk))).toEqual([true]);
    expect(fetch.pendingApprovals.map((a) => isAutoApprovable(a.risk))).toEqual([false]);
  });

  it("covers a family the renderer's old list had never heard of", () => {
    // `copilot.read` is an SDK built-in. The six hand-written families did not
    // include it, so auto-approval left it pending forever.
    const request = normalizeSdkPermission(sdk("read", { fileName: "a.txt" }) as never);
    const state = reduceTurn(requested(request.family, request.risk));
    expect(state.pendingApprovals[0]?.family).toBe("copilot.read");
    expect(isAutoApprovable(state.pendingApprovals[0]!.risk)).toBe(true);
  });
});
