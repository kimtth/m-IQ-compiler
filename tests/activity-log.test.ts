import { describe, expect, it } from "vitest";
import type { ToolCallState } from "@iq/shared";
import { describeTool, detailOf, summarizeActivity } from "../apps/renderer/src/activity.js";

/**
 * How much of a turn's machinery the reader has to look at.
 *
 * A deck build made twenty tool calls, and each one rendered as its own
 * bordered card carrying a status pill, the tool name, the family repeated
 * after it, and a body reading "No output recorded." The transcript stopped
 * being a conversation and became the log file, which is what the user
 * reported: "it generates too much output, some are duplicated."
 *
 * Tested here rather than in `Chat.tsx` because importing that drags in the IPC
 * bridge and `window`.
 */

const call = (over: Partial<ToolCallState> = {}): ToolCallState => ({
  toolCallId: "call-1",
  toolName: "copilot.read",
  family: "copilot",
  summary: "Read a file",
  status: "succeeded",
  output: null,
  error: null,
  untrusted: false,
  ...over,
});

describe("describeTool", () => {
  it("drops the family prefix and reads as prose", () => {
    // The family is shown beside the name, so repeating it in the name was
    // literally half the duplication on screen.
    expect(describeTool("copilot.read", "copilot")).toBe("read");
    expect(describeTool("office_add_many", "office")).toBe("add many");
    expect(describeTool("fabric_ask_data_agent", "fabric")).toBe("ask data agent");
  });

  it("keeps a name that only looks like it carries the family", () => {
    expect(describeTool("officecli_run", "office")).toBe("officecli run");
    expect(describeTool("office_add_many")).toBe("office add many");
  });

  it("never returns an empty label", () => {
    expect(describeTool("weird.", "weird")).toBe("weird.");
  });
});

describe("summarizeActivity", () => {
  it("collapses repeated calls into one step with a count", () => {
    const activity = summarizeActivity([
      call({ toolCallId: "a", toolName: "copilot.read" }),
      call({ toolCallId: "b", toolName: "copilot.read" }),
      call({ toolCallId: "c", toolName: "copilot.read" }),
      call({ toolCallId: "d", toolName: "copilot.write" }),
    ]);

    expect(activity.steps).toHaveLength(2);
    expect(activity.steps[0]?.calls).toHaveLength(3);
    expect(activity.steps[0]?.label).toBe("read");
    expect(activity.steps[1]?.calls).toHaveLength(1);
    // Four calls, two steps — the count of work is not the count of rows.
    expect(activity.total).toBe(4);
  });

  it("keeps first-appearance order, so the list does not reshuffle as it runs", () => {
    const activity = summarizeActivity([
      call({ toolCallId: "a", toolName: "office_create_document", family: "office" }),
      call({ toolCallId: "b", toolName: "copilot.read" }),
      call({ toolCallId: "c", toolName: "office_create_document", family: "office" }),
    ]);
    expect(activity.steps.map((step) => step.toolName)).toEqual([
      "office_create_document",
      "copilot.read",
    ]);
  });

  it("gives a step the most serious status among its calls", () => {
    const activity = summarizeActivity([
      call({ toolCallId: "a", status: "succeeded" }),
      call({ toolCallId: "b", status: "failed" }),
      call({ toolCallId: "c", status: "running" }),
    ]);
    expect(activity.steps[0]?.status).toBe("failed");
  });

  it("names what is happening now while the turn is running", () => {
    // The only thing a live turn can tell the user that they cannot already
    // see is which step it is on.
    const activity = summarizeActivity(
      [
        call({ toolCallId: "a", status: "succeeded" }),
        call({ toolCallId: "b", toolName: "office_add_many", family: "office", status: "running" }),
      ],
      "running",
    );
    expect(activity.running).toBe(1);
    expect(activity.headline).toBe("add many");
  });

  it("reports no work in flight once the turn has ended", () => {
    // The backstop for the SDK's missing tool-call id: a completion that could
    // not be paired leaves a call marked "running" forever, and a conversation
    // from an hour ago then shows a spinner. The turn is over, so nothing is
    // running — that is the one reading a reader cannot argue with.
    const stuck = [
      call({ toolCallId: "a", status: "running" }),
      call({ toolCallId: "b", status: "running" }),
    ];
    expect(summarizeActivity(stuck, "running").headline).toBe("read — and 1 more");

    const settled = summarizeActivity(stuck, "completed");
    expect(settled.running).toBe(0);
    expect(settled.headline).toBe("2 steps");
  });

  it("does not print the family when it is the tool name", () => {
    // The SDK's built-ins arrive as toolName "copilot.read" AND family
    // "copilot.read", which rendered as "copilot.read copilot.read" on every
    // single row.
    const sdk = summarizeActivity([call({ toolName: "copilot.read", family: "copilot.read" })]);
    expect(sdk.steps[0]?.showFamily).toBe(false);

    const ours = summarizeActivity([call({ toolName: "office_add_many", family: "office" })]);
    expect(ours.steps[0]?.showFamily).toBe(true);
  });

  it("counts the other work in flight rather than listing it", () => {
    const activity = summarizeActivity([
      call({ toolCallId: "a", status: "running" }),
      call({ toolCallId: "b", status: "running" }),
      call({ toolCallId: "c", toolName: "copilot.write", status: "running" }),
    ]);
    expect(activity.headline).toBe("write — and 2 more");
  });

  it("says an approval is waiting, because that one needs the user", () => {
    // This outranks "running": a turn that is waiting on a person must not
    // look like a turn that is busy.
    const activity = summarizeActivity([
      call({ toolCallId: "a", status: "running" }),
      call({ toolCallId: "b", status: "awaiting_approval" }),
    ]);
    expect(activity.headline).toBe("Waiting for your approval");
  });

  it("reports the shape of the work once it is done", () => {
    const activity = summarizeActivity([
      call({ toolCallId: "a" }),
      call({ toolCallId: "b" }),
      call({ toolCallId: "c", status: "failed", error: "boom" }),
    ]);
    expect(activity.headline).toBe("3 steps · 1 failed");
    expect(activity.failed).toBe(1);
  });

  it("marks a step as having no detail when its calls produced none", () => {
    // "No output recorded." was rendered for every one of these, which is what
    // made the transcript mostly empty boxes.
    const quiet = summarizeActivity([call({ output: null, error: null })]);
    expect(quiet.steps[0]?.hasDetail).toBe(false);
    expect(detailOf(call({ output: "   " }))).toBe("");

    const loud = summarizeActivity([call({ output: "wrote 6 slides" })]);
    expect(loud.steps[0]?.hasDetail).toBe(true);
  });

  it("has nothing to say about a turn that called no tools", () => {
    const activity = summarizeActivity([]);
    expect(activity.total).toBe(0);
    expect(activity.headline).toBe("");
  });
});
