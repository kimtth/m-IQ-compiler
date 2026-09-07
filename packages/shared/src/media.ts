import { z } from "zod";

/**
 * Local media tooling: audio capture and on-device transcription.
 *
 * Meetly Lite transcribes with whisper.cpp and keeps Azure AI Speech as an
 * opt-in cloud path (meetly-lite/README.md). Both are adopted here, and both
 * are expressed the same way: an external executable the app *drives* rather
 * than embeds.
 *
 * Screen recording used to live here too and was removed. It was a second
 * capture pipeline, a second consent question, a second set of settings and a
 * second failure mode (FFmpeg exiting mid-capture), all in service of
 * producing a file whose only use in this app was to be transcribed — which
 * "Transcribe a file…" already does for a recording made by any screen
 * recorder the user already has.
 *
 * Two rules remain and are the reason this module exists at all.
 *
 *  1. **Absence is a first-class state, not an error.** FFmpeg and whisper.cpp
 *     are large native binaries with their own licences; the app is usable
 *     without either. Every surface reads {@link MediaStatus} and says what is
 *     missing and how to get it, rather than offering a control that throws.
 *  2. **The path is configuration, never a secret.** Nothing here is sensitive,
 *     so all of it is safe to persist, safe to show and safe to log — which is
 *     what lets the UI report *which* executable it resolved rather than a bare
 *     "not found".
 *
 * Where the audio goes is the one genuinely consequential choice, so it is
 * modelled as {@link TranscriptionEngine} and carried on every recording. A
 * transcript produced on-device and one produced in the cloud are not
 * interchangeable facts about a meeting, and a reader months later must be able
 * to tell which happened.
 */

/**
 * Who turns audio into text.
 *
 * `azure` sends audio to the tenant's Azure AI Speech resource. `whisper` runs
 * whisper.cpp against a local model and the audio never leaves the device. The
 * consent notice differs between the two for exactly that reason.
 */
export const TranscriptionEngine = z.enum(["azure", "whisper"]);
export type TranscriptionEngine = z.infer<typeof TranscriptionEngine>;

export const TRANSCRIPTION_ENGINE_LABELS = {
  azure: "Azure AI Speech",
  whisper: "Local Whisper",
} as const satisfies Record<TranscriptionEngine, string>;

/**
 * One external executable, as resolved right now.
 *
 * `path` is reported even when `available` is false: "we looked here and found
 * nothing" is a far more actionable message than "not found", and the path is
 * not sensitive.
 */
export const ToolStatus = z.object({
  /**
   * Defaulted to false, which is also the only sane reading of a status
   * constructed from nothing but a message: every such call site is describing
   * a tool it could *not* resolve.
   *
   * It was required, and the omission was not theoretical. `resolveModel`
   * builds `ToolStatus.parse({ message: "No Whisper model is selected…" })` —
   * the normal state of a machine with no local model — so `parse` threw,
   * `whisper.readiness()` threw, and `meetings:notice` returned an error. The
   * Record tab then sat on "Loading…" forever, which the old layout rendered
   * *instead of* the recording form. A missing default on one boolean was
   * enough to make the recorder unreachable on a fresh install.
   */
  available: z.boolean().default(false),
  /** Absolute path that was resolved, or "" when nothing was. */
  path: z.string().default(""),
  /** First line of the tool's own version banner, when it could be asked. */
  version: z.string().default(""),
  /** Where the path came from, so a surprising resolution is explainable. */
  source: z.enum(["setting", "environment", "prepared", "path", "missing"]).default("missing"),
  /** What is wrong and what to do about it. Empty when available. */
  message: z.string().default(""),
});
export type ToolStatus = z.infer<typeof ToolStatus>;

export const MediaStatus = z.object({
  ffmpeg: ToolStatus,
  ffprobe: ToolStatus,
  whisper: ToolStatus,
  /** The selected `ggml-*.bin`. Absent whisper.cpp still needs a model to run. */
  whisperModel: ToolStatus,
  /**
   * The native capture sidecar.
   *
   * Reported like any other external tool because it is one: it is built from
   * `native/iq-audio` by `pnpm prepare:audio` rather than shipped, so a machine
   * without it must be told what is missing instead of being offered a system
   * audio option that silently records nothing.
   */
  iqAudio: ToolStatus,
});
export type MediaStatus = z.infer<typeof MediaStatus>;

/**
 * One capture device the sidecar reported.
 *
 * `default` is the host's own choice, which is what a picker should preselect.
 */
export const AudioDevice = z.object({
  name: z.string(),
  default: z.boolean().default(false),
});
export type AudioDevice = z.infer<typeof AudioDevice>;

/**
 * What `iq-audio devices` answers.
 *
 * `loopbackSupported` is false everywhere but Windows, where WASAPI loopback is
 * the only way to capture what the other participants are saying. A surface
 * that offers system audio must read this rather than assume it.
 */
export const AudioDevices = z.object({
  inputs: z.array(AudioDevice).default([]),
  outputs: z.array(AudioDevice).default([]),
  loopbackSupported: z.boolean().default(false),
});
export type AudioDevices = z.infer<typeof AudioDevices>;

/**
 * User-editable media settings.
 *
 * Every path may be empty, which means "resolve it": an explicit setting wins,
 * then `IQ_FFMPEG`/`IQ_WHISPER`, then the copy `pnpm prepare:ffmpeg` downloaded
 * under the app's own tools directory, then whatever is on PATH. The order is
 * fixed so a user who set a path is never quietly overridden by a later
 * download.
 */
export const MediaSettingsInput = z.object({
  ffmpegPath: z.string().max(4096).default(""),
  ffprobePath: z.string().max(4096).default(""),
  whisperPath: z.string().max(4096).default(""),
  /** Absolute path to a whisper.cpp `ggml-*.bin` model file. */
  whisperModelPath: z.string().max(4096).default(""),
  /** Absolute path to the `iq-audio` capture sidecar. */
  iqAudioPath: z.string().max(4096).default(""),
  /** Which engine a new capture or import starts with. */
  defaultEngine: TranscriptionEngine.default("azure"),
});
export type MediaSettingsInput = z.input<typeof MediaSettingsInput>;
export type MediaSettings = z.infer<typeof MediaSettingsInput>;

/**
 * Media files Azure AI Speech will accept, and that FFmpeg can reduce to audio.
 *
 * MP4 is here because a screen recording someone already made is one of the
 * most common things to want a transcript of — and since this app no longer
 * records screens, it is the *only* way such a file arrives.
 */
export const IMPORTABLE_MEDIA_EXTENSIONS = [".wav", ".mp3", ".m4a", ".mp4"] as const;

/**
 * Azure's fast-transcription limits, restated so the refusal happens here
 * rather than as a 413 after a 250 MB upload.
 */
export const MAX_IMPORT_BYTES = 250 * 1024 * 1024;
export const MAX_IMPORT_DURATION_MS = 2 * 60 * 60 * 1000;
