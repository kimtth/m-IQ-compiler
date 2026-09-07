import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import { goTo, launchApp, openHistory, type Harness } from "./launch.js";

/**
 * Where a conversation is held.
 *
 * A conversation is not only a thread: one that built a deck belongs to
 * Co-create → Office, and picking it from the rail brings back the mode and
 * the canvas tab as well as the messages.
 *
 * **What decides that is the work, never the window.** This spec used to
 * assert the opposite — navigate to Office with a conversation selected and
 * the conversation was filed under Office — and that is the defect it was
 * written to describe rather than to catch. On a real profile it produced nine
 * records for one deck conversation, in which the correct place was written
 * seventh and buried by two more clicks; the rail then restored Research for a
 * conversation whose only tool call was `office_create_document`.
 *
 * So what is assertable here is the guard: selecting a conversation returns to
 * *its* place and wandering around with one selected does not re-file it. The
 * harness holds no identity, so no turn runs and no tool is ever requested —
 * which means every conversation it can make is genuinely unplaced, and the
 * thread is genuinely where each belongs. Placement from real work is pinned
 * in `tests/session-clear.test.ts` and, against a real profile, in
 * `tests/place-repair-real.test.ts`.
 *
 * Its own harness, and so its own profile, on purpose: this spec reads rows by
 * position, and the conversation list is the one list that grows without
 * bound. Sharing a window with the specs that create conversations of their
 * own would leave these rows below the fold, where they could not be clicked
 * at all.
 */

let harness: Harness;
let page: Page;

beforeAll(async () => {
  harness = await launchApp();
  page = harness.page;
  await page.locator(".rail").waitFor({ state: "visible" });
  // Opened once, and it stays open: the flyout has no scrim and does not close
  // when a row is picked, so selecting a conversation from it is one click
  // here exactly as it was in the rail.
  await openHistory(page);
});

afterAll(async () => {
  await harness?.close();
});

const conversationRows = (): ReturnType<Page["locator"]> =>
  page.locator(".history-flyout .rail-item");

async function newConversation(): Promise<void> {
  await page.locator(".rail").getByRole("button", { name: "New conversation", exact: true }).click();
}

/** Rail destinations only: the canvas tab strip carries a "Close <name>". */
async function openFromRail(name: string): Promise<void> {
  await page.locator(".rail").getByRole("button", { name, exact: true }).click();
}

/**
 * The two conversations, by position.
 *
 * The list is ordered by `updatedAt`, newest first, and a place change is
 * deliberately *not* activity — so these keep their rows however much the
 * window moves around them. That is itself part of what is under test: were a
 * place to advance `updatedAt`, merely looking at a conversation would reorder
 * the user's history.
 */
const secondRow = (): ReturnType<Page["locator"]> => conversationRows().nth(0);
const firstRow = (): ReturnType<Page["locator"]> => conversationRows().nth(1);

/** The open canvas tab, or "" in a mode that has no canvas at all. */
const activeTab = async (): Promise<string> => {
  const tab = page.locator(".canvas-tab.active");
  return (await tab.count()) === 0 ? "" : tab.innerText();
};

/**
 * Select a conversation and report where the window landed.
 *
 * The click is inside the poll because recording a place is a round trip to
 * the privileged side: a row can be reached before the place just established
 * has come back through the published index, and selecting the same
 * conversation twice is exactly what a person would do.
 */
const landOn = async (row: ReturnType<Page["locator"]>): Promise<string> => {
  await row.click();
  return activeTab();
};

describe("a conversation opens where it was held", () => {
  beforeAll(async () => {
    await goTo(page, "Chat", "Conversation");

    await newConversation();
    // Waited on with a locator rather than `expect.poll`, which refuses to run
    // outside a test.
    await conversationRows().nth(0).waitFor({ state: "visible", timeout: 15_000 });
    // The user wanders to a sub-mode with this conversation selected.
    await goTo(page, "Co-create", "Office");

    await newConversation();
    await conversationRows().nth(1).waitFor({ state: "visible", timeout: 15_000 });
    // And to a secondary surface with the other one selected.
    await openFromRail("Meeting Recordings");
    await page
      .locator(".canvas-tab.active", { hasText: "Meeting Recordings" })
      .waitFor({ state: "visible" });
  });

  it("returns an unplaced conversation to the thread, wherever the window had got to", async () => {
    // Office is on screen, and the conversation about to be selected did no
    // work at all. Filing it under Office because that is what the user
    // happened to be looking at is the whole defect.
    await goTo(page, "Co-create", "Office");
    expect(await activeTab()).toContain("Office");

    await expect.poll(() => landOn(firstRow()), { timeout: 15_000 }).toBe("");
    expect(await page.getByRole("tab", { selected: true }).first().innerText()).toMatch(/chat/i);
  });

  it("does the same for a conversation that sat beside a secondary surface", async () => {
    // Back to a mode with a canvas first: the previous test deliberately left
    // the window on Chat, which is one pane and lists no secondary surfaces.
    await goTo(page, "Co-create", "Office");
    await openFromRail("Meeting Recordings");
    expect(await activeTab()).toContain("Meeting Recordings");

    await expect.poll(() => landOn(secondRow()), { timeout: 15_000 }).toBe("");
  });

  it("does not carry one conversation's view over to the next", async () => {
    // Two conversations, neither placed, and selecting either lands on the
    // same honest answer rather than on whatever the previous one left open.
    await expect.poll(() => landOn(firstRow()), { timeout: 15_000 }).toBe("");
    await expect.poll(() => landOn(secondRow()), { timeout: 15_000 }).toBe("");
  });

  it("records nothing for a conversation that only sat there", async () => {
    // The durable half of the same claim: wandering wrote no `place_changed`,
    // so nothing on disk has to be outvoted later. The rail is ordered by
    // `updatedAt`, so an unchanged order is the observable proof that neither
    // conversation was written to while the window moved.
    const before = await conversationRows().allInnerTexts();
    await goTo(page, "Co-create", "Office");
    await openFromRail("Meeting Recordings");
    await goTo(page, "Chat", "Conversation");
    expect(await conversationRows().allInnerTexts()).toEqual(before);  });
});

/**
 * Saying up front what a conversation is for.
 *
 * The one place the shell is allowed to state where a conversation belongs,
 * and it is legitimate for the reason none of the navigation records were: it
 * answers a question the user was actually asked, once, before the
 * conversation exists.
 *
 * Asserted as *reachability and effect* — the menu exists, it offers only
 * destinations a conversation can be held in, and picking one lands the window
 * there. That the choice survives later tool calls is not assertable here: the
 * harness holds no identity, so no turn runs and no tool is ever requested. It
 * is pinned in `tests/session-clear.test.ts`.
 *
 * Last in the file, because it creates conversations of its own and the specs
 * above read rows by position.
 */
describe("choosing where a new conversation belongs", () => {
  const picker = (): ReturnType<Page["locator"]> => page.locator(".rail-new-menu");

  const openPicker = async (): Promise<void> => {
    await page
      .locator(".rail")
      .getByRole("button", { name: "Choose where this conversation belongs" })
      .click();
    await picker().waitFor({ state: "visible" });
  };

  beforeAll(async () => {
    await goTo(page, "Chat", "Conversation");
  });

  it("offers the destinations a conversation can be held in, and no others", async () => {
    await openPicker();
    const offered = await picker().getByRole("menuitem").allInnerTexts();
    const labels = offered.map((entry) => entry.split("\n")[0]?.trim());

    // The first four are `CONVERSATION_DESTINATIONS`, in its order. Data agent
    // is last and below a separator because it is not one: it starts a thread
    // on the Fabric service, not a session, and the privileged side refuses to
    // file a session there.
    expect(labels).toEqual(["Conversation", "Office", "Fabric", "Browser", "Data agent"]);
    // Team replaces the chat pane with state of its own, so a conversation
    // filed on it reopens showing none of its own messages.
    expect(labels).not.toContain("Team");
  });

  it("starts the conversation on the destination that was picked", async () => {
    await picker().getByRole("menuitem", { name: /^Office/ }).click();

    await expect.poll(() => activeTab(), { timeout: 15_000 }).toContain("Office");
  });

  it("dismisses without starting anything when the menu is closed", async () => {
    const before = await conversationRows().count();
    await openPicker();
    await page.locator(".menu-scrim").click();

    await expect.poll(() => picker().count()).toBe(0);
    expect(await conversationRows().count()).toBe(before);
  });
});
