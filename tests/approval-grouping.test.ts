import { describe, expect, it } from "vitest";
import type { PendingApproval, TurnState } from "@iq/shared";
import { groupApprovals, MAX_SUMMARIES, type Waiting } from "../apps/renderer/src/approvals.js";

/**
 * How many times a person is interrupted for one intent.
 *
 * "create a pptx about Microsoft" arrived as one `office_create_document` plus
 * **seventeen** `office_add_content` calls, raised together and all waiting at
 * once, so the thread showed seventeen identical approval cards. Settling the
 * siblings once the first was answered was not enough — the seventeen cards
 * were already on screen, and being asked seventeen times is the complaint.
 */

const turn = { turnId: "turn-1" } as unknown as TurnState;

const waiting = (over: Partial<PendingApproval> = {}): Waiting => ({
  turn,
  approval: {
    toolCallId: `call-${Math.random()}`,
    toolName: "office_add_content",
    family: "office",
    risk: "write",
    summary: "Add bullet to microsoft_presentation.pptx at /slide[2]/body",
    requiredScopes: [],
    ...over,
  } as PendingApproval,
});

describe("groupApprovals", () => {
  it("turns a deck's worth of calls into one question", () => {
    const entries = Array.from({ length: 17 }, (_unused, index) =>
      waiting({ summary: `Add bullet to deck.pptx at /slide[${index}]/body` }),
    );

    const groups = groupApprovals(entries);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.members).toHaveLength(17);
    // Every call is still individually answerable, which is what the audit log
    // records — the collapse is in the asking, not in the accounting.
    expect(new Set(groups[0]!.members.map((m) => m.approval.toolCallId)).size).toBe(17);
  });

  it("lists a few requests and counts the rest", () => {
    const entries = Array.from({ length: 17 }, (_unused, index) =>
      waiting({ summary: `Add bullet at /slide[${index}]` }),
    );

    const [group] = groupApprovals(entries);

    expect(group!.summaries).toHaveLength(MAX_SUMMARIES);
    expect(group!.remaining).toBe(17 - MAX_SUMMARIES);
  });

  it("does not repeat an identical summary", () => {
    const entries = [waiting(), waiting(), waiting()];
    const [group] = groupApprovals(entries);

    expect(group!.summaries).toHaveLength(1);
    expect(group!.remaining).toBe(2);
  });

  it("keeps different tools apart, so one answer never covers two questions", () => {
    const groups = groupApprovals([
      waiting({ toolName: "office_add_content" }),
      waiting({ toolName: "office_set_content", risk: "destructive" }),
      waiting({ toolName: "office_add_content" }),
    ]);

    expect(groups.map((group) => group.toolName)).toEqual([
      "office_add_content",
      "office_set_content",
    ]);
    expect(groups[0]!.members).toHaveLength(2);
    expect(groups[1]!.members).toHaveLength(1);
  });

  it("keeps the same tool name in different families apart", () => {
    // The key is family *and* name: a family is the unit policy reasons about.
    const groups = groupApprovals([
      waiting({ family: "office", toolName: "read_file" }),
      waiting({ family: "m365.files", toolName: "read_file" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("preserves first-appearance order, so the list does not reshuffle", () => {
    const groups = groupApprovals([
      waiting({ toolName: "b_tool" }),
      waiting({ toolName: "a_tool" }),
      waiting({ toolName: "b_tool" }),
    ]);
    expect(groups.map((group) => group.toolName)).toEqual(["b_tool", "a_tool"]);
  });

  it("leaves a single request as a single question", () => {
    const [group] = groupApprovals([waiting()]);
    expect(group!.members).toHaveLength(1);
    expect(group!.remaining).toBe(0);
    expect(group!.summaries).toHaveLength(1);
  });

  it("has nothing to show when nothing is pending", () => {
    expect(groupApprovals([])).toEqual([]);
  });
});
