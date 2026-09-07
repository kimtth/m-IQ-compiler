import { describe, expect, it } from "vitest";
import {
  CONNECTOME_PERSONAS,
  ConnectomePersona,
  DEFAULT_CONNECTOME_WEIGHTS,
  arrivalOf,
  type ConnectomeSelection,
} from "@iq/shared";
import { generateLibrary } from "../apps/renderer/src/connectome/fixtures.js";
import { analyze, analyzeStaged, buildReport } from "../apps/renderer/src/connectome/analyze.js";

/**
 * The Connectome is rendered, not generated: the same selection must always
 * produce the same graph, the same layout and the same report. That is what
 * makes a finding citable rather than a fresh opinion each time it is opened.
 */

const library = generateLibrary();

const selectionFor = (count: number, persona: ConnectomePersona = "all"): ConnectomeSelection => ({
  projectId: "wsp-demo",
  iqCellIds: library.slice(0, count).map((row) => row.id),
  windowDays: 30,
  weights: DEFAULT_CONNECTOME_WEIGHTS,
  persona,
});

describe("connectome analysis", () => {
  it("generates a stable demo library", () => {
    expect(library.length).toBeGreaterThan(8);
    expect(generateLibrary().map((row) => row.id)).toEqual(library.map((row) => row.id));
  });

  /**
   * The library holds three shapes of IQ Cell — ones that do work and write
   * artifacts, ones that answer questions over the vault, and ones that apply
   * a convention. A library of one shape would leave the coupling analysis
   * with nothing to say, because everything in it would couple the same way.
   *
   * The origin is no longer what tells them apart: nothing generates a diagram
   * from IQ Knowledge or Memories any more, so every demo cell says it came
   * from the editor. What they declare is the real difference.
   */
  it("contains IQ Cells of all three shapes", () => {
    expect([...new Set(library.map((row) => row.origin))]).toEqual(["editor"]);

    const asking = library.filter((row) => row.id.startsWith("iqcell_k"));
    const conventions = library.filter((row) => row.id.startsWith("iqcell_m"));
    const working = library.filter((row) => row.id.startsWith("iqcell_0"));
    expect(asking.length).toBeGreaterThan(0);
    expect(conventions.length).toBeGreaterThan(0);
    expect(working.length).toBeGreaterThan(0);

    // A question-answering cell that wrote artifacts like a working one would
    // just be a working cell with a different label.
    expect(asking.every((row) => row.producesArtifacts.length === 0)).toBe(true);
    expect(asking.every((row) => row.reach.includes("Vault index"))).toBe(true);
    expect(conventions.every((row) => row.producesArtifacts.length === 0)).toBe(true);
    expect(conventions.every((row) => row.paths.length === 0)).toBe(true);
    expect(working.some((row) => row.producesArtifacts.length > 0)).toBe(true);
  });

  it("is deterministic for a selection, down to the layout", () => {
    const selection = selectionFor(12);
    const first = analyze(library, selection);
    const second = analyze(library, selection);
    expect(second.graph.hash).toBe(first.graph.hash);
    expect(second.graph.nodes.map((node) => node.position)).toEqual(
      first.graph.nodes.map((node) => node.position),
    );
    expect(second.graph.edges.map((edge) => edge.strength)).toEqual(
      first.graph.edges.map((edge) => edge.strength),
    );
  });

  /**
   * The progress reading is only honest if the run it reports on is the run
   * that would have happened anyway. Two code paths over the same maths is
   * exactly the kind of thing that drifts, so the equality is asserted rather
   * than assumed.
   */
  it("produces an identical graph whether it is run in stages or in one go", async () => {
    const selection = selectionFor(16);
    const direct = analyze(library, selection);
    const stages: string[] = [];
    const staged = await analyzeStaged(
      library,
      selection,
      (stage) => {
        if (stages.at(-1) !== stage) stages.push(stage);
      },
      async () => {},
    );

    expect(staged.graph).toEqual(direct.graph);
    expect(staged.findings).toEqual(direct.findings);
    // And it reports every phase, in order, so the bar cannot skip one.
    expect(stages).toEqual(["compare", "group", "place", "read"]);
  });

  it("changes the hash when the weights change", () => {    const base = analyze(library, selectionFor(12));
    const tweaked = analyze(library, {
      ...selectionFor(12),
      weights: { ...DEFAULT_CONNECTOME_WEIGHTS, co_activation: 0.1 },
    });
    expect(tweaked.graph.hash).not.toBe(base.graph.hash);
  });

  it("only connects IQ-cells that were selected", () => {
    const selection = selectionFor(6);
    const { graph } = analyze(library, selection);
    const ids = new Set(selection.iqCellIds);
    expect(graph.nodes).toHaveLength(6);
    for (const edge of graph.edges) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }
  });

  it("gives every edge the evidence it was derived from", () => {
    const { graph } = analyze(library, selectionFor(14));
    expect(graph.edges.length).toBeGreaterThan(0);
    for (const edge of graph.edges) {
      expect(edge.evidence.length).toBeGreaterThan(0);
      expect(edge.strength).toBeGreaterThan(0);
      expect(edge.strength).toBeLessThanOrEqual(1);
    }
  });

  it("writes a report that states its limits", () => {
    const selection = selectionFor(14);
    const { graph, findings } = analyze(library, selection);
    const report = buildReport(selection, graph, findings);
    expect(report.markdown).toContain("My IQ");
    expect(report.limits.length).toBeGreaterThan(0);
    expect(report.limits.join(" ")).toMatch(/demo/i);
    for (const finding of report.findings) {
      expect(finding.action.length).toBeGreaterThan(0);
      expect(finding.cites.length).toBeGreaterThan(0);
    }
  });

  /**
   * A persona is a reading order, not a filter. Two properties have to hold
   * together, because either alone would be a different feature: the reader's
   * concern comes first, and every other finding is still there. A lens that
   * dropped what it was not aimed at would make the surface less trustworthy
   * the more precisely it was pointed.
   */
  it("orders the findings for a persona without dropping any", () => {
    const base = selectionFor(20);
    const { graph, findings } = analyze(library, base);
    const everything = buildReport(base, graph, findings);

    for (const persona of ConnectomePersona.options) {
      const read = buildReport({ ...base, persona }, graph, findings);
      expect(read.findings.length).toBe(everything.findings.length);
      expect(read.findings.map((row) => row.title).sort()).toEqual(
        everything.findings.map((row) => row.title).sort(),
      );

      const leads = CONNECTOME_PERSONAS[persona].leads;
      const led = read.findings.filter((row) => leads.includes(row.kind));
      expect(read.findings.slice(0, led.length)).toEqual(led);
      expect(read.markdown).toContain(CONNECTOME_PERSONAS[persona].label);
      expect(read.limits).toContain(CONNECTOME_PERSONAS[persona].blindSpot);
    }
  });

  /**
   * A persona that reads the findings in the same order as another persona is
   * a label on a dropdown. Worse than absent: it tells someone their
   * perspective was taken into account when nothing was done with it.
   */
  it("gives every persona a reading no other persona already has", () => {
    const orders = ConnectomePersona.options.map((persona) =>
      CONNECTOME_PERSONAS[persona].leads.join(">"),
    );
    expect(new Set(orders).size).toBe(orders.length);

    for (const persona of ConnectomePersona.options) {
      const lens = CONNECTOME_PERSONAS[persona];
      expect(lens.label.length).toBeGreaterThan(0);
      expect(lens.question).toMatch(/\?/);
      expect(lens.blindSpot.length).toBeGreaterThan(0);
    }
  });

  /**
   * The picture must not move when the reader changes. Persona is deliberately
   * outside the hash: the same body of work seen by two people is still one
   * body of work, and a map that re-laid itself on a dropdown would say the
   * opposite.
   */
  it("leaves the graph untouched when the persona changes", () => {
    const everything = analyze(library, selectionFor(20));
    const security = analyze(library, selectionFor(20, "security"));
    expect(security.graph).toEqual(everything.graph);
  });
});

/**
 * The time lapse is derived from the analysis, so it inherits the analysis's
 * determinism: the same selection always assembles in the same order, or the
 * playback is not something a reader can cite.
 *
 * It replaced a guided tour that flew the camera between stops. That showed
 * where things are, one at a time, and never showed change — a workload steady
 * for a month and one that appeared last Tuesday drew identically.
 */
describe("connectome time lapse", () => {
  it("puts every IQ Cell somewhere on the window", () => {
    const { graph } = analyze(library, selectionFor(12));
    for (const node of graph.nodes) {
      const at = arrivalOf(node.lastRunDaysAgo);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThanOrEqual(1);
    }
  });

  it("carries each cell's last run onto the graph", () => {
    // The edges knew when they were last active and the nodes did not, so a
    // played-back picture could grow its tracts and not its cells.
    const { graph } = analyze(library, selectionFor(12));
    for (const node of graph.nodes) {
      const cell = library.find((row) => row.id === node.id);
      expect(node.lastRunDaysAgo).toBe(cell?.lastRunDaysAgo);
    }
  });

  it("ends on the whole graph and starts on less than it", () => {
    // Otherwise the playback is a fade-in rather than a time lapse: nothing is
    // gained by watching it, because every moment shows the same thing.
    const { graph } = analyze(library, selectionFor(16));
    const landedBy = (epoch: number): number =>
      graph.nodes.filter((node) => arrivalOf(node.lastRunDaysAgo) <= epoch).length;

    expect(landedBy(1)).toBe(graph.nodes.length);
    expect(landedBy(0.1)).toBeLessThan(graph.nodes.length);
  });

  it("puts a cell and the tracts into it on one clock", () => {
    // An edge is as recent as its *least* recent end, so no tract can arrive
    // before both the cells it joins — which would draw a coupling between
    // things that are not on screen yet.
    const { graph } = analyze(library, selectionFor(14));
    const arrival = new Map(
      graph.nodes.map((node) => [node.id, arrivalOf(node.lastRunDaysAgo)]),
    );
    for (const edge of graph.edges) {
      const a = arrival.get(edge.source) ?? 0;
      const b = arrival.get(edge.target) ?? 0;
      // Three places, because `recency` is rounded to four when it is written
      // onto the edge; the claim is that they are the same number, not that
      // they were computed by the same expression.
      expect(edge.recency).toBeCloseTo(Math.min(a, b), 3);
    }
  });

  it("is deterministic for a selection", () => {
    const selection = selectionFor(12);
    const arrivals = (): number[] =>
      analyze(library, selection).graph.nodes.map((node) => arrivalOf(node.lastRunDaysAgo));
    expect(arrivals()).toEqual(arrivals());
  });
});