/**
 * Capture one screenshot per mode for the README.
 *
 * Run after `pnpm build`:
 *
 *     node scripts/capture-modes.mjs
 *
 * The app is launched exactly as the system tests launch it — a throwaway
 * Electron profile, a throwaway `IQ_HOME`, and `IQ_E2E=1` to open past the
 * sign-in card. Nothing here touches the real profile, and `IQ_E2E` grants no
 * token, so identity-bound surfaces render their "not connected" state. That is
 * the honest picture of a fresh install and it is what the README should show.
 *
 * The sample data is loaded first, so the surfaces that are renderer-local —
 * IQ Cell, memories, the knowledge graph — have something in them instead of
 * being four pictures of an empty pane.
 *
 * One sample set needs a tool: the project module builds its document with
 * OfficeCLI rather than shipping a `.docx` in the source tree. The sandbox has
 * no tools directory of its own, so a real install is copied into it before
 * launch. Without one that set refuses to load and the Office shot is a picture
 * of an empty preview — the script says so and carries on.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "docs", "images");

/** The conversation the sample project ships, by the title it is filed under. */
const SAMPLE_CONVERSATION = "Release readiness for the Checkout API";

/** Mode label in the rail, the sub-mode to land on, and the file it is written to. */
const MODES = [
  { label: "Chat", subMode: "Conversation", file: "mode-chat.png" },
  // Office rather than Fabric, which is Co-create's first entry: without a
  // registered workspace Fabric is a picture of a missing connection.
  { label: "Co-create", subMode: "Office", file: "mode-cocreate.png" },
  { label: "IQ Cell", subMode: "My IQ", file: "mode-iq-cell.png" },
  { label: "Connectome IQ", subMode: "Connectome IQ", file: "mode-connectome-iq.png" },
  // Automations rather than the Sample data surface this script has just been
  // using, which would photograph as a page about the screenshots.
  { label: "Control Center", subMode: "Automations", file: "mode-control-center.png" },
];

/** IQ Cell submodules not already shown in the My IQ or library views. */
const IQ_CELL_MODULES = [
  "IQ Industry",
  "IQ Workflow",
  "IQ Knowledge",
  "IQ Memories",
];

// Named modes on the command line limit the run to those pictures:
//
//     node scripts/capture-modes.mjs "Connectome IQ"
//
// One surface changing is the common case, and a full run rewrites every file
// whether or not the app behind it moved. With a filter the IQ Cell montage is
// skipped too, since it is built from a sweep of its own submodules.
const only = process.argv.slice(2);
const modes = only.length === 0 ? MODES : MODES.filter(({ label }) => only.includes(label));
if (modes.length === 0) {
  console.error(
    `no mode matches ${only.join(", ")} — known modes: ${MODES.map(({ label }) => label).join(", ")}`,
  );
  process.exit(1);
}

/** Match on visible text: mode labels carry a beta suffix in their a11y name. */
const startsWith = (name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

async function goTo(page, mode, subMode) {
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
 * The rail lists places; History lists the conversations. It is a flyout over
 * the work, opened from the bottom rail group, and only Chat and Co-create
 * carry the control — they are the only modes that hold a conversation.
 */
async function openHistory(page) {
  const flyout = page.locator(".history-flyout");
  if ((await flyout.count()) === 0) {
    await page.locator(".rail").getByRole("button", { name: "History", exact: true }).click();
  }
  await flyout.waitFor({ timeout: 5_000 });
  return flyout;
}

/** Close the History flyout if it is open. It overlays the work, so a shot taken with it up is a picture of the list. */
async function closeHistory(page) {
  if ((await page.locator(".history-flyout").count()) === 0) return;
  await page.getByRole("button", { name: "Close history" }).click();
  await page.locator(".history-flyout").waitFor({ state: "detached", timeout: 5_000 });
}

const profile = mkdtempSync(path.join(tmpdir(), "iq-shot-"));
const home = mkdtempSync(path.join(tmpdir(), "iq-shot-home-"));
mkdirSync(OUT, { recursive: true });

// Lend the sandbox the OfficeCLI from the real app home. Copied rather than
// downloaded so this script needs no network, and copied rather than shared so
// the sandbox stays throwaway.
const realTools = path.join(homedir(), ".iq-compiler", "tools", "officecli");
if (existsSync(realTools)) {
  cpSync(realTools, path.join(home, "tools", "officecli"), { recursive: true });
} else {
  console.warn(
    `no OfficeCLI at ${realTools} — the sample project will not load and the ` +
      "Co-create shot will show an empty preview",
  );
}

const app = await electron.launch({
  args: [path.join(ROOT, "apps", "main"), `--user-data-dir=${profile}`],
  cwd: ROOT,
  env: {
    ...process.env,
    IQ_HOME: home,
    // Same strips the system tests make: a stale GitHub token picks up a
    // non-Copilot identity, and host-level fallbacks would configure surfaces
    // that are meant to photograph as unconfigured.
    GITHUB_TOKEN: "",
    GH_TOKEN: "",
    IQ_FABRIC_WORKSPACE_ID: "",
    IQ_FABRIC_DATA_AGENT_URL: "",
    IQ_FABRIC_DATA_AGENT_ID: "",
    IQ_E2E: "1",
  },
});

try {
  const page = await app.firstWindow();
  // Shorter than the default so a step that cannot complete says which one it
  // was instead of the run looking hung for half a minute at a time.
  page.setDefaultTimeout(20_000);
  await page.waitForLoadState("domcontentloaded");

  // Maximise before anything is measured. The default window is narrow enough
  // that the three-column surfaces squeeze their middle column to nothing —
  // the Office preview in particular collapses to a sliver of a page — and a
  // screenshot of that says the app is cramped rather than that the window was.
  await app.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows();
    window?.maximize();
  });
  await page.locator(".rail").waitFor({ state: "visible" });

  // The app opens with the rail narrowed to icons, and every run here gets a
  // fresh profile so the preference is never carried over. Open it once: a
  // README screenshot has to show what each destination is called, and this
  // script navigates by those labels.
  if ((await page.locator(".rail.icons").count()) > 0) {
    await page.getByRole("button", { name: "Show Panel" }).click();
    await page.locator(".rail:not(.icons)").waitFor({ timeout: 5_000 });
  }

  // Hide the harness banner. It is fixed to the top of the window and covers
  // the canvas tab strip, so it hides a real part of the app in every shot.
  // Only the banner goes: the signed-out state underneath it is left alone, so
  // the surfaces still photograph as a fresh install rather than a staged one.
  await page.addStyleTag({ content: ".harness-banner { display: none !important; }" });

  await goTo(page, "Control Center", "Sample data");
  // One card per set, not a single button: the surface lists the sets
  // separately so each can be loaded and cleared on its own.
  //
  // Each card is found again by its own label rather than held as an index,
  // because the list re-renders after every load and a held handle goes stale
  // mid-click. And the wait is on the card's loaded/not-loaded pill, not on the
  // button: the button stays in the DOM and only goes disabled, so it says
  // nothing about whether the load finished. It is also disabled for the whole
  // surface while any load runs, which is why it is waited on to come back.
  const cards = page
    .locator(".card")
    .filter({ has: page.getByRole("button", { name: "Load", exact: true }) });
  const labels = await cards.locator("strong").allTextContents();
  for (const label of labels) {
    const card = cards.filter({ has: page.locator("strong", { hasText: label }) }).first();
    const pill = card.locator(".pill").first();
    if ((await pill.textContent()) === "loaded") continue;
    const load = card.getByRole("button", { name: "Load", exact: true });
    // Every Load on the surface is disabled while any one load runs, so a
    // single check races the set before it. Polled against a clock rather than
    // a count: one module's card leaves the list for a moment while the set
    // re-renders, and a check that has to wait out its own timeout first turns
    // a count of tries into minutes of them.
    const deadline = Date.now() + 20_000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      ready = await load.isEnabled({ timeout: 1_000 }).catch(() => false);
      if (!ready) await page.waitForTimeout(500);
    }
    if (!ready) {
      console.log(`skipped "${label}" — its Load button never became available`);
      continue;
    }
    await load.click();
    // Generous: the project set spawns OfficeCLI twice and writes a real
    // document. If it never lands — no OfficeCLI, say — carry on and let the
    // shot show whatever the app actually looks like in that state. Anchored,
    // because "not loaded" contains "loaded".
    const landed = await pill
      .filter({ hasText: /^loaded$/ })
      .waitFor({ timeout: 90_000 })
      .then(() => true)
      .catch(() => false);
    console.log(landed ? `loaded "${label}"` : `"${label}" did not load`);
  }
  await page.waitForTimeout(2_000);

  /** Close every open canvas tab. Each mode opens its own; without this they pile up. */
  const closeTabs = async () => {
    const closeAll = page.getByRole("button", { name: "Close all" });
    if ((await closeAll.count()) > 0) await closeAll.first().click();
  };

  // Visiting Sample data leaves a canvas tab behind, and it would appear in
  // every shot after it as a tab belonging to some other mode.
  await closeTabs();

  /**
   * Clear the dismissible notices.
   *
   * Signed out, several surfaces post one — they all end "(click to dismiss)"
   * — and a stale one from a surface the reader is not looking at is noise in
   * the picture rather than information about the mode.
   *
   * The dismiss handler is on the notice element itself, so click that and not
   * its parent. Two shapes exist: `.notice` on most surfaces and `.error` in
   * the chat pane.
   */
  const dismissNotices = async () => {
    const notices = page.locator(".notice, .error").filter({ hasText: "(click to dismiss)" });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const count = await notices.count();
      if (count === 0) return;
      for (let index = count - 1; index >= 0; index -= 1) {
        await notices
          .nth(index)
          .click({ timeout: 1_000 })
          .catch(() => undefined);
      }
      await page.waitForTimeout(300);
    }
  };

  /**
   * Hide anything showing the sandbox path.
   *
   * The Project pane prints the project root, and the sandbox lives under
   * `os.tmpdir()`, which on Windows is inside the user profile — so the path
   * carries the account name of whoever ran this. It is hidden rather than
   * rewritten: a made-up path in a screenshot is worse than no path.
   */
  const hidePaths = async () => {
    for (const base of [home, profile]) {
      const showing = page.locator(`text=${base}`);
      for (let index = (await showing.count()) - 1; index >= 0; index -= 1) {
        await showing
          .nth(index)
          .evaluate((element) => {
            element.style.visibility = "hidden";
          })
          .catch(() => undefined);
      }
    }
  };

  for (const { label, subMode, file } of modes) {
    console.log(`${label}: closing tabs`);
    await closeTabs();
    console.log(`${label}: entering ${subMode}`);
    await goTo(page, label, subMode);

    // Open the sample conversation. Chat and Co-create are both pictures of an
    // empty pane without it: the thread has no messages and the Office preview
    // has no document, because the document belongs to this conversation.
    //
    // The mode is chosen three times around this, and each one is needed. Only
    // Chat and Co-create carry the History control, so the mode has to be
    // entered before the list can be opened. Opening a conversation then
    // restores the mode it was recorded in — Co-create → Office for this one —
    // so the mode has to be chosen again afterwards or the Chat shot lands on
    // Office. And choosing a mode goes to its home screen, which is why the
    // sub-mode is re-entered with it.
    //
    // The flyout is closed again before the shot. It overlays the work at 300px
    // and stays up until it is dismissed, so a screenshot taken with it open is
    // a picture of the conversation list rather than of the mode.
    if (label === "Chat" || label === "Co-create") {
      const flyout = await openHistory(page);
      const row = flyout.getByRole("button", { name: SAMPLE_CONVERSATION });
      if ((await row.count()) > 0) {
        console.log(`${label}: opening the sample conversation`);
        await row.first().click();
        await closeHistory(page);
        await goTo(page, label, subMode);
        await page.waitForTimeout(3_000);
      } else {
        await closeHistory(page);
        console.warn(`no "${SAMPLE_CONVERSATION}" conversation — ${file} will be empty`);
      }
    }

    // The Connectome map is empty until the comparison is run, and running it
    // is a button press. It is renderer-local — no model, no network — so it
    // works in the harness like everything else on this surface.
    if (subMode === "My IQ") {
      const compare = page
        .locator(".pane.canvas")
        .getByRole("button", { name: "Analyse", exact: true });
      if ((await compare.count()) > 0) {
        await compare.first().click();
        await page.waitForTimeout(4_000);
      }
    }

    // The detail column beside the chart is empty until a function is picked.
    // Every shared IQ is fixture data, so this needs nothing but the sample set
    // the script has already loaded.
    if (label === "Connectome IQ") {
      const specialist = page.locator(".iq-org-specialist-open").first();
      if ((await specialist.count()) > 0) {
        await specialist.click();
        await page.waitForTimeout(1_000);
      }
    }

    console.log(`${label}: dismissing notices`);
    await dismissNotices();
    await hidePaths();
    // Park the pointer somewhere inert: it starts at the top-left corner, which
    // is over the rail, and a hovered rail item photographs as a selected one.
    await page.mouse.move(1_200, 960);
    // The rail paints before the canvas settles; a fixed pause is cruder than a
    // wait on a selector but works for every mode without four special cases.
    await page.waitForTimeout(1_500);
    const to = path.join(OUT, file);
    await page.screenshot({ path: to });
    console.log(`wrote ${path.relative(ROOT, to)}`);
  }

  // IQ Cell is a group of submodules, not one screen. My IQ is already shown
  // separately, so this card grid captures the four remaining feature views.
  // A filtered run skips it: the grid is only whole when every submodule in it
  // was shot in the same pass.
  const iqCellShots = [];
  for (const subMode of only.length === 0 ? IQ_CELL_MODULES : []) {
    await closeTabs();
    await goTo(page, "IQ Cell", subMode);
    if (subMode === "My IQ") {
      const compare = page
        .locator(".pane.canvas")
        .getByRole("button", { name: "Analyse", exact: true });
      if ((await compare.count()) > 0) {
        await compare.first().click();
        await page.waitForTimeout(4_000);
      }
    }
    if (subMode === "IQ Workflow") {
      await page
        .getByLabel("Open a sample diagram")
        .selectOption("pull-request-review");
      await page.waitForTimeout(1_000);
    }
    if (subMode === "IQ Knowledge") {
      await page
        .locator(".pane.canvas")
        .getByRole("button", { name: /^Build the index/ })
        .first()
        .click();
      await page.locator(".knowledge-main .graph-card").waitFor({ timeout: 90_000 });
      // Sigma creates its WebGL layers after the graph card mounts.
      await page.locator(".knowledge-main .graph-frame canvas").first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(1_000);
    }
    await dismissNotices();
    await hidePaths();
    await page.mouse.move(1_200, 960);
    await page.waitForTimeout(1_500);
    iqCellShots.push({ label: subMode, png: await page.screenshot() });
  }

  if (iqCellShots.length > 0) {
    const montage = await chromium.launch({ channel: "msedge" });
    try {
      const montagePage = await montage.newPage({ viewport: { width: 1_320, height: 900 } });
      const cards = iqCellShots
        .map(
          ({ label, png }) => `
          <figure>
            <figcaption>${label}</figcaption>
            <img src="data:image/png;base64,${png.toString("base64")}" alt="${label}">
          </figure>`,
        )
        .join("");
      await montagePage.setContent(`
      <style>
        * { box-sizing: border-box; }
        body { margin: 0; padding: 24px; background: #f5f7fa; color: #17202a; font-family: Arial, sans-serif; }
        main { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
        figure { margin: 0; overflow: hidden; border: 1px solid #d4dbe4; border-radius: 10px; background: white; }
        figcaption { padding: 12px 16px; font-size: 18px; font-weight: 700; }
        img { display: block; width: 100%; height: auto; border-top: 1px solid #d4dbe4; }
      </style>
      <main>${cards}</main>`);
      const to = path.join(OUT, "mode-iq-cell-modules.png");
      await montagePage.screenshot({ path: to, fullPage: true });
      console.log(`wrote ${path.relative(ROOT, to)}`);
    } finally {
      await montage.close();
    }
  }
} finally {
  await app.close().catch(() => undefined);
  rmSync(profile, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
