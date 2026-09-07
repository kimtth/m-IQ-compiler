import itConsulting from "./primers/it-consulting-industry.md?raw";
import software from "./primers/software-industry.md?raw";

/**
 * The bundled industry primers.
 *
 * IQ Industry is a reading surface, so the set it reads is fixed and shipped
 * with the app rather than pointed at a directory. Three reasons, in order:
 *
 *  1. **It is not the knowledge vault.** The vault is the user's corpus —
 *     whatever they put in it, indexed and searched to answer questions about
 *     *their* work. These are reference material about an industry, written to
 *     be read start to finish, and mixing the two would make "what is in my
 *     vault?" unanswerable.
 *  2. **A viewer that can be pointed anywhere is a file browser.** The product
 *     already has one of those, in the project navigator, and it is governed:
 *     it names what the agent may read. This surface reads nothing from disk at
 *     all, so it needs no permission, works signed out and cannot be aimed at
 *     something it should not see.
 *  3. **Determinism.** The primers are also published into the IQ Cell library
 *     and drawn on My IQ, and both of those depend on the set being
 *     the same on every machine and every launch.
 *
 * Imported with Vite's `?raw` so the markdown is the source of truth: the files
 * under `primers/` are the documents, unedited, in the form their author wrote
 * them. Nothing here restates their content.
 */

export interface IndustryPrimer {
  /** Stable id. Also the file stem, and what an IQ Cell records as its source. */
  readonly id: string;
  readonly title: string;
  /** The `category` frontmatter field, used to group the list. */
  readonly category: string;
  /** One line, taken from the primer's own abstract callout. */
  readonly summary: string;
  readonly markdown: string;
}

/**
 * Read the frontmatter fields the list needs.
 *
 * Parsed rather than restated in a table here, because a table beside a
 * document is a second copy of the same fact and the two drift. Only the
 * scalar fields are read: the block lists (`aliases`, `tags`) are rendered
 * from the document itself.
 */
const frontMatterField = (markdown: string, field: string): string => {
  const match = new RegExp(`^${field}:\\s*(.*)$`, "m").exec(frontMatter(markdown));
  const value = match?.[1]?.trim() ?? "";
  return value.replace(/^["']|["']$/g, "");
};

/** The frontmatter block, or "" when the document carries none. */
export const frontMatter = (markdown: string): string =>
  /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? "";

/** The document with its frontmatter removed, which is what gets rendered. */
export const withoutFrontMatter = (markdown: string): string =>
  markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

/**
 * The abstract callout's body, which every primer opens with.
 *
 * Used as the list summary. Falling back to the first paragraph would be
 * plausible and wrong: these documents open with a heading and a callout, so
 * "the first paragraph" is either the title or the abstract depending on the
 * file, and a list where half the rows summarise and half repeat their own
 * title reads as broken.
 */
const abstractOf = (markdown: string): string => {
  const lines = withoutFrontMatter(markdown).split(/\r?\n/);
  const start = lines.findIndex((line) => /^>\s*\[!/.test(line));
  if (start === -1) return "";
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(">")) break;
    body.push(line.replace(/^>\s?/, "").trim());
  }
  return body.join(" ").trim();
};

const primer = (id: string, markdown: string): IndustryPrimer => ({
  id,
  title: frontMatterField(markdown, "title") || id,
  category: frontMatterField(markdown, "category") || "Uncategorised",
  summary: abstractOf(markdown),
  markdown,
});

/**
 * Ordered from the software product domain to the services that help
 * organizations adopt and operate it.
 */
export const INDUSTRY_PRIMERS: readonly IndustryPrimer[] = [
  primer("software-industry", software),
  primer("it-consulting-industry", itConsulting),
];

export const primerById = (id: string): IndustryPrimer | null =>
  INDUSTRY_PRIMERS.find((entry) => entry.id === id) ?? null;

/**
 * Resolve an Obsidian wikilink target against the bundled set.
 *
 * Most targets will not resolve. The primers were written inside a much larger
 * vault and link freely into `Topics/…` notes that are not part of this set, so
 * an unresolved link is the ordinary case rather than an error — and the viewer
 * says so rather than offering a link that goes nowhere. This mirrors how the
 * knowledge graph reports a `missing` node.
 */
export const resolveWikilink = (target: string): IndustryPrimer | null => {
  const stem = target.split(/[\\/]/).pop()?.trim().toLowerCase() ?? "";
  if (stem === "") return null;
  return (
    INDUSTRY_PRIMERS.find(
      (entry) => entry.id.toLowerCase() === stem || entry.title.toLowerCase() === stem,
    ) ?? null
  );
};
