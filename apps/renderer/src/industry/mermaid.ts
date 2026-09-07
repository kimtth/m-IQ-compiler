/**
 * A Mermaid flowchart parser and layout, for the industry primers.
 *
 * Narrow on purpose, exactly like the Markdown renderer beside it. It accepts
 * a small supported subset — `flowchart`/`graph`
 * with a direction, node shapes, and edges with optional labels — and returns
 * `null` for everything else, which is what lets `render.tsx` fall back to
 * showing the source. A partial diagram is worse than the source: the source is
 * honest about being source, and a diagram missing a subgraph silently asserts
 * a structure the author did not write.
 *
 * There is no `mermaid` dependency because the whole of that library, plus the
 * SVG string it produces and the sanitising that string would then need, is a
 * poor trade for simple static flowcharts. This produces plain data; the caller
 * builds React elements from it, so no HTML is constructed anywhere.
 */

export type Direction = "TD" | "LR";

export interface MermaidNode {
  id: string;
  /** Already split on the literal `\n` Mermaid uses for a line break. */
  lines: string[];
  shape: "box" | "round" | "diamond" | "stadium" | "subroutine";
  /** Layout, filled by `layout()`. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MermaidEdge {
  from: string;
  to: string;
  label: string;
  dashed: boolean;
}

export interface MermaidGraph {
  direction: Direction;
  nodes: MermaidNode[];
  edges: MermaidEdge[];
  width: number;
  height: number;
}

/** Anything on a line that means a construct this renderer does not draw. */
const UNSUPPORTED = /^\s*(subgraph|end|classDef|class\s|click|style|linkStyle|direction)\b/;

/**
 * One edge.
 *
 * The arrow alternatives are ordered longest-first so `-.->` is not matched as
 * `-` followed by junk, and the label is captured from the middle rather than
 * from either side because Mermaid puts it inside the arrow.
 */
const EDGE =
  /^(.+?)\s*(-{2,3}>|-\.-+>|={2,3}>|-{3,})(?:\|([^|]*)\|)?\s*(.+)$/;

/**
 * A node reference, with or without a shape and label.
 *
 * The openers are ordered longest-first for the same reason the arrows are:
 * `([` has to be tried before `(`, or a stadium is read as a round node whose
 * label happens to start with a bracket. All five shapes IQ Workflow exports
 * are here, so a diagram drawn on that canvas and pasted into a primer draws
 * as what it was drawn as.
 */
const NODE = /^([A-Za-z0-9_-]+)(?:(\[\[|\(\(|\(\[|\[|\(|\{)(.*?)(\]\]|\)\)|\]\)|\]|\)|\}))?$/;

const SHAPES: Record<string, MermaidNode["shape"]> = {
  "[": "box",
  "(": "round",
  "{": "diamond",
  "((": "round",
  "([": "stadium",
  "[[": "subroutine",
};

/** Rough character width at the font size the figure draws at. */
const CHAR_WIDTH = 6.6;
const LINE_HEIGHT = 16;
const PAD_X = 14;
const PAD_Y = 12;
const MIN_WIDTH = 70;
const GAP_WITHIN_RANK = 26;
const GAP_BETWEEN_RANKS = 62;
const MARGIN = 12;
/** Labels wrap past this many characters, so a long one does not run off. */
const WRAP_AT = 26;

/**
 * Parse a mermaid block, or return null if it uses anything not drawn here.
 *
 * Null is a first-class answer, not a failure: the caller shows the source,
 * which is also what Obsidian does when it cannot render a diagram.
 */
export function parseMermaid(source: string): MermaidGraph | null {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("%%"));
  if (lines.length === 0) return null;

  const header = /^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)\s*$/i.exec(lines[0] ?? "");
  if (!header) return null;
  const declared = (header[1] ?? "TD").toUpperCase();
  // RL and BT are the same layout mirrored; drawing them as their opposite
  // would reverse the meaning of every arrow, so they are refused.
  if (declared === "RL" || declared === "BT") return null;
  const direction: Direction = declared === "LR" ? "LR" : "TD";

  const nodes = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];

  for (const line of lines.slice(1)) {
    if (UNSUPPORTED.test(line)) return null;

    const edge = EDGE.exec(line);
    if (edge) {
      const left = reference(edge[1] ?? "", nodes);
      const right = reference(edge[4] ?? "", nodes);
      if (left === null || right === null) return null;
      edges.push({
        from: left,
        to: right,
        label: (edge[3] ?? "").trim(),
        dashed: (edge[2] ?? "").includes("."),
      });
      continue;
    }

    // A bare node declaration on its own line.
    const solo = reference(line, nodes);
    if (solo === null) return null;
  }

  if (nodes.size === 0) return null;
  return layout({ direction, nodes: [...nodes.values()], edges, width: 0, height: 0 });
}

/** Read one end of an edge, registering the node the first time it is named. */
function reference(raw: string, nodes: Map<string, MermaidNode>): string | null {
  const text = raw.trim();
  const match = NODE.exec(text);
  if (!match) return null;
  const id = match[1] ?? "";
  if (id === "") return null;

  const opener = match[2];
  const existing = nodes.get(id);
  if (opener === undefined) {
    // A reference with no label. Only valid once the node has been declared, or
    // as a node whose id is its label.
    if (!existing) {
      nodes.set(id, blank(id, [id], "box"));
    }
    return id;
  }

  // A generated diagram quotes its labels, because a label containing a
  // bracket or a comma is otherwise ambiguous. The quotes are punctuation for
  // the parser, not part of what the author wrote.
  const declared = (match[3] ?? "").trim();
  const label = /^".*"$/s.test(declared) ? declared.slice(1, -1) : declared;
  const shape = SHAPES[opener] ?? "box";
  const lines = wrap(label === "" ? id : label);
  // A later declaration wins, matching Mermaid: the labelled mention is the one
  // the author meant, and it may come after a bare reference.
  nodes.set(id, blank(id, lines, shape));
  return id;
}

function blank(id: string, lines: string[], shape: MermaidNode["shape"]): MermaidNode {
  return { id, lines, shape, x: 0, y: 0, width: 0, height: 0 };
}

/**
 * Split a label into lines.
 *
 * Mermaid's own break is a literal backslash-n inside the label, which the
 * semiconductor primer uses. Beyond that, long labels are wrapped on words so a
 * participant named in full does not run off the side of the figure.
 */
function wrap(label: string): string[] {
  const explicit = label.split(/\\n|<br\s*\/?>/i).map((part) => part.trim());
  const out: string[] = [];
  for (const part of explicit) {
    if (part.length <= WRAP_AT) {
      out.push(part);
      continue;
    }
    let current = "";
    for (const word of part.split(/\s+/)) {
      if (current === "") current = word;
      else if (`${current} ${word}`.length <= WRAP_AT) current = `${current} ${word}`;
      else {
        out.push(current);
        current = word;
      }
    }
    if (current !== "") out.push(current);
  }
  return out.length > 0 ? out : [""];
}

/**
 * Place the nodes.
 *
 * Rank by longest path from a root, then spread within the rank — the same
 * shape as `place()` in ResearchGraph.tsx and `flow/assemble.ts`, and for the
 * same reason: position becomes a pure function of the graph, so nothing moves
 * unless the diagram changes.
 *
 * **Back-edges are found first and excluded from ranking.** Three of the five
 * primers contain a cycle (`Test -->|Defects| Build`, `E --> B`, `F --> E`) —
 * they are feedback loops, which is exactly what those diagrams are about — and
 * a longest-path walk that followed one would not terminate.
 */
function layout(graph: MermaidGraph): MermaidGraph {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const back = backEdges(graph);
  const forward = graph.edges.filter((_, index) => !back.has(index));

  const rank = new Map<string, number>();
  for (const node of graph.nodes) rank.set(node.id, 0);
  // Longest path: relax until stable. Bounded by node count because the
  // forward set is acyclic by construction.
  for (let pass = 0; pass < graph.nodes.length; pass += 1) {
    let moved = false;
    for (const edge of forward) {
      const next = (rank.get(edge.from) ?? 0) + 1;
      if (next > (rank.get(edge.to) ?? 0)) {
        rank.set(edge.to, next);
        moved = true;
      }
    }
    if (!moved) break;
  }

  for (const node of graph.nodes) {
    const longest = node.lines.reduce((most, line) => Math.max(most, line.length), 0);
    node.width = Math.max(MIN_WIDTH, Math.round(longest * CHAR_WIDTH) + PAD_X * 2);
    node.height = node.lines.length * LINE_HEIGHT + PAD_Y * 2;
  }

  // Group by rank, keeping declaration order within one so the picture reads in
  // the order the author wrote it.
  const ranks = new Map<number, MermaidNode[]>();
  for (const node of graph.nodes) {
    const at = rank.get(node.id) ?? 0;
    const row = ranks.get(at) ?? [];
    row.push(node);
    ranks.set(at, row);
  }

  const ordered = [...ranks.entries()].sort((a, b) => a[0] - b[0]);
  const across = (row: MermaidNode[]): number =>
    row.reduce((total, node) => total + (graph.direction === "TD" ? node.width : node.height), 0) +
    GAP_WITHIN_RANK * (row.length - 1);
  const widest = ordered.reduce((most, [, row]) => Math.max(most, across(row)), 0);

  let along = MARGIN;
  for (const [, row] of ordered) {
    const deep = row.reduce(
      (most, node) => Math.max(most, graph.direction === "TD" ? node.height : node.width),
      0,
    );
    let offset = MARGIN + (widest - across(row)) / 2;
    for (const node of row) {
      if (graph.direction === "TD") {
        node.x = offset;
        node.y = along + (deep - node.height) / 2;
        offset += node.width + GAP_WITHIN_RANK;
      } else {
        node.y = offset;
        node.x = along + (deep - node.width) / 2;
        offset += node.height + GAP_WITHIN_RANK;
      }
    }
    along += deep + GAP_BETWEEN_RANKS;
  }

  const right = graph.nodes.reduce((most, node) => Math.max(most, node.x + node.width), 0);
  const bottom = graph.nodes.reduce((most, node) => Math.max(most, node.y + node.height), 0);

  return {
    ...graph,
    nodes: [...byId.values()],
    width: right + MARGIN,
    height: bottom + MARGIN,
  };
}

/**
 * Indices of edges that close a cycle, by depth-first search.
 *
 * Which edge of a cycle is called the back-edge depends on where the walk
 * starts, and the walk starts in declaration order — so the answer is stable
 * for a given document, which is all the layout needs.
 */
function backEdges(graph: MermaidGraph): Set<number> {
  const out = new Map<string, Array<{ to: string; index: number }>>();
  graph.edges.forEach((edge, index) => {
    const list = out.get(edge.from) ?? [];
    list.push({ to: edge.to, index });
    out.set(edge.from, list);
  });

  const back = new Set<number>();
  const state = new Map<string, "open" | "done">();

  const walk = (id: string): void => {
    state.set(id, "open");
    for (const next of out.get(id) ?? []) {
      const seen = state.get(next.to);
      if (seen === "open") back.add(next.index);
      else if (seen === undefined) walk(next.to);
    }
    state.set(id, "done");
  };

  for (const node of graph.nodes) {
    if (!state.has(node.id)) walk(node.id);
  }
  return back;
}
