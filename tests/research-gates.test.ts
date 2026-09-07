import { describe, expect, it } from "vitest";
import {
  ResearchRun,
  canApprovePlan,
  canCancelRun,
  canEditPlan,
  canRefineRun,
  canRerunQuestion,
  canWriteReport,
  isRunActive,
  unsettledQuestions,
  type ResearchQuestionStatus,
  type ResearchRunStatus,
} from "@iq/shared";

/**
 * What a research run will and will not allow.
 *
 * These rules used to live in two places at once — 14 status comparisons in
 * `ResearchService` and 12 more in `Research.tsx` — and every time the two
 * drifted the symptom was the same: a control the user could press that could
 * only report a refusal. The re-run button offered on a row the run had never
 * heard of, reporting `unknown question draft-0-…`. "Write the report" visible
 * for the whole of a round, able to answer only "wait for gathering to settle".
 *
 * The rules are pure functions of the run now, so they can be pinned here
 * rather than by driving a real run against a temporary `IQ_HOME`. That is the
 * point of the predicates as much as the deduplication is: the tests that
 * covered these rules before had to spend a Coordinator, a fake agent and a
 * poll loop to assert a one-line answer.
 *
 * Every refusal is checked for a *reason*, because the reason is not
 * diagnostics — it is the string the service throws and the surface puts on the
 * disabled control. A gate that refuses silently is half a gate.
 */

function makeRun(over: Partial<ResearchRun> = {}): ResearchRun {
  return ResearchRun.parse({
    id: "res_1",
    topic: "T",
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...over,
  });
}

function question(
  id: string,
  status: ResearchQuestionStatus = "pending",
  taskId = "",
): ResearchRun["questions"][number] {
  return { id, question: `Q ${id}`, status, taskId } as ResearchRun["questions"][number];
}

/** Both terminal states and the two the user reaches before gathering. */
const IDLE: ResearchRunStatus[] = ["planning", "awaiting_review", "complete", "failed", "cancelled"];
const ACTIVE: ResearchRunStatus[] = ["gathering", "reflecting", "refining", "writing"];

describe("research run gates", () => {
  it("treats gathering, reflecting, refining and writing as the run doing work", () => {
    for (const status of ACTIVE) expect(isRunActive(makeRun({ status }))).toBe(true);
    for (const status of IDLE) expect(isRunActive(makeRun({ status }))).toBe(false);
  });

  /**
   * Cancel is offered on exactly the statuses that have something to cancel.
   * The renderer used to spell this as a three-way `||` beside a Cancel button
   * and again beside the graph, which is how "is this run still going?" came to
   * have two answers on one card.
   */
  it("offers cancel on exactly the active statuses", () => {
    for (const status of ACTIVE) expect(canCancelRun(makeRun({ status })).allowed).toBe(true);
    for (const status of IDLE) {
      const gate = canCancelRun(makeRun({ status }));
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toContain(status);
    }
  });

  it("closes plan editing the moment gathering begins", () => {
    expect(canEditPlan(makeRun({ status: "planning" })).allowed).toBe(true);
    expect(canEditPlan(makeRun({ status: "awaiting_review" })).allowed).toBe(true);

    const gate = canEditPlan(makeRun({ status: "gathering" }));
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/no longer be edited/i);
  });

  it("refuses to approve a plan with no questions", () => {
    const empty = canApprovePlan(makeRun({ status: "awaiting_review", questions: [] }));
    expect(empty.allowed).toBe(false);
    expect(empty.reason).toMatch(/at least one question/i);

    const ready = makeRun({ status: "awaiting_review", questions: [question("q1")] });
    expect(canApprovePlan(ready).allowed).toBe(true);
  });

  it("refuses to approve a run that is not awaiting review", () => {
    const gate = canApprovePlan(makeRun({ status: "planning", questions: [question("q1")] }));
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/not awaiting review/i);
  });

  /**
   * The rule that made the button honest: `gathering` is true for the whole of
   * a round, so the status alone says nothing about whether the round settled.
   */
  it("holds the report back until the round settles, and counts what it is waiting on", () => {
    const midRound = makeRun({
      status: "gathering",
      questions: [question("q1", "answered"), question("q2", "running"), question("q3", "pending")],
    });
    expect(unsettledQuestions(midRound).map((q) => q.id)).toEqual(["q2", "q3"]);

    const waiting = canWriteReport(midRound);
    expect(waiting.allowed).toBe(false);
    expect(waiting.reason).toContain("2 questions are");

    const settled = makeRun({
      status: "gathering",
      questions: [question("q1", "answered"), question("q2", "unverified"), question("q3", "failed")],
    });
    expect(unsettledQuestions(settled)).toEqual([]);
    expect(canWriteReport(settled).allowed).toBe(true);
  });

  /** One question waiting is "is", not "are" — the reason is read by a person. */
  it("agrees with itself about number", () => {
    const one = makeRun({ status: "gathering", questions: [question("q1", "running")] });
    expect(canWriteReport(one).reason).toContain("1 question is");
  });

  /**
   * `complete` is the second status that can write, and the reason it is not a
   * loosening: a finished report is exactly the thing a reader has read and
   * has something to say about. Without this, the one control offered on a
   * finished report called a channel that always refused it.
   */
  it("lets a finished run be written again", () => {
    const done = makeRun({ status: "complete", questions: [question("q1", "answered")] });
    expect(canWriteReport(done).allowed).toBe(true);
  });

  it("refuses to write from a status that has nothing settled to write from", () => {
    for (const status of ["planning", "awaiting_review", "reflecting", "refining", "writing"] as const) {
      const gate = canWriteReport(makeRun({ status, questions: [question("q1", "answered")] }));
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toMatch(/not ready to write/i);
    }
  });

  describe("revision", () => {
    /** A note is about a report, so there has to be one to be about. */
    it("refuses a note until the run has finished writing", () => {
      for (const status of ["planning", "awaiting_review", "gathering", "reflecting", "writing"] as const) {
        const gate = canRefineRun(makeRun({ status, report: { markdown: "# Report", path: "/r.md" } }), 16);
        expect(gate.allowed).toBe(false);
        expect(gate.reason).toMatch(/once the run has finished/i);
      }
    });

    it("refuses a note on a run that finished with no report", () => {
      const gate = canRefineRun(makeRun({ status: "complete" }), 16);
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toMatch(/no report to comment on/i);
    });

    /**
     * The ceiling is the whole reason the loop is safe to offer. Every note
     * can add questions, and questions cost model turns — so the run says no
     * at the same number the manager's own follow-ups are capped at, and says
     * where to go instead.
     */
    it("refuses a note once the plan has hit its question ceiling", () => {
      const full = makeRun({
        status: "complete",
        report: { markdown: "# Report", path: "/r.md" },
        questions: Array.from({ length: 16 }, (_, index) => question(`q${index}`, "answered")),
      });
      const gate = canRefineRun(full, 16);
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toMatch(/16-question ceiling/);
      expect(gate.reason).toMatch(/start a new run/i);
    });

    it("allows a note on a finished report with room left", () => {
      const run = makeRun({
        status: "complete",
        report: { markdown: "# Report", path: "/r.md" },
        questions: [question("q1", "answered")],
      });
      expect(canRefineRun(run, 16).allowed).toBe(true);
    });
  });

  /**
   * Re-run is the Coordinator's per-node retry, so it needs a node to retry —
   * and the gate is asked against the run, so a row that exists only in the
   * surface's local draft is answered here rather than named back at the user.
   */
  it("refuses to re-run a question the run has never heard of", () => {
    const run = makeRun({ status: "gathering", planId: "pln_1", questions: [question("q1", "answered", "tsk_1")] });
    const gate = canRerunQuestion(run, "draft-0-1786003914388");
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/unknown question/i);
  });

  it("refuses to re-run a question that was never delegated", () => {
    const ungathered = makeRun({ status: "awaiting_review", questions: [question("q1")] });
    expect(canRerunQuestion(ungathered, "q1").reason).toMatch(/approve the plan/i);

    // A task id without a plan is the same refusal: the retry needs both.
    const noPlan = makeRun({ status: "gathering", questions: [question("q1", "answered", "tsk_1")] });
    expect(canRerunQuestion(noPlan, "q1").reason).toMatch(/approve the plan/i);
  });

  it("allows a re-run once the question has a task on a plan", () => {
    const run = makeRun({
      status: "gathering",
      planId: "pln_1",
      questions: [question("q1", "failed", "tsk_1")],
    });
    expect(canRerunQuestion(run, "q1")).toEqual({ allowed: true, reason: "" });
  });
});
