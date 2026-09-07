import { z } from "zod";

/**
 * Project navigator contracts.
 *
 * Paths crossing this boundary are always project-relative and
 * forward-slashed: the renderer never sees a native absolute path, and the
 * privileged process never trusts one it is handed.
 */

export const ProjectEntry = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(["file", "directory"]),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string().datetime(),
});
export type ProjectEntry = z.infer<typeof ProjectEntry>;

export const ProjectListing = z.object({
  /** Absolute root, shown to the user so the boundary is unambiguous. */
  root: z.string(),
  /** Directory that was listed, project-relative; "" is the root itself. */
  path: z.string(),
  entries: z.array(ProjectEntry),
  truncated: z.boolean(),
});
export type ProjectListing = z.infer<typeof ProjectListing>;

/**
 * A named project: a directory plus everything bound to it.
 *
 * Project is the unit of scoping. Sessions, artifacts, skills, MCP
 * connections, the knowledge index and memories are all scoped by it, every
 * agent action names it, and audit records carry it. Chat may run without one;
 * Co-create requires one.
 */
export const ProjectRecord = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  /** Absolute directory. Shown to the user so the boundary is unambiguous. */
  directory: z.string(),
  createdAt: z.string().datetime(),
  lastOpenedAt: z.string().datetime(),
});
export type ProjectRecord = z.infer<typeof ProjectRecord>;

export const ProjectFile = z.object({
  path: z.string(),
  /**
   * How the canvas should render this. The privileged side decides, from the
   * bytes and the extension, rather than the renderer guessing from a name.
   */
  kind: z.enum(["text", "image"]).default("text"),
  text: z.string().default(""),
  /** Populated for `image` only, as a `data:` URL the canvas can show inline. */
  dataUrl: z.string().default(""),
  /** True when the file was cut off at the preview cap. */
  truncated: z.boolean(),
});
export type ProjectFile = z.infer<typeof ProjectFile>;
