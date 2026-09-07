import { generateLibrary } from "../connectome/fixtures.js";
import {
  countCells,
  forgetRemoved,
  reconcileCells,
  rememberRemoved,
  removeCells,
} from "../flow/reconcile.js";

/**
 * My IQ's demo library, as records in the IQ Cell library.
 *
 * They were two libraries: the map read a generated demo library that existed
 * only inside the Connectome, and the IQ Cell library listed only what had been
 * compiled by hand. So the surface that shows you a library of IQ Cells and the
 * surface named after the library disagreed about what exists, which is the
 * kind of thing that makes a reader distrust both.
 *
 * They are one library now. The machinery lives in `flow/reconcile.ts`, because
 * the industry primers need exactly the same treatment and had no business
 * being reconciled by a module named after sample data: these cells are worked
 * examples and are switched off with the sample flag, while the primers ship
 * with the app and are not.
 */

export { rememberRemoved };

export const reconcileDemoIqCells = (projectId: string | null): number =>
  reconcileCells(projectId, generateLibrary());

/** How many of the demo cells are currently in the library. */
export const countDemoIqCells = (projectId: string | null): number =>
  countCells(projectId, generateLibrary());

/** Take the demo cells back out, and remember that they were removed. */
export const removeDemoIqCells = (projectId: string | null): number =>
  removeCells(projectId, generateLibrary());

/** Forget that the demo cells were removed, so reconciling adds them again. */
export const forgetRemovedDemoIqCells = (projectId: string | null): void =>
  forgetRemoved(projectId, generateLibrary());
