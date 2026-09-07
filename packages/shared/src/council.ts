import { z } from "zod";

/**
 * Council contracts for Chat → Team.
 *
 * A council answers questions a single agent answers badly: trade-offs, design
 * choices, prioritisation, risk. Members argue in rounds and a chair — distinct
 * from the members — calls the debate and writes a structured verdict.
 *
 * Two safety properties are encoded here rather than left to the UI: the round
 * budget is required up front, because a council multiplies token spend; and a
 * member's tool grant is a subset of the session's, never a superset.
 */

export const CouncilMember = z.object({
  id: z.string(),
  name: z.string().min(1).max(60),
  /** Role brief: advocate, skeptic, cost, security, end user, and so on. */
  stance: z.string().min(1).max(400),
  /** Catalogue id from the model registry, or "" for the council default. */
  modelId: z.string().default(""),
  skills: z.array(z.string()).default([]),
  /** Never broader than the session's own grant; narrowed at run start. */
  toolFamilies: z.array(z.string()).default([]),
});
export type CouncilMember = z.infer<typeof CouncilMember>;

export const CouncilPreset = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  members: z.array(CouncilMember).min(2).max(6),
  builtIn: z.boolean().default(false),
});
export type CouncilPreset = z.infer<typeof CouncilPreset>;

export const CouncilPhase = z.enum(["opening", "rebuttal", "convergence", "verdict"]);
export type CouncilPhase = z.infer<typeof CouncilPhase>;

export const CouncilToolCall = z.object({
  name: z.string(),
  summary: z.string(),
  ok: z.boolean(),
});
export type CouncilToolCall = z.infer<typeof CouncilToolCall>;

export const CouncilContribution = z.object({
  id: z.string(),
  round: z.number().int().min(0),
  phase: CouncilPhase,
  memberId: z.string(),
  memberName: z.string(),
  stance: z.string(),
  modelId: z.string(),
  /** One line for the collapsed card; `argument` is the expansion. */
  summary: z.string(),
  argument: z.string(),
  toolCalls: z.array(CouncilToolCall).default([]),
  at: z.string().datetime(),
});
export type CouncilContribution = z.infer<typeof CouncilContribution>;

export const CouncilDissent = z.object({
  memberId: z.string(),
  memberName: z.string(),
  position: z.string(),
});
export type CouncilDissent = z.infer<typeof CouncilDissent>;

export const CouncilVerdict = z.object({
  recommendation: z.string(),
  criteria: z.array(z.string()).default([]),
  strongestFor: z.string().default(""),
  strongestAgainst: z.string().default(""),
  dissent: z.array(CouncilDissent).default([]),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
  openQuestions: z.array(z.string()).default([]),
  /** Project-relative Markdown export, or "" when no project is bound. */
  path: z.string().default(""),
  at: z.string().datetime(),
});
export type CouncilVerdict = z.infer<typeof CouncilVerdict>;

export const CouncilRunStatus = z.enum([
  "running",
  "awaiting_input",
  "complete",
  "failed",
  "cancelled",
]);
export type CouncilRunStatus = z.infer<typeof CouncilRunStatus>;

export const CouncilRun = z.object({
  id: z.string(),
  question: z.string(),
  /**
   * What this run is *called*, as distinct from what it was *asked*.
   *
   * Empty by default, which means "call it by its question". A run is listed
   * in the rail and in a picker by one line, and a debatable question is a
   * sentence — so the history read as a column of near-identical truncations
   * and there was no way to tell two rounds of the same argument apart.
   *
   * It is a separate field rather than an editable `question` on purpose. The
   * question is what the members were actually given: it is quoted in the
   * transcript, in the verdict and in the audit record, and a history whose
   * question could be rewritten after the fact would be a history that cannot
   * be trusted to say what was argued. Renaming changes the label and nothing
   * else.
   */
  title: z.string().max(120).default(""),
  sessionId: z.string().nullable().default(null),
  projectId: z.string().nullable().default(null),
  members: z.array(CouncilMember),
  roundBudget: z.number().int().min(1).max(6),
  roundsRun: z.number().int().min(0).default(0),
  phase: CouncilPhase.default("opening"),
  status: CouncilRunStatus.default("running"),
  contributions: z.array(CouncilContribution).default([]),
  verdict: CouncilVerdict.nullable().default(null),
  /** Live spend estimate, so the multiplier is visible while it runs. */
  estimatedTokens: z.number().int().min(0).default(0),
  /** Constraints the user injected at a round boundary. */
  injections: z
    .array(z.object({ round: z.number().int(), text: z.string(), at: z.string().datetime() }))
    .default([]),
  correlationId: z.string().default(""),
  error: z.string().default(""),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CouncilRun = z.infer<typeof CouncilRun>;

/** A rail row and a picker option are one line, so a title is a label. */
export const MAX_COUNCIL_TITLE_LENGTH = 80;

/**
 * Reduce a typed title to something that fits a row.
 *
 * First non-empty line only, collapsed, trailing punctuation dropped — the
 * same treatment a conversation's title gets, because they are listed side by
 * side in the same rail and two rules would show as two styles.
 */
export const normalizeCouncilTitle = (raw: string): string => {
  const firstLine = raw.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed === "") return "";
  const clipped =
    collapsed.length > MAX_COUNCIL_TITLE_LENGTH
      ? `${collapsed.slice(0, MAX_COUNCIL_TITLE_LENGTH - 1).trimEnd()}\u2026`
      : collapsed;
  return clipped.replace(/[\s,.;:!?]+$/u, "") || clipped;
};

/**
 * What to show for a run.
 *
 * One function, so the rail, the picker and the run card can never disagree
 * about what a run is called. An unnamed run falls back to its question, which
 * is what every one of them showed before titles existed.
 */
export const councilRunTitle = (run: Pick<CouncilRun, "title" | "question">): string =>
  run.title.trim() || run.question;

export const CouncilRenameInput = z.object({
  runId: z.string().min(1),
  /** Empty clears the name and puts the run back to being called by its question. */
  title: z.string().max(120),
});
export type CouncilRenameInput = z.infer<typeof CouncilRenameInput>;

export const CouncilStartInput = z.object({
  question: z.string().min(1).max(2_000),
  members: z.array(CouncilMember.omit({ id: true }).extend({ id: z.string().optional() })).min(2).max(6),
  roundBudget: z.number().int().min(1).max(6).default(3),
  sessionId: z.string().nullable().default(null),
  projectId: z.string().nullable().default(null),
});
export type CouncilStartInput = z.infer<typeof CouncilStartInput>;

/**
 * Rough per-run token estimate, shown before the user commits.
 *
 * Deliberately coarse and stated as an estimate: the point is to make the
 * multiplier visible, not to bill anyone.
 */
export function estimateCouncilTokens(members: number, roundBudget: number): number {
  const perTurn = 1_200;
  const chairTurns = roundBudget + 2;
  return (members * roundBudget + chairTurns) * perTurn;
}
