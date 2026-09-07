import path from "node:path";
import {
  DecisionGate,
  OrchestrationPlan,
  OrchestrationTask,
  newTaskId,
  type TaskStatus,
} from "@iq/shared";
import { readJson, writeJsonAtomic, removeIfExists } from "../util/jsonl.js";
import { SAMPLE_PLANS, isSamplePlan } from "../samples/plans.js";
import { KeyedMutex } from "../util/lock.js";
import type { AppPaths } from "../config/paths.js";
import { z } from "zod";

/**
 * One plan and everything that belongs to it.
 *
 * The shared contracts are normalized (a task points at its plan), but a plan
 * is only ever read or written as a whole, so it is stored as one atomically
 * rewritten document. That gives an all-or-nothing consistency guarantee
 * without depending on a native database.
 */
export const PlanDocument = z.object({
  plan: OrchestrationPlan,
  tasks: z.array(OrchestrationTask),
  gates: z.array(DecisionGate),
});
export type PlanDocument = z.infer<typeof PlanDocument>;

export class PlanStore {
  private readonly locks = new KeyedMutex();

  constructor(private readonly paths: AppPaths) {}

  private file(planId: string): string {
    return path.join(this.paths.orchestration, `${planId}.json`);
  }

  async read(planId: string): Promise<PlanDocument | null> {
    const raw = await readJson<unknown>(this.file(planId), null);
    if (!raw) return null;
    const parsed = PlanDocument.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  async write(doc: PlanDocument): Promise<void> {
    await writeJsonAtomic(this.file(doc.plan.id), doc);
  }

  async delete(planId: string): Promise<void> {
    await removeIfExists(this.file(planId));
  }

  /** Every persisted plan, newest first. */
  async list(limit = 50): Promise<PlanDocument[]> {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(this.paths.orchestration).catch(() => [] as string[]);
    const docs: PlanDocument[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const doc = await this.read(file.replace(/\.json$/, ""));
      if (doc) docs.push(doc);
    }
    return docs
      .sort((a, b) => b.plan.createdAt.localeCompare(a.plan.createdAt))
      .slice(0, limit);
  }

  /**
   * Write the worked example, already finished.
   *
   * Idempotent through the fixed id, and an existing sample is left alone —
   * overwriting it would discard a gate the user had answered while reading it.
   */
  async seedSamples(): Promise<{ added: number; total: number }> {
    let added = 0;
    for (const doc of SAMPLE_PLANS) {
      if ((await this.read(doc.plan.id)) !== null) continue;
      await this.write(doc);
      added += 1;
    }
    return { added, total: (await this.list()).length };
  }

  /** Remove only the sample plans. */
  async clearSamples(): Promise<{ removed: number; total: number }> {
    let removed = 0;
    for (const doc of await this.list(500)) {
      if (!isSamplePlan(doc.plan.id)) continue;
      await this.delete(doc.plan.id);
      removed += 1;
    }
    return { removed, total: (await this.list()).length };
  }

  /** Read-modify-write under a per-plan lock so parallel tasks cannot race. */
  async mutate(
    planId: string,
    fn: (doc: PlanDocument) => PlanDocument,
  ): Promise<PlanDocument> {
    return this.locks.withLock(planId, async () => {
      const doc = await this.read(planId);
      if (!doc) throw new Error(`unknown plan ${planId}`);
      const next = fn(doc);
      next.plan.updatedAt = new Date().toISOString();
      await this.write(next);
      return next;
    });
  }
}

export interface SubAgentRequest {
  planId: string;
  parentSessionId: string;
  task: OrchestrationTask;
  signal: AbortSignal;
}

export interface SubAgentResult {
  result: string;
  sessionId: string;
}

export interface CoordinatorDeps {
  store: PlanStore;
  /**
   * Executes one task in an isolated sub-agent session.
   *
   * Isolation is the point: a task carries its full instruction rather than
   * inheriting the parent's conversation.
   */
  delegate: (request: SubAgentRequest) => Promise<SubAgentResult>;
  audit: (record: {
    action: string;
    planId: string;
    taskId?: string;
    outcome: "allowed" | "denied" | "failed";
    detail?: Record<string, unknown>;
  }) => Promise<void>;
  logger: {
    info: (message: string, fields?: Record<string, unknown>) => void;
    warn: (message: string, fields?: Record<string, unknown>) => void;
    error: (message: string, fields?: Record<string, unknown>) => void;
  };
  publish: (doc: PlanDocument) => void;
  /** Hard ceiling on parallelism regardless of what a plan requests. */
  maxParallelCeiling?: number;
}

export interface TaskSpec {
  /** Stable alias used to express dependencies before ids exist. */
  key: string;
  title: string;
  instruction: string;
  dependsOn?: string[];
  toolFamilies?: string[];
  skills?: string[];
  maxAttempts?: number;
}

export interface GateSpec {
  question: string;
  /** Aliases of the tasks held until this gate is resolved. */
  gates: string[];
}

/**
 * Coordinator for sub-agent delegation and parallel execution.
 *
 * The coordinator polls the persisted DAG and converges the plan in passes. Each
 * pass:
 *
 *  1. promotes `blocked` tasks whose dependencies have all succeeded to `ready`;
 *  2. holds any task behind an unresolved decision gate, and fails it outright
 *     if the gate was rejected;
 *  3. dispatches `ready` tasks up to the plan's parallel cap;
 *  4. retries a failed task while attempts remain, then settles the plan.
 *
 * Every transition is persisted before it takes effect, so a crash costs only
 * the in-flight tasks, and those are re-runnable because each carries its own
 * complete instruction.
 */
export class Coordinator {
  private readonly running = new Map<string, AbortController>();
  private readonly tracked = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private passing = false;

  constructor(private readonly deps: CoordinatorDeps) {}

  start(intervalMs = 1_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pass(), intervalMs);
    this.timer.unref?.();
    this.deps.logger.info("coordinator started", { intervalMs });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.running.values()) controller.abort("coordinator stopping");
    this.running.clear();
  }

  /** Register a plan for polling; called on create and on boot recovery. */
  track(planId: string): void {
    this.tracked.add(planId);
  }

  // --- plan construction ---------------------------------------------------

  async createPlan(input: {
    parentSessionId: string;
    /** The parent turn, used to stop only the work started by that turn. */
    parentTurnId?: string;
    objective: string;
    maxParallel?: number;
    tasks: TaskSpec[];
    gates?: GateSpec[];
  }): Promise<PlanDocument> {
    if (input.tasks.length === 0) throw new Error("a plan needs at least one task");

    const planId = newTaskId();
    const now = new Date().toISOString();
    const idByKey = new Map<string, string>();
    for (const spec of input.tasks) {
      if (idByKey.has(spec.key)) throw new Error(`duplicate task key "${spec.key}"`);
      idByKey.set(spec.key, newTaskId());
    }

    const resolve = (key: string, context: string): string => {
      const id = idByKey.get(key);
      if (!id) throw new Error(`${context} refers to unknown task key "${key}"`);
      return id;
    };

    const tasks = input.tasks.map((spec) => {
      const dependsOn = (spec.dependsOn ?? []).map((key) => resolve(key, `task "${spec.key}"`));
      return OrchestrationTask.parse({
        id: resolve(spec.key, "task"),
        planId,
        title: spec.title,
        instruction: spec.instruction,
        status: (dependsOn.length === 0 ? "ready" : "blocked") satisfies TaskStatus,
        dependsOn,
        toolFamilies: spec.toolFamilies ?? [],
        skills: spec.skills ?? [],
        sessionId: null,
        attempt: 0,
        maxAttempts: spec.maxAttempts ?? 2,
        result: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      });
    });

    const gates = (input.gates ?? []).map((spec) =>
      DecisionGate.parse({
        id: newTaskId(),
        planId,
        question: spec.question,
        gatedTaskIds: spec.gates.map((key) => resolve(key, "gate")),
        resolution: "pending",
        resolvedBy: null,
        resolvedAt: null,
      }),
    );

    const ceiling = this.deps.maxParallelCeiling ?? 4;
    const doc: PlanDocument = {
      plan: OrchestrationPlan.parse({
        id: planId,
        objective: input.objective,
        parentSessionId: input.parentSessionId,
        parentTurnId: input.parentTurnId ?? null,
        maxParallel: Math.max(1, Math.min(input.maxParallel ?? 2, ceiling)),
        status: "running",
        createdAt: now,
        updatedAt: now,
      }),
      tasks,
      gates,
    };

    assertAcyclic(doc);
    await this.deps.store.write(doc);
    this.track(planId);
    await this.deps.audit({
      action: "orchestration.plan_created",
      planId,
      outcome: "allowed",
      detail: {
        objective: input.objective,
        taskCount: tasks.length,
        gateCount: gates.length,
        maxParallel: doc.plan.maxParallel,
      },
    });
    this.deps.publish(doc);
    void this.pass();
    return doc;
  }

  /** Every persisted plan, newest first. */
  listPlans(limit = 50): Promise<PlanDocument[]> {
    return this.deps.store.list(limit);
  }

  /** The worked example, already finished so the loop has nothing to dispatch. */
  seedSamples(): Promise<{ added: number; total: number }> {
    return this.deps.store.seedSamples();
  }

  clearSamples(): Promise<{ removed: number; total: number }> {
    return this.deps.store.clearSamples();
  }

  /**
   * Re-register still-running plans after a restart so polling resumes, and
   * reconcile the tasks the dead process was executing.
   *
   * The re-registration alone was not enough, and left plans that could never
   * finish. A task's `dispatched`/`running` status is persisted, but the thing
   * doing the running is an in-memory `AbortController` in `this.running` —
   * which a restart empties. `passPlan` counts those statuses as occupying a
   * parallel slot, so a plan whose whole in-flight batch died came back with
   * `maxParallel` phantom tasks blocking every `ready` one behind them, and
  * `settleIfDone` refusing to settle because they are not settled.
   *
   * Each task carries its complete instruction, so re-running one is safe;
   * attempts already spent still count, so a task that has used them is failed
   * with a stated reason rather than retried without limit.
   */
  async trackOpenPlans(): Promise<number> {
    const open = (await this.deps.store.list(200)).filter(
      (doc) => doc.plan.status === "running",
    );
    for (const doc of open) {
      this.track(doc.plan.id);
      await this.reconcileInterrupted(doc.plan.id);
    }
    return open.length;
  }

  private async reconcileInterrupted(planId: string): Promise<void> {
    const before = await this.deps.store.read(planId);
    if (!before) return;
    const interrupted = new Set(
      before.tasks
        .filter((task) => task.status === "dispatched" || task.status === "running")
        .map((task) => task.id),
    );
    if (interrupted.size === 0) return;

    const reconciled = await this.deps.store.mutate(planId, (doc) => ({
      ...doc,
      tasks: doc.tasks.map((task) => {
        if (!interrupted.has(task.id)) return task;
        const retryable = task.attempt < task.maxAttempts;
        return {
          ...task,
          status: (retryable ? "ready" : "failed") as TaskStatus,
          error: "interrupted before it finished; the process running it stopped",
          updatedAt: new Date().toISOString(),
        };
      }),
    }));
    this.deps.publish(reconciled);

    for (const task of reconciled.tasks.filter((candidate) => interrupted.has(candidate.id))) {
      await this.deps.audit({
        action:
          task.status === "ready"
            ? "orchestration.task_retry_scheduled"
            : "orchestration.task_failed",
        planId,
        taskId: task.id,
        outcome: "failed",
        detail: { error: task.error, attempt: task.attempt, cancelled: false },
      });
    }

    await this.settleIfDone(planId);
  }

  getPlan(planId: string): Promise<PlanDocument | null> {
    return this.deps.store.read(planId);
  }

  // --- human controls ------------------------------------------------------

  /** Resolve a decision gate. Rejecting it fails every task it holds. */
  async resolveGate(
    planId: string,
    gateId: string,
    resolution: "approved" | "rejected",
    resolvedBy: string,
  ): Promise<PlanDocument> {
    const at = new Date().toISOString();
    const doc = await this.deps.store.mutate(planId, (current) => {
      const gate = current.gates.find((candidate) => candidate.id === gateId);
      if (!gate) throw new Error(`unknown gate ${gateId}`);
      if (gate.resolution !== "pending") throw new Error(`gate ${gateId} is already resolved`);

      return {
        ...current,
        gates: current.gates.map((candidate) =>
          candidate.id === gateId
            ? { ...candidate, resolution, resolvedBy, resolvedAt: at }
            : candidate,
        ),
        tasks:
          resolution === "rejected"
            ? current.tasks.map((task) =>
                gate.gatedTaskIds.includes(task.id) &&
                (task.status === "blocked" || task.status === "ready")
                  ? {
                      ...task,
                      status: "cancelled" as TaskStatus,
                      error: "decision gate rejected",
                      updatedAt: at,
                    }
                  : task,
              )
            : current.tasks,
      };
    });

    await this.deps.audit({
      action: `orchestration.gate_${resolution}`,
      planId,
      outcome: resolution === "approved" ? "allowed" : "denied",
      detail: { gateId, resolvedBy },
    });
    this.deps.publish(doc);
    void this.pass();
    return doc;
  }

  async cancelPlan(planId: string, reason: string): Promise<PlanDocument> {
    const at = new Date().toISOString();
    const doc = await this.deps.store.mutate(planId, (current) => ({
      ...current,
      plan: { ...current.plan, status: "cancelled" as const },
      tasks: current.tasks.map((task) =>
        isSettled(task.status)
          ? task
          : { ...task, status: "cancelled" as TaskStatus, error: reason, updatedAt: at },
      ),
    }));

    for (const task of doc.tasks) this.running.get(task.id)?.abort(reason);
    this.tracked.delete(planId);
    await this.deps.audit({
      action: "orchestration.plan_cancelled",
      planId,
      outcome: "denied",
      detail: { reason },
    });
    this.deps.publish(doc);
    return doc;
  }

  /**
   * Stop the work delegated by one parent turn.
   *
   * A chat turn may return after it starts a delegated plan, so cancelling the
   * turn alone used to leave its child sessions running. The parent turn is
   * part of the plan identity so stopping a later turn in the same conversation
   * cannot cancel work the user chose to leave running.
   */
  async cancelPlansForTurn(
    parentSessionId: string,
    parentTurnId: string,
    reason: string,
  ): Promise<PlanDocument[]> {
    const plans = await this.deps.store.list(Number.MAX_SAFE_INTEGER);
    const matching = plans.filter(
      (doc) =>
        doc.plan.status === "running" &&
        doc.plan.parentSessionId === parentSessionId &&
        doc.plan.parentTurnId === parentTurnId,
    );
    return Promise.all(matching.map((doc) => this.cancelPlan(doc.plan.id, reason)));
  }

  /** Manually retry a settled-but-unsuccessful task and reopen the plan. */
  async retryTask(planId: string, taskId: string): Promise<PlanDocument> {
    const at = new Date().toISOString();
    const doc = await this.deps.store.mutate(planId, (current) => ({
      ...current,
      plan: { ...current.plan, status: "running" as const },
      tasks: current.tasks.map((task) => {
        if (task.id === taskId) {
          return {
            ...task,
            status: (task.dependsOn.length === 0 ? "ready" : "blocked") as TaskStatus,
            attempt: 0,
            error: null,
            updatedAt: at,
          };
        }
        // Downstream work cancelled by this task's failure becomes eligible again.
        if (task.status === "cancelled" && task.dependsOn.includes(taskId)) {
          return { ...task, status: "blocked" as TaskStatus, error: null, updatedAt: at };
        }
        return task;
      }),
    }));

    this.track(planId);
    await this.deps.audit({
      action: "orchestration.task_retry_requested",
      planId,
      taskId,
      outcome: "allowed",
    });
    this.deps.publish(doc);
    void this.pass();
    return doc;
  }

  // --- the coordination pass ----------------------------------------------

  private async pass(): Promise<void> {
    if (this.passing) return;
    this.passing = true;
    try {
      for (const planId of [...this.tracked]) {
        await this.passPlan(planId).catch((error: unknown) => {
          this.deps.logger.error("plan pass failed", {
            planId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } finally {
      this.passing = false;
    }
  }

  private async passPlan(planId: string): Promise<void> {
    const current = await this.deps.store.read(planId);
    if (!current || current.plan.status !== "running") {
      this.tracked.delete(planId);
      return;
    }

    // Step 1: promote blocked tasks whose dependencies are all satisfied.
    const promoted = await this.deps.store.mutate(planId, (doc) => {
      const byId = new Map(doc.tasks.map((task) => [task.id, task]));
      const at = new Date().toISOString();

      return {
        ...doc,
        tasks: doc.tasks.map((task) => {
          if (task.status !== "blocked") return task;

          const deps = task.dependsOn.map((id) => byId.get(id));
          if (deps.some((dep) => !dep || dep.status === "failed" || dep.status === "cancelled")) {
            return {
              ...task,
              status: "cancelled" as TaskStatus,
              error: "a dependency did not succeed",
              updatedAt: at,
            };
          }
          if (!deps.every((dep) => dep?.status === "succeeded")) return task;

          const holding = doc.gates.find(
            (gate) => gate.gatedTaskIds.includes(task.id) && gate.resolution !== "approved",
          );
          if (holding) return task;

          return { ...task, status: "ready" as TaskStatus, updatedAt: at };
        }),
      };
    });

    if (changed(current, promoted)) this.deps.publish(promoted);

    // Step 2: dispatch ready tasks, respecting the plan's parallel cap.
    const inFlight = promoted.tasks.filter(
      (task) => task.status === "dispatched" || task.status === "running",
    ).length;
    const slots = Math.max(0, promoted.plan.maxParallel - inFlight);

    for (const task of promoted.tasks.filter((candidate) => candidate.status === "ready").slice(0, slots)) {
      void this.dispatch(planId, task.id);
    }

    await this.settleIfDone(planId);
  }

  private async dispatch(planId: string, taskId: string): Promise<void> {
    if (this.running.has(taskId)) return;

    const controller = new AbortController();
    this.running.set(taskId, controller);

    try {
      const started = await this.deps.store.mutate(planId, (doc) => ({
        ...doc,
        tasks: doc.tasks.map((task) =>
          task.id === taskId
            ? {
                ...task,
                status: "running" as TaskStatus,
                attempt: task.attempt + 1,
                // The previous attempt's reason is not this attempt's state. Left
                // in place, a healthy retry reads as "running: cancelled by user".
                error: null,
                updatedAt: new Date().toISOString(),
              }
            : task,
        ),
      }));
      this.deps.publish(started);

      const task = started.tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`task ${taskId} vanished from plan ${planId}`);

      await this.deps.audit({
        action: "orchestration.task_started",
        planId,
        taskId,
        outcome: "allowed",
        detail: { title: task.title, attempt: task.attempt, toolFamilies: task.toolFamilies },
      });

      const outcome = await this.deps.delegate({
        planId,
        parentSessionId: started.plan.parentSessionId,
        task,
        signal: controller.signal,
      });

      const succeeded = await this.deps.store.mutate(planId, (doc) => ({
        ...doc,
        tasks: doc.tasks.map((candidate) =>
          candidate.id === taskId
            ? {
                ...candidate,
                status: "succeeded" as TaskStatus,
                result: outcome.result,
                sessionId: outcome.sessionId,
                error: null,
                updatedAt: new Date().toISOString(),
              }
            : candidate,
        ),
      }));
      this.deps.publish(succeeded);
      await this.deps.audit({
        action: "orchestration.task_succeeded",
        planId,
        taskId,
        outcome: "allowed",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = controller.signal.aborted;

      const failed = await this.deps.store.mutate(planId, (doc) => ({
        ...doc,
        tasks: doc.tasks.map((task) => {
          if (task.id !== taskId) return task;
          // Attempts left means another pass will pick it up as "ready".
          const retryable = !cancelled && task.attempt < task.maxAttempts;
          return {
            ...task,
            status: (cancelled ? "cancelled" : retryable ? "ready" : "failed") as TaskStatus,
            error: message,
            updatedAt: new Date().toISOString(),
          };
        }),
      }));
      this.deps.publish(failed);

      const task = failed.tasks.find((candidate) => candidate.id === taskId);
      await this.deps.audit({
        action:
          task?.status === "ready"
            ? "orchestration.task_retry_scheduled"
            : "orchestration.task_failed",
        planId,
        taskId,
        outcome: "failed",
        detail: { error: message, attempt: task?.attempt, cancelled },
      });
    } finally {
      this.running.delete(taskId);
      await this.settleIfDone(planId).catch(() => undefined);
    }
  }

  private async settleIfDone(planId: string): Promise<void> {
    const doc = await this.deps.store.read(planId);
    if (!doc || doc.plan.status !== "running") return;
    if (doc.tasks.some((task) => !isSettled(task.status))) return;

    const failed = doc.tasks.some(
      (task) => task.status === "failed" || task.status === "cancelled",
    );
    const settled = await this.deps.store.mutate(planId, (current) => ({
      ...current,
      plan: { ...current.plan, status: failed ? ("failed" as const) : ("succeeded" as const) },
    }));

    this.tracked.delete(planId);
    this.deps.publish(settled);
    await this.deps.audit({
      action: failed ? "orchestration.plan_failed" : "orchestration.plan_succeeded",
      planId,
      outcome: failed ? "failed" : "allowed",
      detail: { taskCount: doc.tasks.length },
    });
  }
}

function isSettled(status: TaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function changed(before: PlanDocument, after: PlanDocument): boolean {
  return before.tasks.some((task, index) => task.status !== after.tasks[index]?.status);
}

/**
 * Reject a plan whose dependencies form a cycle.
 *
 * Left unchecked, a cycle's tasks would simply never be promoted and the plan
 * would sit at "running" forever. Failing at construction makes the authoring
 * mistake obvious instead.
 */
export function assertAcyclic(doc: PlanDocument): void {
  const byId = new Map(doc.tasks.map((task) => [task.id, task]));
  const state = new Map<string, "visiting" | "done">();

  const visit = (taskId: string, trail: string[]): void => {
    const status = state.get(taskId);
    if (status === "done") return;
    if (status === "visiting") {
      const titles = [...trail, taskId].map((id) => byId.get(id)?.title ?? id);
      throw new Error(`orchestration plan has a dependency cycle: ${titles.join(" -> ")}`);
    }
    state.set(taskId, "visiting");
    for (const dependency of byId.get(taskId)?.dependsOn ?? []) {
      if (!byId.has(dependency)) {
        throw new Error(`task ${taskId} depends on unknown task ${dependency}`);
      }
      visit(dependency, [...trail, taskId]);
    }
    state.set(taskId, "done");
  };

  for (const task of doc.tasks) visit(task.id, []);
}
