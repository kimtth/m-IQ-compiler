import type { FlowGraph, IqCellOrigin } from "@iq/shared";
import { isRetiredFlowNodeKind } from "@iq/shared";
import { draftFromCell } from "../connectome/draft.js";
import type { DemoIqCell } from "../connectome/fixtures.js";
import { deleteFlow, deleteIqCell, listFlows, listIqCells, publishIqCell, saveFlow } from "./storage.js";
import { device } from "./device.js";

/**
 * Keeping a declared set of IQ Cells and the library in agreement.
 *
 * Two sets are declared rather than authored: My IQ's seeded demo
 * library, and the industry primers that ship with the app. Both have the same
 * problem — the surface that shows you a library of IQ Cells and the surface
 * named after the library must not disagree about what exists — and both had
 * the same answer, written twice. This is that answer, once.
 *
 * Each declared cell is reconstructed into a draft, by the same reconstruction
 * the map's Edit control uses and shaped by the surface that made it, and
 * published. They become ordinary records: openable, renameable, deletable,
 * versioned the same way anything else is.
 *
 * Reconciled rather than seeded once. A one-shot seed silently under-covered:
 * anything added afterwards never appeared, and the two surfaces drifted apart
 * again. This adds whatever is missing on every visit and remembers what was
 * deleted, so a removal stays a removal.
 */

const removedKey = (projectId: string | null): string =>
  `iq.iqcells.removed.${projectId ?? "unbound"}`;

const readRemoved = (projectId: string | null): Set<string> => {
  try {
    const raw = device().read(removedKey(projectId));
    return new Set(raw === null ? [] : (JSON.parse(raw) as string[]));
  } catch {
    return new Set();
  }
};

/**
 * Remember that a declared cell was deleted on purpose.
 *
 * Without this, reconciling would put it straight back on the next visit and
 * the delete control would look broken.
 */
export const rememberRemoved = (projectId: string | null, flowId: string): void => {
  const removed = readRemoved(projectId);
  removed.add(flowId);
  device().write(removedKey(projectId), JSON.stringify([...removed]));
};

/**
 * What a draft is, ignoring when it was touched.
 *
 * Used to tell an untouched reconstruction from one someone has since worked
 * on. `updatedAt` is deliberately not part of it: saving a draft stamps the
 * time whether or not anything changed.
 */
const shapeOf = (graph: FlowGraph): string =>
  JSON.stringify({ name: graph.name, nodes: graph.nodes, edges: graph.edges });

/**
 * A saved draft no version of this palette could have produced.
 *
 * These drafts are reconstructions, and reconstructions written by older
 * builds are still on disk: they drew a declared host as an HTTP call, a
 * consumed file as a file-read step and an automation face as a schedule, and
 * all of those kinds were retired. The result opens with its own trigger
 * reported as a retired step, so nothing downstream is reachable and a worked
 * example reads as a dozen errors — which is exactly what a reader is looking
 * at when they conclude the validator is wrong.
 *
 * A retired kind is the test because it is the one thing editing cannot
 * produce: the palette does not offer these steps, so their presence dates the
 * draft rather than describing anyone's work. A draft someone has since
 * changed within the current palette is still theirs and is left alone.
 */
const supersededByPalette = (graph: FlowGraph): boolean =>
  graph.nodes.some((node) => isRetiredFlowNodeKind(node.kind));

/** Returns how many were added. Zero means the library is already in agreement. */
export const reconcileCells = (
  projectId: string | null,
  cells: readonly DemoIqCell[],
): number => {
  const removed = readRemoved(projectId);
  const known = new Set(listIqCells(projectId).map((card) => card.flowId));
  const saved = new Map(listFlows(projectId).map((row) => [row.id, row]));

  let added = 0;
  for (const cell of cells) {
    const draft = draftFromCell(cell, projectId);
    const origin = cell.origin as IqCellOrigin;

    // An earlier build saved every demo draft, including the ones that came
    // from IQ Knowledge and Memories, so an existing install still has them in the
    // editor's workbench. Taken back only when untouched: if someone has since
    // edited one it is their work now, whatever it started as, and deleting it
    // to tidy up a list would be the worse mistake.
    if (origin !== "editor") {
      const stale = saved.get(draft.id);
      if (stale !== undefined && shapeOf(stale) === shapeOf(draft)) {
        deleteFlow(projectId, draft.id);
      }
    }

    // The same argument, for a draft an older palette wrote. Replaced rather
    // than left to be reported step by step: the reader is being shown a
    // worked example, and one that opens as a list of retired steps teaches
    // them to distrust the diagnostics instead of the draft.
    const superseded = saved.get(draft.id);
    if (superseded !== undefined && supersededByPalette(superseded)) {
      if (origin === "editor") saveFlow(projectId, draft);
      else deleteFlow(projectId, draft.id);
      // The card describes the draft, so a refreshed draft is a new version of
      // it: the published manifest was still declaring reach through steps
      // that no longer exist.
      if (known.has(draft.id)) publishIqCell(projectId, draft, origin, cell.originRef ?? []);
    }

    // The draft id is derived from the cell, so "already here" and "deleted on
    // purpose" are both answerable without a second bookkeeping record.
    if (known.has(draft.id) || removed.has(draft.id)) continue;
    // Saved only when the editor is where it came from: the drafts list is what
    // someone drew, not everything that has a graph.
    if (origin === "editor") saveFlow(projectId, draft);
    publishIqCell(projectId, draft, origin, cell.originRef ?? []);
    added += 1;
  }
  return added;
};

/** How many of a declared set are currently in the library. */
export const countCells = (projectId: string | null, cells: readonly DemoIqCell[]): number => {
  const known = new Set(listIqCells(projectId).map((card) => card.flowId));
  let present = 0;
  for (const cell of cells) {
    if (known.has(draftFromCell(cell, projectId).id)) present += 1;
  }
  return present;
};

/**
 * Take a declared set back out, and remember that it was removed.
 *
 * The removal has to be remembered or {@link reconcileCells} puts them straight
 * back on the next visit — which is the same reason a single deleted card is
 * remembered. Only the declared ids are touched: a cell someone published
 * themselves is their work, whatever it happens to be named.
 *
 * Returns how many were removed.
 */
export const removeCells = (projectId: string | null, cells: readonly DemoIqCell[]): number => {
  // Keyed by flow id because that is what a declared cell reconstructs to, but
  // holding the whole card: `deleteIqCell` matches on the **card** id, which is
  // `iqcell_<flowId>` and not the flow id. Passing the flow id deleted nothing
  // while still counting a removal and still remembering it — so Clear reported
  // success, took the draft away, left the published card in the library, and
  // then reconcile could never put it back or refresh it either.
  const cards = new Map(listIqCells(projectId).map((card) => [card.flowId, card]));
  const saved = new Set(listFlows(projectId).map((row) => row.id));

  let removed = 0;
  for (const cell of cells) {
    const draft = draftFromCell(cell, projectId);
    rememberRemoved(projectId, draft.id);
    if (saved.has(draft.id)) deleteFlow(projectId, draft.id);
    const card = cards.get(draft.id);
    if (card !== undefined) {
      deleteIqCell(projectId, card.id);
      removed += 1;
    }
  }
  return removed;
};

/**
 * Forget that a declared set was ever removed, so reconciling adds it again.
 *
 * Without this "clear" would be one-way: the removal record is what makes a
 * deletion stick, and the same record is what would stop a later "load" from
 * having any effect at all.
 */
export const forgetRemoved = (projectId: string | null, cells: readonly DemoIqCell[]): void => {
  const removed = readRemoved(projectId);
  for (const cell of cells) {
    removed.delete(draftFromCell(cell, projectId).id);
  }
  device().write(removedKey(projectId), JSON.stringify([...removed]));
};
