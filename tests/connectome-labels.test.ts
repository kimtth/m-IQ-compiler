import { describe, expect, it } from "vitest";
import { shortLabel, shortLabelsFor } from "../apps/renderer/src/connectome/labels.js";

/**
 * The map names its nodes so an answer in the chat can be found on the
 * picture. Two things have to hold for that to work: the label has to be short
 * enough to fit next to a dot, and no two cells may end up with the same one —
 * a reader who sees "Standards notes" twice has learnt nothing.
 */
describe("map labels", () => {
  it("drops the opening words every IQ Cell name shares", () => {
    expect(shortLabel("Ask the standards notes")).toBe("Standards notes");
    expect(shortLabel("Brief me on the supplier notes")).toBe("Supplier notes");
  });

  it("reads from after the colon", () => {
    expect(shortLabel("Apply: how we name engineering changes")).toBe("Name engineering…");
  });

  it("cuts on a word boundary and marks the cut", () => {
    const label = shortLabel("Ask the plant and process and tooling notes");
    expect(label.length).toBeLessThanOrEqual(21);
    expect(label.endsWith("…")).toBe(true);
    expect(label.startsWith("Plant and process")).toBe(true);
  });

  it("does not stop on a word that says nothing", () => {
    // "Flag VINs with the…" spends four characters on "the" and stops mid
    // phrase; the reader learns no more than from "Flag VINs…".
    expect(shortLabel("Flag VINs with the same fault after a software update")).toBe("Flag VINs…");
  });

  it("keeps two words even when they are all stock openers", () => {
    expect(shortLabel("Apply the")).toBe("Apply the");
  });

  it("falls back to the full name when there is nothing to trim", () => {
    expect(shortLabel("Torque")).toBe("Torque");
  });

  it("separates two cells that would shorten to the same label", () => {
    const labels = shortLabelsFor([
      { id: "a", name: "Ask the plant and process and tooling notes" },
      { id: "b", name: "Ask the plant and process and safety notes" },
      { id: "c", name: "Brief me on the supplier notes" },
    ]);
    expect(labels.get("a")).not.toBe(labels.get("b"));
    // Untouched: only the colliding pair pays the longer budget.
    expect(labels.get("c")).toBe("Supplier notes");
  });

  it("gives every node a label", () => {
    const nodes = [
      { id: "a", name: "Ask the standards notes" },
      { id: "b", name: "Apply 3 conventions" },
      { id: "c", name: "" },
    ];
    const labels = shortLabelsFor(nodes);
    expect(labels.size).toBe(3);
    for (const node of nodes.slice(0, 2)) expect(labels.get(node.id)).not.toBe("");
  });
});
