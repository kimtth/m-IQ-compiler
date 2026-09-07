import type { JSX, ReactNode } from "react";

/**
 * Just enough Markdown to render a message body honestly.
 *
 * This exists because of a specific defect: a council verdict comes back as a
 * fenced JSON object, and the transcript printed the fence markers and the JSON
 * as one run of pre-wrapped prose. The most structured answer the app produces
 * was also the least readable one it displayed.
 *
 * Deliberately not a Markdown library. Three constructs are handled — fenced
 * code, `**bold**` and inline `code` — because those are what the models
 * actually emit into a chat turn here, and everything else survives untouched:
 * the bubble is `white-space: pre-wrap`, so a list or a heading still reads as
 * the author wrote it. A parser that half-understood tables and links would
 * change more text than it improved.
 *
 * The fence regex tolerates a *missing* closing fence on purpose. Turns stream,
 * so for most of a block's life the ``` that ends it has not arrived yet, and
 * waiting for it would make the block appear as raw text and then jump.
 */

const FENCE = /```([\w+-]*)[ \t]*\r?\n?([\s\S]*?)(?:```|$)/g;
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;

/** Bold and inline code within one run of prose. */
function inline(text: string, key: string): ReactNode[] {
  return text.split(INLINE).map((part, index) => {
    const id = `${key}:${index}`;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={id}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={id}>{part.slice(2, -2)}</strong>;
    }
    return <span key={id}>{part}</span>;
  });
}

export function MessageBody({ text }: { text: string }): JSX.Element {
  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = 0;

  FENCE.lastIndex = 0;
  for (let match = FENCE.exec(text); match !== null; match = FENCE.exec(text)) {
    // A zero-length match would loop forever; it cannot happen with a literal
    // fence in the pattern, but the guard costs nothing next to that failure.
    if (match[0] === "") break;

    // Trailing whitespace before a fence is the newline that opened it.
    const before = text.slice(cursor, match.index).replace(/\n+$/, "");
    if (before !== "") parts.push(<span key={`t${index}`}>{inline(before, `t${index}`)}</span>);

    const language = match[1] ?? "";
    const code = (match[2] ?? "").replace(/\n+$/, "");
    parts.push(
      <div className="code-block" key={`c${index}`}>
        {language !== "" && <span className="lang">{language}</span>}
        <pre>
          <code>{code}</code>
        </pre>
      </div>,
    );

    cursor = match.index + match[0].length;
    index += 1;
  }

  const rest = text.slice(cursor).replace(/^\n+/, "");
  if (rest !== "") parts.push(<span key="tail">{inline(rest, "tail")}</span>);

  // An empty message still needs an element: the caller styles the container.
  return <>{parts}</>;
}
