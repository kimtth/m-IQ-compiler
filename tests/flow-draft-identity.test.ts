import { describe, expect, it } from "vitest";
import type { FlowGraph } from "@iq/shared";
import { draftFromCell, draftIdFor } from "../apps/renderer/src/connectome/draft.js";
import { generateLibrary, type DemoIqCell } from "../apps/renderer/src/connectome/fixtures.js";
import { specOf } from "../apps/renderer/src/flow/catalog.js";

/**
 * A reconstructed diagram's identity.
 *
 * My IQ reads a library of IQ Cells; the demo library is
 * generated telemetry rather than something anyone drew, so IQ Workflow
 * rebuilds a diagram from what each cell declares. The rebuild has to land on
 * the *same* id every time, because `flow/reconcile.ts` answers "is this one
 * already here" and "was this one deleted on purpose" from that id alone.
 *
 * When the id was freshly minted each visit, neither question was answerable
 * and every visit added another copy of the whole library.
 */

const cells = generateLibrary();
const cellOf = (id: string): DemoIqCell => {
  const found = cells.find((cell) => cell.id === id);
  if (found === undefined) throw new Error(`no demo cell ${id}`);
  return found;
};

/**
 * The drawing, without the ids.
 *
 * Node ids are minted per rebuild, so two rebuilds of one cell never share
 * them. What has to stay put is the picture: the same kinds, labels, settings
 * and arrows, in the same order.
 */
const shapeOf = (graph: FlowGraph): string => {
  const index = new Map(graph.nodes.map((node, position) => [node.id, position]));
  return JSON.stringify({
    name: graph.name,
    nodes: graph.nodes.map((node) => ({ kind: node.kind, label: node.label, config: node.config })),
    edges: graph.edges
      .map((edge) => [index.get(edge.from), index.get(edge.to), edge.label, edge.style])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
};

describe("reconstructed diagram identity", () => {
  it("rebuilds the same cell to the same id, every time", () => {
    const cell = cellOf("iqcell_00");
    expect(draftFromCell(cell, "wsp").id).toBe(draftIdFor(cell));
    expect(draftFromCell(cell, "wsp").id).toBe(draftFromCell(cell, "wsp").id);
  });

  it("gives every cell in the library its own id", () => {
    const ids = new Set(cells.map((cell) => draftFromCell(cell, "wsp").id));
    expect(ids.size).toBe(cells.length);
  });

  /**
   * The id belongs to the cell, not to the project it is being read in. The
   * project scopes where the diagram is stored; two projects looking at the
   * same cell are looking at the same thing.
   */
  it("does not change with the project", () => {
    const cell = cellOf("iqcell_01");
    expect(draftFromCell(cell, "wsp-a").id).toBe(draftFromCell(cell, "wsp-b").id);
  });

  /**
   * Node ids are minted per rebuild, so the hash of the drawing is not the
   * thing that stays put — the drawing is. `flow/reconcile.ts` compares the
   * shape for exactly this reason: it is what tells it whether someone has
   * edited a reconstruction since it was written.
   */
  it("rebuilds the same drawing until the declarations change", () => {    const cell = cellOf("iqcell_02");
    expect(shapeOf(draftFromCell(cell, "wsp"))).toBe(shapeOf(draftFromCell(cell, "wsp")));

    const renamed = { ...cell, name: `${cell.name} (revised)` };
    expect(shapeOf(draftFromCell(renamed, "wsp"))).not.toBe(shapeOf(draftFromCell(cell, "wsp")));
  });
});

/**
 * What the reconstruction draws.
 *
 * The same evidence the coupling analysis reasons about — consumed artifacts,
 * the work itself, embedded cells, produced artifacts — so the diagram and the
 * map cannot disagree.
 */
describe("reconstructed diagram shape", () => {
  it("opens on a Start and closes on an End", () => {
    for (const cell of cells) {
      const graph = draftFromCell(cell, "wsp");
      expect(graph.nodes.filter((node) => node.kind === "start")).toHaveLength(1);
      expect(graph.nodes.some((node) => node.kind === "end")).toBe(true);
    }
  });

  it("draws an embedded IQ Cell as a subflow, never as another step", () => {
    const embedding = cells.find((cell) => cell.embeds.length > 0);
    if (embedding === undefined) throw new Error("expected the demo library to embed something");

    const graph = draftFromCell(embedding, "wsp");
    for (const embedded of embedding.embeds) {
      const node = graph.nodes.find((candidate) => candidate.label === embedded);
      expect(node?.kind).toBe("subflow");
      expect(node?.config["flow"]).toBe(embedded);
    }
  });

  it("writes only settings the form can show back", () => {
    for (const cell of cells) {
      const graph = draftFromCell(cell, "wsp");
      for (const node of graph.nodes) {
        const fields = new Set(specOf(node.kind).config.map((field) => field.name));
        for (const name of Object.keys(node.config)) {
          expect(fields.has(name), `${node.kind} has no field ${name}`).toBe(true);
        }
      }
    }
  });
});
