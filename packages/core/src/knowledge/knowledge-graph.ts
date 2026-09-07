import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve as resolvePath, sep } from "node:path";
import type {
  GraphEdgeKind,
  GraphNode,
  KnowledgeGraph,
  KnowledgeHit,
  KnowledgeNodeDetail,
  KnowledgeSummary,
} from "@iq/shared";
import { readJson, writeJsonAtomic } from "../util/jsonl.js";
import { GRAPH_VERSION, buildGraph, nodeId, stripFrontmatter, type Artifact } from "./indexer.js";
import { SOURCE_DIR } from "./ingest.js";
import type { AppPaths } from "../config/paths.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { Logger } from "../util/logger.js";

/**
 * Knowledge graph over the vault.
 *
 * Corpus: the notes in the chosen vault directory, and nothing else. It used to
 * index installed Agent Skills alongside them, which put a `skill:` node in
 * every graph whether or not the vault had anything to do with it — a picture
 * of the vault with a handful of the app's own furniture scattered through it.
 * A skill is a procedure the agent loads, not a document the user curated, and
 * the two do not belong in one picture.
 *
 * The scan is bounded on every axis that a hostile or merely untidy directory
 * could blow up — file count, per-file size, directory depth — and it refuses
 * to follow anything that leaves the root it was given, because the project
 * is writable by the agent and a symlink is the obvious way to turn an indexer
 * into a file-exfiltration primitive.
 */

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".mdx",
  ".csv",
  ".json",
  ".yaml",
  ".yml",
  // Obsidian vault formats: a canvas is flattened to its prose and its file
  // references, a base is a saved query over note properties. Both are corpus,
  // not scratch output, so both are indexed.
  ".canvas",
  ".base",
]);
/** Indexed as nodes for their name and links from other notes, never read. */
const OPAQUE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx", ".pdf", ".msg", ".eml"]);

const MAX_FILES = 4_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_DEPTH = 8;
/** Cap on the body returned to a caller, so one note cannot flood a context. */
const MAX_CONTENT_CHARS = 20_000;

const EMPTY_GRAPH: KnowledgeGraph = {
  version: GRAPH_VERSION,
  builtAt: "",
  truncated: false,
  skipped: {},
  nodes: [],
  edges: [],
};

export interface KnowledgeGraphOptions {
  paths: AppPaths;
  audit: AuditLog;
  logger: Logger;
  /**
   * The corpus root, resolved per scan.
   *
   * A resolver rather than a fixed path so choosing a different vault re-points
   * the index without reconstructing the service. Defaults to the project
   * directory when omitted.
   */
  vaultDir?: () => string;
  publish?: (summary: KnowledgeSummary) => void;
}

export class KnowledgeGraphService {
  private graph: KnowledgeGraph = EMPTY_GRAPH;
  private loaded = false;
  /** Full text of the last scan, kept only in memory: the index is derivable. */
  private text = new Map<string, string>();
  /**
   * Whether *this process* has scanned, as opposed to having loaded a cache.
   *
   * Recorded explicitly because the obvious proxy is wrong. `ensureIndexed`
   * used to ask whether any text had been collected, which is false for an
   * empty vault however many times it has been scanned — so every read
   * rebuilt, every rebuild published `knowledge:changed`, the UI reloaded on
   * the event and read again. An empty vault span the app at full tilt and
   * filled the log with identical "knowledge graph rebuilt, nodes: 0" lines.
   */
  private indexedHere = false;
  private indexing: Promise<KnowledgeSummary> | null = null;

  constructor(private readonly options: KnowledgeGraphOptions) {}

  private get graphFile(): string {
    return join(this.options.paths.knowledge, "graph.json");
  }

  /**
   * The directory the graph is built from.
   *
   * The knowledge vault when one is chosen, otherwise the project. Resolved
   * per scan rather than captured, so changing the vault only needs a reindex.
   */
  corpusRoot(): string {
    return this.options.vaultDir?.() ?? this.options.paths.project;
  }

  /** The current graph, loading the persisted one on first use. */
  async current(): Promise<KnowledgeGraph> {
    if (this.loaded) return this.graph;
    const stored = await readJson<KnowledgeGraph | null>(this.graphFile, null);
    // A graph written by an older indexer is discarded rather than migrated:
    // it is a cache, and rebuilding it is cheap.
    this.graph = stored && stored.version === GRAPH_VERSION ? stored : EMPTY_GRAPH;
    this.loaded = true;
    return this.graph;
  }

  summary(graph: KnowledgeGraph = this.graph): KnowledgeSummary {
    const count = (kind: string): number =>
      graph.nodes.filter((node) => node.kind === kind).length;
    return {
      builtAt: graph.builtAt,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      documents: count("document"),
      skills: count("skill"),
      tags: count("tag"),
      unresolvedLinks: count("missing"),
      truncated: graph.truncated,
    };
  }

  /**
   * Rebuild the graph from disk.
   *
   * Concurrent callers share one scan: the UI's reindex button, a tool call and
   * startup can all land at once, and running the walk three times over the same
   * directory would only produce the same answer more slowly.
   */
  async reindex(correlationId: string): Promise<KnowledgeSummary> {
    if (this.indexing) return this.indexing;
    this.indexing = this.runIndex(correlationId).finally(() => {
      this.indexing = null;
    });
    return this.indexing;
  }

  /** Index once per process, so search has text to work with. */
  async ensureIndexed(correlationId: string): Promise<KnowledgeGraph> {
    const graph = await this.current();
    if (this.indexedHere) return graph;
    await this.reindex(correlationId);
    return this.graph;
  }

  private async runIndex(correlationId: string): Promise<KnowledgeSummary> {
    const started = Date.now();
    const skipped: Record<string, number> = {};
    const note = (reason: string): void => {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
    };

    const artifacts: Artifact[] = [];
    const text = new Map<string, string>();

    const vault = await this.scanRoot(this.corpusRoot(), note, MAX_FILES);
    for (const entry of vault.artifacts) {
      artifacts.push(entry.artifact);
      text.set(nodeId("document", entry.artifact.path), entry.text);
    }

    const graph = buildGraph({
      artifacts,
      truncated: vault.truncated,
      skipped,
    });

    await writeJsonAtomic(this.graphFile, graph);
    this.graph = graph;
    this.text = text;
    this.loaded = true;
    this.indexedHere = true;

    const summary = this.summary(graph);
    this.options.logger.info("knowledge graph rebuilt", {
      nodes: summary.nodes,
      edges: summary.edges,
      ms: Date.now() - started,
    });

    await this.options.audit.record({
      actor: { kind: "system" },
      action: "knowledge.reindex",
      family: "knowledge",
      outcome: "succeeded",
      correlationId,
      resources: [`${summary.documents} documents`],
      ...(graph.truncated ? { reason: "scan stopped at the artifact limit" } : {}),
    });

    this.options.publish?.(summary);
    return summary;
  }

  // --- queries --------------------------------------------------------------

  /**
   * Rank artifacts against a query.
   *
   * Scoring is intentionally simple and explainable — title and tag matches
   * outrank body matches, and every term must appear somewhere — because the
   * result feeds a model that will act on it, and a surprising ranking is worse
   * than a plain one.
   */
  async search(query: string, limit: number, correlationId: string): Promise<KnowledgeHit[]> {
    const graph = await this.ensureIndexed(correlationId);
    const terms = query
      .toLowerCase()
      .split(/[^\w#/-]+/)
      .map((term) => term.trim())
      .filter((term) => term.length > 1);
    if (terms.length === 0) return [];

    const hits: KnowledgeHit[] = [];

    for (const node of graph.nodes) {
      if (node.kind === "missing") continue;
      const title = node.title.toLowerCase();
      const path = node.path.toLowerCase();
      const tags = node.tags.join(" ").toLowerCase();
      const body = (this.text.get(node.id) ?? node.excerpt).toLowerCase();

      let score = 0;
      let matchedAll = true;
      for (const term of terms) {
        let termScore = 0;
        if (title.includes(term)) termScore += 8;
        if (tags.includes(term)) termScore += 5;
        if (path.includes(term)) termScore += 3;
        if (body.includes(term)) termScore += 1;
        if (termScore === 0) matchedAll = false;
        score += termScore;
      }
      if (!matchedAll || score === 0) continue;

      // A well-connected note is usually the one the user meant.
      score += Math.min(node.degree, 10) * 0.25;
      hits.push({
        id: node.id,
        kind: node.kind,
        title: node.title,
        path: node.path,
        score: Number(score.toFixed(2)),
        snippet: snippet(this.text.get(node.id) ?? node.excerpt, terms),
      });
    }

    return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
  }

  /** One node with its neighbours and, for a readable artifact, its text. */
  async node(id: string, correlationId: string): Promise<KnowledgeNodeDetail | null> {
    const graph = await this.ensureIndexed(correlationId);
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const node = byId.get(id);
    if (!node) return null;

    const outgoing: Array<{ node: GraphNode; kind: GraphEdgeKind }> = [];
    const incoming: Array<{ node: GraphNode; kind: GraphEdgeKind }> = [];
    for (const edge of graph.edges) {
      if (edge.from === id) {
        const other = byId.get(edge.to);
        if (other) outgoing.push({ node: other, kind: edge.kind });
      } else if (edge.to === id) {
        const other = byId.get(edge.from);
        if (other) incoming.push({ node: other, kind: edge.kind });
      }
    }

    return {
      node,
      outgoing,
      incoming,
      content: (this.text.get(id) ?? "").slice(0, MAX_CONTENT_CHARS),
    };
  }

  // --- scanning -------------------------------------------------------------

  private async scanRoot(
    root: string,
    note: (reason: string) => void,
    budget: number,
  ): Promise<{ artifacts: Array<{ artifact: Artifact; text: string }>; truncated: boolean }> {
    const out: Array<{ artifact: Artifact; text: string }> = [];
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      return { artifacts: out, truncated: false };
    }

    let truncated = false;

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (out.length >= budget) {
        truncated = true;
        return;
      }
      if (depth > MAX_DEPTH) {
        note("too_deep");
        return;
      }

      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (out.length >= budget) {
          truncated = true;
          return;
        }
        if (entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);

        // A symlink is never followed, in either direction: the project is
        // agent-writable, so following one would let a note decide what the
        // indexer reads.
        if (entry.isSymbolicLink()) {
          note("symlink");
          continue;
        }
        if (entry.isDirectory()) {
          // The source half is input, not corpus. Indexing it would put every
          // report in the graph twice — once as the raw file, once as the note
          // Ingest wrote from it — and the raw one links to nothing.
          if (depth === 0 && entry.name === SOURCE_DIR) {
            note("source_directory");
            continue;
          }
          await walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!isInside(realRoot, full)) {
          note("outside_root");
          continue;
        }

        const extension = extensionOf(entry.name);
        const opaque = OPAQUE_EXTENSIONS.has(extension);
        if (!TEXT_EXTENSIONS.has(extension) && !opaque) {
          note("unsupported_type");
          continue;
        }

        const info = await stat(full).catch(() => null);
        if (!info) continue;
        if (info.size > MAX_FILE_BYTES) {
          note("too_large");
          continue;
        }

        const relativePath = relative(realRoot, full).split(sep).join("/");
        const text = opaque ? "" : await readFile(full, "utf8").catch(() => "");
        out.push({
          artifact: {
            kind: "document",
            path: relativePath,
            text,
            sizeBytes: info.size,
            updatedAt: info.mtime.toISOString(),
          },
          text: stripFrontmatter(text),
        });
      }
    };

    await walk(realRoot, 0);
    return { artifacts: out, truncated };
  }
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index).toLowerCase();
}

/** True when `candidate` really is under `root`, not merely prefixed by it. */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolvePath(root), resolvePath(candidate));
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`..${sep}`);
}

function snippet(body: string, terms: readonly string[]): string {
  if (!body) return "";
  const lower = body.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  if (at === -1) return body.slice(0, 160).replace(/\s+/g, " ").trim();

  const start = Math.max(0, at - 60);
  const text = body.slice(start, start + 220).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${text}${start + 220 < body.length ? "…" : ""}`;
}
