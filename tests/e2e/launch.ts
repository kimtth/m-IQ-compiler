import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import type { ElectronApplication, Locator, Page } from "playwright-core";

/**
 * Launching the real app for a system test.
 *
 * These are end-to-end runs, not unit tests: the packaged main process starts,
 * the renderer paints, and the specs drive the same controls a person would.
 * Nothing is stubbed, so a spec that passes means the interaction is actually
 * feasible in the shipped window rather than in a jsdom approximation of it.
 *
 * Two things make that practical. The app is launched against a throwaway user
 * data directory *and* a throwaway `IQ_HOME`, so a run never touches the
 * tester's real profile, saved drafts, registered connections or MCP servers,
 * and every run starts from the same blank slate. Isolating only Electron's
 * user data was not enough: everything the privileged side owns — sessions,
 * skills, memories, `config/*.json` — lives under `IQ_HOME`, so a spec that
 * asserted "a fresh profile offers exactly these MCP servers" was really
 * asserting something about the machine it ran on.
 *
 * And the sign-in gate is opened with `IQ_E2E=1`, which skips the card without
 * granting anything — no token is held, so any surface that needs Azure,
 * Microsoft 365 or Copilot still refuses exactly as it would for a signed-out
 * user. That is the boundary these specs stay inside: the IQ Cell editor and
 * the My IQ surface are entirely renderer-local, so they are fully
 * exercisable, while identity-bound surfaces are only asserted to fail closed.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The app root — `iq-compiler/`. Two levels up from `tests/e2e/`. */
export const ROOT = path.resolve(HERE, "..", "..");

/**
 * Sample files a spec or a manual tester loads.
 *
 * Kept out of this directory on purpose: `tests/e2e/` is code, `sample-data/`
 * is not. Mixing them makes it unclear which files are the harness and which
 * are the material, and it invites specs to reach for whatever happens to sit
 * next to them rather than for a named, curated set.
 */
export const SAMPLE_DATA = path.resolve(ROOT, "sample-data");

const MAIN_ENTRY = path.join(ROOT, "apps", "main", "dist", "index.js");
const RENDERER_ENTRY = path.join(ROOT, "apps", "renderer", "dist", "index.html");

export interface Harness {
  app: ElectronApplication;
  page: Page;
  /** The `IQ_HOME` this run used. Everything the privileged side wrote is here. */
  home: string;
  /** Close the window and delete the throwaway profile. */
  close: () => Promise<void>;
}

export interface LaunchOptions {
  /**
   * Open past the sign-in card. Default true. Set false to test the gate
   * itself, which is the one spec that must meet the app signed out.
   */
  signedIn?: boolean;
  /**
   * Reuse an existing `IQ_HOME` instead of making a fresh one.
   *
   * This is how a spec tests what survives a restart: launch, do something,
   * close, then launch again on the same home. A home passed in is the
   * caller's to delete — `close` leaves it alone, or the second launch would
   * have nothing to find.
   */
  home?: string;
  /** Extra environment for the main process. */
  env?: Record<string, string>;
}

/**
 * Fail with the fix rather than with a stack trace.
 *
 * The overwhelmingly common way to break an e2e run is to forget the build, and
 * Electron's own error for a missing entry point does not say so.
 */
function requireBuild(): void {
  const missing = [MAIN_ENTRY, RENDERER_ENTRY].filter((entry) => !existsSync(entry));
  if (missing.length === 0) return;
  throw new Error(
    `The app is not built, so there is nothing to drive.\n` +
      `Missing: ${missing.map((entry) => path.relative(ROOT, entry)).join(", ")}\n` +
      `Run \`pnpm build\` in ${ROOT} first.`,
  );
}

export async function launchApp(options: LaunchOptions = {}): Promise<Harness> {
  requireBuild();

  const profile = mkdtempSync(path.join(tmpdir(), "iq-e2e-"));
  // The app's own home, separate from Electron's user data. Both are thrown
  // away on close; neither is the tester's.
  const home = options.home ?? mkdtempSync(path.join(tmpdir(), "iq-e2e-home-"));
  const ownsHome = options.home === undefined;

  const app = await electron.launch({
    args: [path.join(ROOT, "apps", "main"), `--user-data-dir=${profile}`],
    cwd: ROOT,
    env: {
      ...process.env,
      IQ_HOME: home,
      // A stale GitHub token in the environment makes the Copilot SDK pick up a
      // non-Copilot identity and report "No model available", which would show
      // up here as an unrelated failure. Strip both, as the runtime does.
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
      // Host-level connection fallbacks are read from the environment by
      // design, so a developer who has them set would otherwise run these
      // specs against a configured app while CI runs them against a blank one.
      IQ_FABRIC_WORKSPACE_ID: "",
      IQ_FABRIC_DATA_AGENT_URL: "",
      IQ_FABRIC_DATA_AGENT_ID: "",
      ...(options.signedIn === false ? {} : { IQ_E2E: "1" }),
      ...options.env,
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The app opens with the rail narrowed to icons. That is right for a person
  // — every destination is still one click away and the work gets the width —
  // and wrong for a test, because the specs navigate by rail label and every
  // run gets a fresh profile, so the preference is never carried over. Open it
  // once here so no spec has to think about it.
  if (options.signedIn !== false) {
    await page.locator(".rail").waitFor({ state: "attached", timeout: 15_000 });
    if ((await page.locator(".rail.icons").count()) > 0) {
      await page.getByRole("button", { name: "Show Panel" }).click();
      await page.locator(".rail:not(.icons)").waitFor({ timeout: 5_000 });
    }
  }

  return {
    app,
    page,
    home,
    close: async () => {
      await app.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
      if (ownsHome) rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * Open a top-level mode, then one of its sub-modes.
 *
 * The rail is the only navigation surface, so every spec starts here. Mode
 * labels carry a beta suffix in their accessible name, which is why this
 * matches on the visible text of the segment instead — a prefix match, over a
 * name that is **escaped first**. Labels do contain regex metacharacters, and
 * unescaped a pair of parentheses becomes a group: the pattern then asks for
 * the name without them, matches nothing, and every spec in the file fails in
 * `beforeAll` with no mention of the name that caused it.
 *
 * Control Center is not a segment. It sits at the top of the bottom rail group
 * with the project and the connections, because it governs work rather than
 * being a way of doing it — so it is reached as a rail item.
 */
const startsWith = (name: string): RegExp =>
  new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

export async function goTo(page: Page, mode: string, subMode?: string): Promise<void> {
  const segment = page.getByRole("tab", { name: startsWith(mode) });
  if ((await segment.count()) > 0) await segment.click();
  else await page.locator(".rail").getByRole("button", { name: mode, exact: true }).click();
  if (subMode !== undefined) {
    await page.getByRole("button", { name: startsWith(subMode) }).first().click();
  }
}

/**
 * Open the History flyout and return it.
 *
 * The conversation list is not in the rail. The rail lists places; History
 * lists the things the user made. It opens over the work rather than beside
 * it, so a spec can read the list without leaving the surface under test.
 *
 * Only Chat and Co-create have the control, because they are the only modes
 * that hold a conversation. Calling this anywhere else fails on the click,
 * which is the right answer: the list is genuinely not there.
 */
export async function openHistory(page: Page): Promise<Locator> {
  const flyout = page.locator(".history-flyout");
  if ((await flyout.count()) === 0) {
    await page.locator(".rail").getByRole("button", { name: "History", exact: true }).click();
  }
  await flyout.waitFor({ timeout: 5_000 });
  return flyout;
}

/** Close the History flyout if it is open. */
export async function closeHistory(page: Page): Promise<void> {
  if ((await page.locator(".history-flyout").count()) === 0) return;
  await page.getByRole("button", { name: "Close history" }).click();
  await page.locator(".history-flyout").waitFor({ state: "detached", timeout: 5_000 });
}
