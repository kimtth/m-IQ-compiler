import path from "node:path";
import { CronExpressionParser } from "cron-parser";
import {
  JobRun,
  ScheduledJob,
  newJobRunId,
  newScheduledJobId,
  type RetryPolicy,
  type Trigger,
} from "@iq/shared";
import { appendJsonl, readJsonl, readJson, writeJsonAtomic } from "../util/jsonl.js";
import { SAMPLE_JOBS, isSampleJob } from "../samples/automations.js";
import { SingleFlight } from "../util/lock.js";
import { withTimeout, TimeoutError } from "../util/retry.js";
import type { AppPaths } from "../config/paths.js";

/**
 * Durable store for jobs and run history.
 *
 * Job definitions live in a single JSON file and run output on disk.
 * Definitions are a small mutable set, so an atomic rewrite is right; runs only
 * ever grow, so they are append-only.
 */
export class ScheduleStore {
  private readonly jobsFile: string;
  private readonly runsFile: string;

  constructor(paths: AppPaths) {
    this.jobsFile = path.join(paths.jobs, "jobs.json");
    this.runsFile = path.join(paths.jobs, "runs.jsonl");
  }

  async listJobs(): Promise<ScheduledJob[]> {
    const raw = await readJson<unknown>(this.jobsFile, []);
    if (!Array.isArray(raw)) return [];
    const jobs: ScheduledJob[] = [];
    for (const entry of raw) {
      const parsed = ScheduledJob.safeParse(entry);
      if (parsed.success) jobs.push(parsed.data);
    }
    return jobs;
  }

  async getJob(jobId: string): Promise<ScheduledJob | null> {
    return (await this.listJobs()).find((job) => job.id === jobId) ?? null;
  }

  async saveJob(job: ScheduledJob): Promise<void> {
    const jobs = await this.listJobs();
    const index = jobs.findIndex((existing) => existing.id === job.id);
    if (index >= 0) jobs[index] = job;
    else jobs.push(job);
    await writeJsonAtomic(this.jobsFile, jobs);
  }

  async deleteJob(jobId: string): Promise<void> {
    await writeJsonAtomic(
      this.jobsFile,
      (await this.listJobs()).filter((job) => job.id !== jobId),
    );
  }

  async appendRun(run: JobRun): Promise<void> {
    await appendJsonl(this.runsFile, [run]);
  }

  /**
   * Latest state of every run, newest first.
   *
   * The log holds one line per state change, so the last line for a run id wins.
   */
  async listRuns(jobId?: string, limit = 200): Promise<JobRun[]> {
    const latest = new Map<string, JobRun>();
    for (const row of await readJsonl(this.runsFile)) {
      const parsed = JobRun.safeParse(row);
      if (!parsed.success) continue;
      if (jobId && parsed.data.jobId !== jobId) continue;
      latest.set(parsed.data.runId, parsed.data);
    }
    return [...latest.values()]
      .sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor))
      .slice(0, limit);
  }
}

export interface JobExecution {
  sessionId: string;
  summary: string;
}

export interface SchedulerDeps {
  store: ScheduleStore;
  /**
   * Runs one occurrence.
   *
   * Each occurrence runs in a fresh agent session with job-scoped toolsets. The
   * container injects an executor that does exactly that, so the scheduler
   * stays free of agent concerns.
   */
  execute: (job: ScheduledJob, run: JobRun, signal: AbortSignal) => Promise<JobExecution>;
  audit: (record: {
    action: string;
    jobId: string;
    runId: string;
    outcome: "allowed" | "denied" | "failed";
    detail?: Record<string, unknown>;
  }) => Promise<void>;
  logger: {
    info: (message: string, fields?: Record<string, unknown>) => void;
    warn: (message: string, fields?: Record<string, unknown>) => void;
    error: (message: string, fields?: Record<string, unknown>) => void;
  };
  publish: (run: JobRun) => void;
  /**
   * Whether the app is showing its worked examples.
   *
   * A sample job is written disabled and re-disabled on every load, so the only
   * way one runs is that somebody switched it on deliberately. This is the
   * second lock, for the case that is not deliberate at all: samples switched
   * off months later, an enabled example forgotten in the list, and an
   * unattended turn still firing every Monday against a fixture nobody
   * remembers agreeing to. Off means off.
   */
  sampleDataEnabled?: () => boolean;
  now?: () => Date;
  /** Ceiling on concurrent runs across all jobs. */
  maxConcurrent?: number;
  /**
   * Occurrences older than this are not backfilled after downtime; the
   * scheduler skips forward instead. Prevents a week offline from firing a
   * week of emails on the next launch.
   */
  catchUpWindowMs?: number;
}

/**
 * Scheduler for unattended agent work.
 *
 * Three properties matter more than triggering itself, because these runs act
 * while nobody is watching:
 *
 *  - **Idempotency.** Each occurrence has a key of `jobId:scheduledFor`. A key
 *    that already succeeded is never executed again, so a crash mid-tick cannot
 *    double-send a mail.
 *  - **Single-flight.** One occurrence per job at a time.
 *  - **Bounded retries.** Failures back off exponentially up to the job's
 *    policy and then stop, rather than looping forever.
 */
export class Scheduler {
  private readonly flight = new SingleFlight();
  private readonly controllers = new Map<string, AbortController>();
  private readonly succeededKeys = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly deps: SchedulerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async start(intervalMs = 30_000): Promise<void> {
    if (this.timer) return;
    await this.hydrate();
    await this.reconcileInterruptedRuns();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    this.deps.logger.info("scheduler started", { intervalMs });
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.controllers.values()) controller.abort("scheduler stopping");
    this.controllers.clear();
  }

  // --- job management ------------------------------------------------------

  async createJob(input: {
    name: string;
    objective: string;
    trigger: Trigger;
    toolFamilies?: string[];
    skills?: string[];
    enabled?: boolean;
    retry?: Partial<RetryPolicy>;
    timeoutMs?: number;
  }): Promise<ScheduledJob> {
    if (input.trigger.kind === "cron") {
      const invalid = validateCron(input.trigger.expression, input.trigger.timezone);
      if (invalid) throw new Error(`invalid cron expression: ${invalid}`);
    }

    const at = this.now().toISOString();
    const job = ScheduledJob.parse({
      id: newScheduledJobId(),
      name: input.name,
      objective: input.objective,
      trigger: input.trigger,
      enabled: input.enabled ?? true,
      toolFamilies: input.toolFamilies ?? [],
      skills: input.skills ?? [],
      retry: input.retry ?? {},
      timeoutMs: input.timeoutMs ?? 10 * 60_000,
      createdAt: at,
      updatedAt: at,
    });
    await this.deps.store.saveJob(job);
    this.deps.logger.info("job created", { jobId: job.id, trigger: job.trigger.kind });
    return job;
  }

  async updateJob(jobId: string, patch: Partial<ScheduledJob>): Promise<ScheduledJob> {
    const existing = await this.deps.store.getJob(jobId);
    if (!existing) throw new Error(`unknown job ${jobId}`);
    const merged = ScheduledJob.parse({
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: this.now().toISOString(),
    });
    await this.deps.store.saveJob(merged);
    return merged;
  }

  setEnabled(jobId: string, enabled: boolean): Promise<ScheduledJob> {
    return this.updateJob(jobId, { enabled });
  }

  async deleteJob(jobId: string): Promise<void> {
    this.controllers.get(jobId)?.abort("job deleted");
    await this.deps.store.deleteJob(jobId);
  }

  listJobs(): Promise<ScheduledJob[]> {
    return this.deps.store.listJobs();
  }

  /**
   * Put the worked examples in the store, disabled.
   *
   * Idempotent through the fixed sample ids, and it never re-enables a sample
   * the user has since switched on — an existing sample is left exactly as it
   * is, because "load examples" is not consent to undo a decision they made
   * about one.
   */
  async seedSamples(): Promise<{ added: number; total: number }> {
    const existing = new Set((await this.deps.store.listJobs()).map((job) => job.id));
    let added = 0;
    for (const job of SAMPLE_JOBS) {
      if (existing.has(job.id)) continue;
      await this.deps.store.saveJob(job);
      added += 1;
    }
    return { added, total: (await this.deps.store.listJobs()).length };
  }

  /** Remove only the sample jobs. Anything the user wrote is untouched. */
  async clearSamples(): Promise<{ removed: number; total: number }> {
    const jobs = await this.deps.store.listJobs();
    let removed = 0;
    for (const job of jobs) {
      if (!isSampleJob(job.id)) continue;
      await this.deleteJob(job.id);
      removed += 1;
    }
    return { removed, total: (await this.deps.store.listJobs()).length };
  }

  listRuns(jobId?: string): Promise<JobRun[]> {
    return this.deps.store.listRuns(jobId);
  }

  /**
   * Fire a job immediately, outside its schedule.
   *
   * Given its own occurrence key so a manual run can never collide with, or be
   * suppressed by, the scheduled one.
   */
  async runNow(jobId: string): Promise<JobRun | null> {
    const job = await this.deps.store.getJob(jobId);
    if (!job) throw new Error(`unknown job ${jobId}`);
    const at = this.now();
    return this.execute(job, at, `${job.id}:manual:${at.toISOString()}`, 1);
  }

  // --- ticking -------------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const jobs = await this.deps.store.listJobs();
      const runs = await this.deps.store.listRuns();

      for (const job of jobs) {
        if (!job.enabled) continue;
        if (isSampleJob(job.id) && this.deps.sampleDataEnabled?.() === false) continue;
        if (this.controllers.size >= (this.deps.maxConcurrent ?? 3)) break;
        if (this.controllers.has(job.id)) continue;

        const jobRuns = runs.filter((run) => run.jobId === job.id);

        // A failed run with attempts left takes priority over a new occurrence.
        const retry = jobRuns.find(
          (run) =>
            run.status === "failed" &&
            run.nextAttemptAt !== null &&
            new Date(run.nextAttemptAt).getTime() <= now.getTime() &&
            run.attempt < job.retry.maxAttempts,
        );
        if (retry) {
          void this.execute(
            job,
            new Date(retry.scheduledFor),
            retry.idempotencyKey,
            retry.attempt + 1,
          );
          continue;
        }

        const due = this.nextDueOccurrence(job, jobRuns, now);
        if (due) void this.execute(job, due, `${job.id}:${due.toISOString()}`, 1);
      }
    } catch (error) {
      this.deps.logger.error("scheduler tick failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.ticking = false;
    }
  }

  /**
   * The occurrence a job owes right now, if any.
   *
   * Derived from the trigger and the last scheduled occurrence rather than
   * stored, so the durable log stays the single source of truth. Occurrences
   * older than the catch-up window are skipped instead of backfilled.
   */
  private nextDueOccurrence(job: ScheduledJob, runs: JobRun[], now: Date): Date | null {
    if (job.trigger.kind === "manual") return null;

    const scheduledKeyPrefix = `${job.id}:`;
    const lastScheduled = runs
      .filter((run) => run.idempotencyKey.startsWith(scheduledKeyPrefix))
      .filter((run) => !run.idempotencyKey.includes(":manual:"))
      .map((run) => new Date(run.scheduledFor))
      .sort((a, b) => b.getTime() - a.getTime())[0];

    if (job.trigger.kind === "once") {
      const at = new Date(job.trigger.at);
      if (lastScheduled) return null;
      return at.getTime() <= now.getTime() ? at : null;
    }

    const window = this.deps.catchUpWindowMs ?? 60 * 60_000;
    let cursor = lastScheduled ?? new Date(job.createdAt);
    let next = this.advance(job.trigger, cursor);

    // Skip forward over occurrences missed while the app was closed.
    let guard = 0;
    while (next && next.getTime() < now.getTime() - window && guard < 10_000) {
      cursor = next;
      next = this.advance(job.trigger, cursor);
      guard += 1;
    }

    if (!next) return null;
    if (next.getTime() > now.getTime()) return null;
    if (this.succeededKeys.has(`${job.id}:${next.toISOString()}`)) return null;
    return next;
  }

  private advance(trigger: Trigger, from: Date): Date | null {
    switch (trigger.kind) {
      case "interval":
        return new Date(from.getTime() + trigger.everyMs);
      case "cron":
        try {
          return CronExpressionParser.parse(trigger.expression, {
            currentDate: from,
            tz: trigger.timezone,
          })
            .next()
            .toDate();
        } catch (error) {
          this.deps.logger.error("invalid cron expression", {
            expression: trigger.expression,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      case "once":
        return new Date(trigger.at);
      default:
        return null;
    }
  }

  // --- executing one occurrence -------------------------------------------

  private async execute(
    job: ScheduledJob,
    scheduledFor: Date,
    idempotencyKey: string,
    attempt: number,
  ): Promise<JobRun | null> {
    if (this.succeededKeys.has(idempotencyKey)) {
      this.deps.logger.info("occurrence already succeeded; skipping", { jobId: job.id, idempotencyKey });
      return null;
    }

    // Single-flight per job: skip a second occurrence while one is running.
    const settled = await this.flight.run(job.id, async () => {
      const controller = new AbortController();
      this.controllers.set(job.id, controller);

      let run: JobRun = JobRun.parse({
        runId: newJobRunId(),
        jobId: job.id,
        idempotencyKey,
        attempt,
        status: "running",
        sessionId: null,
        scheduledFor: scheduledFor.toISOString(),
        startedAt: this.now().toISOString(),
        finishedAt: null,
        error: null,
        nextAttemptAt: null,
      });

      await this.persist(run);
      await this.deps.audit({
        action: "scheduler.run_started",
        jobId: job.id,
        runId: run.runId,
        outcome: "allowed",
        detail: { attempt, idempotencyKey, trigger: job.trigger.kind, objective: job.objective },
      });

      try {
        const outcome = await withTimeout(
          job.timeoutMs,
          () => this.deps.execute(job, run, controller.signal),
          `job ${job.name}`,
        );

        this.succeededKeys.add(idempotencyKey);
        run = {
          ...run,
          status: "succeeded",
          sessionId: outcome.sessionId,
          finishedAt: this.now().toISOString(),
        };
        await this.persist(run);
        await this.deps.audit({
          action: "scheduler.run_succeeded",
          jobId: job.id,
          runId: run.runId,
          outcome: "allowed",
          detail: { attempt, sessionId: outcome.sessionId, summary: outcome.summary.slice(0, 400) },
        });
        return run;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const cancelled = controller.signal.aborted;
        const timedOut = error instanceof TimeoutError;
        const retryable = !cancelled && attempt < job.retry.maxAttempts;

        run = {
          ...run,
          status: cancelled ? "cancelled" : timedOut ? "timed_out" : "failed",
          finishedAt: this.now().toISOString(),
          error: message,
          nextAttemptAt: retryable
            ? new Date(this.now().getTime() + backoffMs(job.retry, attempt)).toISOString()
            : null,
        };
        await this.persist(run);
        await this.deps.audit({
          action: retryable ? "scheduler.run_retry_scheduled" : "scheduler.run_failed",
          jobId: job.id,
          runId: run.runId,
          outcome: "failed",
          detail: { attempt, error: message, nextAttemptAt: run.nextAttemptAt, timedOut },
        });
        this.deps.logger.warn("scheduled run did not succeed", {
          jobId: job.id,
          runId: run.runId,
          attempt,
          status: run.status,
        });
        return run;
      } finally {
        this.controllers.delete(job.id);
      }
    });

    return settled ?? null;
  }

  private async persist(run: JobRun): Promise<void> {
    await this.deps.store.appendRun(run);
    this.deps.publish(run);
  }

  private async hydrate(): Promise<void> {
    for (const run of await this.deps.store.listRuns(undefined, 1_000)) {
      if (run.status === "succeeded") this.succeededKeys.add(run.idempotencyKey);
    }
  }

  /**
   * A run left "running" by a crash is failed rather than resumed.
   *
   * The agent may already have had an external effect, and no durable record
   * says how far it got, so re-running it unattended is the unsafe direction.
   * It is left failed with `nextAttemptAt` null, awaiting a human.
   */
  private async reconcileInterruptedRuns(): Promise<void> {
    for (const run of await this.deps.store.listRuns(undefined, 1_000)) {
      if (run.status !== "running") continue;
      await this.persist({
        ...run,
        status: "failed",
        finishedAt: this.now().toISOString(),
        error: "interrupted by shutdown; not resumed automatically",
        nextAttemptAt: null,
      });
      await this.deps.audit({
        action: "scheduler.run_interrupted",
        jobId: run.jobId,
        runId: run.runId,
        outcome: "failed",
        detail: { idempotencyKey: run.idempotencyKey, attempt: run.attempt },
      });
    }
  }
}

/** Exponential backoff with full jitter, capped by the job's policy. */
export function backoffMs(policy: RetryPolicy, attempt: number): number {
  const raw = policy.backoffMs * policy.backoffFactor ** Math.max(0, attempt - 1);
  return Math.floor(Math.random() * Math.min(raw, policy.maxBackoffMs));
}

/** Validate a cron expression without scheduling anything. */
export function validateCron(expression: string, timezone?: string): string | null {
  try {
    CronExpressionParser.parse(expression, { tz: timezone });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
