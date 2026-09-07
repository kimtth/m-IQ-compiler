import type { FlowGraph, FlowNodeKind } from "@iq/shared";
import { parseMermaid, type MermaidGraph, type MermaidNode } from "../industry/mermaid.js";
import { assemble, type AssemblyStep } from "./assemble.js";

/**
 * Mermaid text onto the canvas.
 *
 * The way in for "describe your process": the agent answers with a Mermaid
 * flowchart, and this turns that text into an editable diagram. It reuses the
 * parser IQ Industry already has, because a second Mermaid parser in the same
 * app is a second set of shapes to keep in step with the first.
 *
 * Shape decides kind, which is the whole reason the vocabulary was aligned to
 * Mermaid shapes in the first place. A stadium with nothing leading into it is
 * where the flow begins; every other stadium is an outcome.
 *
 * Null is a first-class answer. The parser returns null for a diagram using
 * anything it does not read — a subgraph, a class definition, another diagram
 * type — and the caller shows the raw text rather than putting a partial
 * drawing on the canvas. Half a diagram silently asserts a process nobody
 * described.
 */

const kindOf = (node: MermaidNode, incoming: number): FlowNodeKind => {
  switch (node.shape) {
    case "stadium":
      return incoming === 0 ? "start" : "end";
    case "diamond":
      return "decision";
    case "round":
      return "data";
    case "subroutine":
      return "subflow";
    default:
      return "step";
  }
};

/** Build a laid-out, editable diagram from a parsed Mermaid graph. */
export const graphFromMermaid = (
  parsed: MermaidGraph,
  name: string,
  projectId: string | null,
): FlowGraph => {
  const index = new Map(parsed.nodes.map((node, at) => [node.id, at]));

  const steps: AssemblyStep[] = parsed.nodes.map((node, at) => {
    const incoming = parsed.edges.filter((edge) => edge.to === node.id);
    return {
      kind: kindOf(node, incoming.length),
      label: node.lines.join(" "),
      // `from: []` on a node with nothing pointing at it, rather than omitted:
      // omitting it means "the step before me", which would invent an arrow
      // the author did not draw.
      from: incoming.flatMap((edge) => {
        const source = index.get(edge.from);
        if (source === undefined || source === at) return [];
        return [{ from: source, label: edge.label, style: edge.dashed ? "dashed" : "solid" }];
      }),
    };
  });

  return assemble(name, steps, projectId);
};

/**
 * Parse Mermaid text and lay it out, or return null.
 *
 * Accepts either a bare diagram or one still inside its fenced block, because
 * an agent asked for a fenced block returns one and stripping the fence at
 * every call site is how one of them ends up forgetting.
 */
export const draftFromMermaid = (
  text: string,
  name: string,
  projectId: string | null,
): FlowGraph | null => {
  const fenced = /```(?:mermaid)?\s*\n([\s\S]*?)```/.exec(text);
  const source = (fenced?.[1] ?? text).trim();
  const parsed = parseMermaid(source);
  if (parsed === null) return null;
  return graphFromMermaid(parsed, name, projectId);
};
