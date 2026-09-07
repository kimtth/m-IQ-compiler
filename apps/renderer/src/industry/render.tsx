import { Fragment, type JSX, type ReactNode } from "react";
import { FileQuestion } from "lucide-react";
import { parseMermaid, type MermaidGraph, type MermaidNode } from "./mermaid.js";

/**
 * An Obsidian-style markdown renderer, for the industry primers.
 *
 * Hand-written rather than taken from a library, and deliberately narrow: it
 * renders exactly the constructs the bundled primers use — frontmatter is
 * stripped before it arrives, then headings, paragraphs, bulleted and numbered
 * lists with one level of nesting, tables, `> [!kind]` callouts, fenced code,
 * horizontal rules, and inline bold, italic, code and `[[wikilinks]]`.
 *
 * The narrowness is the point. A general markdown pipeline means either a
 * parser plus a sanitiser plus `dangerouslySetInnerHTML`, or a plugin
 * ecosystem, for a fixed set of five documents that ship with the app. This
 * builds React elements directly, so there is no HTML string anywhere in it and
 * nothing to sanitise — the worst a malformed document can do is render as
 * plain text.
 *
 * `apps/renderer/src/markdown.tsx` stays what it is: three constructs for chat
 * bubbles, where the text is streaming and mostly prose. This is for documents.
 */

export interface Outline {
  readonly id: string;
  readonly text: string;
  readonly level: 1 | 2 | 3;
}

/** A heading's anchor. Stable, so the outline and the document agree. */
export const headingId = (text: string): string =>
  `h-${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;

/**
 * The headings, for the outline pane.
 *
 * Read from the same source as the document rather than from the rendered
 * output: an outline derived from the DOM would be a second traversal that can
 * disagree with the first, and it would need the document to be mounted.
 */
export const outlineOf = (markdown: string): Outline[] => {
  const found: Outline[] = [];
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("```")) fenced = !fenced;
    if (fenced) continue;
    const match = /^(#{1,3})\s+(.*)$/.exec(line);
    if (!match) continue;
    const text = match[2]?.trim() ?? "";
    if (text === "") continue;
    found.push({ id: headingId(text), text, level: match[1]?.length as 1 | 2 | 3 });
  }
  return found;
};

/** How a `[!kind]` callout is labelled when it carries no title of its own. */
const CALLOUT_LABELS: Record<string, string> = {  abstract: "Abstract",
  summary: "Summary",
  note: "Note",
  info: "Info",
  tip: "Tip",
  warning: "Warning",
  danger: "Danger",
  example: "Example",
  quote: "Quote",
};

interface InlineProps {
  text: string;
  /**
   * What a wikilink should do. Returning null from the resolver means the
   * target is not in the bundled set, which is the ordinary case — the primers
   * were written inside a much larger vault.
   */
  onFollow?: (target: string) => void;
  resolves?: (target: string) => boolean;
}

/**
 * Inline spans.
 *
 * One pass with a single alternation rather than four nested passes, because
 * nested passes would have to re-scan text that an earlier pass had already
 * turned into elements — which is how a naive renderer ends up bolding the
 * inside of a code span.
 */
const INLINE = /(\[\[[^\]]+\]\])|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)/g;

export function Inline({ text, onFollow, resolves }: InlineProps): JSX.Element {
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const match of text.matchAll(INLINE)) {
    const at = match.index;
    if (at > last) parts.push(text.slice(last, at));
    const token = match[0];
    last = at + token.length;

    if (token.startsWith("[[")) {
      const body = token.slice(2, -2);
      const bar = body.indexOf("|");
      const target = (bar === -1 ? body : body.slice(0, bar)).trim();
      const label = (bar === -1 ? body : body.slice(bar + 1)).trim();
      const known = resolves?.(target) === true;
      parts.push(
        known ? (
          <button
            key={key++}
            className="wikilink"
            title={`Open ${target}`}
            onClick={() => onFollow?.(target)}
          >
            {label}
          </button>
        ) : (
          // Not a link. The target is outside the bundled set, and rendering a
          // control that cannot do anything is worse than saying so: the icon
          // and the title are what distinguish "not here" from "broken".
          <span key={key++} className="wikilink missing" title={`${target} — not in this set`}>
            {label}
            <FileQuestion size={11} aria-hidden="true" />
          </span>
        ),
      );
      continue;
    }
    if (token.startsWith("`")) {
      parts.push(<code key={key++}>{token.slice(1, -1)}</code>);
      continue;
    }
    if (token.startsWith("**")) {
      parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
      continue;
    }
    parts.push(<em key={key++}>{token.slice(1, -1)}</em>);
  }
  if (last < text.length) parts.push(text.slice(last));

  return <>{parts}</>;
}

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: { text: string; depth: number }[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "callout"; label: string; flavour: string; body: string[] }
  | { kind: "quote"; body: string[] }
  | { kind: "code"; language: string; body: string }
  | { kind: "rule" };

const cells = (line: string): string[] =>
  line
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());

const isSeparator = (line: string): boolean => /^\|?[\s:-]*-[\s:|-]*\|?$/.test(line) && line.includes("-");

/**
 * Split a document into blocks.
 *
 * A line-at-a-time state machine rather than a grammar. Markdown's block level
 * is line-oriented in practice, and the alternative — a recursive parser — buys
 * nothing for documents that never nest a table inside a list.
 */
export const blocksOf = (markdown: string): Block[] => {
  const lines = markdown.split(/\r?\n/);
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      flush();
      continue;
    }

    if (line.startsWith("```")) {
      flush();
      const language = line.slice(3).trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      blocks.push({ kind: "code", language, body: body.join("\n") });
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading[1]?.length as 1 | 2 | 3,
        text: heading[2]?.trim() ?? "",
      });
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }

    if (line.startsWith(">")) {
      flush();
      const body: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith(">")) {
        body.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i += 1;
      }
      i -= 1;
      const marker = /^\[!(\w+)\]\s*(.*)$/.exec(body[0] ?? "");
      if (marker) {
        const flavour = (marker[1] ?? "note").toLowerCase();
        blocks.push({
          kind: "callout",
          flavour,
          label: marker[2]?.trim() || (CALLOUT_LABELS[flavour] ?? flavour),
          body: body.slice(1),
        });
      } else {
        blocks.push({ kind: "quote", body });
      }
      continue;
    }

    if (line.trimStart().startsWith("|") && isSeparator(lines[i + 1] ?? "")) {
      flush();
      const header = cells(line.trim());
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").trimStart().startsWith("|")) {
        rows.push(cells((lines[i] ?? "").trim()));
        i += 1;
      }
      i -= 1;
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const item = /^(\s*)(?:([-*+])|(\d+)\.)\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = item[3] !== undefined;
      const items: { text: string; depth: number }[] = [];
      while (i < lines.length) {
        const next = /^(\s*)(?:([-*+])|(\d+)\.)\s+(.*)$/.exec(lines[i] ?? "");
        if (!next) break;
        // A different marker starts a different list: a numbered sequence and a
        // set of bullets mean different things and must not be merged.
        if ((next[3] !== undefined) !== ordered) break;
        items.push({
          text: next[4] ?? "",
          depth: Math.min(1, Math.floor((next[1]?.length ?? 0) / 2)),
        });
        i += 1;
      }
      i -= 1;
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    paragraph.push(line.trim());
  }
  flush();
  return blocks;
};

export interface MarkdownDocumentProps {
  markdown: string;
  /** Called with a wikilink target the caller said it can resolve. */
  onFollow?: (target: string) => void;
  resolves?: (target: string) => boolean;
}

export function MarkdownDocument({
  markdown,
  onFollow,
  resolves,
}: MarkdownDocumentProps): JSX.Element {
  const inline = (text: string): JSX.Element => (
    <Inline text={text} {...(onFollow ? { onFollow } : {})} {...(resolves ? { resolves } : {})} />
  );

  return (
    <article className="md">
      {blocksOf(markdown).map((block, index) => {
        switch (block.kind) {
          case "heading": {
            const Tag = (["h1", "h2", "h3"] as const)[block.level - 1] ?? "h3";
            return (
              <Tag key={index} id={headingId(block.text)}>
                {inline(block.text)}
              </Tag>
            );
          }
          case "paragraph":
            return <p key={index}>{inline(block.text)}</p>;
          case "rule":
            return <hr key={index} />;
          case "code": {
            // A mermaid block is drawn when it is one this renderer can draw in
            // full, and shown as source otherwise. Partial is not an option: a
            // diagram missing a construct silently asserts a structure the
            // author did not write, while source is at least honestly source.
            const diagram = block.language === "mermaid" ? parseMermaid(block.body) : null;
            if (diagram !== null) return <MermaidFigure key={index} graph={diagram} />;
            return (
              <pre key={index} className="md-code" data-language={block.language}>
                {block.language !== "" && <span className="md-code-language">{block.language}</span>}
                <code>{block.body}</code>
              </pre>
            );
          }
          case "callout":
            return (
              <aside key={index} className={`md-callout ${block.flavour}`}>
                <strong>{block.label}</strong>
                {block.body.map((line, row) => (
                  <p key={row}>{inline(line)}</p>
                ))}
              </aside>
            );
          case "quote":
            return (
              <blockquote key={index}>
                {block.body.map((line, row) => (
                  <p key={row}>{inline(line)}</p>
                ))}
              </blockquote>
            );
          case "table":
            return (
              <div key={index} className="md-table">
                <table>
                  <thead>
                    <tr>
                      {block.header.map((cell, column) => (
                        <th key={column}>{inline(cell)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, column) => (
                          <td key={column}>{inline(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag key={index}>
                {block.items.map((entry, item) => (
                  <Fragment key={item}>
                    <li className={entry.depth > 0 ? "nested" : undefined}>{inline(entry.text)}</li>
                  </Fragment>
                ))}
              </Tag>
            );
          }
        }
      })}
    </article>
  );
}

/**
 * A parsed Mermaid flowchart, as SVG.
 *
 * React elements throughout — there is no SVG string anywhere in this file, so
 * there is nothing to sanitise, which is the same reason the Markdown renderer
 * above it is hand-written. The alternative was the `mermaid` package, which
 * produces markup as text and would have to be injected.
 *
 * The figure is `width: 100%` with a viewBox, so it scales to whatever column
 * the document is in rather than being fixed at the size the layout computed.
 */
function MermaidFigure({ graph }: { graph: MermaidGraph }): JSX.Element {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));

  return (
    <figure className="md-mermaid">
      <svg
        viewBox={`0 0 ${graph.width} ${graph.height}`}
        role="img"
        preserveAspectRatio="xMidYMin meet"
        style={{ maxHeight: graph.height }}
      >
        <defs>
          <marker
            id="md-mermaid-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className="md-mermaid-head" />
          </marker>
        </defs>

        {/* Edges first, so a line never crosses over the box it points at. */}
        {graph.edges.map((edge, index) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          if (!from || !to) return null;
          const start = anchor(from, to, graph.direction);
          const end = anchor(to, from, graph.direction);
          const midX = (start.x + end.x) / 2;
          const midY = (start.y + end.y) / 2;
          return (
            <g key={`${edge.from}-${edge.to}-${index}`}>
              <line
                x1={start.x}
                y1={start.y}
                x2={end.x}
                y2={end.y}
                className={`md-mermaid-link${edge.dashed ? " dashed" : ""}`}
                markerEnd="url(#md-mermaid-arrow)"
              />
              {edge.label !== "" && (
                <>
                  {/* A plate behind the label, because an edge label sits on
                      its own line and is unreadable crossed by it. */}
                  <rect
                    x={midX - (edge.label.length * 3.1 + 4)}
                    y={midY - 8}
                    width={edge.label.length * 6.2 + 8}
                    height={16}
                    className="md-mermaid-label-plate"
                  />
                  <text x={midX} y={midY + 4} className="md-mermaid-label">
                    {edge.label}
                  </text>
                </>
              )}
            </g>
          );
        })}

        {graph.nodes.map((node) => (
          <g key={node.id}>
            {node.shape === "diamond" ? (
              <polygon
                points={diamond(node)}
                className="md-mermaid-node"
              />
            ) : (
              <rect
                x={node.x}
                y={node.y}
                width={node.width}
                height={node.height}
                rx={node.shape === "round" || node.shape === "stadium" ? node.height / 2 : 4}
                className="md-mermaid-node"
              />
            )}
            {node.lines.map((line, row) => (
              <text
                key={row}
                x={node.x + node.width / 2}
                y={node.y + node.height / 2 - ((node.lines.length - 1) * 16) / 2 + row * 16 + 5}
                className="md-mermaid-text"
              >
                {line}
              </text>
            ))}
          </g>
        ))}
      </svg>
    </figure>
  );
}

/**
 * Where an edge meets a box.
 *
 * The edge of the box on the side facing the other node, rather than its
 * centre, so the arrowhead lands on the border instead of under the label.
 */
function anchor(
  node: MermaidNode,
  toward: MermaidNode,
  direction: MermaidGraph["direction"],
): { x: number; y: number } {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  const otherX = toward.x + toward.width / 2;
  const otherY = toward.y + toward.height / 2;

  if (direction === "TD") {
    if (Math.abs(otherY - cy) < 1) {
      return { x: otherX > cx ? node.x + node.width : node.x, y: cy };
    }
    return { x: cx, y: otherY > cy ? node.y + node.height : node.y };
  }
  if (Math.abs(otherX - cx) < 1) {
    return { x: cx, y: otherY > cy ? node.y + node.height : node.y };
  }
  return { x: otherX > cx ? node.x + node.width : node.x, y: cy };
}

const diamond = (node: MermaidNode): string => {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  return [
    `${cx},${node.y}`,
    `${node.x + node.width},${cy}`,
    `${cx},${node.y + node.height}`,
    `${node.x},${cy}`,
  ].join(" ");
};

