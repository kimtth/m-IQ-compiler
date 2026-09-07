import { describe, expect, it } from "vitest";
import {
  AppSurface,
  CONVERSATION_DESTINATIONS,
  SURFACES,
  canHoldConversation,
  modeForSurface,
  panesHiddenBy,
  railSurfacesFor,
} from "@iq/shared";

/**
 * One surface, one description.
 *
 * A surface used to be described in seven declarations across two files in two
 * processes: the enum, `modeForSurface`, `SURFACES_WITHOUT_A_THREAD`, the
 * renderer's `SURFACES` table of labels, one of three per-mode arrays,
 * `SURFACE_HIDES_PANES`, and an arm of a switch. Two of those answered the same
 * question — which mode owns this surface — and the renderer's copy was the one
 * the rail actually rendered, so `@iq/shared`'s answer could be wrong without
 * anything noticing. Two more were documented as mirrors of each other.
 *
 * The rail now derives from `SURFACES`, so the disagreement is not expressible.
 * What is left to pin is that the derivations really do cover every surface and
 * really do agree with the rule the privileged side refuses writes on.
 */

describe("surface registry", () => {
  it("describes every surface in the enum, and nothing else", () => {
    expect(Object.keys(SURFACES).sort()).toEqual([...AppSurface.options].sort());
  });

  it("gives each surface a label and a detail", () => {
    for (const surface of AppSurface.options) {
      expect(SURFACES[surface].label.length, surface).toBeGreaterThan(0);
      expect(SURFACES[surface].detail.length, surface).toBeGreaterThan(0);
    }
  });

  /**
   * Chat is one pane with no canvas, so no surface may claim it: a surface
   * asked for from Chat has to move the mode to somewhere a canvas exists.
   */
  it("never puts a canvas surface in the mode that has no canvas", () => {
    for (const surface of AppSurface.options) {
      expect(modeForSurface(surface), surface).not.toBe("chat");
    }
  });

  /**
   * The rail and `modeForSurface` are now the same fact. This asserts the
   * current arrangement so a move between modes is a deliberate edit rather
   * than a silent one.
   */
  it("offers each mode the surfaces it owns", () => {
    expect(railSurfacesFor("flow")).toEqual(["knowledge"]);
    expect(railSurfacesFor("cocreate")).toEqual(["browser", "meetings"]);
    expect(railSurfacesFor("control")).toEqual(["skills", "mcp"]);
    expect(railSurfacesFor("chat")).toEqual([]);
  });

  /** Projects and Connections & access are reached from the bottom group. */
  it("leaves the two frame surfaces out of every mode's rail", () => {
    const railed = new Set(
      (["chat", "cocreate", "flow", "control"] as const).flatMap((mode) => railSurfacesFor(mode)),
    );
    const unrailed = AppSurface.options.filter((surface) => !railed.has(surface));
    expect(unrailed).toEqual(["projects", "connections"]);
  });

  /**
   * The rule that used to be a hand-kept mirror: a surface that suppresses the
   * chat pane cannot hold a conversation, because its history would be off
   * screen. Both halves read the same field now, so this proves the derivation
   * rather than two lists agreeing by luck.
   */
  it("refuses to file a conversation on a surface that hides the thread", () => {
    for (const surface of AppSurface.options) {
      const hidesThread = panesHiddenBy(surface).includes("chat");
      const allowed = canHoldConversation({ subMode: null, surface });
      if (hidesThread) expect(allowed, surface).toBe(false);
    }
    expect(panesHiddenBy("projects")).toEqual(["chat"]);
    expect(panesHiddenBy("connections")).toEqual(["chat", "navigator"]);
    expect(panesHiddenBy("browser")).toEqual([]);
  });

  /**
   * The offer and the rule are still two things — the list is what a user is
   * shown, `canHoldConversation` is what the privileged side refuses a write
   * on — so they are proved against each other rather than derived.
   */
  it("offers only destinations the shell can actually show", () => {
    for (const place of CONVERSATION_DESTINATIONS) {
      expect(canHoldConversation(place), JSON.stringify(place)).toBe(true);
    }
  });
});
