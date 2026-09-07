import {
  CorrelationResult,
  FRAME_CORRELATION_WINDOW_MS,
  MAX_CLIPBOARD_PREVIEW_CHARS,
  SessionBundle,
  isMeaningfulEvent,
  type BundleStep,
  type CorrelatedFrame,
  type FrameRecord,
  type RecEvent,
  type SilentEvent,
  type StepBoundary,
} from "@iq/shared";

/**
 * Turning a raw capture into the one artifact the analyst reads.
 *
 * Everything here is deterministic: the same events and frames always produce
 * the same bundle. That is the point. It means the segmentation can be argued
 * with and unit-tested without a model in the loop, and it means a disagreement
 * about what happened is a disagreement about the rules rather than about what
 * the model felt like saying that day.
 *
 * The pipeline is two passes:
 *
 *  1. **Correlation** — attach each frame to the events near it in time, and
 *     name the two ways the streams disagree. Those disagreements are kept
 *     rather than smoothed away; they are the honest signal that the timeline
 *     is incomplete somewhere.
 *  2. **Segmentation** — fold the events into steps at the boundaries a human
 *     would recognise, and attach each step's frames and evidence.
 */

/**
 * Time of an event, in milliseconds since the recording began.
 *
 * `epoch` rather than `t` because frames are timestamped by the compositor
 * against the wall clock, and comparing the two requires one origin. `t` stays
 * authoritative for ordering, where it is never wrong.
 */
const offsetOf = (event: RecEvent, startEpoch: number): number =>
  Math.max(0, Math.round(event.epoch - startEpoch));

export function correlate(input: {
  events: readonly RecEvent[];
  frames: readonly FrameRecord[];
  startEpoch: number;
  windowMs?: number;
}): CorrelationResult {
  const windowMs = input.windowMs ?? FRAME_CORRELATION_WINDOW_MS;
  const meaningful = input.events
    .filter((event) => isMeaningfulEvent(event.type))
    .map((event) => ({ event, tMs: offsetOf(event, input.startEpoch) }))
    .sort((a, b) => a.tMs - b.tMs);

  // The foreground context is carried forward: a frame taken thirty seconds
  // into reading a page has no event beside it, but we still know what was on
  // screen, and saying so is more use to the analyst than a blank.
  const context = new ContextTrack(input.events, input.startEpoch);
  const explainedSeqs = new Set<number>();

  const frames: CorrelatedFrame[] = input.frames
    .slice()
    .sort((a, b) => a.tMs - b.tMs)
    .map((frame) => {
      const near = meaningful.filter((entry) => Math.abs(entry.tMs - frame.tMs) <= windowMs);
      for (const entry of near) explainedSeqs.add(entry.event.seq);
      const gaps = near.map((entry) => Math.abs(entry.tMs - frame.tMs));
      const at = context.at(frame.tMs);
      return {
        ...frame,
        app: at.app,
        url: at.url,
        title: at.title,
        nearestEventSeqs: near.map((entry) => entry.event.seq),
        nearestEventGapMs: gaps.length > 0 ? Math.min(...gaps) : null,
        unexplained: near.length === 0,
      };
    });

  const silentEvents: SilentEvent[] = meaningful
    .filter((entry) => !explainedSeqs.has(entry.event.seq))
    .map((entry) => {
      const gaps = frames.map((frame) => Math.abs(frame.tMs - entry.tMs));
      return {
        seq: entry.event.seq,
        type: entry.event.type,
        tMs: entry.tMs,
        nearestFrameGapMs: gaps.length > 0 ? Math.min(...gaps) : null,
      };
    });

  return CorrelationResult.parse({
    frames,
    silentEvents,
    stats: {
      frameCount: frames.length,
      unexplainedFrameCount: frames.filter((frame) => frame.unexplained).length,
      silentEventCount: silentEvents.length,
    },
  });
}

/** What was in front at any moment, replayed from the activation events. */
class ContextTrack {
  private readonly points: { tMs: number; app: string; title: string; url: string }[] = [];

  constructor(events: readonly RecEvent[], startEpoch: number) {
    let app = "";
    let title = "";
    let url = "";
    for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
      const payload = event.payload as Record<string, unknown>;
      if (event.type === "app.activate") {
        app = str(payload["app"]);
        title = str(payload["title"]);
        // A new application means the previously known URL belongs to a window
        // that is no longer in front.
        url = "";
      } else if (event.type === "app.title-change") {
        title = str(payload["title"]);
      } else if (event.type === "browser.url") {
        url = str(payload["url"]);
      } else {
        continue;
      }
      this.points.push({ tMs: offsetOf(event, startEpoch), app, title, url });
    }
  }

  at(tMs: number): { app: string; title: string; url: string } {
    let current = { app: "", title: "", url: "" };
    for (const point of this.points) {
      if (point.tMs > tMs) break;
      current = { app: point.app, title: point.title, url: point.url };
    }
    return current;
  }
}

export interface BundleInput {
  recordingId: string;
  platform: string;
  appVersion: string;
  startEpoch: number;
  stopEpoch: number | null;
  events: readonly RecEvent[];
  frames: readonly FrameRecord[];
}

/**
 * Fold a capture into steps.
 *
 * A step boundary is a change of application or a change of URL, and nothing
 * else. Title changes are deliberately *not* boundaries: a spreadsheet renames
 * its window on every save, and treating that as a new step would shred a
 * single piece of work into a dozen meaningless fragments. Clipboard changes
 * are not boundaries either — a copy is the middle of a step, never its start.
 */
export function buildBundle(input: BundleInput): SessionBundle {
  const events = [...input.events].sort((a, b) => a.seq - b.seq);
  const correlation = correlate({
    events,
    frames: input.frames,
    startEpoch: input.startEpoch,
  });

  const durationMs =
    input.stopEpoch !== null
      ? Math.max(0, input.stopEpoch - input.startEpoch)
      : events.length > 0
        ? offsetOf(events[events.length - 1]!, input.startEpoch)
        : 0;

  const steps: BundleStep[] = [];
  let open: MutableStep | null = null;

  const close = (endMs: number): void => {
    if (open === null) return;
    steps.push(finish(open, endMs, correlation.frames));
    open = null;
  };

  for (const event of events) {
    if (!isMeaningfulEvent(event.type)) continue;
    const tMs = offsetOf(event, input.startEpoch);
    const payload = event.payload as Record<string, unknown>;

    const boundary = boundaryFor(event.type, payload, open);
    if (boundary !== null) {
      // Read before closing: a URL change stays inside the same application,
      // and `close` drops the reference the new step inherits it from.
      const previousApp: string = open?.app ?? "";
      close(tMs);
      open = {
        index: steps.length,
        startMs: tMs,
        boundary,
        app: event.type === "app.activate" ? str(payload["app"]) : previousApp,
        titles: [],
        hosts: [],
        urls: [],
        clipboardPreviews: [],
        markers: [],
        eventSeqs: [],
      };
    }
    if (open === null) {
      // Everything before the first boundary still belongs somewhere.
      open = {
        index: steps.length,
        startMs: tMs,
        boundary: "start",
        app: "",
        titles: [],
        hosts: [],
        urls: [],
        clipboardPreviews: [],
        markers: [],
        eventSeqs: [],
      };
    }

    open.eventSeqs.push(event.seq);
    absorb(open, event.type, payload);
  }

  close(durationMs);

  return SessionBundle.parse({
    version: 1,
    session: {
      id: input.recordingId,
      startedAt: input.startEpoch,
      stoppedAt: input.stopEpoch,
      durationMs,
      platform: input.platform,
      appVersion: input.appVersion,
    },
    steps,
    stats: {
      eventCount: events.length,
      meaningfulEventCount: events.filter((event) => isMeaningfulEvent(event.type)).length,
      stepCount: steps.length,
      frameCount: correlation.stats.frameCount,
      unexplainedFrameCount: correlation.stats.unexplainedFrameCount,
      silentEventCount: correlation.stats.silentEventCount,
    },
  });
}

interface MutableStep {
  index: number;
  startMs: number;
  boundary: StepBoundary;
  app: string;
  titles: string[];
  hosts: string[];
  urls: string[];
  clipboardPreviews: string[];
  markers: string[];
  eventSeqs: number[];
}

function boundaryFor(
  type: string,
  payload: Record<string, unknown>,
  open: MutableStep | null,
): StepBoundary | null {
  if (open === null) return "start";
  if (type === "app.activate") {
    return str(payload["app"]) === open.app ? null : "app-change";
  }
  if (type === "browser.url") {
    const url = str(payload["url"]);
    // Only a *different* page starts a step. A re-read of the same URL — which
    // the poller emits after any switch away and back — is the same work.
    return url !== "" && !open.urls.includes(url) && open.urls.length > 0 ? "url-change" : null;
  }
  return null;
}

function absorb(step: MutableStep, type: string, payload: Record<string, unknown>): void {
  const push = (list: string[], value: string): void => {
    if (value !== "" && !list.includes(value)) list.push(value);
  };
  switch (type) {
    case "app.activate":
      if (step.app === "") step.app = str(payload["app"]);
      push(step.titles, str(payload["title"]));
      break;
    case "app.title-change":
      push(step.titles, str(payload["title"]));
      break;
    case "browser.url":
      push(step.urls, str(payload["url"]));
      push(step.hosts, str(payload["host"]));
      break;
    case "clipboard.change":
      push(step.clipboardPreviews, str(payload["textPreview"]).slice(0, MAX_CLIPBOARD_PREVIEW_CHARS));
      break;
    case "marker":
      push(step.markers, str(payload["note"]));
      break;
    default:
      break;
  }
}

function finish(step: MutableStep, endMs: number, frames: readonly CorrelatedFrame[]): BundleStep {
  const end = Math.max(step.startMs, endMs);
  return {
    index: step.index,
    startMs: step.startMs,
    endMs: end,
    durationMs: end - step.startMs,
    boundary: step.boundary,
    app: step.app,
    titles: step.titles,
    hosts: step.hosts,
    urls: step.urls,
    clipboardPreviews: step.clipboardPreviews,
    markers: step.markers,
    eventSeqs: step.eventSeqs,
    frames: frames
      .filter((frame) => frame.tMs >= step.startMs && frame.tMs <= end)
      .map((frame) => frame.file),
    summary: summarise(step),
  };
}

/**
 * A one-line label, written by rules rather than by a model.
 *
 * The analyst gets to disagree with this — it is a hint, not a conclusion — but
 * it has to exist before any model runs, so that a bundle is readable by a
 * human debugging why an analysis came out wrong.
 */
function summarise(step: MutableStep): string {
  const where = step.hosts[0] ?? step.app;
  const what = step.titles[0] ?? step.urls[0] ?? "";
  if (where === "" && what === "") return "unattributed activity";
  if (what === "") return where;
  return `${where} — ${what}`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
