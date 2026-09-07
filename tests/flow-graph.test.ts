import { describe, expect, it } from "vitest";
import type { FlowGraph } from "@iq/shared";
import {
  addNode,
  connect,
  emptyGraph,
  removeNode,
  sourceHash,
  topoOrder,
} from "../apps/renderer/src/flow/graph.js";
import {
  FAMILY_LABELS,
  FAMILY_ORDER,
  SPECS,
  isRetired,
  specOf,
} from "../apps/renderer/src/flow/catalog.js";
import { TEMPLATES, fromTemplate } from "../apps/renderer/src/flow/storage.js";
import { validate } from "../apps/renderer/src/flow/compile.js";
import { draftFromCell } from "../apps/renderer/src/connectome/draft.js";
import { generateLibrary } from "../apps/renderer/src/connectome/fixtures.js";

/**
 * The graph is the surface's only source of truth. It is pure, so it is the
 * part worth pinning: a diagram that reads once must read the same way after a
 * reload, and moving a node must never change its identity.
 */

const seeded = () => {
  const base = emptyGraph("Demo", "wsp-demo");
  const first = addNode(base, "start", 40, 40);
  const second = addNode(first.graph, "step", 340, 40);
  return { graph: second.graph, start: first.node, step: second.node };
};

describe("flow graph", () => {
  it("adds nodes carrying their catalogue label", () => {
    const { graph, start } = seeded();
    expect(graph.nodes).toHaveLength(2);
    expect(start.label).toBe(specOf("start").label);
  });

  /**
   * Work loops. Rework, re-review, chase again until the supplier answers —
   * the most common real process there is has a back-edge in it. The old
   * canvas refused one outright, which meant that process could not be drawn.
   */
  it("allows an edge that closes a cycle", () => {
    const { graph, start, step } = seeded();
    const forward = connect(graph, { from: start.id, to: step.id });
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;

    const back = connect(forward.graph, { from: step.id, to: start.id });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.graph.edges).toHaveLength(2);
  });

  it("refuses only the three drawings that mean nothing", () => {
    const { graph, start, step } = seeded();

    const unknown = connect(graph, { from: start.id, to: "no_such_node" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toMatch(/unknown/i);

    const itself = connect(graph, { from: start.id, to: start.id });
    expect(itself.ok).toBe(false);
    if (!itself.ok) expect(itself.reason).toMatch(/itself/i);

    const first = connect(graph, { from: start.id, to: step.id });
    if (!first.ok) throw new Error("expected the first arrow to connect");
    const again = connect(first.graph, { from: start.id, to: step.id });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toMatch(/already/i);
  });

  it("starts every arrow solid and unlabelled", () => {
    const { graph, start, step } = seeded();
    const drawn = connect(graph, { from: start.id, to: step.id });
    if (!drawn.ok) throw new Error("expected the arrow to connect");
    expect(drawn.edge.label).toBe("");
    expect(drawn.edge.style).toBe("solid");
  });

  it("hashes the source, not the layout", () => {
    const { graph } = seeded();
    const before = sourceHash(graph);
    const moved = {
      ...graph,
      nodes: graph.nodes.map((node) => ({ ...node, x: node.x + 137, y: node.y - 42 })),
    };
    expect(sourceHash(moved)).toBe(before);
  });

  it("drops the edges of a removed node", () => {
    const { graph, start, step } = seeded();
    const linked = connect(graph, { from: start.id, to: step.id });
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linked.graph.edges).toHaveLength(1);

    const pruned = removeNode(linked.graph, step.id);
    expect(pruned.nodes).toHaveLength(1);
    expect(pruned.edges).toHaveLength(0);
  });

  it("orders a connected flow from its start", () => {
    const { graph, start, step } = seeded();
    const linked = connect(graph, { from: start.id, to: step.id });
    if (!linked.ok) throw new Error("expected the arrow to connect");
    const order = topoOrder(linked.graph).map((node) => node.id);
    expect(order.indexOf(start.id)).toBeLessThan(order.indexOf(step.id));
  });

  /**
   * A loop has no topological order, and the reading order still has to name
   * every node. Dropping the steps inside a loop would leave the description
   * disagreeing with the picture.
   */
  it("still returns every node when a loop makes ordering impossible", () => {
    const { graph, start, step } = seeded();
    const forward = connect(graph, { from: start.id, to: step.id });
    if (!forward.ok) throw new Error("expected the arrow to connect");
    const back = connect(forward.graph, { from: step.id, to: start.id });
    if (!back.ok) throw new Error("expected the back-edge to connect");

    const order = topoOrder(back.graph).map((node) => node.id).sort();
    expect(order).toEqual([start.id, step.id].sort());
  });
});

/**
 * The vocabulary is a promise: seven kinds, each with a shape, and every
 * bundled sample has to be something a first-time reader can open without a
 * page of complaints.
 */
describe("flow catalog and samples", () => {
  it("offers exactly the seven kinds, each in a family the palette orders", () => {
    expect(SPECS.map((spec) => spec.kind).sort()).toEqual(
      ["data", "decision", "end", "note", "start", "step", "subflow"].sort(),
    );
    for (const spec of SPECS) expect(FAMILY_ORDER).toContain(spec.family);
    for (const family of FAMILY_ORDER) expect(FAMILY_LABELS[family].length).toBeGreaterThan(0);
  });

  /**
   * Shape is the whole notation. Two kinds may share one — Start and End are
   * both stadiums, exactly as Mermaid draws them — but a kind with no shape
   * cannot be drawn at all.
   */
  it("gives every kind a shape, and uses only the five Mermaid draws", () => {
    const shapes = new Set(SPECS.map((spec) => spec.shape));
    for (const shape of shapes) {
      expect(["stadium", "box", "diamond", "round", "subroutine"]).toContain(shape);
    }
    expect(specOf("start").shape).toBe("stadium");
    expect(specOf("end").shape).toBe("stadium");
    expect(specOf("decision").shape).toBe("diamond");
    expect(specOf("subflow").shape).toBe("subroutine");
    expect(specOf("data").shape).toBe("round");
  });

  /**
   * Who does the work and where it happens are fields on the step, not kinds
   * and not lanes. If they ever became nodes the canvas would be drawing an
   * org chart on top of a process.
   */
  it("carries owner and system as config on a step", () => {
    const fields = specOf("step").config.map((field) => field.name);
    expect(fields).toContain("owner");
    expect(fields).toContain("system");
    expect(SPECS.map((spec) => spec.kind)).not.toContain("owner");
  });

  it("instantiates every sample into a graph with no blocking errors", () => {
    for (const template of TEMPLATES) {
      const graph = fromTemplate(template, "wsp-demo");
      expect(graph.nodes.length).toBe(template.steps.length);
      const errors = validate(graph).filter((problem) => problem.severity === "error");
      expect(errors, `${template.id}: ${errors.map((e) => e.message).join("; ")}`).toEqual([]);
    }
  });

  it("says a flow with no Start cannot be read, and a flow with no End is unfinished", () => {
    const base = emptyGraph("Sketch", "wsp-demo");
    const lonely = addNode(base, "step", 40, 40);

    const problems = validate(lonely.graph);
    expect(problems.find((problem) => problem.code === "FLOW002")?.severity).toBe("error");
    expect(problems.find((problem) => problem.code === "FLOW005")?.severity).toBe("warning");
  });

  it("says a decision with one way out has not written its answers down", () => {
    const base = emptyGraph("Sketch", "wsp-demo");
    const start = addNode(base, "start", 40, 40);
    const decision = addNode(start.graph, "decision", 40, 200);
    const done = addNode(decision.graph, "end", 40, 400);

    const first = connect(done.graph, { from: start.node.id, to: decision.node.id });
    if (!first.ok) throw new Error("expected the arrow to connect");
    const second = connect(first.graph, { from: decision.node.id, to: done.node.id });
    if (!second.ok) throw new Error("expected the arrow to connect");

    const only = validate(second.graph).find((problem) => problem.code === "FLOW004");
    expect(only?.severity).toBe("warning");
    expect(only?.nodeId).toBe(decision.node.id);
  });

  /**
   * A Data block sits beside the flow — the pack a supplier sends in arrives
   * before the Start, by definition — and a Note is a remark about the
   * drawing. Warning about either would train the reader to ignore FLOW003.
   */
  it("does not call a Data block or a Note unreachable", () => {
    const base = emptyGraph("Sketch", "wsp-demo");
    const start = addNode(base, "start", 40, 40);
    const done = addNode(start.graph, "end", 40, 200);
    const data = addNode(done.graph, "data", 340, 40);
    const note = addNode(data.graph, "note", 340, 200);
    const linked = connect(note.graph, { from: start.node.id, to: done.node.id });
    if (!linked.ok) throw new Error("expected the arrow to connect");

    const unreachable = validate(linked.graph).filter((problem) => problem.code === "FLOW003");
    expect(unreachable).toEqual([]);
  });

  it("opens a diagram that uses a step the palette no longer offers", () => {
    // Drafts live in localStorage and outlive the release that wrote them. A
    // retired kind has to render and report itself, not return `undefined` from
    // the catalogue and take the canvas down with it.
    const base = emptyGraph("Old draft", "wsp-demo");
    const start = addNode(base, "start", 40, 40);
    const retired = addNode(start.graph, "work_iq" as never, 40, 260);

    const spec = specOf("work_iq" as never);
    expect(spec.config).toEqual([]);
    expect(isRetired("work_iq" as never)).toBe(true);
    expect(isRetired("step")).toBe(false);

    const problems = validate(retired.graph);
    expect(problems.some((problem) => problem.code === "FLOW010")).toBe(true);
    // And it says so once, rather than also claiming the step is unreachable.
    expect(
      problems.filter((problem) => problem.nodeId === retired.node.id).map((p) => p.code),
    ).toEqual(["FLOW010"]);
  });

  it("says an empty canvas is a starting point, not a fault", () => {
    const problems = validate(emptyGraph("Untitled diagram", "wsp-demo"));
    expect(problems.map((problem) => [problem.code, problem.severity])).toEqual([
      ["FLOW001", "info"],
    ]);
  });
});

/**
 * Every diagram this app draws on someone's behalf.
 *
 * The starter templates and the demo library's reconstructions — worked
 * examples the reader is shown and did not author. A worked example that opens
 * with a page of diagnostics does not teach the notation, it teaches that the
 * diagnostics are noise, which is the more expensive lesson. So the standard
 * is stricter than for a sketch: no errors and no warnings.
 */
describe("generated diagrams", () => {
  const generated = (): { what: string; graph: FlowGraph }[] => [
    ...TEMPLATES.map((template) => ({
      what: `template ${template.id}`,
      graph: fromTemplate(template, "wsp-demo"),
    })),
    ...generateLibrary().map((cell) => ({
      what: `cell ${cell.id}`,
      graph: draftFromCell(cell, "wsp-demo"),
    })),
  ];

  it("reads every generated diagram without an error or a warning", () => {
    for (const { what, graph } of generated()) {
      const loud = validate(graph).filter((problem) => problem.severity !== "info");
      expect(loud.map((problem) => `${what}: ${problem.code} ${problem.message}`)).toEqual([]);
    }
  });

  it("uses only the seven kinds the palette offers", () => {
    for (const { what, graph } of generated()) {
      for (const node of graph.nodes) {
        expect(isRetired(node.kind), `${what}: ${node.label} is a retired kind`).toBe(false);
      }
    }
  });

  it("labels every arrow leaving a decision", () => {
    // An unlabelled branch is a question with the answers left off, which is
    // the one thing a reader always asks about first.
    for (const { what, graph } of generated()) {
      for (const node of graph.nodes.filter((candidate) => candidate.kind === "decision")) {
        for (const edge of graph.edges.filter((candidate) => candidate.from === node.id)) {
          expect(edge.label.trim(), `${what}: ${node.label} has an unlabelled branch`).not.toBe("");
        }
      }
    }
  });
});
