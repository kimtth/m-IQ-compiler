import type { FlowGraph, IqCellCard, IqCellFace, IqCellOrigin } from "@iq/shared";
import { describe } from "./compile.js";
import { assemble, type AssemblyStep } from "./assemble.js";
import { device } from "./device.js";

/**
 * Persistence.
 *
 * Everything lives in the renderer: diagrams and published IQ Cells are held
 * on the device, keyed by project, and moved between machines as a JSON bundle
 * rather than through a service. The shapes are the shared contracts, so a
 * later privileged implementation can adopt the same records unchanged.
 *
 * Reached through {@link DeviceStore} rather than `window.localStorage`
 * directly. The browser API used to *be* the interface here, which meant there
 * was no seam to put a second implementation behind and no way to test the
 * records without a browser.
 */

const scopeOf = (projectId: string | null): string => projectId ?? "unbound";
const flowKey = (projectId: string | null): string => `iq.flows.${scopeOf(projectId)}`;
const iqCellKey = (projectId: string | null): string => `iq.iqcells.${scopeOf(projectId)}`;
/** The key this store used before IQ-lets were renamed to IQ Cells. */
const legacyCellKey = (projectId: string | null): string => `iq.iqlets.${scopeOf(projectId)}`;

const read = <T>(key: string): T[] => {
  try {
    const raw = device().read(key);
    return raw === null ? [] : (JSON.parse(raw) as T[]);
  } catch {
    return [];
  }
};

const write = <T>(key: string, rows: readonly T[]): void => {
  device().write(key, JSON.stringify(rows));
};

/**
 * Move a pre-rename library across, once.
 *
 * A rename is not a reason to lose someone's work, so the old key is read,
 * copied under the new one and removed. The records themselves are unchanged —
 * only the concept's name moved.
 */
const migrateCells = (projectId: string | null): void => {
  const legacy = legacyCellKey(projectId);
  const raw = device().read(legacy);
  if (raw === null) return;
  if (device().read(iqCellKey(projectId)) === null) {
    device().write(iqCellKey(projectId), raw);
  }
  device().remove(legacy);
};

export const listFlows = (projectId: string | null): FlowGraph[] =>
  read<FlowGraph>(flowKey(projectId))
    .map(normalise)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

/**
 * Bring a diagram saved by an older build up to date.
 *
 * Two things drifted. Node config is a plain string map, so an old graph still
 * holds option text a picker no longer offers. And an edge written by the
 * runtime build carries typed ports instead of a label and a style, so reading
 * `edge.label` on it would be reading `undefined`.
 *
 * Done on read rather than in a one-off pass because these records live in
 * device storage, which has no boot step. Nothing has applied the schema's
 * defaults yet either, so a node saved without config arrives without the
 * field.
 */
const CONFIG_VALUES: Record<string, string> = {
  workspace: "project",
  "web + workspace": "web + project",
  "workspace only": "project only",
};

const normalise = (graph: FlowGraph): FlowGraph => ({
  ...graph,
  nodes: (graph.nodes ?? []).map((node) => ({
    ...node,
    config: Object.fromEntries(
      Object.entries(node.config ?? {}).map(([key, value]) => [key, CONFIG_VALUES[value] ?? value]),
    ),
  })),
  edges: (graph.edges ?? []).map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    label: edge.label ?? "",
    style: edge.style ?? "solid",
  })),
});

export const saveFlow = (projectId: string | null, graph: FlowGraph): void => {
  const rows = read<FlowGraph>(flowKey(projectId)).filter((row) => row.id !== graph.id);
  write(flowKey(projectId), [graph, ...rows]);
};

export const deleteFlow = (projectId: string | null, id: string): void => {
  write(
    flowKey(projectId),
    read<FlowGraph>(flowKey(projectId)).filter((row) => row.id !== id),
  );
};

// ── handing a draft to the Editor ────────────────────────────────────────

/**
 * One surface asking the Editor to open something.
 *
 * My IQ's Edit control has to put a draft on the canvas of a
 * component it does not own and may not even have mounted yet. Passing it
 * through a callback chain would mean threading a graph through the shell for
 * one button, so instead the draft is saved like any other and its id is left
 * where the Editor looks: the record is real, and a reload after a crash finds
 * it exactly where a saved draft would be.
 *
 * The event is what makes it work when the Editor's tab is already open —
 * switching back to an existing tab does not remount it, so a mount-time read
 * alone would silently do nothing.
 */
const handoffKey = (projectId: string | null): string => `iq.flow.open.${scopeOf(projectId)}`;

/** Fired at `window` when a draft has been staged for the Editor. */
export const FLOW_HANDOFF_EVENT = "iq:flow-open";

export const stageForEditor = (projectId: string | null, graph: FlowGraph): void => {
  saveFlow(projectId, graph);
  device().write(handoffKey(projectId), graph.id);
  device().announce(FLOW_HANDOFF_EVENT);
};

/** Listen for a staged draft. Returns the unsubscribe. */
export const onFlowStaged = (handler: () => void): (() => void) =>
  device().listen(FLOW_HANDOFF_EVENT, handler);

/** Read and clear the staged draft. Returns null when nothing is waiting. */
export const takeStagedFlow = (projectId: string | null): FlowGraph | null => {
  const key = handoffKey(projectId);
  const id = device().read(key);
  if (id === null) return null;
  device().remove(key);
  return read<FlowGraph>(flowKey(projectId)).find((row) => row.id === id) ?? null;
};

export const listIqCells = (projectId: string | null): IqCellCard[] => {
  migrateCells(projectId);
  // Records written before origins existed have none; they were all drawn on
  // the canvas, because it was the only surface that published.
  return read<IqCellCard>(iqCellKey(projectId))
    .map((row) => ({ ...row, origin: row.origin ?? "editor", originRef: row.originRef ?? [] }))
    .sort((a, b) => b.compiledAt.localeCompare(a.compiledAt));
};

/**
 * Publish a diagram into the project library.
 *
 * Publishing is a record, not a deployment. The canvas describes how work
 * happens; the card is the version of that description the project agreed on,
 * so it can be found, renamed and superseded. Nothing is registered with the
 * rest of the product and nothing is scheduled.
 *
 * The face is always `node`, and it is the only one left. `automation` came
 * from a schedule trigger and `command` from a chat-command trigger, and both
 * of those steps are gone: a face claiming behaviour with nothing behind it is
 * worse than no face at all.
 *
 * `tokensPerRun` and `manifest` are written empty for the same reason. They
 * were derived from a palette of steps that would have reached out to
 * services; a diagram reaches nothing, and a cost estimate for work that does
 * not happen is a number the reader would be right to act on and wrong to
 * believe. The fields stay on the record so an older card still parses, and
 * the library row hides a zero.
 *
 * `origin` is required rather than defaulted at this boundary. Only IQ
 * Workflow publishes today, but the records on disk name five surfaces, and a
 * caller that forgets to say which is a caller whose records are quietly filed
 * under the wrong one.
 */
export const publishIqCell = (
  projectId: string | null,
  graph: FlowGraph,
  origin: IqCellOrigin,
  originRef: readonly string[] = [],
): IqCellCard => {
  migrateCells(projectId);
  const description = describe(graph);
  const existing = read<IqCellCard>(iqCellKey(projectId));
  const previous = existing.find((row) => row.flowId === graph.id);

  const faces: IqCellFace[] = ["node"];

  const card: IqCellCard = {
    id: previous?.id ?? `iqcell_${graph.id}`,
    flowId: graph.id,
    name: graph.name,
    version: (previous?.version ?? 0) + 1,
    faces,
    origin,
    originRef: [...originRef],
    contractHash: description.hash,
    compiledAt: new Date().toISOString(),
    runs: previous?.runs ?? 0,
    completionRate: previous?.completionRate ?? 1,
    tokensPerRun: 0,
    manifest: [],
  };

  write(iqCellKey(projectId), [card, ...existing.filter((row) => row.id !== card.id)]);
  return card;
};

/**
 * Rename a published IQ Cell.
 *
 * The name a diagram had when it was published is rarely the name it deserves
 * once there are a dozen of them, and republishing just to relabel a record is
 * not a reasonable ask. Only the name changes: the version, the hash and the
 * timestamp all describe the published version and would be lies if a rename
 * touched them.
 */
export const renameIqCell = (
  projectId: string | null,
  id: string,
  name: string,
): IqCellCard[] => {
  migrateCells(projectId);
  const trimmed = name.trim();
  if (trimmed === "") return listIqCells(projectId);
  write(
    iqCellKey(projectId),
    read<IqCellCard>(iqCellKey(projectId)).map((row) =>
      row.id === id ? { ...row, name: trimmed } : row,
    ),
  );
  return listIqCells(projectId);
};

/**
 * Remove a published IQ Cell from the library.
 *
 * The diagram it was published from is left alone: the card is a record of one
 * published version, and deleting the record must not delete the work.
 * Publishing the same diagram again starts its version count over, which is
 * honest — the history it was counting no longer exists.
 */
export const deleteIqCell = (projectId: string | null, id: string): IqCellCard[] => {
  migrateCells(projectId);
  write(
    iqCellKey(projectId),
    read<IqCellCard>(iqCellKey(projectId)).filter((row) => row.id !== id),
  );
  return listIqCells(projectId);
};

/** Export a diagram as the bundle the navigator would show on disk. */
export const exportBundle = (graph: FlowGraph): string =>
  JSON.stringify(
    {
      kind: "iq.flow",
      version: 1,
      // Layout is carried in its own section so a diff of the process is not
      // buried in coordinate churn.
      flow: {
        id: graph.id,
        name: graph.name,
        nodes: graph.nodes.map(({ x, y, ...rest }) => rest),
        edges: graph.edges,
      },
      layout: Object.fromEntries(graph.nodes.map((node) => [node.id, { x: node.x, y: node.y }])),
      // Named `description` because that is what it is. It used to be called
      // `contract`, which promised a reader that something would honour it.
      description: describe(graph).markdown,
    },
    null,
    2,
  );

export const importBundle = (text: string, projectId: string | null): FlowGraph => {
  const parsed = JSON.parse(text) as {
    flow?: { id?: string; name?: string; nodes?: unknown[]; edges?: unknown[] };
    layout?: Record<string, { x: number; y: number }>;
  };
  if (parsed.flow === undefined) throw new Error("Not a workflow bundle.");

  const layout = parsed.layout ?? {};
  const nodes = (parsed.flow.nodes ?? []).map((raw) => {
    const node = raw as FlowGraph["nodes"][number];
    const at = layout[node.id] ?? { x: 80, y: 80 };
    return { ...node, x: at.x, y: at.y };
  });

  // Through the same normalisation a saved diagram gets, so a bundle exported
  // by the runtime build imports with real labels rather than undefined ones.
  return normalise({
    id: parsed.flow.id ?? `flow_${Date.now().toString(36)}`,
    name: parsed.flow.name ?? "Imported diagram",
    projectId,
    nodes,
    edges: (parsed.flow.edges ?? []) as FlowGraph["edges"],
    updatedAt: new Date().toISOString(),
  });
};

// ── Starter templates ────────────────────────────────────────────────────

type TemplateStep = AssemblyStep;

export interface Template {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  readonly steps: readonly TemplateStep[];
}

/**
 * Starter templates.
 *
 * Ten processes an organisation actually runs, drawn the way this canvas asks
 * for them: a start, work with an owner and a system named on it, decisions
 * whose answers are written on the arrows, and an outcome. Several loop —
 * send it back for changes and review again, revise and recirculate — because
 * that is what the work does, and a modeler that could not draw a loop would be
 * describing a business nobody has.
 *
 * Nothing here is about this app. The previous set was ten arrangements of the
 * product's own primitives, which taught a new reader that the canvas is for
 * wiring features together. It is for describing how work happens.
 *
 * Each one opens with no errors and no warnings, which is the point of a
 * template: a worked example that arrives complaining teaches the reader that
 * the checks are noise.
 */
export const TEMPLATES: readonly Template[] = [
  {
    id: "pull-request-review",
    name: "Pull request review",
    detail: "PR opened → review → checks green → merged or closed",
    steps: [
      { kind: "start", label: "PR opened", config: { trigger: "An engineer opens a pull request" } },
      {
        kind: "data",
        label: "Pull request",
        from: [0],
        config: { format: "Record", system: "Source host" },
      },
      {
        kind: "step",
        label: "Review the change",
        // The rework loops straight back here. An author who pushes the
        // requested changes is reviewed again, not put through a second process.
        from: [0, { from: 5 }],
        config: {
          owner: "Reviewer",
          system: "Source host",
          duration: "1 day",
        },
      },
      {
        kind: "decision",
        label: "Approved?",
        from: [2],
        config: {
          question: "Does the reviewer approve the change as it stands?",
          criteria: "Scope, tests and migrations all reviewed and accepted",
        },
      },
      {
        kind: "step",
        label: "Run the full pipeline",
        from: [{ from: 3, label: "Approved" }],
        config: { owner: "CI", system: "Build pipeline", duration: "40 minutes" },
      },
      {
        kind: "step",
        label: "Send back for changes",
        from: [{ from: 3, label: "Changes requested" }],
        config: { owner: "Author", duration: "2 days" },
      },
      {
        kind: "decision",
        label: "All checks green?",
        from: [4],
        config: { question: "Did every required check pass on the merge commit?" },
      },
      {
        kind: "end",
        label: "Merged",
        from: [{ from: 6, label: "Yes" }],
        config: { outcome: "Merged to the main branch" },
      },
      {
        kind: "end",
        label: "Closed unmerged",
        from: [{ from: 6, label: "No" }],
        config: { outcome: "Closed. The author reopens with a fix" },
      },
    ],
  },
  {
    id: "production-change",
    name: "Production change request",
    detail: "Change raised → impact assessed → change board → shipped or rejected",
    steps: [
      { kind: "start", label: "Change raised", config: { trigger: "An engineer raises a change request" } },
      {
        kind: "data",
        label: "Change request record",
        from: [0],
        config: { format: "Record", system: "Change tracker" },
      },
      {
        kind: "step",
        label: "Assess blast radius and timing",
        from: [0],
        config: { owner: "Service owner", system: "Change tracker", duration: "3 days" },
      },
      {
        kind: "decision",
        label: "Touches an audited control?",
        from: [2],
        config: { question: "Does the change touch a system covered by an audit control?" },
      },
      {
        kind: "step",
        label: "Get a security review",
        from: [{ from: 3, label: "Yes" }],
        config: { owner: "Security", duration: "5 days" },
      },
      {
        kind: "step",
        label: "Take it to the change board",
        from: [{ from: 3, label: "No" }, 4],
        config: { owner: "Change board", duration: "1 week" },
      },
      {
        kind: "decision",
        label: "Board decision",
        from: [5],
        config: { question: "Does the board approve the change?" },
      },
      {
        kind: "end",
        label: "Change shipped",
        from: [{ from: 6, label: "Approved" }],
        config: { outcome: "Released to production" },
      },
      {
        kind: "end",
        label: "Change rejected",
        from: [{ from: 6, label: "Rejected" }],
        config: { outcome: "Rejected, with the reasons recorded" },
      },
    ],
  },
  {
    id: "invoice-approval",
    name: "Invoice approval",
    detail: "Invoice arrives → matched to the order → approved by value → paid",
    steps: [
      {
        kind: "start",
        label: "Invoice arrives",
        config: { trigger: "A supplier invoice lands in accounts payable" },
      },
      {
        kind: "data",
        label: "The invoice",
        from: [0],
        config: { format: "Document", system: "Accounts payable" },
      },
      {
        kind: "step",
        label: "Match it to the purchase order",
        from: [0, { from: 4 }],
        config: { owner: "Accounts payable", system: "SAP", duration: "1 day" },
      },
      {
        kind: "decision",
        label: "Does it match?",
        from: [2],
        config: {
          question: "Do the invoice, the order and the goods receipt agree?",
          criteria: "Three-way match within tolerance",
        },
      },
      {
        kind: "step",
        label: "Query it with the supplier",
        from: [{ from: 3, label: "No" }],
        config: { owner: "Accounts payable", duration: "5 days" },
      },
      {
        kind: "decision",
        label: "Over the delegated limit?",
        from: [{ from: 3, label: "Yes" }],
        config: { question: "Is the invoice above £10,000?" },
      },
      {
        kind: "step",
        label: "Get the budget holder's approval",
        from: [{ from: 5, label: "Yes" }],
        config: { owner: "Budget holder", duration: "2 days" },
      },
      {
        kind: "end",
        label: "Scheduled for payment",
        from: [{ from: 5, label: "No" }, 6],
        config: { outcome: "Paid on the next payment run" },
      },
    ],
  },
  {
    id: "new-starter",
    name: "New starter onboarding",
    detail: "Offer accepted → record, kit and plan in parallel → ready on day one",
    steps: [
      { kind: "start", label: "Offer accepted", config: { trigger: "A candidate accepts the offer" } },
      {
        kind: "step",
        label: "Raise the joiner record",
        from: [0],
        config: { owner: "HR", system: "Workday", duration: "1 day" },
      },
      {
        kind: "data",
        label: "Joiner record",
        from: [1],
        config: { format: "Record", system: "Workday" },
      },
      {
        kind: "step",
        label: "Order the laptop and accounts",
        from: [1],
        config: { owner: "IT", system: "Service desk", duration: "5 days" },
      },
      {
        kind: "step",
        label: "Book the first-week plan",
        from: [1],
        config: { owner: "Hiring manager", duration: "2 days" },
      },
      {
        kind: "decision",
        label: "Ready on day one?",
        from: [3, 4, { from: 6 }],
        config: { question: "Are the accounts, the laptop and the plan all in place?" },
      },
      {
        kind: "step",
        label: "Fix what is missing",
        from: [{ from: 5, label: "No" }],
        config: { owner: "Hiring manager", duration: "3 days" },
      },
      {
        kind: "end",
        label: "Started",
        from: [{ from: 5, label: "Yes" }],
        config: { outcome: "The new starter is working" },
      },
    ],
  },
  {
    id: "customer-complaint",
    name: "Customer complaint",
    detail: "Complaint received → acknowledged → investigated → safety check → remedy agreed",
    steps: [
      {
        kind: "start",
        label: "Complaint received",
        config: { trigger: "A customer reports a fault" },
      },
      {
        kind: "data",
        label: "Complaint record",
        from: [0],
        config: { format: "Record", system: "CRM" },
      },
      {
        kind: "step",
        label: "Acknowledge it",
        from: [0],
        config: { owner: "Customer care", system: "CRM", duration: "1 day" },
      },
      {
        kind: "step",
        label: "Investigate the fault",
        from: [2],
        config: { owner: "Support engineering", duration: "10 days" },
      },
      {
        kind: "decision",
        label: "Did it lose data or money?",
        from: [3],
        config: { question: "Could the fault have exposed data or moved money wrongly?" },
      },
      {
        kind: "subflow",
        label: "Incident review",
        from: [{ from: 4, label: "Yes" }],
        config: { flow: "Incident review" },
      },
      {
        kind: "step",
        label: "Agree a remedy with the customer",
        from: [{ from: 4, label: "No" }, 5],
        config: { owner: "Customer care", duration: "5 days" },
      },
      {
        kind: "end",
        label: "Complaint closed",
        from: [6],
        config: { outcome: "The customer accepted the remedy" },
      },
    ],
  },
  {
    id: "purchase-request",
    name: "Purchase request",
    detail: "Request raised → budget checked → sourcing → order placed",
    steps: [
      {
        kind: "start",
        label: "Request raised",
        config: { trigger: "Someone raises a purchase request" },
      },
      {
        kind: "data",
        label: "Purchase request",
        from: [0],
        config: { format: "Form", system: "Procurement" },
      },
      {
        kind: "step",
        label: "Check it against the budget",
        from: [0],
        config: { owner: "Cost controller", system: "SAP", duration: "2 days" },
      },
      {
        kind: "decision",
        label: "Budget available?",
        from: [2],
        config: { question: "Is there budget left in the cost centre this year?" },
      },
      {
        kind: "step",
        label: "Send it back to the requester",
        from: [{ from: 3, label: "No" }],
        config: { owner: "Cost controller", duration: "1 day" },
      },
      {
        kind: "end",
        label: "Request withdrawn",
        from: [4],
        config: { outcome: "Not funded this year" },
      },
      {
        kind: "step",
        label: "Run the sourcing check",
        from: [{ from: 3, label: "Yes" }],
        config: { owner: "Procurement", duration: "1 week" },
      },
      {
        kind: "step",
        label: "Raise the purchase order",
        from: [6],
        config: { owner: "Procurement", system: "SAP", duration: "1 day" },
      },
      {
        kind: "end",
        label: "Order placed",
        from: [7],
        config: { outcome: "The purchase order is with the supplier" },
      },
    ],
  },
  {
    id: "document-signoff",
    name: "Document review and sign-off",
    detail: "Draft ready → circulated → comments → revised or signed off",
    steps: [
      {
        kind: "start",
        label: "Draft ready",
        config: { trigger: "An author marks a draft ready for review" },
      },
      {
        kind: "data",
        label: "The draft",
        from: [0],
        config: { format: "Document", system: "Document library" },
      },
      {
        kind: "step",
        label: "Circulate for comment",
        from: [0, { from: 5 }],
        config: { owner: "Author", system: "Document library", duration: "1 day" },
      },
      {
        kind: "step",
        label: "Collect the comments",
        from: [2],
        config: { owner: "Author", duration: "1 week" },
      },
      {
        kind: "decision",
        label: "Any blocking comment?",
        from: [3],
        config: { question: "Did a reviewer raise something that must change?" },
      },
      {
        kind: "step",
        label: "Revise the draft",
        from: [{ from: 4, label: "Yes" }],
        config: { owner: "Author", duration: "3 days" },
      },
      {
        kind: "step",
        label: "Sign it off",
        from: [{ from: 4, label: "No" }],
        config: { owner: "Approver", system: "Document library", duration: "2 days" },
      },
      {
        kind: "end",
        label: "Published",
        from: [6],
        config: { outcome: "The approved version is published" },
      },
    ],
  },
  {
    id: "incident-response",
    name: "Incident response",
    detail: "Incident raised → triaged → service restored → review written",
    steps: [
      {
        kind: "start",
        label: "Incident raised",
        config: { trigger: "Monitoring or a person reports an incident" },
      },
      {
        kind: "step",
        label: "Triage the severity",
        from: [0],
        config: { owner: "On call", system: "Service desk", duration: "15 minutes" },
      },
      {
        kind: "decision",
        label: "Severity one?",
        from: [1],
        config: { question: "Is service lost for a whole site or customer?" },
      },
      {
        kind: "step",
        label: "Open a major incident bridge",
        from: [{ from: 2, label: "Yes" }],
        config: { owner: "Incident manager", duration: "1 hour" },
      },
      {
        kind: "step",
        label: "Work it in the queue",
        from: [{ from: 2, label: "No" }],
        config: { owner: "On call", duration: "2 days" },
      },
      {
        kind: "step",
        label: "Restore service",
        from: [3, 4],
        config: { owner: "On call", duration: "4 hours" },
      },
      {
        kind: "data",
        label: "Incident record",
        from: [5],
        config: { format: "Record", system: "Service desk" },
      },
      {
        kind: "step",
        label: "Write the post-incident review",
        from: [5],
        config: { owner: "Incident manager", duration: "5 days" },
      },
      {
        kind: "end",
        label: "Closed",
        from: [7],
        config: { outcome: "Service restored and the review agreed" },
      },
    ],
  },
  {
    id: "filling-a-role",
    name: "Filling an open role",
    detail: "Role approved → advertised → interviewed → offer, then onboarding",
    steps: [
      { kind: "start", label: "Role approved", config: { trigger: "A vacancy is approved to hire" } },
      {
        kind: "step",
        label: "Write the brief",
        from: [0],
        config: { owner: "Hiring manager", duration: "3 days" },
      },
      {
        kind: "step",
        label: "Advertise and screen",
        from: [1, { from: 6 }],
        config: { owner: "Recruiter", system: "Applicant tracking", duration: "3 weeks" },
      },
      {
        kind: "data",
        label: "Shortlist",
        from: [2],
        config: { format: "Record", system: "Applicant tracking" },
      },
      {
        kind: "step",
        label: "Interview the shortlist",
        from: [2],
        config: { owner: "Interview panel", duration: "2 weeks" },
      },
      {
        kind: "decision",
        label: "Anyone appointable?",
        from: [4],
        config: { question: "Did anyone meet the bar?" },
      },
      {
        kind: "step",
        label: "Reopen the search",
        from: [{ from: 5, label: "No" }],
        config: { owner: "Recruiter", duration: "2 weeks" },
      },
      {
        kind: "step",
        label: "Make the offer",
        from: [{ from: 5, label: "Yes" }],
        config: { owner: "Hiring manager", duration: "3 days" },
      },
      {
        kind: "subflow",
        label: "New starter onboarding",
        from: [7],
        config: { flow: "New starter onboarding" },
      },
      {
        kind: "end",
        label: "Role filled",
        from: [8],
        config: { outcome: "Someone accepted and started" },
      },
    ],
  },
  {
    id: "expense-claim",
    name: "Expense claim",
    detail: "Claim submitted → checked against policy → approved → reimbursed",
    steps: [
      {
        kind: "start",
        label: "Claim submitted",
        config: { trigger: "Someone submits an expense claim" },
      },
      {
        kind: "data",
        label: "Receipts",
        from: [0],
        config: { format: "Document", system: "Expenses" },
      },
      {
        kind: "step",
        label: "Check the lines against policy",
        from: [0, { from: 4 }],
        config: { owner: "Line manager", system: "Expenses", duration: "3 days" },
      },
      {
        kind: "decision",
        label: "Within policy?",
        from: [2],
        config: {
          question: "Does every line meet the travel and expenses policy?",
          criteria: "Receipt attached, in date, and within the per-night limit",
        },
      },
      {
        kind: "step",
        label: "Ask for an explanation",
        from: [{ from: 3, label: "No" }],
        config: { owner: "Line manager", duration: "5 days" },
      },
      {
        kind: "step",
        label: "Approve for payment",
        from: [{ from: 3, label: "Yes" }],
        config: { owner: "Line manager", duration: "1 day" },
      },
      {
        kind: "end",
        label: "Reimbursed",
        from: [5],
        config: { outcome: "Paid with the next payroll run" },
      },
    ],
  },
];

/**
 * Instantiate a template as a wired diagram.
 *
 * The layout rules live in `assemble.ts`, because the templates are not the
 * only thing that has to turn a list of steps into a readable diagram.
 */
export const fromTemplate = (template: Template, projectId: string | null): FlowGraph =>
  assemble(template.name, template.steps, projectId);

