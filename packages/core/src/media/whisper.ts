import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { TranscriptSegment, type MediaSettings, type TranscriptionResult } from "@iq/shared";
import type { Logger } from "../util/logger.js";
import type { AppPaths } from "../config/paths.js";
import { resolveMediaTools } from "./tools.js";
import { MediaToolMissingError, type FfmpegService } from "./ffmpeg.js";

const run = promisify(execFile);

/**
 * On-device transcription with whisper.cpp.
 *
 * The reason this exists next to {@link SpeechService} rather than behind it is
 * that they are not interchangeable implementations of one idea. Azure AI
 * Speech sends the room's audio to a cloud service and returns diarized
 * speakers; whisper.cpp keeps the audio on the device and returns none. Hiding
 * that behind a common interface would let a caller pick "transcription" and
 * silently change where the audio goes, which is the one decision in this
 * feature that must always be explicit — so the engine is chosen by the user,
 * carried on the consent, and stored on the meeting.
 *
 * The transport is a child process, not a binding. whisper.cpp is C++ and its
 * bindings need a toolchain at install time; an Electron app that requires
 * Visual Studio Build Tools to `pnpm install` is not an app anyone will run.
 * `whisper-cli` with `-oj` writes a JSON file this class parses, which costs one
 * temp file and buys a dependency-free install.
 */

export interface WhisperDeps {
  paths: AppPaths;
  logger: Logger;
  settings: () => MediaSettings;
  /** Used to normalise input to the 16 kHz mono WAV whisper.cpp requires. */
  ffmpeg: FfmpegService;
}

/** whisper.cpp is slow on CPU; an hour of audio can genuinely take an hour. */
const WHISPER_TIMEOUT_MS = 4 * 60 * 60 * 1000;

interface WhisperJson {
  transcription?: Array<{
    timestamps?: { from?: string; to?: string };
    offsets?: { from?: number; to?: number };
    text?: string;
  }>;
}

export class WhisperService {
  constructor(private readonly deps: WhisperDeps) {}

  /** Whether a local transcription could run right now, and why not if it cannot. */
  async readiness(): Promise<{ ready: boolean; message: string }> {
    const tools = await resolveMediaTools(this.deps.settings(), this.deps.paths);
    if (!tools.whisper.status.available) return { ready: false, message: tools.whisper.status.message };
    if (!tools.whisperModel.available) return { ready: false, message: tools.whisperModel.message };
    return { ready: true, message: "" };
  }

  /**
   * Transcribe a media file on this device.
   *
   * `mediaPath` may be anything FFmpeg reads: the WAV conversion happens here
   * rather than at the call sites, because every call site would otherwise have
   * to know whisper.cpp's input constraint and one of them would forget.
   */
  async transcribeFile(input: {
    mediaPath: string;
    locale?: string;
    correlationId: string;
  }): Promise<TranscriptionResult> {
    const settings = this.deps.settings();
    const tools = await resolveMediaTools(settings, this.deps.paths);
    if (tools.whisper.command === null) throw new MediaToolMissingError(tools.whisper.status.message);
    if (!tools.whisperModel.available) throw new MediaToolMissingError(tools.whisperModel.message);

    const stem = this.deps.ffmpeg.scratchPath(`whisper-${input.correlationId}`);
    const wav = `${stem}.wav`;
    // whisper-cli appends `.json` to whatever `-of` names, so the stem is
    // handed over bare and the reader adds the extension back.
    const jsonPath = `${stem}.json`;

    try {
      await this.deps.ffmpeg.toWhisperWav(input.mediaPath, wav);

      const language = (input.locale ?? "").split("-")[0] || "auto";
      const args = [
        "-m",
        tools.whisperModel.path,
        "-f",
        wav,
        "-l",
        language,
        "-oj",
        "-of",
        stem,
        // No progress spam on stderr: this runs unattended and the log is read
        // by a human only when something failed.
        "--no-prints",
      ];

      this.deps.logger.info("whisper transcription starting", {
        model: tools.whisperModel.path,
        language,
      });

      await run(tools.whisper.command, args, {
        timeout: WHISPER_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      });

      const raw = JSON.parse(await readFile(jsonPath, "utf8")) as WhisperJson;
      const segments = parseWhisperJson(raw);
      const durationMs = segments.length === 0 ? 0 : (segments[segments.length - 1]?.endMs ?? 0);

      return {
        text: segments.map((segment) => segment.text).join(" ").trim(),
        durationMs,
        segments,
        locale: input.locale ?? "auto",
      };
    } finally {
      // Scratch is deleted whatever happened: the WAV is a full copy of the
      // audio, so leaving it behind would quietly double the disk cost of every
      // local transcription.
      await rm(wav, { force: true });
      await rm(jsonPath, { force: true });
    }
  }
}

/**
 * Read whisper.cpp's JSON into transcript segments.
 *
 * `offsets` are milliseconds and are preferred; `timestamps` are `HH:MM:SS,mmm`
 * strings and are the fallback for older builds. Speaker is always null —
 * whisper.cpp does not diarize, and inventing "Speaker 1" would put a claim in
 * the transcript that nothing supports.
 */
export function parseWhisperJson(raw: unknown): TranscriptSegment[] {
  const rows = (raw as WhisperJson).transcription;
  if (!Array.isArray(rows)) return [];

  const segments: TranscriptSegment[] = [];
  for (const row of rows) {
    const text = (row.text ?? "").trim();
    if (text === "") continue;
    const startMs = row.offsets?.from ?? parseTimestamp(row.timestamps?.from);
    const endMs = row.offsets?.to ?? parseTimestamp(row.timestamps?.to);
    segments.push(
      TranscriptSegment.parse({
        index: segments.length,
        speaker: null,
        startMs: Math.max(0, Math.round(startMs)),
        endMs: Math.max(0, Math.round(endMs)),
        text,
      }),
    );
  }
  return segments;
}

function parseTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const match = /^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/.exec(value.trim());
  if (!match) return 0;
  const [, hours, minutes, seconds, millis] = match;
  return (
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1_000 +
    Number((millis ?? "0").padEnd(3, "0"))
  );
}
