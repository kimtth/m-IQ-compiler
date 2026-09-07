import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle,
  CircleAlert,
  Copy,
  Download,
  Eraser,
  FileCode2,
  Info,
  Package,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Workflow,
} from "lucide-react";
import type {
  FlowDiagnostic,
  FlowEdge,
  FlowGraph,
  FlowNode,
  FlowNodeKind,
  IqCellCard,
} from "@iq/shared";
import { IQ_CELL_ORIGIN_LABELS } from "@iq/shared";
import { FAMILY_LABELS, FAMILY_ORDER, searchSpecs, specOf, type ConfigField } from "./catalog.js";
import {
  addNode,
  connect,
  edgeOf,
  emptyGraph,
  nodeOf,
  removeEdge,
  removeNode,
  sourceHash,
  topoOrder,
  updateEdge,
  updateNode,
} from "./graph.js";
import { blocking, validate } from "./compile.js";
import { toMarkdown, toMermaid, toSvg } from "./export.js";
import { askForDiagram } from "./ask.js";
import { NODE_TYPES, typeOf, type FlowRfNode, type NodeData } from "./nodes.js";
import { EDGE_TYPES, type EdgeData, type FlowRfEdge } from "./edges.js";
import { SplitDivider, useSplit, type ColumnSpec } from "../split.js";
import { IqCellRow } from "./IqCellRow.js";
import {
  onFlowStaged,
  TEMPLATES,
  deleteFlow,
  deleteIqCell,
  exportBundle,
  fromTemplate,
  importBundle,
  listFlows,
  listIqCells,
  publishIqCell,
  renameIqCell,
  saveFlow,
  takeStagedFlow,
} from "./storage.js";

/**
 * IQ Workflow.
 *
 * A modeler for how work actually happens: seven shapes, arrows between them,
 * and words on the arrows. Nothing on this canvas runs, and nothing on it is
 * meant to — a diagram of a supplier approval is a thing people argue over in
 * a meeting, not a program.
 *
 * The vocabulary lines up one-for-one with Mermaid flowchart shapes, so a
 * diagram drawn here leaves as text anybody can read, edit elsewhere and paste
 * back. Export is what Compile used to be; Publish records a version in the
 * project's IQ Cell library so a diagram can be found again.
 *
 * `FlowGraph` is the store of record. React Flow's nodes and edges are a
 * projection of it, rebuilt on render and mapped straight back on change, so
 * undo is a stack of graphs rather than a stack of canvas events.
 */

interface FlowProps {
  projectId: string | null;
  onError: (problem: unknown) => void;
}

/**
 * The palette carries node names and their one-line detail, and the inspector
 * carries a form, so neither has a width that is right for every diagram. The
 * canvas is the elastic column, so a drag takes space from the canvas alone
 * and never from the column on the far side.
 */
const FLOW_COLUMNS: Record<"palette" | "inspector", ColumnSpec> = {
  palette: { min: 200, initial: 276, side: "left" },
  inspector: { min: 240, initial: 300, side: "right" },
};

/**
 * The cells this surface's sidebar lists.
 *
 * Drawn here only. Every row in that sidebar opens a diagram on the canvas
 * beside it, and a cell recorded by another surface has none — it would be a
 * control that cannot do what it offers. The IQ Cell library destination lists
 * them all and routes each to the surface it came from.
 */
const editorCells = (projectId: string | null): IqCellCard[] =>
  listIqCells(projectId).filter((card) => card.origin === "editor");

/**
 * Two nodes are on the same rank if their tops are within this many pixels.
 *
 * The layout puts a whole rank on one y, so anything smaller than the shortest
 * node is enough to tell "beside" from "below".
 */
const SAME_RANK = 24;

/**
 * Which side of each node an arrow leaves, and which side it arrives at.
 *
 * Every node offers four handles so an author can wire a diagram in any
 * direction. React Flow, given no handle, takes the first one it finds — which
 * is the top on both ends. Every arrow in every diagram therefore left the top
 * of one node and arrived at the top of the next, and a flow that reads
 * downwards was drawn as a row of arcs looping over the boxes.
 *
 * So the sides are derived from where the two nodes actually are. A diagram
 * that reads downwards leaves the bottom and arrives at the top; a step that
 * loops back up does the reverse; two nodes side by side on one rank connect
 * left to right. Recomputed as nodes move, so dragging one re-aims its arrows.
 *
 * This is layout, not content: nothing is written to the graph, and an arrow
 * the author drew by dragging from a particular handle is drawn the same way
 * as one the app wired, because the graph never recorded that choice either.
 *
 * `jumped` says the arrow passes a rank on its way. Bottom to top would send it
 * down the middle of the canvas and straight through whatever is parked there:
 * a decision's "No" that skips the branch below it was drawn over the top of
 * that branch, label and all, so the diagram showed a line into a box it does
 * not connect to and no "No" anywhere. Those leave and arrive at the same side
 * instead, which bows the curve clear of the column.
 */
const sidesFor = (
  from: { x: number; y: number },
  to: { x: number; y: number },
  jumped: boolean,
): { source: string; target: string } => {
  const down = to.y - from.y;
  if (Math.abs(down) < SAME_RANK) {
    return to.x >= from.x ? { source: "r", target: "l" } : { source: "l", target: "r" };
  }
  if (jumped) {
    const side = to.x >= from.x ? "r" : "l";
    return { source: side, target: side };
  }
  return down > 0 ? { source: "b", target: "t" } : { source: "t", target: "b" };
};

/**
 * The y of each rank, in order.
 *
 * The layout puts a whole rank on one y, so the distinct node tops are the
 * ranks. Two tops within `SAME_RANK` of each other are one rank — a rank's
 * members are laid out level, and this only has to survive rounding.
 */
const ranksOf = (nodes: readonly FlowNode[]): number[] => {
  const ys: number[] = [];
  for (const node of [...nodes].sort((a, b) => a.y - b.y)) {
    const last = ys[ys.length - 1];
    if (last === undefined || node.y - last >= SAME_RANK) ys.push(node.y);
  }
  return ys;
};

/**
 * How far apart two arrows sharing one handle are pulled.
 *
 * Wide enough to read as two lines at the zoom a whole diagram is viewed at,
 * and narrow enough that four of them still leave from within the node they
 * belong to — the narrowest node is the 168px diamond, so three either side of
 * centre is the most this has to hold.
 */
const EDGE_SPREAD = 26;

/**
 * Slide each arrow along the side it uses, so arrows sharing a handle separate.
 *
 * A handle is one point. Every arrow leaving a node's bottom therefore starts
 * at the same pixel, and two that run in roughly the same direction — a step
 * that feeds both the next step and a document — are drawn as a single line a
 * couple of pixels thick for as long as they have not diverged. That reads as a
 * broken line, not as two connections.
 *
 * Each end is spread independently, because the crowding is per handle: an
 * arrow may be one of three leaving its source and the only one arriving at its
 * target. Ordering is the graph's own edge order, so it is stable across
 * renders and a diagram does not reshuffle its arrows as it is edited.
 */
const spreadEdges = (
  edges: readonly FlowEdge[],
  sides: ReadonlyMap<string, { source: string; target: string }>,
): Map<string, { from: number; to: number }> => {
  const seats = new Map<string, string[]>();
  const take = (key: string, id: string): void => {
    const row = seats.get(key) ?? [];
    row.push(id);
    seats.set(key, row);
  };

  for (const edge of edges) {
    const side = sides.get(edge.id);
    if (side === undefined) continue;
    take(`${edge.from}|${side.source}`, edge.id);
    take(`${edge.to}|${side.target}`, edge.id);
  }

  /** Centred on the handle: one arrow sits on it, two straddle it. */
  const offsetIn = (key: string, id: string): number => {
    const row = seats.get(key) ?? [];
    const seat = row.indexOf(id);
    if (row.length < 2 || seat < 0) return 0;
    return (seat - (row.length - 1) / 2) * EDGE_SPREAD;
  };

  const shifts = new Map<string, { from: number; to: number }>();
  for (const edge of edges) {
    const side = sides.get(edge.id);
    if (side === undefined) continue;
    shifts.set(edge.id, {
      from: offsetIn(`${edge.from}|${side.source}`, edge.id),
      to: offsetIn(`${edge.to}|${side.target}`, edge.id),
    });
  }
  return shifts;
};

/** The line under a node's label: the first two fields that are filled in. */
const detailOf = (node: FlowNode): string =>
  specOf(node.kind)
    .config.map((field) => (node.config[field.name] ?? "").trim())
    .filter((value) => value !== "")
    .slice(0, 2)
    .join(" · ");

export function Flow(props: FlowProps): JSX.Element {
  // The provider has to sit outside the component that calls `useReactFlow`,
  // which is where the canvas gets `screenToFlowPosition` and `fitView`.
  return (
    <ReactFlowProvider>
      <Modeler {...props} />
    </ReactFlowProvider>
  );
}

function Modeler({ projectId, onError }: FlowProps): JSX.Element {
  const split = useSplit("flow", projectId ?? "none", FLOW_COLUMNS, 420);
  const { screenToFlowPosition, fitView } = useReactFlow();

  const [flows, setFlows] = useState<FlowGraph[]>([]);
  const [graph, setGraph] = useState<FlowGraph>(() => emptyGraph("Untitled diagram", projectId));
  const [history, setHistory] = useState<FlowGraph[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [labelling, setLabelling] = useState<string | null>(null);
  const [term, setTerm] = useState("");
  const [drawer, setDrawer] = useState<"checks" | "outline" | "export">("checks");
  const [iqCells, setIqCells] = useState<IqCellCard[]>([]);
  const [published, setPublished] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [asking, setAsking] = useState(false);
  const [rawAnswer, setRawAnswer] = useState<string | null>(null);

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** The graph as it was when the current drag started, for a one-step undo. */
  const dragOrigin = useRef<FlowGraph | null>(null);
  const graphRef = useRef<FlowGraph>(graph);
  graphRef.current = graph;

  const problems = useMemo(() => validate(graph), [graph]);
  const hash = useMemo(() => sourceHash(graph), [graph]);
  const ordered = useMemo(() => topoOrder(graph), [graph]);

  useEffect(() => {
    setFlows(listFlows(projectId));
    setIqCells(editorCells(projectId));
  }, [projectId]);

  /**
   * A diagram handed over by another surface — My IQ's Edit
   * control is the one that does this today.
   *
   * Both paths are needed. The read runs on mount for the case where this
   * surface was not open, and the event covers the case where it was:
   * switching back to a tab that already exists does not remount it, so a
   * mount-time read alone would leave the user staring at whatever was on the
   * canvas before.
   */
  useEffect(() => {
    const adopt = (): void => {
      const staged = takeStagedFlow(projectId);
      if (staged === null) return;
      setFlows(listFlows(projectId));
      setGraph(staged);
      setHistory([]);
      setSelected(null);
      setSelectedEdge(null);
      setNotice(
        `Opened ${staged.name}. This diagram was rebuilt from what the IQ Cell declares, not loaded from a stored source, because the demo library has none.`,
      );
    };
    adopt();
    // Through the store, not a bare `window` listener: the handoff is a
    // contract between two surfaces, and the store is what declares it.
    return onFlowStaged(adopt);
  }, [projectId]);

  // A published record belongs to the diagram that produced it: any edit means
  // the badge no longer describes what is on screen.
  useEffect(() => {
    setPublished(null);
  }, [hash]);

  const commit = useCallback((next: FlowGraph) => {
    setHistory((stack) => [...stack.slice(-40), graphRef.current]);
    setGraph(next);
  }, []);

  const mutate = useCallback((fn: (current: FlowGraph) => FlowGraph) => {
    setGraph((current) => {
      setHistory((stack) => [...stack.slice(-40), current]);
      return fn(current);
    });
  }, []);

  const undo = useCallback(() => {
    setHistory((stack) => {
      const previous = stack.at(-1);
      if (previous === undefined) return stack;
      setGraph(previous);
      return stack.slice(0, -1);
    });
  }, []);

  // Ctrl/⌘+Z steps back, but never while someone is typing into a field.
  // Delete is React Flow's own, and it applies the same rule.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target !== null && target.isContentEditable) return;
      if (event.key !== "z" && event.key !== "Z") return;
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  const persist = useCallback(() => {
    try {
      saveFlow(projectId, graph);
      setFlows(listFlows(projectId));
      setNotice("Saved to this device.");
    } catch (problem) {
      onError(problem);
    }
  }, [graph, onError, projectId]);

  // ── the canvas ─────────────────────────────────────────────────────────

  const renameNode = useCallback(
    (id: string, label: string) => mutate((current) => updateNode(current, id, { label })),
    [mutate],
  );
  const endRename = useCallback(() => setRenaming(null), []);

  const labelEdge = useCallback(
    (id: string, label: string) => mutate((current) => updateEdge(current, id, { label })),
    [mutate],
  );

  const rfNodes = useMemo<FlowRfNode[]>(
    () =>
      graph.nodes.map((node) => {
        const own = problems.filter((problem) => problem.nodeId === node.id);
        const data: NodeData = {
          kind: node.kind,
          label: node.label,
          detail: detailOf(node),
          flag: own.some((problem) => problem.severity === "error")
            ? "error"
            : own.some((problem) => problem.severity === "warning")
              ? "warning"
              : "",
          renaming: renaming === node.id,
          onRename: renameNode,
          onRenameEnd: endRename,
        };
        return {
          id: node.id,
          type: typeOf(node.kind),
          position: { x: node.x, y: node.y },
          selected: selected === node.id,
          data,
        };
      }),
    [graph.nodes, problems, renaming, selected, renameNode, endRename],
  );

  const rfEdges = useMemo<FlowRfEdge[]>(() => {
    const at = new Map(graph.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
    const ranks = ranksOf(graph.nodes);
    /** True when a rank sits between these two, so the arrow would cross it. */
    const jumps = (from: { y: number }, to: { y: number }): boolean => {
      const top = Math.min(from.y, to.y) + SAME_RANK;
      const bottom = Math.max(from.y, to.y) - SAME_RANK;
      return ranks.some((y) => y > top && y < bottom);
    };
    // A node that is not there is a broken edge, not a layout question. It is
    // drawn with the downward pair and left for the checks to report.
    const sides = new Map(
      graph.edges.map((edge) => {
        const from = at.get(edge.from);
        const to = at.get(edge.to);
        const pair =
          from && to ? sidesFor(from, to, jumps(from, to)) : { source: "b", target: "t" };
        return [edge.id, pair] as const;
      }),
    );
    const shifts = spreadEdges(graph.edges, sides);

    return graph.edges.map((edge) => {
      const shift = shifts.get(edge.id) ?? { from: 0, to: 0 };
      const data: EdgeData = {
        label: edge.label,
        dashed: edge.style === "dashed",
        editing: labelling === edge.id,
        fromShift: shift.from,
        toShift: shift.to,
        onLabel: labelEdge,
        onEdit: setLabelling,
      };
      const side = sides.get(edge.id) ?? { source: "b", target: "t" };
      return {
        id: edge.id,
        source: edge.from,
        target: edge.to,
        sourceHandle: side.source,
        targetHandle: side.target,
        type: "iq",
        selected: selectedEdge === edge.id,
        data,
      };
    });
  }, [graph.edges, graph.nodes, labelling, selectedEdge, labelEdge]);

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowRfNode>[]): void => {
      for (const change of changes) {
        if (change.type === "select") {
          const { id, selected: on } = change;
          setSelected((current) => (on ? id : current === id ? null : current));
          if (on) setSelectedEdge(null);
          continue;
        }
        if (change.type === "remove") {
          const { id } = change;
          mutate((current) => removeNode(current, id));
          setSelected((current) => (current === id ? null : current));
          continue;
        }
        if (change.type !== "position") continue;
        const at = change.position;
        if (at === undefined) continue;
        // A drag is one gesture, not fifty edits: the snapshot is taken once,
        // when the drag starts, so a single undo puts the node back where it
        // was picked up from.
        if (change.dragging === true && dragOrigin.current === null) {
          dragOrigin.current = graphRef.current;
        }
        const { id } = change;
        setGraph((current) => updateNode(current, id, { x: at.x, y: at.y }));
        if (change.dragging === false && dragOrigin.current !== null) {
          const before = dragOrigin.current;
          dragOrigin.current = null;
          setHistory((stack) => [...stack.slice(-40), before]);
        }
      }
    },
    [mutate],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<FlowRfEdge>[]): void => {
      for (const change of changes) {
        if (change.type === "select") {
          const { id, selected: on } = change;
          setSelectedEdge((current) => (on ? id : current === id ? null : current));
          if (on) setSelected(null);
          continue;
        }
        if (change.type !== "remove") continue;
        const { id } = change;
        mutate((current) => removeEdge(current, id));
        setSelectedEdge((current) => (current === id ? null : current));
      }
    },
    [mutate],
  );

  /**
   * Drawing an arrow.
   *
   * `connect` in `graph.ts` is the gatekeeper, here as everywhere else: the
   * canvas never writes an edge itself, so the rules about what may be joined
   * are stated once and are testable without a canvas.
   */
  const onConnect = useCallback(
    (connection: Connection): void => {
      const outcome = connect(graphRef.current, {
        from: connection.source,
        to: connection.target,
      });
      if (!outcome.ok) {
        setNotice(outcome.reason);
        return;
      }
      commit(outcome.graph);
      setSelectedEdge(outcome.edge.id);
      setSelected(null);
    },
    [commit],
  );

  const place = useCallback(
    (kind: FlowNodeKind, at?: { x: number; y: number }) => {
      mutate((current) => {
        const spot = at ?? {
          x: 120 + current.nodes.length * 24,
          y: 60 + current.nodes.length * 40,
        };
        const result = addNode(current, kind, spot.x, spot.y);
        setSelected(result.node.id);
        return result.graph;
      });
    },
    [mutate],
  );

  // ── describe your process ──────────────────────────────────────────────

  /**
   * Ask for a diagram in plain English.
   *
   * The answer never overwrites what is on the canvas. Someone typing a
   * sentence is adding a diagram, not discarding the one they were drawing, so
   * the result lands as a new draft and the previous one is still in the list.
   */
  const askForOne = useCallback(async (): Promise<void> => {
    const text = prompt.trim();
    if (text === "" || asking) return;
    setAsking(true);
    setRawAnswer(null);
    setNotice("Asking for a diagram…");
    try {
      const answer = await askForDiagram(text, projectId);
      if (answer.graph === null) {
        setRawAnswer(answer.text);
        setDrawer("export");
        setNotice("That reply was not a diagram this canvas reads. The text is in the Export tab.");
        return;
      }
      commit(answer.graph);
      setSelected(null);
      setSelectedEdge(null);
      setPrompt("");
      setNotice(`Drew "${answer.graph.name}". Check it, then Save to keep it.`);
      window.setTimeout(() => void fitView({ padding: 0.2 }), 0);
    } catch (problem) {
      onError(problem);
      setNotice(null);
    } finally {
      setAsking(false);
    }
  }, [asking, commit, fitView, onError, projectId, prompt]);

  // ── publishing ─────────────────────────────────────────────────────────

  const publish = useCallback(() => {
    if (graph.nodes.length === 0) return;
    try {
      const card = publishIqCell(projectId, graph, "editor");
      setIqCells(editorCells(projectId));
      setPublished(card.id);
      setNotice(`Recorded ${card.name} v${card.version} in the IQ Cell library.`);
    } catch (problem) {
      onError(problem);
    }
  }, [graph, onError, projectId]);

  // ── derived ────────────────────────────────────────────────────────────

  const selectedNode = selected === null ? null : nodeOf(graph, selected);
  const activeEdge = selectedEdge === null ? null : edgeOf(graph, selectedEdge);
  const errors = problems.filter((problem) => problem.severity === "error").length;
  const warnings = problems.filter((problem) => problem.severity === "warning").length;

  /**
   * Three words, and they describe the drawing rather than a build.
   *
   * Invalid is something a reader would stumble over — no Start, mainly.
   * Draft is a diagram with loose ends: an unreachable step, a decision whose
   * answers were never written on its arrows. Complete means the checks found
   * nothing, not that anything was produced.
   */
  const state = blocking(problems) ? "Invalid" : warnings > 0 ? "Draft" : "Complete";

  return (
    <div className="flow">
      <header className="flow-head">
        <span className="flow-title">
          <Workflow size={16} aria-hidden="true" />
          <input
            value={graph.name}
            aria-label="Diagram name"
            onChange={(event) => setGraph({ ...graph, name: event.target.value })}
          />
        </span>
        <span className={`flow-state ${state.toLowerCase()}`}>{state}</span>
        <span className="flow-hash" title="Source hash — layout never changes it">
          {hash}
        </span>

        <label className="field describe">
          <Sparkles size={14} aria-hidden="true" />
          <input
            value={prompt}
            disabled={asking}
            placeholder="Describe your process"
            aria-label="Describe your process"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void askForOne();
            }}
          />
        </label>
        <button
          className="ghost"
          onClick={() => void askForOne()}
          disabled={asking || prompt.trim() === ""}
          title="Ask for a diagram, then edit it here"
        >
          {asking ? "Drawing…" : "Draw it"}
        </button>

        <span className="spacer" />

        <label className="field sample" title="Open a worked example">
          <select
            value=""
            aria-label="Open a sample diagram"
            onChange={(event) => {
              const template = TEMPLATES.find((row) => row.id === event.target.value);
              event.currentTarget.value = "";
              if (template === undefined) return;
              // Replacing a canvas that has work on it is destructive, so ask.
              if (
                graph.nodes.length > 0 &&
                !window.confirm(`Replace the canvas with "${template.name}"?`)
              ) {
                return;
              }
              commit(fromTemplate(template, projectId));
              setNotice(`Opened the "${template.name}" sample. ${template.detail}`);
            }}
          >
            <option value="">Samples…</option>
            {TEMPLATES.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </label>
        <button className="ghost" onClick={() => setDrawer("checks")} title="Checks">
          <CircleAlert size={14} aria-hidden="true" /> {errors} · {warnings}
        </button>
        <button
          className="ghost"
          onClick={() => {
            if (graph.nodes.length === 0 && graph.edges.length === 0) return;
            // Emptying a canvas someone has worked on is the one action here
            // that undo alone cannot obviously walk back, so it asks first.
            if (!window.confirm(`Clear every node from "${graph.name}"?`)) return;
            // The diagram keeps its id and name. Clearing is "start this one
            // over", not "start a different one" — a new id would leave the
            // saved diagram behind under the same name and make the list read
            // as two of the same thing.
            commit({ ...graph, nodes: [], edges: [] });
            setSelected(null);
            setSelectedEdge(null);
            setNotice("Canvas cleared. Undo with Ctrl+Z, or Save to keep it empty.");
          }}
          disabled={graph.nodes.length === 0}
          title="Remove every node and arrow from this diagram"
        >
          <Eraser size={14} aria-hidden="true" /> Clear
        </button>
        <button className="ghost" onClick={persist}>
          Save
        </button>
        <button className="primary" onClick={publish} disabled={graph.nodes.length === 0}>
          <Package size={14} aria-hidden="true" /> {published === null ? "Publish" : "Published"}
        </button>
      </header>

      {notice !== null && (
        <div className="flow-notice" onClick={() => setNotice(null)} role="status">
          {notice} <span className="muted">(click to dismiss)</span>
        </div>
      )}

      <div
        className="flow-body"
        ref={split.containerRef}
        style={{ gridTemplateColumns: split.template }}
      >
        <aside className="flow-palette">
          <label className="field search">
            <Search size={14} aria-hidden="true" />
            <input
              value={term}
              placeholder="decision, document, outcome"
              aria-label="Search the palette"
              onChange={(event) => setTerm(event.target.value)}
            />
          </label>

          {FAMILY_ORDER.map((family) => {
            const specs = searchSpecs(term).filter((spec) => spec.family === family);
            if (specs.length === 0) return null;
            return (
              <section key={family}>
                <h4>{FAMILY_LABELS[family]}</h4>
                {specs.map((spec) => (
                  <button
                    key={spec.kind}
                    className={`palette-item family-${spec.family}`}
                    data-flow-palette={spec.kind}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "copy";
                      event.dataTransfer.setData("text/iq-node", spec.kind);
                    }}
                    onDoubleClick={() => place(spec.kind)}
                    onClick={() => place(spec.kind)}
                    title={spec.detail}
                  >
                    <span className={`shape-mark ${spec.shape}`} aria-hidden="true" />
                    <strong>{spec.label}</strong>
                    <span className="muted">{spec.detail}</span>
                  </button>
                ))}
              </section>
            );
          })}

          <section>
            <h4>Samples</h4>
            {TEMPLATES.map((template) => (
              <button
                key={template.id}
                className="palette-item template"
                onClick={() => commit(fromTemplate(template, projectId))}
              >
                <strong>{template.name}</strong>
                <span className="muted">{template.detail}</span>
              </button>
            ))}
          </section>
        </aside>

        <SplitDivider
          label="Resize node list"
          onPointerDown={(event) => split.startDrag("palette", event)}
        />

        <div
          className="flow-canvas"
          ref={surfaceRef}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(event) => {
            const dropped = event.dataTransfer.getData("text/iq-node");
            if (dropped === "") return;
            event.preventDefault();
            // Drop under the cursor, not with a corner at it.
            const at = screenToFlowPosition({ x: event.clientX, y: event.clientY });
            place(dropped as FlowNodeKind, { x: at.x - 84, y: at.y - 28 });
          }}
        >
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDoubleClick={(_event, node) => setRenaming(node.id)}
            onEdgeDoubleClick={(_event, edge) => setLabelling(edge.id)}
            onPaneClick={() => {
              setSelected(null);
              setSelectedEdge(null);
            }}
            // Loose, because every handle is both an entry and an exit: a chase
            // loop goes back up the left of the page, and a diagram should not
            // have to be laid out to suit the tool.
            connectionMode={ConnectionMode.Loose}
            isValidConnection={(connection) => connection.source !== connection.target}
            snapToGrid
            snapGrid={[8, 8]}
            deleteKeyCode={["Delete", "Backspace"]}
            minZoom={0.2}
            maxZoom={2.2}
            fitView
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>

          {graph.nodes.length === 0 && (
            <div className="flow-empty">
              <strong>Start with a Start</strong>
              <span className="muted">
                Drag one in from the list, open a sample, or describe your process in the box above.
              </span>
            </div>
          )}
        </div>

        <SplitDivider
          label="Resize inspector"
          onPointerDown={(event) => split.startDrag("inspector", event)}
        />

        <aside className="flow-inspector">
          {selectedNode !== null ? (
            <Inspector
              node={selectedNode}
              problems={problems.filter((problem) => problem.nodeId === selectedNode.id)}
              onChange={(patch) => mutate((current) => updateNode(current, selectedNode.id, patch))}
              onDelete={() => {
                mutate((current) => removeNode(current, selectedNode.id));
                setSelected(null);
              }}
            />
          ) : activeEdge !== null ? (
            <EdgeInspector
              edge={activeEdge}
              fromLabel={nodeOf(graph, activeEdge.from)?.label ?? "somewhere"}
              toLabel={nodeOf(graph, activeEdge.to)?.label ?? "somewhere"}
              onChange={(patch) => mutate((current) => updateEdge(current, activeEdge.id, patch))}
              onDelete={() => {
                mutate((current) => removeEdge(current, activeEdge.id));
                setSelectedEdge(null);
              }}
            />
          ) : (
            <FlowSummary
              graph={graph}
              flows={flows}
              iqCells={iqCells}
              onOpen={(next) => {
                setGraph(next);
                setSelected(null);
                setSelectedEdge(null);
              }}
              onNew={() => commit(emptyGraph("Untitled diagram", projectId))}
              onDelete={(id) => {
                deleteFlow(projectId, id);
                setFlows(listFlows(projectId));
              }}
              onExport={() =>
                download(`${graph.name}.iqcell.json`, exportBundle(graph), "application/json")
              }
              onImport={() => fileRef.current?.click()}
              onOpenCell={(card) => {
                // A cell records one published version of a diagram. Opening it
                // loads that diagram if it still exists, and says so plainly if
                // it was deleted, rather than silently doing nothing.
                const source = flows.find((row) => row.id === card.flowId);
                if (source === undefined) {
                  setNotice(
                    card.origin === "editor"
                      ? `${card.name} was published from a diagram that is no longer saved on this device.`
                      : // Recorded somewhere else entirely. Saying its diagram
                        // is missing would imply it was drawn here, which is
                        // the one thing the origin exists to keep straight.
                        `${card.name} was recorded in ${IQ_CELL_ORIGIN_LABELS[card.origin]}, not on this canvas, so there is no diagram to open. Open it there instead.`,
                  );
                  return;
                }
                setGraph(source);
                setSelected(null);
                setSelectedEdge(null);
                setNotice(
                  `Opened ${source.name} — the diagram ${card.name} v${card.version} was published from.`,
                );
              }}
              onRenameCell={(id, name) => setIqCells(renameIqCell(projectId, id, name))}
              onDeleteCell={(card) => {
                if (
                  !window.confirm(
                    `Remove ${card.name} v${card.version} from the IQ Cell library? The diagram it was published from is kept.`,
                  )
                ) {
                  return;
                }
                setIqCells(deleteIqCell(projectId, card.id));
                if (published === card.id) setPublished(null);
                setNotice(`Removed ${card.name} from the IQ Cell library.`);
              }}
            />
          )}
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file === undefined) return;
              void file.text().then((text) => {
                try {
                  commit(importBundle(text, projectId));
                } catch (problem) {
                  onError(problem);
                }
              });
              event.target.value = "";
            }}
          />
        </aside>
      </div>

      <section className="flow-drawer">
        <div className="tabs">
          {(["checks", "outline", "export"] as const).map((view) => (
            <button
              key={view}
              className={drawer === view ? "active" : ""}
              data-flow-tab={view}
              onClick={() => setDrawer(view)}
            >
              {view === "checks"
                ? `Checks (${problems.length})`
                : view === "outline"
                  ? `Outline (${graph.nodes.length})`
                  : "Export"}
            </button>
          ))}
          <span className="spacer" />
          <button className="ghost" onClick={undo} disabled={history.length === 0}>
            Undo
          </button>
        </div>

        <div className="drawer-body">
          {drawer === "checks" && <Checks problems={problems} onSelect={setSelected} />}
          {drawer === "outline" && <Outline nodes={ordered} onSelect={setSelected} />}
          {drawer === "export" && (
            <ExportPane
              graph={graph}
              raw={rawAnswer}
              surface={surfaceRef}
              onNotice={setNotice}
              onError={onError}
            />
          )}
        </div>
      </section>
    </div>
  );
}

// ── pieces ────────────────────────────────────────────────────────────────

function Inspector({
  node,
  problems,
  onChange,
  onDelete,
}: {
  node: FlowNode;
  problems: FlowDiagnostic[];
  onChange: (patch: Partial<FlowNode>) => void;
  onDelete: () => void;
}): JSX.Element {
  const spec = specOf(node.kind);
  const set = (name: string, value: string): void =>
    onChange({ config: { ...node.config, [name]: value } });

  return (
    <div className="stack">
      <div className="card">
        <h3 className="inspector-title">
          <span className={`shape-mark ${spec.shape}`} aria-hidden="true" />
          {spec.label}
        </h3>
        <p className="muted">{spec.detail}</p>
        <label className="field">
          <span>Label</span>
          <input value={node.label} onChange={(event) => onChange({ label: event.target.value })} />
        </label>

        {spec.config.map((field: ConfigField) => (
          <label className="field" key={field.name}>
            <span>{field.label}</span>
            {field.kind === "textarea" ? (
              <textarea
                rows={3}
                value={node.config[field.name] ?? ""}
                placeholder={field.placeholder}
                onChange={(event) => set(field.name, event.target.value)}
              />
            ) : field.kind === "select" ? (
              <select
                value={node.config[field.name] ?? ""}
                onChange={(event) => set(field.name, event.target.value)}
              >
                <option value="">Choose…</option>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={field.kind === "number" ? "number" : "text"}
                value={node.config[field.name] ?? ""}
                placeholder={field.placeholder}
                onChange={(event) => set(field.name, event.target.value)}
              />
            )}
          </label>
        ))}
      </div>

      {problems.length > 0 && (
        <div className="card">
          <h3>Checks</h3>
          {problems.map((problem, index) => (
            <p key={index} className={`diag ${problem.severity}`}>
              <code>{problem.code}</code> {problem.message}
            </p>
          ))}
        </div>
      )}

      <div className="card">
        <button className="danger" onClick={onDelete}>
          <Trash2 size={14} aria-hidden="true" /> Delete node
        </button>
      </div>
    </div>
  );
}

/**
 * The arrow inspector.
 *
 * Two fields, and the first is the point of the notation: the answers to a
 * decision are written on the arrows leaving it, so an arrow that cannot be
 * labelled turns every diamond into a shape with no branches. Style is here
 * because a dashed link is how a note is attached without claiming the note is
 * a step.
 */
function EdgeInspector({
  edge,
  fromLabel,
  toLabel,
  onChange,
  onDelete,
}: {
  edge: FlowEdge;
  fromLabel: string;
  toLabel: string;
  onChange: (patch: Partial<Omit<FlowEdge, "id" | "from" | "to">>) => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <div className="stack">
      <div className="card">
        <h3>Arrow</h3>
        <p className="muted">
          {fromLabel} → {toLabel}
        </p>
        <label className="field">
          <span>Label</span>
          <input
            value={edge.label}
            placeholder="yes"
            aria-label="Arrow label"
            onChange={(event) => onChange({ label: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Style</span>
          <select
            value={edge.style}
            aria-label="Arrow style"
            onChange={(event) =>
              onChange({ style: event.target.value === "dashed" ? "dashed" : "solid" })
            }
          >
            <option value="solid">Solid</option>
            <option value="dashed">Dashed</option>
          </select>
        </label>
      </div>
      <div className="card">
        <button className="danger" onClick={onDelete}>
          <Trash2 size={14} aria-hidden="true" /> Delete arrow
        </button>
      </div>
    </div>
  );
}

function FlowSummary({
  graph,
  flows,
  iqCells,
  onOpen,
  onNew,
  onDelete,
  onExport,
  onImport,
  onOpenCell,
  onRenameCell,
  onDeleteCell,
}: {
  graph: FlowGraph;
  flows: FlowGraph[];
  iqCells: IqCellCard[];
  onOpen: (graph: FlowGraph) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onExport: () => void;
  onImport: () => void;
  onOpenCell: (card: IqCellCard) => void;
  onRenameCell: (id: string, name: string) => void;
  onDeleteCell: (card: IqCellCard) => void;
}): JSX.Element {
  return (
    <div className="stack">
      <div className="card">
        <h3>This diagram</h3>
        <p className="muted">
          Select a node or an arrow to describe it. Nothing here runs — the canvas says how the work
          happens, and Export takes it elsewhere.
        </p>
        <div className="row">
          <button className="ghost" onClick={onNew}>
            <Plus size={14} aria-hidden="true" /> New
          </button>
          <button className="ghost" onClick={onExport}>
            <Download size={14} aria-hidden="true" /> Export
          </button>
          <button className="ghost" onClick={onImport}>
            <Upload size={14} aria-hidden="true" /> Import
          </button>
        </div>
      </div>

      {/* The library comes first because it is the finished work. Saved
          diagrams are the workbench under it — reachable, but not the thing
          you scan for.

          Scoped to this surface, hence the parenthetical. Every row here opens
          a diagram on the canvas beside it, and a cell recorded elsewhere has
          none — offering one would be a control that cannot do what it says.
          The IQ Cell library destination lists them all and routes each to its
          own surface. */}
      <div className="card">
        <h3>IQ Cell library (Workflow)</h3>
        {iqCells.length === 0 && <p className="muted">Publish a diagram to record an IQ Cell.</p>}
        {iqCells.map((card) => (
          <IqCellRow
            key={card.id}
            card={card}
            open={card.flowId === graph.id}
            onOpen={() => onOpenCell(card)}
            onRename={(name) => onRenameCell(card.id, name)}
            onDelete={() => onDeleteCell(card)}
          />
        ))}
      </div>

      <div className="card">
        <h3>Saved diagrams</h3>
        {flows.length === 0 && <p className="muted">Nothing saved on this device yet.</p>}
        {flows.map((saved) => (
          <div className="row between" key={saved.id}>
            <button className="link" onClick={() => onOpen(saved)}>
              <FileCode2 size={14} aria-hidden="true" /> {saved.name}
              {saved.id === graph.id && <em> · open</em>}
            </button>
            <button
              className="icon"
              aria-label={`Delete ${saved.name}`}
              onClick={() => onDelete(saved.id)}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Checks({
  problems,
  onSelect,
}: {
  problems: FlowDiagnostic[];
  onSelect: (id: string) => void;
}): JSX.Element {
  if (problems.length === 0) return <p className="muted">Nothing to report.</p>;
  return (
    <ul className="diagnostics">
      {problems.map((problem, index) => (
        <li key={index} className={problem.severity}>
          {problem.severity === "error" ? (
            <CircleAlert size={14} aria-hidden="true" />
          ) : problem.severity === "warning" ? (
            <AlertTriangle size={14} aria-hidden="true" />
          ) : (
            <Info size={14} aria-hidden="true" />
          )}
          <code>{problem.code}</code>
          {problem.nodeId === null ? (
            <span>{problem.message}</span>
          ) : (
            <button className="link" onClick={() => onSelect(problem.nodeId as string)}>
              {problem.message}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The diagram as a list.
 *
 * The keyboard path through the canvas, and the thing a screen reader can
 * follow. Reading order comes from `topoOrder`, which falls back to insertion
 * order where a loop makes a topological order impossible — every node is
 * listed either way.
 */
function Outline({
  nodes,
  onSelect,
}: {
  nodes: FlowNode[];
  onSelect: (id: string) => void;
}): JSX.Element {
  if (nodes.length === 0) return <p className="muted">Nothing on the canvas.</p>;
  return (
    <ol className="flow-outline-list">
      {nodes.map((node) => (
        <li key={node.id}>
          <button className="link" onClick={() => onSelect(node.id)}>
            <span className={`shape-mark ${specOf(node.kind).shape}`} aria-hidden="true" />
            {node.label} — {specOf(node.kind).label}
          </button>
        </li>
      ))}
    </ol>
  );
}

/**
 * Getting the diagram out.
 *
 * Mermaid first, because it is the format that stays a diagram: it can be
 * pasted into a wiki, a pull request or an IQ Industry primer, and it comes
 * back onto this canvas unchanged. Markdown is the same diagram for people who
 * cannot render one, and SVG is for a slide.
 */
function ExportPane({
  graph,
  raw,
  surface,
  onNotice,
  onError,
}: {
  graph: FlowGraph;
  raw: string | null;
  surface: { current: HTMLDivElement | null };
  onNotice: (message: string) => void;
  onError: (problem: unknown) => void;
}): JSX.Element {
  const mermaid = toMermaid(graph);

  const copy = (label: string, text: string): void => {
    navigator.clipboard.writeText(text).then(
      () => onNotice(`${label} copied.`),
      (problem: unknown) => onError(problem),
    );
  };

  return (
    <div className="contract-pane">
      {raw !== null && (
        <div className="card">
          <h3>What the agent said</h3>
          <p className="muted">
            No diagram was drawn from this, so the canvas is unchanged. The reply is below as it
            arrived.
          </p>
          <pre className="contract">{raw}</pre>
        </div>
      )}

      <div className="row">
        <button className="ghost" onClick={() => copy("Mermaid", mermaid)}>
          <Copy size={14} aria-hidden="true" /> Copy Mermaid
        </button>
        <button
          className="ghost"
          onClick={() => download(`${graph.name}.mmd`, mermaid, "text/plain")}
        >
          <Download size={14} aria-hidden="true" /> Download .mmd
        </button>
        <button className="ghost" onClick={() => copy("Markdown", toMarkdown(graph))}>
          <Copy size={14} aria-hidden="true" /> Copy Markdown
        </button>
        <button
          className="ghost"
          onClick={() => download(`${graph.name}.md`, toMarkdown(graph), "text/markdown")}
        >
          <Download size={14} aria-hidden="true" /> Download .md
        </button>
        <button
          className="ghost"
          onClick={() => {
            const svg = toSvg(surface.current);
            if (svg === null) {
              onNotice("The canvas is not on screen, so there is nothing to draw.");
              return;
            }
            download(`${graph.name}.svg`, svg, "image/svg+xml");
          }}
        >
          <Download size={14} aria-hidden="true" /> Download .svg
        </button>
      </div>

      <pre className="contract" data-flow-mermaid>
        {mermaid}
      </pre>
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────

const download = (name: string, text: string, type: string): void => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
};
