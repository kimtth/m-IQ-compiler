import { GraphEdge, GraphNode, type GraphEdgeKind, type KnowledgeGraph } from "@iq/shared";
import { parse as parseYaml } from "yaml";

/**
 * Artifact parsing and graph construction.
 *
 * Kept free of I/O so the link grammar and the resolution rules can be tested
 * directly. `KnowledgeGraphService` supplies the artifacts; everything here is
 * a pure function of them.
 */

export const GRAPH_VERSION = 1;

/** Wiki-link: `[[target]]` or `[[target|label]]`. */
const WIKI_LINK = /\[\[([^\]|#]{1,200})(?:[#|][^\]]{0,200})?\]\]/g;
/** Markdown link with a relative target; absolute URLs are ignored. */
const MARKDOWN_LINK = /\[[^\]]{0,200}\]\(([^)\s]{1,300})\)/g;
/** `#tag`, excluding Markdown headings (which are `#` followed by a space). */
const TAG = /(?:^|[\s(,;])#([A-Za-z][\w/-]{0,60})/g;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const FIRST_HEADING = /^#{1,6}\s+(.{1,200})$/m;

export const EXCERPT_LENGTH = 400;

/** One artifact handed to the indexer. */
export interface Artifact {
  kind: "document" | "skill";
  /** Project-relative path (documents) or skill name (skills). */
  path: string;
  title?: string;
  text: string;
  sizeBytes: number;
  updatedAt: string;
  /** Tags known before parsing, e.g. a skill's declared tools. */
  tags?: string[];
}

export interface ParsedArtifact {
  title: string;
  tags: string[];
  /** Link targets exactly as written, before resolution. */
  links: string[];
  /** Alternative names the note may be linked by, from frontmatter `aliases`. */
  aliases: string[];
  excerpt: string;
}

export const nodeId = (kind: string, key: string): string => `${kind}:${key}`;

/** Strip a YAML frontmatter block so its keys are not mistaken for content. */
export function stripFrontmatter(text: string): string {
  return text.replace(FRONTMATTER, "");
}

export function parseArtifact(artifact: Artifact): ParsedArtifact {
  // A canvas is JSON, so the Markdown grammar cannot be run over it directly.
  // It is flattened first into the prose it contains plus the files it points
  // at, after which it is indexed exactly like a note.
  const canvas = isCanvas(artifact.path) ? readCanvas(artifact.text) : null;
  const body = canvas ? canvas.text : stripFrontmatter(artifact.text);
  const frontmatter = canvas ? EMPTY_FRONTMATTER : parseFrontmatter(artifact.text);

  const links = new Set<string>(canvas?.files ?? []);
  for (const match of body.matchAll(WIKI_LINK)) {
    const target = match[1]?.trim();
    if (target) links.add(target);
  }
  for (const match of body.matchAll(MARKDOWN_LINK)) {
    const target = match[1]?.trim();
    // Only intra-project links form graph edges; an external URL belongs to
    // the browser pane, not the graph.
    if (target && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("#")) {
      links.add(target);
    }
  }

  const tags = new Set([...(artifact.tags ?? []), ...frontmatter.tags]);
  for (const match of body.matchAll(TAG)) {
    const tag = match[1]?.toLowerCase();
    if (tag) tags.add(tag);
  }

  const heading = FIRST_HEADING.exec(body)?.[1]?.trim();
  const title = artifact.title ?? heading ?? basename(artifact.path);

  return {
    title,
    tags: [...tags].sort(),
    links: [...links],
    aliases: frontmatter.aliases,
    excerpt: excerptOf(body),
  };
}

interface Frontmatter {
  tags: string[];
  aliases: string[];
}

const EMPTY_FRONTMATTER: Frontmatter = { tags: [], aliases: [] };

/**
 * Read the two frontmatter properties the graph cares about.
 *
 * Obsidian treats `tags` and `aliases` in frontmatter as first-class: a tag
 * declared there is as real as an inline `#tag`, and an alias is a name the
 * note can be linked by. Ignoring them meant a note whose tags were declared
 * properly appeared untagged, and a `[[link]]` written to an alias resolved to
 * nothing. Malformed YAML is skipped rather than thrown, so one bad note cannot
 * break an index.
 */
function parseFrontmatter(text: string): Frontmatter {
  const raw = FRONTMATTER.exec(text)?.[1];
  if (!raw) return EMPTY_FRONTMATTER;

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch {
    return EMPTY_FRONTMATTER;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return EMPTY_FRONTMATTER;

  const record = data as Record<string, unknown>;
  const tags = stringList(record.tags ?? record.tag)
    .map((tag) => tag.replace(/^#/, "").toLowerCase())
    .filter((tag) => /^[A-Za-z][\w/-]*$/.test(tag));
  const aliases = stringList(record.aliases ?? record.alias);
  return { tags, aliases };
}

/** Accept both YAML shapes Obsidian allows: a list, or one comma-separated scalar. */
function stringList(value: unknown): string[] {
  const items =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
  return items.map((item) => item.trim()).filter((item) => item.length > 0 && item.length <= 200);
}

function isCanvas(path: string): boolean {
  return path.toLowerCase().endsWith(".canvas");
}

interface CanvasContent {
  /** Prose the canvas carries, so tags and wikilinks inside it still count. */
  text: string;
  /** Paths referenced by `file` nodes and group backgrounds. */
  files: string[];
}

/**
 * Flatten a JSON Canvas file (<https://jsoncanvas.org/spec/1.0/>).
 *
 * A canvas is how a user expresses structure the prose does not, so its `file`
 * nodes are real edges. Anything that is not valid canvas JSON returns null and
 * the file is indexed as plain text instead.
 */
function readCanvas(source: string): CanvasContent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const nodes = (parsed as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return null;

  const text: string[] = [];
  const files: string[] = [];

  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    for (const key of ["text", "label"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) text.push(value);
    }
    for (const key of ["file", "background"]) {
      const value = record[key];
      // The subpath after `#` addresses a heading inside the target, not
      // another file, and the resolver strips it anyway.
      if (typeof value === "string" && value.trim()) files.push(value.split("#")[0]?.trim() ?? "");
    }
  }

  return { text: text.join("\n\n"), files: files.filter(Boolean) };
}

function excerptOf(body: string): string {
  const flat = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH)}…` : flat;
}

function basename(path: string): string {
  const last = path.split("/").pop() ?? path;
  return last.replace(/\.[^.]+$/, "");
}

export interface BuildInput {
  artifacts: readonly Artifact[];
  truncated?: boolean;
  skipped?: Record<string, number>;
  now?: () => Date;
}

/**
 * Build the graph.
 *
 * Link resolution is deliberately forgiving, because a note written by hand
 * rarely spells a path exactly: a target matches by full relative path, by path
 * without extension, by file name, or by title. A target that still does not
 * resolve becomes a `missing` node rather than being dropped, so the UI can
 * show the same unresolved links an Obsidian-style graph would.
 */
export function buildGraph(input: BuildInput): KnowledgeGraph {
  const now = input.now ?? (() => new Date());
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  /** Alias -> node id. An ambiguous alias is dropped rather than guessed at. */
  const alias = new Map<string, string | null>();

  const addAlias = (key: string, id: string): void => {
    const normalized = key.trim().toLowerCase();
    if (!normalized) return;
    const existing = alias.get(normalized);
    if (existing === undefined) alias.set(normalized, id);
    else if (existing !== id) alias.set(normalized, null);
  };

  const parsed = new Map<string, ParsedArtifact>();

  for (const artifact of input.artifacts) {
    const id = nodeId(artifact.kind, artifact.path);
    if (nodes.has(id)) continue;
    const details = parseArtifact(artifact);
    parsed.set(id, details);

    nodes.set(
      id,
      GraphNode.parse({
        id,
        kind: artifact.kind,
        title: details.title,
        path: artifact.path,
        tags: details.tags,
        excerpt: details.excerpt,
        sizeBytes: artifact.sizeBytes,
        updatedAt: artifact.updatedAt,
      }),
    );

    addAlias(artifact.path, id);
    addAlias(artifact.path.replace(/\.[^./]+$/, ""), id);
    addAlias(basename(artifact.path), id);
    addAlias(details.title, id);
    for (const alias of details.aliases) addAlias(alias, id);
  }

  const link = (from: string, to: string, kind: GraphEdgeKind): void => {
    if (from === to) return;
    const key = `${from}\u0000${to}\u0000${kind}`;
    const existing = edges.get(key);
    if (existing) existing.weight += 1;
    else edges.set(key, GraphEdge.parse({ from, to, kind, weight: 1 }));
  };

  for (const [id, details] of parsed) {
    for (const tag of details.tags) {
      const tagId = nodeId("tag", tag);
      if (!nodes.has(tagId)) {
        nodes.set(tagId, GraphNode.parse({ id: tagId, kind: "tag", title: `#${tag}` }));
      }
      link(id, tagId, "tagged");
    }

    for (const target of details.links) {
      const resolved = resolve(target, alias);
      if (resolved) {
        link(id, resolved, resolved.startsWith("skill:") ? "uses_skill" : "links");
        continue;
      }

      const missingId = nodeId("missing", target.toLowerCase());
      if (!nodes.has(missingId)) {
        nodes.set(missingId, GraphNode.parse({ id: missingId, kind: "missing", title: target }));
      }
      link(id, missingId, "links");
    }
  }

  for (const edge of edges.values()) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (from) from.degree += 1;
    if (to) to.degree += 1;
  }

  return {
    version: GRAPH_VERSION,
    builtAt: now().toISOString(),
    truncated: input.truncated ?? false,
    skipped: input.skipped ?? {},
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort(
      (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
    ),
  };
}

/** Resolve one written link target against the alias table. */
function resolve(target: string, alias: Map<string, string | null>): string | null {
  const cleaned = target.replace(/^\.\//, "").replace(/\\/g, "/").split("#")[0]?.trim() ?? "";
  if (!cleaned) return null;

  const withoutExtension = cleaned.replace(/\.[^./]+$/, "");
  const leaf = cleaned.split("/").pop() ?? cleaned;

  for (const candidate of [cleaned, withoutExtension, leaf, leaf.replace(/\.[^./]+$/, "")]) {
    const found = alias.get(candidate.toLowerCase());
    if (found) return found;
  }
  return null;
}
