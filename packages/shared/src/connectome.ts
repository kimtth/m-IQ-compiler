import { z } from "zod";

/**
 * The Connectome — the parent layer above IQ Cells.
 *
 * An IQ Cell knows its own procedure and nothing about its neighbours. The
 * Connectome is the graph of relationships between them in a project, and it
 * answers a different question: not "how is this job done?" but "what does the
 * whole body of work look like?".
 *
 * It is a reading surface. Nothing here executes, no edge is drawn by hand,
 * and every edge and finding carries the evidence it was derived from rather
 * than a value read out of an artifact.
 */

/** How a connection between two IQ Cells was established. */
export const ConnectomeEdgeOrigin = z.enum(["structural", "latent"]);
export type ConnectomeEdgeOrigin = z.infer<typeof ConnectomeEdgeOrigin>;

/**
 * The couplings a latent edge can be derived from. Each is evidence the
 * product already keeps, never new instrumentation.
 */
export const CouplingComponent = z.enum([
  "artifact_lineage",
  "project_reach",
  "external_reach",
  "shared_configuration",
  "co_activation",
  "human_coupling",
]);
export type CouplingComponent = z.infer<typeof CouplingComponent>;

export const COUPLING_LABELS: Readonly<Record<CouplingComponent, string>> = {
  artifact_lineage: "Artifact lineage",
  project_reach: "Shared project reach",
  external_reach: "Shared external reach",
  shared_configuration: "Shared configuration",
  co_activation: "Temporal co-activation",
  human_coupling: "Same approver",
};

/**
 * What each signal actually compares.
 *
 * The analysis is a comparison of declarations two IQ Cells already carry, not
 * an inference a model made. Stating the comparison next to the number is what
 * makes a strength figure checkable rather than something to be taken on
 * trust, so these lines are shown on the surface, not only in the docs.
 */
export const COUPLING_HOW: Readonly<Record<CouplingComponent, string>> = {
  artifact_lineage: "One writes a file the other reads. Counted from declared inputs and outputs.",
  project_reach: "Both declare the same project paths.",
  external_reach: "Both hold the same outside grant — a host, Microsoft 365, or the browser.",
  shared_configuration: "Both name the same model, skill, MCP server or connection.",
  co_activation: "Their runs land in the same hours of the day.",
  human_coupling: "The same person approves both.",
};

/** Plain-language names for the two ways an edge can exist. */
export const ORIGIN_LABELS: Readonly<Record<ConnectomeEdgeOrigin, string>> = {
  structural: "Declared — one embeds the other",
  latent: "Inferred — from shared signals only",
};


/** Default component weights. Shown in the report and adjustable live. */
export const DEFAULT_CONNECTOME_WEIGHTS: Readonly<Record<CouplingComponent, number>> = {
  artifact_lineage: 1,
  project_reach: 0.7,
  external_reach: 0.8,
  shared_configuration: 0.5,
  co_activation: 0.6,
  human_coupling: 0.4,
};

export const ConnectomeWeights = z.record(CouplingComponent, z.number());
export type ConnectomeWeights = Record<CouplingComponent, number>;

export const ConnectomeNode = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number(),
  faces: z.array(z.string()),
  /** Drives node size. */
  runs: z.number(),
  /** Drives the node ring. */
  completionRate: z.number(),
  tokensPerRun: z.number(),
  /** Drives the permission badge. */
  reach: z.array(z.string()),
  bundleId: z.string().nullable().default(null),
  /**
   * Days since this IQ Cell last ran, which is what the time lapse is a lapse
   * *of*. Defaulted so a graph serialised before the time lapse existed still
   * parses — it simply plays as though everything ran today.
   */
  lastRunDaysAgo: z.number().default(0),
  /** Seeded layout position; the same selection always yields the same one. */
  position: z.tuple([z.number(), z.number(), z.number()]),
});
export type ConnectomeNode = z.infer<typeof ConnectomeNode>;

export const ConnectomeEvidence = z.object({
  component: CouplingComponent,
  detail: z.string(),
  score: z.number(),
});
export type ConnectomeEvidence = z.infer<typeof ConnectomeEvidence>;

export const ConnectomeEdge = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  origin: ConnectomeEdgeOrigin,
  /** 0..1, weighted sum of the evidence below. */
  strength: z.number(),
  /** 0..1 recency, driving fibre saturation. */
  recency: z.number(),
  evidence: z.array(ConnectomeEvidence),
  bundleId: z.string().nullable().default(null),
});
export type ConnectomeEdge = z.infer<typeof ConnectomeEdge>;

/**
 * The span the time lapse plays over, in days.
 *
 * The same figure `recency` is computed against, so a node's arrival and an
 * edge's saturation are on one clock. Stated once here because three modules
 * need it and a second copy is a second clock.
 */
export const RECENCY_WINDOW_DAYS = 45;

/**
 * Where something sits on the time lapse: 0 at the far end of the window, 1
 * now. An IQ Cell that has not run inside the window arrives at the start
 * rather than being left out — it is still part of the body of work.
 */
export const arrivalOf = (daysAgo: number): number =>
  1 - Math.min(1, Math.max(0, daysAgo) / RECENCY_WINDOW_DAYS);

export const ConnectomeBundle = z.object({
  id: z.string(),
  name: z.string(),
  members: z.array(z.string()),
  shares: z.array(z.string()),
  /** Hue in degrees, tinting the direction-coded fibre colour. */
  hue: z.number(),
  costShare: z.number(),
  runShare: z.number(),
});
export type ConnectomeBundle = z.infer<typeof ConnectomeBundle>;

export const ConnectomeFindingKind = z.enum([
  "redundancy",
  "fragility",
  "cost_concentration",
  "permission_concentration",
  "stale_pin",
  "orphan",
]);
export type ConnectomeFindingKind = z.infer<typeof ConnectomeFindingKind>;

export const ConnectomeFinding = z.object({
  kind: ConnectomeFindingKind,
  title: z.string(),
  detail: z.string(),
  /** The edges or nodes the finding cites. */
  cites: z.array(z.string()),
  /** The concrete next step. The report never performs it. */
  action: z.string(),
});
export type ConnectomeFinding = z.infer<typeof ConnectomeFinding>;

/**
 * Who the analysis is being read for.
 *
 * The same body of work is a different problem depending on who is looking at
 * it. A budget owner and a security reviewer are handed the same graph and the
 * same findings, and the first thing each needs to see is not the same thing.
 *
 * A persona changes the **order** of the findings and nothing else. It is not a
 * filter: the analysis is a claim about how someone's work hangs together, and
 * a lens that quietly dropped the findings its reader is not looking for would
 * make the surface less trustworthy the more precisely it was aimed. It also
 * does not enter the graph hash — the picture must not move when the reader
 * changes, because only the reading changed.
 */
export const ConnectomePersona = z.enum([
  "all",
  "ceo",
  "manager",
  "product",
  "engineering",
  "security",
  "compliance",
  "finance",
  "operator",
]);
export type ConnectomePersona = z.infer<typeof ConnectomePersona>;

export interface ConnectomePersonaLens {
  label: string;
  /** The question this reader brings to the body of work. */
  question: string;
  /**
   * Finding kinds this reader leads with, most pressing first.
   *
   * No two personas may declare the same order. A persona whose ordering
   * matches another's is a label on the dropdown and nothing else, and it
   * would tell a reader their perspective had been taken into account when it
   * had not. `tests/connectome.test.ts` holds them apart.
   */
  leads: readonly ConnectomeFindingKind[];
  /**
   * What this ordering pushes down.
   *
   * Carried beside the lens rather than left implicit, and printed in the
   * report: promoting one kind of finding demotes another, and a reader who is
   * not told which is being demoted will read the top of the list as the whole
   * of the problem.
   */
  blindSpot: string;
}

export const CONNECTOME_PERSONAS: Readonly<Record<ConnectomePersona, ConnectomePersonaLens>> = {
  all: {
    label: "Everything",
    question: "What does this body of work look like?",
    leads: [],
    blindSpot: "Nothing is promoted, so the first finding is not the most pressing one.",
  },
  ceo: {
    label: "CEO",
    question: "What does this cost, and what could it cost us?",
    leads: ["cost_concentration", "permission_concentration", "fragility"],
    blindSpot: "The ranking is sound; the absolute figures are not. Run history and token counts are demo data.",
  },
  manager: {
    label: "Manager",
    question: "What is slowing the team down or about to break?",
    leads: ["fragility", "stale_pin", "redundancy"],
    blindSpot: "Nothing here knows who is waiting on what. Coupling is between IQ Cells, not between people.",
  },
  product: {
    label: "Product owner",
    question: "What is being built twice, and what is nobody using?",
    leads: ["redundancy", "orphan", "cost_concentration"],
    blindSpot: "Use is counted in runs, not in value. An IQ Cell nobody needs can still run every day.",
  },
  engineering: {
    label: "Engineering lead",
    question: "What takes the rest down with it when it fails?",
    leads: ["fragility", "redundancy", "orphan"],
    blindSpot: "Cost sits lower, so a reliable but expensive IQ Cell never reaches the top.",
  },
  security: {
    label: "Security reviewer",
    question: "Who can reach what, and how hard would that be to withdraw?",
    leads: ["permission_concentration", "fragility", "stale_pin"],
    blindSpot: "Reach is declared, not observed. No ordering of these findings can show a grant nobody wrote down.",
  },
  compliance: {
    label: "Compliance officer",
    question: "Can I show who approved what, and is any of it out of date?",
    leads: ["permission_concentration", "stale_pin", "orphan"],
    blindSpot: "An approver is a name on a record, not a signed decision. This shows concentration, not whether a review happened.",
  },
  finance: {
    label: "Budget owner",
    question: "Where does the spend go, and what is being paid for twice?",
    leads: ["cost_concentration", "redundancy", "orphan"],
    blindSpot: "Token counts are demo figures, and a fragile IQ Cell is cheap until it starts retrying.",
  },
  operator: {
    label: "Operator",
    question: "What in my own work needs tidying up?",
    leads: ["stale_pin", "orphan", "redundancy"],
    blindSpot: "Spend and access sit lower, so an expensive IQ Cell that still works looks fine here.",
  },
};

/**
 * Order findings for one reader.
 *
 * A stable sort on rank alone: findings the persona leads with come first in
 * the persona's own order, everything else keeps the order the analysis found
 * it in. Same list in, same list out — reordering is not a computation the
 * reader has to re-run the analysis for.
 */
export const orderFindingsFor = (
  persona: ConnectomePersona,
  findings: readonly ConnectomeFinding[],
): ConnectomeFinding[] => {
  const { leads } = CONNECTOME_PERSONAS[persona];
  const rankOf = (finding: ConnectomeFinding): number => {
    const at = leads.indexOf(finding.kind);
    return at === -1 ? leads.length : at;
  };
  return [...findings].sort((a, b) => rankOf(a) - rankOf(b));
};

export const ConnectomeSelection = z.object({
  projectId: z.string().nullable().default(null),
  iqCellIds: z.array(z.string()),
  /** Days of run history considered. */
  windowDays: z.number(),
  weights: ConnectomeWeights,
  /**
   * Who the findings are ordered for. Defaulted so a report written before
   * personas existed still parses, and reads as the unordered "everything".
   */
  persona: ConnectomePersona.default("all"),
});
export type ConnectomeSelection = z.infer<typeof ConnectomeSelection>;

export const ConnectomeGraph = z.object({
  nodes: z.array(ConnectomeNode),
  edges: z.array(ConnectomeEdge),
  bundles: z.array(ConnectomeBundle),
  /** Stable for a given selection, window and weight set. */
  hash: z.string(),
  seed: z.number(),
});
export type ConnectomeGraph = z.infer<typeof ConnectomeGraph>;

export const ConnectomeReport = z.object({
  selection: ConnectomeSelection,
  graph: ConnectomeGraph,
  findings: z.array(ConnectomeFinding),
  /** What the analysis could not see. Unverifiable claims are marked, not made. */
  limits: z.array(z.string()),
  markdown: z.string(),
  generatedAt: z.string().datetime(),
});
export type ConnectomeReport = z.infer<typeof ConnectomeReport>;

