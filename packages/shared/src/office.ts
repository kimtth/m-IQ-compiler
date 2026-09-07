import { z } from "zod";

/**
 * Office authoring contracts.
 *
 * Office mode drives OfficeCLI, a self-contained binary, as a subprocess: it
 * exposes no Node API, so the agent composes subcommands and the canvas renders
 * what comes back. Nothing here carries a command line from the renderer — the
 * renderer asks for status and for a preview, and the agent (through governed
 * tools) is the only thing that mutates a document.
 */

export const OfficeKind = z.enum(["docx", "xlsx", "pptx"]);
export type OfficeKind = z.infer<typeof OfficeKind>;

export const OFFICE_EXTENSIONS: Record<string, OfficeKind> = {
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".pptx": "pptx",
};

/** Skill name per output type; the directory name must match exactly. */
export const OFFICE_SKILLS = {
  docx: "officecli-docx",
  xlsx: "officecli-xlsx",
  pptx: "officecli-pptx",
} as const satisfies Record<OfficeKind, string>;

export const OfficeToolState = z.enum(["unknown", "ready", "installing", "missing", "error"]);
export type OfficeToolState = z.infer<typeof OfficeToolState>;

export const OfficeStatus = z.object({
  state: OfficeToolState,
  /** Pinned or discovered version, recorded in the audit record of every call. */
  version: z.string().default(""),
  /** `path` (discovered on PATH) or `managed` (installed into the app's tools). */
  origin: z.enum(["path", "managed", "none"]).default("none"),
  message: z.string().default(""),
});
export type OfficeStatus = z.infer<typeof OfficeStatus>;

/**
 * Subcommands the agent may compose.
 *
 * Kept as a closed set so a new verb cannot be smuggled in through an argument,
 * and so the destructive ones can be named in one place.
 */
export const OfficeSubcommand = z.enum([
  "create",
  "add",
  "set",
  "remove",
  "query",
  "batch",
  "merge",
  "validate",
  "view",
  "open",
  "close",
]);
export type OfficeSubcommand = z.infer<typeof OfficeSubcommand>;

/**
 * Never auto-approvable. Overwriting an existing file is handled separately,
 * because the verb alone does not reveal it.
 */
export const OFFICE_DESTRUCTIVE: readonly OfficeSubcommand[] = ["remove", "set", "merge"];

export const OfficePreviewFormat = z.enum(["html", "svg"]);
export type OfficePreviewFormat = z.infer<typeof OfficePreviewFormat>;

/**
 * One slide in a rendered deck, so the canvas can offer a working index.
 *
 * OfficeCLI's own HTML view ships a thumbnail navigator, but it is built by
 * script at load time and the canvas renders that markup with `sandbox=""` and
 * no `allow-scripts` — it is agent output, not a page we trust. So the frame
 * gets no navigator, and the list is published here for the *host* page to
 * draw, where clicking it is an ordinary React event rather than a promise the
 * sandbox will not keep.
 */
export const OfficePreviewSlide = z.object({
  /** 1-based slide number, as OfficeCLI numbers them. */
  number: z.number().int().positive(),
  /**
   * The slide's own first line of text, or "" when it has none yet.
   * The number is what identifies it; this is only there to be recognised.
   */
  title: z.string().default(""),
});
export type OfficePreviewSlide = z.infer<typeof OfficePreviewSlide>;

export const OfficePreview = z.object({
  /** Project-relative path of the artifact being previewed. */
  path: z.string(),
  kind: OfficeKind,
  format: OfficePreviewFormat,
  /** Rendered markup. Displayed sandboxed; it is generated, not trusted. */
  content: z.string(),
  generatedAt: z.string().datetime(),
  /**
   * The slides in `content`, in order. Empty for a document that has none —
   * a .docx, a .xlsx, an SVG render, or a deck that is still empty — and the
   * canvas then shows no index rather than an index of nothing.
   */
  slides: z.array(OfficePreviewSlide).default([]),
  /**
   * The slide's design size in points, or 0 when the render does not say.
   *
   * Needed because OfficeCLI fits slides to the viewport **with a script**
   * (`scaleSlides()`, re-run on resize), and the canvas frame runs none. Left
   * alone, every slide draws at its full 960pt and the frame shows the middle
   * of it. The host sizes the frame to the design width and scales the whole
   * frame instead, which needs the number rather than a guess — a 4:3 deck is
   * 720pt, not 960.
   */
  slideWidthPt: z.number().nonnegative().default(0),
  slideHeightPt: z.number().nonnegative().default(0),
  /**
   * True while a generation is in flight. The canvas labels the preview
   * read-only and warns that opening the file in the system app locks it.
   */
  generating: z.boolean().default(false),
  /**
   * Why this frame could not be rendered, empty when it could.
   *
   * A half-built document is often not renderable — a deck with no slides yet,
   * a workbook whose first sheet is still being added — and while the agent is
   * writing, that is the *expected* answer, not a fault. Reporting it as a
   * thrown error turned a healthy build into a stream of error toasts, so it is
   * carried here instead and the canvas keeps showing the last good frame.
   * A refusal (path escapes the project, no project bound) still throws:
   * that is a boundary being enforced, not a document being unready.
   */
  problem: z.string().default(""),
});
export type OfficePreview = z.infer<typeof OfficePreview>;

/**
 * A page rendered by the application that owns the format — PowerPoint or Word
 * on Windows — rather than by OfficeCLI's HTML view.
 *
 * This exists because the HTML preview is not a layout proof, and measurably
 * so. Rendering the same deck both ways: OfficeCLI's own `query` reports a body
 * placeholder's effective size as 24pt, its HTML writes `font-size:18pt` for
 * the same runs, and PowerPoint draws 24pt — so every layout-driven slide is
 * under-rendered by a quarter. Worse, text that does not fit is *clipped* in
 * the HTML view where PowerPoint spills it past the border, so an overflowing
 * slide looks very nearly fine. Both errors point the same way: the fast
 * preview flatters the document.
 *
 * It is a separate request, not a better `OfficePreview`, because it costs
 * 8–12 seconds and starts PowerPoint. That is fine to ask for; it is not fine
 * to do on every mutation while a deck is being written.
 */
export const OfficeRender = z.object({
  path: z.string(),
  kind: OfficeKind,
  /** PNG as a data URL, or "" when the render could not be produced. */
  image: z.string(),
  /** The page rendered, or null for a contact sheet of the whole document. */
  page: z.number().int().positive().nullable().default(null),
  generatedAt: z.string().datetime(),
  /**
   * Why there is no image. The common case is not a fault: `--render native`
   * requires PowerPoint or Word to be installed, and most machines the app
   * runs on will not have them. Reported rather than thrown so the surface can
   * say which renderer the user is looking at instead of showing an error.
   */
  problem: z.string().default(""),
});
export type OfficeRender = z.infer<typeof OfficeRender>;

/**
 * One Office artifact already sitting in the bound project.
 *
 * The mutation stream only tells the surface about documents written in this
 * app session. Reopening the app, or the surface, leaves it with nothing to
 * show even when the project is full of decks the agent wrote yesterday. This
 * is how the surface finds them.
 */
export const OfficeDocument = z.object({
  /** Project-relative path, which is what `office:preview` takes. */
  path: z.string(),
  kind: OfficeKind,
  bytes: z.number().int().nonnegative().default(0),
  /** Last write time, so the newest document can be the one that opens. */
  modifiedAt: z.string().datetime(),
});
export type OfficeDocument = z.infer<typeof OfficeDocument>;

/** Emitted whenever an OfficeCLI mutation lands, so the canvas can refresh. */
export const OfficeChange = z.object({
  path: z.string(),
  kind: OfficeKind,
  subcommand: OfficeSubcommand,
  projectId: z.string().nullable().default(null),
  at: z.string().datetime(),
  generating: z.boolean().default(false),
});
export type OfficeChange = z.infer<typeof OfficeChange>;

/**
 * The document one conversation is working on.
 *
 * The Office preview used to be a single global thing: it followed the newest
 * mutation from anywhere, so switching conversations left the wrong document on
 * screen. This is what makes the preview belong to the conversation.
 *
 * The project id is carried because a project-relative path is not unique
 * across projects, and opening the wrong `report.docx` is worse than opening
 * none.
 */
export const OfficeFocusEntry = z.object({
  sessionId: z.string(),
  projectId: z.string().nullable().default(null),
  /** Project-relative, the same form `office:preview` takes. */
  path: z.string(),
  at: z.string().datetime(),
});
export type OfficeFocusEntry = z.infer<typeof OfficeFocusEntry>;
