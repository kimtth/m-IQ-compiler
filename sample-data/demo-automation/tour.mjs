/**
 * IQ Compiler — the full feature tour, driven.
 *
 * A companion to `demo.mjs`. That one is a fixed 60-second IQ Cell reel; this
 * one walks the whole feature catalogue in `demo-scenario-script.md`, chapter by
 * chapter, so a recording session is one command instead of an hour of clicking
 * and re-clicking the same route.
 *
 * What it does and does not do
 * ----------------------------
 * 1. **It never authenticates.** Sign-in is the one step that is genuinely the
 *    person's — a device code, a browser, a tenant choice. No token, credential
 *    or secret is read, written or passed by this file. A demo that logs itself
 *    in teaches a habit nobody should have.
 *
 *    The one control it will press is the gate's **Continue**, and only while it
 *    is enabled — which the gate allows only once both connections are already
 *    green. That press acquires nothing and chooses nothing; it dismisses a gate
 *    whose work is done. If Continue is disabled, the tour names the missing
 *    connection and waits for the person.
 *
 * 2. **It sends the prompts and waits for the real answer.** A prompt sitting
 *    in a box is a picture of a question, not a product. Every chapter with a
 *    prompt types it, sends it, and waits for the turn to finish before the
 *    hold starts, so the shot contains the answer rather than the asking.
 *
 *    That costs real time and real tokens, and it produces a different answer
 *    every take. `--dry` types and stops, which is the version you can record
 *    forty times.
 *
 *    **It still does not answer approval cards.** When one comes up the tour
 *    says so and waits for a person to decide, up to {@link APPROVAL_WAIT_MS}.
 *    Clicking Allow on someone's behalf is the one thing this script must never
 *    learn to do.
 *
 * 3. **It purges exactly what it loaded.** It records which sample modules were
 *    already there before it started and clears only the ones it turned on, in
 *    a `finally`, so a crash mid-tour still tidies up. It restores the "Show
 *    sample data" switch to whatever it found.
 *
 * 4. **It does not delete conversations.** Chapters that need a composer create
 *    a conversation if none exists. Removing one afterwards would mean deciding
 *    which row is "ours" from a list the viewer also owns, and getting that
 *    wrong destroys real history. The tour reports what it created and leaves
 *    the deletion to a person.
 *
 * The through-line
 * ----------------
 * The chapters run in the script's order, and that order is an argument: you
 * work in Chat and Co-create, what you make there is a file, and that file is
 * the input to an IQ Cell. Captions carry it — the Co-create chapters say where
 * the file lands, and the IQ Cell chapters say what they read.
 *
 * Chapters are independent
 * ------------------------
 * Every chapter navigates from scratch, so `--only` gives you exactly that
 * chapter with nothing before it. That is how the B-roll in
 * `demo-scenario-script.md` §2 is meant to be shot: one clip per take, cut
 * together later, re-shoot the one that went wrong.
 *
 * One cut is not here: `demo-scenario-script.md` §6 chain A moves a generated
 * file into the knowledge vault's `source/` directory. That is a file-system
 * edit to the viewer's own vault, which this script does not make. Shoot it by
 * hand: `--only=research`, move the report, then `--only=knowledge`.
 *
 * Running it
 * ----------
 *     cd iq-compiler
 *     pnpm build                                    # once; the tour drives the built app
 *     node sample-data/demo-automation/tour.mjs --list
 *     node sample-data/demo-automation/tour.mjs
 *     node sample-data/demo-automation/tour.mjs --only=knowledge,memories,connectome
 *     node sample-data/demo-automation/tour.mjs --skip=fabric,dataagent --record
 *     node sample-data/demo-automation/tour.mjs --only=chat --dry   # type, send nothing
 *     node sample-data/demo-automation/tour.mjs --speed=0.5   # halve every hold
 *
 * `--with-knowledge` is off by default for the same reason as in `demo.mjs`:
 * loading the sample vault *reassigns* the knowledge vault directory, and
 * clearing it afterwards leaves the vault unset rather than back on whatever
 * the viewer had chosen. Every other module is additive and reversible; that
 * one is not, so it is opted into rather than out of.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `iq-compiler/` — two levels up from `sample-data/demo-automation/`. */
const ROOT = path.resolve(HERE, "..", "..");

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const ARGS = process.argv.slice(2);
const has = (flag) => ARGS.includes(flag);
const valueOf = (name) => {
  const hit = ARGS.find((arg) => arg.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : "";
};
const listOf = (name) =>
  valueOf(name)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const RECORD = has("--record");
/**
 * Sending is the default; `--dry` types the prompt and stops there.
 *
 * It was the other way round, and the tour recorded twenty chapters of empty
 * composers. `--send` is still accepted so old commands keep working, and now
 * means nothing, because it is what happens anyway.
 */
const SEND = !has("--dry");
const WITH_KNOWLEDGE = has("--with-knowledge");
const LIST_ONLY = has("--list");
const ONLY = listOf("--only");
const SKIP = listOf("--skip");
const SPEED = Number(valueOf("--speed") || "1") || 1;

/**
 * How long to wait for a person to sign in.
 *
 * Generous, because this is the one step the script does not control and
 * rushing it would mean the tour fails for the most ordinary reason there is.
 */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/**
 * How long one sent prompt may take before the tour gives up on it.
 *
 * Generous because a real turn is genuinely slow: a model call, tool calls, a
 * document being written. Giving up costs the chapter its answer, not the run.
 */
const TURN_TIMEOUT_MS = 4 * 60_000;

/** How long to wait for a person to answer an approval card. */
const APPROVAL_WAIT_MS = 3 * 60_000;

/** Sample modules the tour wants. Knowledge is conditional; see the header. */
const REQUIRED_MODULES = [
  "IQ Memories",
  "IQ Cell library",
  "Automations",
  "Delegated plans",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Every hold goes through here, so `--speed` is honoured in one place. */
const hold = (seconds) => sleep(Math.max(0, Math.round(seconds * 1000 * SPEED)));
const escapeName = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const startsWith = (name) => new RegExp(`^${escapeName(name)}`);

const log = (message) => console.log(`  ${message}`);
const step = (message) => console.log(`\n== ${message}`);
const note = (message) => console.log(`  · ${message}`);

// ---------------------------------------------------------------------------
// The caption bar
// ---------------------------------------------------------------------------

/**
 * A caption bar drawn over the app.
 *
 * Injected rather than built into the product: this is narration for a
 * recording, not a feature, and a banner the app could show on its own would be
 * one more thing to explain.
 *
 * Three rules it is built to, all learned from watching a take:
 *
 *  - **Cover as little of the app as possible.** The app is the subject. The
 *    bar is capped in height, the body is clamped to one line, and there is no
 *    tall gradient fading up the screen — an earlier version ate the bottom
 *    third of the window and the thing being demonstrated was behind it.
 *  - **Stay light enough to read through.** A near-black panel reads as a
 *    different application sitting on top. A translucent slate panel with a
 *    blur behind it reads as a subtitle on the app.
 *  - **Plain words.** Every line here is read by people whose first language is
 *    not English, at speed, while also looking at a UI. Short sentences, common
 *    words, no metaphors.
 */
const OVERLAY = `
(() => {
  const id = "iq-tour-overlay";
  document.getElementById(id)?.remove();
  const host = document.createElement("div");
  host.id = id;
  host.style.cssText = [
    "position:fixed", "left:0", "right:0", "bottom:0", "z-index:2147483647",
    "font:13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif",
    "color:#f8fafc", "pointer-events:none",
    // Translucent, not opaque: the app stays visible through it.
    "background:rgba(30,41,59,0.62)",
    "backdrop-filter:blur(10px)", "-webkit-backdrop-filter:blur(10px)",
    "border-top:1px solid rgba(248,250,252,0.16)",
    "padding:10px 20px 12px", "transition:opacity 240ms ease",
  ].join(";");
  const clamp =
    "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  host.innerHTML =
    '<div style="display:flex;align-items:baseline;gap:9px">' +
    '<div id="iq-tour-index" style="font-size:11px;font-weight:600;letter-spacing:0.06em;opacity:0.65;flex:0 0 auto"></div>' +
    '<div id="iq-tour-title" style="font-size:15px;font-weight:650;flex:0 0 auto"></div>' +
    '<div id="iq-tour-body" style="font-size:13px;opacity:0.88;flex:1 1 auto;' + clamp + '"></div>' +
    '</div>' +
    '<div id="iq-tour-prompt" style="margin-top:4px;font:11.5px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;' +
    'opacity:0.62;' + clamp + '"></div>' +
    '<div style="margin-top:8px;height:2px;background:rgba(248,250,252,0.18);border-radius:2px;overflow:hidden">' +
    '<div id="iq-tour-bar" style="height:100%;width:0%;background:#38bdf8;transition:width 400ms linear"></div></div>';
  document.body.appendChild(host);
})();
`;

async function showCaption(page, caption) {
  await page
    .evaluate(
      ([index, heading, text, prompt, progress]) => {
        const set = (id, value) => {
          const node = document.getElementById(id);
          if (node) node.textContent = value;
        };
        set("iq-tour-index", index);
        set("iq-tour-title", heading);
        set("iq-tour-body", text);
        set("iq-tour-prompt", prompt);
        const bar = document.getElementById("iq-tour-bar");
        if (bar) bar.style.width = `${progress}%`;
      },
      [
        caption.index,
        caption.title,
        caption.body,
        caption.prompt ? `▸ ${caption.prompt}` : "",
        caption.percent,
      ],
    )
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Navigation helpers
//
// Every one of these is best-effort. An optional connection the viewer has not
// registered (Fabric, Speech, a Foundry image deployment) leaves its control
// absent or disabled, and a tour that dies on that is useless for the machine
// it will actually be recorded on. Missing controls are reported and skipped.
// ---------------------------------------------------------------------------

/** Pick a top-level mode. Control Center is a rail destination, not a segment. */
async function chooseMode(page, name) {
  if (name === "Control Center") {
    const row = page.locator(".rail-group.bottom button").filter({ hasText: "Control Center" });
    if ((await row.count()) === 0) return false;
    await row.first().click();
    await page.waitForTimeout(450);
    return true;
  }
  const tab = page.getByRole("tab", { name: startsWith(name) });
  if ((await tab.count()) === 0) {
    note(`mode "${name}" is not in this build`);
    return false;
  }
  await tab.first().click();
  await page.waitForTimeout(450);
  return true;
}

/**
 * Open one rail destination by name.
 *
 * Scoped to `.rail-group.nav` because the canvas tab strip carries a
 * "Close <name>" button for anything already open, and an unscoped match picks
 * whichever the DOM happens to reach first.
 */
async function openRail(page, name) {
  const row = page.locator(".rail-group.nav button").filter({ hasText: name });
  if ((await row.count()) === 0) {
    note(`rail destination "${name}" is not offered here`);
    return false;
  }
  await row.first().click({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  return true;
}

/** `mode` then `destination`, because a sub-mode only exists inside its mode. */
async function goTo(page, mode, destination) {
  if (!(await chooseMode(page, mode))) return false;
  if (!destination) return true;
  return openRail(page, destination);
}

/** Click a button only if it is present and enabled; say so when it is not. */
async function press(page, locator, what) {
  if ((await locator.count()) === 0) {
    note(`"${what}" is not on screen — skipping`);
    return false;
  }
  const button = locator.first();
  if (await button.isDisabled().catch(() => true)) {
    // Disabled-with-a-reason is a designed state in this app, not a fault. It
    // is worth saying out loud so a recording session knows what it is seeing.
    const why = await button.getAttribute("title").catch(() => null);
    note(`"${what}" is disabled${why ? `: ${why}` : ""} — skipping`);
    return false;
  }
  await button.click().catch(() => undefined);
  await page.waitForTimeout(450);
  return true;
}

/** Scroll the surface a little, so a still frame is not a static screenshot. */
async function drift(page, distance = 260) {
  await page.mouse.wheel(0, distance).catch(() => undefined);
  await page.waitForTimeout(400);
}

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

/** Chat needs a conversation before it has a composer. */
async function ensureConversation(page, created) {
  const composer = page.locator(".pane.chat .composer textarea");
  if ((await composer.count()) > 0) return true;

  const button = page.getByRole("button", { name: "New conversation" });
  if ((await button.count()) === 0) return false;
  await button.first().click().catch(() => undefined);
  await page.waitForTimeout(900);
  created.push(new Date().toISOString());
  return (await composer.count()) > 0;
}

/**
 * Is the chat pane in the middle of a turn?
 *
 * Two surfaces share this pane and they say "working" differently. Chat puts a
 * "Working…" pill and a Stop button in the header. The Data agent disables its
 * box while it polls. Either one means the answer is not here yet.
 */
async function turnRunning(page) {
  const working = page.locator(".pane.chat .pane-header .pill").filter({ hasText: /Working/ });
  if ((await working.count().catch(() => 0)) > 0) return true;
  const box = page.locator(".pane.chat .composer textarea").first();
  if ((await box.count().catch(() => 0)) === 0) return false;
  return box.isDisabled().catch(() => false);
}

/**
 * Wait for the turn to finish.
 *
 * Approval cards are waited on, never clicked. The whole claim this app makes
 * is that a person decides; a demo script that ticks Allow to keep its own
 * timing would be filming the opposite of the product.
 */
async function awaitAnswer(page) {
  // A turn takes a moment to register as running. Without this the first poll
  // sees an idle pane and calls a turn that has not started yet finished.
  const startedBy = Date.now() + 10_000;
  while (Date.now() < startedBy && !(await turnRunning(page))) await page.waitForTimeout(300);

  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let approvalSince = 0;
  while (Date.now() < deadline) {
    if ((await page.locator(".pane.chat .card.approval").count().catch(() => 0)) > 0) {
      if (approvalSince === 0) {
        approvalSince = Date.now();
        log("an approval card is up — answer it in the app window; the tour is waiting");
      } else if (Date.now() - approvalSince > APPROVAL_WAIT_MS) {
        note("nobody answered the approval card — moving on with the chapter unfinished");
        return false;
      }
      await page.waitForTimeout(1_000);
      continue;
    }
    approvalSince = 0;
    if (!(await turnRunning(page))) return true;
    await page.waitForTimeout(1_000);
  }
  note(`no answer after ${Math.round(TURN_TIMEOUT_MS / 1_000)}s — moving on`);
  return false;
}

/**
 * Ask a question and stay until it is answered.
 *
 * Typed character by character rather than filled: a prompt appearing all at
 * once reads as a screenshot, and the whole point of the frame is that a person
 * is asking a question. `--dry` leaves it in the box unsent.
 */
async function typePrompt(page, text, created) {
  if (!(await ensureConversation(page, created))) {
    note("no composer here — prompt not shown");
    return false;
  }
  const composer = page.locator(".pane.chat .composer textarea").first();
  await composer.click().catch(() => undefined);
  await composer.fill("").catch(() => undefined);
  await composer.type(text, { delay: 12 }).catch(() => undefined);
  await page.waitForTimeout(400);

  if (!SEND) return true;

  await composer.press("Enter").catch(() => undefined);
  log("sent — real turn, real minutes");
  const answered = await awaitAnswer(page);
  if (answered) log("answered");
  return answered;
}

/**
 * Put a prompt in a box that belongs to the surface itself, and run it.
 *
 * Image Creation and Research do not use the chat composer — they have their
 * own field, their own history and their own start button, and the chat pane is
 * hidden while they are open.
 *
 * `start` is `{ name, busy }`, and both halves are needed: these buttons
 * *rename* themselves while they work, so watching the one you clicked means
 * watching a locator that stops matching the moment the work begins. Waiting
 * for the busy label to go away is the signal that survives the rename.
 */
async function typeInSurface(page, selector, text, start) {
  const box = page.locator(selector).first();
  if ((await box.count()) === 0) {
    note(`no input matching ${selector} — prompt not shown`);
    return false;
  }
  await box.click().catch(() => undefined);
  await box.fill("").catch(() => undefined);
  await box.type(text, { delay: 12 }).catch(() => undefined);
  await page.waitForTimeout(400);

  if (!SEND || !start) return true;

  // A composer whose send button is an icon has no text to filter on, so a
  // chapter may name it by selector instead.
  const button = start.selector
    ? page.locator(start.selector).first()
    : page.locator("button.primary").filter({ hasText: start.name });
  if (!(await press(page, button, start.name))) return false;
  log(`started — ${start.name} is doing the real thing`);

  const working = start.selector
    ? page.locator(`${start.selector}[aria-label*="${start.busy}"]`)
    : page.locator("button.primary").filter({ hasText: start.busy });
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await working.count().catch(() => 0)) === 0) {
      log("done");
      return true;
    }
    await page.waitForTimeout(1_000);
  }
  note(`"${start.name}" did not finish in ${Math.round(TURN_TIMEOUT_MS / 1_000)}s — moving on`);
  return false;
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
  await page.waitForTimeout(1_000);
  return true;
}

async function openSampleData(page) {
  await chooseMode(page, "Control Center");
  await openRail(page, "Sample data");

  // The pane renders before `samples:status` comes back, so it paints once with
  // the switch off and the modules absent. Reading either of those in that
  // window makes the tour turn a switch the viewer already had on.
  await page
    .locator(".pane-body .card")
    .nth(1)
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => undefined);
  await page.waitForTimeout(600);
}

/**
 * Turn on what the tour needs, and hand back the undo.
 *
 * The returned list is exactly what this run switched on — never what was
 * already there. That distinction is the whole safety property: a viewer who
 * keeps the sample memories loaded between demos must still have them
 * afterwards.
 */
async function loadSamples(page) {
  step("Loading sample data");
  await openSampleData(page);

  const toggle = page.locator(".tool-grant input[type=checkbox]").first();
  const wasEnabled = await toggle.isChecked().catch(() => true);
  if (!wasEnabled) {
    await toggle.check().catch(() => undefined);
    await page.waitForTimeout(800);
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

async function purge(page, undo, created) {
  step("Purging");
  if (created.length > 0) {
    log(`the tour created ${created.length} conversation(s); delete them from the rail if you want`);
  }
  if (!undo) return;
  try {
    await openSampleData(page);
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
    if (undo.loadedByUs.length === 0) log("nothing to purge — the tour loaded nothing new");
  } catch (problem) {
    console.error(`  purge failed: ${problem.message}`);
    console.error("  Clear it by hand: Control Center → Sample data → Clear");
  }
}

// ---------------------------------------------------------------------------
// The chapters
//
// Order follows `demo-scenario-script.md`: governance, Chat, Co-create, IQ Cell,
// Control Center.
//
// **Title the chapter with the feature's own name.** A viewer is learning a
// product, not reading aphorisms. "You see the files before it reads them" is a
// good sentence and a bad label: nobody can ask a colleague about it afterwards.
// "IQ Knowledge" they can. So: title = the name in the UI, body = what it is and
// what you get, in plain words.
//
// **Write the body in plain English.** It is read at speed, by people whose
// first language is often not English, while they are also looking at a UI. So:
// short sentences, common words, say the thing directly. "Delegation has a
// ceiling" and "conventions are reviewed, never absorbed" both shipped once and
// both had to be read twice.
//
// `seconds` is how long the chapter holds *after* its actions finish, so a slow
// machine never truncates the shot. Prompts are the English ones from the
// script, so the caption and the document cannot drift apart — except that the
// script's `<URL>` and `<topic>` placeholders are filled in with something real
// here, because these prompts are sent and a model cannot research `<topic>`.
// ---------------------------------------------------------------------------

const CHAPTERS = [
  {
    id: "audit",
    seconds: 8,
    title: "Audit",
    body: "Every action is written down before it happens. Pick one run and see everything it did, and everything it was refused.",
    async run(page) {
      await goTo(page, "Control Center", "Audit");
      await drift(page, 200);
    },
  },
  {
    id: "chat",
    seconds: 9,
    title: "Chat",
    body: "One thread with the agent. It names itself from your first message. What comes out of it — files, decisions, rules — is the input for an IQ Cell later.",
    prompt: "Explain in three sentences what this application is for.",
    async run(page, ctx) {
      await goTo(page, "Chat", "Conversation");
      await typePrompt(page, this.prompt, ctx.created);
    },
  },
  {
    id: "m365",
    seconds: 9,
    title: "Microsoft 365 tools",
    body: "Mail, calendar and files, using your own account. Reading needs no approval. Sending mail asks you every time.",
    prompt:
      "Summarise the mail I received in the last three days as sender, time received, and the one thing being asked of me.",
    async run(page, ctx) {
      await goTo(page, "Chat", "Conversation");
      await typePrompt(page, this.prompt, ctx.created);
    },
  },
  {
    id: "browser",
    seconds: 9,
    title: "Browser",
    body: "You and the agent share one browser. Going to the web asks every time. A bot wall is reported as a bot wall, not as a failure, and the agent stops trying that host.",
    prompt:
      "Open this page in the browser pane so I can watch, then read it from the pane and quote three sentences verbatim: https://learn.microsoft.com/en-us/azure/well-architected/pillars",
    async run(page, ctx) {
      await goTo(page, "Co-create", "Browser");
      await drift(page, 180);
      await typePrompt(page, this.prompt, ctx.created);
    },
  },
  {
    id: "council",
    seconds: 12,
    title: "Team (Council)",
    body: "The LLM Council idea as a product. Positions you choose answer the same question, read each other, and close with a verdict. Every round is kept and the verdict is a file.",
    async run(page) {
      await goTo(page, "Chat", "Team");
      // Load sample fills the question and three stances and runs nothing — a
      // demo that spends tokens on its own is a surprise on someone's bill.
      await press(page, page.getByRole("button", { name: /Load sample/i }), "Load sample");
      await drift(page, 220);
    },
  },
  {
    id: "dataagent",
    seconds: 9,
    title: "Data agent",
    body: "Ask your Fabric data in plain language. This answer is not from the model, it is from your data. The queries are always on screen, never behind a toggle.",
    prompt: "Break down the most recent quarter by category.",
    async run(page, ctx) {
      await goTo(page, "Chat", "Data agent");
      await typePrompt(page, this.prompt, ctx.created);
    },
  },
  {
    id: "office",
    seconds: 10,
    title: "Office",
    body: "Real .docx, .xlsx and .pptx files. Each one gets its own folder in the project. A whole deck is built in one batch, so it asks once, not once per slide.",
    prompt:
      "Build a five-slide pptx: cover, three KPI cards, a flowchart, a comparison table, and a recommendation. Add it in one batch, not one slide at a time.",
    async run(page, ctx) {
      await goTo(page, "Co-create", "Office");
      await drift(page, 180);
      await typePrompt(page, this.prompt, ctx.created);
    },
  },
  {
    id: "image",
    seconds: 20,
    title: "Image Creation",
    body: "Generate images with your own Foundry model. It is a conversation: the first result is a draft, and each follow-up prompt changes the picture already there instead of starting over. You can also paint the one area an edit should touch. Each image is saved to the project images folder with a file recording how it was made, and the deck can just use it.",
    prompt:
      "A flat vector infographic for a quarterly business review. A 2x2 grid of four panels labelled Revenue, Cost, Headcount, Risk. Each panel shows one large number and one short caption under it. Deep navy background, white text, a single orange accent colour. Clean geometric shapes, no photographs, no gradients, no logos.",
    // The second prompt is the point of the chapter. It is not a new picture,
    // it is an edit of the one already on screen.
    edit:
      "Keep the same four panels and the same layout. Change the accent colour from orange to cyan, and add a thin upward trend line across the bottom of the Revenue panel.",
    async run(page) {
      await goTo(page, "Co-create", "Image Creation");
      await drift(page, 180);
      const send = { name: "Generate", busy: "Generating", selector: "button.composer-send" };
      const drawn = await typeInSurface(
        page,
        'textarea[placeholder^="Describe the image"]',
        this.prompt,
        send,
      );
      if (!drawn) return;
      await page.waitForTimeout(2_500);
      await typeInSurface(
        page,
        'textarea[placeholder^="Describe the image"]',
        this.edit,
        send,
      );
      await page.waitForTimeout(2_000);
    },
  },
  {
    id: "research",
    seconds: 12,
    title: "Research",
    body: "Deep research that plans first. You edit and approve the questions before anything runs. It keeps its own history instead of a chat conversation, and the report is written to the project research folder, so it can be read again later.",
    prompt:
      "Research this topic along three separate lines and attach a source to every claim: the five pillars of the Azure Well-Architected Framework",
    async run(page) {
      await goTo(page, "Chat", "Research");
      await drift(page, 180);
      // Planning and no further. Gathering is minutes of parallel web work, and
      // the plan is the point of the chapter anyway: you read the questions and
      // approve them before anything runs.
      await typeInSurface(
        page,
        'textarea[placeholder="What should the report answer?"]',
        this.prompt,
        { name: "Plan the report", busy: "Planning" },
      );
    },
  },
  {
    id: "record",
    seconds: 9,
    title: "Skill Recording",
    body: "Do the job once and the app writes the skill. There is nothing to type: Record, Analyse, Approve, Build are buttons. It is a draft until you approve it, and a skill can never widen its own permissions.",
    async run(page) {
      await goTo(page, "Co-create", "Skill Recording");
      await drift(page, 220);
    },
  },
  {
    id: "meetings",
    seconds: 8,
    title: "Meeting Recordings",
    body: "Record, transcribe and take notes on this machine. If it cannot record, the button stays on screen and tells you why. The audio and the notes stay in the project.",
    async run(page) {
      await goTo(page, "Co-create", "Meeting Recordings");
      await drift(page, 200);
    },
  },
  {
    id: "fabric",
    seconds: 9,
    title: "Fabric",
    body: "You understood the data in chat and found what was missing. Here you build it. Three tools only: list, create, ask. What was created is proved by listing before and after.",
    prompt: "List the items in this project, grouped by item type.",
    async run(page, ctx) {
      await goTo(page, "Co-create", "Fabric");
      await drift(page, 180);
      await typePrompt(page, this.prompt, ctx.created);
    },
  },
  {
    id: "industry",
    seconds: 9,
    title: "IQ Industry",
    body: "Ready-made primers for your industry. The agent starts with domain context instead of guessing it from your question.",
    async run(page) {
      await goTo(page, "IQ Cell", "IQ Industry");
      await drift(page, 340);
      await drift(page, 340);
    },
  },
  {
    id: "knowledge",
    seconds: 14,
    title: "IQ Knowledge",
    body: "Andrej Karpathy's LLM-wiki idea, on your own material. Put your documents and your Co-create output in the vault, and it writes a wiki the agent reads. Zoom in — every node is one of your notes.",
    async run(page) {
      await goTo(page, "IQ Cell", "IQ Knowledge");
      await drift(page, 200);
      const compiled = await press(
        page,
        page.locator("button.primary").filter({ hasText: /Compile/ }),
        "Compile",
      );
      if (compiled) await page.waitForTimeout(7_000);

      // Node labels appear only once a node is big enough to carry one
      // (radius x scale > 9), and the graph opens zoomed to fit — which for a
      // 250-node vault means no text at all. Without this the shot is a field of
      // grey dots, and a viewer cannot tell it is built from *their* documents.
      //
      // The Zoom in button (x1.25 about the centre) rather than a wheel over the
      // SVG: the button is a stable target, while the wheel needs the cursor
      // parked on the canvas and zooms about wherever the pointer happens to be.
      // Stepped one click at a time so the recording shows the graph opening up,
      // rather than cutting to a different picture.
      const zoomIn = page.getByRole("button", { name: "Zoom in", exact: true });
      if ((await zoomIn.count()) === 0) {
        note("no zoom control on this build — node text will stay hidden");
        return;
      }
      for (let click = 0; click < 8; click += 1) {
        await zoomIn.first().click().catch(() => undefined);
        await page.waitForTimeout(320);
      }
    },
  },
  {
    id: "memories",
    seconds: 11,
    title: "IQ Memories",
    body: "Rules the agent proposed from your conversations. It can only propose. Nothing applies until you approve it, and editing an approved rule sends it back for approval.",
    async run(page) {
      await goTo(page, "IQ Cell", "IQ Memories");
      await drift(page, 300);
      await drift(page, 300);
    },
  },
  {
    id: "workflow",
    seconds: 12,
    title: "IQ Workflow",
    body: "A procedure drawn as a graph. Open one and you can see how the work is modelled.",
    async run(page, ctx) {
      await goTo(page, "IQ Cell", "IQ Workflow");
      await drift(page, 200);

      // An empty canvas says nothing. Loading a real cell is the whole point of
      // the chapter: the viewer has to see steps, inputs and checks to believe
      // a workflow is a document rather than a picture of one.
      const openCell = page.locator(".iqcell-card .iqcell-open");
      if ((await openCell.count()) === 0) {
        note("no published cell in the Workflow sidebar — canvas stays empty");
        return;
      }
      await openCell.first().click().catch(() => undefined);
      await page.waitForTimeout(1_600);
      await ctx.say(
        "The steps, the inputs and the checks are your business model, drawn. Model the business differently and the workflow changes with it.",
      );
    },
  },
  {
    id: "library",
    seconds: 11,
    title: "IQ Cell library",
    body: "Every compiled cell in one list, from all five sources. Click a row and it opens the screen that made it.",
    async run(page) {
      await goTo(page, "IQ Cell", "IQ Cell library");
      // Cycle the origin filter: the point of the surface is that it answers
      // "where did I compile that?" for every origin, not just the editor.
      for (const origin of ["IQ Knowledge", "IQ Memories", "IQ Industry", "All"]) {
        const chip = page.locator(".pane-body .row button").filter({ hasText: origin });
        if ((await chip.count()) === 0) continue;
        await chip.first().click().catch(() => undefined);
        await page.waitForTimeout(1_100);
      }
    },
  },
  {
    id: "connectome",
    seconds: 24,
    title: "My IQ",
    body: "A map of every cell and every link, replayed in the order the work happened — then you ask it questions and it answers from the analysis.",
    async run(page, ctx) {
      await goTo(page, "IQ Cell", "My IQ");
      const ran = await press(
        page,
        page.locator("button.primary").filter({ hasText: "Analyse" }),
        "Analyse",
      );
      // The map assembles itself on completion and then plays the time lapse.
      // That reveal is the shot, so it is waited for rather than held over.
      if (ran) await page.waitForTimeout(14_000);

      // The report column is closed on arrival, and it is where the analysis
      // says what it *found* — the couplings nobody declared, the cells nothing
      // reaches. Leaving it shut makes the chapter a pretty picture with no
      // result, which is the opposite of the point.
      const showReport = page.getByRole("button", { name: "Show the report", exact: true });
      if ((await showReport.count()) > 0) {
        await ctx.say("Open the report and it tells you what it found: new links and cells nobody had connected before.");
        await showReport.first().click().catch(() => undefined);
        await page.waitForTimeout(1_400);
        await drift(page, 260);
        await drift(page, 260);
      } else {
        note("no report control on this build — findings not shown");
      }

      // The report says what it found. The chat is where the map answers back,
      // and it is the part that reads as a product rather than a diagram: the
      // suggestions mean nothing has to be typed, and every answer offers the
      // next question, so the chapter can run itself.
      const ask = page.getByRole("button", { name: "Ask about the map", exact: true });
      if ((await ask.count()) > 0) {
        await ctx.say("Now ask it. The answers come from this analysis, not from a model — the same question always gives the same numbers.");
        await press(page, ask, "Ask about the map");
        await page.waitForTimeout(900);

        // The opening suggestions are set by the persona above, so whichever
        // one is showing is the right first question for this reader. The
        // expander is excluded — clicking it would unfold a list, not ask.
        await press(page, page.locator(".chat-suggestions .chip:not(.chip-more)"), "opening question");
        await page.waitForTimeout(1_600);

        // The follow-up is the point being made: nobody has to know what to
        // type next, because each answer hands over the next question.
        await ctx.say("Every answer offers what to ask next, and every row is clickable — it takes you to that cell on the map.");
        await press(page, page.locator(".chat-next .chip:not(.chip-more)"), "follow-up question");
        await page.waitForTimeout(1_800);
        await drift(page, 220);
      } else {
        note("no chat control on this build — questions not shown");
      }

      // Publish is named and deliberately not pressed: it writes a snapshot to
      // <IQ_HOME>/myiq, and the tour leaves behind nothing its own purge cannot
      // take back.
      await ctx.say("Publish it as an MCP server and other apps can ask your own map questions.");
    },
  },
  {
    id: "automations",
    seconds: 9,
    title: "Automations",
    body: "Scheduled and repeating work. Every sample job arrives switched off and read-only, so loading examples starts nothing.",
    async run(page) {
      await goTo(page, "Control Center", "Automations");
      await drift(page, 260);
    },
  },
  {
    id: "plans",
    seconds: 9,
    title: "Delegated plans",
    body: "Watch sub-agents run in parallel, with retries. A delegated task can read, write and go online. It can never run a shell command.",
    async run(page) {
      await goTo(page, "Control Center", "Delegated plans");
      await drift(page, 240);
    },
  },
  {
    id: "skills",
    seconds: 9,
    title: "Skills",
    body: "Procedures the agent loads when it needs them. Training makes a skill better at its job, but never gives it more tools.",
    async run(page) {
      await goTo(page, "Control Center", "Skills");
      await drift(page, 260);
    },
  },
  {
    id: "mcp",
    seconds: 10,
    title: "MCP servers",
    body: "Connect outside tools. A new server arrives switched off with nothing approved. You inspect it, then tick the tools you want.",
    async run(page) {
      await goTo(page, "Control Center", "MCP servers");
      await drift(page, 240);
    },
  },
  {
    id: "samples",
    seconds: 8,
    title: "Sample data",
    body: "Load and clear the worked examples. Turning the switch off deletes nothing. Only Clear removes data, and Clear always works.",
    async run(page) {
      await openSampleData(page);
      await drift(page, 220);
    },
  },
];

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function selectChapters() {
  const known = new Set(CHAPTERS.map((chapter) => chapter.id));
  for (const id of [...ONLY, ...SKIP]) {
    if (!known.has(id)) {
      throw new Error(
        `unknown chapter "${id}". Run with --list to see them all.`,
      );
    }
  }
  const chosen = CHAPTERS.filter((chapter) => ONLY.length === 0 || ONLY.includes(chapter.id))
    .filter((chapter) => !SKIP.includes(chapter.id));
  if (chosen.length === 0) throw new Error("every chapter was filtered out; nothing to record.");
  return chosen;
}

function printChapters() {
  console.log("\nChapters (use --only=a,b or --skip=a,b):\n");
  for (const chapter of CHAPTERS) {
    console.log(`  ${chapter.id.padEnd(12)} ${String(chapter.seconds).padStart(2)}s  ${chapter.title}`);
  }
  const total = CHAPTERS.reduce((sum, chapter) => sum + chapter.seconds, 0);
  console.log(`\n  ${CHAPTERS.length} chapters, ${total}s of holds plus whatever the app takes.\n`);
}

/**
 * Wait for the window to be past the sign-in gate.
 *
 * The rail only exists once the app is in. Polling for it is how the handoff
 * works: nothing here knows or wants to know how the person got in.
 *
 * One thing it does press: **Continue**, and only while it is enabled. The gate
 * enables that button when both connections are already green, so pressing it
 * acquires no token, picks no tenant and decides nothing — it dismisses a gate
 * whose work is done. On a machine that is already signed in, waiting for a
 * person to click it means the tour times out five minutes later having done
 * nothing at all, which is what happened the first time this ran.
 *
 * Everything above that button is still the person's: if Continue is disabled,
 * the tour says which connection is missing and waits.
 */
async function waitForSignIn(page) {
  step("Waiting for the app to be signed in");

  const rail = page.locator(".rail-group.nav").first();
  const gate = page.locator(".signin-card");
  const cont = gate.locator("button", { hasText: "Continue" }).last();

  const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
  let told = false;
  while (Date.now() < deadline) {
    if (await rail.isVisible().catch(() => false)) {
      log("in");
      await page.waitForTimeout(900);
      return;
    }
    if ((await gate.count().catch(() => 0)) > 0) {
      if (await cont.isEnabled().catch(() => false)) {
        log("both connections are green — pressing Continue");
        await cont.click().catch(() => {});
      } else if (!told) {
        told = true;
        // Read the gate back rather than guessing at it: the person needs to
        // know which of the two rows is the one holding this up.
        const lines = await gate.locator(".status-line").allInnerTexts().catch(() => []);
        log("the sign-in gate is up and Continue is not available yet:");
        for (const line of lines) log(`  ${line.replace(/\s+/g, " ").trim()}`);
        log("finish the sign-in in the app window; the tour starts on its own.");
      }
    }
    await page.waitForTimeout(1000);
  }
  throw new Error("the app never got past the sign-in gate");
}

async function main() {
  if (LIST_ONLY) {
    printChapters();
    return;
  }

  const chapters = selectChapters();
  const budget = chapters.reduce((sum, chapter) => sum + chapter.seconds, 0);

  const videoDir = path.join(HERE, "recordings");
  if (RECORD) mkdirSync(videoDir, { recursive: true });

  step(
    `IQ Compiler tour — ${chapters.length} chapters, ~${Math.round(budget * SPEED)}s of holds` +
      `${RECORD ? ", recording" : ""}${SEND ? "" : ", --dry: nothing is sent"}`,
  );
  if (SEND) {
    log("prompts are sent for real: real minutes, real tokens, a different answer every take.");
    log("approval cards are yours to answer — the tour waits, it never clicks Allow.");
    log("pass --dry to type the prompts and send none of them.");
  }

  const app = await electron.launch({
    args: [path.join(ROOT, "apps", "main")],
    cwd: ROOT,
    // No IQ_E2E, no IQ_HOME override, no token: the tour runs against the real
    // app exactly as the viewer's own install would, and signs in as nobody.
    ...(RECORD ? { recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } } } : {}),
  });

  const page = await app.firstWindow();
  page.on("pageerror", (error) => console.error(`  renderer error: ${error.message}`));
  await page.waitForLoadState("domcontentloaded");

  let undo = null;
  const created = [];
  try {
    await waitForSignIn(page);
    undo = await loadSamples(page);

    await page.evaluate(OVERLAY);
    let done = 0;
    for (const chapter of chapters) {
      const index = `${done + 1}/${chapters.length}`;
      step(`${index}  ${chapter.title}  [${chapter.id}]`);

      const caption = {
        index,
        title: chapter.title,
        body: chapter.body,
        prompt: chapter.prompt ?? "",
        percent: Math.round((done / chapters.length) * 100),
      };
      await showCaption(page, caption);

      // A chapter that throws costs its own shot and nothing else. Recording
      // sessions are long and the machine is never quite the one it was written
      // on; losing the remaining eighteen chapters to one missing button would
      // be the worst possible trade.
      try {
        await chapter.run(page, {
          created,
          // Some chapters have two things to say and one of them only makes
          // sense once the app has caught up — the Connectome's findings do not
          // exist until the analysis finishes. `say` re-words the body line in
          // place so the caption can follow the shot instead of describing the
          // whole chapter at the start and being wrong for half of it.
          say: (body) => showCaption(page, { ...caption, body }),
        });
      } catch (problem) {
        console.error(`  chapter "${chapter.id}" failed: ${problem.message}`);
      }

      await hold(chapter.seconds);
      done += 1;
      await showCaption(page, { ...caption, percent: Math.round((done / chapters.length) * 100) });
    }
  } finally {
    // Purge before the overlay comes down, so a viewer can see it happen.
    await purge(page, undo, created);
    await page
      .evaluate(() => document.getElementById("iq-tour-overlay")?.remove())
      .catch(() => undefined);
    if (RECORD) log(`recording written to ${videoDir}`);
    await app.close().catch(() => undefined);
  }

  step("Done");
}

main().catch((problem) => {
  console.error(`\nTour failed: ${problem.message}`);
  process.exitCode = 1;
});
