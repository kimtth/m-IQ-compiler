import { describe, expect, it } from "vitest";
import { TEMPLATES, fromTemplate } from "../apps/renderer/src/flow/storage.js";
import { toMermaid } from "../apps/renderer/src/flow/export.js";
import { draftFromMermaid } from "../apps/renderer/src/flow/fromMermaid.js";
import { parseMermaid } from "../apps/renderer/src/industry/mermaid.js";
import { specOf } from "../apps/renderer/src/flow/catalog.js";
import { validate } from "../apps/renderer/src/flow/compile.js";

/**
 * Mermaid is the interchange format, so the round trip is the contract.
 *
 * The vocabulary was aligned to Mermaid shapes for exactly one reason: a
 * diagram drawn here has to survive being pasted somewhere else and brought
 * back. Two things are pinned below — that what `toMermaid` writes is what
 * `parseMermaid` reads, and that parsing it back produces the same kinds.
 *
 * The parser is the one IQ Industry already uses. A second Mermaid parser in
 * the same app would be a second set of shapes to keep in step with the first,
 * and the first place they would drift is here.
 */

const exported = () =>
  TEMPLATES.map((template) => ({
    what: template.id,
    graph: fromTemplate(template, "wsp-demo"),
  }));

describe("exported Mermaid", () => {
  it("is read by the parser IQ Industry uses", () => {
    for (const { what, graph } of exported()) {
      const parsed = parseMermaid(toMermaid(graph));
      expect(parsed, `${what} did not parse`).not.toBeNull();
      if (parsed === null) continue;

      // Notes are not exported, so the node count is the drawn ones.
      const drawn = graph.nodes.filter((node) => specOf(node.kind).family !== "annotation");
      expect(parsed.nodes).toHaveLength(drawn.length);
    }
  });

  it("opens with flowchart TD and nothing the parser refuses", () => {
    for (const { what, graph } of exported()) {
      const text = toMermaid(graph);
      expect(text.startsWith("flowchart TD"), what).toBe(true);
      // Styling, subgraphs and click handlers are all things the canvas owns
      // or does not have. Writing one would produce a file this app cannot
      // read back.
      expect(text).not.toMatch(/\b(subgraph|classDef|linkStyle|click|style)\b/);
    }
  });

  it("quotes labels, so a comma or a bracket cannot change a shape", () => {
    const graph = fromTemplate(TEMPLATES[0]!, "wsp-demo");
    const awkward = {
      ...graph,
      nodes: graph.nodes.map((node, index) =>
        index === 1 ? { ...node, label: "Reject, with reasons [see policy]" } : node,
      ),
    };
    const parsed = parseMermaid(toMermaid(awkward));
    expect(parsed).not.toBeNull();
    expect(parsed?.nodes.some((node) => node.lines.join(" ").includes("Reject, with reasons"))).toBe(
      true,
    );
  });

  it("carries the answers on the arrows out of a decision", () => {
    const branching = exported().find(({ graph }) =>
      graph.nodes.some((node) => node.kind === "decision"),
    );
    if (branching === undefined) throw new Error("expected a sample with a decision");

    const parsed = parseMermaid(toMermaid(branching.graph));
    expect(parsed?.edges.some((edge) => edge.label.trim() !== "")).toBe(true);
  });
});

describe("Mermaid round trip", () => {
  /**
   * Draw, export, parse, draw again. The ids and the layout are allowed to
   * change — they are minted per assembly — but the picture is not.
   */
  it("comes back as the same kinds, labels and arrow count", () => {
    for (const { what, graph } of exported()) {
      const back = draftFromMermaid(toMermaid(graph), graph.name, "wsp-demo");
      expect(back, `${what} did not come back`).not.toBeNull();
      if (back === null) continue;

      const drawn = graph.nodes.filter((node) => specOf(node.kind).family !== "annotation");
      expect(back.nodes.map((node) => node.kind).sort()).toEqual(
        drawn.map((node) => node.kind).sort(),
      );
      expect(back.nodes.map((node) => node.label).sort()).toEqual(
        drawn.map((node) => node.label).sort(),
      );
      expect(back.edges).toHaveLength(graph.edges.length);
    }
  });

  it("survives a second trip unchanged", () => {
    for (const { what, graph } of exported()) {
      const once = draftFromMermaid(toMermaid(graph), graph.name, "wsp-demo");
      if (once === null) throw new Error(`${what} did not come back`);
      const twice = draftFromMermaid(toMermaid(once), graph.name, "wsp-demo");
      if (twice === null) throw new Error(`${what} did not come back twice`);
      expect(toMermaid(twice)).toBe(toMermaid(once));
    }
  });

  it("reads a diagram back without a new complaint", () => {
    for (const { what, graph } of exported()) {
      const back = draftFromMermaid(toMermaid(graph), graph.name, "wsp-demo");
      if (back === null) throw new Error(`${what} did not come back`);
      const loud = validate(back).filter((problem) => problem.severity !== "info");
      expect(loud.map((problem) => `${what}: ${problem.code} ${problem.message}`)).toEqual([]);
    }
  });
});

describe("pasted Mermaid", () => {
  const FENCED = [
    "Here is the process.",
    "",
    "```mermaid",
    "flowchart TD",
    '  a(["Request raised"])',
    '  b["Finance checks the budget"]',
    '  c{"Over 10k?"}',
    '  d[["Director approval"]]',
    '  e("Purchase order")',
    '  f(["Order placed"])',
    "  a --> b",
    "  b --> c",
    "  c -->|Yes| d",
    "  c -->|No| e",
    "  d --> e",
    "  e --> f",
    "```",
  ].join("\n");

  it("reads a fenced block and gives each shape its kind", () => {
    const graph = draftFromMermaid(FENCED, "Purchase request", "wsp-demo");
    expect(graph).not.toBeNull();
    if (graph === null) return;

    const kindOf = (label: string) =>
      graph.nodes.find((node) => node.label === label)?.kind;
    expect(kindOf("Request raised")).toBe("start");
    expect(kindOf("Finance checks the budget")).toBe("step");
    expect(kindOf("Over 10k?")).toBe("decision");
    expect(kindOf("Director approval")).toBe("subflow");
    expect(kindOf("Purchase order")).toBe("data");
    // A stadium with something pointing at it is an outcome, not a second start.
    expect(kindOf("Order placed")).toBe("end");
  });

  it("reads the same diagram without its fence", () => {
    const bare = FENCED.split("\n").slice(3, -1).join("\n");
    const fenced = draftFromMermaid(FENCED, "Purchase request", "wsp-demo");
    const plain = draftFromMermaid(bare, "Purchase request", "wsp-demo");
    expect(plain).not.toBeNull();
    if (fenced === null || plain === null) return;
    expect(toMermaid(plain)).toBe(toMermaid(fenced));
  });

  it("keeps the answers written on the branches", () => {
    const graph = draftFromMermaid(FENCED, "Purchase request", "wsp-demo");
    if (graph === null) throw new Error("expected the diagram to parse");
    expect(graph.edges.map((edge) => edge.label).filter((label) => label !== "").sort()).toEqual([
      "No",
      "Yes",
    ]);
  });

  /**
   * Half a diagram silently asserts a process nobody described, so anything
   * the parser cannot read is refused outright and the caller shows the raw
   * text instead.
   */
  it("returns null rather than drawing part of what it was given", () => {
    expect(draftFromMermaid("sequenceDiagram\n  A->>B: hello", "Nope", "wsp-demo")).toBeNull();
    expect(draftFromMermaid("what do you mean", "Nope", "wsp-demo")).toBeNull();
  });
});
