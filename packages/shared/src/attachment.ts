import { z } from "zod";

/**
 * File references in a chat message.
 *
 * "Add File to Chat" used to drop a backticked path into the composer and stop
 * there. The path was decoration: the model was handed a string that looked
 * like a filename, in a turn that had never read it, and it either guessed or
 * spent a tool call and an approval card finding out. Attaching a file has to
 * mean the file is in the turn.
 *
 * The syntax is deliberately plain, because a person types it too:
 *
 *     file: reports/q4-summary.md
 *
 * One reference per line, the whole rest of the line is the path — paths have
 * spaces in them, and a token-delimited syntax would break on every one. The
 * line is the unit because that is what the composer inserts and what a reader
 * can see the shape of.
 *
 * Declared in `@iq/shared` so the renderer that writes the reference and the
 * privileged side that resolves it cannot drift: a syntax agreed in two places
 * is a syntax that silently stops matching.
 */

export const FILE_REFERENCE_PREFIX = "file:";

/** How a reference is written, so the composer never spells it by hand. */
export const fileReference = (path: string): string => `${FILE_REFERENCE_PREFIX} ${path}`;

/**
 * The path one line refers to, or null if the line is not a reference.
 *
 * The single place the syntax is decoded. Both readers below go through it, so
 * "which lines are references" and "which line is *this* reference" can never
 * answer differently — which is what a chip that refuses to delete itself
 * would look like.
 */
const referencedPath = (line: string): string | null => {
  const trimmed = line.trim();
  if (!trimmed.toLowerCase().startsWith(FILE_REFERENCE_PREFIX)) return null;
  const path = trimmed
    .slice(FILE_REFERENCE_PREFIX.length)
    .trim()
    .replace(/^[`"']|[`"']$/g, "");
  return path === "" ? null : path;
};

/**
 * Every path referenced in a message, in the order they appear.
 *
 * De-duplicated: referencing the same file twice is something people do, and
 * reading it twice would spend the context budget to say the same thing.
 * Nothing here validates the path — that is the privileged side's job, and it
 * has to re-do it whatever this returns.
 */
export const fileReferences = (content: string): string[] => {
  const found: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const path = referencedPath(line);
    if (path !== null && !found.includes(path)) found.push(path);
  }
  return found;
};

/**
 * The same message with every line referencing `path` taken out.
 *
 * The composer shows references as chips, and a chip has to be removable. The
 * removal has to agree with {@link fileReferences} exactly — a chip that
 * deletes the wrong line is worse than no chip — so it lives here beside the
 * parse instead of being written out again in the renderer.
 *
 * Every matching line goes, not just the first: the same file can be
 * referenced twice and the chip for it is one chip.
 */
export const withoutFileReference = (content: string, path: string): string =>
  content
    .split(/\r?\n/)
    .filter((line) => referencedPath(line) !== path)
    .join("\n");

/**
 * One resolved attachment, as it is recorded on the turn.
 *
 * `text` is not part of the durable record: the turn log is append-only and a
 * conversation that attached a 200-page document would carry a copy of it
 * forever, in a file the user cannot prune. What is recorded is *which* file
 * was attached and how much of it was read.
 */
export const MessageAttachment = z.object({
  /** Project-relative, always spelled with `/`. */
  path: z.string(),
  mime: z.string().default("text/plain"),
});
export type MessageAttachment = z.infer<typeof MessageAttachment>;

/** Per-file and total caps on what an attachment may add to one turn. */
export const MAX_ATTACHMENT_CHARS = 20_000;
export const MAX_ATTACHMENTS_TOTAL_CHARS = 60_000;
