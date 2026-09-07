import { writeFile } from "node:fs/promises";
import {
  MAX_CLIPBOARD_PREVIEW_CHARS,
  RecordingRecord,
  SKILL_RECORDING_NOTICE_VERSION,
  newCorrelationId,
  type FrameRecord,
  type FrameSource,
  type RecEventInput,
  type RecorderStatus,
} from "@iq/shared";
import type { AuditLog } from "../audit/audit-log.js";
import type { Logger } from "../util/logger.js";
import { RecordingEventBus } from "./event-bus.js";
import { RecordingStore, frameFileName, newRecordingId } from "./store.js";

/**
 * One capture, from pressing record to a directory that can be analysed.
 *
 * Exactly one recording runs at a time, and that is a property of the machine
 * rather than a simplification: there is one screen and one foreground window,
 * so two concurrent captures would record the same thing twice and disagree
 * about it.
 *
 * ## Where consent applies
 *
 * Capture requires acknowledging the current notice; it does **not** require a
 * signed-in Microsoft account, because nothing leaves the device and requiring
 * an identity to watch your own screen locally would be a formality that only
 * blocks the feature. Analysis is the opposite case — it uploads screen content
 * — and {@link RecordingAnalyst} refuses it without an attributable identity.
 * The two notices are versioned separately for the same reason.
 *
 * ## What is injected, and why
 *
 * Collectors, the screen recorder and the narration recorder all arrive as
 * interfaces. Every one of them needs Electron or a native binary, and this
 * class is the piece worth testing: the state machine, the ordering of the
 * writes, and what happens when a capture is discarded halfway through.
 */

/** A source of timeline events. Started and stopped with the recording. */
export interface RecordingCollector {
  readonly name: string;
  start(emit: (event: RecEventInput) => void): Promise<void> | void;
  stop(): Promise<void> | void;
}

/** One still the screen recorder decided was worth keeping. */
export interface CapturedFrame {
  bytes: Uint8Array;
  /** Milliseconds since the recording started. */
  tMs: number;
  phash: string;
  width: number;
  height: number;
  source: FrameSource;
}

export interface ScreenRecorder {
  /**
   * Begin capturing. Returns null when capture is impossible, which is not an
   * error: a recording with a timeline and no frames is still analysable, and
   * failing the whole capture because a display could not be enumerated would
   * throw away the part that was working.
   */
  start(input: {
    videoFile: string;
    /** Wall-clock anchor the recording's `tMs` values are measured from. */
    startEpoch: number;
    onFrame: (frame: CapturedFrame) => void;
  }): Promise<{ fps: number } | null>;
  stop(): Promise<{ durationMs: number; bytes: number } | null>;
}

/**
 * The recorder used when the host supplies none — a headless test, or a
 * platform with no capture backend.
 *
 * It returns null from `start` rather than throwing, which is the same answer
 * a real recorder gives when no display can be enumerated. The capture then
 * proceeds with a timeline and no frames, and says so in its status, instead
 * of failing outright over the part that was never available.
 */
export const UNAVAILABLE_SCREEN_RECORDER: ScreenRecorder = {
  start: async () => null,
  stop: async () => null,
};

/** What went wrong, as text a log can actually print. */
const reason = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

export interface NarrationRecorder {
  start(input: { out: string; microphone: string }): Promise<void>;
  stop(): Promise<{ path: string; durationMs: number } | null>;
}

export interface RecorderControllerDeps {
  store: RecordingStore;
  audit: AuditLog;
  logger: Logger;
  appVersion: string;
  /** Rebuilt for each recording, so a collector cannot leak state between them. */
  collectors: () => RecordingCollector[];
  screen: () => ScreenRecorder;
  narration: () => NarrationRecorder;
  currentAccount: () => { oid: string; tenantId: string; username: string } | null;
  publish: (record: RecordingRecord) => void;
  publishStatus: (status: RecorderStatus) => void;
  now?: () => Date;
}

export interface StartRecordingInput {
  acknowledgedNoticeVersion: string;
  captureVideo: boolean;
  captureNarration: boolean;
  microphone: string;
}

/** Everything about the capture currently running. */
interface ActiveCapture {
  record: RecordingRecord;
  bus: RecordingEventBus;
  collectors: RecordingCollector[];
  screen: ScreenRecorder | null;
  narration: NarrationRecorder | null;
  frames: FrameRecord[];
  /** Next frame file number. Separate from the array so a drop cannot reuse one. */
  nextFrameIndex: number;
  startedAtMs: number;
}

export class RecorderController {
  private active: ActiveCapture | null = null;
  /** Set while start or stop is in flight, so the UI can show the transition. */
  private transition: "starting" | "stopping" | null = null;
  /** Serialises start/stop/discard: they are not safe to interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: RecorderControllerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  status(): RecorderStatus {
    const active = this.active;
    return {
      state: this.transition ?? (active ? "recording" : "idle"),
      recordingId: active?.record.id ?? null,
      startedAt: active?.record.startedAt ?? null,
      eventCount: active?.bus.count ?? 0,
      frameCount: active?.frames.length ?? 0,
      videoActive: active !== null && active.screen !== null,
      narrationActive: active !== null && active.narration !== null,
      blockedReason: "",
    };
  }

  private emitStatus(): void {
    this.deps.publishStatus(this.status());
  }

  /** Run one lifecycle operation at a time, in the order they were asked for. */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // --- start --------------------------------------------------------------

  start(input: StartRecordingInput): Promise<RecordingRecord> {
    return this.serial(() => this.startNow(input));
  }

  private async startNow(input: StartRecordingInput): Promise<RecordingRecord> {
    const correlationId = newCorrelationId();
    const account = this.deps.currentAccount();
    const actor = account
      ? ({ kind: "user", oid: account.oid, tenantId: account.tenantId } as const)
      : ({ kind: "system" } as const);

    const refuse = async (reason: string): Promise<Error> => {
      await this.deps.audit.record({
        actor,
        action: "recording.capture_refused",
        family: "recording",
        outcome: "denied",
        correlationId,
        reason,
      });
      return new Error(reason);
    };

    if (this.active !== null) throw await refuse("a recording is already running");
    if (input.acknowledgedNoticeVersion !== SKILL_RECORDING_NOTICE_VERSION) {
      throw await refuse(
        `the recording notice has changed (acknowledged ${input.acknowledgedNoticeVersion}, ` +
          `current ${SKILL_RECORDING_NOTICE_VERSION}); read it again before recording`,
      );
    }

    this.transition = "starting";
    this.emitStatus();

    try {
      const startedAt = this.now();
      const id = newRecordingId(startedAt);
      await this.deps.store.ensureDir(id);

      const record = RecordingRecord.parse({
        id,
        title: "",
        status: "recording",
        platform: process.platform,
        appVersion: this.deps.appVersion,
        startedAt: startedAt.toISOString(),
        correlationId,
      });

      const capture: ActiveCapture = {
        record,
        bus: new RecordingEventBus({
          write: (events) => this.deps.store.appendEvents(id, events),
          now: () => this.now(),
          onEvent: () => this.emitStatus(),
          onError: (error) => this.deps.logger.warn("recording event write failed", { id, error }),
        }),
        collectors: [],
        screen: null,
        narration: null,
        frames: [],
        nextFrameIndex: 0,
        startedAtMs: startedAt.getTime(),
      };
      this.active = capture;

      capture.bus.emit({
        type: "session.start",
        source: "controller",
        payload: { platform: process.platform },
      });

      // Media first, collectors last. A screen recorder that cannot start says
      // so before any collector has written an event, which keeps a failed
      // start from leaving a timeline nobody asked for.
      if (input.captureVideo) {
        const screen = this.deps.screen();
        const started = await screen
          .start({
            videoFile: this.deps.store.file(id, "video"),
            startEpoch: startedAt.getTime(),
            onFrame: (frame) => void this.onFrame(capture, frame),
          })
          .catch((error: unknown) => {
            // `message`, not the error object: a thrown `Error` has
            // non-enumerable fields, so logging it whole prints `{}`.
            this.deps.logger.warn("screen capture unavailable", { id, error: reason(error) });
            return null;
          });
        if (started !== null) {
          capture.screen = screen;
          capture.record = { ...capture.record, hasVideo: true };
          capture.bus.emit({
            type: "video.start",
            source: "screen",
            payload: { file: "video.webm", fps: started.fps },
          });
        }
      }

      if (input.captureNarration) {
        const narration = this.deps.narration();
        const ok = await narration
          .start({ out: this.deps.store.file(id, "narrationAudio"), microphone: input.microphone })
          .then(() => true)
          .catch((error: unknown) => {
            this.deps.logger.warn("narration capture unavailable", { id, error: reason(error) });
            return false;
          });
        if (ok) {
          capture.narration = narration;
          capture.record = { ...capture.record, hasNarration: true };
        }
      }

      capture.collectors = this.deps.collectors();
      for (const collector of capture.collectors) {
        try {
          await collector.start((event) => {
            if (this.active === capture) capture.bus.emit(event);
          });
        } catch (error) {
          this.deps.logger.warn("collector failed to start", {
            id,
            collector: collector.name,
            error,
          });
        }
      }

      await this.deps.store.save(capture.record);
      await this.deps.audit.record({
        actor,
        action: "recording.capture_started",
        family: "recording",
        outcome: "allowed",
        correlationId,
        resources: [id],
        reason: `video=${capture.record.hasVideo} narration=${capture.record.hasNarration}`,
      });

      this.transition = null;
      this.emitStatus();
      this.deps.publish(capture.record);
      return capture.record;
    } catch (error) {
      // A half-started capture must not survive as a recording nobody can stop.
      await this.teardown("discard").catch(() => undefined);
      this.transition = null;
      this.emitStatus();
      throw error;
    }
  }

  // --- while recording ----------------------------------------------------

  /**
   * Persist one frame and note it on the timeline.
   *
   * Frames are written here rather than by the screen recorder so that the file
   * name, the manifest entry and the `frame.captured` event are produced by one
   * piece of code. When those three disagree the frame is unreachable, and that
   * is the kind of drift that only shows up in an analysis that quietly lost
   * half its evidence.
   */
  private async onFrame(capture: ActiveCapture, frame: CapturedFrame): Promise<void> {
    if (this.active !== capture) return;
    const file = frameFileName(capture.nextFrameIndex++);
    try {
      await writeFile(this.deps.store.framePath(capture.record.id, file), frame.bytes);
    } catch (error) {
      this.deps.logger.warn("frame write failed", { id: capture.record.id, file, error });
      return;
    }
    if (this.active !== capture) return;
    capture.frames.push({
      file,
      tMs: Math.max(0, Math.round(frame.tMs)),
      source: frame.source,
      phash: frame.phash,
      width: frame.width,
      height: frame.height,
    });
    capture.bus.emit({
      type: "frame.captured",
      source: "screen",
      payload: { file, source: frame.source, phash: frame.phash },
    });
  }

  /** Pin a note to the timeline. Returns false when nothing is recording. */
  marker(note: string): boolean {
    const capture = this.active;
    if (capture === null) return false;
    capture.bus.emit({
      type: "marker",
      source: "user",
      payload: { note: note.slice(0, MAX_CLIPBOARD_PREVIEW_CHARS * 4) },
    });
    return true;
  }

  // --- stop and discard ---------------------------------------------------

  stop(): Promise<RecordingRecord> {
    return this.serial(async () => {
      const record = await this.teardown("save");
      if (record === null) throw new Error("nothing is recording");
      return record;
    });
  }

  discard(): Promise<void> {
    return this.serial(async () => {
      await this.teardown("discard");
    });
  }

  /**
   * Stop everything and settle the record.
   *
   * The order matters and is the reverse of start: collectors first, so nothing
   * can append after the log is closed; then the bus, so every event is on disk
   * before anything reads it; then the media, which owns files of its own.
   */
  private async teardown(outcome: "save" | "discard"): Promise<RecordingRecord | null> {
    const capture = this.active;
    if (capture === null) return null;

    this.transition = "stopping";
    this.emitStatus();
    const id = capture.record.id;

    for (const collector of capture.collectors) {
      try {
        await collector.stop();
      } catch (error) {
        this.deps.logger.warn("collector failed to stop", {
          id,
          collector: collector.name,
          error,
        });
      }
    }

    let videoBytes = 0;
    if (capture.screen !== null) {
      const stopped = await capture.screen.stop().catch((error) => {
        this.deps.logger.warn("screen capture failed to stop", { id, error });
        return null;
      });
      videoBytes = stopped?.bytes ?? 0;
      capture.bus.emit({
        type: "video.stop",
        source: "screen",
        payload: { file: "video.webm", fps: 0 },
      });
    }

    let narrationOk = false;
    if (capture.narration !== null) {
      const stopped = await capture.narration.stop().catch((error) => {
        this.deps.logger.warn("narration capture failed to stop", { id, error });
        return null;
      });
      narrationOk = (stopped?.durationMs ?? 0) > 0;
    }

    capture.bus.emit({ type: "session.stop", source: "controller", payload: {} });
    await capture.bus.close();

    // Cleared before the last writes so that a slow disk cannot leave the UI
    // saying "recording" after every collector has already stopped.
    this.active = null;
    this.transition = null;

    const endedAt = this.now();
    const settled: RecordingRecord = {
      ...capture.record,
      status: outcome === "discard" ? "discarded" : "ready",
      endedAt: endedAt.toISOString(),
      durationMs: Math.max(0, endedAt.getTime() - capture.startedAtMs),
      eventCount: capture.bus.count,
      frameCount: capture.frames.length,
      hasVideo: capture.record.hasVideo && videoBytes > 0,
      hasNarration: capture.record.hasNarration && narrationOk,
    };

    if (outcome === "discard") {
      await this.deps.store.remove(id).catch((error) => {
        this.deps.logger.warn("discarded recording could not be removed", { id, error });
      });
    } else {
      await this.deps.store.writeFrames(id, capture.frames);
      await this.deps.store.save(settled);
    }

    await this.deps.audit.record({
      actor: this.actor(),
      action: outcome === "discard" ? "recording.capture_discarded" : "recording.capture_stopped",
      family: "recording",
      outcome: "succeeded",
      correlationId: settled.correlationId,
      resources: [id],
      reason: `events=${settled.eventCount} frames=${settled.frameCount}`,
    });

    this.emitStatus();
    if (outcome !== "discard") this.deps.publish(settled);
    return settled;
  }

  private actor(): { kind: "user"; oid: string; tenantId: string } | { kind: "system" } {
    const account = this.deps.currentAccount();
    return account
      ? { kind: "user", oid: account.oid, tenantId: account.tenantId }
      : { kind: "system" };
  }

  /**
   * Close out anything a crash left open, on the next start.
   *
   * A record still marked `recording` describes a capture whose collectors died
   * with the process. Its timeline is whatever reached disk, which is usually
   * most of it — so it is settled as `ready` rather than deleted, and the
   * duration is taken from the last event rather than from now, which would
   * otherwise report an overnight crash as a fourteen-hour recording.
   */
  async reconcileOnBoot(): Promise<number> {
    let closed = 0;
    for (const record of await this.deps.store.list()) {
      if (record.status !== "recording" && record.status !== "processing") continue;
      const events = await this.deps.store.readEvents(record.id).catch(() => []);
      const last = events.at(-1);
      const durationMs = last?.t ?? 0;
      await this.deps.store.save({
        ...record,
        status: events.length > 0 ? "ready" : "failed",
        endedAt: new Date(new Date(record.startedAt).getTime() + durationMs).toISOString(),
        durationMs,
        eventCount: events.length,
        error:
          events.length > 0
            ? "recording was interrupted; the timeline may be incomplete"
            : "the recording was interrupted before anything was captured",
      });
      closed += 1;
    }
    await this.deps.store.sweepOrphans().catch(() => 0);
    return closed;
  }
}
