import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import { goTo, launchApp, type Harness } from "./launch.js";

/**
 * Connectome IQ — the AI-driven company organization.
 *
 * The shared IQ data is renderer-local fixture data, so the full hierarchy can
 * be exercised without an identity, model, project, network or MCP process.
 */

let harness: Harness;
let page: Page;

beforeAll(async () => {
  harness = await launchApp();
  page = harness.page;
  await goTo(page, "Connectome IQ");
  await page.locator(".iq-org").waitFor({ state: "visible", timeout: 15_000 });
});

afterAll(async () => {
  await harness?.close();
}, 60_000);

describe("Connectome IQ — company hierarchy", () => {
  it("uses the full surface for the organization until a node is selected", async () => {
    await expect.poll(() => page.locator(".iq-hub-body.detail-open").count()).toBe(0);
    await expect.poll(() => page.locator(".iq-org-detail").count()).toBe(0);
  });

  it("shows company, specialized IQ and AI-role levels", async () => {
    await expect.poll(() => page.locator(".iq-org-company").count()).toBe(1);
    await expect.poll(() => page.locator(".iq-org-specialist").count()).toBe(5);
    await expect.poll(() => page.locator(".iq-org-role").count()).toBe(3);

    const chart = await page.locator(".iq-org").innerText();
    expect(chart).toContain("AI-driven company");
    expect(chart).toContain("IQ Contoso");
    expect(chart).toContain("Specialized IQ");
    expect(chart).toContain("AI role");
  });

  it("draws bold connectors between every organization level", async () => {
    const companyLine = await page.locator(".iq-org-company").evaluate(
      (node) => getComputedStyle(node, "::after").borderLeftWidth,
    );
    const specialistLine = await page.locator(".iq-org-branch").first().evaluate(
      (node) => getComputedStyle(node, "::before").borderLeftWidth,
    );
    const roleLine = await page.locator(".iq-org-roles").evaluate(
      (node) => getComputedStyle(node).borderLeftWidth,
    );

    expect(Number.parseFloat(companyLine)).toBeGreaterThanOrEqual(3);
    expect(Number.parseFloat(specialistLine)).toBeGreaterThanOrEqual(3);
    expect(Number.parseFloat(roleLine)).toBeGreaterThanOrEqual(3);
  });

  it("expands and hides every specialized branch", async () => {
    await page.getByRole("button", { name: "Show all AI roles" }).click();
    await expect.poll(() => page.locator(".iq-org-role").count()).toBe(15);

    await page.getByRole("button", { name: "Hide all AI roles" }).click();
    await expect.poll(() => page.locator(".iq-org-role").count()).toBe(0);
  });

  it("opens an AI role in the detail panel", async () => {
    await page.getByRole("button", { name: "Show AI roles in Customer support IQ" }).click();
    const role = page.locator(".iq-org-role").first();
    const roleName = (await role.locator("strong").innerText()).trim();
    await role.click();

    const detail = page.locator(".iq-org-role-detail");
    await detail.waitFor({ state: "visible" });
    expect(await detail.innerText()).toContain(roleName);
    expect(await detail.innerText()).toContain("completion");
  });

  it("adds specialized IQs to one company context", async () => {
    const operations = page.locator(".iq-org-specialist", { hasText: "Operations IQ" });
    await operations.getByRole("button", { name: "Add to context" }).click();
    await expect
      .poll(() => page.locator(".flow-head").innerText())
      .toContain("2 in company context");
    await expect.poll(() => operations.getByRole("button", { name: "In company context" }).count()).toBe(1);
  });

  it("filters the organization by function and AI role", async () => {
    const search = page.getByLabel("Search specialized IQs");
    await search.fill("leadership");
    await expect.poll(() => page.locator(".iq-org-specialist").count()).toBe(1);
    expect(await page.locator(".iq-org-specialist").innerText()).toContain("Project delivery IQ");
    expect(await page.locator(".iq-org-company").count()).toBe(1);

    await search.fill("");
    await expect.poll(() => page.locator(".iq-org-specialist").count()).toBe(5);
  });
});
