/**
 * IQ Cell — a 60-second demonstration, driven.
 *
 * What this is for
 * ----------------
 * IQ Cell is hard to show by describing it, because the thing worth seeing is
 * not any one surface — it is that the same body of work is legible from five
 * different angles, and that every claim on screen can be traced back to
 * something the user can check. A slide deck cannot show that. A live click-
 * through can, but only if it hits the same beats every time and finishes
 * before an audience loses the thread.
 *
 * So: a fixed script, a caption bar that says what each beat is *for* rather
 * than what is being clicked, and a hard time budget. Every caption answers
 * "what decision does this make better", because that is the question a viewer
 * is actually asking.
 *
 * Two rules it will not break
 * ---------------------------
 * 1. **It never authenticates.** Sign-in is handed to the person watching:
 *    the app opens, the script waits, and the demo starts by itself once the
 *    window is past the gate. No token, no credential, no secret is read,
 *    written or passed by this file. That is not a limitation, it is the
 *    point — a demo that logs itself in teaches a habit nobody should have.
 *
 * 2. **It purges exactly what it loaded.** It records which sample modules
 *    were already loaded before it started and clears only the ones it turned
 *    on, in a `finally`, so a crash mid-demo still tidies up. It never clears a
 *    module the viewer already had, and it restores the "Show sample data"
 *    switch to whatever it found.
 *
 * Running it
 * ----------
 *     cd iq-compiler
 *     pnpm build                      # once; the demo drives the built app
 *     node sample-data/demo-automation/demo.mjs
 *     node sample-data/demo-automation/demo.mjs --record   # writes a .webm
 *     node sample-data/demo-automation/demo.mjs --with-knowledge
 *
 * `--with-knowledge` is off by default on purpose. Loading the sample vault
 * *reassigns* the knowledge vault directory, and clearing it afterwards leaves
 * the vault unset rather than back on whatever the viewer had chosen. Every
 * other module is additive and reversible; that one is not, so it is opted
 * into rather than out of.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `iq-compiler/` — three levels up from `sample-data/demo-automation/`. */
const ROOT = path.resolve(HERE, "..", "..");

const RECORD = process.argv.includes("--record");
const WITH_KNOWLEDGE = process.argv.includes("--with-knowledge");

/** The whole demo, in seconds. Beats are checked against this before it runs. */
const BUDGET_SECONDS = 60;

/**
 * How long to wait for a person to sign in.
 *
 * Generous, because this is the one step the script does not control and
 * rushing it would mean the demo fails for the most ordinary reason there is.
 */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** Sample modules the demo needs. Knowledge is conditional; see the header. */
const REQUIRED_MODULES = ["IQ Memories", "IQ Cell library", "Delegated plans"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeName = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const startsWith = (name) => new RegExp(`^${escapeName(name)}`);

const log = (message) => console.log(`  ${message}`);
const step = (message) => console.log(`\n== ${message}`);

// ---------------------------------------------------------------------------
// The caption bar
// ---------------------------------------------------------------------------

/**
 * A caption bar drawn over the app.
 *
 * Injected rather than built into the product: this is narration for a
 * recording, not a feature, and a banner the app could show on its own would
 * be one more thing to explain. It carries a heading, one benefit sentence and
 * a progress bar for the whole demo, so a viewer always knows how much is left.
 */
const OVERLAY = `
(() => {
  const id = "iq-demo-overlay";
  document.getElementById(id)?.remove();
  const host = document.createElement("div");
  host.id = id;
  host.style.cssText = [
    "position:fixed", "left:0", "right:0", "bottom:0", "z-index:2147483647",
    "font:14px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif",
    "color:#f8fafc", "pointer-events:none",
    "background:linear-gradient(to top, rgba(5,7,12,0.96) 62%, rgba(5,7,12,0))",
    "padding:44px 32px 20px", "transition:opacity 320ms ease",
  ].join(";");
  host.innerHTML =
    '<div id="iq-demo-title" style="font-size:19px;font-weight:650;letter-spacing:-0.01em"></div>' +
    '<div id="iq-demo-body" style="margin-top:5px;opacity:0.85;max-width:92ch"></div>' +
    '<div style="margin-top:12px;height:3px;background:rgba(248,250,252,0.16);border-radius:2px;overflow:hidden">' +
    '<div id="iq-demo-bar" style="height:100%;width:0%;background:#38bdf8;transition:width 400ms linear"></div></div>';
  document.body.appendChild(host);
})();
`;

async function showCaption(page, title, body, percent) {
  await page
    .evaluate(
      ([heading, text, progress]) => {
        const set = (id, value) => {
          const node = document.getElementById(id);
          if (node) node.textContent = value;
        };
        set("iq-demo-title", heading);
        set("iq-demo-body", text);
        const bar = document.getElementById("iq-demo-bar");
        if (bar) bar.style.width = `${progress}%`;
      },
      [title, body, percent],
    )
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

/** The IQ Cell mode segment. Matched by text: the tab's name carries "Beta". */
async function openIqCell(page) {
  const tab = page.getByRole("tab", { name: startsWith("IQ Cell") });
  await tab.first().click();
  await page.waitForTimeout(350);
}

/**
 * Open one IQ Cell surface by name.
 *
 * Scoped to `.rail-group.nav` because the canvas tab strip carries a
 * "Close <name>" button for anything already open, and an unscoped match picks
 * whichever the DOM happens to reach first.
 */
async function openSurface(page, name) {
  const row = page.locator(".rail-group.nav button").filter({ hasText: name });
  await row.first().click({ timeout: 10_000 });
  await page.waitForTimeout(400);
}

async function openControlCentre(page, subSurface) {
  await page.locator(".rail-group.bottom button").filter({ hasText: "Control Center" }).first().click();
  await page.waitForTimeout(400);
  if (subSurface) await openSurface(page, subSurface);
}

// ---------------------------------------------------------------------------
// Sample data: load what is missing, remember what to put back
// ---------------------------------------------------------------------------

/** Read every module card in Control Center → Sample data. */
async function readModules(page) {
  return page.$$eval(".pane-body .card", (cards) =>
    cards
      .map((card) => {
        const name = card.querySelector("strong")?.textContent?.trim() ?? "";
        const pill = card.querySelector(".pill")?.textContent?.trim() ?? "";
        return { name, loaded: pill === "loaded" };
      })
      .filter((row) => row.name !== ""),
  );
}

async function setModule(page, name, action) {
  const card = page.locator(".pane-body .card").filter({ hasText: name });
  const button = card.getByRole("button", { name: action, exact: true });
  if ((await button.count()) === 0) return false;
  if (await button.first().isDisabled()) return false;
  await button.first().click();
  await page.waitForTimeout(900);
  return true;
}

/**
 * Turn on what the demo needs, and hand back the undo.
 *
 * The returned list is exactly what this run switched on — never what was
 * already there. That distinction is the whole safety property: a viewer who
 * keeps the sample memories loaded between demos must still have them
 * afterwards.
 */
async function loadSamples(page) {
  await openControlCentre(page, "Sample data");

  // The pane renders before `samples:status` comes back, so it paints once
  // with the switch off and the modules absent. Reading either of those in
  // that window makes the demo turn a switch the viewer already had on.
  await page
    .locator(".pane-body .card")
    .nth(1)
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => undefined);
  await page.waitForTimeout(600);

  const toggle = page.locator(".tool-grant input[type=checkbox]").first();
  const wasEnabled = await toggle.isChecked().catch(() => true);
  if (!wasEnabled) {
    await toggle.check().catch(() => undefined);
    await page.waitForTimeout(700);
  }

  const wanted = WITH_KNOWLEDGE ? [...REQUIRED_MODULES, "IQ Knowledge"] : REQUIRED_MODULES;
  const before = await readModules(page);
  const loadedByUs = [];

  for (const name of wanted) {
    const module = before.find((row) => row.name.startsWith(name));
    if (!module) {
      log(`sample module "${name}" is not offered by this build; skipping`);
      continue;
    }
    if (module.loaded) {
      log(`"${module.name}" was already loaded — leaving it alone`);
      continue;
    }
    if (await setModule(page, module.name, "Load")) {
      loadedByUs.push(module.name);
      log(`loaded "${module.name}"`);
    }
  }

  if (!WITH_KNOWLEDGE) {
    log("knowledge samples skipped (pass --with-knowledge; it reassigns the vault directory)");
  }

  return { loadedByUs, wasEnabled };
}

async function purge(page, undo) {
  if (!undo) return;
  step("Purging");
  try {
    await openControlCentre(page, "Sample data");
    for (const name of undo.loadedByUs) {
      if (await setModule(page, name, "Clear")) log(`cleared "${name}"`);
      else log(`could not clear "${name}" — clear it from Control Center → Sample data`);
    }
    if (!undo.wasEnabled) {
      const toggle = page.locator(".tool-grant input[type=checkbox]").first();
      if (await toggle.isChecked().catch(() => false)) {
        await toggle.uncheck().catch(() => undefined);
        log("restored the Show sample data switch");
      }
    }
    if (undo.loadedByUs.length === 0) log("nothing to purge — the demo loaded nothing new");
  } catch (problem) {
    console.error(`  purge failed: ${problem.message}`);
    console.error("  Clear it by hand: Control Center → Sample data → Clear");
  }
}

// ---------------------------------------------------------------------------
// The beats
// ---------------------------------------------------------------------------

/**
 * Every beat states a benefit, not a feature.
 *
 * "Compiled from your own notes" is a feature. "An answer you can check
 * without trusting the model" is the reason anyone would choose this over a
 * chat window that sounds equally confident and cites nothing.
 */
const BEATS = [
  {
    seconds: 4,
    title: "IQ Cell",
    body: "Five views of one body of work — every one of them traceable back to something you can open.",
    async run(page) {
      await openIqCell(page);
    },
  },
  {
    seconds: 6,
    title: "Grounded before it is asked",
    body: "Domain primers ship with the app, so a run starts knowing the field it is working in instead of inferring it from the question.",
    async run(page) {
      await openSurface(page, "IQ Industry");
      await page.mouse.wheel(0, 320);
    },
  },
  {
    seconds: 11,
    title: "You see the sources before anything reads them",
    body: "Compile lists every file it is about to read, then builds the graph from the links between the notes it writes. The corpus is checkable before the claim is made — not after.",
    async run(page) {
      await openSurface(page, "IQ Knowledge");
      const compile = page.locator("button.primary").filter({ hasText: /Compile/ });
      if ((await compile.count()) > 0 && !(await compile.first().isDisabled())) {
        await compile.first().click();
        await page.waitForTimeout(6_500);
      }
    },
  },
  {
    seconds: 8,
    title: "Conventions are reviewed, never absorbed",
    body: "What the agent learns about how you work is a proposal with a source and a type. A one-off observation is marked as one, so it never quietly becomes a standing rule.",
    async run(page) {
      await openSurface(page, "IQ Memories");
      await page.mouse.wheel(0, 260);
    },
  },
  {
    seconds: 6,
    title: "The procedure is an artifact",
    body: "A workflow is a document you can read, version and hand to someone else — not a prompt that lives in one person's history.",
    async run(page) {
      await openSurface(page, "IQ Workflow");
    },
  },
  {
    seconds: 17,
    title: "The decision you cannot make from one answer",
    body: "My IQ draws every cell and every coupling and replays them in the order the work happened — so you can see what is load-bearing, what has gone quiet, and what two teams are duplicating.",
    async run(page) {
      await openSurface(page, "My IQ");
      const run = page.locator("button.primary").filter({ hasText: "Analyse" });
      if ((await run.count()) > 0 && !(await run.first().isDisabled())) {
        await run.first().click();
        // The map assembles itself on completion; that reveal is the beat.
        await page.waitForTimeout(13_000);
      }
    },
  },
  {
    seconds: 6,
    title: "Everything compiled, and where it came from",
    body: "One library across all five origins, and each row opens the surface that made it — so a result is never a dead end.",
    async run(page) {
      await openSurface(page, "IQ Cell library");
    },
  },
  {
    seconds: 2,
    title: "Checkable by construction",
    body: "Every figure on these surfaces was computed from declared inputs and can be opened, re-run and disagreed with.",
    async run() {},
  },
];

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function checkBudget() {
  const total = BEATS.reduce((sum, beat) => sum + beat.seconds, 0);
  if (total > BUDGET_SECONDS) {
    throw new Error(
      `The beats add up to ${total}s, over the ${BUDGET_SECONDS}s budget. ` +
        "Shorten one rather than letting the demo run long — the budget is the feature.",
    );
  }
  return total;
}

/**
 * Wait for the window to be past the sign-in gate.
 *
 * The rail only exists once the app is in. Polling for it is how the handoff
 * works: nothing here knows or wants to know how the person got in.
 */
async function waitForSignIn(page) {
  step("Waiting for you to sign in");
  log("Sign in in the app window. The demo starts on its own the moment you are through.");
  await page.locator(".rail-group.nav").first().waitFor({ state: "visible", timeout: SIGN_IN_TIMEOUT_MS });
  log("signed in");
  await page.waitForTimeout(800);
}

async function main() {
  const total = checkBudget();

  const videoDir = path.join(HERE, "recordings");
  if (RECORD) mkdirSync(videoDir, { recursive: true });

  step(`IQ Cell demo — ${total}s of beats${RECORD ? ", recording" : ""}`);

  const app = await electron.launch({
    args: [path.join(ROOT, "apps", "main")],
    cwd: ROOT,
    // No IQ_E2E, no IQ_HOME override, no token: the demo runs against the real
    // app exactly as the viewer's own install would, and signs in as nobody.
    ...(RECORD ? { recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } } } : {}),
  });

  const page = await app.firstWindow();
  page.on("pageerror", (error) => console.error(`  renderer error: ${error.message}`));
  await page.waitForLoadState("domcontentloaded");

  let undo = null;
  try {
    await waitForSignIn(page);

    undo = await loadSamples(page);

    await page.evaluate(OVERLAY);
    let elapsed = 0;
    for (const beat of BEATS) {
      step(`${beat.title} (${beat.seconds}s)`);
      await showCaption(page, beat.title, beat.body, Math.round((elapsed / total) * 100));
      const started = Date.now();
      await beat.run(page);
      // Beats hold for their stated time whatever the app did, so the demo is
      // the same length every run. A beat that overruns is reported rather than
      // silently stretching the demo past its budget.
      const remaining = beat.seconds * 1000 - (Date.now() - started);
      if (remaining > 0) await sleep(remaining);
      else log(`over by ${Math.round(-remaining / 1000)}s`);
      elapsed += beat.seconds;
      await showCaption(page, beat.title, beat.body, Math.round((elapsed / total) * 100));
    }
  } finally {
    // Purge before the overlay comes down, so a viewer can see it happen.
    await purge(page, undo);
    await page
      .evaluate(() => document.getElementById("iq-demo-overlay")?.remove())
      .catch(() => undefined);
    if (RECORD) log(`recording written to ${videoDir}`);
    await app.close().catch(() => undefined);
  }

  step("Done");
}

main().catch((problem) => {
  console.error(`\nDemo failed: ${problem.message}`);
  process.exitCode = 1;
});
