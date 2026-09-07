import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  CouncilContribution,
  CouncilDissent,
  CouncilMember,
  CouncilPreset,
  CouncilRun,
  CouncilStartInput,
  CouncilVerdict,
  estimateCouncilTokens,
  newCorrelationId,
  newTaskId,
  normalizeCouncilTitle,
  type CouncilPhase,
} from "@iq/shared";
import { z } from "zod";
import { readJson, writeJsonAtomic } from "../util/jsonl.js";
import { KeyedMutex } from "../util/lock.js";
import type { AppPaths } from "../config/paths.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { Logger } from "../util/logger.js";
import type { ResolveModel } from "../research/research-service.js";
import type { RunAgent } from "../runtime/agent-run.js";

/**
 * Chat → Team (the council).
 *
 * A council answers questions a single agent answers badly: trade-offs, design
 * choices, prioritisation, risk. Members argue in rounds and a chair — distinct
 * from the members — frames the question, orders the debate, calls it early when
 * positions stop moving, and writes a structured verdict. Four design decisions
 * shape this file.
 *
 *  1. The chair is a separate agent, not the first member. Its job is procedural
 *     — frame, order, converge, decide — so folding it into a member would let
 *     one stance also run the debate, which is exactly the bias the council is
 *     meant to counter.
 *
 *  2. Human controls act at a round boundary, never mid-turn. `inject`,
 *     `forceVerdict` and `cancel` set intent that the loop consumes between
 *     rounds. Interrupting a member mid-argument would leave a half-written
 *     contribution that no later round could sensibly rebut.
 *
 *  3. A member's tool grant is a subset of the session's, computed at run start.
 *     A council multiplies reach as well as spend, so a member is never allowed
 *     to hold a family the user's own session does not, and the narrowing is
 *     enforced here rather than trusted to the roster the UI submitted.
 *
 *  4. The verdict is a validated artifact, not prose. It is parsed against the
 *     zod contract — recommendation, criteria, strongest-for/against, attributed
 *     dissent, confidence, open questions — so a downstream reader gets a
 *     structure it can render and cite, not a paragraph it must re-parse.
 */

export interface CouncilDeps {
  logger: Logger;
  audit: AuditLog;
  paths: AppPaths;
  runAgent: RunAgent;
  resolveModel: ResolveModel;
  /** The bound project's absolute directory, or null when Chat-scoped. */
  projectDir: () => string | null;
  correlationId: () => string;
  /**
   * The tool families the originating session itself holds. A member's grant is
   * intersected with this at run start, so a member can never out-reach the user.
   */
  sessionGrant: (sessionId: string | null) => string[] | Promise<string[]>;
  now?: () => Date;
}

export type CouncilListener = (run: CouncilRun) => void;

/** Per-turn token figure, kept equal to the shared estimator so the live number
 * and the up-front estimate are the same unit. */
const PER_TURN_TOKENS = 1_200;

const CHAIR_ID = "chair";

/** The verdict shape the chair must return; lenient so a missing optional field
 * does not cost an otherwise complete decision. */
const VerdictPayload = z.object({
  recommendation: z.string().min(1),
  criteria: z.array(z.string()).default([]),
  strongestFor: z.string().default(""),
  strongestAgainst: z.string().default(""),
  dissent: z
    .array(
      z.object({
        memberId: z.string().default(""),
        memberName: z.string().default(""),
        position: z.string().min(1),
      }),
    )
    .default([]),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
  openQuestions: z.array(z.string()).default([]),
});

/** The chair's convergence verdict between rounds. */
const ConvergencePayload = z.object({
  converged: z.boolean(),
  reason: z.string().default(""),
});

/**
 * Built-in councils. Intentionally small and opinionated: a design trade-off
 * panel and a prioritisation panel cover the two questions users reach for a
 * council to answer most often, and everything else is a saved preset.
 */
const BUILT_IN_PRESETS: CouncilPreset[] = [
  {
    id: "preset-design-tradeoff",
    name: "Design trade-off",
    description: "Weighs a design decision from four fixed angles.",
    builtIn: true,
    members: [
      { id: "advocate", name: "Advocate", stance: "Argue for the proposal and its upside.", modelId: "", skills: [], toolFamilies: [] },
      { id: "skeptic", name: "Skeptic", stance: "Attack the proposal; surface risks and failure modes.", modelId: "", skills: [], toolFamilies: [] },
      { id: "cost", name: "Cost", stance: "Judge the proposal purely on cost, effort and maintenance.", modelId: "", skills: [], toolFamilies: [] },
      { id: "security", name: "Security", stance: "Judge the proposal purely on security and privacy risk.", modelId: "", skills: [], toolFamilies: [] },
    ],
  },
  {
    id: "preset-prioritisation",
    name: "Prioritisation",
    description: "Ranks competing options against value, effort and risk.",
    builtIn: true,
    members: [
      { id: "value", name: "Value", stance: "Advocate for user and business value above all.", modelId: "", skills: [], toolFamilies: [] },
      { id: "effort", name: "Effort", stance: "Advocate for the lowest-effort, fastest-to-ship option.", modelId: "", skills: [], toolFamilies: [] },
      { id: "risk", name: "Risk", stance: "Advocate for the least risky option and flag unknowns.", modelId: "", skills: [], toolFamilies: [] },
    ],
  },
];

/** In-memory control intents, consumed at the next round boundary. */
interface Controls {
  forceVerdict: boolean;
  cancelled: boolean;
}

export class CouncilService {
  private readonly locks = new KeyedMutex();
  private readonly listeners = new Set<CouncilListener>();
  /** Runs whose debate loop is live; boundary controls only matter for these. */
  private readonly running = new Map<string, Controls>();

  constructor(private readonly deps: CouncilDeps) {}

  onChange(listener: CouncilListener): void {
    this.listeners.add(listener);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private dir(runId: string): string {
    return join(this.deps.paths.root, "council", runId);
  }

  private file(runId: string): string {
    return join(this.dir(runId), "run.json");
  }

  private get presetsFile(): string {
    return join(this.deps.paths.root, "council", "presets.json");
  }

  // --- persistence ---------------------------------------------------------

  private async read(runId: string): Promise<CouncilRun | null> {
    const raw = await readJson<unknown>(this.file(runId), null);
    if (!raw) return null;
    const parsed = CouncilRun.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  private async requireRun(runId: string): Promise<CouncilRun> {
    const run = await this.read(runId);
    if (!run) throw new Error(`unknown council run ${runId}`);
    return run;
  }

  private async persist(run: CouncilRun): Promise<CouncilRun> {
    const next = { ...run, updatedAt: this.nowIso() };
    await writeJsonAtomic(this.file(next.id), next);
    for (const listener of this.listeners) listener(next);
    return next;
  }

  /**
   * Write a finished run verbatim, for the sample data to show.
   *
   * A council is the one feature that cannot be demonstrated without spending
   * real tokens on several models at once, so the Team surface was empty for
   * anyone who had not run one — and empty is the wrong first impression of a
   * feature whose whole claim is that the argument is kept.
   *
   * Separate from {@link persist} because that stamps `updatedAt` with the
   * clock, and a seeded run has to keep the timestamps it was written with or
   * the transcript's own ordering stops matching the times beside it.
   *
   * It does not audit. The audit trail records what the council *decided*, and
   * a sample run decided nothing; {@link SamplesService} records the load.
   */
  async seed(run: CouncilRun): Promise<void> {
    const parsed = CouncilRun.parse(run);
    await mkdir(this.dir(parsed.id), { recursive: true });
    await writeJsonAtomic(this.file(parsed.id), parsed);
    for (const listener of this.listeners) listener(parsed);
  }

  private mutate(runId: string, fn: (run: CouncilRun) => CouncilRun): Promise<CouncilRun> {
    return this.locks.withLock(runId, async () => {
      const run = await this.requireRun(runId);
      return this.persist(fn(run));
    });
  }

  async get(runId: string): Promise<CouncilRun | null> {
    return this.read(runId);
  }

  async list(limit = 50): Promise<CouncilRun[]> {
    const { readdir } = await import("node:fs/promises");
    const base = join(this.deps.paths.root, "council");
    const ids = await readdir(base).catch(() => [] as string[]);
    const runs: CouncilRun[] = [];
    for (const id of ids) {
      if (id === "presets.json") continue;
      const run = await this.read(id);
      if (run) runs.push(run);
    }
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  /**
   * Rename a run.
   *
   * Only the label. `question` is what the members were given and is quoted in
   * the transcript, the verdict and the audit trail, so it stays exactly as it
   * was asked; an empty title puts the run back to being called by it.
   *
   * No sign-in required and no approval: naming something is not a decision
   * about it, and the alternative — a history that cannot be organised without
   * an identity — makes the rail unusable for the one person who can see it.
   * The audit record still names both, so a run that was renamed to something
   * unrecognisable can be traced back to what it actually argued.
   */
  async rename(runId: string, title: string): Promise<CouncilRun> {
    const normalized = normalizeCouncilTitle(title);
    const before = await this.requireRun(runId);
    if (before.title === normalized) return before;

    const run = await this.mutate(runId, (current) => ({ ...current, title: normalized }));

    await this.deps.audit.record({
      // `system`, as delete is, and for the same reason: renaming needs no
      // sign-in, so there is no Entra object id to attribute it to and a
      // `user` actor would have to invent one. The channel is only reachable
      // from the window, so "a person at this machine" is what it means.
      actor: { kind: "system" },
      action: "council.run_renamed",
      family: "council",
      outcome: "succeeded",
      correlationId: run.correlationId,
      resources: [runId],
      reason:
        normalized === ""
          ? `cleared the name of "${run.question}"`
          : `named "${run.question}" as "${normalized}"`,
    });

    return run;
  }

  /**
   * Delete a run and everything it produced.
   *
   * A live run is cancelled first rather than deleted from under its own loop:
   * the loop writes the run back at every round boundary, so removing the
   * directory while it argues would recreate it a few seconds later and the
   * delete would look like it had silently failed.
   *
   * The verdict already exported into the project is left alone. It is a file
   * in the user's own directory by then, and deleting a transcript is not
   * consent to delete a document.
   */
  async delete(runId: string): Promise<void> {
    const run = await this.read(runId);
    if (run === null) return;

    const control = this.running.get(runId);
    if (control) {
      control.cancelled = true;
      this.running.delete(runId);
    }

    await this.locks.withLock(runId, async () => {
      await rm(this.dir(runId), { recursive: true, force: true });
    });

    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "council.run_deleted",
      family: "council",
      outcome: "succeeded",
      correlationId: run.correlationId,
      resources: [runId],
      reason: `deleted "${run.question}" (${run.status}, ${run.contributions.length} contributions)`,
    });

    // Deliberately not published. `council:changed` carries a run, and sending
    // one for something that no longer exists would put the row straight back
    // in every list that folds the stream by id. Callers reload instead.
  }

  // --- presets -------------------------------------------------------------

  /** Built-in councils first, then the user's saved ones. */
  async presets(): Promise<CouncilPreset[]> {
    return [...BUILT_IN_PRESETS, ...(await this.userPresets())];
  }

  private async userPresets(): Promise<CouncilPreset[]> {
    const raw = await readJson<unknown>(this.presetsFile, []);
    if (!Array.isArray(raw)) return [];
    const out: CouncilPreset[] = [];
    for (const entry of raw) {
      const parsed = CouncilPreset.safeParse(entry);
      if (parsed.success && !parsed.data.builtIn) out.push(parsed.data);
    }
    return out;
  }

  async savePreset(input: {
    id?: string;
    name: string;
    description?: string;
    /**
     * `id` is optional, because this method already mints one for a member
     * that arrives without it — see the `?? newTaskId()` below.
     *
     * It was declared required, which contradicted the body and disagreed with
     * `council:savePreset`'s own schema (`CouncilStartInput.shape.members`,
     * where `id` is `.optional()`). Nothing caught it: the IPC handler map was
     * typed `(...args: never[]) => Promise<unknown>`, so neither end of this
     * channel was checked against the other. Typing the map on the contract is
     * what surfaced it.
     */
    members: Array<Omit<z.input<typeof CouncilMember>, "id"> & { id?: string }>;
  }): Promise<CouncilPreset> {
    const preset = CouncilPreset.parse({
      id: input.id ?? `usr-${newTaskId()}`,
      name: input.name,
      description: input.description ?? "",
      members: input.members.map((member) => ({ ...member, id: member.id ?? newTaskId() })),
      builtIn: false,
    });
    if (BUILT_IN_PRESETS.some((builtin) => builtin.id === preset.id)) {
      throw new Error("a built-in preset cannot be overwritten");
    }
    const existing = (await this.userPresets()).filter((entry) => entry.id !== preset.id);
    await writeJsonAtomic(this.presetsFile, [...existing, preset]);
    return preset;
  }

  async deletePreset(id: string): Promise<void> {
    if (BUILT_IN_PRESETS.some((builtin) => builtin.id === id)) {
      throw new Error("a built-in preset cannot be deleted");
    }
    const existing = (await this.userPresets()).filter((entry) => entry.id !== id);
    await writeJsonAtomic(this.presetsFile, existing);
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * Validate the roster and the budget, narrow every member's grant, then run
   * the debate as a background loop.
   *
   * The round budget is required up front rather than discovered mid-run because
   * a council multiplies token spend: the estimate must be visible before the
   * user commits, and the loop must have a hard ceiling it cannot exceed.
   */
  async start(input: CouncilStartInput): Promise<CouncilRun> {
    const parsed = CouncilStartInput.parse(input);
    const runId = newTaskId();
    const correlationId = this.deps.correlationId() || newCorrelationId();
    const now = this.nowIso();

    const grant = await this.deps.sessionGrant(parsed.sessionId ?? null);
    const grantSet = new Set(grant);

    const members: CouncilMember[] = [];
    for (const raw of parsed.members) {
      const resolved =
        raw.modelId && raw.modelId.length > 0
          ? { id: raw.modelId }
          : await this.deps.resolveModel("council", parsed.projectId);
      // A member can never hold a family the user's own session does not.
      const narrowed = (raw.toolFamilies ?? []).filter((family) => grantSet.has(family));
      members.push(
        CouncilMember.parse({
          id: raw.id ?? newTaskId(),
          name: raw.name,
          stance: raw.stance,
          modelId: resolved?.id ?? "",
          skills: raw.skills ?? [],
          toolFamilies: narrowed,
        }),
      );
    }

    const run = CouncilRun.parse({
      id: runId,
      question: parsed.question,
      sessionId: parsed.sessionId,
      projectId: parsed.projectId,
      members,
      roundBudget: parsed.roundBudget,
      roundsRun: 0,
      phase: "opening",
      status: "running",
      contributions: [],
      verdict: null,
      estimatedTokens: estimateCouncilTokens(members.length, parsed.roundBudget),
      injections: [],
      correlationId,
      error: "",
      createdAt: now,
      updatedAt: now,
    });
    await mkdir(this.dir(runId), { recursive: true });
    const persisted = await this.persist(run);

    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "council.run_started",
      family: "council",
      outcome: "allowed",
      correlationId,
      resources: [runId],
      reason: `${members.length} members, ${parsed.roundBudget} rounds, ~${persisted.estimatedTokens} tokens`,
    });

    this.running.set(runId, { forceVerdict: false, cancelled: false });
    void this.runDebate(runId);
    return persisted;
  }

  /**
   * Add a constraint the members must respect from the next round on.
   *
   * The injection is durable on the run and echoed into every later prompt; the
   * run flips to `awaiting_input` so the UI can show that the user's constraint
   * is queued, and the loop clears that back to `running` when it consumes it.
   */
  async inject(runId: string, text: string): Promise<CouncilRun> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("an injected constraint cannot be empty");
    return this.mutate(runId, (run) => {
      if (run.status !== "running" && run.status !== "awaiting_input") {
        throw new Error(`run ${runId} is not accepting input (status ${run.status})`);
      }
      return {
        ...run,
        status: "awaiting_input",
        injections: [...run.injections, { round: run.roundsRun, text: trimmed, at: this.nowIso() }],
      };
    });
  }

  /** Force the verdict at the next round boundary. */
  async forceVerdict(runId: string): Promise<CouncilRun> {
    const control = this.running.get(runId);
    if (control) control.forceVerdict = true;
    return this.requireRun(runId);
  }

  /** Cancel at the next round boundary; a run with no live loop is cancelled now. */
  async cancel(runId: string): Promise<CouncilRun> {
    const control = this.running.get(runId);
    if (control) {
      control.cancelled = true;
      return this.requireRun(runId);
    }
    return this.mutate(runId, (run) =>
      run.status === "complete" || run.status === "failed" || run.status === "cancelled"
        ? run
        : { ...run, status: "cancelled", error: "cancelled" },
    );
  }

  /**
   * Fail runs a crash left mid-debate.
   *
   * Unlike research, a council has no external durable executor to re-attach to:
   * the debate state is only the persisted contributions, and an agent turn cut
   * off by a crash cannot be resumed. So an interrupted run is stated as failed
   * rather than left at `running`.
   */
  async resume(): Promise<number> {
    let repaired = 0;
    for (const run of await this.list(200)) {
      if (run.status !== "running" && run.status !== "awaiting_input") continue;
      repaired += 1;
      await this.persist({
        ...run,
        status: "failed",
        error: "the council was interrupted and cannot be resumed",
      }).catch(() => undefined);
    }
    return repaired;
  }

  // --- the debate ----------------------------------------------------------

  private async runDebate(runId: string): Promise<void> {
    try {
      const run = await this.requireRun(runId);
      const chairModel =
        (await this.deps.resolveModel("reasoning", run.projectId)) ??
        (await this.deps.resolveModel("council", run.projectId));
      if (!chairModel) throw new Error("no model is configured for the council chair");

      // The chair frames the question and the decision criteria first.
      await this.chairTurn(
        runId,
        chairModel.id,
        0,
        "opening",
        `You are the chair of a council debating this question:\n"${run.question}"\n\n` +
          `Restate the question in one sentence and list the decision criteria the ` +
          `council should judge answers against. Be brief.`,
      );

      // Opening statements from every member.
      await this.memberRound(runId, chairModel.id, 0, "opening");

      let boundary = this.atBoundary(runId);
      if (boundary === "cancel") return this.finishCancelled(runId);

      // Rebuttal rounds, up to the budget, ending early on convergence.
      if (boundary !== "verdict") {
        for (let round = 1; round <= run.roundBudget; round += 1) {
          boundary = this.atBoundary(runId);
          if (boundary === "cancel") return this.finishCancelled(runId);
          if (boundary === "verdict") break;

          await this.consumeInjections(runId);
          await this.memberRound(runId, chairModel.id, round, "rebuttal");
          await this.mutate(runId, (current) => ({ ...current, roundsRun: round }));

          if (await this.chairConverged(runId, chairModel.id, round)) break;
        }
      }

      if (this.atBoundary(runId) === "cancel") return this.finishCancelled(runId);

      // Convergence summary, then the structured verdict.
      await this.mutate(runId, (current) => ({ ...current, phase: "convergence" }));
      await this.chairTurn(
        runId,
        chairModel.id,
        (await this.read(runId))?.roundsRun ?? 0,
        "convergence",
        `As chair, summarise where the council converged and where it did not. Be brief.`,
      );

      await this.produceVerdict(runId, chairModel.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.error("council debate failed", { runId, error: message });
      await this.mutate(runId, (run) => ({ ...run, status: "failed", error: message })).catch(
        () => undefined,
      );
      await this.deps.audit.record({
        actor: { kind: "system" },
        action: "council.run_failed",
        family: "council",
        outcome: "failed",
        correlationId: (await this.read(runId))?.correlationId ?? runId,
        resources: [runId],
        reason: message,
      });
    } finally {
      this.running.delete(runId);
    }
  }

  /** Read the pending control intent for a boundary. Never interrupts a turn. */
  private atBoundary(runId: string): "cancel" | "verdict" | "continue" {
    const control = this.running.get(runId);
    if (!control) return "continue";
    if (control.cancelled) return "cancel";
    if (control.forceVerdict) return "verdict";
    return "continue";
  }

  /** Clear the `awaiting_input` flag once the loop has picked up the injection. */
  private async consumeInjections(runId: string): Promise<void> {
    const run = await this.read(runId);
    if (run?.status === "awaiting_input") {
      await this.mutate(runId, (current) => ({ ...current, status: "running" }));
    }
  }

  private async finishCancelled(runId: string): Promise<void> {
    await this.mutate(runId, (run) => ({ ...run, status: "cancelled", error: "cancelled" }));
    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "council.run_cancelled",
      family: "council",
      outcome: "denied",
      correlationId: (await this.read(runId))?.correlationId ?? runId,
      resources: [runId],
      reason: "cancelled at a round boundary",
    });
  }

  /** One turn for each member in roster order. */
  private async memberRound(
    runId: string,
    chairModelId: string,
    round: number,
    phase: CouncilPhase,
  ): Promise<void> {
    const run = await this.requireRun(runId);
    await this.mutate(runId, (current) => ({ ...current, phase }));

    for (const member of run.members) {
      const modelId = member.modelId || chairModelId;
      const prompt = this.memberPrompt(await this.requireRun(runId), member, round, phase);
      const result = await this.deps.runAgent({
        prompt,
        label: { kind: "council", detail: `${member.name} · ${phase} round ${round}` },
        modelId,
        toolFamilies: member.toolFamilies,
        skills: member.skills,
      });

      const argument = result.text.trim();
      const contribution = CouncilContribution.parse({
        id: newTaskId(),
        round,
        phase,
        memberId: member.id,
        memberName: member.name,
        stance: member.stance,
        modelId,
        summary: firstLine(argument),
        argument,
        toolCalls: result.toolCalls,
        at: this.nowIso(),
      });

      await this.appendContribution(runId, contribution);
      await this.deps.audit.record({
        actor: { kind: "system" },
        action: "council.member_turn",
        family: "council",
        outcome: "succeeded",
        correlationId: run.correlationId,
        resources: [member.id, modelId, `round:${round}`],
        reason: `${member.name} (${member.stance.slice(0, 80)}) spoke in ${phase} round ${round}`,
      });
    }
  }

  private async chairTurn(
    runId: string,
    chairModelId: string,
    round: number,
    phase: CouncilPhase,
    prompt: string,
  ): Promise<string> {
    const run = await this.requireRun(runId);
    const result = await this.deps.runAgent({
      prompt,
      label: { kind: "council", detail: `Chair · ${phase} round ${round}` },
      modelId: chairModelId,
      toolFamilies: [],
    });
    const argument = result.text.trim();
    const contribution = CouncilContribution.parse({
      id: newTaskId(),
      round,
      phase,
      memberId: CHAIR_ID,
      memberName: "Chair",
      stance: "chair",
      modelId: chairModelId,
      summary: firstLine(argument),
      argument,
      toolCalls: result.toolCalls,
      at: this.nowIso(),
    });
    await this.appendContribution(runId, contribution);
    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "council.chair_turn",
      family: "council",
      outcome: "succeeded",
      correlationId: run.correlationId,
      resources: [CHAIR_ID, chairModelId, `round:${round}`],
      reason: `chair spoke in ${phase} round ${round}`,
    });
    return argument;
  }

  /** Ask the chair whether the debate has stopped moving. */
  private async chairConverged(
    runId: string,
    chairModelId: string,
    round: number,
  ): Promise<boolean> {
    const run = await this.requireRun(runId);
    const result = await this.deps.runAgent({
      prompt:
        `As chair, decide whether the council's positions have stopped moving and ` +
        `the debate can end. Return ONLY JSON: {"converged": true|false, "reason": "..."}.\n\n` +
        this.transcriptDigest(run),
      label: { kind: "council", detail: `Chair · convergence check after round ${round}` },
      modelId: chairModelId,
      toolFamilies: [],
    });
    const json = extractJsonObject(result.text);
    if (json === null) return false;
    try {
      const parsed = ConvergencePayload.safeParse(JSON.parse(json));
      if (parsed.success && parsed.data.converged) {
        this.deps.logger.info("council converged early", { runId, round, reason: parsed.data.reason });
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private async produceVerdict(runId: string, chairModelId: string): Promise<void> {
    await this.mutate(runId, (run) => ({ ...run, phase: "verdict" }));
    const run = await this.requireRun(runId);

    // Two attempts: a chair that returns unparsable JSON is given one more try
    // before the run is failed, since re-prompting is cheap and losing a full
    // debate to one malformed reply is not.
    let payload: z.infer<typeof VerdictPayload> | null = null;
    for (let attempt = 0; attempt < 2 && payload === null; attempt += 1) {
      const result = await this.deps.runAgent({
        prompt: this.verdictPrompt(run, attempt > 0),
        label: {
          kind: "council",
          detail: attempt > 0 ? "Chair · verdict (retry)" : "Chair · verdict",
        },
        modelId: chairModelId,
        toolFamilies: [],
      });
      const json = extractJsonObject(result.text);
      if (json !== null) {
        try {
          const parsed = VerdictPayload.safeParse(JSON.parse(json));
          if (parsed.success) payload = parsed.data;
        } catch {
          payload = null;
        }
      }
    }

    if (!payload) throw new Error("the chair did not return a parsable verdict");

    const byId = new Map(run.members.map((member) => [member.id, member]));
    const dissent: CouncilDissent[] = payload.dissent.map((entry) => {
      const member = entry.memberId ? byId.get(entry.memberId) : undefined;
      return CouncilDissent.parse({
        memberId: entry.memberId || member?.id || "",
        memberName: entry.memberName || member?.name || "a member",
        position: entry.position,
      });
    });

    const verdict = CouncilVerdict.parse({
      recommendation: payload.recommendation,
      criteria: payload.criteria,
      strongestFor: payload.strongestFor,
      strongestAgainst: payload.strongestAgainst,
      dissent,
      confidence: payload.confidence,
      openQuestions: payload.openQuestions,
      path: "",
      at: this.nowIso(),
    });

    let path = "";
    const projectDir = this.deps.projectDir();
    if (projectDir) {
      path = await this.writeIntoProject(projectDir, run, verdict);
    }

    const done = await this.mutate(runId, (current) => ({
      ...current,
      status: "complete",
      phase: "verdict",
      verdict: { ...verdict, path },
    }));

    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "council.verdict_written",
      family: "council",
      outcome: "succeeded",
      correlationId: done.correlationId,
      resources: path ? [runId, path] : [runId],
      reason: `verdict at ${verdict.confidence} confidence with ${dissent.length} dissents`,
    });
  }

  // --- prompts and rendering ----------------------------------------------

  private memberPrompt(
    run: CouncilRun,
    member: CouncilMember,
    // The round is already legible from the transcript this prompt renders, so
    // naming it again would be a second answer to the same question. Kept in
    // the signature because every caller has it and a prompt that needs to
    // treat round one differently is a change here, not at four call sites.
    _round: number,
    phase: CouncilPhase,
  ): string {
    const constraints = run.injections.length
      ? `\nConstraints the user added:\n${run.injections.map((i) => `- ${i.text}`).join("\n")}\n`
      : "";
    const opener =
      phase === "opening"
        ? `Give your opening statement.`
        : `Rebut the other members and refine your position. Do not merely repeat yourself.`;
    return (
      `You are "${member.name}" on a council debating:\n"${run.question}"\n\n` +
      `Your stance: ${member.stance}\n${constraints}\n` +
      `${opener} Be concise and specific.\n\n` +
      (phase === "opening" ? "" : `Debate so far:\n${this.transcriptDigest(run)}`)
    );
  }

  private verdictPrompt(run: CouncilRun, retry: boolean): string {
    return (
      (retry
        ? `Your previous reply was not valid JSON. Return ONLY the JSON object.\n\n`
        : ``) +
      `As chair, write the council's verdict on:\n"${run.question}"\n\n` +
      `Attribute any dissent to the member who held it. Return ONLY a JSON object ` +
      `of this exact shape:\n` +
      `{\n` +
      `  "recommendation": "the decision",\n` +
      `  "criteria": ["the decision criteria used"],\n` +
      `  "strongestFor": "the strongest argument for the recommendation",\n` +
      `  "strongestAgainst": "the strongest argument against it",\n` +
      `  "dissent": [{ "memberId": "", "memberName": "", "position": "..." }],\n` +
      `  "confidence": "low|medium|high",\n` +
      `  "openQuestions": ["..."]\n` +
      `}\n\n` +
      `Members: ${run.members.map((m) => `${m.name} (${m.id})`).join(", ")}\n\n` +
      `Debate:\n${this.transcriptDigest(run)}`
    );
  }

  /** A compact, bounded transcript for a prompt: one line per contribution. */
  private transcriptDigest(run: CouncilRun, limit = 40_000): string {
    const lines = run.contributions.map(
      (c) => `[r${c.round} ${c.phase}] ${c.memberName}: ${c.argument}`,
    );
    const body = lines.join("\n\n");
    return body.length <= limit ? body : `${body.slice(-limit)}`;
  }

  private async appendContribution(runId: string, contribution: CouncilContribution): Promise<void> {
    await this.mutate(runId, (run) => ({
      ...run,
      contributions: [...run.contributions, contribution],
      // Live spend: reflects the turns actually taken, not just the estimate.
      estimatedTokens: (run.contributions.length + 1) * PER_TURN_TOKENS,
    }));
  }

  private async writeIntoProject(
    projectDir: string,
    run: CouncilRun,
    verdict: CouncilVerdict,
  ): Promise<string> {
    const relPath = `council/${slug(run.question)}-${run.id}.md`;
    const full = resolve(projectDir, relPath);
    const rel = relative(projectDir, full);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("the verdict path leaves the project");
    }
    await mkdir(join(projectDir, "council"), { recursive: true });
    await writeFile(full, renderVerdict(run, verdict), "utf8");
    return rel.split(sep).join("/");
  }
}

function renderVerdict(run: CouncilRun, verdict: CouncilVerdict): string {
  const dissent = verdict.dissent.length
    ? verdict.dissent.map((d) => `- **${d.memberName}**: ${d.position}`).join("\n")
    : "_No dissent was recorded._";
  const criteria = verdict.criteria.length ? verdict.criteria.map((c) => `- ${c}`).join("\n") : "_None stated._";
  const open = verdict.openQuestions.length
    ? verdict.openQuestions.map((q) => `- ${q}`).join("\n")
    : "_None._";
  return (
    `# Council verdict\n\n` +
    `**Question:** ${run.question}\n\n` +
    `## Recommendation\n\n${verdict.recommendation}\n\n` +
    `**Confidence:** ${verdict.confidence}\n\n` +
    `## Decision criteria\n\n${criteria}\n\n` +
    `## Strongest argument for\n\n${verdict.strongestFor || "_Not stated._"}\n\n` +
    `## Strongest argument against\n\n${verdict.strongestAgainst || "_Not stated._"}\n\n` +
    `## Dissent\n\n${dissent}\n\n` +
    `## Open questions\n\n${open}\n`
  );
}

function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.trim().slice(0, 200);
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
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
    else if (char === "{") depth += 1;
    else if (char === "}") {
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
      .slice(0, 40) || "verdict"
  );
}
