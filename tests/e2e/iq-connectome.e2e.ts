import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import { goTo, launchApp, type Harness } from "./launch.js";

/**
 * IQ Cell → My IQ.
 *
 * The map is analysis over a deterministic demo library, so a run is repeatable
 * and the assertions can name real values instead of shapes. Two things are
 * deliberately driven from the DOM rather than from the 3D canvas: selecting a
 * node, and opening its details. Clicking a sphere means hitting a raycast
 * target whose screen position depends on the GPU, the window size and the
 * reveal animation, which is a coin toss in an unattended run. The list and
 * the report pane reach the same state through the same handlers, so the
 * coverage is real and the flakiness is not. Picking on the map itself is in
 * the manual plan, where a human can see it.
 */

let harness: Harness;
let page: Page;

/**
 * Run the analysis and wait for a graph to exist.
 *
 * The hash is the honest signal: it is rendered only once a graph has been
 * built, so polling for it is polling for the thing the click was supposed to
 * produce rather than for an animation to settle.
 *
 * The button is found inside the surface's own header. It is labelled Analyse
 * rather than My IQ because those words also name the rail destination and the
 * canvas tab, and an unscoped match on them resolves to three.
 */
async function analyse(): Promise<void> {
  await page
    .locator(".connectome .flow-head")
    .getByRole("button", { name: "Analyse", exact: true })
    .click();
  await expect
    .poll(() => page.locator(".connectome .flow-hash").count(), { timeout: 60_000 })
    .toBe(1);
}

/** The map / table switch, scoped to the view it belongs to. */
const viewTab = (name: string): ReturnType<Page["getByRole"]> =>
  page.locator(".connectome .map-tabs").getByRole("button", { name, exact: true });

async function openCellList(): Promise<void> {
  if ((await page.locator(".connectome-list").count()) > 0) return;
  await page.locator(".connectome .flow-head").getByRole("button", { name: "Show IQ Cells" }).click();
  await page.locator(".connectome-list").waitFor({ state: "visible" });
}

beforeAll(async () => {
  harness = await launchApp();
  page = harness.page;
  await page.locator(".rail").waitFor({ state: "visible" });
  await goTo(page, "IQ Cell", "My IQ");
  await page.locator(".connectome").waitFor({ state: "visible" });
});

afterAll(async () => {
  await harness?.close();
});

describe("My IQ — naming and demo data", () => {
  it("titles itself My IQ", async () => {
    await expect.poll(() => page.locator(".connectome .flow-title").innerText()).toContain(
      "My IQ",
    );
  });

  it("carries the product line beside the name", async () => {
    await expect
      .poll(() => page.locator(".connectome .flow-tagline").innerText())
      .toContain("Your knowledge, intelligence, and workflows");
  });

  it("labels the map for assistive technology under the new name", async () => {
    expect(await page.getByLabel("My IQ map").count()).toBe(1);
  });

  it("keeps the IQ Cell selection closed when opening the map", async () => {
    expect(await page.locator(".connectome-list").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Show IQ Cells" }).count()).toBe(1);
  });

  it("lists plain-language IQ Cells from several connected work areas", async () => {
    await openCellList();
    const list = await page.locator(".connectome-list").innerText();
    // Names are dealt round-robin from five work areas. A reader should be
    // able to understand each one without specialist domain knowledge.
    expect(list).toMatch(/weekly project update|project dates at risk|readiness summary/i);
    expect(list).toMatch(/customer requests|customer feedback|support summary/i);
    expect(list).toMatch(/shared queue|overdue requests|cost changes/i);
    expect(list).toMatch(/failed checks|quality check-in|main issue/i);
    expect(list).toMatch(/customer update|public feedback|decision brief/i);
  });

  it("includes the industry primers, which are not sample data", async () => {
    // They ship with the app rather than being generated, so they belong on the
    // map whether or not the worked examples are wanted — and a map missing the
    // domain briefs the rest of the work is grounded on is missing the layer
    // underneath everything else.
    await openCellList();
    const list = await page.locator(".connectome-list").innerText();
    expect(list).toMatch(/Brief me on Software Industry/i);
    expect(list).toMatch(/Brief me on IT Consulting Industry/i);
  });

  it("declares a deterministic graph hash once analysed", async () => {
    await analyse();
    const hash = await page.locator(".connectome .flow-hash").innerText();
    expect(hash.trim().length).toBeGreaterThan(0);
  });
});

describe("My IQ — the two views", () => {
  it("switches to the table and shows connections as rows", async () => {
    await viewTab("Table").click();
    await expect.poll(() => page.locator(".connectome-map table tbody tr").count()).toBeGreaterThan(
      0,
    );
  });

  it("returns to the map without losing the analysis", async () => {
    await viewTab("Map").click();
    await expect.poll(() => page.getByLabel("My IQ map").isVisible()).toBe(true);
    expect((await page.locator(".connectome .flow-hash").innerText()).trim().length).toBeGreaterThan(
      0,
    );
  });

  /**
   * The map was the one surface that produced something and had nowhere to put
   * it. Every other surface publishes into the library, and the library is
   * where "what have I made?" is answered — a surface missing from that list is
   * work that has to be remembered rather than found.
   */
  it("opens with the report column closed, so the map gets the pane", async () => {
    expect(await page.locator(".connectome-report").count()).toBe(0);
    expect(await page.locator(".connectome-map canvas").count()).toBe(1);
  });
});

describe("My IQ — the node details dialog", () => {
  /**
   * The reason this dialog exists: a node on either picture is a shape with no
   * readable identity. These assertions are therefore about legibility — the
   * dialog must actually name the thing and say what it does, not merely open.
   *
   * Driven from the IQ Cell list rather than from a picture. Both visual
   * surfaces are canvases now, so picking a node means hitting a target whose
   * position depends on a force layout that has not finished settling — a coin
   * toss in an unattended run. The list is where a reader looks something up by
   * name, and it reaches the same handlers.
   */

  /** Select the first IQ Cell by name, which is what the list is for. */
  async function selectFirstCell(): Promise<void> {
    await openCellList();
    await page.locator(".connectome-list li .name").first().click();
  }

  /**
   * The report column is closed when the surface opens — the map is the
   * elastic column and 340px of prose beside it is 340px the picture does not
   * get. The Details button lives in that column, so a spec that goes looking
   * for it has to open the column first, exactly as a reader would.
   */
  async function openReport(): Promise<void> {
    if ((await page.locator(".connectome-report").count()) > 0) return;
    await page.locator(".flow-head").getByRole("button", { name: "Report" }).click();
    await page.locator(".connectome-report").waitFor({ state: "visible" });
  }

  it("opens from the report pane's Details button", async () => {
    await openReport();
    await selectFirstCell();
    await page.getByRole("button", { name: "Details" }).click();

    const dialog = page.locator(".node-dialog");
    await dialog.waitFor({ state: "visible" });
    expect(await dialog.getAttribute("aria-modal")).toBe("true");
    expect(await dialog.getAttribute("aria-label")).toMatch(/IQ Cell details$/);
  });

  it("states the facts a sphere cannot show", async () => {
    const facts = await page.locator(".node-dialog .node-facts").innerText();
    for (const label of ["Runs", "Completed", "Tokens per run", "Last run", "Approver", "Version"]) {
      expect(facts).toContain(label);
    }
  });

  it("states the reach, the writes and the configuration", async () => {
    const body = await page.locator(".node-dialog").innerText();
    // Matched case-insensitively: these headings are `text-transform:
    // uppercase`, and `innerText` returns what was rendered. The casing is the
    // stylesheet's to choose, so a spec that pinned it would break on a
    // purely visual change.
    for (const heading of ["Reach", "Writes", "Reads", "Project paths", "Hosts", "Configuration"]) {
      expect(body).toMatch(new RegExp(heading, "i"));
    }
  });

  it("lists the strongest connections with the reason attached", async () => {
    const body = await page.locator(".node-dialog").innerText();
    expect(body).toMatch(/strongest connections/i);
    // Every listed connection says whether it was declared or inferred, so an
    // inferred edge is never read as a fact.
    const links = page.locator(".node-dialog .node-link");
    if ((await links.count()) > 0) {
      expect(await links.first().innerText()).toMatch(/declared|inferred/i);
    }
  });

  it("closes on Escape", async () => {
    await page.keyboard.press("Escape");
    await expect.poll(() => page.locator(".node-dialog").count()).toBe(0);
  });

  it("opens again after being closed", async () => {
    await selectFirstCell();
    await page.getByRole("button", { name: "Details" }).click();
    await page.locator(".node-dialog").waitFor({ state: "visible" });
    await page.locator(".node-dialog").getByLabel("Close details").click();
    await expect.poll(() => page.locator(".node-dialog").count()).toBe(0);

    // The node stays selected after the dialog closes, so the report card is
    // showing and its Details button is the way back in.
    await page.getByRole("button", { name: "Details" }).click();
    await page.locator(".node-dialog").waitFor({ state: "visible" });
    expect(await page.locator(".node-dialog").count()).toBe(1);
  });

  it("closes when the scrim is clicked", async () => {
    await page.locator(".node-dialog-scrim").click({ position: { x: 8, y: 8 } });
    await expect.poll(() => page.locator(".node-dialog").count()).toBe(0);
  });
});

describe("My IQ — the time lapse", () => {
  /**
   * The map used to animate by flying the camera between stops, which shows
   * where things are and never shows anything happening. The reveal is a clock
   * now: every tract and cell carries the point in the window at which it was
   * last carrying work, and playing it assembles the picture in that order.
   */
  it("offers a transport with a scrubber over the window", async () => {
    await viewTab("Map").click();
    const bar = page.locator(".tour-bar.timelapse");
    await bar.waitFor({ state: "visible" });
    expect(await bar.getByRole("button", { name: "Play the time lapse" }).count()).toBe(1);
    expect(await page.getByLabel("Time lapse position").count()).toBe(1);
  });

  it("begins the time lapse when My IQ is pressed", async () => {
    // The analysis button starts the visual from the far end of the window.
    // A non-current day proves the first rendered map frame is participating
    // in the time lapse rather than jumping straight to a static picture.
    await expect
      .poll(() => page.locator(".tour-bar.timelapse .tour-count").innerText())
      .toMatch(/−\d+d/);
  });

  it("scrubbing back holds work that had not happened yet", async () => {
    const scrub = page.getByLabel("Time lapse position");
    await scrub.fill("0");

    const copy = page.locator(".tour-bar.timelapse .tour-copy");
    // The counts are the claim the picture is making at that moment, and they
    // have to be smaller than the totals or the clock is doing nothing.
    const text = await copy.innerText();
    const [shown, total] = /(\d+) of (\d+) IQ Cells/.exec(text)?.slice(1) ?? [];
    expect(Number(total)).toBeGreaterThan(0);
    expect(Number(shown)).toBeLessThan(Number(total));
  });

  it("plays forward to today", async () => {
    // Scoped to the transport: the header carries a control with the same
    // words on it, so an unscoped match resolves to two.
    await page
      .locator(".tour-bar.timelapse")
      .getByRole("button", { name: "Play the time lapse", exact: true })
      .click();
    await expect
      .poll(() => page.locator(".tour-bar.timelapse .tour-count").innerText(), { timeout: 30_000 })
      .toBe("now");
  });
});

describe("My IQ — returning to the opening view", () => {
  /**
   * The time lapse and a drag both move the view and neither can be undone by
   * hand: dragging the map rotates it rather than panning it, so there is no
   * "back" a reader can steer to. The reset control is the only way home.
   */
  it("offers the control beside the transport", async () => {
    await viewTab("Map").click();
    const reset = page.getByRole("button", { name: "Back to the opening view" });
    await reset.waitFor({ state: "visible" });
    // It belongs on the bar that moved the view, not in a menu elsewhere.
    expect(await page.locator(".tour-bar", { has: reset }).count()).toBe(1);
  });

  it("returns the clock to today and drops the selection", async () => {
    const count = page.locator(".tour-bar.timelapse .tour-count");
    await page.getByLabel("Time lapse position").fill("200");
    await expect.poll(async () => (await count.innerText()).trim()).not.toBe("now");

    await page.getByRole("button", { name: "Back to the opening view" }).click();
    await expect.poll(async () => (await count.innerText()).trim()).toBe("now");
    await expect.poll(() => page.locator(".node-dialog").count()).toBe(0);
  });
});

describe("My IQ — pane sizing", () => {
  /**
   * The drag goes left, which shrinks the list.
   *
   * Growing it is not assertable at the window size these specs run at: the
   * list starts at its initial 320px and the container clamps it to whatever
   * is left after the report column and the map's own 360px floor — which at
   * 1280px is *below* 320. Dragging right therefore legitimately moves the
   * width down to the ceiling, and a spec expecting growth was asserting that
   * the window was wider than it is. Shrinking exercises the same property
   * — space moves between the columns and neither collapses — at any size.
   */
  it("moves space between the list and the map without collapsing either", async () => {
    await openCellList();
    const list = page.locator(".connectome-list");
    const before = (await list.boundingBox())?.width ?? 0;
    expect(before).toBeGreaterThan(0);

    const divider = page.getByRole("separator", { name: "Resize IQ Cell list" });
    const box = await divider.boundingBox();
    if (box === null) throw new Error("The list divider was not rendered.");

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();

    const after = (await list.boundingBox())?.width ?? 0;
    expect(after).toBeLessThan(before);
    // Never past its own floor, whatever the pointer did.
    expect(after).toBeGreaterThanOrEqual(220);
    // The map is the elastic column; it takes the space but never disappears.
    expect((await page.locator(".connectome-map").boundingBox())?.width ?? 0).toBeGreaterThan(0);
  });
});

/**
 * Asking the map questions.
 *
 * The chat answers from the analysis and never from a model. That buys
 * reproducibility and costs a finite vocabulary, so the surface has to hand the
 * reader the questions it can take — which is also what lets a demo run without
 * anybody typing. These specs hold that path open end to end.
 */
describe("My IQ — asking the map", () => {
  const chat = (): ReturnType<Page["locator"]> => page.locator(".connectome-chat");

  beforeAll(async () => {
    await goTo(page, "IQ Cell", "My IQ");
    if ((await page.locator(".connectome .flow-hash").count()) === 0) await analyse();
    await page
      .locator(".connectome .flow-head")
      .getByRole("button", { name: "Ask about the map", exact: true })
      .click();
    await chat().waitFor({ state: "visible" });
  }, 120_000);

  /**
   * Three, then the rest on request. Printing every question it can take turns
   * the offer into a wall of sentences that competes with the answer above it.
   */
  it("offers three questions to start with and folds the rest behind a click", async () => {
    const opening = chat().locator(".chat-suggestions");
    const asked = opening.locator(".chip:not(.chip-more)");
    await expect.poll(() => asked.count()).toBe(3);

    await opening.locator(".chip-more").click();
    await expect.poll(() => asked.count()).toBeGreaterThan(3);

    await opening.locator(".chip-more").click();
    await expect.poll(() => asked.count()).toBe(3);
  });

  it("says it answers from the analysis rather than from a model", async () => {
    await expect.poll(() => chat().locator(".chat-lens").innerText()).toMatch(/no model asked/i);
  });

  /**
   * A ranked answer is a column of figures. Prose would make the reader parse
   * it; rows let them scan it and click the one they stopped on.
   */
  it("answers a suggested question with rows, not a paragraph", async () => {
    await chat().locator(".chat-suggestions .chip").first().click();
    await expect.poll(() => chat().locator(".msg.from-agent").count()).toBe(1);
    await expect.poll(() => chat().locator(".chat-headline").count()).toBe(1);
    await expect.poll(() => chat().locator(".chat-row").count()).toBeGreaterThan(0);
  });

  /**
   * Three rows, then the rest on request.
   *
   * A finding's row wraps to about five lines in a column this narrow, so ten
   * of them is a page — and a page is not an answer. The count on the fold
   * matters as much as the fold: hiding rows without saying how many are left
   * would hide the scale of what was found.
   */
  it("shows three rows and folds the rest behind a click that says how many", async () => {
    const rows = chat().locator(".msg.from-agent").first().locator(".chat-row");
    await expect.poll(() => rows.count()).toBeLessThanOrEqual(3);

    const more = chat().locator(".msg.from-agent").first().locator(".chat-more");
    await expect.poll(() => more.count()).toBe(1);
    await expect.poll(() => more.innerText()).toMatch(/^Show \d+ more$/);

    await more.click();
    await expect.poll(() => rows.count()).toBeGreaterThan(3);
    await expect.poll(() => more.innerText()).toBe("Show fewer");

    await more.click();
    await expect.poll(() => rows.count()).toBe(3);
  });

  /** Every answer hands over the next question, or the exchange dead-ends. */
  it("offers what to ask next, and answering it again offers more", async () => {
    await expect
      .poll(() => chat().locator(".chat-next .chip:not(.chip-more)").count())
      .toBeGreaterThan(0);
    await chat().locator(".chat-next .chip").first().click();
    await expect.poll(() => chat().locator(".msg.from-agent").count()).toBe(2);
    await expect
      .poll(() =>
        chat().locator(".msg.from-agent").nth(1).locator(".chat-next .chip:not(.chip-more)").count(),
      )
      .toBeGreaterThan(0);
  });

  /**
   * Outside its vocabulary it says so. An invented answer about someone's own
   * automations is worse than no answer, and this is the surface that must not
   * bluff — everything else on it is reproducible.
   */
  it("refuses a question it cannot answer from the graph", async () => {
    const box = chat().locator(".mini-composer input");
    await box.fill("Should we hire another engineer next quarter?");
    await box.press("Enter");
    await expect
      .poll(() => chat().locator(".msg.from-agent").last().locator(".chat-headline").innerText())
      .toMatch(/only read this analysis/i);
  });
});

/**
 * Publishing My IQ over MCP.
 *
 * The Connectome used to file its analysis in the IQ Cell library as well. That
 * went with the generated drafts: a drawing is something a person makes, and a
 * surface minting one behind their back put cards in the library nobody drew.
 * What is left is the thing the button always did that mattered — it makes My
 * IQ readable from another app.
 *
 * Last in the file, because publishing raises a dialog over the surface and
 * every spec above reads the surface underneath it.
 */
describe("My IQ — publishing over MCP", () => {
  it("publishes the library and the analysis, and says what went out", async () => {
    await goTo(page, "IQ Cell", "My IQ");
    if ((await page.locator(".connectome .flow-hash").count()) === 0) await analyse();
    await page.locator(".flow-head .flow-hash").waitFor({ state: "visible", timeout: 60_000 });

    // Publishing asks for a name first, so it is two clicks: the header button
    // raises the dialog and the dialog does the work.
    await page.locator(".flow-head").getByRole("button", { name: /^Publish$/ }).click();
    const dialog = page.locator(".modal-card");
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    await dialog.locator("input[type='text'], .field input").first().fill("My IQ");
    await dialog.getByRole("button", { name: "Publish", exact: true }).click();
    // The receipt names both halves of what went out: the cells and the
    // analysis over them.
    await expect
      .poll(() => page.locator(".connectome-notice").innerText(), { timeout: 20_000 })
      .toMatch(/My IQ is published: \d+ IQ Cells and the analysis of \d+\./);

    // Publishing puts nothing in the IQ Cell library. Nothing here draws.
    await expect.poll(() => page.locator(".connectome-notice").innerText()).not.toMatch(/library/i);
  }, 120_000);
});


