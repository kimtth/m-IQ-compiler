import { describe, expect, it } from "vitest";
import { parseMermaid } from "../apps/renderer/src/industry/mermaid.js";

/**
 * The IQ Industry viewer draws supported flowcharts rather than printing their
 * source. Anything outside the accepted subset must fall back to source rather
 * than be drawn incorrectly.
 */

describe("parseMermaid", () => {
  it("keeps an edge label", () => {
    const graph = parseMermaid("flowchart TD\n  A[One] -->|then| B[Two]")!;
    expect(graph.edges[0]?.label).toBe("then");
  });

  it("splits a label on the literal newline mermaid uses", () => {
    const graph = parseMermaid("flowchart TD\n  A[Chip designer\\ncreates a spec] --> B[Fab]")!;
    expect(graph.nodes[0]?.lines).toEqual(["Chip designer", "creates a spec"]);
  });

  /** Ranking excludes a cycle-closing edge and still draws it. */
  it("terminates on a cycle and keeps the edge", () => {
    const graph = parseMermaid(
      "flowchart TD\n  Build[Build] --> Test[Test]\n  Test -->|Defects| Build",
    )!;
    expect(graph.edges.length).toBe(2);
    expect(graph.nodes.length).toBe(2);
  });

  it("ranks a chain in order", () => {
    const graph = parseMermaid("flowchart TD\n  A[One] --> B[Two]\n  B --> C[Three]")!;
    const y = (id: string): number => graph.nodes.find((node) => node.id === id)!.y;
    expect(y("A")).toBeLessThan(y("B"));
    expect(y("B")).toBeLessThan(y("C"));
  });

  it("lays a left-to-right chart out across rather than down", () => {
    const graph = parseMermaid("flowchart LR\n  A[One] --> B[Two]")!;
    const node = (id: string) => graph.nodes.find((entry) => entry.id === id)!;
    expect(node("A").x).toBeLessThan(node("B").x);
  });

  it("reads the shape a node was declared with", () => {
    const graph = parseMermaid("flowchart TD\n  A{Decision} --> B(Round)")!;
    expect(graph.nodes.find((node) => node.id === "A")?.shape).toBe("diamond");
    expect(graph.nodes.find((node) => node.id === "B")?.shape).toBe("round");
  });

  /**
   * Falling back is a first-class answer. A diagram missing its subgraphs would
   * silently assert a structure the author did not write, so the source is
   * shown instead — which is what Obsidian does too.
   */
  it.each([
    ["a subgraph", "flowchart TD\n  subgraph One\n    A[A] --> B[B]\n  end"],
    ["a class definition", "flowchart TD\n  A[A] --> B[B]\n  classDef big fill:#f00"],
    ["a click handler", "flowchart TD\n  A[A] --> B[B]\n  click A href 'https://example.com'"],
    ["a sequence diagram", "sequenceDiagram\n  Alice->>Bob: Hello"],
    ["a pie chart", "pie title Things\n  'One' : 40"],
    ["a right-to-left chart", "flowchart RL\n  A[A] --> B[B]"],
    ["nothing at all", ""],
  ])("returns null for %s", (_case, source) => {
    expect(parseMermaid(source)).toBeNull();
  });
});
