import { describe, expect, it } from "vitest";
import { SkillEvolutionRun } from "@iq/shared";
import { SAMPLE_EVOLUTION_RUN } from "../apps/renderer/src/samples/evolution.js";
import { SAMPLE_COUNCIL } from "../apps/renderer/src/samples/council.js";

/**
 * The renderer's two form-filling samples write nothing anywhere — they fill a
 * surface and stop. That is what makes them safe to offer, and it is also what
 * makes them easy to get subtly wrong: nothing validates a constant, so a
 * sample can drift out of shape or start claiming something untrue and no
 * running code would notice.
 *
 * These pin the two properties that matter: the sample is a *valid* record of
 * its own type, and it does not assert anything the app cannot back up.
 */

describe("the skill-evolution sample", () => {
  it("is a valid run record", () => {
    expect(() => SkillEvolutionRun.parse(SAMPLE_EVOLUTION_RUN)).not.toThrow();
  });

  /**
   * It is rendered as a finished run, so anything else would put the card in a
   * state the sample cannot leave — a "running" sample would offer a Stop
   * button that stops nothing.
   */
  it("is finished, not in flight", () => {
    expect(SAMPLE_EVOLUTION_RUN.status).toBe("succeeded");
    expect(SAMPLE_EVOLUTION_RUN.finishedAt).not.toBe("");
  });

  /**
   * The feature's own rule is that a rewrite is only proposed when it beats the
   * original. A sample that showed a proposal scoring below its baseline would
   * teach the reader the opposite of what the code does.
   */
  it("shows an improvement, because that is the only case that proposes", () => {
    const { baseline, best } = SAMPLE_EVOLUTION_RUN;
    expect(baseline).not.toBeNull();
    expect(best).not.toBeNull();
    expect(best!.composite).toBeGreaterThan(baseline!.composite);
  });

  /** Every gate must pass, for the same reason: a blocked rewrite is not proposed. */
  it("passes every gate it lists", () => {
    expect(SAMPLE_EVOLUTION_RUN.constraints.length).toBeGreaterThan(0);
    for (const gate of SAMPLE_EVOLUTION_RUN.constraints) {
      expect(gate.passed, gate.name).toBe(true);
    }
  });

  /**
   * The judge's feedback is the mechanism GEPA works from, so a sample whose
   * candidates carried empty or bland feedback would misrepresent how the
   * feature works — it would look like scoring alone drives the rewrite.
   */
  it("carries substantive feedback on every candidate", () => {
    expect(SAMPLE_EVOLUTION_RUN.candidates.length).toBeGreaterThan(1);
    for (const candidate of SAMPLE_EVOLUTION_RUN.candidates) {
      expect(candidate.feedback.length).toBeGreaterThan(80);
    }
  });

  /** Candidates improve over the run; a flat or falling series is not evolution. */
  it("improves across its candidates", () => {
    const scores = SAMPLE_EVOLUTION_RUN.candidates.map((entry) => entry.score.composite);
    expect(scores.at(-1)).toBeGreaterThan(scores[0] as number);
  });

  /**
   * It runs on Copilot. Naming a Foundry deployment would contradict the
   * precondition the surface enforces, and would be the first thing a reader
   * copied.
   */
  it("names a Copilot model, which is the only kind evolution accepts", () => {
    expect(SAMPLE_EVOLUTION_RUN.modelId.startsWith("copilot:")).toBe(true);
  });
});

describe("the council sample", () => {
  /**
   * Included here because it is the precedent this one follows, and because the
   * property that makes it safe is worth keeping pinned: it carries a question
   * with no correct answer and stances that genuinely pull against each other.
   * A council asked something factual produces agreeing paragraphs and teaches
   * the reader that the feature does nothing.
   */
  it("carries a question and conflicting stances", () => {
    expect(SAMPLE_COUNCIL.question.length).toBeGreaterThan(40);
    expect(SAMPLE_COUNCIL.members.length).toBeGreaterThanOrEqual(3);
    for (const member of SAMPLE_COUNCIL.members) {
      expect(member.name).not.toBe("");
      expect(member.stance.length).toBeGreaterThan(40);
    }
  });

  /** It fills a form and runs nothing, so it must not pin a model or a tool grant. */
  it("grants nothing", () => {
    for (const member of SAMPLE_COUNCIL.members) {
      expect(member.modelId).toBe("");
      expect(member.toolFamilies).toBe("");
    }
  });
});
