import type { SkillEvolutionRun } from "@iq/shared";

/**
 * A finished evolution run, for the Load sample button.
 *
 * Not a module of the samples hub, and deliberately so: nothing is written
 * anywhere. It fills the card and stops, so there is no "loaded" state to
 * report, nothing to clear from a store, and no proposal sitting in someone's
 * review queue afterwards. What it shares with the real modules is that it is a
 * worked example, which is why it lives here.
 *
 * Skill evolution is the surface that most needs one. A run is minutes of
 * model calls that the user pays for, and until it finishes there is nothing on
 * screen but a status line — so the only way to find out what the feature
 * produces was to buy one. Worse, the honest outcome is often "nothing was
 * proposed", which is correct and reads like a broken feature to someone who
 * has never seen the other outcome.
 *
 * The values and feedback are fabricated. They show the shape of a completed
 * run: the judge names the step at fault and what to add because that text is
 * the mechanism the optimizer works from.
 */
export const SAMPLE_EVOLUTION_RUN: SkillEvolutionRun = {
  id: "sample-evolution",
  skillName: "mail-triage",
  status: "succeeded",
  modelId: "copilot:sample-model",
  startedAt: "2030-01-01T09:00:00.000Z",
  finishedAt: "2030-01-01T09:20:00.000Z",
  budget: 40,
  baseline: {
    correctness: 0.88,
    procedureFollowing: 0.79,
    conciseness: 0.81,
    lengthPenalty: 0,
    composite: 0.846,
  },
  best: {
    correctness: 0.97,
    procedureFollowing: 0.95,
    conciseness: 0.89,
    lengthPenalty: 0,
    composite: 0.945,
  },
  candidates: [
    {
      iteration: 1,
      score: {
        correctness: 0.9,
        procedureFollowing: 0.7,
        conciseness: 0.85,
        lengthPenalty: 0,
        composite: 0.835,
      },
      feedback:
        "The procedure assumes every message is triageable and goes straight to deciding urgency. Add a step before it that checks whether the message carries enough to act on, and branches to \"ask for specifics and stop\" when it does not — otherwise the assistant has to invent a judgement.",
    },
    {
      iteration: 2,
      score: {
        correctness: 0.95,
        procedureFollowing: 0.9,
        conciseness: 0.72,
        lengthPenalty: 0,
        composite: 0.889,
      },
      feedback:
        "Nothing in the procedure bounds the output, so the reply expanded into drafting suggestions and follow-up scheduling that were never asked for. Say that triage ends at the disposition: sender, urgency, and the one action required.",
    },
    {
      iteration: 3,
      score: {
        correctness: 0.97,
        procedureFollowing: 0.95,
        conciseness: 0.89,
        lengthPenalty: 0,
        composite: 0.945,
      },
      feedback:
        "The remaining gap is that urgency is read from the sender's own wording rather than from what the message describes. State that the two are assessed separately, and that a stated priority is overridden when the content does not support it.",
    },
  ],
  constraints: [
    { name: "not empty", passed: true, message: "1,284 characters" },
    { name: "size", passed: true, message: "1,284 of 15,000 bytes" },
    { name: "section coverage", passed: true, message: "kept 4 of 4 sections" },
    {
      name: "purpose preserved",
      passed: true,
      message: "Still triages a mailbox under the same rules; the added steps narrow it rather than widen it.",
    },
  ],
  proposal: "mail-triage",
  problem: "",
};
