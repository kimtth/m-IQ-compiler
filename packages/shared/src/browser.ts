import { z } from "zod";

/**
 * Built-in browser pane.
 *
 * The renderer here is sandboxed with `webviewTag: false` and a `default-src
 * 'none'` policy, so the pane cannot be an element inside the renderer's
 * document or host remote content at all.
 *
 * So the page does not run in this application. It runs in a separate browser
 * process driven by Playwright; its viewport is streamed to the renderer as
 * JPEG frames with `Page.startScreencast`, and the user's clicks and keystrokes
 * are forwarded back into it as CDP input events. What the renderer holds is a
 * picture of a page, never the page itself: no remote DOM, no remote script,
 * and no path from a hostile site to the preload bridge.
 *
 * This is the shape VS Code's Edge DevTools extension uses for its Screencast
 * panel, and it is what lets one browser be both the surface the user operates
 * and the surface the agent automates.
 */

/** Where the renderer wants the pane drawn, in CSS pixels of the content area. */
export const BrowserBounds = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
});
export type BrowserBounds = z.infer<typeof BrowserBounds>;

export const BrowserVerdict = z.object({
  allowed: z.boolean(),
  /** Normalized URL actually used; empty when the URL could not be parsed. */
  url: z.string().default(""),
  host: z.string().default(""),
  reason: z.string().default(""),
});
export type BrowserVerdict = z.infer<typeof BrowserVerdict>;

/**
 * Whether a browser engine is available to drive.
 *
 * The page runs in a real Edge or Chrome installed on the machine; nothing is
 * downloaded. When neither is present the pane says so with the next step,
 * rather than failing at the moment the agent first tries to open a page.
 */
export const BrowserEngine = z.enum(["idle", "starting", "ready", "unavailable"]);
export type BrowserEngine = z.infer<typeof BrowserEngine>;

export const BrowserState = z.object({
  /** False when tenant policy disables the pane entirely. */
  enabled: z.boolean(),
  /** True once a page has been loaded and the view exists. */
  open: z.boolean(),
  visible: z.boolean(),
  url: z.string().default(""),
  title: z.string().default(""),
  loading: z.boolean().default(false),
  canGoBack: z.boolean().default(false),
  canGoForward: z.boolean().default(false),
  /** Why the last navigation was refused, if it was. */
  blocked: z.string().default(""),
  /**
   * Host patterns tenant policy refuses. Normally empty: the pane loads the
   * open web, and only an explicit tenant deny-list narrows it. Surfaced so a
   * refusal has a visible rule behind it rather than looking like a bug.
   */
  deniedHosts: z.array(z.string()).default([]),
  engine: BrowserEngine.default("idle"),
  /** Which channel is driving — `msedge`, `chrome` — or why none could be. */
  engineDetail: z.string().default(""),
});
export type BrowserState = z.infer<typeof BrowserState>;

/** One screencast frame: a picture of the page, and nothing executable. */
export const BrowserFrame = z.object({
  /** Base64 JPEG. */
  data: z.string(),
  /** Size of the captured viewport in CSS pixels, for coordinate mapping. */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** How far the page is scrolled, so the renderer can map clicks correctly. */
  offsetTop: z.number().default(0),
  scale: z.number().default(1),
});
export type BrowserFrame = z.infer<typeof BrowserFrame>;

/**
 * Input travelling the other way: renderer to page.
 *
 * Text is deliberately a separate kind from keys. Synthesised key events carry
 * a keycode, which cannot express Hangul, kana, or anything else an IME
 * composes — those arrive already committed and are inserted as text. Keys are
 * reserved for the control set (Enter, Tab, arrows) where a keycode is the
 * point.
 */
const coord = z.number().min(-100_000).max(100_000);

export const BrowserInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mouse"),
    type: z.enum(["mousePressed", "mouseReleased", "mouseMoved"]),
    x: coord,
    y: coord,
    button: z.enum(["left", "middle", "right", "none"]).default("none"),
    clickCount: z.number().int().min(0).max(3).default(0),
  }),
  z.object({
    kind: z.literal("wheel"),
    x: coord,
    y: coord,
    deltaX: coord.default(0),
    deltaY: coord.default(0),
  }),
  z.object({
    kind: z.literal("text"),
    /** Already composed by the user's IME. Capped so one paste cannot flood. */
    text: z.string().min(1).max(4_000),
  }),
  z.object({
    kind: z.literal("key"),
    key: z.string().min(1).max(32),
    code: z.string().max(32).default(""),
    keyCode: z.number().int().min(0).max(255).default(0),
    ctrl: z.boolean().default(false),
    alt: z.boolean().default(false),
    shift: z.boolean().default(false),
    meta: z.boolean().default(false),
  }),
]);
export type BrowserInput = z.infer<typeof BrowserInput>;
