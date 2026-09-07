import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  RESEARCH_QUESTION_CEILING,
  ResearchCitation,
  ResearchConflict,
  ResearchQuestion,
  ResearchRefineInput,
  ResearchReport,
  ResearchRun,
  ResearchStartInput,
  canApprovePlan,
  canEditPlan,
  canRefineRun,
  canRerunQuestion,
  canWriteReport,
  isRunActive,
  newCorrelationId,
  newTaskId,
  type CitationKind,
  type ModelRole,
  type ResearchGate,
  type ResearchGraphDelta,
} from "@iq/shared";
import { z } from "zod";
import { researchModelFor, type ResearchSidecar, type SidecarEvent } from "./agent-framework.js";
import { readJson, writeJsonAtomic } from "../util/jsonl.js";
import { KeyedMutex } from "../util/lock.js";
import type { AppPaths } from "../config/paths.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { Logger } from "../util/logger.js";
import type { Coordinator, PlanDocument } from "../orchestration/coordinator.js";
import type {
  AgentRunLabel,
  AgentRunRequest,
  AgentRunResult,
  RunAgent,
} from "../runtime/agent-run.js";

/**
 * Chat → Research.
 *
 * A research run is deliberately a visible plan, not a black box: the topic is
 * decomposed into questions the user can edit, the questions are gathered in
 * parallel, and one writer agent synthesises the report so voice and structure
 * stay consistent. Three design decisions drive this file.
 *
 *  1. Gathering is delegated through the {@link Coordinator}, not run inline.
 *     "Parallel sub-agents gather; one agent writes" is a product requirement,
 *     but the deeper reason is governance: a gathering run must appear in
 *     Control Center → Delegated plans as a DAG with per-node status and
 *     per-node retry, and the Coordinator is the one component that already
 *     provides durable, restart-safe, individually-retryable task execution.
 *     Reimplementing that here would be a second, weaker copy of it.
 *
 *  2. Citation discipline is enforced in code, never left to the prompt. A
 *     finding the sub-agent returns without a citation is recorded as
 *     `unverified`, never `answered`; disagreeing sources become a
 *     {@link ResearchConflict} rather than being silently reconciled; and an
 *     answer we cannot parse against the zod contracts is a `failed` question
 *     rather than invented content. The prompt asks for a structured payload
 *     precisely so these rules can be applied to data rather than to prose.
 *
 *  3. Every run is durable under `<root>/research/<id>/run.json` and re-attached
 *     on boot. Because the heavy lifting lives in the Coordinator's own durable
 *     plan store, resuming a gathering run is just re-attaching to its plan;
 *     anything that cannot be re-attached is failed with a stated reason rather
 *     than left spinning at "running" forever.
 */

export type { AgentRunLabel, AgentRunRequest, AgentRunResult, RunAgent };

/** Resolves a role to a model without reaching into the registry directly. */
export type ResolveModel = (
  role: ModelRole,
  projectId: string | null,
) => Promise<{ id: string; displayName: string } | null>;

export interface ResearchDeps {
  logger: Logger;
  audit: AuditLog;
  paths: AppPaths;
  /** Sub-agent gathering is delegated here so it lands in Delegated plans. */
  coordinator: Coordinator;
  /** Runs the decomposition and the single writer turn. */
  runAgent: RunAgent;
  resolveModel: ResolveModel;
  /** The bound project's absolute directory, or null when Chat-scoped. */
  projectDir: () => string | null;
  /** Correlation id for the originating request; falls back to a fresh one. */
  correlationId: () => string;
  /**
   * Tool families a gathering sub-agent is granted. Conservative by default —
   * read-oriented investigation surfaces — and widened by the orchestrator when
   * a run needs more reach. The governed registry filters unknown families.
   */
  gatheringToolFamilies?: string[];
  /**
   * The Agent Framework workflow, when this machine has one prepared.
   *
   * Optional because absence is a downgrade, not a failure: without it the
   * Coordinator pipeline below runs exactly as before. What it adds is the
   * framework's own account of the run — which executor is live, which question
   * is in flight — which is what the graph draws.
   */
  sidecar?: ResearchSidecar;
  /** One node or edge of a running graph, pushed as the workflow emits it. */
  onGraph?: (delta: ResearchGraphDelta) => void;
  now?: () => Date;
}

export type ResearchListener = (run: ResearchRun) => void;

/** The report body cap handed to the writer, so a huge plan cannot blow up a turn. */
const MAX_WRITER_CONTEXT = 60_000;

const DEFAULT_GATHERING_FAMILIES = ["browser", "knowledge", "workiq"] as const;

/**
 * Hard ceiling on the questions a run may accumulate across every round.
 *
 * A loop that can extend its own plan needs a bound it cannot reason its way
 * past. The manager decides *whether* to go again; this decides how far that
 * can ever go, and it is enforced in code rather than asked for in a prompt.
 *
 * Defined in `@iq/shared` because the surface has to refuse a reader's note
 * before sending it, and a ceiling only this file knows is one the reader meets
 * as an error after writing.
 */
const MAX_TOTAL_QUESTIONS = RESEARCH_QUESTION_CEILING;

/** Follow-ups one round may raise, so a single verdict cannot flood the plan. */
const MAX_FOLLOW_UPS = 4;

/**
 * What the manager is allowed to conclude.
 *
 * Deliberately narrow. It may say the evidence is sufficient, name the
 * questions it found thin, and propose follow-ups — and nothing else. It cannot
 * return findings, citations or conflicts, so there is no path by which a
 * reviewing turn can add uncited content to a report. Citation discipline stays
 * where it was: in code, applied to sub-agent payloads.
 */
const ManagerVerdict = z.object({
  /** One paragraph on where the evidence stands, for the ledger. */
  assessment: z.string().default(""),
  /** Ids of questions whose answers are thin, missing or contradicted. */
  weak: z.array(z.string()).default([]),
  /** New questions that would close those gaps. */
  followUps: z.array(z.string().min(1).max(500)).default([]),
  /** True when another round would add nothing. */
  done: z.boolean().default(false),
});

/**
 * What a refine turn is allowed to conclude.
 *
 * Narrower than {@link ManagerVerdict}, and narrow for the same reason: it may
 * turn the reader's note into questions, or say the note needs no new evidence.
 * It cannot write findings, citations or conflicts, so a reader cannot talk
 * content into a report by asking for it — they can only cause it to be looked
 * up and cited like everything else.
 */
const RefinePlan = z.object({
  /** Questions that would answer the note. Empty means nothing to gather. */
  questions: z.array(z.string().min(1).max(500)).default([]),
  /**
   * True when the note is about wording, structure or emphasis and the report
   * should be written again from the evidence already gathered.
   *
   * Separate from `questions` because the two failures are different: a report
   * that buries its conflicts needs rewriting, not re-researching, and
   * gathering more sources would not fix it.
   */
  rewrite: z.boolean().default(false),
  /**
   * Why no question was raised, in words the reader should read.
   *
   * Present so a note that changes nothing still gets an answer. Silence would
   * be indistinguishable from the feature being broken.
   */
  declined: z.string().default(""),
});

/**
 * The shape a gathering sub-agent must return.
 *
 * Kept intentionally lenient at the edges — the sub-agent supplies a citation's
 * kind, ref and title, and we stamp `retrievedAt` ourselves — so a model that
 * omits an ISO timestamp does not cost us an otherwise good, cited finding.
 */
const GatheredCitation = z.object({
  kind: z.enum(["url", "api", "m365", "artifact"]).default("url"),
  ref: z.string().min(1),
  title: z.string().default(""),
});

const GatheredConflict = z.object({
  claim: z.string().min(1),
  positions: z
    .array(z.object({ statement: z.string().min(1), citation: GatheredCitation }))
    .min(2),
});

const GatheredAnswer = z.object({
  findings: z.string().default(""),
  citations: z.array(GatheredCitation).default([]),
  conflicts: z.array(GatheredConflict).default([]),
  sources: z.array(z.string()).default([]),
});

/**
 * Refuse with the gate's own sentence.
 *
 * The reason is thrown verbatim rather than wrapped, because the surface puts
 * the same string on the disabled control. A message the service decorates here
 * is a message the button cannot show, and then there are two of them again.
 */
function enforce(gate: ResearchGate): void {
  if (!gate.allowed) throw new Error(gate.reason);
}

export class ResearchService {
  /** One store, one lock per run: two advances of a run can never interleave. */
  private readonly locks = new KeyedMutex();
  private readonly listeners = new Set<ResearchListener>();
  /** Runs whose gathering poll loop is live, so we never start it twice. */
  private readonly driving = new Set<string>();
  /**
   * The sidecar observation in flight for a run, so cancelling stops it.
   *
   * The graph workflow is a real child process making real model calls; without
   * a handle on it, `cancel()` stopped the Coordinator and left the sidecar
   * running until its idle timeout — spending a budget for a run the user had
   * already abandoned.
   */
  private readonly observing = new Map<string, AbortController>();

  constructor(private readonly deps: ResearchDeps) {}

  onChange(listener: ResearchListener): void {
    this.listeners.add(listener);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private dir(runId: string): string {
    return join(this.deps.paths.root, "research", runId);
  }

  private file(runId: string): string {
    return join(this.dir(runId), "run.json");
  }

  // --- persistence ---------------------------------------------------------

  private async read(runId: string): Promise<ResearchRun | null> {
    const raw = await readJson<unknown>(this.file(runId), null);
    if (!raw) return null;
    const parsed = ResearchRun.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  private async requireRun(runId: string): Promise<ResearchRun> {
    const run = await this.read(runId);
    if (!run) throw new Error(`unknown research run ${runId}`);
    return run;
  }

  private async persist(run: ResearchRun): Promise<ResearchRun> {
    const next = { ...run, updatedAt: this.nowIso() };
    await writeJsonAtomic(this.file(next.id), next);
    for (const listener of this.listeners) listener(next);
    return next;
  }

  /**
   * Write a finished run verbatim, for the sample data to show.
   *
   * Research fans out to sub-agents and fetches the open web, so there is no
   * way to see a finished report without a model, a network and the time to
   * wait for both. The sample run is how the surface can be read — the plan,
   * the cited report and the gaps it admits to — before any of that is set up.
   *
   * Separate from {@link persist} because that stamps `updatedAt` with the
   * clock, and a seeded run keeps the timestamps it was written with.
   */
  async seed(run: ResearchRun): Promise<void> {
    const parsed = ResearchRun.parse(run);
    await mkdir(this.dir(parsed.id), { recursive: true });
    await writeJsonAtomic(this.file(parsed.id), parsed);
    for (const listener of this.listeners) listener(parsed);
  }

  /** Read-modify-write under a per-run lock, then publish the result. */
  private mutate(runId: string, fn: (run: ResearchRun) => ResearchRun): Promise<ResearchRun> {
    return this.locks.withLock(runId, async () => {
      const run = await this.requireRun(runId);
      return this.persist(fn(run));
    });
  }

  async get(runId: string): Promise<ResearchRun | null> {
    return this.read(runId);
  }

  /** Every persisted run, newest first. */
  async list(limit = 50): Promise<ResearchRun[]> {
    const { readdir } = await import("node:fs/promises");
    const base = join(this.deps.paths.root, "research");
    const ids = await readdir(base).catch(() => [] as string[]);
    const runs: ResearchRun[] = [];
    for (const id of ids) {
      const run = await this.read(id);
      if (run) runs.push(run);
    }
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * Start a run and leave it in `awaiting_review` for the user to edit the plan.
   *
   * Seeded questions win outright — the user has already told us the plan — and
   * only an empty seed triggers an agent decomposition. A decomposition that
   * cannot be parsed fails the run rather than proceeding with a guessed plan,
   * because a research report built on an unstated plan is exactly the black box
   * this feature exists to avoid.
   */
  async start(input: ResearchStartInput): Promise<ResearchRun> {
    const parsed = ResearchStartInput.parse(input);
    const runId = newTaskId();
    const correlationId = this.deps.correlationId() || newCorrelationId();
    const now = this.nowIso();

    let run = ResearchRun.parse({
      id: runId,
      topic: parsed.topic,
      // Research is a standalone surface. It must not seize the active chat
      // conversation or make that thread reopen on Research later.
      sessionId: null,
      projectId: parsed.projectId,
      status: "planning",
      questions: [],
      report: {},
      planId: "",
      round: 1,
      maxRounds: parsed.maxRounds,
      // Recorded now, because this is the only moment the caller states it: the
      // approve channel carries a run id and nothing else.
      maxParallel: parsed.maxParallel,
      ledger: [],
      writerModelId: "",
      correlationId,
      error: "",
      createdAt: now,
      updatedAt: now,
    });
    await mkdir(this.dir(runId), { recursive: true });
    run = await this.persist(run);

    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "research.run_started",
      family: "research",
      outcome: "allowed",
      correlationId,
      resources: [runId],
      reason: `topic decomposed into a reviewable plan (maxParallel ${parsed.maxParallel})`,
    });

    let questionTexts = parsed.questions;
    if (questionTexts.length === 0) {
      try {
        questionTexts = await this.decompose(parsed.topic, parsed.projectId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return this.persist({ ...run, status: "failed", error: message });
      }
    }

    const questions = questionTexts.map((text) => this.freshQuestion(text));
    return this.persist({
      ...run,
      status: "awaiting_review",
      questions,
    });
  }

  /**
   * Replace the plan while it is still editable.
   *
   * A question whose text is unchanged keeps its id and any findings it already
   * has; a reworded or new question is reset to `pending`. Editing is refused
   * once gathering has begun, because a plan the sub-agents are already running
   * against cannot be quietly rewritten underneath them.
   */
  async updatePlan(
    runId: string,
    questions: Array<{ id?: string; question: string }>,
  ): Promise<ResearchRun> {
    return this.mutate(runId, (run) => {
      enforce(canEditPlan(run));
      const existing = new Map(run.questions.map((q) => [q.id, q]));
      const next = questions.map((entry) => {
        const prior = entry.id ? existing.get(entry.id) : undefined;
        if (prior && prior.question === entry.question) return prior;
        return this.freshQuestion(entry.question, prior?.id);
      });
      return { ...run, status: "awaiting_review", questions: next };
    });
  }

  /**
   * Approve the plan and start gathering.
   *
   * Gathering is one delegated plan per round, with one task per question and
   * no dependencies between them — every question is independent, which is what
   * lets the Coordinator run them in parallel up to `maxParallel` and retry any
   * one in isolation. A round is a plan, so Delegated plans shows each round's
   * DAG separately rather than one plan that grows underneath the user.
   */
  async approvePlan(runId: string, maxParallel?: number): Promise<ResearchRun> {
    const prepared = await this.mutate(runId, (run) => {
      enforce(canApprovePlan(run));
      // An explicit argument overrides, but the normal path has none: the IPC
      // channel carries only a run id, so the cap is the one recorded at start.
      const cap = maxParallel ?? run.maxParallel;
      return { ...run, status: "gathering", maxParallel: cap, error: "" };
    });

    const cap = prepared.maxParallel;
    const withTasks = await this.gatherRound(prepared, prepared.questions, cap);

    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "research.plan_approved",
      family: "research",
      outcome: "allowed",
      correlationId: withTasks.correlationId,
      resources: [runId, withTasks.planId],
      reason: `${withTasks.questions.length} questions delegated as plan ${withTasks.planId} (maxParallel ${cap})`,
    });

    void this.drive(runId);
    void this.observe(withTasks, cap);
    return withTasks;
  }

  /**
   * Run the Agent Framework workflow alongside the round, for the graph.
   *
   * Deliberately *alongside* rather than instead of: the Coordinator owns the
   * findings, the citation discipline and the per-question retry, and none of
   * that is worth trading for a picture. What the sidecar contributes is the
   * framework's own event stream — the thing a hand-rolled fan-out cannot
   * produce — so the user can watch the reasoning take shape while it happens
   * instead of reading a report afterwards.
   *
   * Every failure here is silent by design. A machine with no Python, a venv
   * that will not import, a Copilot sign-in that has lapsed: each of those
   * costs the graph and nothing else. Letting any of them fail a run that is
   * already gathering would make the visualisation a liability.
   */
  private async observe(run: ResearchRun, maxParallel: number): Promise<void> {
    const sidecar = this.deps.sidecar;
    if (!sidecar) return;
    const ready = await sidecar.status();
    if (!ready.ready) {
      this.deps.logger.debug("research graph unavailable", { reason: ready.message });
      return;
    }

    // The model is *not* configured here and there is no setting for it: the
    // user already chose one in Connections as the default for the `research`
    // role, and a second place to configure a model is a second place for it to
    // be wrong. A role pointing at a non-Copilot model yields "", which lets the
    // CLI pick rather than handing it a name it cannot use.
    const chosen = await this.deps.resolveModel("research", run.projectId).catch(() => null);
    const model = researchModelFor(chosen?.id ?? null);

    // The handle `cancel()` needs. The sidecar already accepts a signal and
    // kills its child on abort; nothing was passing one, so Cancel stopped the
    // Coordinator and left a Python workflow calling models for another ten
    // minutes. Registered before the run so a cancel racing the start still
    // finds something to abort.
    const controller = new AbortController();
    this.observing.get(run.id)?.abort();
    this.observing.set(run.id, controller);

    /**
     * Which nodes the workflow has told us are in flight.
     *
     * Kept because the graph is a stream of deltas with no terminal frame of
     * its own: when the sidecar stops for any reason short of finishing, every
     * node it had marked `running` stays `running` in the UI forever. A picture
     * that shows three steps working an hour after the process died is worse
     * than no picture, because it is the most trusted thing on the surface.
     */
    const inFlight = new Set<string>();
    const watch = (event: SidecarEvent): void => {
      if (event.type === "node" || event.type === "node_status") {
        if (event.status === "running") inFlight.add(event.id);
        else inFlight.delete(event.id);
      }
      this.publish(run.id, event);
    };

    /** Say the run stopped, rather than leaving it looking busy. */
    const settle = (why: string): void => {
      for (const id of inFlight) {
        this.publish(run.id, { type: "node_status", id, status: "failed", detail: why });
      }
      inFlight.clear();
    };

    try {
      const outcome = await sidecar.run(
        {
          topic: run.topic,
          questions: run.questions.map((question) => question.question),
          maxRounds: run.maxRounds,
          maxParallel,
          ...(model ? { model } : {}),
          // `copilotCli` is left unset on purpose: the sidecar defaults to the
          // binary this app already drives, which is what makes one sign-in
          // cover both processes.
        },
        watch,
        controller.signal,
      );
      if (outcome.problem) {
        this.deps.logger.warn("research graph stopped early", {
          runId: run.id,
          problem: outcome.problem,
        });
        settle(outcome.problem);
        return;
      }
      settle("the workflow ended without reporting this step");
      // Persisted so reopening a finished run still shows how it was reached.
      await this.mutate(run.id, (current) => ({ ...current, graph: outcome.graph })).catch(
        () => undefined,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn("research graph failed", { runId: run.id, error: detail });
      settle(detail);
    } finally {
      // Only if it is still ours: a later round registers its own controller,
      // and clearing that one would leave the new observation uncancellable.
      if (this.observing.get(run.id) === controller) this.observing.delete(run.id);
    }
  }

  /** Translate one sidecar frame into a graph delta the UI can fold in. */
  private publish(runId: string, event: SidecarEvent): void {
    const emit = this.deps.onGraph;
    if (!emit) return;
    if (event.type === "node") {
      emit({
        runId,
        node: {
          id: event.id,
          kind: event.kind,
          label: event.label,
          status: event.status,
          detail: event.detail,
          round: event.round,
        },
        edge: null,
      });
      return;
    }
    if (event.type === "edge") {
      emit({ runId, node: null, edge: { from: event.from, to: event.to } });
      return;
    }
    if (event.type === "node_status") {
      // A status frame carries no kind or label, so it is sent as a partial the
      // renderer merges onto the node it already has. Inventing a kind here
      // would redraw the node as the wrong shape mid-run.
      emit({
        runId,
        node: { id: event.id, status: event.status, detail: event.detail },
        edge: null,
      });
    }
  }

  /**
   * Delegate one round's questions and record the plan they run under.
   *
   * Extracted from {@link approvePlan} because a follow-up round is the same
   * operation with a different question set — and because the *only* reliable
   * link from a question back to its task is input order, which has to be
   * established in one place or it will drift.
   */
  private async gatherRound(
    run: ResearchRun,
    questions: readonly ResearchQuestion[],
    maxParallel: number,
  ): Promise<ResearchRun> {
    const families = this.deps.gatheringToolFamilies ?? [...DEFAULT_GATHERING_FAMILIES];
    const doc = await this.deps.coordinator.createPlan({
      parentSessionId: run.sessionId ?? `research:${run.id}`,
      objective:
        run.round > 1
          ? `Research (round ${run.round}): ${run.topic}`
          : `Research: ${run.topic}`,
      maxParallel,
      tasks: questions.map((question) => ({
        key: question.id,
        title: question.question.slice(0, 120),
        instruction: this.gatheringInstruction(run.topic, question.question),
        toolFamilies: families,
        maxAttempts: 2,
      })),
    });

    // createPlan preserves input order, so task i answers question i. That is
    // the only reliable link back — the plan's task ids are generated inside it.
    const byQuestionId = new Map(questions.map((question, index) => [question.id, doc.tasks[index]?.id ?? ""]));
    return this.mutate(run.id, (current) => ({
      ...current,
      planId: doc.plan.id,
      questions: current.questions.map((question) => {
        const taskId = byQuestionId.get(question.id);
        return taskId ? { ...question, taskId } : question;
      }),
    }));
  }

  /**
   * Re-run exactly one question without disturbing the rest of the report.
   *
   * This is the Coordinator's per-node retry surfaced verbatim: the failed (or
   * merely unverified) task is reset, the plan reopens, and the poll loop picks
   * the change up. Nothing else in the run is touched.
   */
  /**
   * Read the round's findings back and decide whether to go again.
   *
   * This is the phase the pipeline did not have. Gathering answered the
   * questions it was given; nothing then asked *whether those were the right
   * questions*, or whether the evidence that came back actually supports a
   * report. `coverageGaps` knew — it just wrote the gaps into the report as a
   * disclaimer instead of doing anything about them.
   *
   * Three properties make this safe to run without a click:
   *
   *  - **The manager can only do two things**: mark a question thin, and
   *    propose follow-up questions. It cannot edit findings, citations or
   *    conflicts, so citation discipline stays in code where it was.
   *  - **The budget is not its to spend.** It decides *whether* to go again;
   *    `maxRounds` and {@link MAX_TOTAL_QUESTIONS} decide how far that can go,
   *    and they are enforced here rather than asked for in the prompt.
   *  - **Failure degrades, it does not destroy.** A manager turn that errors or
   *    will not parse leaves the run in `gathering` with every finding intact,
   *    so the report can still be written. The alternative — failing a run that
   *    has already done its work — would make reflection a liability.
   */
  private async reflect(runId: string): Promise<void> {
    const start = await this.mutate(runId, (run) => {
      if (run.status !== "gathering") throw new Error(`run ${runId} is not gathering`);
      return { ...run, status: "reflecting" };
    }).catch(() => null);
    if (!start) return;

    const stop = this.budgetStop(start);
    if (stop) {
      await this.closeRound(start, { assessment: "", weak: [], followUps: [] }, stop);
      return;
    }

    let verdict: z.infer<typeof ManagerVerdict> | null = null;
    try {
      const model = await this.deps.resolveModel("research", start.projectId);
      if (!model) throw new Error("no model is configured for the research role");
      const result = await this.deps.runAgent({
        prompt: this.managerPrompt(start),
        label: { kind: "research", detail: `Review round ${start.round} · ${start.topic}` },
        modelId: model.id,
        toolFamilies: [],
      });
      verdict = this.parseVerdict(result.text);
    } catch (error) {
      this.deps.logger.warn("research reflection failed", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!verdict) {
      // Not a failure of the run: everything gathered is still there, and the
      // user can write the report or re-run a question by hand.
      await this.closeRound(
        start,
        { assessment: "", weak: [], followUps: [] },
        "the round could not be reviewed; the findings are unchanged",
      );
      return;
    }

    // The manager names ids; only ids that exist count. A hallucinated id is
    // dropped rather than treated as a gap in a question nobody asked.
    const known = new Set(start.questions.map((question) => question.id));
    const weak = verdict.weak.filter((id) => known.has(id));
    const room = Math.max(0, MAX_TOTAL_QUESTIONS - start.questions.length);
    const followUps = verdict.followUps.slice(0, Math.min(MAX_FOLLOW_UPS, room));

    if (verdict.done || followUps.length === 0) {
      await this.closeRound(
        start,
        { assessment: verdict.assessment, weak, followUps: [] },
        verdict.done ? "the evidence was judged sufficient" : "no follow-up question was raised",
      );
      return;
    }

    const round = start.round + 1;
    const added = followUps.map((text, index) =>
      this.freshQuestion(text, undefined, {
        round,
        // Lineage: pair a follow-up with the weak question it was raised to
        // close when there is one to pair it with.
        parentId: weak[index] ?? weak[0] ?? "",
      }),
    );

    const next = await this.mutate(runId, (run) => ({
      ...run,
      status: "gathering",
      round,
      questions: [...run.questions, ...added],
      ledger: [
        ...run.ledger,
        {
          round: run.round,
          assessment: verdict!.assessment,
          weak,
          followUps: added.map((question) => question.question),
          stopped: "",
          at: this.nowIso(),
        },
      ],
    }));

    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "research.round_reflected",
      family: "research",
      outcome: "allowed",
      correlationId: next.correlationId,
      resources: [runId],
      reason: `round ${start.round}: ${weak.length} thin, ${added.length} follow-ups raised`,
    });

    await this.gatherRound(next, added, next.maxParallel);
    void this.drive(runId);
  }

  /** Why the loop must stop, or "" when it may go again. */
  private budgetStop(run: ResearchRun): string {
    if (run.round >= run.maxRounds) {
      return `the round budget of ${run.maxRounds} was reached`;
    }
    if (run.questions.length >= MAX_TOTAL_QUESTIONS) {
      return `the plan reached its ${MAX_TOTAL_QUESTIONS}-question ceiling`;
    }
    // Nothing to close: a round where every question is cited and none failed
    // has no gap for a follow-up to aim at.
    if (run.questions.every((question) => question.status === "answered")) {
      return "every question was answered with a citation";
    }
    return "";
  }

  /** Record the round and settle back to `gathering`, ready to write. */
  private async closeRound(
    run: ResearchRun,
    note: { assessment: string; weak: string[]; followUps: string[] },
    stopped: string,
  ): Promise<void> {
    let owed = false;
    const settled = await this.mutate(run.id, (current) => {
      owed = current.pendingRewrite;
      return {
        ...current,
        status: "gathering",
        pendingRewrite: false,
        ledger: [
          ...current.ledger,
          {
            round: current.round,
            assessment: note.assessment,
            weak: note.weak,
            followUps: note.followUps,
            stopped,
            at: this.nowIso(),
          },
        ],
      };
    }).catch(() => null);

    // A round the reader opened by commenting on the report ends in a new
    // report. Leaving them to find the write button would mean their note
    // visibly changed the plan, gathered new evidence, and then appeared to do
    // nothing — which is the failure this whole path exists to remove.
    if (settled && owed) void this.write(run.id).catch(() => undefined);
  }

  /**
   * Turn a reader's note on a finished report into another round.
   *
   * This is what stops Research being a single-shot pipeline. The run reaches
   * `complete` with a report, a plan and its evidence all intact; a reader who
   * says "the cost figures have no primary source" previously had nowhere to
   * put that sentence, and the run had no transition out of `complete` at all.
   *
   * Three properties keep it honest, and they are the same three that govern
   * autonomous reflection:
   *
   *  - **The note buys questions, not content.** The refine turn may only
   *    return questions; findings, citations and conflicts still come from
   *    gathering sub-agents and are still validated in code. A reader cannot
   *    talk a claim into a report by asserting it.
   *  - **The ceiling is not the reader's to raise.** `MAX_TOTAL_QUESTIONS`
   *    bounds the plan however many notes are left, and the room remaining is
   *    what the turn is allowed to ask for.
   *  - **A note that changes nothing still gets an answer.** If no question is
   *    worth asking, the run returns to `complete` with the refusal recorded
   *    against the note rather than silently doing nothing.
   *
   * The existing report stays on screen throughout. Blanking it while the new
   * evidence is gathered would take away the thing the reader is commenting on.
   */
  async refine(input: ResearchRefineInput): Promise<ResearchRun> {
    const parsed = ResearchRefineInput.parse(input);
    const note = parsed.note.trim();

    const start = await this.mutate(parsed.runId, (run) => {
      enforce(canRefineRun(run, MAX_TOTAL_QUESTIONS));
      return { ...run, status: "refining", error: "" };
    });

    const feedbackId = newTaskId();
    const round = start.round + 1;
    const room = Math.max(0, MAX_TOTAL_QUESTIONS - start.questions.length);

    let plan: z.infer<typeof RefinePlan> | null = null;
    let failure = "";
    try {
      const model = await this.deps.resolveModel("research", start.projectId);
      if (!model) throw new Error("no model is configured for the research role");
      const result = await this.deps.runAgent({
        prompt: this.refinePrompt(start, note, room),
        label: { kind: "research", detail: `Revise report · ${start.topic}` },
        modelId: model.id,
        toolFamilies: [],
      });
      plan = this.parseRefinePlan(result.text);
      if (!plan) failure = "the note could not be turned into questions; nothing was changed";
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn("research refinement failed", { runId: parsed.runId, error: failure });
    }

    const questions = (plan?.questions ?? []).slice(0, Math.min(MAX_FOLLOW_UPS, room));

    // Nothing to gather. Either the note asks for the report to be written
    // again from the evidence already in hand, or it asks for nothing at all —
    // and the two get different answers.
    if (questions.length === 0) {
      const rewrite = failure === "" && (plan?.rewrite ?? false);
      const declined = failure || plan?.declined || "this note needs no new evidence";
      const unchanged = await this.mutate(parsed.runId, (run) => ({
        ...run,
        status: "complete",
        feedback: [
          ...run.feedback,
          {
            id: feedbackId,
            note,
            round: run.round,
            questions: [],
            declined: rewrite ? "" : declined,
            at: this.nowIso(),
          },
        ],
      }));
      await this.deps.audit.record({
        actor: { kind: "system" },
        action: "research.report_revised",
        family: "research",
        outcome: "allowed",
        correlationId: unchanged.correlationId,
        resources: [parsed.runId],
        reason: rewrite
          ? "reader note raised no question; the report is being written again from the same evidence"
          : `reader note raised no question: ${declined}`,
      });
      // The note is already persisted, and the writer reads the notes, so the
      // rewrite answers it. Awaited rather than fired and forgotten so the
      // caller gets the new report rather than the old one.
      return rewrite ? this.write(parsed.runId) : unchanged;
    }

    const added = questions.map((text) =>
      // No `parentId`: the parent of these is the note, not another question.
      // Claiming a question as the source of one the reader asked for would put
      // a false lineage into the plan.
      this.freshQuestion(text, undefined, { round }),
    );

    const next = await this.mutate(parsed.runId, (run) => ({
      ...run,
      status: "gathering",
      round,
      // The round it opens must be allowed to run. `maxRounds` bounds what the
      // manager may spend on its own; it is not a budget the reader's own
      // request should be refused against.
      maxRounds: Math.max(run.maxRounds, round),
      pendingRewrite: true,
      questions: [...run.questions, ...added],
      feedback: [
        ...run.feedback,
        {
          id: feedbackId,
          note,
          round,
          questions: added.map((question) => question.question),
          declined: "",
          at: this.nowIso(),
        },
      ],
    }));

    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "research.report_revised",
      family: "research",
      outcome: "allowed",
      correlationId: next.correlationId,
      resources: [parsed.runId],
      reason: `reader note opened round ${round} with ${added.length} question${added.length === 1 ? "" : "s"}`,
    });

    const gathering = await this.gatherRound(next, added, next.maxParallel);
    void this.drive(parsed.runId);
    return gathering;
  }

  /**
   * Re-run exactly one question without disturbing the rest of the report.
   *
   * This is the Coordinator's per-node retry surfaced verbatim: the failed (or
   * merely unverified) task is reset, the plan reopens, and the poll loop picks
   * the change up. Nothing else in the run is touched.
   */
  async rerunQuestion(runId: string, questionId: string): Promise<ResearchRun> {
    const run = await this.requireRun(runId);
    enforce(canRerunQuestion(run, questionId));
    const question = run.questions.find((q) => q.id === questionId)!;

    await this.deps.coordinator.retryTask(run.planId, question.taskId);
    const reset = await this.mutate(runId, (current) => ({
      ...current,
      status: "gathering",
      questions: current.questions.map((q) =>
        q.id === questionId
          ? {
              ...q,
              status: "pending",
              statusLine: "queued for re-run",
              error: "",
              startedAt: null,
              finishedAt: null,
            }
          : q,
      ),
    }));

    void this.drive(runId);
    return reset;
  }

  /**
   * Synthesise the report with the single writer agent.
   *
   * The writer produces only the narrative; the source table and the coverage
   * summary are assembled here from the questions' own citations and statuses.
   * That keeps citation discipline in code: the list of what could not be
   * answered is derived from the data, so the report cannot claim completeness
   * the gathering phase did not achieve.
   */
  async write(runId: string): Promise<ResearchRun> {    const start = await this.mutate(runId, (run) => {
      enforce(canWriteReport(run));
      return { ...run, status: "writing", error: "" };
    });

    try {
      const model = await this.deps.resolveModel("research", start.projectId);
      if (!model) throw new Error("no model is configured for the research writer role");

      const result = await this.deps.runAgent({
        prompt: this.writerPrompt(start),
        label: { kind: "research", detail: `Report · ${start.topic}` },
        modelId: model.id,
        toolFamilies: [],
      });
      const narrative = result.text.trim();
      if (!narrative) throw new Error("the writer returned an empty report");

      const coverage = this.coverageGaps(start);
      const markdown = this.assembleReport(start, narrative, coverage);
      const generatedAt = this.nowIso();

      let path = "";
      const projectDir = this.deps.projectDir();
      if (projectDir) {
        path = await this.writeIntoProject(projectDir, start, markdown);
      }

      const report: ResearchReport = { markdown, path, generatedAt, coverage };
      const done = await this.mutate(runId, (run) => ({
        ...run,
        status: "complete",
        writerModelId: model.id,
        report,
      }));

      await this.deps.audit.record({
        actor: { kind: "system" },
        action: "research.report_written",
        family: "research",
        outcome: "succeeded",
        correlationId: done.correlationId,
        resources: path ? [runId, path] : [runId],
        reason: `${markdown.length} characters; ${coverage.length} coverage gaps noted`,
      });
      return done;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.audit.record({
        actor: { kind: "system" },
        action: "research.report_written",
        family: "research",
        outcome: "failed",
        correlationId: start.correlationId,
        resources: [runId],
        reason: message,
      });
      // Back to `gathering`, not `failed`: the findings are intact and the
      // report can be asked for again.
      return this.mutate(runId, (run) => ({ ...run, status: "gathering", error: message }));
    }
  }

  async cancel(runId: string): Promise<ResearchRun> {
    const run = await this.requireRun(runId);
    if (run.planId && isRunActive(run)) {
      await this.deps.coordinator
        .cancelPlan(run.planId, "research run cancelled")
        .catch(() => undefined);
    }
    // The graph workflow is a separate child process spending its own budget;
    // cancelling the plan says nothing to it.
    this.observing.get(runId)?.abort();
    this.observing.delete(runId);
    this.driving.delete(runId);
    return this.mutate(runId, (current) => ({
      ...current,
      status: "cancelled",
      questions: current.questions.map((q) =>
        q.status === "pending" || q.status === "running"
          ? { ...q, status: "cancelled", statusLine: "run cancelled" }
          : q,
      ),
    }));
  }

  /**
   * Remove one durable Research record.
   *
   * An active delegated plan is cancelled before the run directory goes away:
   * otherwise the polling loop can complete after deletion and write the run
   * straight back. The Coordinator keeps its plan as an audit record, and a
   * report already written to the user's project stays there. Removing
   * Research history is not consent to remove a user-facing document.
   */
  async delete(runId: string): Promise<void> {
    const run = await this.read(runId);
    if (run === null) return;

    if (run.planId && isRunActive(run)) {
      await this.deps.coordinator.cancelPlan(run.planId, "research run deleted").catch(() => undefined);
    }
    this.observing.get(runId)?.abort();
    this.observing.delete(runId);
    this.driving.delete(runId);

    // Share the lock used by persistence. A writer that wakes after this has
    // to read the run again and fails cleanly; it cannot recreate a directory
    // removed from underneath it.
    await this.locks.withLock(runId, async () => {
      await rm(this.dir(runId), { recursive: true, force: true });
    });

    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "research.run_deleted",
      family: "research",
      outcome: "succeeded",
      correlationId: run.correlationId,
      resources: run.report.path ? [runId, run.report.path] : [runId],
      reason: `deleted "${run.topic}" (${run.status}, ${run.questions.length} questions); project report retained`,
    });
  }

  /**
   * Re-attach runs that a crash left mid-flight.
   *
   * A gathering run re-attaches to its delegated plan and resumes polling; the
   * plan store is where the real progress lives, so nothing is lost. A run that
   * was mid-decomposition (`planning`) or mid-write cannot be re-attached to any
   * durable executor, so it is stated as failed (or reset) rather than left
   * running.
   */
  async resume(): Promise<number> {
    let reattached = 0;
    for (const run of await this.list(200)) {
      if (run.status === "gathering" && run.planId) {
        reattached += 1;
        this.deps.coordinator.track(run.planId);
        void this.drive(run.id);
      } else if (run.status === "writing") {
        await this.persist({
          ...run,
          status: "gathering",
          error: "the report write was interrupted; run it again",
        }).catch(() => undefined);
      } else if (run.status === "reflecting") {
        // Reflection is one agent turn with nothing durable behind it, so an
        // interrupted review is simply not a review. The round's findings are
        // untouched; the run settles where it was before the manager ran.
        await this.persist({
          ...run,
          status: "gathering",
          error: "the round review was interrupted; the findings are unchanged",
        }).catch(() => undefined);
      } else if (run.status === "refining") {
        // Same shape, different landing: refinement is one agent turn on a run
        // that was already `complete`, so an interrupted one leaves a finished
        // report and no new questions. It settles back to `complete` with the
        // note still unanswered, which the reader can send again.
        await this.persist({
          ...run,
          status: "complete",
          pendingRewrite: false,
          error: "the revision was interrupted; the report is unchanged",
        }).catch(() => undefined);
      } else if (run.status === "gathering") {
        await this.persist({
          ...run,
          status: "failed",
          error: "gathering was interrupted before a delegated plan existed",
        }).catch(() => undefined);
      } else if (run.status === "planning") {
        await this.persist({
          ...run,
          status: "failed",
          error: "topic decomposition was interrupted before a plan was ready",
        }).catch(() => undefined);
      }
    }
    return reattached;
  }

  // --- gathering poll loop -------------------------------------------------

  /**
   * Follow the delegated plan to completion, mirroring each task's state onto
   * its question. Runs as a background loop the same way the scheduler and
   * coordinator timers do; a single guard prevents two loops for one run.
   */
  private async drive(runId: string): Promise<void> {
    if (this.driving.has(runId)) return;
    this.driving.add(runId);
    try {
      for (;;) {
        const run = await this.read(runId);
        if (!run || run.status !== "gathering" || !run.planId) return;

        const doc = await this.deps.coordinator.getPlan(run.planId);
        if (!doc) {
          await this.mutate(runId, (current) => ({
            ...current,
            status: "failed",
            error: "the delegated gathering plan could not be found",
          }));
          return;
        }

        await this.syncFromPlan(runId, doc);

        if (doc.plan.status !== "running") {
          // The round has settled. Reflection decides whether that is the end
          // of the run or the start of the next round; it re-enters `drive`
          // itself when it raises follow-ups, so this loop simply stops.
          void this.reflect(runId);
          return;
        }
        await sleep(200);
      }
    } catch (error) {
      this.deps.logger.error("research gathering loop failed", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.driving.delete(runId);
    }
  }

  /** Project the plan's task states onto the run's questions, once. */
  private async syncFromPlan(runId: string, doc: PlanDocument): Promise<void> {
    const byTaskId = new Map(doc.tasks.map((task) => [task.id, task]));
    const finishedNow: ResearchQuestion[] = [];

    const updated = await this.mutate(runId, (run) => ({
      ...run,
      questions: run.questions.map((question) => {
        const task = byTaskId.get(question.taskId);
        if (!task) return question;

        switch (task.status) {
          case "running":
          case "dispatched":
            if (question.status === "running") return question;
            return {
              ...question,
              status: "running",
              statusLine: "gathering",
              startedAt: question.startedAt ?? this.nowIso(),
            };
          case "succeeded": {
            if (question.status === "answered" || question.status === "unverified") return question;
            const answered = this.applyQuestionPayload(question, task.result ?? "");
            finishedNow.push(answered);
            return answered;
          }
          case "failed":
            if (question.status === "failed") return question;
            return {
              ...question,
              status: "failed",
              statusLine: "gathering failed",
              error: task.error ?? "the gathering sub-agent failed",
              finishedAt: this.nowIso(),
            };
          case "cancelled":
            if (question.status === "cancelled") return question;
            return {
              ...question,
              status: "cancelled",
              statusLine: "cancelled",
              finishedAt: this.nowIso(),
            };
          default:
            return question;
        }
      }),
    }));

    for (const question of finishedNow) {
      await this.deps.audit.record({
        actor: { kind: "system" },
        action: "research.question_gathered",
        family: "research",
        outcome: question.status === "unverified" ? "allowed" : "succeeded",
        correlationId: updated.correlationId,
        // Host-only: a URL carrying a token in its path must never be logged.
        resources: [runId, ...question.sources],
        reason: `${question.status}: ${question.citations.length} citations, ${question.conflicts.length} conflicts`,
      });
    }
  }

  /**
   * Turn a sub-agent's raw answer into a validated question state.
   *
   * The two load-bearing rules live here: an answer that will not parse is
   * `failed`, and a finding with no citation is `unverified` — never `answered`.
   */
  private applyQuestionPayload(question: ResearchQuestion, raw: string): ResearchQuestion {
    const payload = this.parseAnswer(raw);
    const finishedAt = this.nowIso();
    if (!payload) {
      return {
        ...question,
        status: "failed",
        statusLine: "unparsable answer",
        error: "the sub-agent's structured answer could not be parsed",
        finishedAt,
      };
    }

    const retrievedAt = finishedAt;
    const citations: ResearchCitation[] = payload.citations.map((citation) =>
      ResearchCitation.parse({
        kind: citation.kind as CitationKind,
        ref: citation.ref,
        title: citation.title,
        retrievedAt,
      }),
    );
    const conflicts: ResearchConflict[] = payload.conflicts.map((conflict) =>
      ResearchConflict.parse({
        claim: conflict.claim,
        positions: conflict.positions.map((position) => ({
          statement: position.statement,
          citation: ResearchCitation.parse({
            kind: position.citation.kind as CitationKind,
            ref: position.citation.ref,
            title: position.citation.title,
            retrievedAt,
          }),
        })),
      }),
    );

    // Sources are derived host-only rather than trusting the payload's list, so
    // nothing token-bearing can leak into the source table or the audit log.
    const sources = uniqueHosts([
      ...citations.map((c) => c.ref),
      ...conflicts.flatMap((conflict) => conflict.positions.map((p) => p.citation.ref)),
    ]);

    const verified = citations.length > 0;
    return {
      ...question,
      status: verified ? "answered" : "unverified",
      statusLine: verified
        ? `answered with ${citations.length} citations`
        : "no citation found; recorded as unverified",
      findings: payload.findings,
      citations,
      conflicts,
      sources,
      error: "",
      finishedAt,
    };
  }

  private parseAnswer(raw: string): z.infer<typeof GatheredAnswer> | null {
    const json = extractJsonObject(raw);
    if (json === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      return null;
    }
    const parsed = GatheredAnswer.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  // --- agent prompts -------------------------------------------------------

  private async decompose(topic: string, projectId: string | null): Promise<string[]> {
    const model = await this.deps.resolveModel("research", projectId);
    if (!model) throw new Error("no model is configured for the research writer role");

    const result = await this.deps.runAgent({
      prompt:
        `Decompose the research topic below into 3 to 8 focused, independent questions.\n` +
        `Return ONLY a JSON array of question strings, e.g. ["...","..."]. No prose.\n\n` +
        `TOPIC: ${topic}`,
      label: { kind: "research", detail: `Decompose · ${topic}` },
      modelId: model.id,
      toolFamilies: [],
    });

    const json = extractJsonArray(result.text);
    if (json === null) throw new Error("the topic decomposition could not be parsed");
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      throw new Error("the topic decomposition could not be parsed");
    }
    const parsed = z.array(z.string().min(1).max(500)).min(1).safeParse(value);
    if (!parsed.success) throw new Error("the topic decomposition did not contain any questions");
    return parsed.data.slice(0, 8);
  }

  /**
   * Ask the manager to read the round back.
   *
   * The ledger it is shown is the run's own data — question ids, statuses,
   * citation counts and conflicts — not prose it could be talked out of. It is
   * asked for ids because ids are checkable: a verdict naming a question that
   * does not exist is dropped rather than acted on.
   */
  private managerPrompt(run: ResearchRun): string {
    const ledger = run.questions
      .map((question) => {
        const conflicts = question.conflicts.length;
        return (
          `- id: ${question.id}\n` +
          `  question: ${question.question}\n` +
          `  status: ${question.status}${question.error ? ` (${question.error})` : ""}\n` +
          `  citations: ${question.citations.length}${conflicts ? `, conflicts: ${conflicts}` : ""}\n` +
          `  findings: ${question.findings ? question.findings.slice(0, 600) : "(none)"}`
        );
      })
      .join("\n")
      .slice(0, MAX_WRITER_CONTEXT);

    const spent = run.round;
    const left = Math.max(0, run.maxRounds - spent);
    return (
      `You are reviewing round ${spent} of a research run on: "${run.topic}".\n` +
      `Rounds remaining after this one: ${left}. Questions so far: ${run.questions.length} ` +
      `of a maximum ${MAX_TOTAL_QUESTIONS}.\n\n` +
      `A question is THIN when it is unverified (no citation), failed, or its ` +
      `findings do not actually answer it. Sources that disagree are recorded as ` +
      `conflicts and are NOT a reason to go again — a conflict is a finding.\n\n` +
      `Judge only what is below. Do not add facts. Do not restate findings.\n\n` +
      `LEDGER\n${ledger}\n\n` +
      `Return ONLY a JSON object of this exact shape:\n` +
      `{\n` +
      `  "assessment": "one short paragraph on where the evidence stands",\n` +
      `  "weak": ["question ids that are thin"],\n` +
      `  "followUps": ["at most ${MAX_FOLLOW_UPS} new questions that would close those gaps"],\n` +
      `  "done": true when another round would add nothing\n` +
      `}`
    );
  }

  private parseVerdict(raw: string): z.infer<typeof ManagerVerdict> | null {
    const json = extractJsonObject(raw);
    if (json === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      return null;
    }
    const parsed = ManagerVerdict.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Ask what the reader's note needs looked up.
   *
   * The report is included because the note is about the report — "this
   * section is thin" is unreadable without it — but the plan and its statuses
   * are included too, so the turn can tell a gap in the evidence from a gap in
   * the writing. A note about phrasing should raise no question at all, and
   * `declined` is how it says so.
   */
  private refinePrompt(run: ResearchRun, note: string, room: number): string {
    const plan = run.questions
      .map(
        (question) =>
          `- ${question.question}\n  status: ${question.status}, citations: ${question.citations.length}`,
      )
      .join("\n");
    const report = run.report.markdown.slice(0, MAX_WRITER_CONTEXT);

    return (
      `A reader has commented on a finished research report on: "${run.topic}".\n\n` +
      `Decide what NEW evidence has to be gathered to address the comment, and ` +
      `express it as research questions.\n\n` +
      `Rules:\n` +
      `- At most ${Math.min(MAX_FOLLOW_UPS, room)} questions. Raise fewer if fewer will do.\n` +
      `- A question must be answerable from sources, and must not repeat a ` +
      `question already in the plan below.\n` +
      `- If the comment is about wording, structure or emphasis rather than ` +
      `evidence, raise NO question and say so in "declined" — the report can be ` +
      `rewritten from what is already gathered.\n` +
      `- Do not answer the comment yourself. Do not state facts.\n\n` +
      `EXISTING PLAN\n${plan}\n\n` +
      `THE REPORT\n${report}\n\n` +
      `THE READER'S COMMENT\n${note}\n\n` +
      `Return ONLY a JSON object of this exact shape:\n` +
      `{\n` +
      `  "questions": ["new research questions, or an empty list"],\n` +
      `  "rewrite": true when no question is needed but the report should be ` +
      `written again from the evidence it already has,\n` +
      `  "declined": "why nothing needs to change, when nothing does"\n` +
      `}`
    );
  }

  private parseRefinePlan(raw: string): z.infer<typeof RefinePlan> | null {
    const json = extractJsonObject(raw);
    if (json === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      return null;
    }
    const parsed = RefinePlan.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  private gatheringInstruction(topic: string, question: string): string {
    return (
      `You are a research sub-agent for the topic: "${topic}".\n` +
      `Investigate exactly this question and nothing else: "${question}".\n\n` +
      `Every claim MUST carry a citation. If you cannot source a claim, leave it ` +
      `out and return no citations rather than stating it.\n` +
      `If sources disagree, record the disagreement as a conflict rather than ` +
      `picking a winner.\n\n` +
      `Return ONLY a JSON object of this exact shape and nothing else:\n` +
      `{\n` +
      `  "findings": "a short prose summary of what was established",\n` +
      `  "citations": [{ "kind": "url|api|m365|artifact", "ref": "the source", "title": "" }],\n` +
      `  "conflicts": [{ "claim": "...", "positions": [{ "statement": "...", "citation": { "kind": "url", "ref": "...", "title": "" } }] }],\n` +
      `  "sources": ["host-only labels"]\n` +
      `}`
    );
  }

  private writerPrompt(run: ResearchRun): string {
    const sections = run.questions.map((question) => {
      const cites = question.citations
        .map((c, index) => `    [${index + 1}] (${c.kind}) ${c.ref}`)
        .join("\n");
      const conflicts = question.conflicts
        .map((conflict) => `    CONFLICT: ${conflict.claim}`)
        .join("\n");
      return (
        `### ${question.question}\n` +
        `Status: ${question.status}\n` +
        `Findings: ${question.findings || "(none)"}\n` +
        (cites ? `Citations:\n${cites}\n` : "") +
        (conflicts ? `${conflicts}\n` : "")
      );
    });
    const body = sections.join("\n").slice(0, MAX_WRITER_CONTEXT);

    // What the reader asked for last time, and the time before. Included
    // because a rewrite that ignores the note it was asked for is worse than
    // no rewrite: the reader watched the run work and got the same report
    // back. Notes direct emphasis and structure only — the findings below are
    // still the only material, which is what keeps a note from becoming a way
    // to put uncited content into a report.
    const notes = run.feedback
      .map((entry) => `- ${entry.note}`)
      .join("\n")
      .slice(0, 4_000);

    return (
      `Write a comprehensive, well-structured research report in Markdown for the ` +
      `topic: "${run.topic}".\n` +
      `Use ONLY the findings below. Do not invent facts or citations. Reference ` +
      `citations by their bracket numbers. Report any conflict as a conflict; do ` +
      `not resolve it. Write the report body only — a source table and a coverage ` +
      `summary are appended automatically, so do not write them yourself.\n\n` +
      (notes
        ? `The reader has asked for the following. Address it using the findings ` +
          `below and nothing else; if the evidence does not support what was ` +
          `asked, say so plainly rather than filling the gap.\n${notes}\n\n`
        : "") +
      body
    );
  }

  // --- report assembly -----------------------------------------------------

  private coverageGaps(run: ResearchRun): string[] {
    return run.questions
      .filter((q) => q.status !== "answered")
      .map((q) => {
        const why =
          q.status === "unverified"
            ? "no citation could be found"
            : q.status === "failed"
              ? q.error || "gathering failed"
              : q.status;
        return `${q.question} — ${why}`;
      });
  }

  private assembleReport(run: ResearchRun, narrative: string, coverage: string[]): string {
    const rows: string[] = [];
    let index = 0;
    for (const question of run.questions) {
      for (const citation of question.citations) {
        index += 1;
        const title = citation.title || citation.ref;
        rows.push(`| ${index} | ${citation.kind} | ${title} | ${citation.ref} |`);
      }
    }

    const sourceTable = rows.length
      ? [`| # | Kind | Title | Reference |`, `| --- | --- | --- | --- |`, ...rows].join("\n")
      : "_No sources were cited._";

    const coverageBlock = coverage.length
      ? coverage.map((gap) => `- ${gap}`).join("\n")
      : "_Every question in the plan was answered with at least one citation._";

    return (
      `# Research: ${run.topic}\n\n` +
      `${narrative}\n\n` +
      `## Sources\n\n${sourceTable}\n\n` +
      `## Coverage summary\n\n${coverageBlock}\n`
    );
  }

  /**
   * Write the report into the bound project, proving containment the same way
   * the project navigator does: a relative path is resolved against the root
   * and refused if it escapes.
   */
  private async writeIntoProject(
    projectDir: string,
    run: ResearchRun,
    markdown: string,
  ): Promise<string> {
    const relPath = `research/${slug(run.topic)}-${run.id}.md`;
    const full = resolve(projectDir, relPath);
    const rel = relative(projectDir, full);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("the report path leaves the project");
    }
    await mkdir(join(projectDir, "research"), { recursive: true });
    await writeFile(full, markdown, "utf8");
    return rel.split(sep).join("/");
  }

  private freshQuestion(
    text: string,
    id?: string,
    lineage: { round?: number; parentId?: string } = {},
  ): ResearchQuestion {
    return ResearchQuestion.parse({
      id: id ?? newTaskId(),
      question: text.trim().slice(0, 500),
      status: "pending",
      statusLine: "",
      findings: "",
      citations: [],
      conflicts: [],
      sources: [],
      error: "",
      startedAt: null,
      finishedAt: null,
      taskId: "",
      round: lineage.round ?? 1,
      parentId: lineage.parentId ?? "",
    });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Collapse a set of refs to a deduplicated, host-only list. */
function uniqueHosts(refs: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const ref of refs) hosts.add(hostOf(ref));
  return [...hosts];
}

function hostOf(ref: string): string {
  try {
    return new URL(ref).host || ref;
  } catch {
    // Non-URL refs (an API route, an m365 item id, a project path) are not
    // token-bearing in the way a URL query is, so they are kept as given.
    return ref.split(/[?#]/)[0] ?? ref;
  }
}

/** Extract the first balanced JSON object from a model's text. */
function extractJsonObject(raw: string): string | null {
  return extractBalanced(raw, "{", "}");
}

function extractJsonArray(raw: string): string | null {
  return extractBalanced(raw, "[", "]");
}

function extractBalanced(raw: string, open: string, close: string): string | null {
  const start = raw.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return null;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "report"
  );
}
