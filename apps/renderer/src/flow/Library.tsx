import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Package } from "lucide-react";
import {
  IQ_CELL_ORIGIN_LABELS,
  type FlowGraph,
  type IqCellCard,
  type IqCellOrigin,
} from "@iq/shared";
import { IqCellRow } from "./IqCellRow.js";
import { routeForCell, type IqCellRoute } from "./route.js";
import { reconcileIndustryIqCells } from "../industry/cells.js";
import { reconcileDemoIqCells, rememberRemoved, useSampleData } from "../samples/index.js";
import {
  deleteIqCell,
  listFlows,
  listIqCells,
  renameIqCell,
  stageForEditor,
} from "./storage.js";

/**
 * IQ Cell → IQ Cell library.
 *
 * Every published cell in this project, whichever surface made it. The library
 * was editor-scoped for a while and that was the wrong cut: a person looking
 * for "the thing I made" does not remember which of three surfaces they were
 * standing in when they published it, and a library that answers "not here"
 * to two thirds of that question is a filter wearing a library's name.
 *
 * What differs by origin is not whether a cell is listed but **where opening it
 * goes**, because the three are not variations on one another. An editor cell
 * is a procedure someone drew, so the canvas is the answer. A knowledge cell is
 * the index — or one document in it — published so it can be asked questions,
 * so IQ Knowledge is, focused on that document. A memory cell is a set of
 * conventions, so IQ Memories is, with those memories selected. Sending all
 * three to a canvas nobody drew on answered a question two of them were never
 * asked.
 *
 * The editor's own sidebar stays scoped to editor cells and says so — every row
 * there loads a draft onto the canvas beside it, and the other two origins have
 * no draft to load.
 *
 * A cell is a record of one published version, and deleting it leaves whatever
 * it was published from alone: the draft, the index and the memories are all
 * untouched. That is restated on screen here because this is where someone will
 * do the deleting.
 */

interface LibraryProps {
  projectId: string | null;
  onError: (problem: unknown) => void;
  /**
   * Take the reader where the cell was made.
   *
   * One callback rather than one per origin: which surface a route names is
   * `routeForCell`'s answer, and this component's only remaining part in it is
   * staging the draft when the route is the canvas.
   */
  onOpenCell: (route: IqCellRoute) => void;
}

type OriginFilter = IqCellOrigin | "all";

const FILTERS: readonly OriginFilter[] = [
  "all",
  "industry",
  "editor",
  "knowledge",
  "memory",
  "connectome",
];

export function IqCellLibrary({
  projectId,
  onError,
  onOpenCell,
}: LibraryProps): JSX.Element {
  const [cells, setCells] = useState<IqCellCard[]>([]);
  const [drafts, setDrafts] = useState<FlowGraph[]>([]);
  const [term, setTerm] = useState("");
  const [origin, setOrigin] = useState<OriginFilter>("all");
  const [notice, setNotice] = useState<string | null>(null);
  const samples = useSampleData();

  const reload = useCallback(() => {
    setCells(listIqCells(projectId));
    setDrafts(listFlows(projectId));
  }, [projectId]);

  useEffect(reload, [reload]);

  /**
   * My IQ's IQ Cells belong in the IQ Cell library.
   *
   * Reconciled on every visit rather than seeded once: a one-shot seed silently
   * under-covered, because anything added to the demo library afterwards never
   * appeared and the two surfaces drifted apart again. Deletions are
   * remembered, so removing one is still a decision that sticks.
   */
  useEffect(() => {
    // Off means off: the reconcile is what puts the demo cells back, so gating
    // it here is what makes the flag hold. Nothing already in the library is
    // removed — Control Center → Sample data is where that decision is made,
    // because deleting records as a side effect of a preference is not one.
    if (!samples) return;
    try {
      const added = reconcileDemoIqCells(projectId);
      if (added === 0) return;
      reload();
      setNotice(
        `Added ${added} IQ ${added === 1 ? "Cell" : "Cells"} from My IQ. They are ordinary records — rename, open or remove any of them, and they will not come back.`,
      );
    } catch (problem) {
      onError(problem);
    }
  }, [onError, reload, samples, projectId]);

  /**
   * The industry primers belong here too, and are not sample data.
   *
   * Deliberately a second effect rather than a branch inside the first: these
   * five ship with the app, so the sample flag has nothing to say about them.
   * Gating them with it would mean turning off the worked examples also removed
   * five documents that are not worked examples.
   */
  useEffect(() => {
    try {
      if (reconcileIndustryIqCells(projectId) > 0) reload();
    } catch (problem) {
      onError(problem);
    }
  }, [onError, reload, projectId]);

  const shown = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return cells.filter((card) => {
      if (origin !== "all" && card.origin !== origin) return false;
      if (needle === "") return true;
      return (
        card.name.toLowerCase().includes(needle) ||
        card.faces.some((face) => face.includes(needle)) ||
        IQ_CELL_ORIGIN_LABELS[card.origin].toLowerCase().includes(needle)
      );
    });
  }, [cells, origin, term]);

  /**
   * Open a cell where it was made.
   *
   * The destination and its focus are `routeForCell`'s answer, so this surface
   * and My IQ cannot disagree about where a cell belongs. What is
   * left here is the one thing that really is local: the canvas needs a draft,
   * and this library's drafts are the ones saved on this device.
   */
  const open = (card: IqCellCard): void => {
    try {
      const route = routeForCell(card.origin, card.originRef);
      if (route.kind === "editor") {
        const source = drafts.find((row) => row.id === card.flowId);
        if (source === undefined) {
          // Honest rather than silent: the record survived a draft that did not,
          // and pretending otherwise would open an empty canvas.
          setNotice(
            `${card.name} was published from a draft that is no longer saved on this device, so there is nothing to open.`,
          );
          return;
        }
        stageForEditor(projectId, source);
      }
      onOpenCell(route);
    } catch (problem) {
      onError(problem);
    }
  };

  const rename = (card: IqCellCard, name: string): void => {
    setCells(renameIqCell(projectId, card.id, name));
  };

  const remove = (card: IqCellCard): void => {
    if (
      !window.confirm(
        `Remove ${card.name} v${card.version} from the IQ Cell library? Whatever it was published from is kept.`,
      )
    ) {
      return;
    }
    setCells(deleteIqCell(projectId, card.id));
    // So reconciling does not put a demo cell straight back on the next visit,
    // which would make the delete control look broken.
    rememberRemoved(projectId, card.flowId);
    setNotice(`Removed ${card.name} v${card.version}. ${sourceKeptNote(card)}`);
  };

  const totalTokens = cells.reduce((sum, card) => sum + card.tokensPerRun, 0);
  const counts = useMemo(() => {
    const map = new Map<IqCellOrigin, number>();
    for (const card of cells) map.set(card.origin, (map.get(card.origin) ?? 0) + 1);
    return map;
  }, [cells]);

  return (
    <>
      <div className="pane-header">
        <span className="pane-title">IQ Cell library</span>
        <span className="chip beta">Beta · this device</span>
        <span className="muted">
          {cells.length === 0
            ? "Nothing published yet"
            : `${cells.length} published · ${totalTokens.toLocaleString()} tokens per full pass`}
        </span>
        <div className="spacer" />
        <div style={{ width: 240 }}>
          <input
            placeholder="Search the library"
            aria-label="Search the library"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
          />
        </div>
        <button onClick={reload}>Refresh</button>
      </div>

      <div className="pane-body">
        {notice !== null && (
          <div className="notice" onClick={() => setNotice(null)} role="status">
            {notice} <span className="muted">(click to dismiss)</span>
          </div>
        )}

        {cells.length === 0 ? (
          <div className="empty-state">
            <Package size={20} aria-hidden="true" />
            <h2>No IQ Cells yet</h2>
            <p className="muted">
              Publish a diagram from IQ Workflow, an index or a document from IQ Knowledge, or a
              set of conventions from IQ Memories. Whichever you use, the published version is
              recorded here and opens back where it was made.
            </p>
            {/* The empty state's way out is the canvas with nothing staged for
                it, which is the same destination an editor cell routes to. */}
            <button className="primary" onClick={() => onOpenCell({ kind: "editor" })}>
              Open IQ Workflow
            </button>
          </div>
        ) : (
          <>
            {/* Filtering is offered, not imposed. The default is everything,
                because "where did I make that?" is the question this
                destination exists to answer. */}
            <div className="row" style={{ gap: 6, marginBottom: 8 }}>
              {FILTERS.map((value) => (
                <button
                  key={value}
                  className={origin === value ? "primary" : "ghost"}
                  aria-pressed={origin === value}
                  onClick={() => setOrigin(value)}
                >
                  {value === "all" ? "All" : IQ_CELL_ORIGIN_LABELS[value]}
                  <span className="muted">
                    {" "}
                    {value === "all" ? cells.length : (counts.get(value) ?? 0)}
                  </span>
                </button>
              ))}
            </div>

            <div className="iqcell-library">
              {shown.length === 0 && (
                <p className="muted">
                  {term.trim() === ""
                    ? "Nothing published from that surface yet."
                    : `Nothing matches “${term}”.`}
                </p>
              )}
              {shown.map((card) => (
                <IqCellRow
                  key={card.id}
                  card={card}
                  detail={detailFor(card, drafts)}
                  onOpen={() => open(card)}
                  onRename={(name) => rename(card, name)}
                  onDelete={() => remove(card)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

/**
 * The line under a row, which is also the promise the row's name makes.
 *
 * It names the destination rather than the provenance: "Published from Draft 3"
 * says what happened, and this line has to say what clicking will do.
 */
function detailFor(card: IqCellCard, drafts: readonly FlowGraph[]): string {
  if (card.origin === "industry") {
    return "Opens the industry primer it came from in IQ Industry";
  }
  if (card.origin === "knowledge") {
    return card.originRef.length > 0
      ? "Opens the document it came from in IQ Knowledge"
      : "Opens the knowledge index in IQ Knowledge";
  }
  if (card.origin === "memory") {
    const count = card.originRef.length;
    return count === 0
      ? "Opens IQ Memories"
      : `Opens the ${count} ${count === 1 ? "memory" : "memories"} it came from in IQ Memories`;
  }
  if (card.origin === "connectome") {
    const hash = card.originRef[0];
    return hash === undefined
      ? "Opens My IQ"
      : `Opens My IQ — from analysis ${hash}`;
  }
  const source = drafts.find((row) => row.id === card.flowId);
  return source === undefined
    ? "Published from IQ Workflow — the draft is gone"
    : `Opens ${source.name} in IQ Workflow`;
}

/** What survives a delete, said in the terms of the surface that made it. */
function sourceKeptNote(card: IqCellCard): string {
  switch (card.origin) {
    case "industry":
      return "The primer is bundled with the app and is untouched.";
    case "knowledge":
      return "The knowledge index is untouched.";
    case "memory":
      return "The memories it was published from are untouched.";
    default:
      return "Its draft is still in IQ Workflow.";
  }
}
