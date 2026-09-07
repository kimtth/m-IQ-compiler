import { z } from "zod";

/**
 * Scheduled work.
 *
 * Triggers cover manual, interval, cron-expression and one-shot jobs. The job
 * objective carries the natural-language instruction; the trigger only decides
 * when to create a run.
 *
 * Each run creates a *fresh* session with a job-scoped tool set. That keeps
 * scheduled work isolated from any prior interactive turn and leaves each run
 * with its own output and audit trail.
 */

export const Trigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("cron"), expression: z.string(), timezone: z.string().default("UTC") }),
  z.object({ kind: z.literal("interval"), everyMs: z.number().int().positive() }),
  z.object({ kind: z.literal("once"), at: z.string().datetime() }),
]);
export type Trigger = z.infer<typeof Trigger>;

/**
 * Retry policy. Scheduled work must be safe to retry, so every run carries an
 * idempotency key and the scheduler is single-flight per job. Retries are
 * fenced by operation identity rather than by timing alone.
 */
export const RetryPolicy = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(3),
  backoffMs: z.number().int().positive().default(30_000),
  backoffFactor: z.number().min(1).default(2),
  maxBackoffMs: z.number().int().positive().default(15 * 60_000),
});
export type RetryPolicy = z.infer<typeof RetryPolicy>;

export const ScheduledJob = z.object({
  id: z.string(),
  name: z.string().min(1),
  /** The objective handed to a fresh agent session on each run. */
  objective: z.string().min(1),
  trigger: Trigger,
  enabled: z.boolean().default(true),
  /** Tool families this job may use. Narrower than the interactive default. */
  toolFamilies: z.array(z.string()).default([]),
  /** Skills pre-activated for the run. */
  skills: z.array(z.string()).default([]),
  retry: RetryPolicy.default({}),
  /** Cap on wall-clock time before the run is failed and released. */
  timeoutMs: z.number().int().positive().default(10 * 60_000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ScheduledJob = z.infer<typeof ScheduledJob>;

export const JobRunStatus = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);
export type JobRunStatus = z.infer<typeof JobRunStatus>;

export const JobRun = z.object({
  runId: z.string(),
  jobId: z.string(),
  /** Stable across retries of the same logical occurrence; fences duplicates. */
  idempotencyKey: z.string(),
  attempt: z.number().int().min(1),
  status: JobRunStatus,
  sessionId: z.string().nullable(),
  scheduledFor: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
  /** Next attempt time when status is "failed" and attempts remain. */
  nextAttemptAt: z.string().datetime().nullable(),
});
export type JobRun = z.infer<typeof JobRun>;
