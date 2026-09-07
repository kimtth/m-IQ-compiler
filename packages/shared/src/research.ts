import { z } from "zod";

/**
 * Research contracts.
 *
 * A research run is a visible plan, not a black box: the topic is decomposed
 * into questions, each question is answered by a delegated sub-agent, and one
 * writer agent synthesises the report so voice and structure stay consistent.
 *
 * Every claim carries a citation. A claim that cannot be sourced is marked
 * unverified rather than stated, and conflicting sources are reported as a
 * conflict rather than silently resolved — the two rules that make the output
 * worth trusting.
 */

export const CitationKind = z.enum(["url", "api", "m365", "artifact"]);
export type CitationKind = z.infer<typeof CitationKind>;

export const ResearchCitation = z.object({
  kind: CitationKind,
  /** URL, API route, Microsoft 365 item id or project-relative path. */
  ref: z.string(),
  title: z.string().default(""),
  retrievedAt: z.string().datetime(),
});
export type ResearchCitation = z.infer<typeof ResearchCitation>;

export const ResearchConflict = z.object({
  claim: z.string(),
  positions: z
    .array(z.object({ statement: z.string(), citation: ResearchCitation }))
    .min(2),
});
export type ResearchConflict = z.infer<typeof ResearchConflict>;

export const ResearchQuestionStatus = z.enum([
  "pending",
  "running",
  "answered",
  "unverified",
  "failed",
  "cancelled",
]);
export type ResearchQuestionStatus = z.infer<typeof ResearchQuestionStatus>;

export const ResearchQuestion = z.object({
  id: z.string(),
  question: z.string().min(1).max(500),
  status: ResearchQuestionStatus.default("pending"),
  /** One-line status shown in the plan; the full trace is the sub-agent's. */
  statusLine: z.string().default(""),
  findings: z.string().default(""),
  citations: z.array(ResearchCitation).default([]),
  conflicts: z.array(ResearchConflict).default([]),
  /** Hosts and resources consulted, host-only, for the source table. */
  sources: z.array(z.string()).default([]),
  error: z.string().default(""),
  startedAt: z.string().datetime().nullable().default(null),
  finishedAt: z.string().datetime().nullable().default(null),
  /** Delegated plan node this question ran as, for cross-linking. */
  taskId: z.string().default(""),
  /** Which gathering round raised it. Round 1 is the reviewed plan. */
  round: z.number().int().min(1).default(1),
  /**
   * The question this one was raised to close, when it came from reflection.
   *
   * Lineage is kept because a follow-up is only defensible next to the gap it
   * answers: without it the plan grows questions the user never approved and
   * cannot trace.
   */
  parentId: z.string().default(""),
});
export type ResearchQuestion = z.infer<typeof ResearchQuestion>;

/**
 * What the manager concluded at the end of one gathering round.
 *
 * Recorded per round rather than replaced, so "why did it go round again?" is
 * answerable after the fact. This is the run's own progress ledger — the thing
 * a single-pass pipeline has no way to produce.
 */
export const ResearchRoundNote = z.object({
  round: z.number().int().min(1),
  /** The manager's own words on where the evidence stood. */
  assessment: z.string().default(""),
  /** Questions it judged thin or contradicted, by id. */
  weak: z.array(z.string()).default([]),
  /** Follow-up questions it raised, already appended to the plan. */
  followUps: z.array(z.string()).default([]),
  /** Why the loop stopped here, when it did. */
  stopped: z.string().default(""),
  at: z.string().datetime(),
});
export type ResearchRoundNote = z.infer<typeof ResearchRoundNote>;

/**
 * The reasoning graph a run produced, as the Agent Framework sidecar reports it.
 *
 * This is the workflow's own account of itself, not a picture we assemble from
 * the outside: the executors and their edges are the graph the framework built
 * and validated, and the statuses are its `executor_invoked` /
 * `executor_completed` / `executor_failed` events. Questions appear as nodes
 * because the fan-out is real — one researcher per question, running
 * concurrently — and a graph that hid them would be a diagram of the code
 * rather than of the run.
 */
export const ResearchNodeKind = z.enum([
  "plan",
  "research",
  "reflect",
  "synthesize",
  "question",
]);
export type ResearchNodeKind = z.infer<typeof ResearchNodeKind>;

export const ResearchNodeStatus = z.enum(["pending", "running", "done", "failed", "skipped"]);
export type ResearchNodeStatus = z.infer<typeof ResearchNodeStatus>;

export const ResearchNode = z.object({
  id: z.string(),
  kind: ResearchNodeKind,
  label: z.string().default(""),
  status: ResearchNodeStatus.default("pending"),
  /** One line on what the step concluded, e.g. "3 citations". */
  detail: z.string().default(""),
  round: z.number().int().min(1).default(1),
});
export type ResearchNode = z.infer<typeof ResearchNode>;

export const ResearchEdge = z.object({ from: z.string(), to: z.string() });
export type ResearchEdge = z.infer<typeof ResearchEdge>;

export const ResearchGraph = z.object({
  nodes: z.array(ResearchNode).default([]),
  edges: z.array(ResearchEdge).default([]),
});
export type ResearchGraph = z.infer<typeof ResearchGraph>;

/**
 * A node as far as one frame knows it.
 *
 * `id` is the only certainty. A status change arrives without a `kind` or a
 * `label` because the workflow is reporting *that the step moved*, not what the
 * step is — and filling those in with defaults would redraw a running node as
 * the wrong shape, which is worse than not redrawing it. Clients merge what is
 * present onto the node they already hold.
 */
export const ResearchNodePatch = ResearchNode.partial().extend({ id: z.string() });
export type ResearchNodePatch = z.infer<typeof ResearchNodePatch>;

/**
 * One change to a run's graph, pushed as it happens.
 *
 * Sent as a delta rather than by re-publishing the run because the graph moves
 * far faster than the run record does: a wide round emits a status change per
 * question per state, and serialising the whole run for each would make the
 * surface's own bookkeeping the slowest part of a research run. The delta is
 * additive and idempotent — a client that missed one can ask for the run and
 * get the whole graph back.
 */
export const ResearchGraphDelta = z.object({
  runId: z.string(),
  /** A node appearing, or an existing one changing state. */
  node: ResearchNodePatch.nullable().default(null),
  edge: ResearchEdge.nullable().default(null),
});
export type ResearchGraphDelta = z.infer<typeof ResearchGraphDelta>;

export const ResearchRunStatus = z.enum([
  "planning",
  "awaiting_review",
  "gathering",
  /**
   * The manager is reading the round's findings back and deciding whether the
   * question set was actually answered. A single-pass pipeline has no such
   * state: it gathers once and writes whatever came back.
   */
  "reflecting",
  /**
   * The manager is turning the reader's note on a finished report into
   * follow-up questions.
   *
   * The state exists so the run is visibly working rather than appearing to
   * ignore the note. It is distinct from `reflecting` because the questions
   * come from a person, not from a verdict about the evidence — and because
   * the two are answerable separately after the fact.
   */
  "refining",
  "writing",
  "complete",
  "failed",
  "cancelled",
]);
export type ResearchRunStatus = z.infer<typeof ResearchRunStatus>;

/**
 * One note the reader left on a finished report, and what it produced.
 *
 * Kept verbatim and kept forever. A report that changed because someone asked
 * it to has to be able to say who asked and what they asked for; the questions
 * it raised are recorded next to the note so the new evidence traces back to a
 * sentence a person wrote rather than appearing in the plan unexplained.
 */
export const ResearchFeedback = z.object({
  id: z.string(),
  /** The reader's own words. */
  note: z.string().min(1).max(2000),
  /** The round this note opened. */
  round: z.number().int().min(1),
  /** Questions raised to answer it, as text. */
  questions: z.array(z.string()).default([]),
  /** Why nothing was raised, when nothing was. */
  declined: z.string().default(""),
  at: z.string().datetime(),
});
export type ResearchFeedback = z.infer<typeof ResearchFeedback>;

export const ResearchReport = z.object({
  markdown: z.string().default(""),
  /** Project-relative path once written, or "" while it is only in memory. */
  path: z.string().default(""),
  generatedAt: z.string().datetime().nullable().default(null),
  /** Named gaps: what the plan could not answer, stated rather than omitted. */
  coverage: z.array(z.string()).default([]),
});
export type ResearchReport = z.infer<typeof ResearchReport>;

export const ResearchRun = z.object({
  id: z.string(),
  topic: z.string().min(1).max(500),
  sessionId: z.string().nullable().default(null),
  projectId: z.string().nullable().default(null),
  status: ResearchRunStatus.default("planning"),
  questions: z.array(ResearchQuestion).default([]),
  report: ResearchReport.default({}),
  /** Delegated plan the gathering phase ran under. */
  planId: z.string().default(""),
  /** The round now gathering, or the last one gathered. */
  round: z.number().int().min(1).default(1),
  /**
   * How many gathering rounds this run may spend, including the first.
   *
   * A loop that can extend its own plan needs a budget it cannot argue with:
   * the manager decides *whether* to go again, never *how many times*.
   */
  maxRounds: z.number().int().min(1).max(4).default(2),
  /**
   * Sub-agents this run may gather with at once, as approved when it started.
   *
   * Stored on the run rather than held in memory because a follow-up round is
   * not a new decision about how hard to run — it is the same run continuing,
   * and a restart between rounds must not quietly change the answer. Without
   * it the cap the user chose was accepted, audited and then dropped, and every
   * round fell back to the default.
   */
  maxParallel: z.number().int().min(1).max(6).default(3),
  /** One note per completed round — the run's progress ledger. */
  ledger: z.array(ResearchRoundNote).default([]),
  /** Every note the reader left on a report, oldest first. */
  feedback: z.array(ResearchFeedback).default([]),
  /**
   * Whether the round now gathering should end in a new report on its own.
   *
   * Set when a round was opened by reader feedback. Without it the note
   * visibly changed the plan, gathered new evidence and then left the old
   * report on screen until the reader found the write button — which reads as
   * the feedback having done nothing. Persisted rather than held in memory so
   * a restart mid-round still finishes the job it was asked to do.
   */
  pendingRewrite: z.boolean().default(false),
  /**
   * The Agent Framework workflow's own graph, when the sidecar drove the run.
   *
   * Empty for a run gathered by the in-process pipeline: the graph is the
   * sidecar's report of what it executed, and inventing one for a run that had
   * no workflow behind it would be a drawing of nothing.
   */
  graph: ResearchGraph.default({}),
  writerModelId: z.string().default(""),
  correlationId: z.string().default(""),
  error: z.string().default(""),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ResearchRun = z.infer<typeof ResearchRun>;

export const ResearchStartInput = z.object({
  topic: z.string().min(1).max(500),
  projectId: z.string().nullable().default(null),
  /** Questions to seed the plan with. Empty means the agent decomposes it. */
  questions: z.array(z.string().min(1).max(500)).default([]),
  /** Cap on parallel sub-agents, so a wide plan cannot saturate the runtime. */
  maxParallel: z.number().int().min(1).max(6).default(3),
  /**
   * Gathering rounds allowed, including the first. 1 reproduces the old
   * single-pass behaviour; the default spends one follow-up round on whatever
   * the first round left thin.
   */
  maxRounds: z.number().int().min(1).max(4).default(2),
});
export type ResearchStartInput = z.infer<typeof ResearchStartInput>;

/**
 * A note on a finished report, and the request to act on it.
 *
 * The note is prose because that is what a reader has. Turning it into
 * questions is the manager's job and happens on the privileged side, where the
 * same ceilings that bound an autonomous round bound this one — a reader can
 * ask for anything, and the plan still cannot grow past
 * `MAX_TOTAL_QUESTIONS`.
 */
export const ResearchRefineInput = z.object({
  runId: z.string(),
  note: z.string().min(1).max(2000),
});
export type ResearchRefineInput = z.infer<typeof ResearchRefineInput>;

/**
 * Whether a run will accept something, and what to say when it will not.
 *
 * `reason` is written to be shown to a person, because it is shown to a person
 * twice: `ResearchService` throws it, and the surface puts it on the disabled
 * control. That is the whole point of the type — one sentence with one source,
 * so a button cannot promise what the service refuses.
 */
export interface ResearchGate {
  allowed: boolean;
  /** Why not, in the words the user should read. Empty when allowed. */
  reason: string;
}

const RUN_ALLOWED: ResearchGate = { allowed: true, reason: "" };

function refused(reason: string): ResearchGate {
  return { allowed: false, reason };
}

/**
 * Hard ceiling on the questions one run may accumulate across every round.
 *
 * A loop that can extend its own plan needs a bound it cannot reason its way
 * past, and so does a reader who can keep leaving notes. The manager decides
 * *whether* to go again and the reader decides *what to ask*; this decides how
 * far either can ever go.
 *
 * Shared rather than kept in the service because the surface has to refuse a
 * note before sending it. A limit only the privileged side knows is a limit
 * the user meets as an error after they have already written the note.
 */
export const RESEARCH_QUESTION_CEILING = 16;

/**
 * A run's legal transitions, stated once for both sides of the IPC seam.
 *
 * These predicates exist because the alternative kept shipping the same defect:
 * a control whose precondition lives on the privileged side, offered anyway,
 * and reporting the refusal after the click. It happened to the re-run button
 * (which leaked a React key back as `unknown question draft-0-…`), to "Write
 * the report" (visible for the whole of a round, able to answer only "wait for
 * gathering to settle"), and to "Approve plan & gather". The status enum was
 * shared from the start; the *rules over it* were not, so each side re-derived
 * them and they drifted.
 *
 * Every predicate is a pure function of the run. Nothing here reaches for a
 * store, a clock or a model, which is what lets the surface ask the same
 * question the service asks without an IPC round trip — and what lets both be
 * tested without a temporary `IQ_HOME`.
 */

/** Statuses in which the run is doing work of its own. */
export function isRunActive(run: ResearchRun): boolean {
  return (
    run.status === "gathering" ||
    run.status === "reflecting" ||
    run.status === "refining" ||
    run.status === "writing"
  );
}

/**
 * Questions that have not settled.
 *
 * Exported rather than kept private because the surface counts them ("3 of 7
 * still gathering…") and {@link canWriteReport} refuses on them. Two readings
 * of "settled" would be one too many.
 */
export function unsettledQuestions(run: ResearchRun): ResearchQuestion[] {
  return run.questions.filter(
    (question) => question.status === "pending" || question.status === "running",
  );
}

/**
 * A plan the sub-agents are already running against cannot be rewritten
 * underneath them, so editing closes the moment gathering begins.
 */
export function canEditPlan(run: ResearchRun): ResearchGate {
  if (run.status === "planning" || run.status === "awaiting_review") return RUN_ALLOWED;
  return refused(`the plan can no longer be edited (status ${run.status})`);
}

export function canApprovePlan(run: ResearchRun): ResearchGate {
  if (run.status !== "awaiting_review") {
    return refused(`this run is not awaiting review (status ${run.status})`);
  }
  if (run.questions.length === 0) return refused("a research plan needs at least one question");
  return RUN_ALLOWED;
}

/**
 * Writing needs a *settled* round, not merely a gathering run.
 *
 * The coverage summary is derived from the questions' own statuses, so a report
 * assembled mid-round would quote a figure that is about to change.
 *
 * `complete` is allowed as well as `gathering`. A finished run's evidence is
 * settled by definition, so asking for the narrative again is safe — and the
 * button offering exactly that sat on the finished report calling a channel
 * that refused every time it was pressed, because this gate named only
 * `gathering`.
 */
export function canWriteReport(run: ResearchRun): ResearchGate {
  if (run.status !== "gathering" && run.status !== "complete") {
    return refused(`this run is not ready to write (status ${run.status})`);
  }
  const waiting = unsettledQuestions(run).length;
  if (waiting > 0) {
    return refused(
      `${waiting} question${waiting === 1 ? " is" : "s are"} still gathering; wait for the round to settle before writing the report`,
    );
  }
  return RUN_ALLOWED;
}

/**
 * Whether the reader's note on the report can be acted on.
 *
 * Only on a finished run. While anything is still moving the note would be
 * about a report that is about to change, and the reader would be arguing with
 * a moving target.
 *
 * `ceiling` is the plan's hard question limit, passed in rather than imported
 * so the rule stays a pure function of the run and the surface can ask it
 * without an IPC round trip. It is the service's constant; there is one of it.
 */
export function canRefineRun(run: ResearchRun, ceiling: number): ResearchGate {
  if (run.status !== "complete") {
    return refused(`a report can only be revised once the run has finished (status ${run.status})`);
  }
  if (run.report.markdown === "") {
    return refused("there is no report to comment on yet");
  }
  if (run.questions.length >= ceiling) {
    return refused(
      `the plan has reached its ${ceiling}-question ceiling; start a new run to go further`,
    );
  }
  return RUN_ALLOWED;
}

/**
 * Re-run is the Coordinator's per-node retry, so it needs a node to retry.
 *
 * Takes an id rather than a question so that a row the surface invented — one
 * added to the plan and not yet saved — is answered as unknown here instead of
 * being sent to the privileged side and named back at the user.
 */
export function canRerunQuestion(run: ResearchRun, questionId: string): ResearchGate {
  const question = run.questions.find((candidate) => candidate.id === questionId);
  if (!question) return refused(`unknown question ${questionId}`);
  if (run.planId === "" || question.taskId === "") {
    return refused("this question has not been gathered yet; approve the plan first");
  }
  return RUN_ALLOWED;
}

export function canCancelRun(run: ResearchRun): ResearchGate {
  if (!isRunActive(run)) return refused(`this run is not running (status ${run.status})`);
  return RUN_ALLOWED;
}
