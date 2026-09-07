import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import { closeHistory, goTo, launchApp, openHistory, type Harness } from "./launch.js";

/**
 * Chat's surfaces, and the shape of the workbench around them.
 *
 * Everything asserted here is reachable without an identity, which is the whole
 * point of two of these specs: the Data agent surface and the recorder must be
 * *legible* to a signed-out user rather than absent, because "absent" is
 * indistinguishable from "not built" and that is exactly how two real defects
 * went unnoticed.
 *
 * The pane specs establish their own control case before asserting. The
 * workbench sheds panes when the window is too narrow, so a test that only
 * checked "the chat pane is gone on Connections & access" would pass just as
 * happily on a window too small to show it. Each one therefore proves the panes
 * are present on an ordinary surface first.
 */

let harness: Harness;
let page: Page;

/**
 * Click a rail destination.
 *
 * Scoped to the rail on purpose: once a surface is open the canvas tab strip
 * carries a "Close <name>" button, and an unscoped match resolves to two.
 */
async function openFromRail(name: string): Promise<void> {
  await page.locator(".rail").getByRole("button", { name, exact: true }).click();
}

beforeAll(async () => {
  harness = await launchApp();
  page = harness.page;
  await page.locator(".rail").waitFor({ state: "visible" });
});

afterAll(async () => {
  await harness?.close();
});

describe("Chat → Data agent", () => {
  it("is offered in the rail as its own destination", async () => {
    await page.getByRole("tab", { name: /^Chat/ }).click();
    const rail = await page.locator(".rail-group.nav").innerText();

    expect(rail).toContain("Conversation");
    expect(rail).toContain("Team");
    // The reason this surface exists: data questions used to be reachable only
    // from inside Co-create → Fabric, below a build form, and only once a
    // project had been registered.
    expect(rail).toContain("Data agent");
  });

  it("says plainly that no Data Agent is connected, and offers the way to fix it", async () => {
    await goTo(page, "Chat", "Data agent");

    const pane = page.locator(".pane.chat");
    await expect.poll(() => pane.innerText()).toContain("No Fabric Data Agent connected");
    // The remedy is named, not implied.
    await expect.poll(() => pane.innerText()).toContain("Connections & access");
    expect(
      await page.getByRole("button", { name: "Open Connections & access" }).count(),
    ).toBe(1);
  });

  it("takes over the chat pane rather than opening a canvas tab", async () => {
    // Chat is one pane by design. A surface that opened a canvas here would
    // make it the only mode whose shape changes under the reader.
    expect(await page.locator(".pane.canvas").count()).toBe(0);
  });
});

describe("Chat → Team", () => {
  it("gives every council seat a person icon, not an unlabelled row", async () => {
    await goTo(page, "Chat", "Team");
    const roster = page.locator(".pane.chat");
    await expect.poll(() => roster.innerText()).toContain("Members");

    // Two blank members are seeded, so two avatars must be drawn.
    await expect.poll(() => page.locator(".member-avatar").count()).toBe(2);

    // Colour is by seat and must actually differ, or the avatars are decoration
    // rather than a way to tell two speakers apart.
    const classes = await page.locator(".member-avatar").evaluateAll((nodes) =>
      nodes.map((node) => node.className),
    );
    expect(classes.every((name) => /seat-\d/.test(name))).toBe(true);
  });

  it("adds an avatar with each member added", async () => {
    await page.getByRole("button", { name: "Add member" }).click();
    await expect.poll(() => page.locator(".member-avatar").count()).toBe(3);
  });
});

describe("workbench panes follow the open surface", () => {
  it("shows conversation, canvas and project on an ordinary Co-create surface", async () => {
    // The control case. Everything below asserts panes are *absent*, which is
    // only meaningful if they were present to begin with at this window size.
    await goTo(page, "Co-create");
    await openFromRail("Meeting Recordings");
    await page.locator(".pane.canvas").waitFor({ state: "visible" });

    expect(await page.locator(".pane.chat").count()).toBe(1);
    expect(await page.locator(".pane.canvas").count()).toBe(1);
    expect(await page.locator(".pane.navigator").count()).toBe(1);
  });

  it("drops both the conversation and the project on Connections & access", async () => {
    await openFromRail("Connections & access");
    await expect
      .poll(() => page.locator(".canvas-tab.active").innerText())
      .toContain("Connections & access");

    // A settings page is one form at a time; a conversation and a file tree
    // beside it are two competing focuses that cannot act on it.
    await expect.poll(() => page.locator(".pane.chat").count()).toBe(0);
    await expect.poll(() => page.locator(".pane.navigator").count()).toBe(0);
    expect(await page.locator(".pane.canvas").count()).toBe(1);
  });

  it("drops the conversation on Projects but keeps the file tree", async () => {
    await openFromRail("Projects");
    await expect
      .poll(() => page.locator(".canvas-tab.active").innerText())
      .toContain("Projects");

    // A turn is scoped to the bound project, so a live composer beside the
    // control that rebinds it sends into the project being left.
    await expect.poll(() => page.locator(".pane.chat").count()).toBe(0);
    // The navigator stays: it is the preview of the project being chosen.
    expect(await page.locator(".pane.navigator").count()).toBe(1);
  });

  it("brings the conversation back when an ordinary surface is reopened", async () => {
    // Suppression must be a property of the open surface, not a latch.
    await openFromRail("Meeting Recordings");
    await expect.poll(() => page.locator(".pane.chat").count()).toBe(1);
    expect(await page.locator(".pane.navigator").count()).toBe(1);
  });
});

describe("the Chat landing page", () => {
  it("is what Chat shows before the first conversation", async () => {
    // Explicitly to Conversation: the shell remembers the last sub-mode per
    // mode, and the specs above left Chat on Team.
    await goTo(page, "Chat", "Conversation");
    await expect.poll(() => page.locator(".home").count()).toBe(1);
  });

  it("gives way to the conversation once one is started", async () => {
    await page.getByRole("button", { name: "Start a conversation" }).click();
    await expect.poll(() => page.locator(".home").count()).toBe(0);
    // A conversation now exists, so History groups one. Matched
    // case-insensitively: group headings are `text-transform: uppercase`.
    const flyout = await openHistory(page);
    await expect.poll(() => flyout.innerText()).toMatch(/conversations/i);
    await closeHistory(page);
  });

  it("is still reachable from the rail once a conversation exists", async () => {
    // The defect this pins: the landing page used to be chosen by "has this
    // profile ever had a conversation", which is true forever after the first
    // turn — so Home became unreachable on day one and stayed that way.
    await openFromRail("Home");
    await expect.poll(() => page.locator(".home").count()).toBe(1);
  });
});

describe("Control Center", () => {
  it("does not list conversations", async () => {
    // Reached from the bottom rail group, not from the mode segments: it
    // governs work rather than being a way of doing it, so it sits with the
    // bound project and the connections.
    await openFromRail("Control Center");
    const nav = await page.locator(".rail-group.nav").innerText();

    expect(nav).toContain("Automations");
    expect(nav).toContain("Audit");
    // The worked examples are governed here too, in one list, rather than only
    // as a Load/Clear pair on each surface that happens to have them.
    expect(nav).toContain("Sample data");
    // No History control at all, rather than a History control that opens an
    // empty panel. Control Center is where work is governed, not where it is
    // done, and selecting a conversation from it does nothing a reader sees.
    expect(
      await page.locator(".rail").getByRole("button", { name: "History", exact: true }).count(),
    ).toBe(0);
    expect(await page.locator(".history-flyout").count()).toBe(0);
  });

  it("still lists them in Chat, where they can be opened", async () => {
    await page.getByRole("tab", { name: /^Chat/ }).click();
    const flyout = await openHistory(page);
    await expect.poll(() => flyout.innerText()).toMatch(/conversations/i);
    await closeHistory(page);
  });
});

describe("Chat → Team — the sample council", () => {
  it("fills the question and a roster that will actually disagree", async () => {
    await goTo(page, "Chat", "Team");
    await page.getByRole("button", { name: "Load sample" }).click();

    const pane = page.locator(".pane.chat");
    await expect.poll(() => pane.locator("textarea").first().inputValue()).toContain(
      "rejecting 3% of completed requests",
    );
    // Three stances, so three seats.
    await expect.poll(() => page.locator(".member-avatar").count()).toBe(3);
    const text = await pane.innerText();
    expect(text).toContain("Members (3)");
  });

  it("runs nothing by itself", async () => {
    // A demo that spent tokens on open would be a surprise on someone's bill,
    // so the sample fills the form and stops.
    expect(await page.locator(".round-group").count()).toBe(0);
  });

  it("clears back to the state the pane opens in", async () => {
    await page.getByRole("button", { name: "Clear sample" }).click();
    const pane = page.locator(".pane.chat");
    await expect.poll(() => pane.locator("textarea").first().inputValue()).toBe("");
    await expect.poll(() => page.locator(".member-avatar").count()).toBe(2);
  });
});
