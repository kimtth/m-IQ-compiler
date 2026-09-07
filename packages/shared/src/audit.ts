import { z } from "zod";

/**
 * Append-only audit record.
 *
 * Every actor action and every agent side effect terminates in an audit record,
 * so that "who caused this Graph write" is always answerable.
 *
 * Records deliberately carry resource identifiers but never tokens or raw
 * links.
 */

export const AuditActor = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    /** Entra object id. Never the raw UPN, which is stored separately. */
    oid: z.string(),
    tenantId: z.string(),
  }),
  z.object({ kind: z.literal("agent"), sessionId: z.string(), turnId: z.string() }),
  z.object({ kind: z.literal("scheduler"), jobId: z.string(), runId: z.string() }),
  z.object({ kind: z.literal("system") }),
]);
export type AuditActor = z.infer<typeof AuditActor>;

export const AuditRecord = z.object({
  id: z.string(),
  at: z.string().datetime(),
  actor: AuditActor,
  /** Dotted action name, e.g. "m365.mail.send", "skill.approve", "auth.consent". */
  action: z.string(),
  /** Tool family or subsystem. */
  family: z.string(),
  outcome: z.enum(["allowed", "denied", "succeeded", "failed"]),
  /** Ties together every record produced by one user request. */
  correlationId: z.string(),
  /** Entra scopes actually used, for least-privilege review. */
  scopes: z.array(z.string()).default([]),
  resources: z.array(z.string()).default([]),
  /** Why a decision was made; required for every deny. */
  reason: z.string().default(""),
});
export type AuditRecord = z.infer<typeof AuditRecord>;
