import {
  isRetiredFlowNodeKind,
  type FlowNodeFamily,
  type FlowNodeKind,
} from "@iq/shared";

/**
 * The vocabulary of the modeler.
 *
 * One definition per kind: its family, the shape it is drawn and exported as,
 * and the descriptive fields a person fills in. That is the whole of it —
 * there are no ports, no reach and no token cost, because nothing here runs.
 *
 * The catalogue is still the only place a kind's meaning is written down. The
 * canvas, the checks and the export all read it, so a node cannot appear on
 * the canvas without the catalogue saying what it is.
 */

/**
 * How one field is asked for.
 *
 * All four are plain form controls. The pickers that used to be here — pick a
 * conversation, pick a file — bound a step to something on this device, and a
 * diagram of how a business works is not bound to anything.
 */
export type ConfigKind = "text" | "textarea" | "number" | "select";

export interface ConfigField {
  readonly name: string;
  readonly label: string;
  readonly kind: ConfigKind;
  readonly options?: readonly string[];
  readonly placeholder?: string;
}

/**
 * The shape a kind is drawn and exported as.
 *
 * One value per Mermaid flowchart shape, so the export is a lookup rather than
 * a judgement call and the canvas and the exported diagram cannot drift.
 */
export type FlowShape = "stadium" | "box" | "diamond" | "round" | "subroutine";

export interface NodeSpec {
  readonly kind: FlowNodeKind;
  readonly family: FlowNodeFamily;
  readonly label: string;
  readonly detail: string;
  readonly shape: FlowShape;
  readonly config: readonly ConfigField[];
}

/** The whole vocabulary, in the order it is offered. */
export const SPECS: readonly NodeSpec[] = [
  {
    kind: "start",
    family: "flow",
    label: "Start",
    detail: "Where the flow begins",
    shape: "stadium",
    config: [
      {
        name: "trigger",
        label: "What starts it",
        kind: "text",
        placeholder: "An engineer opens a pull request",
      },
    ],
  },
  {
    kind: "step",
    family: "flow",
    label: "Step",
    detail: "Someone or something does work",
    shape: "box",
    config: [
      // Owner and system are fields rather than lanes because Mermaid
      // flowchart has no swimlanes: a Lane kind would export to nothing, and a
      // System drawn beside a Step says twice what one Step says once.
      { name: "owner", label: "Who does it", kind: "text", placeholder: "Service owner" },
      { name: "system", label: "In which system", kind: "text", placeholder: "SAP" },
      { name: "duration", label: "How long it takes", kind: "text", placeholder: "2 days" },
      { name: "notes", label: "Notes", kind: "textarea", placeholder: "What good looks like" },
    ],
  },
  {
    kind: "decision",
    family: "flow",
    label: "Decision",
    detail: "A branch. The answers are written on the arrows",
    shape: "diamond",
    config: [
      {
        name: "question",
        label: "The question",
        kind: "text",
        placeholder: "Is the pack complete?",
      },
      {
        name: "criteria",
        label: "How it is decided",
        kind: "textarea",
        placeholder: "All 18 elements present and signed",
      },
    ],
  },
  {
    kind: "subflow",
    family: "flow",
    label: "Subflow",
    detail: "A flow described elsewhere",
    shape: "subroutine",
    config: [
      { name: "flow", label: "The other flow", kind: "text", placeholder: "Deviation approval" },
    ],
  },
  {
    kind: "end",
    family: "flow",
    label: "End",
    detail: "An outcome",
    shape: "stadium",
    config: [{ name: "outcome", label: "The outcome", kind: "text", placeholder: "Part approved" }],
  },
  {
    kind: "data",
    family: "context",
    label: "Data",
    detail: "A document, record or dataset the flow handles",
    shape: "round",
    config: [
      {
        name: "format",
        label: "What it is",
        kind: "select",
        options: ["Document", "Spreadsheet", "Record", "Dataset", "Message", "Form"],
      },
      {
        name: "system",
        label: "System of record",
        kind: "text",
        placeholder: "Quality management system",
      },
    ],
  },
  {
    kind: "note",
    family: "annotation",
    label: "Note",
    detail: "A remark, attached with a dashed link",
    // Never exported. Mermaid flowchart has no annotation shape, and drawing a
    // note as a box would put a remark about the diagram into the diagram.
    shape: "box",
    config: [{ name: "text", label: "The note", kind: "textarea" }],
  },
];

export const NODE_SPECS: Readonly<Record<FlowNodeKind, NodeSpec>> = Object.fromEntries(
  SPECS.map((spec) => [spec.kind, spec]),
) as Record<FlowNodeKind, NodeSpec>;

/**
 * The card a kind the vocabulary no longer offers is drawn as.
 *
 * Drafts live in device storage and outlive the release that wrote them, so a
 * kind leaving cannot mean the flow that used it stops opening. The card is
 * deliberately inert — no configuration — so a retired step can be seen, read
 * and deleted but never silently kept as part of the flow. The checks report
 * it, and the description cannot claim it does anything because the catalogue
 * says it does nothing.
 *
 * Built per kind rather than shared, so the card names the step that was there
 * instead of the generic fact that something was.
 */
const retiredSpec = (kind: FlowNodeKind): NodeSpec => ({
  kind,
  family: "annotation",
  label: `Retired step · ${kind}`,
  detail: "This step is no longer part of the vocabulary. Replace or delete it.",
  shape: "box",
  config: [],
});

const retiredSpecs = new Map<string, NodeSpec>();

/**
 * A kind is resolved rather than indexed so a draft saved against an older
 * vocabulary opens instead of crashing the canvas on a lookup that returns
 * `undefined` — which every caller here would then read a property off.
 */
export const specOf = (kind: FlowNodeKind): NodeSpec => {
  const spec = NODE_SPECS[kind] as NodeSpec | undefined;
  if (spec !== undefined) return spec;
  const cached = retiredSpecs.get(kind);
  if (cached !== undefined) return cached;
  const built = retiredSpec(kind);
  retiredSpecs.set(kind, built);
  return built;
};

/** True when this node's kind is no longer offered. */
export const isRetired = (kind: FlowNodeKind): boolean =>
  (NODE_SPECS[kind] as NodeSpec | undefined) === undefined || isRetiredFlowNodeKind(kind);

export const FAMILY_ORDER: readonly FlowNodeFamily[] = ["flow", "context", "annotation"];

export const FAMILY_LABELS: Readonly<Record<FlowNodeFamily, string>> = {
  flow: "The process",
  context: "What it handles",
  annotation: "Annotation",
};

/** Free-text search over name and description. */
export const searchSpecs = (term: string): readonly NodeSpec[] => {
  const needle = term.trim().toLowerCase();
  if (needle === "") return SPECS;
  return SPECS.filter((spec) => [spec.label, spec.detail].join(" ").toLowerCase().includes(needle));
};
