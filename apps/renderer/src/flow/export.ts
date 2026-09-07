import type { FlowGraph, FlowNode } from "@iq/shared";
import { specOf, type FlowShape } from "./catalog.js";
import { describe } from "./compile.js";
import { topoOrder } from "./graph.js";

/**
 * Getting a diagram out of the app.
 *
 * Export is what Compile used to be. The canvas produces a description of how
 * work happens, and a description is only worth drawing if it can leave — into
 * a wiki, a slide, a review pack, a pull request. Four formats, each with a
 * job: Mermaid so the diagram stays a diagram and can be edited anywhere,
 * Markdown so it can be read without a renderer, SVG so it can be pasted into
 * a deck, and the `.iqflow` bundle so it can come back here.
 */

/**
 * Mermaid ids.
 *
 * Node ids on the canvas look like `step_lx8f2a3`, which is legal Mermaid but
 * unreadable in a diff. These are `n0`, `n1` … in reading order, so two
 * exports of the same diagram produce the same text.
 */
const idsFor = (nodes: readonly FlowNode[]): Map<string, string> =>
  new Map(nodes.map((node, index) => [node.id, `n${index}`]));

/**
 * Wrap a label in the brackets its shape uses.
 *
 * Labels are quoted. A label is a sentence a person wrote — "Reject, with
 * reasons" — and an unquoted bracket or comma inside one either breaks the
 * diagram or silently changes its shape.
 */
const SHAPE_BRACKETS: Record<FlowShape, readonly [string, string]> = {
  stadium: ["([", "])"],
  box: ["[", "]"],
  diamond: ["{", "}"],
  round: ["(", ")"],
  subroutine: ["[[", "]]"],
};

/** Mermaid has no escape for a quote inside a quoted label; a curly one is safe. */
const quote = (text: string): string => `"${text.replace(/"/g, "\u201d").replace(/\n/g, "\\n")}"`;

/**
 * The diagram as Mermaid `flowchart TD`.
 *
 * Notes are left out. Mermaid flowchart has no annotation shape, and drawing a
 * note as a box would put a remark *about* the diagram *into* it — the reader
 * of the exported file would have no way to tell the two apart.
 */
export const toMermaid = (graph: FlowGraph): string => {
  const drawn = topoOrder(graph).filter((node) => specOf(node.kind).family !== "annotation");
  const ids = idsFor(drawn);
  const lines = [`flowchart TD`];

  for (const node of drawn) {
    const [open, close] = SHAPE_BRACKETS[specOf(node.kind).shape];
    lines.push(`  ${ids.get(node.id) as string}${open}${quote(node.label)}${close}`);
  }

  for (const edge of graph.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    // An arrow to or from a note has nowhere to land once the note is gone.
    if (from === undefined || to === undefined) continue;
    const arrow = edge.style === "dashed" ? "-.->" : "-->";
    const label = edge.label.trim() === "" ? "" : `|${edge.label.trim().replace(/\|/g, "/")}|`;
    lines.push(`  ${from} ${arrow}${label} ${to}`);
  }

  return `${lines.join("\n")}\n`;
};

/** The diagram as prose. Same text the Export tab shows. */
export const toMarkdown = (graph: FlowGraph): string => describe(graph).markdown;

/**
 * The canvas as a standalone SVG.
 *
 * Serialised from React Flow's viewport element with the pan-and-zoom
 * transform baked into a wrapping group, so the file shows what was on screen
 * rather than a picture positioned by a transform the file does not carry.
 * Returns null when the canvas is not mounted — the caller disables the
 * control rather than downloading an empty file.
 */
export const toSvg = (root: HTMLElement | null): string | null => {
  if (root === null) return null;
  const viewport = root.querySelector(".react-flow__viewport") as HTMLElement | null;
  if (viewport === null) return null;

  // The frame is the pane, not the viewport: the viewport is the transformed
  // layer, so its own rect already has the pan and zoom folded in and would
  // give a canvas that grows every time someone zoomed out.
  const box = root.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return null;

  const clone = viewport.cloneNode(true) as HTMLElement;
  clone.style.transform = "";
  const width = Math.ceil(box.width);
  const height = Math.ceil(box.height);

  // foreignObject carries the nodes across as the HTML they already are.
  // Redrawing every card as SVG primitives would be a second renderer to keep
  // in step with the first, and it would drift the first time a card changed.
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<g transform="${viewport.style.transform.replace(/"/g, "")}">`,
    `<foreignObject width="${width}" height="${height}">`,
    `<div xmlns="http://www.w3.org/1999/xhtml">${clone.innerHTML}</div>`,
    `</foreignObject>`,
    `</g>`,
    `</svg>`,
  ].join("");
};
