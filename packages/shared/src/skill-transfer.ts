import { z } from "zod";

/**
 * Skill import and export contracts.
 *
 * A skill is portable by design: the Agent Skills specification defines it as
 * a directory containing `SKILL.md`, so a directory *is* the interchange
 * format. Import and export therefore move directories rather than inventing a
 * container, which keeps a bundle produced here readable by any other
 * conforming runtime.
 *
 * Import is deliberately a two-step operation. Inspect first — the user sees
 * exactly what a skill declares, including which tool families it asks for —
 * and only then install. A skill is prompt-surface: it instructs the agent, so
 * accepting one sight-unseen would be equivalent to accepting an unreviewed
 * change to the system prompt.
 */

export const SkillImportPreview = z.object({
  /** Directory the user chose, echoed back so the source is unambiguous. */
  source: z.string(),
  name: z.string(),
  description: z.string(),
  /** Tool families the skill asks to use. Empty means it declares none. */
  allowedTools: z.array(z.string()),
  /** Files shipped alongside SKILL.md, relative to the skill directory. */
  resources: z.array(z.string()),
  /** First part of the procedure, so the user can judge what it will do. */
  bodyExcerpt: z.string(),
  /** True when a skill of this name is already installed and would be replaced. */
  conflicts: z.boolean(),
  /**
   * Reasons the bundle cannot be installed as-is. A non-empty list means
   * import is refused, not merely discouraged.
   */
  problems: z.array(z.string()),
});
export type SkillImportPreview = z.infer<typeof SkillImportPreview>;

export const SkillExportResult = z.object({
  name: z.string(),
  /** Absolute directory that was written. */
  destination: z.string(),
  files: z.array(z.string()),
});
export type SkillExportResult = z.infer<typeof SkillExportResult>;
