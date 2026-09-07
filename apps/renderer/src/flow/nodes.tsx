import { memo } from "react";
import type { JSX } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { FlowNodeKind } from "@iq/shared";
import { isRetired, type FlowShape } from "./catalog.js";

/**
 * The seven shapes, as React Flow nodes.
 *
 * One component per kind, because a kind is a thing a reader recognises by its
 * outline: a diamond asks a question, a stadium starts or ends, a box is work.
 * They all delegate to one `Shape`, so the outline is decided in exactly one
 * place and the export can look the shape up in the catalogue rather than
 * guess it from the component.
 *
 * Nothing here is styled inline. The outlines are CSS — a border radius for
 * four of them, a rotated square for the diamond — so a theme change touches
 * the stylesheet and not this file.
 */

export interface NodeData extends Record<string, unknown> {
  readonly kind: FlowNodeKind;
  readonly label: string;
  /** The summary line under the label: owner, system, whichever is filled in. */
  readonly detail: string;
  /** Worst diagnostic severity attached to this node, or "" for none. */
  readonly flag: "" | "warning" | "error";
  /** True while this node's label is being typed over on the canvas. */
  readonly renaming: boolean;
  readonly onRename: (id: string, label: string) => void;
  readonly onRenameEnd: () => void;
}

export type FlowRfNode = Node<NodeData>;

/**
 * Four handles, one per side.
 *
 * A business flow is drawn in whatever direction the page allows — a chase
 * loop goes back up the left, an exception falls out to the right — so pinning
 * a node to one entry and one exit would force the author to lay the diagram
 * out to suit the tool. The canvas runs in loose connection mode, so each of
 * these is both an exit and an entry and the direction of an arrow is decided
 * by which one the author dragged from.
 */
const SIDES: readonly (readonly [string, Position])[] = [
  ["t", Position.Top],
  ["r", Position.Right],
  ["b", Position.Bottom],
  ["l", Position.Left],
];

function Shape({
  id,
  shape,
  data,
  selected,
}: {
  id: string;
  shape: FlowShape;
  data: NodeData;
  selected: boolean;
}): JSX.Element {
  return (
    <div
      className={`iq-node iq-${shape}${selected ? " selected" : ""}${data.flag === "" ? "" : ` flag-${data.flag}`}`}
      data-flow-node={data.kind}
      data-flow-label={data.label}
    >
      <span className="iq-shape" aria-hidden="true" />
      <span className="iq-body">
        {data.renaming ? (
          <input
            className="iq-rename"
            aria-label="Rename this node"
            defaultValue={data.label}
            autoFocus
            onBlur={(event) => {
              data.onRename(id, event.target.value);
              data.onRenameEnd();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") data.onRenameEnd();
            }}
            // Typing in a node must not pan the canvas or delete the node.
            onPointerDown={(event) => event.stopPropagation()}
          />
        ) : (
          <span className="iq-label">{data.label}</span>
        )}
        {data.detail !== "" && !data.renaming && <span className="iq-detail">{data.detail}</span>}
      </span>
      {SIDES.map(([side, position]) => (
        <Handle key={side} id={side} type="source" position={position} className="iq-handle" />
      ))}
    </div>
  );
}

const nodeOfShape =
  (shape: FlowShape) =>
  ({ id, data, selected }: NodeProps<FlowRfNode>): JSX.Element => (
    <Shape id={id} shape={shape} data={data} selected={selected === true} />
  );

export const StartNode = memo(nodeOfShape("stadium"));
export const EndNode = memo(nodeOfShape("stadium"));
export const StepNode = memo(nodeOfShape("box"));
export const DecisionNode = memo(nodeOfShape("diamond"));
export const SubflowNode = memo(nodeOfShape("subroutine"));
export const DataNode = memo(nodeOfShape("round"));
export const NoteNode = memo(nodeOfShape("box"));

/**
 * A kind this vocabulary no longer offers.
 *
 * Drawn as a plain box with a distinct outline so a draft written against the
 * runtime palette still opens and can be read, replaced and deleted. Silently
 * dropping the node would rewrite someone's diagram on load.
 */
export const RetiredNode = memo(
  ({ id, data, selected }: NodeProps<FlowRfNode>): JSX.Element => (
    <div className={`iq-retired-wrap${selected ? " selected" : ""}`}>
      <Shape id={id} shape="box" data={data} selected={selected === true} />
    </div>
  ),
);

StartNode.displayName = "StartNode";
EndNode.displayName = "EndNode";
StepNode.displayName = "StepNode";
DecisionNode.displayName = "DecisionNode";
SubflowNode.displayName = "SubflowNode";
DataNode.displayName = "DataNode";
NoteNode.displayName = "NoteNode";
RetiredNode.displayName = "RetiredNode";

/**
 * The registry React Flow reads, and the one place a kind becomes a component.
 *
 * Defined at module scope on purpose: React Flow remounts every node when this
 * object changes identity, which rebuilt the whole canvas on every keystroke
 * when it was built inside the component.
 */
export const NODE_TYPES = {
  start: StartNode,
  end: EndNode,
  step: StepNode,
  decision: DecisionNode,
  subflow: SubflowNode,
  data: DataNode,
  note: NoteNode,
  retired: RetiredNode,
};

/** Which registered component draws this kind. */
export const typeOf = (kind: FlowNodeKind): string => (isRetired(kind) ? "retired" : kind);
