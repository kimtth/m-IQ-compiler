import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import Sigma from "sigma";
import type { KnowledgeGraph } from "@iq/shared";
import { buildLayout, type EdgeAttributes, type NodeAttributes } from "./layout.js";

/**
 * The knowledge graph, drawn by sigma.
 *
 * Sigma owns the canvases, the camera and the hit testing; React owns the
 * controls around them. The two meet at exactly two points: the reducers,
 * which sigma calls per node and per edge on every frame, and `refresh`,
 * which is how a React state change reaches a WebGL scene. Nothing about the
 * picture is a React element, which is the point — the previous renderer
 * rebuilt an SVG of five hundred nodes on every pan.
 */

const MIN_CAMERA_RATIO = 1 / 12;
const MAX_CAMERA_RATIO = 4;
/** Below two characters a search matches most of a vault and dims nothing. */
const MIN_FIND = 2;

/** Sigma cannot resolve a CSS custom property, so the colours are read out. */
interface Palette {
  node: string;
  link: string;
  selected: string;
  label: string;
  dim: string;
}

function paletteOf(element: Element | null): Palette {
  const styles = element ? getComputedStyle(element) : null;
  const colour = (name: string, fallback: string): string =>
    styles?.getPropertyValue(name).trim() || fallback;
  return {
    node: colour("--graph-node", "#4a4a4a"),
    link: colour("--graph-link", "#b8b8b8"),
    selected: colour("--primary", "#171717"),
    label: colour("--fg", "#171717"),
    // Pushed back rather than hidden: a dimmed node still says something is
    // there, and hiding it would make hovering look like deletion.
    dim: colour("--graph-link", "#b8b8b8"),
  };
}

export function GraphView({
  graph: knowledge,
  selectedId,
  onSelect,
}: {
  graph: KnowledgeGraph;
  selectedId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const frame = useRef<HTMLDivElement>(null);
  const sigma = useRef<Sigma<NodeAttributes, EdgeAttributes> | null>(null);
  const [find, setFind] = useState("");
  const [zoom, setZoom] = useState(100);
  const [theme, setTheme] = useState(0);

  const palette = useMemo(() => paletteOf(document.documentElement), [theme]);
  const { graph, hidden } = useMemo(() => buildLayout(knowledge), [knowledge]);

  /**
   * What the reducers read.
   *
   * They are installed once and then called by sigma on every frame, so they
   * cannot close over state without going stale. Refs let the settings stay
   * fixed while the values behind them change.
   */
  const hover = useRef<string | null>(null);
  const selected = useRef(selectedId);
  const matches = useRef<Set<string> | null>(null);
  const colours = useRef(palette);
  colours.current = palette;

  const draw = useCallback((): void => {
    sigma.current?.refresh({ skipIndexation: true });
  }, []);

  useEffect(() => {
    selected.current = selectedId;
    draw();
  }, [draw, selectedId]);

  useEffect(() => {
    const term = find.trim().toLowerCase();
    matches.current =
      term.length < MIN_FIND
        ? null
        : new Set(
            graph.filterNodes(
              (_id, data) =>
                data.title.toLowerCase().includes(term) ||
                data.path.toLowerCase().includes(term),
            ),
          );
    draw();
  }, [draw, find, graph]);

  // A canvas does not inherit CSS colours. Repaint when the theme changes so
  // the graph keeps its contrast on both the light and the dark surface.
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme((version) => version + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = frame.current;
    if (host === null) return;

    const renderer = new Sigma(graph, host, {
      // The container is a flex child that may not have been measured yet;
      // sigma resizes itself once it has been.
      allowInvalidContainer: true,
      minCameraRatio: MIN_CAMERA_RATIO,
      maxCameraRatio: MAX_CAMERA_RATIO,
      defaultNodeColor: colours.current.node,
      defaultEdgeColor: colours.current.link,
      labelColor: { color: colours.current.label },
      labelSize: 11,
      labelDensity: 0.5,
      // A label should annotate a visible node, not eclipse a small one.
      labelRenderedSizeThreshold: 8,
      // Edges are the shape; dropping them while panning is what makes a large
      // vault feel like it is being dragged rather than redrawn.
      hideEdgesOnMove: graph.order > 1200,
      hideLabelsOnMove: true,
      enableEdgeEvents: false,
      zIndex: true,
      nodeReducer: (node, data) => {
        const paint = colours.current;
        const focus = hover.current;
        const found = matches.current;
        const near = focus === null || focus === node || graph.areNeighbors(focus, node);
        const missed = found !== null && !found.has(node);
        const isSelected = node === selected.current;
        const dimmed = !near || missed;
        return {
          ...data,
          color: isSelected ? paint.selected : dimmed ? paint.dim : paint.node,
          highlighted: isSelected || focus === node,
          forceLabel: isSelected || focus === node || (found !== null && !missed),
          label: dimmed && !isSelected ? "" : data.label,
          zIndex: isSelected || focus === node ? 2 : dimmed ? 0 : 1,
        };
      },
      edgeReducer: (edge, data) => {
        const paint = colours.current;
        const focus = hover.current;
        if (focus === null) return { ...data, color: paint.link };
        // Hovering lifts a note and what it links to, and pushes the rest back.
        return graph.hasExtremity(edge, focus)
          ? { ...data, color: paint.label, zIndex: 1 }
          : { ...data, hidden: true };
      },
    });

    sigma.current = renderer;
    const camera = renderer.getCamera();
    const report = (): void => setZoom(Math.round(100 / camera.ratio));
    report();

    camera.on("updated", report);
    renderer.on("enterNode", ({ node }) => {
      hover.current = node;
      renderer.refresh({ skipIndexation: true });
    });
    renderer.on("leaveNode", () => {
      hover.current = null;
      renderer.refresh({ skipIndexation: true });
    });
    renderer.on("clickNode", ({ node }) => onSelect(node));

    return () => {
      camera.off("updated", report);
      renderer.kill();
      sigma.current = null;
    };
    // `onSelect` is deliberately excluded: it changes identity on every render
    // of the parent, and rebuilding a WebGL scene for that would throw the
    // camera away mid-gesture. The handler only forwards an id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  // Re-paint on a theme change without rebuilding the scene. The reducers read
  // `colours` on every frame, so only the defaults need restating.
  useEffect(() => {
    sigma.current?.setSettings({
      defaultNodeColor: palette.node,
      defaultEdgeColor: palette.link,
      labelColor: { color: palette.label },
    });
    draw();
  }, [draw, palette]);

  const zoomBy = useCallback((into: boolean): void => {
    const camera = sigma.current?.getCamera();
    if (camera === undefined) return;
    void (into ? camera.animatedZoom({ duration: 200 }) : camera.animatedUnzoom({ duration: 200 }));
  }, []);

  const fit = useCallback((): void => {
    void sigma.current?.getCamera().animatedReset({ duration: 300 });
  }, []);

  /** Frame a subset: the search hits if there are any, otherwise the selection. */
  const fitToFound = useCallback((): void => {
    const renderer = sigma.current;
    if (renderer === null) return;
    const ids = matches.current ?? (selected.current === null ? null : [selected.current]);
    if (ids === null) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const id of ids) {
      // Display coordinates share the camera's frame, which is the space the
      // camera's own x, y and ratio are expressed in.
      const at = renderer.getNodeDisplayData(id);
      if (at === undefined) continue;
      minX = Math.min(minX, at.x);
      maxX = Math.max(maxX, at.x);
      minY = Math.min(minY, at.y);
      maxY = Math.max(maxY, at.y);
    }
    if (minX === Infinity) return;

    // A single hit has no extent, so it gets a close-up rather than a division
    // by zero.
    const span = Math.max(maxX - minX, maxY - minY, 0.02) * 1.3;
    void renderer.getCamera().animate(
      {
        x: (minX + maxX) / 2,
        y: (minY + maxY) / 2,
        ratio: Math.min(MAX_CAMERA_RATIO, Math.max(MIN_CAMERA_RATIO, span)),
      },
      { duration: 400 },
    );
  }, []);

  const canFitToFound = find.trim().length >= MIN_FIND || selectedId !== null;

  return (
    <div className="card graph-card">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h3>Graph</h3>
        <div className="row">
          {/* A legend for four hues the picture no longer draws would be worse
              than none. What the picture encodes now is size, and kind is
              answered by the table and the detail panel. */}
          <span className="muted">Size · how many things link to it</span>
          {hidden > 0 && <span className="muted">{hidden} more not drawn</span>}
        </div>
      </div>

      <div className="row" style={{ marginBottom: 8 }}>
        <div style={{ width: 200 }}>
          <input
            placeholder="Find a node"
            value={find}
            onChange={(event) => setFind(event.target.value)}
          />
        </div>
        <button className="icon subtle" title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(false)}>
          <Minus className="lucide" size={16} aria-hidden="true" />
        </button>
        <span className="pill">{zoom}%</span>
        <button className="icon subtle" title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(true)}>
          <Plus className="lucide" size={16} aria-hidden="true" />
        </button>
        <button onClick={fit}>Fit</button>
        <button disabled={!canFitToFound} onClick={fitToFound}>
          Zoom to selection
        </button>
      </div>

      <div ref={frame} className="graph-frame" />
      <div className="muted" style={{ marginTop: 6 }}>
        Scroll to zoom, drag to pan. Hover to isolate a note and what it links to; click to see
        where it came from.
      </div>
    </div>
  );
}
