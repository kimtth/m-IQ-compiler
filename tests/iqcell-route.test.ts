import { describe, expect, it } from "vitest";
import { focusFor, NO_FOCUS, routeForCell, type SurfaceFocus } from "../apps/renderer/src/flow/route.js";

/**
 * Where an IQ Cell opens.
 *
 * "An IQ Cell opens where it was compiled" is the product's rule, and it used
 * to be written twice — once in `flow/Library.tsx` and once in
 * `connectome/Connectome.tsx` — at different fidelity. The library passed the
 * cell's `originRef` through so a memory cell landed on its own memories; the
 * Connectome dropped it, and had no `connectome` arm at all, so a cell compiled
 * from an analysis fell through to the canvas. Neither switch could be reached
 * from a test, because both lived inside a component that drags in `window` and
 * three.js.
 *
 * `tests/compiled-identity.test.ts` already pins the *inverse* of this — that a
 * knowledge cell's id can be turned back into the node it came from. This pins
 * the forward direction, which is what a user actually presses.
 */

describe("IQ Cell routing", () => {
  it("sends each origin to the surface that compiled it", () => {
    expect(routeForCell("editor")).toEqual({ kind: "editor" });
    expect(routeForCell("knowledge", ["node_7"])).toEqual({ kind: "knowledge", nodeId: "node_7" });
    expect(routeForCell("memory", ["mem_1", "mem_2"])).toEqual({
      kind: "memories",
      memoryIds: ["mem_1", "mem_2"],
    });
    expect(routeForCell("industry", ["semiconductors"])).toEqual({
      kind: "industry",
      primerId: "semiconductors",
    });
    expect(routeForCell("connectome", ["a1b2c3"])).toEqual({ kind: "connectome" });
  });

  /**
   * A cell recorded before origin references existed has none. It opens its
   * surface unfocused rather than refusing — the record is still true about
   * where it was made.
   */
  it("opens unfocused when the cell names no source", () => {
    expect(routeForCell("knowledge")).toEqual({ kind: "knowledge", nodeId: null });
    expect(routeForCell("industry", [])).toEqual({ kind: "industry", primerId: null });
    expect(routeForCell("memory", [])).toEqual({ kind: "memories", memoryIds: [] });
  });

  /**
   * The empty reference is one shared array.
   *
   * The receiving surfaces key an effect on the value they are handed, so a
   * fresh `[]` per route would re-run `MemoriesCenter`'s selection effect for a
   * route that selected nothing.
   */
  it("reuses one empty reference, so an unfocused route is not a change", () => {
    const first = routeForCell("memory", []);
    const second = routeForCell("memory", []);
    expect(first).toEqual({ kind: "memories", memoryIds: [] });
    expect(second).toEqual({ kind: "memories", memoryIds: [] });
    if (first.kind !== "memories" || second.kind !== "memories") throw new Error("wrong kind");
    expect(first.memoryIds).toBe(second.memoryIds);
    expect(first.memoryIds).toBe(NO_FOCUS.memoryIds);
  });

  /**
   * The two surfaces cannot disagree any more: the same origin and reference
   * produce the same route whoever asked.
   */
  it("answers the same for the library and the Connectome", () => {
    const fromLibrary = routeForCell("industry", ["aviation"]);
    const fromConnectome = routeForCell("industry", ["aviation"]);
    expect(fromLibrary).toEqual(fromConnectome);
  });
});

describe("surface focus", () => {
  const busy: SurfaceFocus = {
    knowledgeNodeId: "node_7",
    memoryIds: ["mem_1"],
    primerId: "aviation",
  };

  it("replaces only the field the route names", () => {
    expect(focusFor(routeForCell("knowledge", ["node_9"]), busy)).toEqual({
      knowledgeNodeId: "node_9",
      memoryIds: ["mem_1"],
      primerId: "aviation",
    });
    expect(focusFor(routeForCell("memory", ["mem_2"]), busy)).toEqual({
      knowledgeNodeId: "node_7",
      memoryIds: ["mem_2"],
      primerId: "aviation",
    });
  });

  /**
   * A surface that already has a canvas tab is not remounted, so clearing a
   * focus nobody asked about would move a surface nobody navigated to.
   */
  it("leaves the other surfaces where they were", () => {
    expect(focusFor(routeForCell("editor"), busy)).toBe(busy);
    expect(focusFor(routeForCell("connectome"), busy)).toBe(busy);
  });

  it("clears a stale selection when the new route selects nothing", () => {
    const next = focusFor(routeForCell("memory", []), busy);
    expect(next.memoryIds).toEqual([]);
    // …and the other two are untouched, so only IQ Memories moves.
    expect(next.knowledgeNodeId).toBe("node_7");
    expect(next.primerId).toBe("aviation");
  });

  it("starts focused on nothing", () => {
    expect(NO_FOCUS).toEqual({ knowledgeNodeId: null, memoryIds: [], primerId: null });
  });
});
