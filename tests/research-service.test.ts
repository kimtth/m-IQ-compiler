import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveAppPaths,
  ensureAppPaths,
  type AppPaths,
} from "../packages/core/src/config/paths.js";
import { AuditLog } from "../packages/core/src/audit/audit-log.js";
import { createLogger } from "../packages/core/src/util/logger.js";
import {
  Coordinator,
  PlanStore,
  type SubAgentRequest,
} from "../packages/core/src/orchestration/coordinator.js";
import {
  ResearchService,
  type AgentRunResult,
} from "../packages/core/src/research/research-service.js";
import type { ResearchGraphDelta } from "@iq/shared";

/**
 * Research runs are exercised end-to-end through a real {@link Coordinator} with
 * a fake `delegate`, because the whole point of the service is that gathering is
 * a delegated plan — a fake coordinator would test nothing that matters.
 */

const TMP_BASE = join(dirname(fileURLToPath(import.meta.url)), ".tmp");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error("condition not met before timeout");
}

/** A delegate whose per-question reply the test controls by task title. */
type Reply = { ok: string } | { fail: string };

describe("ResearchService", () => {
  let dir: string;
  let paths: AppPaths;
  let coordinator: Coordinator;
  let replies: Map<string, Reply>;
  const logger = createLogger("error");

  beforeEach(() => {
    if (!existsSync(TMP_BASE)) mkdirSync(TMP_BASE, { recursive: true });
    dir = mkdtempSync(join(TMP_BASE, "research-"));
    paths = resolveAppPaths(dir);
    ensureAppPaths(paths);
    replies = new Map();

    coordinator = new Coordinator({
      store: new PlanStore(paths),
      logger,
      publish: () => undefined,
      audit: async () => undefined,
      delegate: async (request: SubAgentRequest) => {
        const reply = replies.get(request.task.title);
        if (!reply) throw new Error(`no reply configured for "${request.task.title}"`);
        if ("fail" in reply) throw new Error(reply.fail);
        return { result: reply.ok, sessionId: "ses_test" };
      },
    });
    // A short interval so retried and re-run tasks are re-dispatched promptly.
    coordinator.start(20);
  });

  afterEach(() => {
    coordinator.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeService(runAgent?: (p: string) => AgentRunResult): ResearchService {
    return new ResearchService({
      logger,
      audit: new AuditLog(paths),
      paths,
      coordinator,
      runAgent: async ({ prompt }) => runAgent?.(prompt) ?? { text: "report body", toolCalls: [] },
      resolveModel: async () => ({ id: "copilot:test", displayName: "Test" }),
      projectDir: () => null,
      correlationId: () => "cor_test",
    });
  }

  const answer = (findings: string, citations: unknown[], conflicts: unknown[] = []): string =>
    JSON.stringify({ findings, citations, conflicts, sources: [] });

  /**
   * Wait for a round to settle *through* reflection.
   *
   * Gathering finishing is no longer the end of a round: the manager reads the
   * findings back and may open another one. Waiting on "no question is pending"
   * lands in the gap between the two, where the run still looks finished — so
   * this waits on the ledger, which is written exactly once per closed round
   * and is the only durable evidence that reflection actually ran.
   */
  const settled = async (
    service: ResearchService,
    runId: string,
    rounds = 1,
  ): Promise<void> => {
    await waitUntil(async () => {
      const run = await service.get(runId);
      if (!run) return false;
      if (run.status !== "gathering" || run.ledger.length < rounds) return false;
      return run.questions.every((q) => q.status !== "pending" && q.status !== "running");
    });
  };

  /** A manager reply the service will accept. */
  const verdict = (value: {
    assessment?: string;
    weak?: string[];
    followUps?: string[];
    done?: boolean;
  }): string => JSON.stringify({ assessment: "", weak: [], followUps: [], done: false, ...value });

  it("starts independently of an active chat session", async () => {
    const service = makeService();

    // `sessionId` was accepted by older renderer builds. The boundary ignores
    // it so starting Research cannot take over or re-file that conversation.
    const run = await service.start({
      topic: "Standalone research",
      questions: ["Q one"],
      sessionId: "ses_active_chat",
    } as never);

    expect(run.sessionId).toBeNull();
  });

  it("deletes one saved run without affecting another", async () => {
    const service = makeService();
    const first = await service.start({ topic: "Remove me", questions: ["Q one"] } as never);
    const second = await service.start({ topic: "Keep me", questions: ["Q two"] } as never);

    await service.delete(first.id);

    expect(await service.get(first.id)).toBeNull();
    expect((await service.list()).map((run) => run.id)).toEqual([second.id]);
    expect(existsSync(join(paths.root, "research", first.id))).toBe(false);
  });

  it("records an uncited finding as unverified, never answered", async () => {
    const service = makeService();
    const run = await service.start({ topic: "T", questions: ["Q one"] } as never);
    replies.set("Q one", { ok: answer("something is true", []) });

    await service.approvePlan(run.id);
    await waitUntil(async () => {
      const current = await service.get(run.id);
      return (
        current?.questions.every((q) => q.status !== "pending" && q.status !== "running") ?? false
      );
    });

    const current = await service.get(run.id);
    expect(current?.questions[0]?.status).toBe("unverified");
    expect(current?.questions[0]?.findings).toBe("something is true");
  });

  it("records disagreeing sources as a conflict rather than resolving them", async () => {
    const service = makeService();
    const run = await service.start({ topic: "T", questions: ["Q conflict"] } as never);
    replies.set("Q conflict", {
      ok: answer(
        "the answer is disputed",
        [{ kind: "url", ref: "https://a.example/x", title: "A" }],
        [
          {
            claim: "is it X or Y",
            positions: [
              { statement: "X", citation: { kind: "url", ref: "https://a.example/x" } },
              { statement: "Y", citation: { kind: "url", ref: "https://b.example/y" } },
            ],
          },
        ],
      ),
    });

    await service.approvePlan(run.id);
    await waitUntil(async () => (await service.get(run.id))?.questions[0]?.status === "answered");

    const q = (await service.get(run.id))?.questions[0];
    expect(q?.status).toBe("answered");
    expect(q?.conflicts).toHaveLength(1);
    expect(q?.conflicts[0]?.positions).toHaveLength(2);
  });

  it("leaves the rest of the run intact when one question fails, and reruns it in isolation", async () => {
    const service = makeService();
    const run = await service.start({ topic: "T", questions: ["Q good", "Q bad"] } as never);
    replies.set("Q good", { ok: answer("ok", [{ kind: "url", ref: "https://ok.example" }]) });
    replies.set("Q bad", { fail: "the source was unreachable" });

    await service.approvePlan(run.id);
    await waitUntil(async () => {
      const c = await service.get(run.id);
      return (
        c?.questions.find((q) => q.question === "Q bad")?.status === "failed" &&
        c?.questions.find((q) => q.question === "Q good")?.status === "answered"
      );
    });

    const afterGather = await service.get(run.id);
    const bad = afterGather?.questions.find((q) => q.question === "Q bad");
    expect(afterGather?.questions.find((q) => q.question === "Q good")?.status).toBe("answered");
    expect(bad?.status).toBe("failed");

    // Re-run only the failed question; the good one must not be re-gathered.
    replies.set("Q bad", { ok: answer("now sourced", [{ kind: "url", ref: "https://fixed.example" }]) });
    await service.rerunQuestion(run.id, bad!.id);
    await waitUntil(
      async () =>
        (await service.get(run.id))?.questions.find((q) => q.question === "Q bad")?.status ===
        "answered",
    );

    const healed = await service.get(run.id);
    expect(healed?.questions.find((q) => q.question === "Q bad")?.status).toBe("answered");
    expect(healed?.questions.find((q) => q.question === "Q good")?.status).toBe("answered");
  });

  /**
   * What makes a question re-runnable, stated so the surface can ask the same
   * question the service does.
   *
   * Re-run is the Coordinator's per-node retry, so it needs a node: `taskId` is
   * empty until the plan is approved and the question delegated. Research.tsx
   * offers the control only when `taskId !== ""` for exactly this reason —
   * before the guard it was drawn on every row, including one the user had
   * just added, and the failure reported the renderer's own React key back as
   * `unknown question draft-0-…`.
   */
  it("refuses to re-run a question that has not been gathered", async () => {
    const service = makeService();
    const run = await service.start({ topic: "T", questions: ["Q one"] } as never);

    const pending = run.questions[0];
    expect(pending?.taskId).toBe("");
    await expect(service.rerunQuestion(run.id, pending!.id)).rejects.toThrow(/approve the plan/i);

    // And a question the surface invented is never a question of this run.
    await expect(service.rerunQuestion(run.id, "draft-0-1786003914388")).rejects.toThrow(
      /unknown question/i,
    );
  });

  /**
   * The reasoning graph is a stream of deltas with no terminal frame.
   *
   * So a sidecar that stops between a step starting and finishing leaves that
   * node `running` in the UI for good — which is what "endless running" looks
   * like from the outside, and it is the most trusted thing on the surface.
   * Failure here is deliberately silent (a dead sidecar must never fail a run
   * that is gathering perfectly well), and silence was being taken as "still
   * working".
   */
  it("settles the graph nodes it left running when the workflow stops", async () => {
    const deltas: ResearchGraphDelta[] = [];
    const service = new ResearchService({
      logger,
      audit: new AuditLog(paths),
      paths,
      coordinator,
      runAgent: async () => ({ text: "report body", toolCalls: [] }),
      resolveModel: async () => ({ id: "copilot:test", displayName: "Test" }),
      projectDir: () => null,
      correlationId: () => "cor_test",
      onGraph: (delta) => deltas.push(delta),
      sidecar: {
        status: async () => ({ ready: true, python: "py", version: "0.1.0", message: "" }),
        run: async (_request: unknown, onEvent: (event: never) => void) => {
          onEvent({ type: "node", id: "plan", kind: "plan", label: "Plan", status: "done", detail: "", round: 1 } as never);
          onEvent({ type: "node", id: "q0", kind: "question", label: "Q one", status: "running", detail: "", round: 1 } as never);
          onEvent({ type: "node", id: "q1", kind: "question", label: "Q two", status: "running", detail: "", round: 1 } as never);
          onEvent({ type: "node_status", id: "q1", status: "done", detail: "2 citations" } as never);
          return { graph: { nodes: [], edges: [] }, result: null, problem: "the workflow was cancelled" };
        },
      } as never,
    });

    replies.set("Q one", { ok: answer("ok", [{ kind: "url", ref: "https://ok.example" }]) });
    const run = await service.start({ topic: "T", questions: ["Q one"] } as never);
    await service.approvePlan(run.id);
    await waitUntil(async () => deltas.some((delta) => delta.node?.status === "failed"));

    // The one still in flight is settled with the reason; the two that reported
    // for themselves are left exactly as they reported.
    const settledNodes = deltas.filter((delta) => delta.node?.status === "failed");
    expect(settledNodes.map((delta) => delta.node?.id)).toEqual(["q0"]);
    expect(settledNodes[0]?.node?.detail).toBe("the workflow was cancelled");
    expect(deltas.filter((delta) => delta.node?.id === "q1" && delta.node.status === "failed")).toEqual([]);
    expect(deltas.filter((delta) => delta.node?.id === "plan" && delta.node.status === "failed")).toEqual([]);

    // Let the round finish before the fixture is torn down. The graph settles
    // long before the gathering does, so returning here would leave the
    // coordinator polling a plan whose directory is about to be deleted.
    await settled(service, run.id);
  });

  /**
   * The cap the user chose has to survive the gap between starting a run and
   * approving its plan: `research:approvePlan` carries a run id and nothing
   * else, so a value held only in memory is a value that is always the default.
   */
  it("gathers with the parallelism the run was started with, not the default", async () => {
    const service = makeService();
    const run = await service.start({
      topic: "T",
      questions: ["Q1"],
      maxParallel: 1,
    } as never);
    expect(run.maxParallel).toBe(1);

    replies.set("Q1", { ok: answer("ok", [{ kind: "url", ref: "https://a.example" }]) });
    // Approved the way the IPC channel approves it: with the run id alone.
    const approved = await service.approvePlan(run.id);
    expect(approved.maxParallel).toBe(1);

    const plan = await coordinator.getPlan(approved.planId);
    expect(plan?.plan.maxParallel).toBe(1);

    // Settled before returning, or the coordinator keeps advancing a plan whose
    // directory `afterEach` has already removed.
    await settled(service, run.id);
  });

  it("keeps that cap for a run reloaded from disk, so a restart cannot change it", async () => {
    const service = makeService();
    const run = await service.start({ topic: "T", questions: ["Q1"], maxParallel: 2 } as never);

    const reloaded = new ResearchService({
      logger,
      audit: new AuditLog(paths),
      paths,
      coordinator,
      runAgent: async () => ({ text: "x", toolCalls: [] }),
      resolveModel: async () => ({ id: "copilot:test", displayName: "Test" }),
      projectDir: () => null,
      correlationId: () => "cor_test",
    });
    expect((await reloaded.get(run.id))?.maxParallel).toBe(2);
  });

  it("reloads a persisted run from disk", async () => {
    const service = makeService();
    const run = await service.start({ topic: "Persist me", questions: ["Q p"] } as never);

    const reloaded = new ResearchService({
      logger,
      audit: new AuditLog(paths),
      paths,
      coordinator,
      runAgent: async () => ({ text: "x", toolCalls: [] }),
      resolveModel: async () => ({ id: "copilot:test", displayName: "Test" }),
      projectDir: () => null,
      correlationId: () => "cor_test",
    });
    const fromDisk = await reloaded.get(run.id);
    expect(fromDisk?.topic).toBe("Persist me");
    expect(fromDisk?.status).toBe("awaiting_review");
    expect(fromDisk?.questions[0]?.question).toBe("Q p");
  });

  it("assembles a report with a source table and a coverage summary", async () => {
    const service = makeService((prompt) => ({ text: `NARRATIVE for ${prompt.length}`, toolCalls: [] }));
    const run = await service.start({ topic: "Reporting", questions: ["Q1", "Q2"] } as never);
    replies.set("Q1", { ok: answer("found", [{ kind: "url", ref: "https://src.example/a", title: "A" }]) });
    replies.set("Q2", { ok: answer("nothing sourced", []) });

    await service.approvePlan(run.id);
    await waitUntil(async () => {
      const c = await service.get(run.id);
      return c?.questions.every((q) => q.status === "answered" || q.status === "unverified") ?? false;
    });
    await settled(service, run.id);

    const done = await service.write(run.id);
    expect(done.status).toBe("complete");
    expect(done.status).toBe("complete");
    expect(done.report.markdown).toContain("## Sources");
    expect(done.report.markdown).toContain("## Coverage summary");
    // The unverified question is named as a gap, enforced from data not prose.
    expect(done.report.coverage.some((gap) => gap.startsWith("Q2"))).toBe(true);
  });

  /**
   * The phase the pipeline did not have.
   *
   * Gathering answered the questions it was given; nothing asked whether those
   * were the right questions or whether the evidence supported a report.
   * `coverageGaps` knew, and wrote the gaps into the report as a disclaimer.
   */
  describe("reflection", () => {
    it("raises a follow-up for a thin answer and gathers it as a second round", async () => {
      const service = makeService((prompt) =>
        prompt.startsWith("You are reviewing round 1")
          ? { text: verdict({ assessment: "Q1 is uncited", weak: [], followUps: ["Q1 follow-up"] }), toolCalls: [] }
          : { text: "narrative", toolCalls: [] },
      );
      const run = await service.start({ topic: "T", questions: ["Q1"], maxRounds: 2 } as never);
      replies.set("Q1", { ok: answer("unsourced claim", []) });
      replies.set("Q1 follow-up", {
        ok: answer("now sourced", [{ kind: "url", ref: "https://found.example" }]),
      });

      await service.approvePlan(run.id);
      await settled(service, run.id, 2);

      const done = await service.get(run.id);
      expect(done?.round).toBe(2);
      expect(done?.questions).toHaveLength(2);
      const followUp = done?.questions[1];
      expect(followUp?.question).toBe("Q1 follow-up");
      expect(followUp?.round).toBe(2);
      expect(followUp?.status).toBe("answered");
      // The ledger says why it went again, so it is answerable after the fact.
      expect(done?.ledger[0]?.assessment).toBe("Q1 is uncited");
      expect(done?.ledger[0]?.followUps).toEqual(["Q1 follow-up"]);
    });

    it("spends no round when every question came back cited", async () => {
      // Nothing for a follow-up to aim at, so the manager is never even asked —
      // a round costs sub-agent turns and must be earned.
      let asked = 0;
      const service = makeService((prompt) => {
        if (prompt.startsWith("You are reviewing round")) asked += 1;
        return { text: verdict({ followUps: ["never"] }), toolCalls: [] };
      });
      const run = await service.start({ topic: "T", questions: ["Q1"] } as never);
      replies.set("Q1", { ok: answer("solid", [{ kind: "url", ref: "https://a.example" }]) });

      await service.approvePlan(run.id);
      await settled(service, run.id);

      const done = await service.get(run.id);
      expect(asked).toBe(0);
      expect(done?.round).toBe(1);
      expect(done?.questions).toHaveLength(1);
      expect(done?.ledger[0]?.stopped).toMatch(/answered with a citation/);
    });

    it("stops at the round budget however many follow-ups it wants", async () => {
      // The manager decides *whether* to go again; the budget decides how far
      // that can ever go, and it is enforced in code rather than asked for.
      const service = makeService((prompt) =>
        prompt.startsWith("You are reviewing round")
          ? { text: verdict({ followUps: ["more", "and more"] }), toolCalls: [] }
          : { text: "narrative", toolCalls: [] },
      );
      const run = await service.start({ topic: "T", questions: ["Q1"], maxRounds: 1 } as never);
      replies.set("Q1", { ok: answer("thin", []) });

      await service.approvePlan(run.id);
      await settled(service, run.id);

      const done = await service.get(run.id);
      expect(done?.round).toBe(1);
      expect(done?.questions).toHaveLength(1);
      expect(done?.ledger[0]?.stopped).toMatch(/round budget/);
    });

    it("drops a verdict that names a question which does not exist", async () => {
      const service = makeService((prompt) =>
        prompt.startsWith("You are reviewing round")
          ? { text: verdict({ weak: ["tsk_not_a_real_id"], followUps: ["Q1 follow-up"] }), toolCalls: [] }
          : { text: "narrative", toolCalls: [] },
      );
      const run = await service.start({ topic: "T", questions: ["Q1"], maxRounds: 2 } as never);
      replies.set("Q1", { ok: answer("thin", []) });
      replies.set("Q1 follow-up", { ok: answer("ok", [{ kind: "url", ref: "https://a.example" }]) });

      await service.approvePlan(run.id);
      await settled(service, run.id, 2);

      const done = await service.get(run.id);
      expect(done?.ledger[0]?.weak).toEqual([]);
      // The follow-up still runs; only the unverifiable id was dropped, and it
      // is recorded with no parent rather than a made-up one.
      expect(done?.questions[1]?.parentId).toBe("");
    });

    it("keeps every finding when the review itself fails", async () => {
      // A manager turn that will not parse must not cost a run its work — the
      // report has to remain writable.
      const service = makeService(() => ({ text: "not json at all", toolCalls: [] }));
      const run = await service.start({ topic: "T", questions: ["Q1"], maxRounds: 2 } as never);
      replies.set("Q1", { ok: answer("thin", []) });

      await service.approvePlan(run.id);
      await settled(service, run.id);

      const done = await service.get(run.id);
      expect(done?.questions[0]?.findings).toBe("thin");
      expect(done?.ledger[0]?.stopped).toMatch(/could not be reviewed/);
      // And the report can still be written.
      expect((await service.write(run.id)).status).toBe("complete");
    });
  });

  /**
   * The turn the reader gets.
   *
   * Research used to stop at `complete`: a report, and no way to answer it.
   * These pin the three things that makes the loop worth having — a note can
   * buy new evidence, a note that needs no evidence still gets an answer, and
   * a note that fails costs the reader nothing.
   */
  describe("revision", () => {
    /** Drive a run to a finished report so a note has something to be about. */
    const reported = async (
      service: ResearchService,
      questions: string[],
    ): Promise<string> => {
      const run = await service.start({ topic: "T", questions } as never);
      await service.approvePlan(run.id);
      await settled(service, run.id);
      await service.write(run.id);
      return run.id;
    };

    it("turns a note into new questions, gathers them, and writes the report again", async () => {
      let reports = 0;
      const service = makeService((prompt) => {
        if (prompt.startsWith("A reader has commented")) {
          return {
            text: JSON.stringify({ questions: ["What did the vendor's own filing say?"] }),
            toolCalls: [],
          };
        }
        if (prompt.startsWith("Write a comprehensive")) {
          reports += 1;
          return { text: `narrative ${reports}`, toolCalls: [] };
        }
        return { text: verdict({ done: true }), toolCalls: [] };
      });

      replies.set("Q1", { ok: answer("cost is $5", [{ kind: "url", ref: "https://blog.example" }]) });
      replies.set("What did the vendor's own filing say?", {
        ok: answer("the filing says $9", [{ kind: "url", ref: "https://sec.example/10k" }]),
      });

      const runId = await reported(service, ["Q1"]);
      await service.refine({ runId, note: "the cost figure rests on one blog post" });

      // The follow-up round has to settle, then the owed rewrite lands.
      await waitUntil(async () => (await service.get(runId))?.status === "complete");

      const done = await service.get(runId);
      expect(done?.questions).toHaveLength(2);
      expect(done?.questions[1]?.question).toBe("What did the vendor's own filing say?");
      expect(done?.questions[1]?.round).toBe(2);
      expect(done?.questions[1]?.status).toBe("answered");
      // The note is kept with what it produced, so a changed report can say why.
      expect(done?.feedback).toHaveLength(1);
      expect(done?.feedback[0]?.note).toBe("the cost figure rests on one blog post");
      expect(done?.feedback[0]?.questions).toEqual(["What did the vendor's own filing say?"]);
      // Two reports: the first, and the one the note bought.
      expect(reports).toBe(2);
      expect(done?.report.markdown).toContain("narrative 2");
      expect(done?.report.markdown).toContain("https://sec.example/10k");
      expect(done?.pendingRewrite).toBe(false);
    });

    /**
     * "Too long" needs no research. It still needs an answer — so the report is
     * written again from the evidence already gathered, with the note in front
     * of the writer, and no sub-agent turn is spent.
     */
    it("rewrites from the same evidence when a note asks for no new evidence", async () => {
      let writerSawTheNote = false;
      const service = makeService((prompt) => {
        if (prompt.startsWith("A reader has commented")) {
          return { text: JSON.stringify({ questions: [], rewrite: true }), toolCalls: [] };
        }
        if (prompt.startsWith("Write a comprehensive")) {
          if (prompt.includes("lead with the numbers")) writerSawTheNote = true;
          return { text: "narrative", toolCalls: [] };
        }
        return { text: verdict({ done: true }), toolCalls: [] };
      });
      replies.set("Q1", { ok: answer("found", [{ kind: "url", ref: "https://a.example" }]) });

      const runId = await reported(service, ["Q1"]);
      const after = await service.refine({ runId, note: "lead with the numbers, not the history" });

      expect(after.status).toBe("complete");
      expect(after.questions).toHaveLength(1);
      expect(after.feedback[0]?.declined).toBe("");
      expect(writerSawTheNote).toBe(true);
    });

    it("records why a note raised nothing rather than silently doing nothing", async () => {
      const service = makeService((prompt) => {
        if (prompt.startsWith("A reader has commented")) {
          return {
            text: JSON.stringify({ questions: [], rewrite: false, declined: "the report already says this" }),
            toolCalls: [],
          };
        }
        return prompt.startsWith("Write a comprehensive")
          ? { text: "narrative", toolCalls: [] }
          : { text: verdict({ done: true }), toolCalls: [] };
      });
      replies.set("Q1", { ok: answer("found", [{ kind: "url", ref: "https://a.example" }]) });

      const runId = await reported(service, ["Q1"]);
      const after = await service.refine({ runId, note: "say what the cost was" });

      expect(after.status).toBe("complete");
      expect(after.feedback[0]?.declined).toBe("the report already says this");
      expect(after.feedback[0]?.questions).toEqual([]);
    });

    it("leaves the report untouched when the revision turn fails", async () => {
      const service = makeService((prompt) => {
        if (prompt.startsWith("A reader has commented")) throw new Error("model unavailable");
        return prompt.startsWith("Write a comprehensive")
          ? { text: "the original narrative", toolCalls: [] }
          : { text: verdict({ done: true }), toolCalls: [] };
      });
      replies.set("Q1", { ok: answer("found", [{ kind: "url", ref: "https://a.example" }]) });

      const runId = await reported(service, ["Q1"]);
      const after = await service.refine({ runId, note: "this needs a primary source" });

      // Back where it started, with the failure named — not stuck in `refining`.
      expect(after.status).toBe("complete");
      expect(after.report.markdown).toContain("the original narrative");
      expect(after.questions).toHaveLength(1);
      expect(after.feedback[0]?.declined).toBe("model unavailable");
    });

    it("refuses a note on a run that has not written a report", async () => {
      const service = makeService();
      const run = await service.start({ topic: "T", questions: ["Q1"] } as never);
      await expect(service.refine({ runId: run.id, note: "fix this" })).rejects.toThrow(
        /once the run has finished/i,
      );
    });
  });
});
