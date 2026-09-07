import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import { SAMPLE_DATA, goTo, launchApp, type Harness } from "./launch.js";

/**
 * IQ Cell → IQ Workflow.
 *
 * The whole surface is renderer-local — diagrams and published IQ Cells live in
 * `localStorage`, and export is a pure transform of the canvas — so every step
 * here is genuinely exercisable end to end without an identity. That makes it
 * the right place to prove the renames landed everywhere a user can see them,
 * and that the full draw → publish → export → re-import round trip works in the
 * shipped window.
 *
 * Nothing on this canvas executes. There is no compile, no dry run and no
 * contract; a diagram describes how work happens and the product's job is to
 * let it leave.
 */

let harness: Harness;
let page: Page;

beforeAll(async () => {
  harness = await launchApp();
  page = harness.page;
  await page.locator(".rail").waitFor({ state: "visible" });
  await goTo(page, "IQ Cell", "IQ Workflow");
  // Scoped to the surface's own body: `.flow` alone also matches the workbench,
  // which carries the active mode's name as a class.
  await page.locator(".flow-body").waitFor({ state: "visible" });
});

afterAll(async () => {
  await harness?.close();
});

describe("IQ Cell — the mode reads as IQ Cell everywhere", () => {
  it("names the mode IQ Cell in the rail", async () => {
    const rail = await page.locator(".mode-switch").innerText();
    expect(rail).toContain("IQ Cell");
    // Connectome IQ is a segment of its own, beside IQ Cell rather than inside
    // it: it is where compiled work is met, not a step in compiling it.
    expect(rail).toContain("Connectome IQ");
    // The old name must not survive anywhere in the switch.
    expect(rail).not.toMatch(/\bFlow\b/);
  });

  it("lists My IQ first, then the material it is compiled from", async () => {
    const group = await page.locator(".rail-group.nav").innerText();
    expect(group).toContain("IQ Workflow");
    expect(group).toContain("IQ Knowledge");
    expect(group).toContain("Memories");
    expect(group).toContain("IQ Cell library");
    expect(group).toContain("My IQ");
    // Every pre-rename label must be gone: "Connectome" on its own, the
    // "IQ Connectome" that replaced it, and the "My IQ (Connectome)" after
    // that. The hub carries the only surviving use of the word and it is a
    // mode of its own, so the word belongs nowhere in this rail.
    expect(group).not.toContain("Connectome");
    // The rail must not say "Flow" anywhere either — the surface is IQ Workflow.
    expect(group).not.toMatch(/\bFlow\b/);
    // One rule, under My IQ, and it is the only one. What is below it is not a
    // named group — it is the material My IQ is built from — so it gets a line
    // and not a heading.
    expect(await page.locator(".rail-group.nav .rail-heading").count()).toBe(0);
    expect(await page.locator(".rail-group.nav .rail-rule").count()).toBe(1);
    const order = await page
      .locator(".rail-group.nav > *")
      .evaluateAll((nodes) => nodes.map((node) => node.className));
    expect(order[0]).toContain("rail-item");
    expect(order[1]).toContain("rail-rule");
    // It has no History control: IQ Cell carries no conversation.
    expect(
      await page.locator(".rail").getByRole("button", { name: "History", exact: true }).count(),
    ).toBe(0);
  });

  /**
   * MEASURED, because the text is present either way.
   *
   * A CSS ellipsis does not change what `innerText` returns, so a spec that
   * asserts the wording of a tagline passes just as happily when the user can
   * only read half of it.
   *
   * **The contract these two pin was deliberately reversed.** The rail is 248px
   * and taglines used to wrap, which made every row a different height and the
   * list hard to scan. It now clamps each detail to one ellipsised line and
   * moves the remainder to the row's tooltip — so the guarantee worth testing
   * is no longer "nothing is clipped" but "nothing clipped is *lost*".
   */
  it("clamps every rail tagline to a single line", async () => {
    const lineCounts = await page.locator(".rail-group.nav .rail-item .detail").evaluateAll(
      (nodes) =>
        nodes.map((node) => {
          const height = node.getBoundingClientRect().height;
          const lineHeight = Number.parseFloat(getComputedStyle(node).lineHeight);
          return Math.round(height / lineHeight);
        }),
    );

    expect(lineCounts.length).toBeGreaterThan(0);
    expect(lineCounts.every((lines) => lines === 1)).toBe(true);
  });

  it("keeps a clipped tagline readable on the row's tooltip", async () => {
    // My IQ carries the product line, which is the longest of
    // them and therefore the one that is certainly clipped.
    const row = page.locator(".rail-group.nav .rail-item", { hasText: "My IQ" });

    const detail = (await row.locator(".detail").textContent())?.trim() ?? "";
    const tooltip = (await row.getAttribute("title")) ?? "";

    expect(detail).not.toBe("");
    // The tooltip carries the label and the detail, so nothing the ellipsis
    // takes off the screen is unreachable.
    expect(tooltip).toContain(detail);
  });

  it("lands on Control Center when Control Center is asked for", async () => {
    // A sub-mode that moves modes used to leave a stale memory of where the
    // user was, and the switch followed it straight back out again.
    //
    // Control Center is a rail item rather than a mode segment now, so no
    // segment is selected while it is open — which is the point of moving it:
    // the segments name the three ways work is done, and this is not one.
    await page.locator(".rail").getByRole("button", { name: "Control Center", exact: true }).click();
    await expect
      .poll(() => page.locator('.mode-segment[aria-selected="true"]').count())
      .toBe(0);
    await page.getByRole("tab", { name: /^IQ Cell/ }).click();
    await expect
      .poll(() => page.locator('.mode-segment[aria-selected="true"]').innerText())
      .toContain("IQ Cell");
  });

  it("calls the canvas document a diagram", async () => {
    const name = page.getByLabel("Diagram name");
    await expect.poll(() => name.inputValue()).toBe("Untitled diagram");
    expect(await page.getByLabel("Open a sample diagram").count()).toBe(1);
  });
});

describe("IQ Cell — the palette offers a notation, not a runtime", () => {
  it("offers exactly the seven kinds, grouped in three", async () => {
    const kinds = await page
      .locator("[data-flow-palette]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-flow-palette")));
    expect(kinds.sort()).toEqual([
      "data",
      "decision",
      "end",
      "note",
      "start",
      "step",
      "subflow",
    ]);

    // The family headings are `text-transform: uppercase`, and `innerText`
    // returns the rendered text, so this matches the words rather than a
    // casing the stylesheet owns.
    const palette = await page.locator(".flow-palette").innerText();
    expect(palette).toMatch(/the process/i);
    expect(palette).toMatch(/what it handles/i);
    expect(palette).toMatch(/annotation/i);
  });

  /**
   * The retired runtime vocabulary, pinned by absence.
   *
   * These were nodes that ran: a schedule that fired, a model call, an HTTP
   * request. Nothing on this canvas executes, so a palette still offering them
   * would be promising something the product no longer does.
   */
  it("offers nothing that used to execute", async () => {
    const palette = await page.locator(".flow-palette").innerText();
    for (const gone of [
      "Schedule",
      "Model call",
      "HTTP request",
      "Browser fetch",
      "For each",
      "Council",
      "Agent task",
    ]) {
      expect(palette, `${gone} is still offered`).not.toContain(gone);
    }
  });
});

describe("IQ Cell — drawing a diagram", () => {
  it("opens a sample onto the canvas", async () => {
    // The canvas is empty on a fresh profile, so no replace confirmation is
    // raised and the selection applies directly.
    await page.getByLabel("Open a sample diagram").selectOption({ label: "Purchase request" });

    await expect.poll(() => page.locator("[data-flow-node]").count()).toBeGreaterThan(0);
    await page.locator('[data-flow-tab="outline"]').click();
    await expect
      .poll(() => page.locator('[data-flow-tab="outline"]').innerText())
      .toMatch(/Outline \(\d+\)/);
  });

  it("renames the diagram", async () => {
    const name = page.getByLabel("Diagram name");
    await name.fill("Warranty claim triage");
    await expect.poll(() => name.inputValue()).toBe("Warranty claim triage");
  });

  /**
   * Three words about the drawing, not about a build.
   *
   * The old pill said "compiled" and "dry run passed", which described a
   * machine having accepted something. Nothing is accepted here — the states
   * say whether a reader could follow the picture.
   */
  it("reports a state rather than leaving the header blank", async () => {
    // The pill is `text-transform: uppercase`, and `innerText` returns the
    // rendered text, so this matches case-insensitively rather than asserting
    // a casing the stylesheet owns.
    const state = await page.locator(".flow-state").innerText();
    expect(state).toMatch(/^(draft|complete|invalid)$/i);
    expect(state).not.toMatch(/compil|dry run|publish/i);
  });
});

/**
 * Drawing by hand.
 *
 * The palette's HTML5 drag carries `text/iq-node` on a `DataTransfer`, which
 * Playwright's mouse cannot produce — its drag helpers move a real pointer and
 * the browser only synthesises drag events for its own drag source. The palette
 * button therefore also places on click, and that is the path driven here.
 * Connecting is a real pointer drag on a React Flow handle, so that part is
 * driven exactly as a user would.
 */
describe("IQ Cell — connecting two nodes by hand", () => {
  const nodeAt = (kind: string) => page.locator(`[data-flow-node="${kind}"]`);

  it("starts a fresh canvas", async () => {
    page.once("dialog", (dialog) => void dialog.accept());
    await page.locator(".flow-head").getByRole("button", { name: /Clear/ }).click();
    await expect.poll(() => page.locator("[data-flow-node]").count()).toBe(0);
    await expect.poll(() => page.locator(".flow-empty").count()).toBe(1);
  });

  it("places a Start and a Step from the palette", async () => {
    // One at a time. Each placement is a React state update and the next spot
    // is computed from the node count, so clicking twice in the same frame is
    // not a gesture a person can make and not one worth pinning.
    await page.locator('[data-flow-palette="start"]').click();
    await expect.poll(() => nodeAt("start").count()).toBe(1);

    await page.locator('[data-flow-palette="step"]').click();
    await expect.poll(() => nodeAt("step").count()).toBe(1);

    // Placed, not run: the header still reports on the drawing.
    await expect.poll(() => page.locator(".flow-state").innerText()).toMatch(/draft|invalid/i);
  });

  /** The centre of a locator's box, which is what a pointer aims at. */
  const centreOf = async (what: ReturnType<typeof nodeAt>): Promise<[number, number]> => {
    const box = await what.boundingBox();
    if (box === null) throw new Error("nothing to aim at");
    return [box.x + box.width / 2, box.y + box.height / 2];
  };

  it("moves the Step clear of the Start", async () => {
    // Successive placements are offset by a few pixels, so a fresh Step lands
    // on top of the Start. Two overlapping nodes cannot be joined by pointer,
    // and nor could a person do it, so the first gesture is to separate them.
    const [x, y] = await centreOf(nodeAt("step"));
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 40, y + 220, { steps: 12 });
    await page.mouse.up();

    const [, moved] = await centreOf(nodeAt("step"));
    expect(moved).toBeGreaterThan(y + 100);
  });

  it("draws an arrow by dragging one node's handle onto the other", async () => {
    const before = await page.locator(".iq-edge").count();

    // The bottom handle of Start onto the top handle of Step. The handles are
    // transparent until the node is hovered, which is a paint concern rather
    // than a hit-testing one, so this aims at the box rather than waiting for a
    // visibility the design does not intend. The release lands on a handle and
    // not the node's middle: React Flow only joins what is within its
    // connection radius, and the middle of a node is further than that from any
    // of its four handles. React Flow tracks the line on pointer moves, so the
    // drag is stepped rather than teleported.
    const [fromX, fromY] = await centreOf(nodeAt("start").locator(".iq-handle").nth(2));
    const [toX, toY] = await centreOf(nodeAt("step").locator(".iq-handle").nth(0));
    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(toX, toY, { steps: 12 });
    await page.mouse.up();

    await expect.poll(() => page.locator(".iq-edge").count()).toBe(before + 1);
  });

  it("takes a label typed onto the arrow", async () => {
    // Drawing an arrow selects it, so the inspector is already offering its
    // label. That is the point of the notation: a decision's answers are
    // written on the arrows leaving it.
    const field = page.getByLabel("Arrow label");
    await field.waitFor({ state: "visible" });
    await field.fill("Approved");
    await field.blur();

    await expect
      .poll(() => page.locator("[data-flow-edge-label]").first().getAttribute("data-flow-edge-label"))
      .toBe("Approved");
  });

  it("carries the label into the exported Mermaid", async () => {
    await page.locator('[data-flow-tab="export"]').click();
    const mermaid = await page.locator("[data-flow-mermaid]").innerText();
    expect(mermaid.startsWith("flowchart TD")).toBe(true);
    expect(mermaid).toContain("|Approved|");
    // Stadium for the start, box for the step — the shapes are the vocabulary.
    expect(mermaid).toContain("([");
    expect(mermaid).toMatch(/n\d\["/);
  });
});

describe("IQ Cell — publishing", () => {
  it("records the diagram in the IQ Cell library", async () => {
    await page.getByLabel("Diagram name").fill("Hand-drawn approval");
    await page.locator(".flow-head").getByRole("button", { name: /^Publish/ }).click();

    await expect
      .poll(() => page.locator(".flow-notice").innerText())
      .toContain("in the IQ Cell library");

    // The inspector shows the library only when no node is selected, so the
    // library assertion has to be made from the same state a user would see it
    // in rather than from whatever the last click left focused.
    await page.locator(".flow-canvas").click({ position: { x: 12, y: 12 } });
    await expect
      .poll(() => page.locator(".flow-inspector").innerText())
      .toContain("Hand-drawn approval");
  });
});

describe("IQ Cell — round-tripping a bundle", () => {
  /**
   * Import is the one path that reads a file a person supplied, so it is worth
   * driving with the real bundles from `sample-data/` rather than with something
   * the test invented. Export is deliberately not clicked: it goes through the
   * browser's download machinery, which in Electron raises a save dialog and
   * would hang an unattended run. The manual plan covers it.
   */
  const samples: readonly [file: string, name: string, nodes: number][] = [
    ["incident-postmortem-decision-pack.iqcell.json", "Incident postmortem decision pack", 11],
    ["dependency-upgrade-chase.iqcell.json", "Dependency upgrade chase", 9],
    ["security-advisory-watch.iqcell.json", "Security advisory watch", 9],
  ];

  for (const [file, name, nodes] of samples) {
    it(`imports ${file} and draws it`, async () => {
      await page
        .locator('input[type="file"]')
        .setInputFiles(path.join(SAMPLE_DATA, "iq-cells", file));

      await expect
        .poll(() => page.getByLabel("Diagram name").inputValue(), { timeout: 20_000 })
        .toBe(name);
      await expect.poll(() => page.locator("[data-flow-node]").count()).toBe(nodes);
    });
  }

  it("draws the imported diagram in the current vocabulary", async () => {
    const kinds = await page
      .locator("[data-flow-node]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-flow-node")));
    const allowed = ["start", "end", "step", "decision", "subflow", "data", "note"];
    expect(kinds.every((kind) => kind !== null && allowed.includes(kind))).toBe(true);
    // A retired kind draws inside a dotted warning wrapper, so its absence is
    // visible rather than inferred.
    expect(await page.locator(".iq-retired-wrap").count()).toBe(0);
  });

  it("exports the imported diagram as Mermaid", async () => {
    await page.locator('[data-flow-tab="export"]').click();
    const mermaid = await page.locator("[data-flow-mermaid]").innerText();
    expect(mermaid.startsWith("flowchart TD")).toBe(true);
    // No subgraphs, no styling: the export has to be readable by the parser
    // IQ Industry uses.
    expect(mermaid).not.toMatch(/\b(subgraph|classDef|linkStyle|style)\b/);
  });
});
