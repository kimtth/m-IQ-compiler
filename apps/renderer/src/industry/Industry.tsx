import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { BookOpen, Search } from "lucide-react";
import { MarkdownDocument, outlineOf, headingId } from "./render.js";
import {
  INDUSTRY_PRIMERS,
  primerById,
  resolveWikilink,
  withoutFrontMatter,
  type IndustryPrimer,
} from "./primers.js";
/**
 * IQ Cell → IQ Industry (beta).
 *
 * A reading surface for the domain an IQ Cell will run in. It sits first under
 * IQ Cell because it is what happens before a workflow is composed: the fastest
 * way to build the wrong cell is to have read nothing about the business it is
 * for, and the second fastest is to have read something a model wrote about it
 * five seconds earlier.
 *
 * Deliberately inert. Nothing here calls a model, reaches the network, or reads
 * the filesystem — the primers are bundled with the app and rendered by the
 * renderer — so it works signed out, needs no project and no permission, and
 * a reader can be certain that what is on screen is what was written rather
 * than what was generated.
 *
 * It carries no Compile control. All bundled primers are already in the IQ Cell library,
 * which reconciles them on every visit because they ship with the app rather
 * than being something anyone chose to make — so a button here could only
 * version a record that already exists, which is a button that does nothing a
 * reader can see.
 */

export interface IndustryProps {
  onError: (problem: unknown) => void;
  /**
   * A primer to open on arrival, sent by the IQ Cell library or the IQ
   * Connectome when an industry cell is opened. Null is the ordinary case.
   */
  focusPrimerId?: string | null;
}

export function Industry({ focusPrimerId = null }: IndustryProps): JSX.Element {
  const [selectedId, setSelectedId] = useState<string>(
    () => INDUSTRY_PRIMERS[0]?.id ?? "",
  );
  const [term, setTerm] = useState("");
  const documentRef = useRef<HTMLDivElement | null>(null);

  /**
   * Keyed on the value rather than run once: a canvas tab that already exists
   * is not remounted, so a second request from the library has to land too.
   */
  useEffect(() => {
    if (focusPrimerId === null) return;
    if (primerById(focusPrimerId) === null) return;
    setSelectedId(focusPrimerId);
  }, [focusPrimerId]);

  const selected = useMemo<IndustryPrimer | null>(() => primerById(selectedId), [selectedId]);
  const body = useMemo(
    () => (selected === null ? "" : withoutFrontMatter(selected.markdown)),
    [selected],
  );
  const outline = useMemo(() => outlineOf(body), [body]);

  /** Group the list by the primers' own `category` frontmatter. */
  const groups = useMemo(() => {
    const needle = term.trim().toLowerCase();
    const matched = INDUSTRY_PRIMERS.filter(
      (primer) =>
        needle === "" ||
        primer.title.toLowerCase().includes(needle) ||
        primer.category.toLowerCase().includes(needle) ||
        primer.summary.toLowerCase().includes(needle),
    );
    const byCategory = new Map<string, IndustryPrimer[]>();
    for (const primer of matched) {
      byCategory.set(primer.category, [...(byCategory.get(primer.category) ?? []), primer]);
    }
    return [...byCategory.entries()];
  }, [term]);

  /** Scrolling is the document's, so the outline moves it rather than re-rendering. */
  const jumpTo = useCallback((id: string) => {
    documentRef.current?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: "start" });
  }, []);

  // A new document starts at its top. Without this, opening a long primer after
  // scrolling through another one lands the reader in the middle of a sentence
  // that belongs to a different industry.
  useEffect(() => {
    documentRef.current?.scrollTo({ top: 0 });
  }, [selectedId]);

  return (
    <div className="pane-body industry">
      <div className="industry-list">
        <label className="industry-search">
          <Search size={14} aria-hidden="true" />
          <input
            value={term}
            placeholder="Filter primers"
            aria-label="Filter primers"
            onChange={(event) => setTerm(event.target.value)}
          />
        </label>

        {groups.length === 0 && <p className="muted">No primer matches that.</p>}

        {groups.map(([category, primers]) => (
          <section key={category}>
            <h4>{category}</h4>
            {primers.map((primer) => (
              <button
                key={primer.id}
                className={`industry-item${primer.id === selectedId ? " active" : ""}`}
                onClick={() => setSelectedId(primer.id)}
              >
                <span className="label">{primer.title}</span>
                <span className="detail">{primer.summary}</span>
              </button>
            ))}
          </section>
        ))}

        <p className="muted industry-note">
          Primers are bundled with the app and rendered as written. Nothing here calls a model or
          reaches the network.
        </p>
      </div>

      <div className="industry-doc">
        {selected === null ? (
          <p className="muted">Pick a primer to read.</p>
        ) : (
          <>
            <header className="industry-head">
              <div>
                <h3>
                  <BookOpen size={16} aria-hidden="true" /> {selected.title}
                </h3>
                <span className="muted">{selected.category}</span>
              </div>
              {/* No Compile control.

                  The library already holds all bundled primers — it reconciles them on
                  every visit, because they ship with the app rather than being
                  something anyone chose to make. A button whose only possible
                  effect is to version a record that is already there is a
                  button that does nothing a reader can see. */}
            </header>

            <div className="industry-split">
              <nav className="industry-outline" aria-label="Outline">
                {outline.map((entry) => (
                  <button
                    key={entry.id}
                    className={`outline-${entry.level}`}
                    onClick={() => jumpTo(entry.id)}
                  >
                    {entry.text}
                  </button>
                ))}
              </nav>

              <div className="industry-page" ref={documentRef}>
                <MarkdownDocument
                  markdown={body}
                  resolves={(target) => resolveWikilink(target) !== null}
                  onFollow={(target) => {
                    const primer = resolveWikilink(target);
                    if (primer === null) return;
                    setSelectedId(primer.id);
                    jumpTo(headingId(primer.title));
                  }}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
