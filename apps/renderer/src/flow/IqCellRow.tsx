import { useState } from "react";
import type { JSX } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { IQ_CELL_ORIGIN_LABELS, type IqCellCard } from "@iq/shared";

/**
 * One published IQ Cell.
 *
 * The card used to be an inert `<div>`: it showed a name and a hash and did
 * nothing, so a library of them was a list you could only read. Three things
 * are possible here now, and each is the least surprising version of itself —
 * opening loads the draft the cell was published from onto the canvas, renaming
 * edits in place rather than opening a dialogue, and deleting removes the
 * record while leaving the draft alone.
 *
 * Both places that render this row are editor surfaces — the sidebar beside the
 * canvas, and IQ Cell → IQ Cell library (workflow), which lists cells published
 * from the canvas only — so opening means the same thing in both. Cells from IQ
 * Knowledge and IQ Memories are reached from those surfaces and from the IQ
 * Connectome, which routes by origin.
 *
 * It lives in its own module because the library is shown in two places, and
 * two copies of a row with three destructive-ish actions on it is exactly the
 * kind of duplication that drifts.
 */
export function IqCellRow({
  card,
  open,
  detail,
  onOpen,
  onRename,
  onDelete,
}: {
  card: IqCellCard;
  /** True when this cell's draft is the one currently on the canvas. */
  open?: boolean;
  /** An extra line under the metadata, for context the editor does not need. */
  detail?: string;
  onOpen: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(card.name);

  const commitName = (): void => {
    setEditing(false);
    if (draft.trim() !== "" && draft.trim() !== card.name) onRename(draft);
    else setDraft(card.name);
  };

  return (
    <div className={`iqcell-card${open === true ? " open" : ""}`}>
      <div className="iqcell-head">
        {editing ? (
          <input
            className="iqcell-name"
            value={draft}
            autoFocus
            aria-label={`Rename ${card.name}`}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitName();
              // Escape abandons the edit rather than committing a half-typed
              // name, which is what every other rename field in the app does.
              if (event.key === "Escape") {
                setDraft(card.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            className="iqcell-open"
            title={`Open the draft ${card.name} was published from`}
            onClick={onOpen}
          >
            <strong>{card.name}</strong>
          </button>
        )}
        {!editing && (
          <>
            {open === true && <span className="chip small">open</span>}
            <button
              className="icon"
              title={`Rename ${card.name}`}
              aria-label={`Rename ${card.name}`}
              onClick={() => {
                setDraft(card.name);
                setEditing(true);
              }}
            >
              <Pencil size={13} aria-hidden="true" />
            </button>
            <button
              className="icon"
              title={`Delete ${card.name}`}
              aria-label={`Delete ${card.name}`}
              onClick={onDelete}
            >
              <Trash2 size={13} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
      <span className="muted">
        v{card.version} · {card.faces.join(", ")} · {card.tokensPerRun.toLocaleString()} tokens / run
      </span>
      {/* Which surface made it. Three can, and "someone made this" is not
          an answer to the question a reader arrives with. */}
      <span className={`chip origin ${card.origin}`}>
        {IQ_CELL_ORIGIN_LABELS[card.origin]}
      </span>
      {detail !== undefined && <span className="muted">{detail}</span>}
      <span className="mono muted">{card.contractHash}</span>
    </div>
  );
}

