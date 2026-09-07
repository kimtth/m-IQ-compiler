/**
 * Ingest: raw source files in, Obsidian notes out.
 *
 * A knowledge graph is a consequence of Markdown. That leaves a gap nobody had
 * filled: what someone actually has is a folder of reports, spreadsheets and
 * half-written notes, and pointing the indexer straight at those produces a
 * graph of isolated dots, because none of them link to each other. The missing
 * step is the one Obsidian users do by hand — write the note, give it tags,
 * link it to its neighbours.
 *
 * So the vault has two halves:
 *
 *   <vault>/source/   the raw files, exactly as they arrived. Never indexed.
 *   <vault>/          the generated notes, and only things the graph is made of.
 *
 * Everything here is a pure function of the sources, so the link grammar can be
 * tested without touching a disk, and re-ingesting the same folder produces the
 * same vault.
 *
 * Links are found two ways, and both are conservative. Links a source already
 * wrote are kept when they land on something that was ingested. Beyond that, a
 * note links to another when it *names* it: the other note's title appears in
 * its text. That is a real relation and a defensible one — a report naming a
 * supplier is about that supplier — and it is the only kind that can be found
 * without a model reading every file and guessing.
 */

/** One raw file under `source/`. */
export interface SourceFile {
  /** Path relative to the source directory, POSIX separators. */
  readonly path: string;
  readonly text: string;
  readonly bytes: number;
  readonly updatedAt: string;
}

/** One note to write into the vault root. */
export interface GeneratedNote {
  /** Vault-relative POSIX path. */
  readonly path: string;
  readonly text: string;
  /** The source it was generated from, for the audit trail. */
  readonly source: string;
}

/** The directory raw sources live in, relative to the vault root. */
export const SOURCE_DIR = "source";

/**
 * Written into every generated note's frontmatter.
 *
 * Re-ingesting has to be able to remove the note for a source that has since
 * been deleted, and it must never touch a note somebody wrote themselves. The
 * marker is how those two are told apart: no marker, not ours, left alone.
 */
export const GENERATED_BY = "iq-compiler-ingest";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const FIRST_HEADING = /^#{1,6}\s+(.{1,200})$/m;
const WIKI_LINK = /\[\[([^\]|#]{1,200})(?:[#|][^\]]{0,200})?\]\]/g;
const MARKDOWN_LINK = /\[[^\]]{0,200}\]\(([^)\s]{1,300})\)/g;

/** Extensions read as prose. Anything else is quoted rather than interpreted. */
const PROSE = new Set([".md", ".markdown", ".mdx", ".txt"]);

/** How many source lines a non-prose note quotes. Enough to be recognisable. */
const QUOTED_LINES = 40;
const ABSTRACT_CHARS = 240;
/** Ceiling on derived links per note, so a long report is not joined to all. */
const MAX_DERIVED = 8;
/** Titles shorter than this match too much prose to mean anything. */
const MIN_TITLE_CHARS = 4;

const extensionOf = (path: string): string => {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
};

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const stripFrontmatter = (text: string): string => text.replace(FRONTMATTER, "");

const frontmatterValue = (text: string, key: string): string | null => {
  const block = FRONTMATTER.exec(text)?.[1];
  if (!block) return null;
  const line = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(block)?.[1]?.trim();
  return line ? line.replace(/^["']|["']$/g, "") : null;
};

/** Turn `q3-warranty_review.csv` into `Q3 warranty review`. */
const humanise = (name: string): string => {
  const base = name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (base === "") return "Untitled";
  return base.charAt(0).toUpperCase() + base.slice(1);
};

const titleOf = (source: SourceFile): string => {
  const declared = frontmatterValue(source.text, "title");
  if (declared) return declared.slice(0, 120);
  const heading = FIRST_HEADING.exec(stripFrontmatter(source.text))?.[1]?.trim();
  if (heading) return heading.slice(0, 120);
  return humanise(source.path.split("/").pop() ?? source.path).slice(0, 120);
};

/** The folders a source sits in become its tags: that is what they mean. */
const tagsOf = (source: SourceFile): string[] => {
  const folders = source.path.split("/").slice(0, -1).map(slug).filter(Boolean);
  const extension = extensionOf(source.path).replace(".", "");
  const kind = PROSE.has(extensionOf(source.path)) ? "note" : (slug(extension) || "file");
  return [...new Set(["ingested", kind, ...folders])].filter((tag) => /^[a-z][\w/-]*$/.test(tag));
};

const categoryOf = (source: SourceFile): string => {
  const folder = source.path.split("/").slice(0, -1)[0];
  return folder ? humanise(folder) : "Ingested";
};

/** The first line that reads like a sentence rather than markup. */
const abstractOf = (source: SourceFile, body: string): string => {
  if (!PROSE.has(extensionOf(source.path))) {
    const rows = source.text.split(/\r?\n/).filter((line) => line.trim() !== "").length;
    return `Ingested from \`${SOURCE_DIR}/${source.path}\` — ${rows} non-empty ${
      rows === 1 ? "line" : "lines"
    }, quoted below rather than interpreted.`;
  }
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || /^[#>\-*|`]/.test(trimmed)) continue;
    return trimmed.length > ABSTRACT_CHARS ? `${trimmed.slice(0, ABSTRACT_CHARS)}…` : trimmed;
  }
  return `Ingested from \`${SOURCE_DIR}/${source.path}\`.`;
};

/** Prose is carried through; anything else is quoted, never reinterpreted. */
const bodyOf = (source: SourceFile): { heading: string; text: string } => {
  if (PROSE.has(extensionOf(source.path))) {
    return { heading: "Source text", text: stripFrontmatter(source.text).trim() };
  }
  const lines = source.text.split(/\r?\n/);
  const shown = lines.slice(0, QUOTED_LINES).join("\n");
  const fence = extensionOf(source.path).replace(".", "") || "text";
  return {
    heading: "Source extract",
    text:
      "```" +
      fence +
      "\n" +
      shown +
      "\n```" +
      (lines.length > QUOTED_LINES
        ? `\n\n${lines.length - QUOTED_LINES} further lines are in the source file.`
        : ""),
  };
};

/** Links the source already wrote, as written. */
const declaredLinks = (source: SourceFile): string[] => {
  if (!PROSE.has(extensionOf(source.path))) return [];
  const body = stripFrontmatter(source.text);
  const out = new Set<string>();
  for (const match of body.matchAll(WIKI_LINK)) {
    const target = match[1]?.trim();
    if (target) out.add(target);
  }
  for (const match of body.matchAll(MARKDOWN_LINK)) {
    const target = match[1]?.trim();
    if (target && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("#")) out.add(target);
  }
  return [...out];
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Draft {
  source: SourceFile;
  title: string;
  path: string;
  tags: string[];
  category: string;
}

/**
 * Build the vault.
 *
 * Two passes, because a note cannot be linked to something that has not been
 * named yet: the first decides what every note is called, the second finds the
 * ones that mention each other.
 */
export function generateNotes(sources: readonly SourceFile[]): GeneratedNote[] {
  const drafts: Draft[] = [];
  const takenPaths = new Set<string>();
  const takenTitles = new Set<string>();

  for (const source of [...sources].sort((a, b) => a.path.localeCompare(b.path))) {
    let title = titleOf(source);
    // Two sources can carry the same heading. Titles are how links resolve, so
    // an ambiguous one resolves to nothing at all — worth disambiguating.
    if (takenTitles.has(title.toLowerCase())) {
      title = `${title} (${source.path.split("/").slice(0, -1).join("/") || "root"})`;
    }
    takenTitles.add(title.toLowerCase());

    const folder = source.path.split("/").slice(0, -1).join("/");
    let path = `${folder ? `${folder}/` : ""}${slug(title) || "note"}.md`;
    for (let n = 2; takenPaths.has(path); n += 1) {
      path = `${folder ? `${folder}/` : ""}${slug(title) || "note"}-${n}.md`;
    }
    takenPaths.add(path);

    drafts.push({
      source,
      title,
      path,
      tags: tagsOf(source),
      category: categoryOf(source),
    });
  }

  // Resolve a written link target the way the indexer would: by title, by
  // source path, or by file name.
  const byKey = new Map<string, Draft>();
  for (const draft of drafts) {
    for (const key of [
      draft.title,
      draft.source.path,
      draft.source.path.replace(/\.[^./]+$/, ""),
      draft.source.path.split("/").pop() ?? "",
    ]) {
      const normalized = key.trim().toLowerCase();
      if (normalized) byKey.set(normalized, draft);
    }
  }

  const searchable = drafts.filter((draft) => draft.title.length >= MIN_TITLE_CHARS);

  return drafts.map((draft) => {
    const connected: string[] = [];
    const seen = new Set<string>([draft.title.toLowerCase()]);
    const add = (title: string): void => {
      if (seen.has(title.toLowerCase())) return;
      seen.add(title.toLowerCase());
      connected.push(title);
    };

    for (const target of declaredLinks(draft.source)) {
      const cleaned = target.replace(/^\.\//, "").split("#")[0]?.trim().toLowerCase() ?? "";
      const found =
        byKey.get(cleaned) ??
        byKey.get(cleaned.replace(/\.[^./]+$/, "")) ??
        byKey.get(cleaned.split("/").pop() ?? "");
      if (found) add(found.title);
    }

    // Then the ones this note names. Ordered by where the mention appears, so
    // the list reads like the note does.
    const haystack = stripFrontmatter(draft.source.text);
    const mentions: Array<{ at: number; title: string }> = [];
    for (const other of searchable) {
      if (other === draft) continue;
      const at = haystack.search(new RegExp(`\\b${escapeRegExp(other.title)}\\b`, "i"));
      if (at >= 0) mentions.push({ at, title: other.title });
    }
    for (const mention of mentions.sort((a, b) => a.at - b.at || a.title.localeCompare(b.title))) {
      if (connected.length >= MAX_DERIVED) break;
      add(mention.title);
    }

    return {
      path: draft.path,
      source: draft.source.path,
      text: render(draft, connected),
    };
  });
}

function render(draft: Draft, connected: readonly string[]): string {
  const body = bodyOf(draft.source);
  const abstract = abstractOf(draft.source, stripFrontmatter(draft.source.text));

  return [
    "---",
    `generated_by: ${GENERATED_BY}`,
    `source: "${SOURCE_DIR}/${draft.source.path}"`,
    `title: "${draft.title.replace(/"/g, "'")}"`,
    "tags:",
    ...draft.tags.map((tag) => `  - ${tag}`),
    `category: "${draft.category.replace(/"/g, "'")}"`,
    "---",
    "",
    `# ${draft.title}`,
    "",
    "> [!abstract] Ingested note",
    `> ${abstract.replace(/\n/g, " ")}`,
    "",
    "## Connected concepts",
    "",
    ...(connected.length > 0
      ? connected.map((title) => `- [[${title}]]`)
      : [
          "_Nothing else in the vault names this, and it names nothing else. Add a link by hand, " +
            "or ingest the files it belongs with._",
        ]),
    "",
    "---",
    "",
    `## ${body.heading}`,
    "",
    body.text,
    "",
  ].join("\n");
}

/** True for a note this module wrote, and therefore safe for it to replace. */
export const isGeneratedNote = (text: string): boolean =>
  frontmatterValue(text, "generated_by") === GENERATED_BY;
