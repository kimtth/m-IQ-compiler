import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import { goTo, launchApp, type Harness } from "./launch.js";

/**
 * The approval control, in the shipped window.
 *
 * `tests/auto-approval.test.ts` pins *what* auto-approval covers — the risk the
 * runtime assigns, the risk the fold carries, and the rule written against it.
 * This is the other half: that the control exists where a user can find it,
 * that it asks by default, and that turning it on says on screen that the grant
 * expires.
 *
 * A real approval card cannot be produced here. The harness holds no identity,
 * so no turn runs and no tool is ever requested — which is exactly the boundary
 * these specs stay inside. What can be asserted is the surface the user meets
 * before any of that happens.
 */

let harness: Harness;
let page: Page;

beforeAll(async () => {
  harness = await launchApp();
  page = harness.page;
  await page.locator(".rail").waitFor({ state: "visible" });
  await goTo(page, "Chat", "Conversation");
  // The composer only exists once a conversation does.
  await page.locator(".rail").getByRole("button", { name: "New conversation", exact: true }).click();
});

afterAll(async () => {
  await harness?.close();
});

// The approvals picker sits in the status strip under the box, not in the
// toolbar inside it: it says what the turn will be run under, not what the
// turn is.
const approvals = (): ReturnType<Page["locator"]> =>
  page.locator(".composer-status select[aria-label='Approvals']");

describe("the approval control", () => {
  it("asks before every tool by default", async () => {
    await approvals().waitFor({ state: "visible" });
    expect(await approvals().inputValue()).toBe("ask");
  });

  it("offers exactly two levels, and names what the second one covers", async () => {
    // "read-only" is load-bearing wording: a URL fetch is `external`, so it is
    // deliberately not covered, and the label has to be honest about that.
    expect(await approvals().locator("option").allInnerTexts()).toEqual([
      "Ask before every tool",
      "Auto-approve read-only tools",
    ]);
  });

  it("says the grant is scoped to the session, and only while it is on", async () => {
    const scoped = page.getByText("Scoped to this session", { exact: true });
    expect(await scoped.count()).toBe(0);

    await approvals().selectOption("auto_safe");
    await expect.poll(() => scoped.count()).toBe(1);

    await approvals().selectOption("ask");
    await expect.poll(() => scoped.count()).toBe(0);
  });
});
