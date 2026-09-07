import type { FlowContract, FlowDiagnostic, FlowGraph, FlowNode } from "@iq/shared";
import { isRetired, specOf } from "./catalog.js";
import { sourceHash, topoOrder } from "./graph.js";

/**
 * Checks and description.
 *
 * This surface performs no work. It draws a business process so a person can
 * read it, and the two functions here are the only things done to a drawing:
 * `validate` says what is missing or unreadable, and `describe` writes the
 * same diagram out as an ordered step list and a page of prose.
 *
 * Neither reaches the privileged process. Both are deterministic for a given
 * graph — layout and viewport cannot change the result.
 */

const diag = (
  severity: FlowDiagnostic["severity"],
  code: string,
  message: string,
  nodeId: string | null = null,
  port: string | null = null,
): FlowDiagnostic => ({ severity, code, message, nodeId, port });

// ── Checks ───────────────────────────────────────────────────────────────

/**
 * The rules.
 *
 * Six of them, and each one names something a reader of the diagram would
 * actually stumble over. There is deliberately no cycle rule: work loops —
 * rework, re-review, ask again until the author answers — and a modeler
 * that refuses a back-edge cannot draw the most common process there is.
 *
 * The codes below were re-issued. FLOW001–FLOW009 used to name rules about
 * typed ports, required configuration and stubbed external reach, none of
 * which exist now. FLOW010 keeps its meaning because it is the one rule that
 * outlives palettes.
 */
export const validate = (graph: FlowGraph): FlowDiagnostic[] => {
  const problems: FlowDiagnostic[] = [];

  if (graph.nodes.length === 0) {
    return [diag("info", "FLOW001", "Drop a Start on the canvas to begin.")];
  }

  const starts = graph.nodes.filter((node) => node.kind === "start");
  if (starts.length === 0) {
    problems.push(diag("error", "FLOW002", "A flow needs a Start."));
  }

  // Reachability, over every arrow. An island reads as a second diagram
  // someone forgot to connect.
  const reachable = new Set(starts.map((node) => node.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of graph.edges) {
      if (reachable.has(edge.from) && !reachable.has(edge.to)) {
        reachable.add(edge.to);
        grew = true;
      }
    }
  }

  for (const node of graph.nodes) {
    // A step this vocabulary no longer offers is reported once, plainly, and
    // then left out of every other check: the reader needs to replace it, and
    // burying that under "and it is also unreachable" helps nobody.
    if (isRetired(node.kind)) {
      problems.push(
        diag(
          "warning",
          "FLOW010",
          `${node.label} is a step this canvas no longer offers. Replace or delete it.`,
          node.id,
        ),
      );
      continue;
    }

    const spec = specOf(node.kind);

    // Only the process itself has to be reachable. A Data block sits beside
    // the flow — the ticket somebody files arrives before the Start, by
    // definition — and a Note is a remark about the drawing. Warning about
    // either would train the reader to ignore FLOW003.
    if (spec.family === "flow" && node.kind !== "start" && !reachable.has(node.id)) {
      problems.push(
        diag("warning", "FLOW003", `Nothing leads to ${node.label}.`, node.id),
      );
    }

    // A diamond with one way out is not a decision, it is a step drawn as a
    // diamond. The answers live on the arrows, so fewer than two arrows means
    // the answers were never written down.
    if (node.kind === "decision") {
      const out = graph.edges.filter((edge) => edge.from === node.id).length;
      if (out < 2) {
        problems.push(
          diag(
            "warning",
            "FLOW004",
            `${node.label} has ${out === 0 ? "no way" : "only one way"} out. A decision needs at least two.`,
            node.id,
          ),
        );
      }
    }
  }

  if (!graph.nodes.some((node) => node.kind === "end")) {
    problems.push(diag("warning", "FLOW005", "The flow has no End, so it does not say how it finishes."));
  }

  return problems;
};

export const blocking = (problems: readonly FlowDiagnostic[]): boolean =>
  problems.some((problem) => problem.severity === "error");

// ── Description ──────────────────────────────────────────────────────────

/** The descriptive fields a node carries, in catalogue order, skipping blanks. */
const detailsOf = (node: FlowNode): string[] =>
  specOf(node.kind)
    .config.map((field) => ({ label: field.label, value: (node.config[field.name] ?? "").trim() }))
    .filter((entry) => entry.value !== "")
    .map((entry) => `${entry.label}: ${entry.value}`);

const stepLine = (node: FlowNode): string => {
  const spec = specOf(node.kind);
  const details = detailsOf(node);
  const suffix = details.length === 0 ? "" : ` — ${details.join(" · ")}`;
  return `**${node.label}** (${spec.label})${suffix}`;
};

/**
 * The diagram, in words.
 *
 * Documentation, not a compiled unit. The step list is what a person reads
 * when they cannot see the canvas — in a review pack, in a ticket, pasted into
 * a mail — and the Markdown is the same list with the branches, the things the
 * flow handles and the outcomes written around it.
 *
 * Order comes from `topoOrder`, which falls back to insertion order where a
 * loop makes a topological order impossible. A step inside a loop is still
 * listed; leaving it out would be the description disagreeing with the picture.
 */
export const describe = (graph: FlowGraph): FlowContract => {
  const ordered = topoOrder(graph);
  const labelOf = (id: string): string =>
    graph.nodes.find((node) => node.id === id)?.label ?? "somewhere else";

  const process = ordered.filter((node) => specOf(node.kind).family === "flow");
  const steps = process
    .filter((node) => node.kind !== "start" && node.kind !== "end")
    .map((node, index) => `${index + 1}. ${stepLine(node)}`);

  const startLines = graph.nodes
    .filter((node) => node.kind === "start")
    .map((node) => stepLine(node));
  const endLines = graph.nodes
    .filter((node) => node.kind === "end")
    .map((node) => stepLine(node));
  const dataLines = graph.nodes
    .filter((node) => specOf(node.kind).family === "context")
    .map((node) => stepLine(node));

  // A decision is only half-written without its answers, and the answers are
  // on the arrows. Listing them under the question is the one place the prose
  // can say what the diamond and its labelled arrows say together.
  const decisionLines = ordered
    .filter((node) => node.kind === "decision")
    .flatMap((node) => {
      const question = (node.config["question"] ?? "").trim();
      const head = `- **${node.label}**${question === "" ? "" : ` — ${question}`}`;
      const answers = graph.edges
        .filter((edge) => edge.from === node.id)
        .map(
          (edge) =>
            `  - ${edge.label.trim() === "" ? "(unlabelled)" : edge.label.trim()} → ${labelOf(edge.to)}`,
        );
      return [head, ...answers];
    });

  const hash = sourceHash(graph);

  const markdown = [
    `# ${graph.name}`,
    "",
    `Diagram \`${hash}\`. A description of how the work happens — nothing here runs.`,
    "",
    "## How it starts",
    ...(startLines.length > 0 ? startLines.map((line) => `- ${line}`) : ["- Not stated yet."]),
    "",
    "## The steps",
    ...(steps.length > 0 ? steps : ["1. Nothing yet."]),
    "",
    "## Where it branches",
    ...(decisionLines.length > 0 ? decisionLines : ["- No decisions."]),
    "",
    "## What it handles",
    ...(dataLines.length > 0 ? dataLines.map((line) => `- ${line}`) : ["- Nothing named."]),
    "",
    "## How it ends",
    ...(endLines.length > 0 ? endLines.map((line) => `- ${line}`) : ["- Not stated yet."]),
    "",
  ].join("\n");

  return { flowId: graph.id, name: graph.name, steps, hash, markdown };
};
