import { stat } from "node:fs/promises";
import { MIN_TRANSCRIBABLE_BYTES, NarrationTranscript } from "@iq/shared";
import type { AudioCapture, AudioSidecar } from "../media/audio.js";
import type { WhisperService } from "../media/whisper.js";
import type { Logger } from "../util/logger.js";
import type { NarrationRecorder } from "./controller.js";
import type { RecordingStore } from "./store.js";

/**
 * Optional spoken narration over a recording.
 *
 * A timeline says what the user did; narration is the only channel that says
 * *why*. "This one's a duplicate, so I'm skipping it" is the difference between
 * a skill that copies a click and a skill that knows the rule behind it — and
 * no amount of screen capture recovers it.
 *
 * It reuses the same two services meetings do, rather than the reference's
 * in-process Whisper: {@link AudioSidecar} for capture and {@link WhisperService}
 * for transcription, both already on disk and already governed. Transcription is
 * on-device, so the audio never leaves the machine before the consent gate.
 */

export class SidecarNarrationRecorder implements NarrationRecorder {
  private capture: AudioCapture | null = null;

  constructor(
    private readonly audio: AudioSidecar,
    private readonly logger: Logger,
  ) {}

  async start(input: { out: string; microphone: string }): Promise<void> {
    // Microphone only. System audio would pick up whatever the user is watching
    // — a meeting, a video — none of which they consented to record here.
    //
    // An unnamed device falls back to `default` rather than to nothing: the
    // sidecar is asked for at least one source, and passing neither `--mic` nor
    // `--system` makes it exit with "nothing to capture".
    this.capture = await this.audio.start({
      out: input.out,
      microphone: input.microphone || "default",
      system: false,
    });
  }

  async stop(): Promise<{ path: string; durationMs: number } | null> {
    const capture = this.capture;
    this.capture = null;
    if (capture === null) return null;
    try {
      const result = await capture.stop();
      return { path: result.path, durationMs: result.durationMs };
    } catch (error) {
      this.logger.warn("narration capture failed to finalise", { error });
      capture.cancel();
      return null;
    }
  }
}

export interface NarrationTranscriberDeps {
  store: RecordingStore;
  whisper: WhisperService;
  logger: Logger;
  now?: () => Date;
}

export class NarrationTranscriber {
  /** One transcription per recording at a time; the second caller joins the first. */
  private readonly inFlight = new Map<string, Promise<NarrationTranscript | null>>();

  constructor(private readonly deps: NarrationTranscriberDeps) {}

  /**
   * Transcribe a recording's narration, or return what is already on disk.
   *
   * whisper.cpp is CPU-bound and slower than real time on a laptop, so this is
   * never awaited by the capture path. Analysis waits for it instead — a
   * transcript that arrives after the analyst has read the timeline explains
   * nothing to anyone.
   */
  async ensure(recordingId: string, correlationId: string): Promise<NarrationTranscript | null> {
    const existing = await this.deps.store.readNarration(recordingId);
    if (existing !== null) return existing;

    const running = this.inFlight.get(recordingId);
    if (running) return running;

    const task = this.transcribe(recordingId, correlationId).finally(() => {
      this.inFlight.delete(recordingId);
    });
    this.inFlight.set(recordingId, task);
    return task;
  }

  private async transcribe(
    recordingId: string,
    correlationId: string,
  ): Promise<NarrationTranscript | null> {
    const audioPath = this.deps.store.file(recordingId, "narrationAudio");
    const bytes = await stat(audioPath)
      .then((info) => info.size)
      .catch(() => 0);
    // Below this there is no speech, only the WAV header and a moment of room
    // tone; running whisper on it would burn a minute to produce nothing.
    if (bytes < MIN_TRANSCRIBABLE_BYTES) return null;

    try {
      const result = await this.deps.whisper.transcribeFile({ mediaPath: audioPath, correlationId });
      const transcript = NarrationTranscript.parse({
        model: "whisper.cpp",
        language: result.locale,
        segments: result.segments
          // Whisper emits timestamped silence as empty or musical-note segments;
          // they would appear in the analyst's evidence as narration that said
          // nothing.
          .filter((segment) => segment.text.trim().length > 0)
          .map((segment) => ({
            atMs: segment.startMs,
            endMs: segment.endMs,
            text: segment.text.trim(),
          })),
        updatedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      });
      await this.deps.store.writeNarration(recordingId, transcript);
      return transcript;
    } catch (error) {
      this.deps.logger.warn("narration transcription failed", { recordingId, error });
      return null;
    }
  }
}
