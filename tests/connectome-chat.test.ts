import { describe, expect, it } from "vitest";
import { CONNECTOME_PERSONAS, ConnectomePersona, DEFAULT_CONNECTOME_WEIGHTS } from "@iq/shared";
import { generateLibrary } from "../apps/renderer/src/connectome/fixtures.js";
import { analyze, buildReport } from "../apps/renderer/src/connectome/analyze.js";
import { NO_ANSWER, answer, suggestionsFor } from "../apps/renderer/src/connectome/Chat.js";

/**
 * Asking the map questions.
 *
 * The chat answers from the analysis and never from a model, which buys
 * reproducibility at the cost of a finite vocabulary. Both halves of that trade
 * need holding to: the answers must stay correct against the graph, and the
 * questions the surface itself offers must stay inside the vocabulary.
 */

const library = generateLibrary();

const reportFor = (persona: ConnectomePersona = "all") => {
  const selection = {
    projectId: "wsp-demo",
    iqCellIds: library.map((row) => row.id),
    windowDays: 30,
    weights: DEFAULT_CONNECTOME_WEIGHTS,
    persona,
  };
  const { graph, findings } = analyze(library, selection);
  return buildReport(selection, graph, findings);
};

describe("connectome chat", () => {
  /**
   * The property that keeps a demo from dying mid-sentence.
   *
   * Every answer offers follow-ups, and those follow-ups are the only map of
   * what this can do. If one of them leads to "I cannot answer that", the
   * surface has told the reader to ask something it cannot handle — worse than
   * offering nothing. Walking the whole reachable set catches that the moment a
   * suggestion's wording drifts away from the pattern that matches it.
   */
  it("can answer every question it offers, from every persona", () => {
    for (const persona of ConnectomePersona.options) {
      const report = reportFor(persona);
      const seen = new Set<string>();
      const queue = [...suggestionsFor(report, persona)];
      expect(queue.length).toBeGreaterThan(2);

      while (queue.length > 0) {
        const question = queue.shift() as string;
        if (seen.has(question)) continue;
        seen.add(question);
        const reply = answer(question, report, persona);
        expect(reply.headline, `${persona} asked: ${question}`).not.toBe(NO_ANSWER);
        queue.push(...reply.next);
      }

      // A vocabulary of two questions would pass the check above and still be
      // useless, so the reachable set has to be worth exploring.
      expect(seen.size).toBeGreaterThan(6);
    }
  });

  /** Anything a row points at must be selectable, or clicking it does nothing. */
  it("only cites nodes and edges that are on the map", () => {
    const report = reportFor("all");
    const nodes = new Set(report.graph.nodes.map((row) => row.id));
    const edges = new Set(report.graph.edges.map((row) => row.id));

    for (const question of suggestionsFor(report, "all")) {
      for (const row of answer(question, report, "all").rows) {
        if (row.id === null) continue;
        expect(row.kind === "node" ? nodes.has(row.id) : edges.has(row.id), row.id).toBe(true);
      }
    }
  });

  /**
   * The answer worth arriving for: a strength figure taken apart into the
   * comparisons that produced it. A number nobody can check is not evidence,
   * so the arithmetic has to be the real arithmetic.
   */
  it("shows the working when two IQ Cells are named", () => {
    const report = reportFor("all");
    const edge = [...report.graph.edges].sort((a, b) => b.strength - a.strength)[0];
    expect(edge).toBeDefined();
    if (edge === undefined) return;

    const a = report.graph.nodes.find((row) => row.id === edge.source);
    const b = report.graph.nodes.find((row) => row.id === edge.target);
    const reply = answer(`Why are ${a?.name} and ${b?.name} connected?`, report, "all");

    expect(reply.headline).toContain(`${Math.round(edge.strength * 100)}%`);
    expect(reply.rows).toHaveLength(edge.evidence.length);
    for (const [index, item] of edge.evidence.entries()) {
      const weight = DEFAULT_CONNECTOME_WEIGHTS[item.component];
      expect(reply.rows[index]?.value).toBe(
        `${item.score.toFixed(2)} × ${weight.toFixed(2)} = ${(item.score * weight).toFixed(2)}`,
      );
    }
  });

  it("recognizes two IQ Cells when the question adds harmless words", () => {
    const report = reportFor("all");
    const edge = [...report.graph.edges].sort((a, b) => b.strength - a.strength)[0];
    expect(edge).toBeDefined();
    if (edge === undefined) return;

    const a = report.graph.nodes.find((row) => row.id === edge.source);
    const b = report.graph.nodes.find((row) => row.id === edge.target);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a === undefined || b === undefined) return;

    // A person often turns a label into a sentence, for example by inserting
    // "the" before its second word. It still has to show this pair's evidence.
    const withArticle = (name: string): string => name.replace(" ", " the ");
    const reply = answer(
      `Why are ${withArticle(a.name)} and ${withArticle(b.name)} connected?`,
      report,
      "all",
    );

    expect(reply.headline).toContain(`${Math.round(edge.strength * 100)}%`);
    expect(reply.rows).toHaveLength(edge.evidence.length);
  });

  /**
   * The persona sets what is offered and what leads. It must not touch a
   * figure, because a cost that changes with who is asking is not a cost.
   */
  it("changes what it offers per persona without changing the figures", () => {
    const openings = new Map<ConnectomePersona, string>();
    for (const persona of ConnectomePersona.options) {
      const report = reportFor(persona);
      openings.set(persona, suggestionsFor(report, persona).join(" | "));

      const first = answer("What should I do first?", report, persona);
      expect(first.headline).toContain(CONNECTOME_PERSONAS[persona].label);
      expect(first.note).toContain(CONNECTOME_PERSONAS[persona].blindSpot);
    }

    // Nine readers, nine different opening sets — otherwise the control is
    // decoration.
    expect(new Set(openings.values()).size).toBe(ConnectomePersona.options.length);

    const cost = (persona: ConnectomePersona): string =>
      answer("What costs the most?", reportFor(persona), persona)
        .rows.map((row) => `${row.label}=${row.value ?? ""}`)
        .join(",");
    for (const persona of ConnectomePersona.options) {
      expect(cost(persona)).toBe(cost("all"));
    }
  });

  /** Outside the vocabulary, it says so rather than inventing something. */
  it("refuses a question it cannot answer from the graph", () => {
    const report = reportFor("all");
    const reply = answer("Should we hire another engineer next quarter?", report, "all");
    expect(reply.headline).toBe(NO_ANSWER);
    expect(reply.next.length).toBeGreaterThan(3);
  });
});
