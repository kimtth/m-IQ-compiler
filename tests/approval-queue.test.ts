import { beforeEach, describe, expect, it } from "vitest";
import type { PermissionRequest, TurnEvent, TurnState } from "@iq/shared";
import {
  answer,
  autoAnswers,
  cardsFor,
  EMPTY_LOG,
  record,
  turnsIn,
  waiting,
} from "../apps/renderer/src/approvals.js";

/**
 * A request is shown once and settles once.
 *
 * That invariant used to span six modules and belong to none: the sequence
 * number was allocated in core, folded in `@iq/shared`, de-duplicated inside
 * `Chat.tsx`, flattened, grouped, answered under the `*_always` first-member
 * rule, then swept by the broker in another process. Only the grouping step was
 * reachable from a test — and it is the only one that never held a bug.
 *
 * This is the replay test that boundary made impossible: a stream of events,
 * with a duplicate sequence number in it, folded to exactly the cards a person
 * would see and then to none. No React, no `window`, no bridge.
 */

const SESSION = "ses_1";
const TURN = "turn-1";

let seq = 0;

beforeEach(() => {
  seq = 0;
});

function created(): TurnEvent {
  seq += 1;
  return {
    type: "turn_created",
    turnId: TURN,
    seq,
    at: "2026-08-07T00:00:00.000Z",
    sessionId: SESSION,
    agentId: "agent",
    snapshot: {
      model: "m",
      skills: [],
      toolFamilies: [],
      mode: "chat",
      subMode: "conversation",
      projectId: null,
    },
    correlationId: "cor",
  };
}

function asks(toolCallId: string, over: Partial<PermissionRequest> = {}): TurnEvent {
  seq += 1;
  return {
    type: "tool_call_requested",
    turnId: TURN,
    seq,
    at: "2026-08-07T00:00:00.000Z",
    args: {},
    request: {
      toolCallId,
      toolName: "office_add_content",
      family: "office",
      risk: "write",
      summary: `Add bullet at /slide[${toolCallId}]/body`,
      requiredScopes: [],
      resources: ["Deck.pptx"],
      ...over,
    },
  };
}

function settles(toolCallId: string): TurnEvent {
  seq += 1;
  return {
    type: "tool_permission_settled",
    turnId: TURN,
    seq,
    at: "2026-08-07T00:00:00.000Z",
    toolCallId,
    outcome: { decision: "allow", source: "user_prompt", reason: "approved" },
  };
}

/** Fold a stream the way the live subscription does. */
function replay(events: readonly TurnEvent[]): TurnState[] {
  let log = EMPTY_LOG;
  for (const one of events) log = record(log, one);
  return turnsIn(log, SESSION, []);
}

describe("approval queue", () => {
  it("shows one card for a deck's worth of calls, and none once they settle", () => {
    const start = created();
    const ids = ["c1", "c2", "c3", "c4", "c5", "c6"];
    const requests = ids.map((id) => asks(id));
    const answers = ids.map((id) => settles(id));

    const cards = cardsFor(replay([start, ...requests]), "ask");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.members).toHaveLength(6);
    // Every call is still individually answerable — the collapse is in the
    // asking, not in the accounting the audit log keeps.
    expect(new Set(cards[0]!.members.map((m) => m.approval.toolCallId)).size).toBe(6);

    expect(cardsFor(replay([start, ...requests, ...answers]), "ask")).toEqual([]);
  });

  /**
   * The `seq` collision, seen from the outside.
   *
   * `appendEvent` once allocated the number by read-modify-write with nothing
   * serialising it, so a batch of settlements written in one tick all carried
   * the same number. The log keys on `seq`, so it keeps one and drops the rest
   * — and the ones it dropped were the settlements, leaving a card nothing
   * could remove. Core fixed the cause with a lock; this pins the *cost* of
   * that key, so it stays visible rather than being rediscovered.
   */
  it("treats two events sharing a sequence number as one", () => {
    const first = asks("c1");
    const second: TurnEvent = { ...asks("c2"), seq: first.seq };

    let log = record(EMPTY_LOG, created());
    log = record(log, first);
    const before = log;
    log = record(log, second);

    // Unchanged: the caller tells a duplicate delivery from a real one without
    // repeating the comparison, which is what stops a needless redraw.
    expect(log).toBe(before);
    expect(cardsFor(turnsIn(log, SESSION, []), "ask")[0]!.members).toHaveLength(1);
  });

  it("orders events by sequence however they arrive", () => {
    const start = created();
    const one = asks("c1");
    const two = asks("c2");

    const ordered = waiting(replay([start, one, two])).map((e) => e.approval.toolCallId);
    const scrambled = waiting(replay([two, start, one])).map((e) => e.approval.toolCallId);
    expect(scrambled).toEqual(ordered);
    expect(ordered).toEqual(["c1", "c2"]);
  });

  /**
   * The first-member rule, which is correct only because the broker sweeps the
   * rest. Sending all three would race that sweep and log "no pending approval"
   * for each one it had already settled.
   */
  it("sends one answer for a remembered decision and every answer otherwise", () => {
    const turns = replay([created(), asks("c1"), asks("c2"), asks("c3")]);
    const card = cardsFor(turns, "ask")[0]!;

    expect(answer(card, "allow_always")).toEqual([
      { turnId: TURN, toolCallId: "c1", decision: "allow_always" },
    ]);
    expect(answer(card, "deny_always").map((a) => a.toolCallId)).toEqual(["c1"]);

    // `allow`/`deny` establish no rule, so nothing sweeps: every call is
    // answered, and the audit log keeps one record per call either way.
    expect(answer(card, "allow").map((a) => a.toolCallId)).toEqual(["c1", "c2", "c3"]);
    expect(answer(card, "deny").map((a) => a.toolCallId)).toEqual(["c1", "c2", "c3"]);
  });

  /**
   * Auto-approval keys on the privileged side's own `risk`, not on a list of
   * families the renderer keeps. The family list knew nothing about the SDK's
   * built-ins, so a turn that fetched a URL was never answered and sat until it
   * timed out. `copilot.url` is `external` by design and still asks.
   */
  it("auto-answers read requests only, and withholds their cards", () => {
    const turns = replay([
      created(),
      asks("c1", { toolName: "copilot.read", family: "copilot.read", risk: "read" }),
      asks("c2", { risk: "write" }),
      asks("c3", { toolName: "copilot.url", family: "copilot.url", risk: "external" }),
    ]);

    expect(autoAnswers(turns)).toEqual([{ turnId: TURN, toolCallId: "c1", decision: "allow" }]);

    // In `auto_safe` the request the effect is about to answer is not drawn: a
    // card that appears and vanishes on its own is not a decision anyone made.
    const shown = cardsFor(turns, "auto_safe").flatMap((card) => card.members);
    expect(shown.map((entry) => entry.approval.toolCallId)).toEqual(["c2", "c3"]);

    // Asking mode draws all three.
    expect(cardsFor(turns, "ask").flatMap((card) => card.members)).toHaveLength(3);
  });

  it("has nothing to show for no conversation", () => {
    expect(turnsIn(EMPTY_LOG, null, [])).toEqual([]);
  });

  /** A restored snapshot keeps its place; a live fold of the same turn wins. */
  it("prefers the live fold over the restored snapshot", () => {
    const restored = [
      { turnId: "turn-0", sessionId: SESSION, pendingApprovals: [] },
      { turnId: TURN, sessionId: SESSION, pendingApprovals: [] },
    ] as unknown as TurnState[];

    let log = record(EMPTY_LOG, created());
    log = record(log, asks("c1"));
    const turns = turnsIn(log, SESSION, restored);

    expect(turns.map((turn) => turn.turnId)).toEqual(["turn-0", TURN]);
    expect(turns[1]!.pendingApprovals).toHaveLength(1);
  });
});
