import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { goTo, launchApp, type Harness } from "./launch.js";

/**
 * The browser pane comes back to the page it was on.
 *
 * This has to be a system test. The behaviour is a conversation between four
 * things that only exist in a running app: the pane writes
 * `config/browser.json` when a navigation lands, the file survives the process,
 * the renderer asks `browser:restore` when the surface mounts, and the pane
 * navigates again. A unit test can prove any single link and still leave the
 * feature broken — which is what happened, so the whole chain is driven here.
 *
 * **One home, two launches.** The harness normally hands every run a throwaway
 * `IQ_HOME`, which is right for every other spec and fatal for this one: the
 * second app would open on a blank profile with nothing to restore. Each case
 * makes its own home and passes it to both launches, so it is the same disk
 * both times and the spec still touches nothing of the tester's.
 *
 * **The first case needs the network.** It is the only spec in this suite that
 * does. There is no way around it: what is under test is a real browser
 * returning to a real page, and the pane accepts only `https:`, so a local
 * server would need a certificate Chromium trusts. `IQ_E2E_URL` overrides the
 * page for a machine that cannot reach the default.
 */

/** A page that actually loads. Small, stable, and nothing but a paragraph. */
const LIVE_PAGE = process.env.IQ_E2E_URL || "https://example.com/";

/** The host of {@link LIVE_PAGE}, which is all the assertions need to match on. */
const LIVE_HOST = new URL(LIVE_PAGE).hostname;

/** A reserved host that never resolves, so this load is guaranteed to fail. */
const DEAD_PAGE = "https://e2e-last-page.invalid/remembered";

const homes: string[] = [];

function newHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "iq-e2e-restore-"));
  homes.push(home);
  return home;
}

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/** Open Co-create → Browser and wait for its tab. */
async function openBrowser(harness: Harness): Promise<void> {
  const { page } = harness;
  await page.locator(".rail").waitFor({ state: "visible" });
  await goTo(page, "Co-create");
  await page.locator(".rail").getByRole("button", { name: "Browser", exact: true }).click();
  await page.locator(".canvas-tab.active", { hasText: "Browser" }).waitFor({ state: "visible" });
}

/** The address bar of the open Browser surface. */
const addressBar = (harness: Harness): ReturnType<Harness["page"]["locator"]> =>
  harness.page.locator('.pane.canvas .pane-header input[placeholder="https://…"]');

/** Type a URL into the address bar and press Go, as a user would. */
async function goToPage(harness: Harness, url: string): Promise<void> {
  const bar = addressBar(harness);
  await bar.click();
  await bar.fill(url);
  await harness.page.getByRole("button", { name: "Go", exact: true }).click();
}

/**
 * The pages the app remembers, newest first.
 *
 * One entry per conversation. These runs never open one, so the entry they
 * write is the pane's own bucket — an empty conversation id.
 */
function remembered(home: string): { sessionId: string; url: string }[] {
  const file = path.join(home, "config", "browser.json");
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      pages?: { sessionId: string; url: string }[];
    };
    return raw.pages ?? [];
  } catch {
    return [];
  }
}

describe("Browser — the last page comes back after a restart", () => {
  it("restores the page the pane was on when the app was last open", async () => {
    const home = newHome();

    // --- first run: go somewhere ------------------------------------------
    const first = await launchApp({ home });
    try {
      await openBrowser(first);
      await goToPage(first, LIVE_PAGE);

      // The engine has to start a real browser, so give it room.
      await expect
        .poll(() => addressBar(first).inputValue(), { timeout: 60_000 })
        .toContain(LIVE_HOST);

      // The file is what survives the process. Asserted directly, because "the
      // pane still shows the URL" would also pass on an app that wrote nothing.
      await expect
        .poll(() => remembered(home)[0]?.url ?? "", { timeout: 15_000 })
        .toContain(LIVE_HOST);
    } finally {
      await first.close();
    }

    // --- second run: it should already be there ---------------------------
    const second = await launchApp({ home });
    try {
      await openBrowser(second);

      // Nothing is typed and no button pressed. If this passes, opening the
      // surface was enough.
      await expect
        .poll(() => addressBar(second).inputValue(), { timeout: 60_000 })
        .toContain(LIVE_HOST);
    } finally {
      await second.close();
    }
  });

  /**
   * The regression that made the feature look dead.
   *
   * A load that fails leaves Chromium on `chrome-error://chromewebdata/`. The
   * pane recorded whatever URL the page reported, so one unreachable host
   * overwrote the last good page with a string the policy then refuses, and
   * every restart after that came back to an empty pane. None of that is
   * visible from the surface, which is why it is asserted against the file.
   */
  it("does not remember a page that failed to load", async () => {
    const home = newHome();
    const harness = await launchApp({ home });
    try {
      await openBrowser(harness);
      await goToPage(harness, DEAD_PAGE);

      // The pane reports the failure, so the navigation has definitely been
      // attempted and settled by the time the file is read.
      await harness.page.locator(".pane.canvas .error").waitFor({ timeout: 60_000 });

      expect(remembered(home)).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
