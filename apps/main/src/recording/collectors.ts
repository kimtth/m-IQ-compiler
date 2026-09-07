import { createHash } from "node:crypto";
import { clipboard } from "electron";
import {
  MAX_CLIPBOARD_PREVIEW_CHARS,
  type RecEventInput,
  type WindowBounds,
} from "@iq/shared";
import type { RecordingCollector } from "@iq/core";
import { readActiveWindow, type ActiveWindowInfo } from "./win-active-window.js";
import { WindowsUrlProvider } from "./win-url-provider.js";

/**
 * The two collectors that turn a work session into a timeline.
 *
 * Both poll, because neither Windows nor Electron offers a change notification
 * worth having here: a foreground-window hook would need a message loop in a
 * process that has one already, and Electron's clipboard has no event at all.
 * Polling at human cadence is enough — the point is to know that the user moved
 * from Excel to Edge, not to catch it within a frame.
 */

/** Cadence for foreground-window polling. */
const WINDOW_POLL_MS = 1_000;
/**
 * Slower cadence while a browser is frontmost.
 *
 * The URL read walks a UI Automation tree in the browser's own process, and
 * doing that at full cadence is perceptible as stutter in the browser. We only
 * need the window poll to notice when the user switches away.
 */
const BROWSER_POLL_MS = 1_600;
/** Floor between URL reads while a browser stays frontmost, to catch SPA navs. */
const URL_MIN_INTERVAL_MS = 1_500;
const CLIPBOARD_POLL_MS = 700;

type Emit = (event: RecEventInput) => void;

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Emits `app.activate`, `app.title-change` and `browser.url`.
 *
 * Titles change far more often than applications — a spreadsheet reports every
 * saved edit — so the two are separate event types: `app.activate` is a step
 * boundary, `app.title-change` is detail within one.
 */
export class ActiveWindowCollector implements RecordingCollector {
  readonly name = "active-window";
  private timer: NodeJS.Timeout | null = null;
  private emit: Emit | null = null;
  private polling = false;
  private readonly urls: WindowsUrlProvider | null;

  private lastApp = "";
  private lastTitle = "";
  private lastUrl = "";
  private frontmostIsBrowser = false;
  private urlInFlight = false;
  private lastUrlAt = 0;

  constructor(options: { captureUrls: boolean }) {
    this.urls = options.captureUrls ? new WindowsUrlProvider() : null;
  }

  start(emit: Emit): void {
    this.emit = emit;
    void this.poll();
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.emit = null;
    this.urls?.dispose();
  }

  private schedule(): void {
    if (this.emit === null) return;
    this.timer = setTimeout(
      () => void this.poll(),
      this.frontmostIsBrowser ? BROWSER_POLL_MS : WINDOW_POLL_MS,
    );
  }

  private async poll(): Promise<void> {
    if (this.polling || this.emit === null) return;
    this.polling = true;
    try {
      const window = readActiveWindow();
      if (window !== null) this.process(window);
    } catch {
      // A failed read is one missing sample, not a reason to stop polling.
    } finally {
      this.polling = false;
      this.schedule();
    }
  }

  private process(window: ActiveWindowInfo): void {
    const emit = this.emit;
    if (emit === null) return;

    const app = window.app || "unknown";
    const title = window.title;
    const appChanged = app !== this.lastApp;
    const titleChanged = title !== "" && title !== this.lastTitle;

    if (appChanged) {
      // A new foreground application is a new context: let the URL re-emit even
      // if the tab is the one we already reported, because it now belongs to a
      // different step.
      this.lastUrl = "";
      emit({
        type: "app.activate",
        source: this.name,
        payload: {
          app,
          title,
          pid: window.pid,
          path: window.path,
          ...(window.bounds ? { bounds: window.bounds as WindowBounds } : {}),
        },
      });
    } else if (titleChanged) {
      emit({ type: "app.title-change", source: this.name, payload: { app, title } });
    }

    this.frontmostIsBrowser = this.urls?.supports(app) ?? false;
    if (this.frontmostIsBrowser && !this.urlInFlight) {
      const now = Date.now();
      if (appChanged || titleChanged || now - this.lastUrlAt >= URL_MIN_INTERVAL_MS) {
        this.readUrl(app);
      }
    }

    this.lastApp = app;
    this.lastTitle = title;
  }

  /** Fire and forget: the poll loop never waits on a UI Automation walk. */
  private readUrl(app: string): void {
    if (this.urls === null) return;
    this.urlInFlight = true;
    this.lastUrlAt = Date.now();
    void this.urls
      .get(app)
      .then((result) => {
        const emit = this.emit;
        if (emit === null || !result || result.url === this.lastUrl) return;
        this.lastUrl = result.url;
        const host = hostOf(result.url);
        emit({
          type: "browser.url",
          source: this.name,
          payload: {
            app,
            url: result.url,
            ...(host ? { host } : {}),
            ...(result.title ? { title: result.title } : {}),
          },
        });
      })
      .catch(() => undefined)
      .finally(() => {
        this.urlInFlight = false;
      });
  }
}

/**
 * Emits `clipboard.change`.
 *
 * Copy-then-paste is how a value moves between two applications, and it is
 * invisible to every other collector: the window title does not change and the
 * URL does not change, so without this the timeline shows the user idling
 * between two steps that are actually one.
 *
 * The clipboard's contents at session start are read once as a baseline and
 * never emitted, so the recording captures what was copied *during* the
 * session rather than whatever happened to be there beforehand.
 */
export class ClipboardCollector implements RecordingCollector {
  readonly name = "clipboard";
  private timer: NodeJS.Timeout | null = null;
  private emit: Emit | null = null;
  private lastSignature = "";

  start(emit: Emit): void {
    this.emit = emit;
    this.lastSignature = this.read().signature;
    this.timer = setInterval(() => this.poll(), CLIPBOARD_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit = null;
  }

  private read(): {
    signature: string;
    formats: string[];
    length: number;
    hash: string;
    textPreview?: string;
  } {
    const formats = clipboard.availableFormats();
    const text = clipboard.readText();

    let length = text.length;
    let hashInput: string | Buffer = text;
    let textPreview = text ? preview(text) : undefined;

    // An image has no text to preview, but its dimensions are enough to say
    // "a screenshot was copied here", which is often the whole step.
    if (!text && formats.some((format) => format.startsWith("image/"))) {
      const image = clipboard.readImage();
      if (!image.isEmpty()) {
        const png = image.toPNG();
        length = png.byteLength;
        hashInput = png;
        const { width, height } = image.getSize();
        textPreview = `[image ${width}x${height}]`;
      }
    }

    const hash = createHash("sha256").update(hashInput).digest("hex").slice(0, 16);
    return {
      signature: `${formats.join(",")}|${length}|${hash}`,
      formats,
      length,
      hash,
      ...(textPreview ? { textPreview } : {}),
    };
  }

  private poll(): void {
    const emit = this.emit;
    if (emit === null) return;
    try {
      const current = this.read();
      if (current.signature === this.lastSignature) return;
      this.lastSignature = current.signature;
      // A cleared clipboard is a change with nothing to say about it.
      if (current.formats.length === 0) return;
      emit({
        type: "clipboard.change",
        source: this.name,
        payload: {
          formats: current.formats,
          length: current.length,
          hash: current.hash,
          ...(current.textPreview ? { textPreview: current.textPreview } : {}),
        },
      });
    } catch {
      // The clipboard is briefly locked by whichever app is writing to it.
    }
  }
}

/** One line, whitespace collapsed, length-capped. */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_CLIPBOARD_PREVIEW_CHARS
    ? `${flat.slice(0, MAX_CLIPBOARD_PREVIEW_CHARS)}…`
    : flat;
}

export function createCollectors(options: { captureUrls: boolean }): RecordingCollector[] {
  if (process.platform !== "win32") return [new ClipboardCollector()];
  return [new ActiveWindowCollector(options), new ClipboardCollector()];
}
