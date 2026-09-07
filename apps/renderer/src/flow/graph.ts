import type { FlowEdge, FlowGraph, FlowNode, FlowNodeKind } from "@iq/shared";
import { specOf } from "./catalog.js";

/**
 * Graph operations.
 *
 * Pure functions over an immutable `FlowGraph`, so undo/redo is a stack of
 * snapshots and every mutation is testable without a canvas. Layout lives on
 * the node and is deliberately excluded from the source hash: moving a node
 * must never change what the diagram says.
 */

let counter = 0;

const nextId = (prefix: string): string => {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
};

export const emptyGraph = (name: string, projectId: string | null): FlowGraph => ({
  id: nextId("flow"),
  name,
  projectId,
  nodes: [],
  edges: [],
  updatedAt: new Date().toISOString(),
});

const touch = (graph: FlowGraph, patch: Partial<FlowGraph>): FlowGraph => ({
  ...graph,
  ...patch,
  updatedAt: new Date().toISOString(),
});

export const addNode = (
  graph: FlowGraph,
  kind: FlowNodeKind,
  x: number,
  y: number,
): { graph: FlowGraph; node: FlowNode } => {
  const spec = specOf(kind);
  const node: FlowNode = {
    id: nextId(kind),
    kind,
    label: spec.label,
    x,
    y,
    config: {},
    notes: "",
  };
  return { graph: touch(graph, { nodes: [...graph.nodes, node] }), node };
};

export const updateNode = (
  graph: FlowGraph,
  id: string,
  patch: Partial<Omit<FlowNode, "id" | "kind">>,
): FlowGraph =>
  touch(graph, {
    nodes: graph.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)),
  });

/** Deleting a node takes its edges with it; the caller reports how many. */
export const removeNode = (graph: FlowGraph, id: string): FlowGraph =>
  touch(graph, {
    nodes: graph.nodes.filter((node) => node.id !== id),
    edges: graph.edges.filter((edge) => edge.from !== id && edge.to !== id),
  });

export const removeEdge = (graph: FlowGraph, id: string): FlowGraph =>
  touch(graph, { edges: graph.edges.filter((edge) => edge.id !== id) });

/**
 * Change an arrow's label or style.
 *
 * The label is the whole reason an arrow is editable: a decision asks a
 * question and its answers — "yes", "rejected", "over £10k" — live on the
 * arrows leaving it. Without this the diamond is a shape with no branches.
 */
export const updateEdge = (
  graph: FlowGraph,
  id: string,
  patch: Partial<Omit<FlowEdge, "id" | "from" | "to">>,
): FlowGraph =>
  touch(graph, {
    edges: graph.edges.map((edge) => (edge.id === id ? { ...edge, ...patch } : edge)),
  });

export const edgeOf = (graph: FlowGraph, id: string): FlowEdge | null =>
  graph.edges.find((edge) => edge.id === id) ?? null;

export const nodeOf = (graph: FlowGraph, id: string): FlowNode | null =>
  graph.nodes.find((node) => node.id === id) ?? null;

export interface ConnectRequest {
  from: string;
  to: string;
}

export type ConnectOutcome =
  | { ok: true; graph: FlowGraph; edge: FlowEdge }
  | { ok: false; reason: string };

/**
 * Draw an arrow between two nodes.
 *
 * Three refusals, and they are all about the drawing rather than about what
 * the arrow means: an unknown node, a node pointing at itself, and an arrow
 * that is already there. Everything else is allowed, because this surface
 * describes how a business works and a business loops — rework, re-review,
 * chase again until the supplier answers. The old canvas rejected a back-edge
 * outright, which meant the single most common real process could not be
 * drawn at all.
 */
export const connect = (graph: FlowGraph, request: ConnectRequest): ConnectOutcome => {
  const from = nodeOf(graph, request.from);
  const to = nodeOf(graph, request.to);
  if (from === null || to === null) return { ok: false, reason: "Unknown node." };
  if (from.id === to.id) return { ok: false, reason: "A node cannot connect to itself." };

  const duplicate = graph.edges.some(
    (edge) => edge.from === request.from && edge.to === request.to,
  );
  if (duplicate) return { ok: false, reason: "Those two are already connected." };

  const edge: FlowEdge = {
    id: nextId("edge"),
    from: request.from,
    to: request.to,
    label: "",
    style: "solid",
  };
  return { ok: true, graph: touch(graph, { edges: [...graph.edges, edge] }), edge };
};

/** True when `target` is reachable from `origin` by following arrows. */
export const reaches = (graph: FlowGraph, origin: string, target: string): boolean => {
  const seen = new Set<string>();
  const queue = [origin];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of graph.edges) {
      if (edge.from === current) queue.push(edge.to);
    }
  }
  return false;
};

/**
 * Reading order: the order a person walks the diagram.
 *
 * A topological sort where one exists, so a step is described after whatever
 * leads to it. Where one does not — which is now ordinary, because loops are
 * legal — the nodes a cycle leaves unvisited are appended in the order they
 * were added. Every node is returned either way; a description that quietly
 * dropped the steps inside a loop would be worse than one listed out of order.
 */
export const topoOrder = (graph: FlowGraph): FlowNode[] => {
  const links = graph.edges.map((edge) => ({ from: edge.from, to: edge.to }));
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const link of links) indegree.set(link.to, (indegree.get(link.to) ?? 0) + 1);

  // Ties break on canvas position, so the order a reader sees top-to-bottom is
  // the order the description is written in.
  const ready = graph.nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const order: FlowNode[] = [];

  while (ready.length > 0) {
    const node = ready.shift() as FlowNode;
    order.push(node);
    for (const link of links.filter((l) => l.from === node.id)) {
      const left = (indegree.get(link.to) ?? 0) - 1;
      indegree.set(link.to, left);
      if (left === 0) {
        const next = graph.nodes.find((candidate) => candidate.id === link.to);
        if (next !== undefined) ready.push(next);
      }
    }
    ready.sort((a, b) => a.y - b.y || a.x - b.x);
  }

  // A cycle leaves nodes unvisited. They are appended in insertion order so
  // the canvas never loses a node.
  const missing = graph.nodes.filter((node) => !order.includes(node));
  return [...order, ...missing];
};

/**
 * The source hash.
 *
 * Layout, notes and viewport are excluded: the same flow laid out differently
 * must produce the same identity.
 */
export const sourceHash = (graph: FlowGraph): string => {
  const canonical = JSON.stringify({
    nodes: [...graph.nodes]
      .map((node) => ({ id: node.id, kind: node.kind, label: node.label, config: node.config }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graph.edges]
      .map((edge) => ({
        from: edge.from,
        to: edge.to,
        label: edge.label,
        style: edge.style,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });

  // FNV-1a: short, stable and dependency-free. This is an identity for the
  // drawing, not a security primitive.
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};
