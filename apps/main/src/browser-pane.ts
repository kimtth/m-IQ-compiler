import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Request as PwRequest,
  type Route,
} from "playwright-core";
import { readJson, writeJsonAtomic } from "@iq/core";
import type { App, BrowserActResult, BrowserElementMap, BrowserPageSnapshot, BrowserPaneHost } from "@iq/core";
import type {
  BrowserBounds,
  BrowserEngine,
  BrowserFrame,
  BrowserInput,
  BrowserState,
} from "@iq/shared";

/**
 * Built-in browser pane.
 *
 * The page does not run inside this application. It runs in a real Edge or
 * Chrome already installed on the machine, driven by Playwright; its viewport
 * is streamed to the renderer with `Page.startScreencast` and the user's input
 * is forwarded back as CDP events. The renderer therefore holds a picture of a
 * page rather than the page itself, which is what lets the pane exist at all
 * next to `webviewTag: false` and a `default-src 'none'` policy.
 *
 * The reason for choosing this over an embedded view is that one browser must
 * serve two masters. The user browses in it and the agent automates it, and
 * they must share one process, one profile and one cookie jar — otherwise
 * "log in, then have the agent continue" is impossible. Playwright supplies the
 * automation semantics (locators, actionability waiting, frame handling) that a
 * hand-written verb set would have to reinvent, and VS Code's Edge DevTools
 * extension supplies the precedent for the screencast surface.
 *
 * Every decision about *what may load* still belongs to `app.browserPolicy` in
 * core, so one testable rule governs the address bar, an in-page redirect, and
 * the agent's tools alike.
 */

/** Cap on page text handed to a model, so one page cannot flood a turn. */
const MAX_PAGE_TEXT_CHARS = 20_000;

/**
 * Channels tried in order. Nothing is ever downloaded: the pane drives a
 * browser the machine already has, so an offline or locked-down install is not
 * left waiting on a fetch it may not be allowed to make.
 */
const CHANNELS = ["msedge", "chrome"] as const;

/** A screencast only emits on repaint, so a still page needs a nudge. */
const SNAPSHOT_INTERVAL_MS = 400;
const SNAPSHOT_IDLE_MS = 500;

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/** How long a single agent act may wait for an element to become actionable. */
const ACT_TIMEOUT_MS = 10_000;

/** A beat after an act, so the frame the user sees reflects what just happened. */
const ACT_SETTLE_MS = 250;

/** Ceiling on elements handed to a model in one map. */
const MAX_ELEMENTS = 300;

/** How many conversations keep a remembered page. Oldest fall off the end. */
const MAX_REMEMBERED_PAGES = 100;

/** Prefix the element script uses to say it hit the ceiling. */
const TRUNCATION_MARKER = "#truncated\n";

/**
 * Runs in the page to label interactive elements and describe them.
 *
 * Source text rather than a closure: the main process compiles without DOM
 * types, so `document` cannot be referenced here as code. Previous labels are
 * cleared first, so a handle only ever refers to the most recent map — a stale
 * `e12` from two pages ago resolves to nothing rather than to the wrong thing.
 */
export const ELEMENT_MAP_SCRIPT = `(() => {
  document.querySelectorAll('[data-iq-ref]').forEach((el) => el.removeAttribute('data-iq-ref'));
  const selector = 'a[href],button,input,select,textarea,summary,[role],[onclick],[tabindex],[contenteditable="true"]';
  const lines = [];
  let count = 0;
  let truncated = false;
  for (const el of document.querySelectorAll(selector)) {
    if (count >= ${MAX_ELEMENTS}) { truncated = true; break; }
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
    const ref = 'e' + (++count);
    el.setAttribute('data-iq-ref', ref);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role')
      || (tag === 'a' ? 'link' : tag === 'input' ? (el.getAttribute('type') || 'text') : tag);
    const name = (el.getAttribute('aria-label')
      || el.getAttribute('placeholder')
      || el.getAttribute('title')
      || el.getAttribute('name')
      || el.value
      || el.innerText
      || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    lines.push(ref + ' ' + role + ' "' + name + '"' + (el.disabled ? ' [disabled]' : ''));
  }
  return (truncated ? ${JSON.stringify(TRUNCATION_MARKER)} : '') + lines.join('\\n');
})()`;

export class BrowserPane {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private starting: Promise<Page | null> | null = null;

  private engine: BrowserEngine = "idle";
  private engineDetail = "";
  private viewport = { ...DEFAULT_VIEWPORT };
  private wantVisible = false;
  private blocked = "";
  private closing = false;
  private lastTitle = "";
  private loading = false;

  /**
   * History is tracked here because Playwright exposes `goBack`/`goForward`
   * but nothing that answers "is there anywhere to go". The toolbar needs that
   * answer to disable its buttons, and the agent's tools need it to refuse
   * cleanly rather than silently doing nothing.
   */
  private history: string[] = [];
  private historyIndex = -1;
  private traversing = false;

  private lastFrameAt = 0;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private snapshotting = false;

  /**
   * The page the current conversation had, kept across a close and a restart.
   *
   * Closing tears the browser down and quitting takes the rest, so coming back
   * to the pane meant an empty page and a URL to go and find again. A place is
   * the only thing worth keeping — no session, no form state, just where the
   * user was.
   *
   * Filed per conversation rather than for the app as a whole. One thread
   * reading a paper and another watching a dashboard are two pieces of work,
   * and a single remembered page meant whichever was open last won.
   */
  private lastUrl = "";
  /** The conversation the pane is currently working for. Empty when none. */
  private sessionId = "";
  /** Remembered pages, newest first. Null until the file has been read. */
  private pages: RememberedPage[] | null = null;
  /**
   * True after the user closed the pane.
   *
   * Closing is an instruction, and reopening the page on the next tab switch
   * would ignore it. Cleared by the next navigation, which is the user saying
   * they want a page again.
   */
  private closedByUser = false;

  constructor(
    private readonly app: App,
    private readonly publish: (state: BrowserState) => void,
    private readonly publishFrame: (frame: BrowserFrame) => void,
  ) {}

  state(): BrowserState {
    const page = this.livePage();
    return {
      enabled: this.app.browserPolicy.enabled,
      open: page !== null,
      visible: this.wantVisible && page !== null,
      url: this.currentUrl(),
      title: this.lastTitle,
      loading: this.loading,
      canGoBack: this.historyIndex > 0,
      canGoForward: this.historyIndex >= 0 && this.historyIndex < this.history.length - 1,
      blocked: this.blocked,
      deniedHosts: [...this.app.browserPolicy.deniedHosts],
      engine: this.engine,
      engineDetail: this.engineDetail,
    };
  }

  /**
   * Navigate, after a policy check and an audit record.
   *
   * A refusal is recorded exactly like an allowed navigation. "Which sites did
   * this machine's agent try to open" is a question a reviewer should be able to
   * answer from the audit log alone.
   */
  async navigate(url: string, actor: "user" | "agent"): Promise<BrowserState> {
    const verdict = this.app.browserPolicy.check(url);
    const account = this.app.entra.currentAccount();
    this.closedByUser = false;

    await this.app.audit.record({
      actor:
        actor === "user" && account
          ? { kind: "user", oid: account.oid, tenantId: account.tenantId }
          : { kind: "system" },
      action: "browser.navigate",
      family: "browser",
      outcome: verdict.allowed ? "allowed" : "denied",
      correlationId: this.app.correlationId(),
      // The host, never the full URL: a path or query can carry a token or a
      // document name, and audit records are read by people who may not be
      // entitled to either.
      resources: [verdict.host || "unparsed"],
      reason: verdict.reason,
    });

    if (!verdict.allowed) {
      this.blocked = verdict.reason;
      return this.pushState();
    }

    this.blocked = "";
    const page = await this.ensurePage();
    if (!page) return this.pushState();

    this.wantVisible = true;
    this.loading = true;
    this.pushState();

    await page.goto(verdict.url, { waitUntil: "domcontentloaded" }).catch((error: unknown) => {
      this.blocked = describe(error);
    });

    this.loading = false;
    await this.refreshTitle();
    void this.snapshot();
    return this.pushState();
  }

  async goBack(): Promise<BrowserState> {
    const page = this.livePage();
    if (page && this.historyIndex > 0) {
      this.traversing = true;
      this.historyIndex -= 1;
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      this.traversing = false;
      await this.refreshTitle();
      void this.snapshot();
    }
    return this.pushState();
  }

  async goForward(): Promise<BrowserState> {
    const page = this.livePage();
    if (page && this.historyIndex < this.history.length - 1) {
      this.traversing = true;
      this.historyIndex += 1;
      await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      this.traversing = false;
      await this.refreshTitle();
      void this.snapshot();
    }
    return this.pushState();
  }

  async reload(): Promise<BrowserState> {
    const page = this.livePage();
    if (page) {
      this.traversing = true;
      this.loading = true;
      this.pushState();
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      this.traversing = false;
      this.loading = false;
      await this.refreshTitle();
      void this.snapshot();
    }
    return this.pushState();
  }

  async stopLoading(): Promise<BrowserState> {
    await this.cdp?.send("Page.stopLoading").catch(() => undefined);
    this.loading = false;
    return this.pushState();
  }

  /**
   * The visible text of the current page.
   *
   * Capped, because the result goes into a model's context: an unbounded read
   * would let one page flood a turn. Nothing is returned when no page is
   * loaded — an empty URL is the caller's signal.
   */
  async readPage(): Promise<BrowserPageSnapshot> {
    const page = this.livePage();
    const state = this.state();
    if (!page || !state.url) return emptySnapshot();

    // Evaluated as source text rather than a closure: the main process is
    // compiled without DOM types, and this expression runs in the page.
    const raw = await page
      .evaluate<string>("document.body ? document.body.innerText : ''")
      .catch(() => "");

    const text = String(raw ?? "").replace(/\n{3,}/g, "\n\n").trim();
    return {
      url: state.url,
      title: state.title,
      text: text.slice(0, MAX_PAGE_TEXT_CHARS),
      truncated: text.length > MAX_PAGE_TEXT_CHARS,
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
      loading: state.loading,
    };
  }

  /**
   * Enumerate the interactive elements of the page and issue a handle for each.
   *
   * The agent never gets coordinates. Clicking at (412, 233) is a guess that
   * silently hits the wrong thing when a layout shifts; naming `e17` is a
   * handle this process minted, so a handle we never issued can be refused.
   * The handles are written into the live DOM as `data-iq-ref`, which is also
   * what makes them resolvable by an ordinary Playwright locator — with its
   * actionability waiting — rather than by a raw CDP coordinate.
   */
  async elements(): Promise<BrowserElementMap> {
    const page = this.livePage();
    const state = this.state();
    if (!page || !state.url) return { url: "", title: "", outline: "", truncated: false };

    const raw = await page.evaluate<string>(ELEMENT_MAP_SCRIPT).catch(() => "");
    const text = String(raw ?? "");
    const truncated = text.startsWith(TRUNCATION_MARKER);
    return {
      url: state.url,
      title: state.title,
      outline: truncated ? text.slice(TRUNCATION_MARKER.length) : text,
      truncated,
    };
  }

  /** Click an element previously handed out by {@link elements}. */
  async clickRef(ref: string): Promise<BrowserActResult> {
    return this.act(`click ${ref}`, async (page) => {
      await page.locator(refSelector(ref)).first().click({ timeout: ACT_TIMEOUT_MS });
    });
  }

  /** Replace a field's value, optionally submitting it. */
  async fillRef(ref: string, text: string, submit: boolean): Promise<BrowserActResult> {
    return this.act(`fill ${ref}`, async (page) => {
      const target = page.locator(refSelector(ref)).first();
      // `fill` rather than `type`: it goes through `Input.insertText`, which is
      // the only path that survives an IME-composed script intact.
      await target.fill(text, { timeout: ACT_TIMEOUT_MS });
      if (submit) await target.press("Enter", { timeout: ACT_TIMEOUT_MS });
    });
  }

  /** Choose options in a dropdown, by value or by visible label. */
  async selectRef(ref: string, values: string[]): Promise<BrowserActResult> {
    return this.act(`select ${ref}`, async (page) => {
      const target = page.locator(refSelector(ref)).first();
      try {
        await target.selectOption(values, { timeout: ACT_TIMEOUT_MS });
      } catch {
        // A model reading the page sees labels, not values; accept both rather
        // than making it guess which one the markup used.
        await target.selectOption(
          values.map((label) => ({ label })),
          { timeout: ACT_TIMEOUT_MS },
        );
      }
    });
  }

  /** Press a control key in the page. */
  async pressKey(key: string): Promise<BrowserActResult> {
    return this.act(`press ${key}`, async (page) => {
      await page.keyboard.press(key);
    });
  }

  /** Scroll the page by whole viewport heights. */
  async scrollPage(direction: "up" | "down", amount: number): Promise<BrowserActResult> {
    return this.act(`scroll ${direction}`, async (page) => {
      const height = page.viewportSize()?.height ?? DEFAULT_VIEWPORT.height;
      const delta = height * clamp(amount, 1, 20) * (direction === "up" ? -1 : 1);
      await page.mouse.wheel(0, delta);
    });
  }

  /** Wait until some text appears, for pages that fill themselves in later. */
  async waitForText(text: string, timeoutMs: number): Promise<BrowserActResult> {
    return this.act("wait for text", async (page) => {
      await page
        .getByText(text, { exact: false })
        .first()
        .waitFor({ state: "visible", timeout: clamp(timeoutMs, 500, 60_000) });
    });
  }

  /**
   * Run one act against the live page and report where it left the user.
   *
   * Every act ends with a settle and a fresh frame, because the screencast only
   * emits on repaint: without this the agent would act and the user's pane
   * would keep showing the page as it was before the click.
   */
  private async act(label: string, run: (page: Page) => Promise<void>): Promise<BrowserActResult> {
    const page = this.livePage();
    if (!page || !this.state().url) throw new Error("no page is open in the browser pane");

    try {
      await run(page);
    } catch (error) {
      throw new Error(`${label} failed: ${describe(error)}`);
    }

    await page.waitForLoadState("domcontentloaded", { timeout: ACT_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(ACT_SETTLE_MS);
    await this.snapshot();

    const state = this.state();
    return { url: state.url, title: state.title, detail: `${label} succeeded` };
  }

  /**
   * Forward one user input event into the page.
   *
   * Text and keys are separate kinds on purpose. A synthesised key event
   * carries a keycode, and a keycode cannot express Hangul, kana, or anything
   * else an IME composes; committed text is inserted with `Input.insertText`
   * instead, which is also what Playwright's own `fill()` uses. Keys are
   * reserved for the control set where the keycode is the point.
   */
  async sendInput(input: BrowserInput): Promise<void> {
    const cdp = this.cdp;
    // Input is refused when the pane is not showing: a hidden tab must not be
    // able to act inside a page the user cannot see.
    if (!cdp || !this.livePage() || !this.wantVisible) return;

    try {
      if (input.kind === "mouse") {
        await cdp.send("Input.dispatchMouseEvent", {
          type: input.type,
          x: input.x,
          y: input.y,
          button: input.button,
          clickCount: input.clickCount,
        });
      } else if (input.kind === "wheel") {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: input.x,
          y: input.y,
          button: "none",
          deltaX: input.deltaX,
          deltaY: input.deltaY,
        });
      } else if (input.kind === "text") {
        await cdp.send("Input.insertText", { text: input.text });
      } else {
        const modifiers =
          (input.alt ? 1 : 0) | (input.ctrl ? 2 : 0) | (input.meta ? 4 : 0) | (input.shift ? 8 : 0);
        for (const type of ["keyDown", "keyUp"] as const) {
          await cdp.send("Input.dispatchKeyEvent", {
            type,
            key: input.key,
            code: input.code,
            modifiers,
            windowsVirtualKeyCode: input.keyCode,
            nativeVirtualKeyCode: input.keyCode,
          });
        }
      }
    } catch {
      // A closed page races every input event; losing one keystroke to a
      // teardown is not worth surfacing.
      return;
    }

    void this.snapshot();
  }

  /** Navigation verbs as the agent's tools consume them. */
  agentHost(): Required<BrowserPaneHost> {
    return {
      open: async (url) => {
        const state = await this.navigate(url, "agent");
        if (state.blocked) throw new Error(state.blocked);
        return { url: state.url, title: state.title };
      },
      read: async () => this.readPage(),
      back: async () => {
        await this.goBack();
        return this.pageSnapshot();
      },
      forward: async () => {
        await this.goForward();
        return this.pageSnapshot();
      },
      reload: async () => {
        await this.reload();
        return this.pageSnapshot();
      },
      close: async () => {
        await this.close();
      },
      elements: async () => this.elements(),
      click: async (ref) => this.clickRef(ref),
      fill: async (ref, text, submit) => this.fillRef(ref, text, submit),
      select: async (ref, values) => this.selectRef(ref, values),
      press: async (key) => this.pressKey(key),
      scroll: async (direction, amount) => this.scrollPage(direction, amount),
      waitFor: async (text, timeoutMs) => this.waitForText(text, timeoutMs),
    };
  }

  /**
   * How large to render, and whether the tab is showing.
   *
   * The size is the real viewport, so what the agent measures and what the user
   * sees are the same layout. Visibility starts and stops the screencast, so a
   * hidden tab costs nothing.
   */
  async setBounds(bounds: BrowserBounds & { visible: boolean }): Promise<BrowserState> {
    const sizeable = bounds.width > 0 && bounds.height > 0;
    const width = clamp(bounds.width, 320, 4_096);
    const height = clamp(bounds.height, 240, 4_096);
    const resized =
      Math.abs(width - this.viewport.width) > 8 || Math.abs(height - this.viewport.height) > 8;

    if (sizeable) this.viewport = { width, height };
    this.wantVisible = bounds.visible;

    const page = this.livePage();
    if (page && sizeable && resized) {
      await page.setViewportSize(this.viewport).catch(() => undefined);
    }

    if (this.wantVisible) {
      this.startStreaming();
      void this.snapshot();
    } else {
      this.stopStreaming();
    }

    return this.state();
  }

  /** Tear the browser down completely, discarding in-memory page state. */
  async close(): Promise<BrowserState> {
    this.closing = true;
    this.closedByUser = true;
    this.stopStreaming();

    const context = this.context;
    this.cdp = null;
    this.page = null;
    this.context = null;
    this.history = [];
    this.historyIndex = -1;
    this.lastTitle = "";
    this.loading = false;
    this.blocked = "";
    this.wantVisible = false;
    if (this.engine !== "unavailable") this.engine = "idle";

    await context?.close().catch(() => undefined);
    this.closing = false;
    return this.pushState();
  }

  /** Called on app quit, so a browser process is never left behind. */
  async dispose(): Promise<void> {
    await this.close().catch(() => undefined);
  }

  // --- engine ---------------------------------------------------------------

  private livePage(): Page | null {
    const page = this.page;
    return page && !page.isClosed() ? page : null;
  }

  private currentUrl(): string {
    const page = this.livePage();
    if (!page) return "";
    const url = page.url();
    return url === "about:blank" ? "" : url;
  }

  private pageSnapshot(): BrowserPageSnapshot {
    const state = this.state();
    return {
      url: state.url,
      title: state.title,
      text: "",
      truncated: false,
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
      loading: state.loading,
    };
  }

  private async ensurePage(): Promise<Page | null> {
    const live = this.livePage();
    if (live) return live;
    this.starting ??= this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<Page | null> {
    this.engine = "starting";
    this.engineDetail = "";
    this.pushState();

    const userDataDir = join(this.app.paths.root, "browser-profile");
    mkdirSync(userDataDir, { recursive: true });

    const failures: string[] = [];
    for (const channel of CHANNELS) {
      try {
        // A persistent profile is the point: the user signs in once, in the
        // pane, and the agent continues in the same session. An isolated
        // context would hand the agent a browser nobody is logged into.
        const context = await chromium.launchPersistentContext(userDataDir, {
          channel,
          headless: true,
          viewport: this.viewport,
          // Containment that does not narrow where the user may go.
          acceptDownloads: false,
          permissions: [],
          args: ["--no-default-browser-check", "--disable-features=Translate,MediaRouter"],
        });

        await this.adopt(context);
        this.engine = "ready";
        this.engineDetail = channel;
        this.pushState();
        return this.page;
      } catch (error) {
        failures.push(`${channel}: ${describe(error)}`);
      }
    }

    this.engine = "unavailable";
    this.engineDetail =
      "no browser engine could be started — the pane drives Microsoft Edge or Google Chrome installed on this machine. Install one, then reopen the pane.";
    this.blocked = this.engineDetail;
    this.pushState();
    return null;
  }

  private async adopt(context: BrowserContext): Promise<void> {
    this.context = context;

    // Every request is checked against the same policy the address bar uses, so
    // a redirect, an iframe or a fetch cannot reach a host the tenant denies.
    await context.route("**/*", (route, request) => this.screenRequest(route, request));

    // A popup either belongs in this pane or nowhere. A second window would
    // escape both the layout and the policy that governs this one.
    context.on("page", (opened) => {
      if (opened === this.page) return;
      const target = opened.url();
      void opened.close().catch(() => undefined);
      if (target && target !== "about:blank") void this.navigate(target, "agent");
    });

    context.on("close", () => {
      if (this.closing) return;
      this.page = null;
      this.cdp = null;
      this.context = null;
      this.engine = "idle";
      this.pushState();
    });

    const page = context.pages()[0] ?? (await context.newPage());
    this.page = page;

    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      this.recordHistory(frame.url());
      void this.refreshTitle().then(() => this.pushState());
    });
    page.on("load", () => {
      this.loading = false;
      void this.refreshTitle().then(() => this.pushState());
      void this.snapshot();
    });
    page.on("close", () => {
      this.page = null;
      this.cdp = null;
      this.pushState();
    });
    // A dialog would otherwise block the page forever: nothing in this pane can
    // answer one, and a hostile page could hang the surface with a loop.
    page.on("dialog", (dialog) => void dialog.dismiss().catch(() => undefined));

    const cdp = await context.newCDPSession(page);
    this.cdp = cdp;
    cdp.on("Page.screencastFrame", (frame) => {
      this.lastFrameAt = Date.now();
      if (this.wantVisible) {
        this.publishFrame({
          data: frame.data,
          width: frame.metadata.deviceWidth || this.viewport.width,
          height: frame.metadata.deviceHeight || this.viewport.height,
          offsetTop: frame.metadata.offsetTop ?? 0,
          scale: frame.metadata.pageScaleFactor ?? 1,
        });
      }
      void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
    });

    if (this.wantVisible) this.startStreaming();
  }

  /**
   * Policy on the wire.
   *
   * A main-frame document is audited as a navigation, because that is the act a
   * reviewer cares about. Sub-resources are checked but not audited: one page
   * can issue hundreds, and a log that drowns is a log nobody reads.
   */
  private async screenRequest(route: Route, request: PwRequest): Promise<void> {
    const url = request.url();
    if (!/^https?:/i.test(url)) {
      await route.continue().catch(() => undefined);
      return;
    }

    const verdict = this.app.browserPolicy.check(url);
    if (verdict.allowed) {
      await route.continue().catch(() => undefined);
      return;
    }

    const isMainDocument =
      request.isNavigationRequest() && request.frame() === this.livePage()?.mainFrame();
    if (isMainDocument) {
      this.blocked = verdict.reason;
      void this.app.audit
        .record({
          actor: { kind: "system" },
          action: "browser.navigate",
          family: "browser",
          outcome: "denied",
          correlationId: this.app.correlationId(),
          resources: [verdict.host || "unparsed"],
          reason: verdict.reason,
        })
        .catch(() => undefined);
      this.pushState();
    }

    await route.abort("blockedbyclient").catch(() => undefined);
  }

  /**
   * Track history depth ourselves.
   *
   * A navigation we did not cause truncates the forward entries, exactly as a
   * browser does when you go back and then follow a new link.
   */
  private recordHistory(url: string): void {
    if (this.traversing) return;
    if (url === "about:blank") return;
    if (this.history[this.historyIndex] === url) return;
    this.history = [...this.history.slice(0, this.historyIndex + 1), url];
    this.historyIndex = this.history.length - 1;
  }

  private async refreshTitle(): Promise<void> {
    const page = this.livePage();
    this.lastTitle = page ? await page.title().catch(() => "") : "";
  }

  // --- screencast -----------------------------------------------------------

  private startStreaming(): void {
    const cdp = this.cdp;
    if (!cdp) return;

    void cdp
      .send("Page.startScreencast", {
        format: "jpeg",
        quality: 70,
        maxWidth: this.viewport.width,
        maxHeight: this.viewport.height,
        everyNthFrame: 1,
      })
      .catch(() => undefined);

    // A screencast only emits on repaint, so a still page would leave the pane
    // blank after a tab switch. A captured frame fills the gaps.
    this.snapshotTimer ??= setInterval(() => {
      if (Date.now() - this.lastFrameAt > SNAPSHOT_IDLE_MS) void this.snapshot();
    }, SNAPSHOT_INTERVAL_MS);
  }

  private stopStreaming(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    void this.cdp?.send("Page.stopScreencast").catch(() => undefined);
  }

  private async snapshot(): Promise<void> {
    const page = this.livePage();
    if (!page || !this.wantVisible || this.snapshotting) return;
    this.snapshotting = true;
    try {
      const buffer = await page.screenshot({ type: "jpeg", quality: 70 });
      this.publishFrame({
        data: buffer.toString("base64"),
        width: this.viewport.width,
        height: this.viewport.height,
        offsetTop: 0,
        scale: 1,
      });
    } catch {
      // Screenshotting races navigation; the next frame will be along shortly.
    } finally {
      this.snapshotting = false;
    }
  }

  private pushState(): BrowserState {
    const state = this.state();
    this.remember(state.url);
    this.publish(state);
    return state;
  }

  /**
   * Reopen the page this conversation was on, if there is one.
   *
   * Routed through {@link navigate}, so tenant policy decides again: a host
   * that was allowed yesterday and is denied today is refused now, and the
   * refusal is audited like any other navigation. Does nothing after the user
   * closed the pane — that was an instruction, not an accident.
   *
   * This is also where the pane learns which conversation it is working for,
   * because every other way in — the toolbar, an in-page link, the agent's
   * tools — carries no conversation with it. The renderer calls this when the
   * browser surface opens and again whenever the user changes conversation.
   *
   * A conversation with no remembered page adopts whatever is open. That is
   * what makes an agent-opened page stick: the tool navigates first and the
   * surface mounts a moment later, so without this the page nobody typed would
   * be filed under nothing.
   */
  async restore(sessionId: string): Promise<BrowserState> {
    if (!this.app.browserPolicy.enabled || this.closedByUser) return this.state();

    this.sessionId = sessionId;
    this.lastUrl = await this.rememberedUrl(sessionId);

    const open = this.currentUrl();
    if (this.lastUrl === "") {
      if (open !== "") this.remember(open);
      return this.state();
    }
    if (this.livePage() && open === this.lastUrl) return this.state();
    return this.navigate(this.lastUrl, "user");
  }

  /** Where remembered pages live. One line of state each, so one small file. */
  private get memoryFile(): string {
    return join(this.app.paths.config, "browser.json");
  }

  private async readPages(): Promise<RememberedPage[]> {
    if (this.pages !== null) return this.pages;
    this.pages = [];
    try {
      const raw = await readJson<{ pages?: unknown }>(this.memoryFile, {});
      if (Array.isArray(raw.pages)) {
        this.pages = raw.pages.filter(isRememberedPage).slice(0, MAX_REMEMBERED_PAGES);
      }
    } catch {
      // No file yet, or one that will not parse. Having nothing to restore is
      // not a fault; the pane opens empty, as it always did, and the next
      // navigation writes a good file over the bad one.
    }
    return this.pages;
  }

  private async rememberedUrl(sessionId: string): Promise<string> {
    const pages = await this.readPages();
    return pages.find((page) => page.sessionId === sessionId)?.url ?? "";
  }

  /**
   * Drop pages filed under conversations that no longer exist.
   *
   * Deleting a conversation does not reach in here, and nothing else ever
   * reads those entries again, so without this the file only grows. The pane's
   * own bucket is always kept: it belongs to no conversation, so no
   * conversation can take it away.
   */
  async forget(sessionIds: ReadonlySet<string>, apply: boolean): Promise<number> {
    const pages = await this.readPages();
    const kept = pages.filter((page) => page.sessionId === "" || sessionIds.has(page.sessionId));
    if (kept.length === pages.length) return 0;
    const dropped = pages.length - kept.length;
    if (apply) {
      this.pages = kept;
      await writeJsonAtomic(this.memoryFile, { pages: kept });
    }
    return dropped;
  }

  /**
   * Record where the pane is, for the conversation it is working for.
   *
   * Only somewhere the pane could actually go back to, which is why the URL is
   * put through the same policy a navigation is. A load that fails leaves
   * Chromium sitting on `chrome-error://chromewebdata/`, and remembering that
   * replaced the last good page with a string the policy refuses — so the next
   * launch restored nothing and the feature looked dead.
   *
   * Written through the same atomic helper every other store in the app uses:
   * a plain write that is cut short leaves a truncated file, and a file that
   * will not parse is a last page that never loads again. Best effort beyond
   * that — a failed write costs one restore, not a navigation.
   */
  private remember(url: string): void {
    if (url === "" || url === "about:blank" || url === this.lastUrl) return;
    if (!this.app.browserPolicy.check(url).allowed) return;
    this.lastUrl = url;
    void this.file(this.sessionId, url).catch(() => undefined);
  }

  /**
   * Put one page in the file, under the conversation that was open.
   *
   * Reads before it writes, because the file holds every other conversation's
   * page too and this runs on paths that never called {@link restore}.
   */
  private async file(sessionId: string, url: string): Promise<void> {
    const pages = await this.readPages();
    const entry: RememberedPage = { sessionId, url, at: new Date().toISOString() };
    // Newest first, and capped. Conversations accumulate forever and this file
    // is read on every restore, so old threads fall off the end rather than
    // growing a list nobody will ever navigate back into.
    this.pages = [entry, ...pages.filter((page) => page.sessionId !== sessionId)].slice(
      0,
      MAX_REMEMBERED_PAGES,
    );
    await writeJsonAtomic(this.memoryFile, { pages: this.pages });
  }
}

/**
 * One conversation's last page.
 *
 * An empty `sessionId` is the pane's own bucket: a fresh install has no
 * conversation to file against, and browsing then should still come back.
 */
interface RememberedPage {
  sessionId: string;
  url: string;
  /** ISO time it was recorded, so the newest entries are the ones kept. */
  at: string;
}

function isRememberedPage(value: unknown): value is RememberedPage {
  if (typeof value !== "object" || value === null) return false;
  const page = value as Record<string, unknown>;
  return (
    typeof page.sessionId === "string" &&
    typeof page.url === "string" &&
    page.url !== "" &&
    typeof page.at === "string"
  );
}

function emptySnapshot(): BrowserPageSnapshot {
  return {
    url: "",
    title: "",
    text: "",
    truncated: false,
    canGoBack: false,
    canGoForward: false,
    loading: false,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turn an element handle into a selector.
 *
 * The shape is validated rather than escaped: a handle comes from a model that
 * may be repeating text a remote page fed it, and an unvalidated value spliced
 * into a selector is an injection into our own query. Only handles this process
 * mints — `e` followed by digits — are ever resolved.
 */
function refSelector(ref: string): string {
  if (!/^e\d{1,6}$/.test(ref)) {
    throw new Error(`unknown element handle "${ref}" — call browser_elements first`);
  }
  return `[data-iq-ref="${ref}"]`;
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value) || value <= 0) return low;
  return Math.min(high, Math.max(low, Math.round(value)));
}
