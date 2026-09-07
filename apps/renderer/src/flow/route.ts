import type { IqCellOrigin } from "@iq/shared";

/**
 * Where an IQ Cell opens, and what the destination should land on.
 *
 * "An IQ Cell opens where it was made" is behaviour, and until this module
 * existed it was behaviour with no home: the same five-arm decision was written
 * in `flow/Library.tsx` and again in `connectome/Connectome.tsx`, at different
 * fidelity — the library passed the cell's `originRef` through, the Connectome
 * dropped it and had no `connectome` arm at all. Each surface then carried one
 * `onOpen*` callback per origin (five and four), so a sixth origin meant nine
 * edits across seven files.
 *
 * The rule is a pure function of the origin now. Both surfaces ask it, both
 * hand the shell one {@link IqCellRoute}, and the shell is the only thing that
 * knows how to navigate.
 */

/**
 * The empty reference, shared.
 *
 * One frozen array rather than a fresh `[]` per call, because the receiving
 * surfaces key an effect on the value they are given: a new array identity on
 * every route would re-run `MemoriesCenter`'s selection effect for a route that
 * selected nothing.
 */
const NO_REFS: readonly string[] = Object.freeze([]);

export type IqCellRoute =
  /**
   * The canvas. Carries no draft: the two callers get one from different
   * places — the library from what is saved on this device, the Connectome by
   * rebuilding it from the cell's own declarations — and that genuinely is
   * their business rather than the router's.
   */
  | { kind: "editor" }
  /** IQ Knowledge, on the graph node the cell came from. */
  | { kind: "knowledge"; nodeId: string | null }
  /** IQ Memories, with the cell's source memories selected. */
  | { kind: "memories"; memoryIds: readonly string[] }
  /** IQ Industry, on the primer the cell came from. */
  | { kind: "industry"; primerId: string | null }
  /**
   * My IQ, unfocused.
   *
   * There is nothing to focus on: the analysis behind such a cell is named by
   * its graph hash, and the map re-derives that from the selection rather than
   * storing analyses. Sending the reader to the surface is as far as an honest
   * redirect can go.
   */
  | { kind: "connectome" };

/**
 * Route a cell by the surface that made it.
 *
 * `originRef` is lossy by design — a published identity hashes a memory set, so
 * the set cannot be recovered from the id — which is why it is carried on the
 * record and passed through here. A cell recorded before origin references
 * existed has none and opens its surface unfocused rather than refusing.
 */
export function routeForCell(
  origin: IqCellOrigin,
  originRef: readonly string[] = NO_REFS,
): IqCellRoute {
  switch (origin) {
    case "knowledge":
      return { kind: "knowledge", nodeId: originRef[0] ?? null };
    case "memory":
      return { kind: "memories", memoryIds: originRef.length === 0 ? NO_REFS : originRef };
    case "industry":
      return { kind: "industry", primerId: originRef[0] ?? null };
    case "connectome":
      return { kind: "connectome" };
    case "editor":
      return { kind: "editor" };
  }
}

/**
 * What a surface should land on when something else sent the user to it.
 *
 * One value rather than three sibling states, because it is one idea: the
 * sender and the receiver never share an ancestor below the shell, and holding
 * three parallel `*Focus` states meant three parallel setters, three props down
 * and three callbacks back up — six of `CanvasContent`'s seventeen props
 * existed only to connect two siblings.
 */
export interface SurfaceFocus {
  /** IQ Knowledge: the node to land on, or null for the whole index. */
  knowledgeNodeId: string | null;
  /** IQ Memories: the memories to select. */
  memoryIds: readonly string[];
  /** IQ Industry: the primer to open. */
  primerId: string | null;
}

export const NO_FOCUS: SurfaceFocus = {
  knowledgeNodeId: null,
  memoryIds: NO_REFS,
  primerId: null,
};

/**
 * Fold a route into the focus the surfaces read.
 *
 * Only the field the route names is replaced. The others are left alone because
 * the surfaces that read them may already be open on a canvas tab: clearing
 * IQ Knowledge's node because someone opened a memory cell would move a surface
 * nobody navigated to.
 */
export function focusFor(route: IqCellRoute, current: SurfaceFocus): SurfaceFocus {
  switch (route.kind) {
    case "knowledge":
      return { ...current, knowledgeNodeId: route.nodeId };
    case "memories":
      return { ...current, memoryIds: route.memoryIds };
    case "industry":
      return { ...current, primerId: route.primerId };
    case "editor":
    case "connectome":
      return current;
  }
}
