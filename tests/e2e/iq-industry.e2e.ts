import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import { goTo, launchApp, type Harness } from "./launch.js";

/**
 * IQ Cell → IQ Industry.
 *
 * Entirely renderer-local: the primers are bundled with the app and rendered by
 * the renderer, so nothing here needs an identity, a project, a model or the
 * network. That makes it one of the few surfaces this harness can drive all the
 * way through rather than only assert refuses legibly.
 */

let harness: Harness;
let page: Page;

beforeAll(async () => {
  harness = await launchApp();
  page = harness.page;
  await page.locator(".rail").waitFor({ state: "visible" });
  await goTo(page, "IQ Cell", "IQ Industry");
  await page.locator(".industry").waitFor({ state: "visible" });
});

afterAll(async () => {
  await harness?.close();
});

describe("IQ Industry — the primer list", () => {
  it("offers the bundled primers", async () => {
    await expect.poll(() => page.locator(".industry-item").count()).toBe(2);
  });

  it("names them, rather than their filenames", async () => {
    const list = await page.locator(".industry-list").innerText();
    expect(list).toMatch(/software/i);
    expect(list).toMatch(/consulting/i);
  });

  it("filters", async () => {
    await page.getByLabel("Filter primers").fill("software");
    await expect.poll(() => page.locator(".industry-item").count()).toBe(1);
    await page.getByLabel("Filter primers").fill("");
    await expect.poll(() => page.locator(".industry-item").count()).toBe(2);
  });
});

describe("IQ Industry — the document", () => {
  it("renders the markdown rather than showing its source", async () => {
    const doc = page.locator(".industry-page .md");
    await doc.waitFor({ state: "visible" });
    const text = await doc.innerText();
    // If the renderer were falling through to plain text these would be in the
    // body rather than in the markup.
    expect(text).not.toContain("## ");
    expect(text).not.toContain("---");
    expect(await doc.locator("h2").count()).toBeGreaterThan(3);
  });

  it("renders the abstract as a callout and lists as lists", async () => {
    await page.locator(".industry-item", { hasText: "Software" }).first().click();
    await expect.poll(() => page.locator(".md-callout").count()).toBe(1);
    await expect.poll(() => page.locator(".industry-page .md ul li").count()).toBeGreaterThan(0);
    await expect.poll(() => page.locator(".industry-page .md ol li").count()).toBeGreaterThan(0);
  });

  it("marks a wikilink that leads outside the bundled set", async () => {
    // The primers were written inside a much larger vault, so most targets are
    // not here. A link that silently goes nowhere would be worse than saying so.
    await expect.poll(() => page.locator(".wikilink.missing").count()).toBeGreaterThan(0);
  });

  it("offers an outline that moves the document", async () => {
    const outline = page.locator(".industry-outline button");
    await expect.poll(() => outline.count()).toBeGreaterThan(3);
    await outline.nth(3).click();
    await expect.poll(() => page.locator(".industry-page").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });
});

describe("IQ Industry — the IQ Cells it stands behind", () => {
  it("offers no Publish control of its own", async () => {
    // All bundled primers are already in the library — it reconciles them on every visit,
    // because they ship with the app rather than being something anyone chose
    // to make. A button whose only possible effect is to version a record that
    // is already there is a button that does nothing a reader can see.
    expect(
      await page.locator(".industry-doc").getByRole("button", { name: /Compile|Publish/ }).count(),
    ).toBe(0);
  });

  it("is listed in the IQ Cell library under IQ Industry", async () => {
    await goTo(page, "IQ Cell", "IQ Cell library");
    await expect
      .poll(() => page.locator(".pane.canvas").innerText(), { timeout: 15_000 })
      .toMatch(/Brief me on/i);
    // The library routes each row back to the surface it came from, so the
    // origin has to be on the record rather than guessed from the name.
    expect(await page.locator(".pane.canvas").innerText()).toMatch(/IQ Industry/i);
  });
});
