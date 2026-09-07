import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import { goTo, launchApp, openHistory, type Harness } from "./launch.js";

/**
 * Conversations: creating them, listing them, and naming them.
 *
 * They are created from the rail and listed in History, which opens over the
 * work and stays open until it is dismissed. Anything wrong here makes the
 * surface unusable in a way no unit test can see: the channels answer
 * correctly and the list still shows one row.
 */

let harness: Harness;
let page: Page;

beforeAll(async () => {
  harness = await launchApp();
  page = harness.page;
  await page.locator(".rail").waitFor({ state: "visible" });
  // Opened once. The flyout has no scrim and does not close when a row is
  // picked, so it stays readable across everything below.
  await openHistory(page);
});

afterAll(async () => {
  await harness?.close();
});

/** The rows in History, which is the list under test. */
const conversationRows = (): ReturnType<Page["locator"]> =>
  page.locator(".history-flyout .rail-item");

async function newConversation(): Promise<void> {
  await page.locator(".rail").getByRole("button", { name: "New conversation", exact: true }).click();
}

describe("conversations — Chat", () => {
  beforeAll(async () => {
    await goTo(page, "Chat", "Conversation");
  });

  it("lists a conversation once one is started", async () => {
    await newConversation();
    await expect.poll(() => conversationRows().count()).toBe(1);
  });

  it("creates a second one rather than reusing the first", async () => {
    // The reported defect: pressing it again appeared to do nothing, because
    // every session was created with the same title and nothing ever changed
    // it, so two identical rows read as one.
    await newConversation();
    await expect.poll(() => conversationRows().count()).toBe(2);
  });

  it("can be renamed from the row, which is where the name is read", async () => {
    // The `title_changed` event had been in the schema, and read by
    // `SessionRepo.summary`, since the beginning — and nothing ever emitted
    // one. There was no way to name a conversation at all.
    const row = conversationRows().first();
    await row.dblclick();

    const field = page.locator(".rail-rename");
    await field.waitFor({ state: "visible" });
    await field.fill("Seal check decision");
    await field.press("Enter");

    await expect.poll(() => conversationRows().first().innerText()).toContain(
      "Seal check decision",
    );
  });

  it("keeps the new name after the row is left alone", async () => {
    // Renaming writes an event; the list re-reads the published index. If the
    // name only lived in component state it would survive the keystroke and
    // nothing else.
    await goTo(page, "Chat", "Team");
    await goTo(page, "Chat", "Conversation");
    await expect.poll(() => page.locator(".history-flyout").innerText()).toContain(
      "Seal check decision",
    );
  });
});

describe("conversations — Co-create", () => {
  it("offers and lists them beside the canvas too", async () => {
    await goTo(page, "Co-create");
    const before = await conversationRows().count();
    await newConversation();
    // A generous window: creating a conversation is a round trip to the
    // privileged side and back through the published index, and this spec runs
    // after another that has just booted and torn down a second Electron app.
    await expect.poll(() => conversationRows().count(), { timeout: 15_000 }).toBe(before + 1);
  });
});

