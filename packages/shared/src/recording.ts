import { z } from "zod";
import { Trigger } from "./schedule.js";
import { SKILL_NAME_PATTERN } from "./skill.js";

/**
 * Skill Recording contracts.
 *
 * A person does a task once; the app watches, reconstructs what they did, and
 * turns that single run into something the agent can repeat — a skill or a
 * scheduled automation. The recording lifecycle is Record → Analyze → Approve
 * → Build, with three deliberate constraints.
 *
 *  1. **The artifact is a proposal, never an installation.** A build ends at
 *     `SkillStore.propose()` or a disabled `ScheduledJob`, because an
 *     agent-authored skill in this product is unloadable until a human approves
 *     it, and a procedure reconstructed from one screen recording is exactly the
 *     kind of thing that assumption exists for.
 *
 *  2. **Analysis is an egress, and egress is consented.** Everything up to
 *     Analyze happens on the device. Analyze sends the timeline, the frames and
 *     the narration to GitHub's cloud, which is this app's first bulk export of
 *     screen content — so it is gated by a versioned notice, the same mechanism
 *     meeting capture uses, rather than by a checkbox.
 *
 *  3. **Automations are `ScheduledJob`s.** The app already has a scheduler, so
 *     a built automation is a job with an objective, and the recording only has
 *     to produce that objective.
 *
 * Two time conventions live here on purpose. Anything on the *timeline* is
 * epoch milliseconds, because correlating a frame to an event is arithmetic and
 * ISO strings would only be parsed back. Anything on a *record* is an ISO
 * datetime, matching every other durable record in the app.
 */

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * Bumping this invalidates every earlier acknowledgement.
 *
 * Same rule as {@link RECORDING_NOTICE_VERSION} in `meeting.ts`: a change in
 * what is captured, or in where it goes, is re-consented rather than inherited.
 */
export const SKILL_RECORDING_NOTICE_VERSION = "2026-08";

export const SKILL_RECORDING_CAPTURE_NOTICE = `IQ Compiler will record what you do on this device until you stop it.

While recording, it captures on this device only:
- which application and window is in front, and its title
- the address of the page open in your browser
- a short preview of anything you copy
- a low-rate screen recording (about one frame a second)
- your spoken narration, if you turn it on

Nothing leaves this device while you record. Everything is written under your
IQ Compiler data directory and is readable by anyone who can sign in to it.

Do not type, paste, show or say passwords, tokens, keys or other secrets while
a recording is running.`;

export const SKILL_RECORDING_ANALYSIS_NOTICE = `Analysing sends this recording to GitHub Copilot.

That means leaving this device:
- the event timeline, including window titles, page addresses and clipboard previews
- the screen images extracted from the recording
- the transcript of your narration, if you recorded any

Review the recording before you analyse it. If it captured anything
confidential, delete it instead — analysis cannot be recalled once sent.

You are recorded as the person who authorised this.`;

/**
 * Acknowledgement that the captured recording may leave the device.
 *
 * Held separately from the capture notice because they are different
 * disclosures: capturing your own screen locally and uploading it to a cloud
 * service are not the same decision, and one notice would have to be wrong
 * about one of them.
 */
export const RecordingAnalysisConsent = z.object({
  noticeVersion: z.string(),
  acknowledgedByOid: z.string().min(1),
  acknowledgedByTenantId: z.string().min(1),
  acknowledgedByUsername: z.string().min(1),
  acknowledgedAt: z.string().datetime(),
  /**
   * Typed as a literal `true` so "not answered" and "answered no" cannot both
   * arrive as a falsy value some caller reads as consent.
   */
  contentReviewed: z.literal(true),
});
export type RecordingAnalysisConsent = z.infer<typeof RecordingAnalysisConsent>;

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

/**
 * Canonical event types.
 *
 * `terminal.command` is deliberately absent: no producer emits it, and a type
 * nothing can emit is a type that only ever misleads a reader of this file.
 */
export const RecEventType = z.enum([
  "session.start",
  "session.stop",
  /** A note the user pinned to the timeline while recording. */
  "marker",
  "app.activate",
  "app.title-change",
  "clipboard.change",
  "browser.url",
  "video.start",
  "video.stop",
  "frame.captured",
]);
export type RecEventType = z.infer<typeof RecEventType>;

export const WindowBounds = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type WindowBounds = z.infer<typeof WindowBounds>;

/**
 * The events that mean something happened.
 *
 * Correlation, step segmentation and the "did anything at all get captured?"
 * check all need the same answer, and three copies of this list would drift.
 * Video bookkeeping is excluded because a frame arriving is not the user doing
 * something.
 */
export const MEANINGFUL_EVENT_TYPES: readonly RecEventType[] = [
  "app.activate",
  "app.title-change",
  "browser.url",
  "clipboard.change",
  "marker",
];

export const isMeaningfulEvent = (type: string): boolean =>
  (MEANINGFUL_EVENT_TYPES as readonly string[]).includes(type);

/**
 * A captured event, as persisted to `events.jsonl`.
 *
 * The payload is a loose record rather than a discriminated union because this
 * is the *storage* shape: a log written by an older build must still parse, and
 * a strict union would make one unrecognised event type fail the whole file.
 * The typed contract is {@link RecEventPayloads}, applied by producers.
 */
export const RecEvent = z.object({
  /** Monotonic per-session index. The stable id everything else refers to. */
  seq: z.number().int().nonnegative(),
  /** Milliseconds since session start, derived from a monotonic clock. */
  t: z.number().int().nonnegative(),
  /** Wall-clock epoch milliseconds. */
  epoch: z.number().int().nonnegative(),
  type: z.string(),
  /** Which collector produced it. */
  source: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type RecEvent = z.infer<typeof RecEvent>;

export interface RecEventPayloads {
  "session.start": { platform: string };
  "session.stop": Record<string, never>;
  marker: { note: string };
  "app.activate": {
    app: string;
    title: string;
    url?: string;
    host?: string;
    pid?: number;
    path?: string;
    bounds?: WindowBounds;
  };
  "app.title-change": { app: string; title: string };
  /**
   * The clipboard content is never stored, only its length, a hash so repeats
   * collapse, and a short preview. The preview is what ties "copied the invoice
   * number" to "pasted it into the form" — the hash alone cannot.
   */
  "clipboard.change": {
    formats: string[];
    length: number;
    hash: string;
    textPreview?: string;
  };
  "browser.url": { app: string; url: string; host?: string; title?: string };
  "video.start": { file: string; fps: number };
  "video.stop": { file: string; fps: number };
  "frame.captured": { file: string; source: FrameSource; phash?: string };
}

/** A not-yet-persisted event. The store stamps `seq`, `t` and `epoch`. */
export type RecEventInput = {
  [K in keyof RecEventPayloads]: {
    type: K;
    source: string;
    payload: RecEventPayloads[K];
  };
}[keyof RecEventPayloads];

/** Longest clipboard preview retained. Beyond this the text is dropped. */
export const MAX_CLIPBOARD_PREVIEW_CHARS = 120;

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * Why a frame was kept.
 *
 * `event` frames were sampled because something happened; `scene` frames
 * because the screen changed on its own; `probe` frames were extracted later,
 * from the video, to answer a question the first pass could not.
 */
export const FrameSource = z.enum(["event", "scene", "probe"]);
export type FrameSource = z.infer<typeof FrameSource>;

export const FrameRecord = z.object({
  /** File name inside the session's `frames/` directory. Never a path. */
  file: z.string().min(1),
  /** Milliseconds since session start. */
  tMs: z.number().int().nonnegative(),
  source: FrameSource,
  /**
   * 64-bit difference hash, hex. Empty when hashing was unavailable, which
   * disables dedupe for that frame rather than dropping it.
   */
  phash: z.string().regex(/^([0-9a-f]{16})?$/i).default(""),
  width: z.number().int().nonnegative().default(0),
  height: z.number().int().nonnegative().default(0),
});
export type FrameRecord = z.infer<typeof FrameRecord>;

/** How far a frame may be from an event and still be said to show it. */
export const FRAME_CORRELATION_WINDOW_MS = 1_500;

export const CorrelatedFrame = FrameRecord.extend({
  /** Application and page in front when the frame was taken, if known. */
  app: z.string().default(""),
  url: z.string().default(""),
  title: z.string().default(""),
  /** Events within {@link FRAME_CORRELATION_WINDOW_MS} of this frame. */
  nearestEventSeqs: z.array(z.number().int()).default([]),
  nearestEventGapMs: z.number().int().nullable().default(null),
  /**
   * The screen changed and no event explains why.
   *
   * Usually a gap in the collectors — an in-page interaction changes nothing
   * the window title or the URL reports. Kept rather than discarded because it
   * is the honest signal that the timeline is incomplete there.
   */
  unexplained: z.boolean().default(false),
});
export type CorrelatedFrame = z.infer<typeof CorrelatedFrame>;

/** A meaningful event with no frame near it — the mirror-image gap. */
export const SilentEvent = z.object({
  seq: z.number().int(),
  type: z.string(),
  tMs: z.number().int().nonnegative(),
  nearestFrameGapMs: z.number().int().nullable().default(null),
});
export type SilentEvent = z.infer<typeof SilentEvent>;

export const CorrelationResult = z.object({
  frames: z.array(CorrelatedFrame).default([]),
  silentEvents: z.array(SilentEvent).default([]),
  stats: z.object({
    frameCount: z.number().int().nonnegative().default(0),
    unexplainedFrameCount: z.number().int().nonnegative().default(0),
    silentEventCount: z.number().int().nonnegative().default(0),
  }),
});
export type CorrelationResult = z.infer<typeof CorrelationResult>;

// ---------------------------------------------------------------------------
// The bundle — what the analyst reads
// ---------------------------------------------------------------------------

/** Why a new step began. The boundary rule that fired, kept for auditability. */
export const StepBoundary = z.enum(["start", "app-change", "url-change"]);
export type StepBoundary = z.infer<typeof StepBoundary>;

export const BundleStep = z.object({
  index: z.number().int().nonnegative(),
  /** Milliseconds since session start. */
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  boundary: StepBoundary,
  app: z.string().default(""),
  titles: z.array(z.string()).default([]),
  hosts: z.array(z.string()).default([]),
  urls: z.array(z.string()).default([]),
  clipboardPreviews: z.array(z.string()).default([]),
  markers: z.array(z.string()).default([]),
  /** Seqs of the events folded into this step. */
  eventSeqs: z.array(z.number().int()).default([]),
  /** Frame file names whose timestamps fall inside the step. */
  frames: z.array(z.string()).default([]),
  /** Deterministic one-line label, written by the segmenter, not a model. */
  summary: z.string().default(""),
});
export type BundleStep = z.infer<typeof BundleStep>;

/**
 * The compact, self-contained artifact handed to the analyst.
 *
 * Deterministic by construction: the same events and frames always produce the
 * same bundle. That is what makes an analysis reproducible enough to argue
 * with, and what lets the bundle be unit-tested without a model.
 */
export const SessionBundle = z.object({
  version: z.literal(1),
  session: z.object({
    id: z.string(),
    startedAt: z.number().int(),
    stoppedAt: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
    platform: z.string(),
    appVersion: z.string(),
  }),
  steps: z.array(BundleStep).default([]),
  stats: z.object({
    eventCount: z.number().int().nonnegative().default(0),
    meaningfulEventCount: z.number().int().nonnegative().default(0),
    stepCount: z.number().int().nonnegative().default(0),
    frameCount: z.number().int().nonnegative().default(0),
    unexplainedFrameCount: z.number().int().nonnegative().default(0),
    silentEventCount: z.number().int().nonnegative().default(0),
  }),
});
export type SessionBundle = z.infer<typeof SessionBundle>;

// ---------------------------------------------------------------------------
// Narration
// ---------------------------------------------------------------------------

export const NarrationSegment = z.object({
  /** Milliseconds since session start. */
  atMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string(),
});
export type NarrationSegment = z.infer<typeof NarrationSegment>;

export const NarrationTranscript = z.object({
  model: z.string().default(""),
  language: z.string().default(""),
  segments: z.array(NarrationSegment).default([]),
  updatedAt: z.string().datetime(),
});
export type NarrationTranscript = z.infer<typeof NarrationTranscript>;

// ---------------------------------------------------------------------------
// The recording itself
// ---------------------------------------------------------------------------

/**
 * Lifecycle of one recording.
 *
 * `discarded` is terminal and keeps the record: a recording someone threw away
 * still happened, and the audit log refers to it by id.
 */
export const RecordingStatus = z.enum([
  "recording",
  /** Stopped; frames and narration are still being finished. */
  "processing",
  "ready",
  "analysing",
  "analysed",
  "failed",
  "discarded",
]);
export type RecordingStatus = z.infer<typeof RecordingStatus>;

export const RecordingRecord = z.object({
  id: z.string(),
  /** Auto-named from the analysis when there is one; editable by hand. */
  title: z.string().default(""),
  status: RecordingStatus,
  platform: z.string().default(""),
  appVersion: z.string().default(""),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable().default(null),
  durationMs: z.number().int().nonnegative().default(0),
  eventCount: z.number().int().nonnegative().default(0),
  frameCount: z.number().int().nonnegative().default(0),
  /** Whether a screen video was captured. False is a supported recording. */
  hasVideo: z.boolean().default(false),
  /** Whether narration audio was captured, and whether it transcribed. */
  hasNarration: z.boolean().default(false),
  narrationTranscribed: z.boolean().default(false),
  /**
   * Recorded once, on first Analyze. Null means nothing has left the device.
   */
  analysisConsent: RecordingAnalysisConsent.nullable().default(null),
  /** Highest analysis revision on disk. 0 when never analysed. */
  analysisRevision: z.number().int().nonnegative().default(0),
  analysisApproved: z.boolean().default(false),
  /** Skill proposal produced from this recording, by name. */
  builtSkillName: z.string().nullable().default(null),
  /** Scheduled job produced from this recording, by id. */
  builtJobId: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  correlationId: z.string(),
});
export type RecordingRecord = z.infer<typeof RecordingRecord>;

/** Live recorder state, pushed to the renderer so the UI never polls. */
export const RecorderStatus = z.object({
  state: z.enum(["idle", "starting", "recording", "stopping"]),
  recordingId: z.string().nullable().default(null),
  startedAt: z.string().datetime().nullable().default(null),
  /** Events captured so far, so "is it working?" is answerable at a glance. */
  eventCount: z.number().int().nonnegative().default(0),
  frameCount: z.number().int().nonnegative().default(0),
  videoActive: z.boolean().default(false),
  narrationActive: z.boolean().default(false),
  /** Why recording is impossible right now. Empty when it is possible. */
  blockedReason: z.string().default(""),
});
export type RecorderStatus = z.infer<typeof RecorderStatus>;

// ---------------------------------------------------------------------------
// Analysis — what the recording turned out to be
// ---------------------------------------------------------------------------

export const Confidence = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

export const AnalysisStep = z.object({
  /** Assigned by the analyst (e.g. "s1"); how feedback targets one step. */
  id: z.string().min(1),
  /** Past-tense, addressed to the user: "Opened the release dashboard". */
  title: z.string(),
  detail: z.string().default(""),
  /** Milliseconds since session start. */
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
  apps: z.array(z.string()).default([]),
  /** Events, URLs or frame files the analyst leaned on. */
  evidence: z.array(z.string()).default([]),
  confidence: Confidence.default("medium"),
});
export type AnalysisStep = z.infer<typeof AnalysisStep>;

/** What the analyst submits. The service adds the engine-owned fields. */
export const AnalysisSubmission = z.object({
  /** 2–5 words, for lists. */
  title: z.string().default(""),
  intent: z.string().min(1),
  intentConfidence: Confidence.default("medium"),
  intentRationale: z.string().default(""),
  steps: z.array(AnalysisStep).default([]),
});
export type AnalysisSubmission = z.infer<typeof AnalysisSubmission>;

export const FeedbackEntry = z.object({
  /** The revision this feedback produced. */
  revision: z.number().int().positive(),
  at: z.string().datetime(),
  overall: z.string().default(""),
  steps: z.array(z.object({ stepId: z.string(), note: z.string() })).default([]),
});
export type FeedbackEntry = z.infer<typeof FeedbackEntry>;

export const RecordingAnalysis = z.object({
  version: z.literal(1),
  recordingId: z.string(),
  /** Bumped on every pass. Revision 1 is the first. */
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  title: z.string().default(""),
  intent: z.string(),
  intentConfidence: Confidence,
  intentRationale: z.string().default(""),
  steps: z.array(AnalysisStep).default([]),
  feedbackLog: z.array(FeedbackEntry).default([]),
  /**
   * The user has accepted this as what actually happened.
   *
   * A build reads an approved analysis and nothing else, so approval is the one
   * point where a person takes responsibility for the reconstruction before it
   * is generalised into something that runs unattended.
   */
  approved: z.boolean().default(false),
  approvedAt: z.string().datetime().nullable().default(null),
  /** The session that produced it, so the reasoning stays inspectable. */
  sessionId: z.string().nullable().default(null),
});
export type RecordingAnalysis = z.infer<typeof RecordingAnalysis>;

/** Feedback the UI sends for another pass. */
export const AnalysisFeedback = z.object({
  overall: z.string().max(4_000).default(""),
  steps: z
    .array(z.object({ stepId: z.string().min(1), note: z.string().min(1).max(2_000) }))
    .max(100)
    .default([]),
});
export type AnalysisFeedback = z.infer<typeof AnalysisFeedback>;

// ---------------------------------------------------------------------------
// The build — what the recording becomes
// ---------------------------------------------------------------------------

export const BuildKind = z.enum(["skill", "automation"]);
export type BuildKind = z.infer<typeof BuildKind>;

/**
 * A literal lifted out of the procedure and given a name.
 *
 * This is the generalisation mechanism. A recorded run is full of specifics —
 * one URL, one folder, one account — and a skill that hard-codes them repeats
 * that one run instead of learning from it. Naming them makes the difference
 * visible and, more importantly, editable: the body refers to `{{id}}` and the
 * user can see and change every constant in one place before approving.
 */
export const PlanValue = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/, "value id must be lowercase, digits or underscore"),
  name: z.string().min(1),
  value: z.string().default(""),
});
export type PlanValue = z.infer<typeof PlanValue>;

/**
 * A step either derives something or changes something.
 *
 * Splitting them keeps the plan honest about side effects: the actions are the
 * risky surface, and a reviewer approving a procedure that will run unattended
 * needs to see them without reading every sentence.
 */
export const PlanStepKind = z.enum(["calculation", "action"]);
export type PlanStepKind = z.infer<typeof PlanStepKind>;

export const PlanStep = z.object({
  kind: PlanStepKind,
  title: z.string().default(""),
  /** Imperative and generalised, not a transcript of the recorded run. */
  text: z.string().min(1),
  /** The governed tool this step uses, if any, e.g. "office_create_document". */
  tool: z.string().default(""),
});
export type PlanStep = z.infer<typeof PlanStep>;

/**
 * The builder's proposal, shown before anything is written.
 *
 * Two stages rather than one because the interesting failure is not a badly
 * worded skill, it is a wrongly generalised one — and that is only visible as a
 * plan. Once the plan reads right the prose is a formality.
 */
export const RecordingPlan = z.object({
  kind: BuildKind,
  name: z.string().regex(SKILL_NAME_PATTERN),
  title: z.string().min(1),
  /** Becomes the skill's `description`: says what it does and when to use it. */
  description: z.string().min(1),
  summary: z.string().default(""),
  /** How the one recorded run was turned into a general procedure. */
  generalization: z.string().default(""),
  values: z.array(PlanValue).default([]),
  steps: z.array(PlanStep).default([]),
  /** Proposed `allowed-tools` for the skill frontmatter. */
  allowedTools: z.array(z.string()).default([]),
  /** Automations only. Ignored for skills. */
  trigger: Trigger.nullable().default(null),
});
export type RecordingPlan = z.infer<typeof RecordingPlan>;

/** What the builder submits once the plan is confirmed. */
export const BuildSubmission = z.object({
  name: z.string().regex(SKILL_NAME_PATTERN),
  description: z.string().min(1),
  allowedTools: z.array(z.string()).default([]),
  /** Markdown procedure, referring to values by `{{id}}`. */
  body: z.string().min(1),
});
export type BuildSubmission = z.infer<typeof BuildSubmission>;

export const RecordingBuild = z.object({
  version: z.literal(1),
  recordingId: z.string(),
  kind: BuildKind,
  name: z.string(),
  description: z.string(),
  allowedTools: z.array(z.string()).default([]),
  body: z.string(),
  values: z.array(PlanValue).default([]),
  plan: RecordingPlan.nullable().default(null),
  createdAt: z.string().datetime(),
  /** Set once the artifact exists: a skill proposal name or a job id. */
  skillName: z.string().nullable().default(null),
  jobId: z.string().nullable().default(null),
  sessionId: z.string().nullable().default(null),
});
export type RecordingBuild = z.infer<typeof RecordingBuild>;

/**
 * Substitute `{{id}}` tokens for their literals.
 *
 * Deterministic and done here rather than by the model: a builder asked to
 * inline its own values would sometimes inline them wrongly, and the whole
 * point of naming a constant is that exactly one thing decides what it expands
 * to. An unknown token is left alone — it is more useful to see `{{invoice_id}}`
 * survive into the output than to have it silently become an empty string.
 */
export function renderValues(text: string, values: readonly PlanValue[]): string {
  if (values.length === 0) return text;
  const byId = new Map(values.map((v) => [v.id, v.value]));
  return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (whole, id: string) => {
    const found = byId.get(id.toLowerCase());
    return found === undefined ? whole : found;
  });
}

/** Coerce arbitrary text into a slug {@link SKILL_NAME_PATTERN} accepts. */
export function slugifyRecordingName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "recorded-skill";
}

/** Progress on a long-running analyse or build, pushed while it runs. */
export const RecordingProgress = z.object({
  recordingId: z.string(),
  phase: z.enum(["analysing", "planning", "building"]),
  /** One line naming what the agent is doing, for the UI. */
  message: z.string().default(""),
});
export type RecordingProgress = z.infer<typeof RecordingProgress>;

/**
 * A recording with nothing meaningful in it cannot be analysed.
 *
 * Below this the analyst has nothing to reconstruct and will confabulate a
 * procedure out of two window switches, which is worse than refusing.
 */
export const MIN_ANALYSABLE_EVENTS = 3;
