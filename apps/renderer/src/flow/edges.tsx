import type { JSX } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Position,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";

/**
 * The arrow, and the words on it.
 *
 * One custom edge rather than React Flow's built-in label, because the label
 * is the load-bearing part of this notation: a decision asks a question and
 * the answers — "yes", "rejected", "over £10k" — live on the arrows leaving
 * it. A diamond with unlabelled arrows says nothing, so the label has to be
 * editable where the reader is looking, not only in a side panel.
 */

export interface EdgeData extends Record<string, unknown> {
  readonly label: string;
  readonly dashed: boolean;
  /** True while this arrow's label is being typed over on the canvas. */
  readonly editing: boolean;
  /**
   * How far to slide each end along the side it leaves or arrives at.
   *
   * A handle is a single point, so every arrow sharing one starts at the same
   * pixel. A step that reads a document and then runs has two arrows leaving
   * its bottom, and for the stretch where they have not yet diverged they are
   * one line two pixels wide — which reads as a rendering fault rather than as
   * two connections. These pull them apart. Zero for an arrow that has its
   * handle to itself.
   */
  readonly fromShift: number;
  readonly toShift: number;
  readonly onLabel: (id: string, label: string) => void;
  readonly onEdit: (id: string | null) => void;
}

export type FlowRfEdge = Edge<EdgeData>;

/** Slide a point along the side its handle sits on. Top and bottom move in x. */
const slide = (
  x: number,
  y: number,
  position: Position,
  by: number,
): { x: number; y: number } =>
  position === Position.Left || position === Position.Right
    ? { x, y: y + by }
    : { x: x + by, y };

export function IqEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<FlowRfEdge>): JSX.Element {
  const start = slide(sourceX, sourceY, sourcePosition, data?.fromShift ?? 0);
  const end = slide(targetX, targetY, targetPosition, data?.toShift ?? 0);

  const [path, labelX, labelY] = getBezierPath({
    sourceX: start.x,
    sourceY: start.y,
    targetX: end.x,
    targetY: end.y,
    sourcePosition,
    targetPosition,
  });

  const label = data?.label ?? "";
  const dashed = data?.dashed === true;
  const editing = data?.editing === true;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={`iq-edge${dashed ? " dashed" : ""}${selected === true ? " selected" : ""}`}
      />
      {/* Which way the work goes, said by something other than the arrowhead.
          An arrowhead is 6px at the far end of a curve that may loop back up
          the canvas; a mark travelling the path answers "which direction" from
          anywhere on it. Decoration only — nothing on this canvas runs — so it
          is small, slow, and switched off for anyone who has asked for less
          motion (see `.iq-edge-flow` in the canvas stylesheet). */}
      <circle className="iq-edge-flow" r={3}>
        <animateMotion dur="3s" repeatCount="indefinite" path={path} />
      </circle>
      {(label !== "" || editing) && (
        <EdgeLabelRenderer>
          <div
            className="iq-edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            data-flow-edge-label={label}
            onDoubleClick={() => data?.onEdit(id)}
          >
            {editing ? (
              <input
                aria-label="Label this arrow"
                defaultValue={label}
                autoFocus
                onBlur={(event) => {
                  data?.onLabel(id, event.target.value);
                  data?.onEdit(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") data?.onEdit(null);
                }}
              />
            ) : (
              <span>{label}</span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/**
 * Module scope, like the node registry: React Flow rebuilds every edge when
 * this object changes identity.
 */
export const EDGE_TYPES = { iq: IqEdge };
