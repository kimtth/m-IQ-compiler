import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import { launchApp, type Harness } from "./launch.js";

/**
 * The door.
 *
 * Both connections are required before the app opens, so this is the one spec
 * that meets the app signed out — it launches without the harness flag and
 * asserts the gate holds. The properties tested here do not depend on whether
 * the machine running the test happens to have `az login` behind it: the card
 * is shown, the tenant override behaves, and Continue is refused for as long as
 * either connection is not green.
 */

let harness: Harness;
let page: Page;

beforeAll(async () => {
  harness = await launchApp({ signedIn: false });
  page = harness.page;
});

afterAll(async () => {
  await harness?.close();
});

describe("sign-in gate", () => {
  it("opens on the sign-in card, not the shell", async () => {
    await expect
      .poll(() => page.getByRole("heading", { name: "Connect IQ Compiler" }).isVisible())
      .toBe(true);

    // The rail is the shell's permanent column, so its absence is the clearest
    // evidence that nothing behind the gate was rendered.
    expect(await page.locator(".rail").count()).toBe(0);
  });

  it("explains what each sign-in does", async () => {
    const card = page.locator(".signin-card");
    await expect.poll(() => card.innerText()).toContain("acquires an Azure token");
    await expect.poll(() => card.innerText()).toContain("connects the agent runtime");
    await expect(page.getByRole("button", { name: "Sign in to Microsoft (Azure)" }).count()).resolves.toBe(1);
    await expect(page.getByRole("button", { name: /Sign in to GitHub Copilot/ }).count()).resolves.toBe(1);
  });

  it("keeps the tenant read-only until Edit is used", async () => {
    // The common case is one click, so the field must not start as an input.
    expect(await page.locator(".signin-card input.mono").count()).toBe(0);

    await page.getByRole("button", { name: "Edit tenant" }).click();
    const field = page.locator(".signin-card input.mono");
    await field.waitFor({ state: "visible" });
    expect(await field.count()).toBe(1);
  });

  it("rejects a malformed tenant before attempting sign-in", async () => {
    const field = page.locator(".signin-card input.mono");
    if ((await field.count()) === 0) {
      await page.getByRole("button", { name: "Edit tenant" }).click();
      await field.waitFor({ state: "visible" });
    }

    await field.fill("not a tenant");
    await page.getByRole("button", { name: "Sign in to Microsoft (Azure)" }).click();

    await expect
      .poll(() => page.locator(".signin-card").innerText())
      .toContain("Enter a tenant GUID or a domain");
  });

  it("refuses Continue while either connection is not green", async () => {
    const green = await page.locator(".signin-card .status-dot.ok").count();
    const cont = page.getByRole("button", { name: "Continue" });

    if (green < 2) {
      expect(await cont.isDisabled()).toBe(true);
    } else {
      // The machine is genuinely connected on both, which is a valid state:
      // then the gate must let the user through rather than trap them.
      expect(await cont.isDisabled()).toBe(false);
    }
  });
});
