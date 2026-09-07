import type { FlowEdgeStyle, FlowGraph, FlowNodeKind } from "@iq/shared";
import { addNode, connect, emptyGraph, updateEdge, updateNode } from "./graph.js";
import { specOf } from "./catalog.js";

/**
 * Turning a list of steps into a laid-out, wired diagram.
 *
 * Every path that puts a diagram on the canvas without a person dragging it
 * there goes through here: the starter templates, a reconstruction of a
 * published IQ Cell, and a diagram parsed back from Mermaid. Position becomes
 * a pure function of the graph, so an imported diagram is fully editable from
 * the moment it lands rather than a pile of nodes at the origin.
 *
 * Two rules do the work. A step says what feeds it, so a rank is the longest
 * path from a start and independent work sits side by side instead of
 * pretending to be sequential. And a rank is placed below the tallest node in
 * the rank above it, so a diamond is not overlapped by the box after it.
 */

/**
 * One arrow into a step.
 *
 * A bare index is an unlabelled arrow. The object form is what a decision
 * needs: the answers — "yes", "rejected", "over £10k" — live on the arrows,
 * and a step reached by two arrows can be reached for two different reasons,
 * so the label belongs to the arrow rather than to the step.
 */
export type AssemblyLink =
  | number
  | { readonly from: number; readonly label?: string; readonly style?: FlowEdgeStyle };

export interface AssemblyStep {
  kind: FlowNodeKind;
  label?: string;
  config?: Record<string, string>;
  /**
   * Which earlier steps feed this one, by index. Omitting it means "the step
   * before me", which is what a linear flow wants; naming several is what lets
   * a diagram fan out and rejoin, and naming a later one is how a loop closes.
   */
  from?: readonly AssemblyLink[];
}

const sourceOf = (link: AssemblyLink): number => (typeof link === "number" ? link : link.from);

/** Vertical air between one rank and the next, and horizontal between siblings. */
const RANK_GAP = 72;
const COLUMN_GAP = 260;
const ORIGIN = { x: 120, y: 60 };

/**
 * How tall a node of this kind draws, in the units the canvas positions in.
 *
 * These are the CSS heights, not estimates. A diamond is a 168px square — see
 * `.iq-diamond` — and it was declared as 108 here, which is 60px short. The
 * rank below it was therefore placed inside it: a decision's two branches
 * ended up level with its own bottom vertex, and their arrows, having almost
 * no vertical distance to cover, were drawn as flat lines running sideways
 * through the labels. Every worked example with a decision in it looked wrong
 * for that one number.
 */
const heightOf = (kind: FlowNodeKind): number =>
  specOf(kind).shape === "diamond" ? 168 : 72;

export const assemble = (
  name: string,
  steps: readonly AssemblyStep[],
  projectId: string | null,
  /**
   * A stable id for diagrams that stand for something reconstructed more than
   * once — a demo cell, a template opened twice.
   *
   * Without it every reconstruction mints a fresh id, `publishIqCell` finds no
   * earlier version to count from, and the library fills with identical v1
   * records instead of one cell at v2. Omit it for something drawn by hand:
   * those are genuinely new each time.
   */
  id?: string,
): FlowGraph => {
  const parentsOf = (step: AssemblyStep, index: number): readonly AssemblyLink[] =>
    step.from ?? (index === 0 ? [] : [index - 1]);

  // Rank is the longest path from a start, so a step never sits above
  // something that leads to it.
  const rank: number[] = [];
  steps.forEach((step, index) => {
    // Only earlier steps count towards the rank. A step may name a later one
    // to close a loop, and following that back would not terminate.
    const earlier = parentsOf(step, index).map(sourceOf).filter((parent) => parent < index);
    rank[index] = earlier.length === 0 ? 0 : Math.max(...earlier.map((p) => (rank[p] ?? 0) + 1));
  });

  const ranks = new Map<number, number[]>();
  rank.forEach((value, index) => ranks.set(value, [...(ranks.get(value) ?? []), index]));
  const widest = Math.max(1, ...[...ranks.values()].map((members) => members.length));

  const position = new Map<number, { x: number; y: number }>();
  let y = ORIGIN.y;
  for (const level of [...ranks.keys()].sort((a, b) => a - b)) {
    const members = ranks.get(level) as number[];
    // Centre the rank, so a fan-out spreads either side of the spine rather
    // than hanging off its left edge.
    const offset = (widest - members.length) / 2;
    members.forEach((index, column) => {
      position.set(index, { x: ORIGIN.x + (offset + column) * COLUMN_GAP, y });
    });
    y += Math.max(...members.map((index) => heightOf(steps[index]?.kind ?? "step"))) + RANK_GAP;
  }

  let graph = emptyGraph(name, projectId);
  if (id !== undefined) graph = { ...graph, id };
  const ids: string[] = [];

  steps.forEach((step, index) => {
    const at = position.get(index) ?? ORIGIN;
    const added = addNode(graph, step.kind, at.x, at.y);
    graph = added.graph;
    graph = updateNode(graph, added.node.id, {
      label: step.label ?? specOf(step.kind).label,
      config: step.config ?? {},
    });
    ids[index] = added.node.id;
  });

  steps.forEach((step, index) => {
    for (const link of parentsOf(step, index)) {
      const from = ids[sourceOf(link)];
      const to = ids[index];
      if (from === undefined || to === undefined) continue;
      const outcome = connect(graph, { from, to });
      if (!outcome.ok) continue;
      graph = outcome.graph;
      if (typeof link === "number") continue;
      graph = updateEdge(graph, outcome.edge.id, {
        label: link.label ?? "",
        style: link.style ?? "solid",
      });
    }
  });

  return graph;
};
