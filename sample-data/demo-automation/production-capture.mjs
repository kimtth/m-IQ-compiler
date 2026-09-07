import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const scene = process.argv.find((arg) => arg.startsWith("--scene="))?.split("=")[1] ?? "home";
const skipSeed = process.argv.includes("--skip-seed");
const OUT = path.join(HERE, "production-recordings", scene);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** How many demo conversations a finished load leaves in the rail. `DEMO_COUNT` in `demos.ts`. */
const DEMO_COUNT = 7;
const startsWith = (name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

async function waitForSignIn(page) {
  const rail = page.locator(".rail-group.nav").first();
  const gate = page.locator(".signin-card");
  const cont = gate.locator("button", { hasText: "Continue" }).last();
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    if (await rail.isVisible().catch(() => false)) {
      await sleep(900);
      return;
    }
    if ((await gate.count().catch(() => 0)) > 0 && (await cont.isEnabled().catch(() => false))) {
      await cont.click().catch(() => undefined);
    }
    await sleep(800);
  }
  throw new Error("Sign-in gate did not complete");
}

async function chooseMode(page, name) {
  const tab = page.getByRole("tab", { name: startsWith(name) }).first();
  await tab.click({ timeout: 15_000 });
  await sleep(650);
}

async function openRail(page, name) {
  const button = page.locator(".rail-group.nav button").filter({ hasText: name }).first();
  await button.click({ timeout: 15_000 });
  await sleep(750);
}

async function goTo(page, mode, destination) {
  await chooseMode(page, mode);
  if (destination) await openRail(page, destination);
}

async function ensureSamples(page) {
  const control = page.locator(".rail-group.bottom button").filter({ hasText: "Control Center" }).first();
  await control.click();
  await sleep(500);
  await openRail(page, "Sample data");
  const toggle = page.locator(".tool-grant input[type=checkbox]").first();
  if (!(await toggle.isChecked().catch(() => false))) await toggle.check();
  await sleep(500);
  for (const card of await page.locator(".pane-body .card").all()) {
    const load = card.getByRole("button", { name: "Load", exact: true });
    if ((await load.count()) > 0 && !(await load.isDisabled())) {
      await load.click();
      await sleep(500);
    }
  }

  /*
   * Rewrite the feature demos even when they are already loaded.
   *
   * The loop above only presses an enabled `Load`, so a module that loaded on
   * some earlier run is left exactly as it was — and the demo conversations
   * are the one module where that is wrong. They are the script of the film.
   * When their text or their place changes in `demos.ts`, the camera has to
   * see the new version, not whatever a previous run happened to leave on
   * disk. Skipping this cost one whole take: the Data agent thread kept a
   * stale `work` place from an older build and opened on Conversation.
   *
   * `Clear` then `Load`, because the session log is append-only: a correction
   * can only be made by deleting the file and writing it again, which is what
   * the module's own loader does.
   */
  const demos = page.locator(".pane-body .card").filter({ hasText: "Feature demos" }).first();
  if ((await demos.count()) > 0) {
    /*
     * Enabled is the only reliable "ready" signal on this surface.
     *
     * Every button on the card is disabled while any module is working, and
     * the loop above leaves a knowledge reindex running for about ten seconds.
     * Reading `isDisabled` the moment we arrive therefore says "not loaded"
     * about a module that is merely busy — which is how a run got as far as
     * deleting the council and research records and then did nothing else.
     */
    /*
     * Wait for the surface to go idle, then read which button is live.
     *
     * The Sample data pane disables every button on every card while any one
     * module is working — a single `busy` flag, not one per card. The loop
     * above starts a knowledge reindex that runs for well over a minute, so
     * asking "is Clear disabled?" straight afterwards answers "the surface is
     * busy", which reads identically to "this module is not loaded". A run
     * that believed that got as far as deleting the council and research
     * records and then wrote nothing back.
     *
     * Exactly one of the two is enabled once nothing is working: Load when the
     * module is not loaded, Clear when it is. So the first one to come alive
     * is both the idle signal and the state.
     */
    const clear = demos.getByRole("button", { name: "Clear", exact: true });
    const load = demos.getByRole("button", { name: "Load", exact: true });
    const live = await untilIdle(clear, load);
    if (live === null) {
      // Say so here rather than letting the scene fail two minutes later on a
      // record that was never seeded.
      throw new Error(`Feature demos never became loadable.\n  card: ${await demos.innerText()}`);
    }
    if (live === "clear") {
      await clear.click();
      /*
       * Clearing must leave the module unloaded, which is Load coming alive.
       * When Load never does, the clear threw: `act()` catches it, drops it
       * into the app's error surface and re-enables the same button, so the
       * only way to notice from out here is that the state did not change.
       */
      if (!(await untilEnabled(load))) {
        await showSampleData(page);
        await page.screenshot({ path: path.join(OUT, "diagnostic.png") });
        throw new Error(
          `Clearing the feature demos did not unload them.\n` +
            `  pane: ${await samplesPane(page).innerText()}\n` +
            `  screenshot: ${path.join(OUT, "diagnostic.png")}`,
        );
      }
    }
    await load.click();
    // Clear comes back only once the module is loaded again, so this waits out
    // the whole write: six session logs, five records, an image and a deck.
    await untilEnabled(clear);
    await sleep(600);

    /*
     * Read the outcome off the card, not off the message.
     *
     * `act()` catches whatever the loader throws, shows it in the app's error
     * surface and re-enables the button, so a failed load is indistinguishable
     * from a finished one by button state alone. Without this the run carried
     * on filming a surface whose records had been deleted and never rewritten.
     *
     * The card's own summary is used rather than the "Loaded 6 …" reply,
     * because that reply is transient pane state: seeding the deck opens the
     * Office tab, and coming back to Sample data re-mounts the pane with the
     * message gone. The summary is recomputed from the session logs on disk, so
     * it says what was actually written rather than what was announced — which
     * is the stronger check anyway.
     */
    await showSampleData(page);
    const text = await samplesPane(page).innerText();
    if (!text.includes(`${DEMO_COUNT} of ${DEMO_COUNT} demo conversations`)) {
      await page.screenshot({ path: path.join(OUT, "diagnostic.png") });
      throw new Error(
        `Loading the feature demos did not report success.\n` +
          `  pane: ${text}\n` +
          `  screenshot: ${path.join(OUT, "diagnostic.png")}`,
      );
    }
  }
}

/**
 * Bring the Sample data pane back to the front.
 *
 * The canvas renders only the tab that is selected, and loading the demos
 * writes an Office document — which the app answers by opening Office and
 * making it current. So by the time there is an outcome to read, the pane that
 * owns the buttons is no longer the pane on screen. Reading the first
 * `.pane-body` at that moment returns the deck preview, and the run failed
 * reporting that a load which had in fact just succeeded had not.
 *
 * Silent when the tab is absent: the caller is about to read the pane and will
 * say something far more useful about why it could not.
 */
async function showSampleData(page) {
  const tab = page.locator(".canvas-tab").filter({ hasText: "Sample data" }).first();
  if ((await tab.count()) === 0) return;
  await tab.click();
  await sleep(300);
}

/** The pane that owns the sample modules, whatever else is open beside it. */
function samplesPane(page) {
  return page.locator(".pane-body").filter({ hasText: "Feature demos" }).first();
}

/**
 * Wait until one of the two buttons is clickable, and say which.
 *
 * Null when neither ever is, which means something is still working after the
 * timeout rather than that the module is in some third state.
 */
async function untilIdle(clear, load, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await clear.isDisabled().catch(() => true))) return "clear";
    if (!(await load.isDisabled().catch(() => true))) return "load";
    await sleep(500);
  }
  return null;
}

/**
 * Wait for one specific button to be enabled, and to stay that way.
 *
 * Two consecutive reads because the pane clears its `busy` flag and refreshes
 * its module list in separate renders: for one frame after a clear, the module
 * still says "loaded" and Clear is live again. Sampling once caught that frame
 * and concluded the clear had failed.
 */
async function untilEnabled(button, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let steady = 0;
  while (Date.now() < deadline) {
    steady = (await button.isDisabled().catch(() => true)) ? 0 : steady + 1;
    if (steady >= 2) return true;
    await sleep(500);
  }
  return false;
}

async function goHome(page) {
  await chooseMode(page, "Chat");
  await page.getByRole("button", { name: "Home", exact: true }).first().click();
  await sleep(900);
}

async function ensureConversation(page) {
  await goTo(page, "Chat", "Conversation");
  let composer = page.locator(".pane.chat .composer textarea");
  if ((await composer.count()) === 0) {
    await page.getByRole("button", { name: "New conversation" }).first().click();
    await sleep(900);
    composer = page.locator(".pane.chat .composer textarea");
  }
  return composer.first();
}

async function turnRunning(page) {
  if ((await page.locator(".pane.chat .pane-header .pill").filter({ hasText: /Working/ }).count()) > 0) return true;
  const box = page.locator(".pane.chat .composer textarea").first();
  return (await box.count()) > 0 && (await box.isDisabled().catch(() => false));
}

async function runPrompt(page, text, timeoutMs = 5 * 60_000) {
  const composer = await ensureConversation(page);
  const approvals = page.locator(".pane.chat .card.approval");
  const mode = page.getByRole("combobox", { name: "Approvals" });
  if ((await mode.count()) > 0) await mode.selectOption("auto_safe");
  await composer.fill("");
  await composer.type(text, { delay: 8 });
  await sleep(500);
  await composer.press("Enter");
  const deadline = Date.now() + timeoutMs;
  let started = false;
  let idleSince = 0;
  while (Date.now() < deadline) {
    const cards = await approvals.count().catch(() => 0);
    if (cards > 0) {
      started = true;
      idleSince = 0;
      await sleep(1000);
      const allow = approvals.first().getByRole("button", { name: /^Allow(?: all \d+)?$/ }).first();
      if ((await allow.count()) > 0) await allow.click();
      await sleep(700);
      continue;
    }
    const running = await turnRunning(page);
    if (running) {
      started = true;
      idleSince = 0;
    } else if (started) {
      if (idleSince === 0) idleSince = Date.now();
      if (Date.now() - idleSince > 2500) return;
    }
    await sleep(500);
  }
  throw new Error(`Prompt did not finish: ${text}`);
}

async function home(page) {
  await goHome(page);
  await sleep(2500);
  for (const mode of ["Co-create", "IQ Cell", "Connectome IQ", "Chat"]) {
    await chooseMode(page, mode);
    await sleep(800);
  }
  await goHome(page);
  await sleep(2500);
}

async function browserOffice(page) {
  await chooseMode(page, "Co-create");
  await openRail(page, "Browser");
  const address = page.getByPlaceholder("https://…");
  await address.fill("https://learn.microsoft.com/en-us/azure/well-architected/pillars");
  await sleep(700);
  await page.getByRole("button", { name: "Go", exact: true }).click();
  const browserFrame = page.locator('img[alt^="Page:"]');
  await browserFrame.waitFor({ state: "visible", timeout: 60_000 });
  await sleep(1800);
  await browserFrame.hover();
  await page.mouse.wheel(0, 520);
  await sleep(1400);
  await page.mouse.wheel(0, -240);
  await sleep(1200);

  // The Browser page and the conversation must describe the same work. The
  // old capture left whichever conversation happened to be selected beside
  // this page, so the two halves contradicted each other.
  await page.locator('.rail-item[aria-label="History"]').first().click({ timeout: 15_000 });
  await sleep(900);
  const browserConversation = page
    .locator(".conversation-list .rail-item")
    .filter({ hasText: "Browser · Azure Well-Architected pillars" })
    .first();
  await browserConversation.click({ timeout: 20_000 });
  await sleep(1400);
  await page.locator('.rail-item[aria-label="History"]').first().click();
  await sleep(1200);
  await page.locator(".history-flyout").waitFor({ state: "hidden", timeout: 15_000 });
  await page.locator(".pane.chat .messages .msg.from-user")
    .filter({ hasText: "Open the Microsoft Azure Well-Architected Framework pillars page" })
    .first()
    .waitFor({ state: "visible", timeout: 20_000 });
  await page.locator('img[alt^="Page:"]').waitFor({ state: "visible", timeout: 20_000 });
  await page.screenshot({ path: path.join(OUT, "browser-fullscreen.png") });

  await goTo(page, "Co-create", "Office");
  // Changing the surface does not change the active conversation. Select the
  // Office thread explicitly or the Browser request remains beside the deck.
  await page.locator('.rail-item[aria-label="History"]').first().click({ timeout: 15_000 });
  await sleep(900);
  await page
    .locator(".conversation-list .rail-item")
    .filter({ hasText: "Office · Checkout API 26.2 release review" })
    .first()
    .click({ timeout: 20_000 });
  await sleep(1400);
  await page.locator('.rail-item[aria-label="History"]').first().click();
  await sleep(1000);
  await page.getByText("Content preview", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  await page.locator(".preview-stage").waitFor({ state: "visible", timeout: 60_000 });
  await sleep(2200);
  const slideButtons = page.locator(".slide-index-item");
  if ((await slideButtons.count()) > 1) {
    await slideButtons.nth(1).click().catch(() => undefined);
    await sleep(1300);
    await slideButtons.nth(2).click().catch(() => undefined);
    await sleep(1300);
    await slideButtons.nth(3).click().catch(() => undefined);
    await sleep(1300);
  }
}

async function fabric(page) {
  await goTo(page, "Co-create", "Fabric");
  await sleep(2800);
  const build = page.getByText("Build Fabric artifacts", { exact: true });
  if ((await build.count()) > 0) {
    await build.scrollIntoViewIfNeeded();
    await sleep(1200);
  }
}

async function skillMemory(page) {
  await goTo(page, "Co-create", "Skill Recording");
  const start = page.getByRole("button", { name: "Start recording" });
  if ((await start.count()) > 0 && (await start.isEnabled())) {
    await start.click();
    await sleep(2000);
    await goTo(page, "Co-create", "Browser");
    await page.mouse.wheel(0, 360).catch(() => undefined);
    await sleep(1800);
    await goTo(page, "Co-create", "Skill Recording");
    const mark = page.getByPlaceholder("Note what just happened…");
    if ((await mark.count()) > 0) {
      await mark.fill("Reviewed the browser evidence");
      await mark.press("Enter");
    }
    await sleep(900);
    await page.getByRole("button", { name: "Stop recording" }).click();
    await sleep(2200);
  }

  const reviewed = page.getByLabel(/I have reviewed what was captured/);
  if ((await reviewed.count()) > 0) {
    await reviewed.check();
    await sleep(700);
    await page.getByRole("button", { name: "Analyse", exact: true }).click();
    const reconstructionReady = await page.locator("textarea").first()
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (reconstructionReady) {
      await sleep(1200);
      const intent = page.locator("textarea").first();
      const value = await intent.inputValue();
      await intent.fill(`${value} and retain the evidence trail.`);
      await intent.blur();
      await sleep(900);
      await page.getByRole("button", { name: /Approve$/ }).click();
      await sleep(1300);
      await page.getByRole("button", { name: "Propose a plan" }).click();
      await page.getByRole("button", { name: "Build it" }).waitFor({ state: "visible", timeout: 5 * 60_000 });
      await sleep(1000);
      await page.getByRole("button", { name: "Build it" }).click();
      await page.getByText(/^Built$/).waitFor({ state: "visible", timeout: 5 * 60_000 });
      await sleep(1800);
    }
    const control = page.locator(".rail-group.bottom button").filter({ hasText: "Control Center" }).first();
    await control.click();
    await openRail(page, "Skills");
    await sleep(1800);
  }

  await goTo(page, "IQ Cell", "IQ Memories");
  const pending = page.locator(".card.approval").filter({ hasText: "Awaiting your review" });
  if ((await pending.count()) > 0) {
    const subject = (await pending.locator("strong").nth(1).textContent().catch(() => ""))?.trim() ?? "";
    await pending.getByRole("button", { name: "Approve", exact: true }).first().click();
    await sleep(1300);
    if (subject) {
      const settled = page.locator(".card").filter({ hasText: subject }).last();
      await settled.getByRole("button", { name: "Edit", exact: true }).click().catch(() => undefined);
      const fact = settled.locator("textarea").first();
      if ((await fact.count()) > 0) {
        await fact.fill(`${await fact.inputValue()} Review before reuse.`);
        await settled.getByRole("button", { name: "Save", exact: true }).click();
        await sleep(1600);
      }
    }
  }
}

async function knowledgeMyIq(page) {
  await goTo(page, "IQ Cell", "IQ Knowledge");
  const build = page.getByRole("button", { name: /Build the index/ }).first();
  if ((await build.count()) > 0 && (await build.isEnabled())) {
    await build.click();
    await page.getByText(/notes · \d+ tags · \d+ links/).waitFor({ state: "visible", timeout: 3 * 60_000 }).catch(() => undefined);
    await sleep(2500);
  }
  const graph = page.locator(".knowledge-main");
  if ((await graph.count()) > 0) {
    await graph.click({ position: { x: 520, y: 330 } }).catch(() => undefined);
    await sleep(1300);
  }

  await goTo(page, "IQ Cell", "My IQ");
  await page.getByRole("button", { name: "Instructions", exact: true }).click();
  await sleep(1600);
  await page.keyboard.press("Escape");
  await sleep(700);
  const analyse = page.getByRole("button", { name: "Analyse", exact: true });
  await analyse.click();
  await analyse.waitFor({ state: "visible", timeout: 4 * 60_000 });
  await sleep(3000);
  await page.getByRole("button", { name: "Show the report", exact: true }).click();
  await sleep(1800);
  const report = page.locator(".connectome-report");
  await report.evaluate((node) => { node.scrollTop = Math.min(node.scrollHeight, 900); });
  await sleep(1800);
  await page.getByRole("button", { name: "Ask about the map", exact: true }).click();
  await sleep(900);
  const suggestion = page.locator(".chat-suggestions .chip:not(.chip-more)").first();
  if ((await suggestion.count()) > 0) await suggestion.click();
  await sleep(1800);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await sleep(1000);
  const dialog = page.getByRole("dialog", { name: "Publish My IQ" });
  await dialog.getByRole("textbox").fill("Leadership Operating IQ");
  await sleep(800);
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByText(/is published over MCP/).waitFor({ state: "visible", timeout: 60_000 });
  await sleep(3500);
}

async function industry(page) {
  await goTo(page, "IQ Cell", "IQ Industry");
  const software = page.locator(".industry-item").filter({ hasText: "Software Industry" });
  if ((await software.count()) > 0) await software.first().click();
  await sleep(1400);
  const diagram = page.locator(".industry-page .md-mermaid").first();
  if ((await diagram.count()) > 0) {
    await diagram.evaluate((node) => node.scrollIntoView({ block: "center", behavior: "smooth" }));
    await sleep(2200);
  } else {
    const pageBody = page.locator(".industry-page");
    await pageBody.evaluate((node) => { node.scrollTop = Math.min(node.scrollHeight, 1000); });
    await sleep(1800);
  }
}

async function knowledge(page) {
  await goTo(page, "IQ Cell", "IQ Knowledge");
  await sleep(1600);
  const build = page.getByRole("button", { name: /Build the index/ }).first();
  if ((await build.count()) > 0 && (await build.isEnabled())) {
    await build.click();
    await page.getByText(/notes · \d+ tags · \d+ links/)
      .waitFor({ state: "visible", timeout: 3 * 60_000 })
      .catch(() => undefined);
    await sleep(2600);
  }
  const fit = page.getByRole("button", { name: "Fit", exact: true });
  if ((await fit.count()) > 0) await fit.click();
  await sleep(1400);
  const source = page.locator(".knowledge-file-open").first();
  if ((await source.count()) > 0) {
    await source.click();
    await sleep(2200);
  }
}

async function workflow(page) {
  await goTo(page, "IQ Cell", "IQ Workflow");
  page.once("dialog", (dialog) => void dialog.accept());
  const samples = page.getByRole("combobox", { name: "Open a sample diagram" });
  await samples.selectOption("pull-request-review");
  await sleep(2400);
  const fit = page.locator(".react-flow__controls-fitview");
  if ((await fit.count()) > 0) await fit.click();
  await sleep(1400);
  const decision = page.locator(".react-flow__node").filter({ hasText: "Approved?" }).first();
  const node = (await decision.count()) > 0 ? decision : page.locator(".react-flow__node").nth(2);
  await node.click();
  await sleep(2400);
}

async function memories(page) {
  await goTo(page, "IQ Cell", "IQ Memories");
  await sleep(1800);
  const pending = page.locator(".card.approval").filter({ hasText: "Awaiting your review" }).first();
  if ((await pending.count()) > 0) {
    await pending.scrollIntoViewIfNeeded();
    await sleep(1200);
    await pending.getByRole("button", { name: "Approve", exact: true }).click();
    await sleep(2200);
  }
  const approved = page.locator(".card").filter({ hasText: /Approved|Active/ }).first();
  if ((await approved.count()) > 0) {
    await approved.scrollIntoViewIfNeeded();
    await sleep(1600);
  }
}

async function library(page) {
  await goTo(page, "IQ Cell", "IQ Cell library");
  await sleep(1500);
  for (const label of ["IQ Industry", "IQ Knowledge", "IQ Workflow", "IQ Memories", "All"]) {
    const filter = page.getByRole("button", { name: startsWith(label) }).first();
    if ((await filter.count()) > 0) {
      await filter.click();
      await sleep(950);
    }
  }
  const open = page.locator(".iqcell-open").first();
  if ((await open.count()) > 0) {
    await open.click();
    await sleep(2200);
  }
}

async function connectome(page) {
  await chooseMode(page, "Connectome IQ");
  await sleep(1800);
  const branches = page.locator(".iq-org-branch");
  if ((await branches.count()) > 0) {
    const first = branches.nth(0);
    const expand = first.getByRole("button", { name: /AI roles in/ });
    if ((await expand.count()) > 0 && /Show/.test((await expand.getAttribute("aria-label")) ?? "")) await expand.click();
    await sleep(900);
    await first.locator(".iq-org-role").first().click().catch(() => undefined);
    await sleep(1500);
  }
  if ((await branches.count()) > 1) {
    const second = branches.nth(1);
    await second.locator(".iq-hub-connect").click();
    await sleep(900);
    await second.locator(".iq-org-expand").click();
    await sleep(800);
    await second.locator(".iq-org-role").first().click();
    await sleep(1400);
  }
  const detail = page.locator(".iq-hub-detail");
  await detail.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await sleep(1400);
  const question = page.getByLabel(/Ask .* a question/).last();
  if ((await question.count()) > 0) {
    await question.fill("What should leadership review before approving the quarterly plan?");
    await sleep(700);
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await sleep(2500);
  }
}

/**
 * Open one seeded demo conversation and film it.
 *
 * These are the feature shots. Each one is a real window: the app's own rail,
 * its own transcript, its own tool cards, rendered by the same components a
 * live turn uses. Nothing here is drawn for the camera.
 *
 * The conversations come from the `demos` sample module, which writes one
 * thread per feature. That is what makes the shot honest — the Fabric surface
 * shows the Fabric conversation, not whatever thread happened to be open when
 * the recording started.
 *
 * It films rather than screenshots because a still cannot show the tool card
 * opening, and the tool card is the claim: these are the real tool names, with
 * their real risk, and the answer came back through them.
 */
function demoScene({ mode, rail, title, proof, surfaceProof }) {
  return async (page) => {
    // Land on the feature's own surface first, so the window is already in the
    // right mode when the conversation opens.
    await goTo(page, mode, rail);
    await sleep(700);

    /*
     * Shut every canvas tab before filming.
     *
     * Loading the samples walks the window through Automations, Sample data
     * and Fabric, and each stop leaves a tab behind. The first Office take
     * proved why that matters: four stale tabs were open and the canvas was
     * still previewing a *docx* from an earlier session while the transcript
     * beside it said it had written a *pptx*. The shot has to agree with the
     * conversation in it, so the tabs go before the conversation arrives —
     * selecting it reopens exactly the one tab its place names, and no others.
     */
    const closeAll = page.getByRole("button", { name: /close all/i });
    if ((await closeAll.count()) > 0) {
      await closeAll.first().click().catch(() => undefined);
      await sleep(600);
    }

    // The conversation list is behind History, which sits in its own rail group
    // rather than the sub-mode nav. Matched on `aria-label` because its detail
    // line reads "14 conversations and runs", which a text filter for
    // "Conversation" would also hit.
    await page.locator('.rail-item[aria-label="History"]').first().click({ timeout: 15_000 });
    await sleep(900);

    const row = page
      .locator(".conversation-list .rail-item")
      .filter({ hasText: title })
      .first();
    if ((await row.count()) === 0) {
      const seen = await page.locator(".conversation-list .rail-item").allInnerTexts();
      await page.screenshot({ path: path.join(OUT, "diagnostic.png") });
      throw new Error(
        `No conversation titled "${title}" in History.\n` +
          `  conversations: ${JSON.stringify(seen)}\n` +
          `  screenshot: ${path.join(OUT, "diagnostic.png")}`,
      );
    }
    await row.click({ timeout: 20_000 });
    await sleep(1600);

    // Shut History again. It overlays half the window, and the shot is the
    // conversation, not the picker that reached it.
    const close = page.locator(".conversation-list").locator("..").getByRole("button", {
      name: /close/i,
    });
    if ((await close.count()) > 0) {
      await close.first().click().catch(() => undefined);
    } else {
      await page.locator('.rail-item[aria-label="History"]').first().click();
    }
    await sleep(1200);

    const messages = page.locator(".pane.chat .messages").first();
    await messages.waitFor({ state: "visible", timeout: 20_000 });
    const expectedTurn = messages.locator(".msg.from-user").filter({ hasText: proof }).first();
    await expectedTurn.waitFor({ state: "visible", timeout: 20_000 }).catch(async () => {
      await page.screenshot({ path: path.join(OUT, "diagnostic.png") });
      throw new Error(
        `Conversation "${title}" did not become active.\n` +
          `  expected request: ${proof}\n` +
          `  transcript: ${await messages.innerText()}\n` +
          `  screenshot: ${path.join(OUT, "diagnostic.png")}`,
      );
    });
    if (surfaceProof !== undefined) {
      await page.getByText(surfaceProof, { exact: false }).first()
        .waitFor({ state: "visible", timeout: 60_000 })
        .catch(async () => {
          await page.screenshot({ path: path.join(OUT, "diagnostic.png") });
          throw new Error(
            `Conversation "${title}" opened without its matching surface output.\n` +
              `  expected output: ${surfaceProof}\n` +
              `  screenshot: ${path.join(OUT, "diagnostic.png")}`,
          );
        });
    }
    // Let the question and the answer land before anything moves.
    await sleep(1800);

    // Open the tool card. Collapsed it is one line; the tool names, their
    // family and their status are the point of the shot.
    const head = page.locator(".pane.chat .activity-head").first();
    if ((await head.count()) > 0) {
      const open = await head.getAttribute("aria-expanded");
      if (open !== "true") await head.click();
      await sleep(2200);
    }

    // A slow, even scroll to the bottom. Stepped rather than smooth-scrolled so
    // the frame rate is ours and not the compositor's, and slow enough that a
    // viewer can read a line before it leaves.
    await messages.evaluate(async (element) => {
      const wait = (ms) => new Promise((done) => setTimeout(done, ms));
      const end = element.scrollHeight - element.clientHeight;
      if (end <= 0) return;
      const steps = 60;
      for (let i = 1; i <= steps; i += 1) {
        element.scrollTop = (end * i) / steps;
        await wait(70);
      }
    });
    await sleep(2000);
  };
}

/**
 * Film a surface that keeps its own record instead of a transcript.
 *
 * Team and Research do not render the chat pane. A council is a set of
 * contributions and a verdict; a research run is a report with its citations.
 * Each keeps its own store, and the way back into a past run is the pane's own
 * dropdown — so the run is chosen there, on camera, rather than conjured.
 *
 * Team is why the dropdown is not optional: its selection starts empty, so
 * arriving on the surface shows the roster form and no run at all. Research
 * opens on its newest, but it is picked the same way so both shots show the
 * same gesture.
 *
 * `run` is the seeded record's id — the fixed ones from `demos.ts`, so a
 * second load replaces the demo rather than stacking another copy of it.
 *
 * Everything foldable is unfolded before the scroll, because on these surfaces
 * the detail *is* the demo: the argument under each member's summary, the
 * sources under each finding. Collapsed, the shot is a list of headings.
 */
function recordScene({ mode, rail, run }) {
  return async (page) => {
    await goTo(page, mode, rail);
    await sleep(900);

    const closeAll = page.getByRole("button", { name: /close all/i });
    if ((await closeAll.count()) > 0) {
      await closeAll.first().click().catch(() => undefined);
      await sleep(600);
    }

    const pane = page.locator(".pane-body").first();
    await pane.waitFor({ state: "visible", timeout: 20_000 });
    await sleep(1200);

    const picker = pane.locator("select").first();
    await picker.waitFor({ state: "visible", timeout: 20_000 });
    // Chosen by id, not by label. The machine this is filmed on already had a
    // real research run called "sovereign cloud", so matching on the visible
    // text picked whichever of the two the DOM listed first.
    const ids = await picker.locator("option").evaluateAll((options) =>
      options.map((option) => `${option.value} :: ${option.textContent ?? ""}`),
    );
    if (!ids.some((entry) => entry.startsWith(`${run} ::`))) {
      await page.screenshot({ path: path.join(OUT, "diagnostic.png") });
      throw new Error(
        `No run with id "${run}" in the picker.\n` +
          `  options: ${JSON.stringify(ids, null, 2)}\n` +
          `  screenshot: ${path.join(OUT, "diagnostic.png")}`,
      );
    }
    await picker.selectOption(run);
    await sleep(2000);

    // `<details>` is how Research hides its evidence; Council folds each
    // member behind a chevron button that keeps its state in React. Both are
    // opened before the scroll, because on these surfaces the detail *is* the
    // demo: the argument under each member's summary, the sources under each
    // finding. Collapsed, the shot is a list of headings.
    //
    // The member cards are clicked one at a time rather than in a batch:
    // opening one moves everything below it, and a batch would race the layout.
    await page.evaluate(() => {
      for (const fold of document.querySelectorAll("details")) fold.open = true;
    });
    const folded = pane.locator(".member-card > button");
    const count = await folded.count();
    for (let i = 0; i < count; i += 1) {
      await folded.nth(i).click().catch(() => undefined);
      await sleep(120);
    }
    await sleep(2200);

    // Scroll whichever ancestor actually carries the overflow. These panes are
    // laid out differently from the chat pane, so the scroller is found rather
    // than assumed.
    await pane.evaluate(async (element) => {
      const wait = (ms) => new Promise((done) => setTimeout(done, ms));
      let scroller = element;
      while (scroller !== null && scroller.scrollHeight <= scroller.clientHeight + 4) {
        scroller = scroller.parentElement;
      }
      if (scroller === null) return;
      const end = scroller.scrollHeight - scroller.clientHeight;
      const steps = 60;
      for (let i = 1; i <= steps; i += 1) {
        scroller.scrollTop = (end * i) / steps;
        await wait(70);
      }
    });
    await sleep(2000);
  };
}

/**
 * Film a surface that takes the whole window.
 *
 * Image Creation, Skill Recording and Meeting Recordings each declare
 * `hidesPanes: ["chat"]`, so on those the chat pane is not rendered at all.
 * A seeded conversation is invisible there; what the reader sees is the
 * surface's own record. So there is nothing to select from History — the rail
 * destination is the whole navigation, and the surface shows what it holds.
 */
function surfaceScene({ mode, rail, pick, clicks = [] }) {
  return async (page) => {
    await goTo(page, mode, rail);
    await sleep(1200);

    const closeAll = page.getByRole("button", { name: /close all/i });
    if ((await closeAll.count()) > 0) {
      await closeAll.first().click().catch(() => undefined);
      await sleep(600);
    }
    await goTo(page, mode, rail);
    await sleep(1600);

    /*
     * Choose the seeded record by id when one is named.
     *
     * The surface opens on its newest, which on a machine that has used the
     * feature for real is somebody else's run. Selecting by option value rather
     * than by label is the same lesson Research taught: this machine already
     * had a run whose label was identical to the demo's.
     */
    if (pick !== undefined) {
      // Whichever `<select>` on the surface actually offers the record. These
      // panes put their picker in different places — Image Creation's sits in
      // the header, Skill Recording's is halfway down the body — and a
      // structural selector picked the wrong one or none at all.
      const picker = page.locator(`select:has(option[value="${pick}"])`).first();
      await picker.waitFor({ state: "visible", timeout: 20_000 }).catch(async () => {
        const options = await page.locator("select option").evaluateAll((all) =>
          all.map((option) => `${option.value} :: ${option.textContent ?? ""}`),
        );
        await page.screenshot({ path: path.join(OUT, "diagnostic.png") });
        throw new Error(
          `No option with value "${pick}".\n` +
            `  options: ${JSON.stringify(options, null, 2)}\n` +
            `  screenshot: ${path.join(OUT, "diagnostic.png")}`,
        );
      });
      await picker.selectOption(pick);
      await sleep(1800);
    }

    /*
     * Walk to the part of the surface worth reading.
     *
     * Skill Recording opens on Record — the consent notice — which is the right
     * first screen for a person about to capture something and the wrong one
     * for a reader being shown what the feature produces. Each entry is an
     * exact button name, so a renamed control fails loudly here instead of
     * quietly filming the wrong tab.
     */
    for (const name of clicks) {
      const button = page.getByRole("button", { name, exact: true }).first();
      await button.waitFor({ state: "visible", timeout: 20_000 });
      await button.click();
      await sleep(1600);
    }

    await page.evaluate(() => {
      for (const fold of document.querySelectorAll("details")) fold.open = true;
    });
    await sleep(2200);

    await page.evaluate(async () => {
      const wait = (ms) => new Promise((done) => setTimeout(done, ms));
      const scrollers = [...document.querySelectorAll(".pane-body, .pane .stack")].filter(
        (element) => element.scrollHeight > element.clientHeight + 4,
      );
      const scroller = scrollers[0];
      if (scroller === undefined) return;
      const end = scroller.scrollHeight - scroller.clientHeight;
      const steps = 60;
      for (let i = 1; i <= steps; i += 1) {
        scroller.scrollTop = (end * i) / steps;
        await wait(70);
      }
    });
    await sleep(2000);
  };
}

const DEMO_SCENES = {
  "demo-workiq": demoScene({
    mode: "Chat",
    rail: "Conversation",
    title: "What meetings do I have tomorrow?",
    proof: "What meetings do I have tomorrow, and who is attending?",
  }),
  "demo-research": recordScene({
    mode: "Chat",
    rail: "Research",
    run: "rsr_sample_demo_sovereign",
  }),
  "demo-council": recordScene({
    mode: "Chat",
    rail: "Team (Council)",
    run: "cnl_sample_demo_portal",
  }),
  "demo-dataagent": demoScene({
    mode: "Chat",
    rail: "Data agent",
    title: "Data Agent · customers with open issues",
    proof: "Which customers had more than two open issues last quarter?",
  }),
  "demo-office": demoScene({
    mode: "Co-create",
    rail: "Office",
    title: "Office · Checkout API 26.2 release review",
    proof: "Build a six-slide release review deck for Checkout API 26.2",
    surfaceProof: "Release readiness at a glance",
  }),
  "demo-image": surfaceScene({
    mode: "Co-create",
    rail: "Image Creation",
    pick: "thr_sample_demo_qbr",
  }),
  "demo-skill": surfaceScene({
    mode: "Co-create",
    rail: "Skill Recording",
    pick: "20260901-094200-5a3d0e17",
    clicks: ["Open", "Reconstruction"],
  }),
  "demo-meeting": demoScene({
    mode: "Co-create",
    rail: "Meeting Recordings",
    title: "Meeting · change board CHANGE-2214",
    proof: "Here is the change board recording",
  }),
};

const SCENES = {
  home,
  "browser-office": browserOffice,
  fabric,
  "skill-memory": skillMemory,
  "knowledge-myiq": knowledgeMyIq,
  industry,
  knowledge,
  workflow,
  memories,
  library,
  connectome,
  ...DEMO_SCENES,
};
if (!(scene in SCENES)) throw new Error(`Unknown scene: ${scene}`);
mkdirSync(OUT, { recursive: true });

const LAUNCH = {
  args: [path.join(ROOT, "apps", "main"), "--start-fullscreen"],
  cwd: ROOT,
};

/** Bring the window up full-screen and wait for the renderer to settle. */
async function open(app) {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setFullScreen(true);
  });
  await page.waitForTimeout(800);
  page.on("pageerror", (error) => console.error(`renderer: ${error.message}`));
  await page.waitForLoadState("domcontentloaded");
  await waitForSignIn(page);
  return page;
}

/*
 * Seed in one run, film in the next.
 *
 * Three of the demos — Team, Research and Data agent — are records in their
 * own stores rather than messages in a thread, and the renderer reads those
 * lists once, at sign-in. Loading the samples into a window that is already
 * open therefore changes the disk and nothing on the screen: the Data agent
 * pane stayed on the conversation it had open, which on this machine was a
 * test thread called "red red" holding two raw HTTP 404s.
 *
 * A restart is what a person does, and it is what makes the seeded records
 * the ones each pane opens on. No video is recorded here, so the seeding run
 * leaves no clip behind to be mistaken for footage.
 */
if (!skipSeed) {
  const seeding = await electron.launch(LAUNCH);
  try {
    await ensureSamples(await open(seeding));
  } finally {
    await sleep(700);
    await seeding.close().catch(() => undefined);
  }
  await sleep(1500);
}

const app = await electron.launch({
  ...LAUNCH,
  // Match the current Windows display. The previous fixed 1920×1280 target
  // rescaled a 1664×1109 desktop and made the app smaller again, defeating the
  // display-resolution change made specifically to keep demo text readable.
  recordVideo: { dir: OUT, size: { width: 1664, height: 1109 } },
});
try {
  const page = await open(app);
  await SCENES[scene](page);
  await page.screenshot({ path: path.join(OUT, `${scene}-fullscreen.png`) });
} finally {
  await sleep(700);
  await app.close().catch(() => undefined);
}
console.log(`Production capture complete: ${OUT}`);
