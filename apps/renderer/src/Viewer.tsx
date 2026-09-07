import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import type { ProjectFile } from "@iq/shared";
import { call } from "./bridge.js";

/**
 * The canvas file viewer.
 *
 * The canvas is where a person judges what the agent produced, so the viewer's
 * job is to make the artefact legible *and* to be unambiguous that this is a
 * view rather than an editor. Editing is the agent's affordance, through a
 * turn that can be approved and audited; a silently editable pane here would
 * create a second, unaudited path to changing the same file.
 *
 * Rendering is type-aware but deliberately shallow. Markdown is rendered by a
 * small, closed subset — headings, lists, quotes, code, emphasis, inline code
 * — with everything escaped first. Project files are agent-written, so they
 * are untrusted input: no raw HTML passthrough, and no link is made clickable,
 * because a rendered document must not become a navigation surface.
 */

type View = "preview" | "source";

const MARKDOWN = new Set(["md", "markdown", "mdx"]);

/** Extensions worth showing line numbers for. Prose reads worse with them. */
const CODE = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "css", "scss", "html",
  "py", "rb", "go", "rs", "java", "cs", "sh", "ps1", "sql", "yml", "yaml", "toml",
  "xml", "ini", "env", "dockerfile", "gradle", "kt", "swift", "c", "h", "cpp",
]);

/*
 * No `onError` prop. A file that cannot be read is reported *in* the viewer,
 * beside the name of the file — which is the rule the rest of the product
 * follows for a surface that cannot act. Raising it to the shell as well would
 * put the same failure in two places, one of them without the context.
 */
export function FileViewer({
  path,
}: {
  path: string;
}): JSX.Element {
  const [file, setFile] = useState<ProjectFile | null>(null);
  const [failed, setFailed] = useState("");
  const [view, setView] = useState<View>("preview");

  const load = useCallback(() => {
    setFile(null);
    setFailed("");
    void call("project:read", { path })
      .then(setFile)
      .catch((problem: unknown) => {
        // A refusal here is usually a deliberate one — binary, too large — so
        // it is shown in place rather than raised as an application error.
        setFailed(problem instanceof Error ? problem.message : String(problem));
      });
  }, [path]);

  useEffect(load, [load]);

  const extension = useMemo(() => extensionOf(path), [path]);
  const isMarkdown = MARKDOWN.has(extension);
  const isCode = CODE.has(extension);

  return (
    <>
      <div className="pane-header">
        <span className="pane-title">{path.split("/").pop()}</span>
        <span className="pill" title="Changes are made by the agent, in a turn you can approve">
          Read only
        </span>
        {file?.truncated && <span className="pill warn">Truncated</span>}
        <div className="spacer" />
        {isMarkdown && file?.kind === "text" && (
          <div className="segmented" role="group" aria-label="View">
            <button
              className={view === "preview" ? "on" : ""}
              onClick={() => setView("preview")}
            >
              Preview
            </button>
            <button className={view === "source" ? "on" : ""} onClick={() => setView("source")}>
              Source
            </button>
          </div>
        )}
        <button className="ghost" onClick={load} title="Re-read from disk">
          Refresh
        </button>
      </div>

      <div className="pane-body viewer">
        <p className="muted path">{path}</p>

        {failed !== "" && <div className="notice">{failed}</div>}
        {failed === "" && file === null && <p className="muted">Loading…</p>}

        {file?.kind === "image" && (
          <div className="image-frame">
            <img src={file.dataUrl} alt={path} />
          </div>
        )}

        {file?.kind === "text" &&
          (isMarkdown && view === "preview" ? (
            <Markdown source={file.text} />
          ) : isCode || !isMarkdown ? (
            <CodeBlock source={file.text} numbered={isCode} />
          ) : (
            <CodeBlock source={file.text} numbered={false} />
          ))}

        {file?.truncated && (
          <p className="muted">
            Shown up to the preview limit. Open the file in its own application to see the rest.
          </p>
        )}
      </div>
    </>
  );
}

/** Source with optional line numbers, rendered as text and never as markup. */
function CodeBlock({ source, numbered }: { source: string; numbered: boolean }): JSX.Element {
  const lines = useMemo(() => source.split("\n"), [source]);
  if (!numbered) return <pre className="source">{source}</pre>;

  return (
    <pre className="source numbered">
      {lines.map((line, index) => (
        <span className="line" key={index}>
          <span className="gutter">{index + 1}</span>
          <span className="text">{line}</span>
        </span>
      ))}
    </pre>
  );
}

/**
 * A closed markdown subset, rendered into React elements.
 *
 * This is not a general markdown implementation and is not meant to become
 * one. It renders structure only, from a fixed grammar, because the input is
 * agent-written: anything it does not recognise stays visible as plain text
 * rather than being interpreted.
 */
function Markdown({ source }: { source: string }): JSX.Element {
  const blocks = useMemo(() => parseBlocks(source), [source]);

  return (
    <div className="markdown">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading": {
            const Tag = (["h1", "h2", "h3", "h4", "h5", "h6"] as const)[block.level - 1] ?? "h6";
            return <Tag key={index}>{inline(block.text)}</Tag>;
          }
          case "code":
            return (
              <pre className="source" key={index}>
                {block.text}
              </pre>
            );
          case "quote":
            return <blockquote key={index}>{inline(block.text)}</blockquote>;
          case "list":
            return block.ordered ? (
              <ol key={index}>
                {block.items.map((item, i) => (
                  <li key={i}>{inline(item)}</li>
                ))}
              </ol>
            ) : (
              <ul key={index}>
                {block.items.map((item, i) => (
                  <li key={i}>{inline(item)}</li>
                ))}
              </ul>
            );
          case "rule":
            return <hr key={index} />;
          default:
            return <p key={index}>{inline(block.text)}</p>;
        }
      })}
    </div>
  );
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "rule" };

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      flush();
      continue;
    }

    if (line.startsWith("```")) {
      flush();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    if (/^ {0,3}(?:---|\*\*\*|___)\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      continue;
    }

    if (line.startsWith(">")) {
      flush();
      blocks.push({ kind: "quote", text: line.replace(/^>\s?/, "") });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const ordered = numbered !== null;
      const items: string[] = [(bullet ?? numbered)?.[1] ?? ""];
      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? "";
        const match = ordered ? /^\s*\d+[.)]\s+(.*)$/.exec(next) : /^\s*[-*+]\s+(.*)$/.exec(next);
        if (!match) break;
        items.push(match[1] ?? "");
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    paragraph.push(line.trim());
  }

  flush();
  return blocks;
}

/**
 * Inline emphasis and code, as React nodes.
 *
 * Building nodes rather than an HTML string is the point: there is no path by
 * which document content can become markup, so a project file cannot inject
 * anything into the app's own DOM.
 */
function inline(text: string): JSX.Element[] {
  const nodes: JSX.Element[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_/g;
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(<span key={key++}>{text.slice(last, match.index)}</span>);
    }
    if (match[1] !== undefined) nodes.push(<code key={key++}>{match[1]}</code>);
    else if (match[2] !== undefined) nodes.push(<strong key={key++}>{match[2]}</strong>);
    else nodes.push(<em key={key++}>{match[3] ?? match[4]}</em>);
    last = match.index + match[0].length;
  }

  if (last < text.length) nodes.push(<span key={key++}>{text.slice(last)}</span>);
  return nodes;
}

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name.toLowerCase() : name.slice(dot + 1).toLowerCase();
}
