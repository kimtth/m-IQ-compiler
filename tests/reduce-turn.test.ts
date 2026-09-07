import { describe, expect, it } from "vitest";
import { reduceTurn, type TurnEvent } from "@iq/shared";

/**
 * `reduceTurn` is the single definition of turn state. The UI folds it after a
 * reload and the runtime folds it to recover an interrupted turn, so a
 * disagreement between the two would show up as a session that looks different
 * depending on how you arrived at it.
 */

const at = "2026-01-01T00:00:00.000Z";

const created = (turnId: string, sessionId: string): TurnEvent => ({
  type: "turn_created",
  turnId,
  sessionId,
  seq: 0,
  at,
  agentId: "primary",
  snapshot: { model: "claude-sonnet-4.5", skills: ["mail-triage"], toolFamilies: ["m365.mail"] },
  correlationId: "cor_1",
});

const requested = (turnId: string, seq: number, toolCallId: string): TurnEvent => ({
  type: "tool_call_requested",
  turnId,
  seq,
  at,
  request: {
    toolCallId,
    toolName: "m365_send_mail",
    family: "m365.mail",
    summary: "send a mail",
    risk: "destructive",
    requiredScopes: ["Mail.Send"],
    resources: [],
  },
  args: {},
});

describe("reduceTurn", () => {
  it("starts a turn from its snapshot", () => {
    const state = reduceTurn([created("trn_1", "ses_1")]);
    expect(state.sessionId).toBe("ses_1");
    expect(state.model).toBe("claude-sonnet-4.5");
    expect(state.activeSkills).toEqual(["mail-triage"]);
    expect(state.status).toBe("running");
  });

  it("clears a pending approval once the permission is settled", () => {
    const events: TurnEvent[] = [
      created("trn_1", "ses_1"),
      requested("trn_1", 1, "tc_1"),
      {
        type: "tool_permission_settled",
        turnId: "trn_1",
        seq: 2,
        at,
        toolCallId: "tc_1",
        outcome: { decision: "allow", source: "user_prompt", reason: "approved by the user" },
      },
    ];
    expect(reduceTurn(events).pendingApprovals).toHaveLength(0);
  });

  it("clears a pending approval when the call completes without a settle event", () => {
    // The SDK can auto-approve, in which case completion is the only signal.
    const events: TurnEvent[] = [
      created("trn_1", "ses_1"),
      requested("trn_1", 1, "tc_1"),
      { type: "tool_call_completed", turnId: "trn_1", seq: 2, at, toolCallId: "tc_1", ok: true, result: {}, untrusted: true },
    ];
    expect(reduceTurn(events).pendingApprovals).toHaveLength(0);
  });

  /**
   * The defect that made every transcript unreadable.
   *
   * The Copilot SDK hands its permission handler only `{ sessionId }` — no
   * tool-call id — so the id on `tool_call_requested` is one we minted and the
   * id on `tool_call_completed` is the SDK's own. In every real turn log they
   * differ (`tc_3815c84c…` requested, `toolu_016rKAW…` completed), so nothing
   * ever matched: no call left "running" and no result was ever attached,
   * which is why the transcript read "No output recorded." throughout and a
   * finished conversation still showed work in progress.
   */
  it("pairs a completion to its call by tool name when the ids differ", () => {
    const events: TurnEvent[] = [
      created("trn_1", "ses_1"),
      requested("trn_1", 1, "tc_ours"),
      {
        type: "tool_call_completed",
        turnId: "trn_1",
        seq: 2,
        at,
        // The SDK's id, which we have never seen before.
        toolCallId: "toolu_theirs",
        toolName: "m365_send_mail",
        ok: true,
        result: "sent",
        untrusted: true,
      },
    ];
    const state = reduceTurn(events);
    expect(state.toolCalls[0]?.status).toBe("succeeded");
    expect(state.toolCalls[0]?.output).toBe("sent");
  });

  it("falls back to the oldest open call when the completion has no name", () => {
    // Older logs carry no `toolName` at all. Arrival order is then the only
    // information there is, and it is better than leaving every call running.
    const events: TurnEvent[] = [
      created("trn_1", "ses_1"),
      requested("trn_1", 1, "tc_a"),
      requested("trn_1", 2, "tc_b"),
      {
        type: "tool_call_completed",
        turnId: "trn_1",
        seq: 3,
        at,
        toolCallId: "toolu_x",
        ok: true,
        result: "first",
        untrusted: true,
      },
    ];
    const state = reduceTurn(events);
    expect(state.toolCalls[0]?.status).toBe("succeeded");
    expect(state.toolCalls[0]?.output).toBe("first");
    // The second is untouched: one completion settles one call.
    expect(state.toolCalls[1]?.status).toBe("awaiting_approval");
  });

  it("never settles the same call twice for two completions", () => {
    const events: TurnEvent[] = [
      created("trn_1", "ses_1"),
      requested("trn_1", 1, "tc_a"),
      requested("trn_1", 2, "tc_b"),
      { type: "tool_call_completed", turnId: "trn_1", seq: 3, at, toolCallId: "x", ok: true, result: "one", untrusted: true },
      { type: "tool_call_completed", turnId: "trn_1", seq: 4, at, toolCallId: "y", ok: true, result: "two", untrusted: true },
    ];
    const state = reduceTurn(events);
    expect(state.toolCalls.map((call) => call.output)).toEqual(["one", "two"]);
  });

  it("still prefers an exact id match over the fallback", () => {
    const events: TurnEvent[] = [
      created("trn_1", "ses_1"),
      requested("trn_1", 1, "tc_a"),
      requested("trn_1", 2, "tc_b"),
      { type: "tool_call_completed", turnId: "trn_1", seq: 3, at, toolCallId: "tc_b", ok: true, result: "exact", untrusted: true },
    ];
    const state = reduceTurn(events);
    expect(state.toolCalls[0]?.status).toBe("awaiting_approval");
    expect(state.toolCalls[1]?.output).toBe("exact");
  });

  it("carries the retryable flag off a failure so the UI can offer a retry", () => {    const events: TurnEvent[] = [
      created("trn_1", "ses_1"),
      { type: "turn_failed", turnId: "trn_1", seq: 1, at, error: "transport reset", retryable: true },
    ];
    const state = reduceTurn(events);
    expect(state.status).toBe("failed");
    expect(state.error).toBe("transport reset");
    expect(state.retryable).toBe(true);
  });

  it("is a pure fold, so replaying the same log twice gives the same state", () => {
    const events: TurnEvent[] = [
      created("trn_1", "ses_1"),
      { type: "user_message", turnId: "trn_1", seq: 1, at, content: "hello", attachments: [] },
      { type: "assistant_message", turnId: "trn_1", seq: 2, at, content: "hi" },
      { type: "turn_completed", turnId: "trn_1", seq: 3, at, usage: { inputTokens: 10, outputTokens: 4 } },
    ];
    expect(reduceTurn(events)).toEqual(reduceTurn(events));
  });

  it("tracks the highest sequence seen, so a gap is detectable", () => {
    const events: TurnEvent[] = [
      created("trn_1", "ses_1"),
      { type: "assistant_message", turnId: "trn_1", seq: 7, at, content: "out of order" },
      { type: "assistant_message", turnId: "trn_1", seq: 3, at, content: "late arrival" },
    ];
    expect(reduceTurn(events).lastSeq).toBe(7);
  });
});
