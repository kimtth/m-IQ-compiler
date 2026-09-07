import { z } from "zod";

/**
 * Persistent memory.
 *
 * Persistent memory stores durable facts about the user and their conventions
 * so they can be reused in later sessions. A memory is only ever *proposed* by
 * the agent, and approved memories are what the curator is allowed to compile
 * into skill proposals. Nothing derived from an unapproved memory can reach the
 * prompt surface, and the derived artefact is itself a proposal that needs its
 * own approval.
 */

/** Who the memory is about, which decides where it may be reused. */
export const MemoryScope = z.enum([
  /** A preference or fact about the signed-in person. */
  "user",
  /** A convention that holds for the whole local project. */
  "project",
]);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const MemoryStatus = z.enum([
  /** Captured by the agent, not yet seen by a human. Never used for derivation. */
  "pending",
  /** A human accepted it. Only these feed the curator. */
  "approved",
  /** A human refused it. Kept so the same claim is not re-proposed silently. */
  "rejected",
  /** Replaced by a newer memory on the same subject. */
  "superseded",
]);
export type MemoryStatus = z.infer<typeof MemoryStatus>;

/**
 * What kind of thing the memory is, which is what decides how it is recalled.
 *
 * The taxonomy is the usual one — factual, procedural, episodic, working — and
 * it is worth carrying because `subject` and `scope` do not answer it. Two
 * memories can share a subject and a scope and still be different kinds of
 * claim: "a change request is written `CR-####`" is a fact about the project's
 * vocabulary, while "quote the clause before ruling on it" is a step order.
 * The curator compiles those differently — a fact belongs in a skill's
 * background, a procedure belongs in its instructions — and an episode should
 * not be compiled into a standing rule at all, because it was true of one
 * week's data and is not a convention.
 *
 * **`working` is deliberately not a member.** Working memory is the bounded
 * conversation window, which this app builds per turn and never persists; a
 * `MemoryRecord` is by definition durable, so a value naming the one kind that
 * is never written down would be a state the store can hold and the store's
 * whole contract says it cannot. The window has no id, no approver and no
 * audit trail, and giving it a row here would imply all three.
 */
export const MemoryType = z.enum([
  /** A durable fact about the user, the project or an artifact. */
  "factual",
  /** How something is done here: an order of steps, a rule for producing work. */
  "procedural",
  /** Something that happened once. Kept only because a person explicitly said so. */
  "episodic",
]);
export type MemoryType = z.infer<typeof MemoryType>;

/** How each kind is said on a surface. */
export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  factual: "Factual",
  procedural: "Procedural",
  episodic: "Episodic",
};

/** Why the distinction matters, for the pill's title. */
export const MEMORY_TYPE_DETAIL: Record<MemoryType, string> = {
  factual: "A fact about you, this project or an artifact. Durable.",
  procedural: "How something is done here — an order of steps or a rule for producing work. Durable.",
  episodic:
    "Something that happened once, kept only because it was explicitly saved. Not a standing rule.",
};

/**
 * A single durable fact.
 *
 * `subject` is load-bearing: it is the grouping key the curator compiles on, so
 * memories that belong to the same procedure must share it.
 */
export const MemoryRecord = z.object({
  id: z.string(),
  /** 1-3 words naming the topic, e.g. "status reports", "mail triage". */
  subject: z.string().min(1).max(64),
  /** The fact itself, stated as a directive. Kept short so it stays quotable. */
  fact: z.string().min(1).max(400),
  /** Why it is worth keeping; shown to the approver. */
  rationale: z.string().default(""),
  /** Where the claim came from: file paths, or a quotation of the user. */
  citations: z.array(z.string()).default([]),
  scope: MemoryScope,
  status: MemoryStatus,
  /**
   * What kind of claim it is. Defaults to `factual` so records written before
   * this field existed still parse — an unclassified memory is a plain fact
   * until someone says otherwise, which is the reading that assumes least.
   */
  memoryType: MemoryType.default("factual"),
  /** Tool families the fact implies, carried into a derived skill's allow-list. */
  toolFamilies: z.array(z.string()).default([]),
  sourceSessionId: z.string(),
  sourceTurnId: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** Set when a human decided; identifies them by Entra object id only. */
  decidedBy: z.object({ oid: z.string(), tenantId: z.string() }).nullable().default(null),
  decidedAt: z.string().datetime().nullable().default(null),
  /** Name of the skill this memory has been compiled into, if any. */
  derivedSkill: z.string().nullable().default(null),
});
export type MemoryRecord = z.infer<typeof MemoryRecord>;

/** What the agent (or the UI) supplies when capturing a memory. */
export const MemoryInput = z.object({
  subject: z.string().min(1).max(64),
  fact: z.string().min(1).max(400),
  rationale: z.string().default(""),
  citations: z.array(z.string()).default([]),
  scope: MemoryScope.default("user"),
  memoryType: MemoryType.default("factual"),
  toolFamilies: z.array(z.string()).default([]),
  sourceSessionId: z.string(),
  sourceTurnId: z.string(),
});
export type MemoryInput = z.infer<typeof MemoryInput>;

/**
 * A human's edit to a memory already in the store.
 *
 * Only the three fields a person can meaningfully correct: what the memory is
 * about, what it says, and why it was kept. Everything else on the record is
 * provenance — who proposed it, from which turn, who decided it and when — and
 * a memory whose provenance could be edited would be a memory whose audit trail
 * means nothing.
 *
 * Editing is deliberately possible *after* approval. A convention that has
 * drifted is the normal case, and the alternative is forgetting the memory and
 * re-teaching it, which loses the history for a typo. What an edit does not do
 * is preserve an approval: see `MemoryStore.update`.
 */
export const MemoryEdit = z.object({
  id: z.string().min(1),
  subject: z.string().min(1).max(64),
  fact: z.string().min(1).max(400),
  rationale: z.string().max(1_000).default(""),
});
export type MemoryEdit = z.infer<typeof MemoryEdit>;

/**
 * Bookkeeping for one derivation group, keyed by the slug of its subject.
 *
 * `signature` is what makes automatic derivation idempotent: re-running the
 * curator over an unchanged set of approved memories must not produce a second
 * proposal, or every approval would spam the review queue.
 */
export const MemoryDerivation = z.object({
  slug: z.string(),
  subject: z.string(),
  skillName: z.string(),
  /** Stable digest of the memory ids and revisions that produced the proposal. */
  signature: z.string(),
  memoryIds: z.array(z.string()),
  derivedAt: z.string().datetime(),
  /** Bumped each time the same subject is recompiled from new memories. */
  revision: z.number().int().positive(),
});
export type MemoryDerivation = z.infer<typeof MemoryDerivation>;

/** Result of one curator pass, surfaced to the UI and the audit log. */
export const MemoryDerivationOutcome = z.object({
  slug: z.string(),
  skillName: z.string(),
  memoryIds: z.array(z.string()),
  revision: z.number().int().positive(),
  /** "created" the first time a subject compiles, "updated" afterwards. */
  change: z.enum(["created", "updated"]),
});
export type MemoryDerivationOutcome = z.infer<typeof MemoryDerivationOutcome>;
