import { z } from "zod";

/**
 * Skill evolution: improving a skill's own text against measured behaviour.
 *
 * The app already has two ways a skill can be proposed — the agent writing one
 * with `propose_skill`, and the curator compiling approved memories into
 * `learned-<subject>`. Both answer "there should be a skill for this". Neither
 * answers "this skill exists and is not working well enough", which is the
 * question an assistant that learns has to be able to ask about itself.
 *
 * The engine is GEPA (Genetic-Pareto reflective prompt evolution) driven by
 * DSPy, running in a Python sidecar. What makes it evolution rather than
 * resampling is that the fitness function returns *language*: a judge says why
 * an answer fell short, and the optimizer mutates the skill text in response to
 * the reason rather than to the number.
 *
 * Two boundaries are load-bearing:
 *
 *  1. **The output is a proposal, never an installed skill.** Evolution
 *     shortens the authoring step and never the review step, exactly as the
 *     memory curator does. A skill is prompt surface, so a person approves it.
 *
 *  2. **Constraints are gates, not advice.** A candidate that fails one is not
 *     proposed at all, however well it scored — a skill that wins on the eval
 *     set by quietly dropping half its procedure has not improved.
 */

export const EvolutionStatus = z.enum([
  /** Reading the skill and building an evaluation set. */
  "preparing",
  /** Scoring the skill as it stands, so there is something to improve on. */
  "baseline",
  /** GEPA is mutating and re-scoring candidates. */
  "evolving",
  /** Checking the winner against the constraint gates. */
  "validating",
  /** Finished, and a proposal was written. */
  "succeeded",
  /** Finished, and nothing was proposed. `problem` says why. */
  "failed",
  "cancelled",
]);
export type EvolutionStatus = z.infer<typeof EvolutionStatus>;

/**
 * One candidate's score.
 *
 * Multi-dimensional rather than a single number because the dimensions trade
 * against each other and the trade is the interesting part: a skill can be made
 * more correct by making it much longer, and `conciseness` plus `lengthPenalty`
 * are what stop that reading as an improvement.
 */
export const EvolutionScore = z.object({
  correctness: z.number().default(0),
  procedureFollowing: z.number().default(0),
  conciseness: z.number().default(0),
  lengthPenalty: z.number().default(0),
  composite: z.number().default(0),
});
export type EvolutionScore = z.infer<typeof EvolutionScore>;

export const EvolutionCandidate = z.object({
  iteration: z.number().int().nonnegative(),
  score: EvolutionScore,
  /**
   * What the judge said, in words.
   *
   * Kept and shown because it is the mechanism, not a log line: GEPA mutates
   * the skill in response to this text. Someone deciding whether to approve the
   * result is entitled to see the reasoning that produced it.
   */
  feedback: z.string().default(""),
});
export type EvolutionCandidate = z.infer<typeof EvolutionCandidate>;

/** One gate. A failure stops the proposal, whatever the score said. */
export const EvolutionConstraint = z.object({
  name: z.string(),
  passed: z.boolean(),
  message: z.string().default(""),
});
export type EvolutionConstraint = z.infer<typeof EvolutionConstraint>;

export const SkillEvolutionRun = z.object({
  id: z.string(),
  skillName: z.string(),
  status: EvolutionStatus,
  /** Empty until a model is resolved. Never defaulted to a hardcoded name. */
  modelId: z.string().default(""),
  startedAt: z.string(),
  finishedAt: z.string().default(""),
  /** How many evaluations the optimizer may spend. The user's budget, not the optimizer's. */
  budget: z.number().int().positive().default(40),
  baseline: EvolutionScore.nullable().default(null),
  best: EvolutionScore.nullable().default(null),
  candidates: z.array(EvolutionCandidate).default([]),
  constraints: z.array(EvolutionConstraint).default([]),
  /** The proposal this run wrote, by name. Empty when nothing was proposed. */
  proposal: z.string().default(""),
  /** Why it ended without one. Empty on success. */
  problem: z.string().default(""),
});
export type SkillEvolutionRun = z.infer<typeof SkillEvolutionRun>;

export const SkillEvolutionInput = z.object({
  name: z.string().min(1),
  /**
   * Evaluations to spend. Bounded here rather than in the sidecar because it is
   * a spending decision: every evaluation is a model call the user pays for.
   */
  budget: z.number().int().min(10).max(200).default(40),
});
export type SkillEvolutionInput = z.infer<typeof SkillEvolutionInput>;

/**
 * Whether evolution can run at all, and what to do about it if not.
 *
 * Reported so the surface can disable the control *with the reason* rather than
 * offering it and reporting the failure afterwards — the precondition lives on
 * the privileged side, so the UI has to be able to ask the same question.
 */
export const SkillEvolutionStatus = z.object({
  ready: z.boolean(),
  version: z.string().default(""),
  /** Why it cannot run. Empty when it can. */
  message: z.string().default(""),
  /** The run in flight, if any. */
  run: SkillEvolutionRun.nullable().default(null),
});
export type SkillEvolutionStatus = z.infer<typeof SkillEvolutionStatus>;

/** Longest a skill body may be. Past this it stops being loaded on demand cheaply. */
export const MAX_SKILL_BODY_BYTES = 15_000;
