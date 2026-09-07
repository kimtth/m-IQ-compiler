import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type XYPosition,
} from "@xyflow/react";
import type { ResearchGraph, ResearchGraphDelta, ResearchNode } from "@iq/shared";
import { subscribe } from "./bridge.js";

/**
 * The reasoning graph of a research run, drawn live.
 *
 * This is the Agent Framework workflow's own account of itself — the executors
 * it built, the edges it validated, and the `executor_invoked` /
 * `executor_completed` / `executor_failed` events it raised as it ran. It is
 * not a diagram of the code: the question nodes appear only because the fan-out
 * really happened, one researcher per question, and a run that took two rounds
 * shows two generations of them.
 *
 * **Drawn as a flow, left to right, at fixed positions.** It was a force
 * layout, and that was wrong twice over. A workflow is a DAG whose stages are
 * declared — plan, then a researcher per question, then reflect, then
 * synthesize — so a physics simulation was being asked to rediscover an order
 * the data already states, and it settled on a star with the labels overlapping
 * in the middle. Worse, a status change restarted the simulation, so the whole
 * picture jumped every time a step moved. Ranking the nodes instead makes the
 * position a function of the graph: a status change is then only a change of
 * colour, and nothing moves.
 *
 * The old argument for force — that the width of the fan-out is not known ahead
 * of time — was about hand-placed columns, and it is answered by spreading each
 * rank rather than by giving up on rank altogether. `flow/assemble.ts` does the
 * same thing for IQ Cells.
 *
 * **Colour says what a step is; shading says how it is going.** Every node used
 * to take its fill from its status, so a picture of five stages was drawn in
 * one colour at a time and the only way to tell a question from the reflection
 * that read it was to hover. Fill is the kind now — plan, research, question,
 * reflect, write — and status is carried by the treatment of that fill: faded
 * for not started, ringed for running, solid for done, grey for skipped. A
 * failure is the one exception and takes the red fill outright, keeping its
 * kind on the border: a failed step has to be findable at a glance.
 *
 * **Nodes are DOM, drawn by React Flow.** They were a canvas, and most of what
 * this file used to contain was the price of that: every colour read back out
 * of CSS with `getComputedStyle`, a `MutationObserver` on the theme attribute
 * to force a repaint, labels truncated by hand because canvas text has no
 * ellipsis, and a tooltip of hand-escaped HTML over model output. `data-kind`
 * and `data-status` on a div carry the same encoding, the tokens resolve
 * themselves, and the surface now looks like the rest of the product because it
 * is made of the same things.
 */

/** What each colour means, in the order the workflow runs. */
const KINDS = ["plan", "research", "question", "reflect", "synthesize"] as const;

const KIND_LABELS: Record<ResearchNode["kind"], string> = {
  plan: "plan",
  research: "research",
  question: "question",
  reflect: "reflect",
  synthesize: "write",
};

/** Stage nodes are larger than the questions they fan out to. */
const SIZE: Record<ResearchNode["kind"], number> = {
  plan: 46,
  research: 46,
  reflect: 46,
  synthesize: 46,
  question: 26,
};

/** The drawing area the ranks are laid out inside, in flow units. */
const CANVAS = { width: 1000, height: 560, padX: 90, padY: 60 };

/**
 * The least distance between two nodes of the same rank, in flow units.
 *
 * The box used to be fixed, so a rank was divided by however many members it
 * had: at the planner's cap of sixteen questions that is 29 units between
 * centres for a 26-unit node, and the fan drew as one bar of touching discs
 * with the labels written over each other. The box grows down instead — see
 * `extent` — which is the only thing that makes room, because the view is
 * fitted to the pane while nodes stay the size they are asked for.
 */
const MIN_ROW_GAP = 64;

/**
 * The least distance between two ranks, in flow units.
 *
 * The same defect as `MIN_ROW_GAP`, in the other direction, and it was left
 * unfixed: the box was a fixed 1000 units wide while the number of ranks grows
 * with every round the manager spends, so a run of a few rounds packed its
 * columns to about fifty units apart. A label is written beside its node and is
 * up to `--rg-label-width` wide, so at that pitch every label was drawn over the
 * next column's node and over that node's label. The box grows sideways
 * instead. A node, its label and a gutter need this much room.
 */
const MIN_COL_GAP = 250;

/** How tall the canvas element is when the graph needs no more than `CANVAS.height`. */
const BASE_CANVAS_PX = 420;

/** Past this the card owns the screen; panning is there for the rest. */
const MAX_CANVAS_PX = 900;

/**
 * How the view is framed, used by both the first fit and every refit.
 *
 * `minZoom` is the floor on legibility, not on layout. A label is 12px, and a
 * fit free to shrink a deep graph to a third of its size renders that at 4px —
 * present, and unreadable, which is the worst of both. Below the floor the
 * picture overflows the pane and is read by zooming and dragging instead.
 * `maxZoom` stops a three-node graph being blown up to fill the card.
 */
const FIT = { padding: 0.08, minZoom: 0.6, maxZoom: 1 } as const;

/**
 * Rank each node by the longest path to it, and place it.
 *
 * Longest path rather than shortest, so a node never sits left of something it
 * depends on — the same rule `flow/assemble.ts` uses. A node no edge reaches
 * starts at rank 0, which is what puts `plan` on the left without naming it.
 *
 * Cycles cannot occur (the framework validates the graph it builds), but a
 * partially-delivered graph can still have an edge whose endpoints have not
 * both been announced, so the walk is bounded by the node count rather than run
 * to a fixed point.
 *
 * Exported for test: this is what makes the picture a flow and what makes it
 * stop moving, so it is pinned rather than left to be judged by eye.
 */
export function place(graph: ResearchGraph): Map<string, { x: number; y: number }> {
  const columns = columnsOf(graph);
  const box = extent(graph);

  const depth = Math.max(...columns.keys(), 0);
  const spanX = box.width - CANVAS.padX * 2;
  const spanY = box.height - CANVAS.padY * 2;
  const positions = new Map<string, { x: number; y: number }>();
  for (const [column, members] of columns) {
    const x = CANVAS.padX + (depth === 0 ? spanX / 2 : (column / depth) * spanX);
    members.forEach((id, index) => {
      // One member sits on the spine; several share the height evenly. The
      // height is whatever the widest rank needs, so "evenly" is never closer
      // than `MIN_ROW_GAP` and a sixteen-question fan is a column of separate
      // discs rather than a bar.
      const y =
        members.length === 1
          ? CANVAS.padY + spanY / 2
          : CANVAS.padY + (index / (members.length - 1)) * spanY;
      positions.set(id, { x, y });
    });
  }
  return positions;
}

/**
 * The box `place` draws inside. It grows with the widest fan-out and with the
 * number of ranks, because both are what crowds the picture.
 *
 * Exported because the height of the canvas element is derived from it, and the
 * two have to agree: the view is fitted to the element while nodes keep the
 * pixel size they were asked for, so a box that grew while the element did not
 * would simply draw everything smaller and put the nodes back on top of each
 * other. Width has no such partner — the pane is as wide as it is — so a graph
 * wider than the pane is zoomed out to fit, down to the floor set on the fit,
 * and reached by dragging past that.
 */
export function extent(graph: ResearchGraph): { width: number; height: number } {
  const columns = columnsOf(graph);
  const widest = Math.max(0, ...[...columns.values()].map((members) => members.length));
  const depth = Math.max(...columns.keys(), 0);
  const down = CANVAS.padY * 2 + Math.max(0, widest - 1) * MIN_ROW_GAP;
  const across = CANVAS.padX * 2 + depth * MIN_COL_GAP;
  return {
    width: Math.max(CANVAS.width, across),
    height: Math.max(CANVAS.height, down),
  };
}

/** Group the nodes into ranks by the longest path that reaches each one. */
function columnsOf(graph: ResearchGraph): Map<number, string[]> {
  const ids = graph.nodes.map((node) => node.id);
  const known = new Set(ids);
  const edges = graph.edges.filter((edge) => known.has(edge.from) && known.has(edge.to));

  const rank = new Map(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass += 1) {
    let moved = false;
    for (const edge of edges) {
      const next = (rank.get(edge.from) ?? 0) + 1;
      if (next > (rank.get(edge.to) ?? 0)) {
        rank.set(edge.to, next);
        moved = true;
      }
    }
    if (!moved) break;
  }

  const columns = new Map<number, string[]>();
  for (const id of ids) {
    const column = rank.get(id) ?? 0;
    columns.set(column, [...(columns.get(column) ?? []), id]);
  }
  return columns;
}

interface StepData extends Record<string, unknown> {
  kind: ResearchNode["kind"];
  status: ResearchNode["status"];
  label: string;
  detail: string;
  size: number;
  /**
   * Which side of the node its label is written on.
   *
   * The last rank has the right-hand padding and nothing else, so its label
   * would otherwise be written off the edge of the box the view is fitted to.
   */
  side: "left" | "right";
}

/**
 * One step.
 *
 * Nothing is styled inline except the diameter, which is a number rather than a
 * colour. The encoding lives in `research-graph.css` keyed on `data-kind` and
 * `data-status`, so a theme change is a cascade and not a repaint.
 *
 * The handles are the points React Flow draws edges between. They carry no
 * meaning here — nothing on this surface is connectable — so they are hidden
 * and sit on the node's own centre.
 */
const Step = memo(function Step({ data }: NodeProps<Node<StepData>>): JSX.Element {
  return (
    <div
      className="rg-node"
      data-kind={data.kind}
      data-status={data.status}
      data-side={data.side}
      style={{ ["--rg-size" as string]: `${data.size}px` }}
      title={data.detail ? `${data.label} — ${data.detail}` : data.label}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="rg-dot" aria-hidden />
      <span className="rg-label">{data.label}</span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});

const NODE_TYPES = { step: Step };

export function ResearchGraphView({
  runId,
  graph,
  active,
}: {
  runId: string;
  graph: ResearchGraph;
  /** Whether the run this graph belongs to is still doing work. */
  active: boolean;
}): JSX.Element | null {
  /**
   * Deltas that have arrived since the run record was last read.
   *
   * The run is persisted and re-published on its own schedule; the graph moves
   * per question per state change. Folding live deltas over the persisted graph
   * means the picture is current *between* saves, which is the whole point of
   * watching a run — and because a delta only ever adds a node or replaces one
   * by id, re-reading the run cannot conflict with them.
   */
  const [deltas, setDeltas] = useState<ResearchGraphDelta[]>([]);

  useEffect(() => {
    setDeltas([]);
    return subscribe<ResearchGraphDelta>("research:graph", (delta) => {
      if (delta.runId !== runId) return;
      setDeltas((current) => [...current, delta]);
    });
  }, [runId]);

  const folded = useMemo(() => fold(graph, deltas), [graph, deltas]);

  /**
   * A run that is not running has nothing running in it.
   *
   * The graph is a stream of deltas with no terminal frame, so a sidecar that
   * stops between a step starting and finishing leaves that node `running`
   * forever — and a spinner an hour after the process died is the most trusted
   * and most wrong thing on the surface. The service now settles what it knows
   * it left in flight; this is the backstop for what it never got to say, and
   * for the runs already persisted that way. Same rule as
   * `summarizeActivity(calls, turnStatus)` in the activity log.
   *
   * Drawn as `skipped`, not `failed`: nobody told us it failed. What is known
   * is that it did not finish.
   */
  const live = useMemo(
    () =>
      active
        ? folded
        : {
            ...folded,
            nodes: folded.nodes.map((node) =>
              node.status === "running" || node.status === "pending"
                ? { ...node, status: "skipped" as const, detail: node.detail || "never finished" }
                : node,
            ),
          },
    [folded, active],
  );

  const box = useMemo(() => extent(live), [live]);

  const nodes = useMemo<Node<StepData>[]>(() => {
    const at = place(live);
    return live.nodes.map((node) => {
      const point = at.get(node.id) ?? { x: box.width / 2, y: box.height / 2 };
      const size = SIZE[node.kind];
      return {
        id: node.id,
        type: "step",
        // React Flow positions the top-left corner; `place` names the centre.
        position: { x: point.x - size / 2, y: point.y - size / 2 },
        selectable: false,
        connectable: false,
        data: {
          kind: node.kind,
          status: node.status,
          label: node.label,
          detail: node.detail,
          size,
          side: point.x >= box.width - CANVAS.padX ? "left" : "right",
        },
      };
    });
  }, [live, box]);

  const edges = useMemo<Edge[]>(
    () =>
      live.edges.map((edge) => ({
        id: `${edge.from}->${edge.to}`,
        source: edge.from,
        target: edge.to,
        className: "rg-edge",
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: "var(--research-graph-link)",
        },
      })),
    [live],
  );

  /**
   * The element grows with the box, or the extra room is not room at all.
   *
   * The view is fitted into the element while nodes stay the pixels they were
   * asked for, so a taller box in a fixed element draws the same overlapping
   * fan, only smaller. The element takes the same proportion, capped: past
   * `MAX_CANVAS_PX` the card would own the screen, and panning is there for the
   * rest.
   */
  const canvasPx = Math.min(MAX_CANVAS_PX, Math.round((BASE_CANVAS_PX * box.height) / CANVAS.height));

  if (live.nodes.length === 0) return null;
  const running = live.nodes.filter((node) => node.status === "running").length;
  const kinds = KINDS.filter((kind) => live.nodes.some((node) => node.kind === kind));

  return (
    <div className="research-graph">
      <div className="row between">
        <strong>Reasoning graph</strong>
        <span className="muted">
          {live.nodes.length} steps
          {running > 0 ? ` · ${running} running` : ""} · Agent Framework workflow
        </span>
      </div>
      <div className="research-graph-canvas" style={{ height: `${canvasPx}px` }}>
        <ReactFlowProvider key={runId}>
          <GraphCanvas nodes={nodes} edges={edges} shape={`${nodes.length}:${box.height}`} />
        </ReactFlowProvider>
      </div>
      <div className="row research-graph-key">
        {kinds.map((kind) => (
          <span key={kind} className="muted">
            <span className="rg-key-dot" data-kind={kind} aria-hidden /> {KIND_LABELS[kind]}
          </span>
        ))}
      </div>
      <div className="row research-graph-key">
        <span className="muted">
          <span className="rg-key-dot" data-kind="question" data-status="running" aria-hidden /> running
        </span>
        <span className="muted">
          <span className="rg-key-dot" data-kind="question" data-status="pending" aria-hidden /> not started
        </span>
        <span className="muted">
          <span className="rg-key-dot" data-kind="question" data-status="failed" aria-hidden /> failed
        </span>
        <span className="muted">
          <span className="rg-key-dot" data-kind="question" data-status="skipped" aria-hidden /> never finished
        </span>
      </div>
    </div>
  );
}

/**
 * The pane itself.
 *
 * Separated only because `useReactFlow` has to run inside the provider. The fit
 * is the one imperative thing on this surface: the view is refitted when the
 * graph changes *shape* — a rank gained a member, or the box grew — and never
 * when a node merely changed status, which is what keeps the picture still
 * while a run is moving.
 *
 * Scrolling does not zoom. The graph sits in a card inside a scrolling column,
 * and a surface that eats the wheel is a surface the reader cannot scroll past.
 * The zoom is on the buttons instead, which is also the answer to a deep graph:
 * the fit will not shrink the picture past `FIT` (the labels stop being
 * readable), so a graph wider than the pane is read by zooming and dragging.
 *
 * Nodes can be moved. The layout is a guess about what is worth putting beside
 * what, and it is wrong often enough — two questions whose labels are both long
 * end up crowding each other however wide the columns are. A node the reader
 * drags stays where they put it, including across status changes, because it
 * was moved to be read and a run that is still going must not undo that. It is
 * released when the graph changes shape, which is the only moment the layout
 * has something new to say.
 */
function GraphCanvas({
  nodes,
  edges,
  shape,
}: {
  nodes: Node<StepData>[];
  edges: Edge[];
  shape: string;
}): JSX.Element {
  const { fitView } = useReactFlow();
  // Nodes are DOM, so their size is not known until they have been laid out.
  // Fitting before that measures zero-size boxes and frames the wrong thing.
  const measured = useNodesInitialized();

  /** Where the reader put a node, by id. Empty means "wherever `place` says". */
  const [moved, setMoved] = useState<ReadonlyMap<string, XYPosition>>(new Map());

  useEffect(() => setMoved(new Map()), [shape]);

  useEffect(() => {
    if (!measured) return;
    void fitView({ ...FIT, duration: 200 });
  }, [fitView, measured, shape]);

  /**
   * React Flow is controlled here, so a drag is a change it asks us to make.
   * Only the position is taken: selection and dimensions are ours to decide.
   */
  const onNodesChange = useCallback((changes: NodeChange<Node<StepData>>[]): void => {
    setMoved((current) => {
      let next = current;
      for (const change of changes) {
        if (change.type !== "position" || !change.position) continue;
        if (next === current) next = new Map(current);
        (next as Map<string, XYPosition>).set(change.id, change.position);
      }
      return next;
    });
  }, []);

  const placed = useMemo(
    () => nodes.map((node) => (moved.has(node.id) ? { ...node, position: moved.get(node.id)! } : node)),
    [nodes, moved],
  );

  return (
    <ReactFlow
      nodes={placed}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodesChange={onNodesChange}
      nodesConnectable={false}
      elementsSelectable={false}
      zoomOnScroll={false}
      zoomOnDoubleClick={false}
      preventScrolling={false}
      minZoom={0.2}
      maxZoom={2}
      fitView
      fitViewOptions={FIT}
    >
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

/**
 * Fold live deltas over the persisted graph.
 *
 * A node delta is *merged* onto whatever is already known by that id, not
 * substituted for it. Status frames carry only `id`, `status` and `detail` —
 * the workflow is reporting that a step moved, not restating what the step is —
 * so replacing outright would blank the label and reset the kind, redrawing a
 * running node as the wrong shape. Merging also makes replay order-insensitive
 * for the fields each frame actually sets, which is what lets a reconnecting
 * client catch up by re-reading the run.
 *
 * A patch for a node that has not been announced yet is dropped rather than
 * half-created: a node with no kind has no shape to draw.
 */
function fold(base: ResearchGraph, deltas: readonly ResearchGraphDelta[]): ResearchGraph {
  if (deltas.length === 0) return base;

  const nodes = new Map(base.nodes.map((node) => [node.id, node]));
  const edges = new Set(base.edges.map((edge) => `${edge.from}\u0000${edge.to}`));
  for (const delta of deltas) {
    if (delta.node) {
      const prior = nodes.get(delta.node.id);
      const merged = { ...prior, ...prune(delta.node) };
      if (isNode(merged)) nodes.set(merged.id, merged);
    }
    if (delta.edge) edges.add(`${delta.edge.from}\u0000${delta.edge.to}`);
  }
  return {
    nodes: [...nodes.values()],
    edges: [...edges].map((key) => {
      const [from, to] = key.split("\u0000");
      return { from: from ?? "", to: to ?? "" };
    }),
  };
}

/** Drop absent fields so a patch cannot overwrite known values with undefined. */
function prune(patch: ResearchGraphDelta["node"] & object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

/** Whether enough has arrived to draw the node at all. */
function isNode(value: Record<string, unknown>): value is ResearchGraph["nodes"][number] {
  return typeof value["id"] === "string" && typeof value["kind"] === "string";
}
