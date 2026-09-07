import { z } from "zod";

/**
 * Orchestration task graph.
 *
 * The orchestration store persists task DAGs and messages while a coordinator
 * promotes ready tasks and resolves convergence. Sub-agent spawning creates
 * standalone headless turns, so child sessions can run without sharing mutable
 * parent state.
 */

export const TaskStatus = z.enum([
  "blocked",
  "ready",
  "dispatched",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const OrchestrationTask = z.object({
  id: z.string(),
  planId: z.string(),
  title: z.string().min(1),
  /** Complete, self-contained instruction; sub-agents share no parent context. */
  instruction: z.string().min(1),
  status: TaskStatus,
  /** Task ids that must reach "succeeded" before this becomes "ready". */
  dependsOn: z.array(z.string()).default([]),
  toolFamilies: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  /** Session running this task once dispatched. */
  sessionId: z.string().nullable(),
  attempt: z.number().int().min(0).default(0),
  maxAttempts: z.number().int().min(1).default(2),
  result: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type OrchestrationTask = z.infer<typeof OrchestrationTask>;

/**
 * A decision gate pauses promotion of dependent tasks until a human resolves it.
 */
export const DecisionGate = z.object({
  id: z.string(),
  planId: z.string(),
  question: z.string(),
  /** Tasks held until this gate is resolved. */
  gatedTaskIds: z.array(z.string()),
  resolution: z.enum(["pending", "approved", "rejected"]).default("pending"),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.string().datetime().nullable(),
});
export type DecisionGate = z.infer<typeof DecisionGate>;

export const OrchestrationPlan = z.object({
  id: z.string(),
  objective: z.string(),
  /** Session that owns the plan; sub-agent sessions link back to it. */
  parentSessionId: z.string(),
  /** Turn that launched the plan, when it was delegated from a conversation. */
  parentTurnId: z.string().nullable().default(null),
  /** Upper bound on tasks dispatched concurrently. */
  maxParallel: z.number().int().min(1).max(16).default(4),
  status: z.enum(["running", "succeeded", "failed", "cancelled"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type OrchestrationPlan = z.infer<typeof OrchestrationPlan>;
