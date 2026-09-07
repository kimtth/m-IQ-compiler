import { z } from "zod";

/**
 * IQ Cell → IQ Workflow.
 *
 * A conceptual business-flow modeler. The canvas is for drawing a process so a
 * person can read it: who does what, in what order, and where it branches.
 * Nothing on it executes, and nothing on it pretends to.
 *
 * The vocabulary is a flowchart, aligned one-for-one with Mermaid shapes, so a
 * diagram survives the round trip out to Mermaid and back. It is deliberately
 * not BPMN: BPMN's value is execution semantics and XML interchange, this
 * surface has neither, and its audience already reads box, diamond and
 * rounded start.
 *
 * These contracts live in shared so the drawing and any later reader describe
 * the same object.
 */

/**
 * Node families. Rendered distinctly and never mixed on one node.
 *
 * `flow` is the process itself, `context` is a thing the process handles, and
 * `annotation` is a remark about the drawing rather than part of it.
 */
export const FlowNodeFamily = z.enum(["flow", "context", "annotation"]);
export type FlowNodeFamily = z.infer<typeof FlowNodeFamily>;

/**
 * The vocabulary.
 *
 * Seven kinds, each mapping to exactly one Mermaid flowchart shape. Who does a
 * step and in which system are *fields* on the step, not kinds of their own:
 * Mermaid flowchart has no swimlanes, so a Lane kind would export to nothing,
 * and a System drawn beside a Step says twice what one Step says once.
 *
 * {@link RETIRED_FLOW_NODE_KINDS} keeps drafts written against the old runtime
 * palette openable.
 */
export const FlowNodeKind = z.enum([
  "start",
  "end",
  "step",
  "decision",
  "subflow",
  "data",
  "note",
]);
export type FlowNodeKind = z.infer<typeof FlowNodeKind>;

/**
 * Kinds this canvas used to offer.
 *
 * A draft is stored in device storage and outlives the release that wrote it,
 * so removing a kind cannot mean a saved flow stops opening. These names are
 * still recognised: a node of one of them renders as a neutral retired card and
 * reports itself, which is the difference between "this step no longer exists,
 * replace it" and a blank canvas.
 *
 * The second block is the whole runtime palette. IQ Workflow used to offer
 * product primitives — ask, council, research, work_iq — with typed ports, a
 * permission manifest and a token estimate, none of which ever reached a
 * service. A canvas that offers a step it cannot perform teaches the reader to
 * distrust every other step on it, so the surface became a modeler and the
 * primitives were retired rather than left as decoration.
 *
 * Nothing may be added here without also being removed from {@link FlowNodeKind}
 * — the list is a record of what was taken away, not a second palette.
 */
export const RETIRED_FLOW_NODE_KINDS: readonly string[] = [
  // Triggers that implied an automation runtime the app does not have.
  "schedule",
  "project_watch",
  "mail_arrives",
  "meeting_ends",
  // Generic reach, none of it backed by anything.
  "model_call",
  "browser_fetch",
  "http_request",
  "graph_query",
  // Superseded by the `document` block, which was itself retired below.
  "file_read",
  "file_write",
  // Orchestration primitives with no orchestrator.
  "for_each",
  "delay",
  "map",
  // The runtime palette. Triggers.
  "manual",
  "chat_command",
  // Modes.
  "ask",
  "council",
  "agent_task",
  "author_document",
  "generate_image",
  "research",
  // Grounded corpora.
  "work_iq",
  "foundry_iq",
  "fabric_iq",
  "web_iq",
  // Artifacts.
  "conversation",
  "document",
  // Modules.
  "skill",
  "knowledge_query",
  "memory_write",
  // Control.
  "branch",
  "merge",
  "iq_cell",
  "return",
];

/** True when `kind` names a step this canvas used to offer and no longer does. */
export const isRetiredFlowNodeKind = (kind: string): boolean =>
  RETIRED_FLOW_NODE_KINDS.includes(kind);

export const FlowNode = z.object({
  id: z.string(),
  kind: FlowNodeKind,
  label: z.string(),
  /** Layout is cosmetic and never affects the compiled output. */
  x: z.number(),
  y: z.number(),
  /**
   * Everything descriptive a step carries: its owner, the system it happens
   * in, how long it takes, the question a decision asks. Fields rather than
   * kinds, because who does the work is an attribute of the work.
   */
  config: z.record(z.string()).default({}),
  notes: z.string().default(""),
});
export type FlowNode = z.infer<typeof FlowNode>;

/** How an edge is drawn. A dashed link is a weak or optional relationship. */
export const FlowEdgeStyle = z.enum(["solid", "dashed"]);
export type FlowEdgeStyle = z.infer<typeof FlowEdgeStyle>;

/**
 * One arrow.
 *
 * The label is where a decision's answers live — "yes", "rejected", "over
 * £10k" — so an edge without an editable label is a decision that cannot be
 * written down.
 *
 * The old typed-port fields (`fromPort`, `toPort`, `kind`, `coercion`) are
 * gone. Zod strips unknown keys and the two new fields default, so an edge
 * persisted by the runtime build still parses.
 */
export const FlowEdge = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  label: z.string().default(""),
  style: FlowEdgeStyle.default("solid"),
});
export type FlowEdge = z.infer<typeof FlowEdge>;

export const FlowGraph = z.object({
  id: z.string(),
  name: z.string(),
  projectId: z.string().nullable().default(null),
  nodes: z.array(FlowNode).default([]),
  edges: z.array(FlowEdge).default([]),
  updatedAt: z.string().datetime(),
});
export type FlowGraph = z.infer<typeof FlowGraph>;

export const FlowDiagnosticSeverity = z.enum(["error", "warning", "info"]);
export type FlowDiagnosticSeverity = z.infer<typeof FlowDiagnosticSeverity>;

export const FlowDiagnostic = z.object({
  severity: FlowDiagnosticSeverity,
  /** Stable code, so a diagnostic can be documented and searched for. */
  code: z.string(),
  message: z.string(),
  nodeId: z.string().nullable().default(null),
  port: z.string().nullable().default(null),
});
export type FlowDiagnostic = z.infer<typeof FlowDiagnostic>;

/**
 * One entry of a published IQ Cell's permission manifest.
 *
 * Nothing derives this any more. It survives only as a field of
 * {@link IqCellCard}, which is a record that already exists on people's
 * devices; a card written by IQ Workflow today carries an empty array. The
 * shape is kept so an older card still parses.
 */
export const FlowManifestEntry = z.object({
  reach: z.string(),
  access: z.enum(["read", "write", "external"]),
  nodes: z.array(z.string()),
});
export type FlowManifestEntry = z.infer<typeof FlowManifestEntry>;

/**
 * The plain-language description of a diagram.
 *
 * Documentation, not a runtime promise. `steps` is the ordered step list and
 * `markdown` is the same thing as prose; `hash` identifies the drawing so a
 * published record can quote it.
 */
export const FlowContract = z.object({
  flowId: z.string(),
  name: z.string(),
  /** Plain-language step list — the diagram is readable without the canvas. */
  steps: z.array(z.string()),
  /** Hash of the drawing, quoted by every published record. */
  hash: z.string(),
  markdown: z.string(),
});
export type FlowContract = z.infer<typeof FlowContract>;

/** The faces an IQ Cell can be published under. IQ Workflow registers none. */
export const IqCellFace = z.enum(["automation", "command", "skill", "node"]);
export type IqCellFace = z.infer<typeof IqCellFace>;

/**
 * Which surface compiled this IQ Cell.
 *
 * IQ Workflow is the only surface that publishes one today. The other four
 * values are kept because records carrying them already exist on people's
 * devices: IQ Knowledge, IQ Memories, IQ Industry and My IQ each
 * used to have a Compile button, and those buttons published a cell that could
 * not run. Dropping the values would make an existing library fail to parse,
 * which is a worse answer than naming an origin nothing mints any more.
 */
export const IqCellOrigin = z.enum(["editor", "knowledge", "memory", "industry", "connectome"]);
export type IqCellOrigin = z.infer<typeof IqCellOrigin>;

export const IQ_CELL_ORIGIN_LABELS = {
  editor: "IQ Workflow",
  knowledge: "IQ Knowledge",
  memory: "IQ Memories",
  industry: "IQ Industry",
  connectome: "My IQ",
} as const satisfies Record<IqCellOrigin, string>;

export const IqCellCard = z.object({
  id: z.string(),
  flowId: z.string(),
  name: z.string(),
  version: z.number(),
  faces: z.array(IqCellFace),
  /** Defaulted so records written before origins existed still parse. */
  origin: IqCellOrigin.default("editor"),
  /**
   * What the origin surface needs to reopen what this cell was compiled *from*.
   *
   * Memory ids for a memory cell, the knowledge node id for a document cell,
   * empty for the editor (whose source is the draft `flowId` already names) and
   * for a whole-index knowledge cell (whose source is the index itself).
   *
   * It exists because the compiled identity is deliberately lossy: a memory
   * cell's `flowId` is an order-independent *hash* of the memory ids, so the
   * set it came from cannot be recovered from it. Without this field the
   * library can send someone to IQ Memories but not to the memory they clicked,
   * which is the difference between a link and a hint.
   */
  originRef: z.array(z.string()).default([]),
  contractHash: z.string(),
  compiledAt: z.string().datetime(),
  /** Demo telemetry. Always rendered behind the Demo data marker. */
  runs: z.number(),
  completionRate: z.number(),
  tokensPerRun: z.number(),
  manifest: z.array(FlowManifestEntry),
});
export type IqCellCard = z.infer<typeof IqCellCard>;

