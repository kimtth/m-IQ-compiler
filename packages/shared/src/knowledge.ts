import { z } from "zod";

/**
 * Knowledge graph over local project artifacts.
 *
 * The graph uses notes linked by wiki-links and tags, but restricts the corpus
 * to artifacts that already live locally under the app's own directory:
 * project documents and installed skills. Nothing is fetched, and nothing
 * leaves the device to build it, so the graph inherits the local-first storage
 * guarantee rather than creating a new data path that would need its own
 * governance.
 */

export const GraphNodeKind = z.enum([
  /** A file under the local project directory. */
  "document",
  /** An installed Agent Skill. */
  "skill",
  /** A `#tag` found in a document. */
  "tag",
  /** A link target that does not resolve to anything indexed. */
  "missing",
]);
export type GraphNodeKind = z.infer<typeof GraphNodeKind>;

export const GraphEdgeKind = z.enum([
  /** Document to document, from a wiki-link or a relative Markdown link. */
  "links",
  /** Document to tag. */
  "tagged",
  /** Document to skill, when a link resolves to an installed skill. */
  "uses_skill",
]);
export type GraphEdgeKind = z.infer<typeof GraphEdgeKind>;

export const GraphNode = z.object({
  /** Stable, kind-prefixed identifier, e.g. `document:notes/plan.md`. */
  id: z.string(),
  kind: GraphNodeKind,
  title: z.string(),
  /** Project-relative path with forward slashes; empty for tags. */
  path: z.string().default(""),
  tags: z.array(z.string()).default([]),
  /** First few hundred characters of body text, for previews and search. */
  excerpt: z.string().default(""),
  sizeBytes: z.number().int().nonnegative().default(0),
  updatedAt: z.string().default(""),
  /** Count of incident edges, precomputed so the UI can rank without a pass. */
  degree: z.number().int().nonnegative().default(0),
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphEdge = z.object({
  from: z.string(),
  to: z.string(),
  kind: GraphEdgeKind,
  /** How many times this relationship occurs; repeated links are one edge. */
  weight: z.number().int().positive().default(1),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

export const KnowledgeGraph = z.object({
  /** Bumped when the indexer's output shape changes, to discard stale files. */
  version: z.number().int().positive(),
  builtAt: z.string(),
  /** Set when the scan stopped early at a safety limit. */
  truncated: z.boolean().default(false),
  /** Files skipped, by reason, so a partial index is never silently partial. */
  skipped: z.record(z.string(), z.number()).default({}),
  nodes: z.array(GraphNode).default([]),
  edges: z.array(GraphEdge).default([]),
});
export type KnowledgeGraph = z.infer<typeof KnowledgeGraph>;

/** Lightweight summary pushed to the UI after every reindex. */
export const KnowledgeSummary = z.object({
  builtAt: z.string(),
  nodes: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  documents: z.number().int().nonnegative(),
  skills: z.number().int().nonnegative(),
  tags: z.number().int().nonnegative(),
  unresolvedLinks: z.number().int().nonnegative(),
  truncated: z.boolean().default(false),
});
export type KnowledgeSummary = z.infer<typeof KnowledgeSummary>;

/**
 * Where the graph is indexed from.
 *
 * The vault is a directory the user curates, isolated from the project the
 * agent writes into, in the sense Obsidian uses the word. With none chosen the
 * indexer falls back to the project directory.
 */
export const KnowledgeVaultState = z.object({
  /** The directory currently indexed — the vault, or the project fallback. */
  directory: z.string(),
  /** True when no vault has been chosen and `directory` is the fallback. */
  isDefault: z.boolean(),
  /**
   * True when `directory` is the demo vault the app wrote for itself, which is
   * the only vault it will ever offer to delete.
   */
  isSamples: z.boolean().default(false),
  /** False when the stored directory has since been moved or deleted. */
  exists: z.boolean(),
  /** The project directory used when no vault is chosen. */
  fallback: z.string(),
  /**
   * Where raw files go. Ingest reads it and writes notes into the vault root;
   * the indexer never looks inside it, so a report does not appear twice.
   */
  sourceDirectory: z.string().default(""),
  /** How many readable files are waiting in `source/`. */
  sources: z.number().int().nonnegative().default(0),
});
export type KnowledgeVaultState = z.infer<typeof KnowledgeVaultState>;

/**
 * One raw file waiting in the vault's `source/`.
 *
 * Listed separately from the graph on purpose: a source is not a node. It is
 * what a note will be made *from*, and until Ingest runs it is in the vault
 * without being in the picture — a state the UI has to be able to show, or
 * adding a file looks like it did nothing.
 */
export const KnowledgeSource = z.object({
  /** Path relative to the source directory, POSIX separators. */
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  updatedAt: z.string(),
  /** False for a binary this app cannot read without a converter. */
  readable: z.boolean().default(true),
});
export type KnowledgeSource = z.infer<typeof KnowledgeSource>;

export const KnowledgeHit = z.object({
  id: z.string(),
  kind: GraphNodeKind,
  title: z.string(),
  path: z.string(),
  score: z.number(),
  /** Matching text with the query terms in context. */
  snippet: z.string(),
});
export type KnowledgeHit = z.infer<typeof KnowledgeHit>;

export const KnowledgeNodeDetail = z.object({
  node: GraphNode,
  /** Nodes this one points at. */
  outgoing: z.array(z.object({ node: GraphNode, kind: GraphEdgeKind })),
  /** Nodes pointing at this one — the backlinks panel. */
  incoming: z.array(z.object({ node: GraphNode, kind: GraphEdgeKind })),
  /** Body text, read on demand and capped; empty for tags and missing nodes. */
  content: z.string().default(""),
});
export type KnowledgeNodeDetail = z.infer<typeof KnowledgeNodeDetail>;
