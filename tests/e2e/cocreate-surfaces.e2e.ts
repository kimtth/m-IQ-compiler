import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import { closeHistory, goTo, launchApp, openHistory, type Harness } from "./launch.js";

/**
 * Co-create's secondary surfaces, signed out.
 *
 * The recorder spec is the important one and it is a regression test. The
 * Record tab used to render `{blocked ? <explanation> : <the whole form>}`, so
 * when no Speech resource was registered and nobody was signed in — the state
 * of every fresh install — the card *and the record button with it* were
 * replaced by a single line of prose. The app shipped with no way to start a
 * recording and no way to tell that one was possible. Signed out is therefore
 * exactly the condition this must be asserted under.
 *
 * The rest pin things that are meant to be visible without an identity: what
 * the MCP registry offers on a fresh profile, and the Fabric bundle the app
 * stands on.
 */

let harness: Harness;
let page: Page;

beforeAll(async () => {
  harness = await launchApp();
  page = harness.page;
  await page.locator(".rail").waitFor({ state: "visible" });
  await goTo(page, "Co-create");
});

afterAll(async () => {
  await harness?.close();
});

/**
 * Open one of the rail's secondary surfaces and wait for its tab to be active.
 *
 * The click is scoped to the rail: once a surface is open the canvas tab strip
 * carries a "Close <name>" button, and an unscoped match resolves to two. The
 * wait is a Playwright one rather than `expect.poll`, which Vitest refuses to
 * run outside a test body — and this helper is called from `beforeAll`.
 *
 * It takes the mode as well as the name because the surfaces are not all in
 * one place: Browser and Meeting Recordings are Co-create's, while Skills and
 * MCP servers are Control Center's — neither is work, both are the standing
 * declaration of what the agent may do.
 */
async function openSurface(name: string, mode = "Co-create"): Promise<void> {
  await goTo(page, mode);
  await page.locator(".rail").getByRole("button", { name, exact: true }).click();
  await page.locator(".canvas-tab.active", { hasText: name }).waitFor({ state: "visible" });
}

/**
 * The open surface.
 *
 * Scoped to the canvas because the project navigator is also a pane with its
 * own `.pane-body`, so a bare class selector matches two — and scoped to the
 * pane rather than to `.pane-body` because not every surface has one.
 */
const canvas = (): ReturnType<Page["locator"]> => page.locator(".pane.canvas");
const canvasHeader = (): ReturnType<Page["locator"]> => page.locator(".pane.canvas .pane-header");

describe("Meeting Recordings — the recorder is always reachable", () => {
  beforeAll(async () => {
    await openSurface("Meeting Recordings");
  });

  it("shows the record control even though recording is blocked", async () => {
    const bar = page.locator(".recorder-bar");
    await bar.waitFor({ state: "visible" });

    // Idle, and saying so.
    await expect.poll(() => bar.innerText()).toContain("Ready");
    await expect.poll(() => bar.innerText()).toContain("00:00");

    const button = page.getByRole("button", { name: "Start recording" });
    expect(await button.count()).toBe(1);
    // Present and refused, which is the distinction that was missing: a hidden
    // button and an unavailable one look identical, and only one of them is
    // something the user can act on.
    expect(await button.isDisabled()).toBe(true);
  });

  /**
   * Wait for the recorder's refusal to settle.
   *
   * The button's title passes through three values: the bare label before the
   * component has state, "Loading\u2026" while `meetings:notice` is in flight, and
   * finally the reason. Polling for "not the label" accepts "Loading\u2026" and
   * stops — which is how a spec came to assert that the card displayed the
   * word "Loading\u2026", and passed. A settled reason is a sentence, so length is
   * what distinguishes it from both placeholders.
   */
  const settledReason = async (): Promise<string> => {
    const button = page.locator(".recorder-bar .recorder-toggle");
    await expect
      .poll(async () => ((await button.getAttribute("title")) ?? "").length, { timeout: 15_000 })
      .toBeGreaterThan(20);
    return (await button.getAttribute("title")) ?? "";
  };

  /**
   * The reason is asserted as *a* reason, not as one particular sentence.
   *
   * `meetings.notice()` folds several causes in a fixed order — a missing
   * capture engine, an unregistered Speech resource, a signed-out user — and
   * which one wins is a property of the machine, not of the product. These
   * specs used to demand "Sign in with Microsoft before recording" and failed
   * on any developer machine where Speech happened to be unregistered, which
   * made them noise rather than a signal.
   *
   * What the product actually promises, and what the regression was about, is
   * that the recorder is never *removed*: it stays on screen, refused, and says
   * why. That is what is pinned here.
   */
  it("states the reason it is refused, instead of removing the form", async () => {
    const body = canvas();
    const reason = await settledReason();

    // The reason the button carries must also be visible in the card, so it is
    // not hidden behind a hover the user has no cause to try.
    await expect.poll(() => body.innerText()).toContain(reason);

    // The form itself survives — this is the exact regression.
    await expect.poll(() => body.innerText()).toContain("Record or transcribe a meeting");
    await expect.poll(() => body.innerText()).toContain("Transcribed by");
    expect(await page.getByPlaceholder("What is this meeting?").count()).toBe(1);
  });

  it("carries the reason on the button itself", async () => {
    const title = await settledReason();

    // A sentence, not a placeholder: the point of the title is to say what
    // would have to change.
    expect(title).not.toBe("Start recording");
    expect(title).not.toBe("Loading\u2026");
  });

  it("offers Record and Settings only — screen recording is gone", async () => {
    const header = await canvasHeader().innerText();
    expect(header).toContain("Record");
    expect(header).toContain("Settings");
    expect(header).not.toContain("Screen");
  });

  it("keeps no video settings, now that nothing records video", async () => {
    await canvasHeader().getByRole("button", { name: /Settings/ }).click();
    const body = canvas();
    await expect.poll(() => body.innerText()).toContain("External tools");

    const text = await body.innerText();
    expect(text).toContain("Transcription");
    expect(text).not.toContain("Codec");
    expect(text).not.toContain("Frame rate");
    expect(text).not.toContain("Output folder");
  });
});

describe("Control Center → MCP servers", () => {
  it("offers Power BI modeling on a fresh profile, registered and inert", async () => {
    await openSurface("MCP servers", "Control Center");
    const body = canvas();
    await expect.poll(() => body.innerText()).toContain("Power BI modeling");

    const text = await body.innerText();
    // Seeding registers a server; it grants nothing. Both halves matter.
    expect(text).toContain("never inspected");
    expect(text).toContain("npx");
    // Nothing is enabled by seeding, so the control offered must be Enable.
    expect(await canvas().getByRole("button", { name: /^Enable/ }).count()).toBeGreaterThan(0);
  });

  it("does not seed MarkItDown, which can read any file this process can", async () => {
    // It stays a catalogue entry — a decision someone makes — rather than a
    // row that arrives already configured. The catalogue is further down the
    // page, so this looks only at the registered-servers card.
    const servers = await canvas().locator(".card").first().innerText();
    expect(servers).not.toContain("MarkItDown (Microsoft)");
  });

  it("lists Work IQ on a fresh profile, registered and equally inert", async () => {
    // The Microsoft 365 half of the product. It is *listed* because a server
    // nobody can find is not offered at all; it is not *granted*, which is a
    // separate question and is still answered by hand — hence the assertions
    // that it arrives off, uninspected, and with nothing to disable.
    const row = canvas().locator(".card.nested", { hasText: "Work IQ (Microsoft)" }).first();
    await row.waitFor({ state: "visible" });

    const text = await row.innerText();
    // The catalog contract uses the local stdio CLI.
    expect(text).toContain("npx -y @microsoft/workiq mcp");
    expect(text).toContain("off");
    expect(text).toContain("never inspected");
    // No tool is approved, so the only thing enabling could do is fail.
    expect(await row.getByRole("button", { name: "Enable" }).isDisabled()).toBe(true);
  });
});

describe("Control Center → Skills", () => {
  it("lists the Fabric skill pack alongside the app's own skills", async () => {
    await openSurface("Skills", "Control Center");
    const body = canvas();
    await expect.poll(() => body.innerText()).toContain("Microsoft Fabric skill pack");

    // Either it resolved on this machine or it says why not — both are honest;
    // silence about thirty skills in play is not.
    const text = await body.innerText();
    const resolved = /skills-for-fabric/.test(text);
    const missing = /prepare:fabric-skills/.test(text);
    expect(resolved || missing).toBe(true);
  });
});

describe("Co-create → Fabric", () => {
  it("refuses without a project, and names where to register one", async () => {
    await goTo(page, "Co-create", "Fabric");
    const body = canvas();
    await expect.poll(() => body.innerText()).toContain("No Fabric workspace registered");
    await expect.poll(() => body.innerText()).toContain("Connections & access");
  });
});

/**
 * Co-create keeps a conversation beside its canvas and lists it in the same
 * place Chat does, so it needs the same way to start one and the same working
 * composer. Neither was true: "New conversation" was rendered only in Chat, so
 * the only route was to switch modes, start one there and switch back.
 */
describe("Co-create → the conversation beside the canvas", () => {
  it("offers a way to start one", async () => {
    await goTo(page, "Co-create");
    expect(
      await page.locator(".rail").getByRole("button", { name: "New conversation", exact: true }).count(),
    ).toBe(1);
  });

  it("takes typing in the composer", async () => {
    await page.locator(".rail").getByRole("button", { name: "New conversation", exact: true }).click();

    const composer = page.locator(".pane.chat .composer textarea");
    await composer.waitFor({ state: "visible" });
    await composer.fill("a question about the work");
    await expect.poll(() => composer.inputValue()).toBe("a question about the work");
  });

  /**
   * MEASURED, and the reason it is measured here rather than anywhere else:
   * Co-create's rail is the longest one — four sub-modes and six secondary
   * surfaces, each with a wrapping label and a wrapping tagline under it.
   *
   * The list used to be in that column, and it collapsed. As a plain
   * `flex: 1 1 auto` it was the only thing flex could take space from, so it
   * was squeezed to a height of exactly 0: the rows were in the DOM, clipped
   * by their own container, and unclickable. It is out of the rail now and
   * overlays instead, which is what this pins — however tall the destinations
   * get, the flyout is full height and its rows are reachable.
   */
  it("keeps the conversation list reachable however tall the destinations get", async () => {
    const flyout = await openHistory(page);
    const height = await flyout.evaluate((node) => node.getBoundingClientRect().height);

    // Full height of the shell, so the rail cannot take space from it at all.
    const shell = await page
      .locator(".shell")
      .evaluate((node) => node.getBoundingClientRect().height);
    expect(height).toBe(shell);

    // And the row a person would click is reachable, not merely present.
    await expect
      .poll(() => flyout.locator(".rail-item").first().isVisible())
      .toBe(true);
    await closeHistory(page);
  });
});
