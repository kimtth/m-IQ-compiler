import { z } from "zod";

/**
 * Agent Skills (https://agentskills.io) compliant skill descriptor.
 *
 * A skill is a directory containing a `SKILL.md` whose YAML frontmatter carries
 * the metadata below and whose Markdown body carries the procedure. Only `name`
 * and `description` are loaded into the system prompt at all times; the body and
 * bundled resources are read on demand. That progressive-disclosure rule is what
 * keeps a large skill library affordable in context.
 *
 * Enabled skills are injected into the agent system prompt and exposed by slash
 * autocomplete.
 */

/** Slug rule from the Agent Skills spec: lowercase letters, digits and hyphens. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const SkillFrontmatter = z.object({
  /** Unique slug, must match the containing directory name. */
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(SKILL_NAME_PATTERN, "skill name must be a lowercase hyphenated slug"),
  /**
   * The single most important field: it is the only text besides the name that
   * is always in context, so it must state both what the skill does and when to
   * use it.
   */
  description: z.string().min(1).max(1024),
  license: z.string().optional(),
  /**
   * Optional allow-list restricting which tool families the skill may use while
   * active. Enforced by PermissionPolicy, not merely advisory.
   */
  "allowed-tools": z.array(z.string()).optional(),
  /** Free-form namespaced metadata permitted by the spec. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatter>;

export const SkillOrigin = z.enum([
  /** Ships with the product, installed on first run. */
  "bundled",
  /** Authored by a person in this project. */
  "user",
  /** Authored by the agent and pending or past human review. */
  "agent",
]);
export type SkillOrigin = z.infer<typeof SkillOrigin>;

/**
 * Review state for agent-authored skills.
 *
 * The curator tracks agent-created skills so they can be reviewed, archived,
 * restored, pinned, backed up and rolled back. An agent-authored skill stays
 * unloadable until explicit human approval.
 */
export const SkillReviewState = z.enum([
  "draft",
  "pending_review",
  "approved",
  "archived",
]);
export type SkillReviewState = z.infer<typeof SkillReviewState>;

export const SkillRecord = z.object({
  name: z.string(),
  description: z.string(),
  origin: SkillOrigin,
  review: SkillReviewState,
  enabled: z.boolean(),
  /** Absolute path to the skill directory. */
  path: z.string(),
  allowedTools: z.array(z.string()),
  /** Files bundled alongside SKILL.md, relative to the skill directory. */
  resources: z.array(z.string()),
  version: z.number().int().positive(),
  updatedAt: z.string().datetime(),
});
export type SkillRecord = z.infer<typeof SkillRecord>;

/** A proposal to create or update a skill, derived from an approved memory. */
export const SkillProposal = z.object({
  name: z.string().regex(SKILL_NAME_PATTERN),
  description: z.string().min(1),
  body: z.string().min(1),
  allowedTools: z.array(z.string()).default([]),
  /** Session and turn that produced the proposal, for auditability. */
  sourceSessionId: z.string(),
  sourceTurnId: z.string(),
  rationale: z.string(),
});
export type SkillProposal = z.infer<typeof SkillProposal>;
