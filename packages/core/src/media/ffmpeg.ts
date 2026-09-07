import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { MediaSettings } from "@iq/shared";
import type { Logger } from "../util/logger.js";
import { resolveMediaTools } from "./tools.js";
import type { AppPaths } from "../config/paths.js";

const run = promisify(execFile);

/**
 * The FFmpeg wire: probing a media file and reducing it to audio.
 *
 * Adopted from Meetly Lite, which drives FFmpeg for "capture, encoding, audio
 * mixing, and MP4-to-MP3 conversion" (meetly-lite/README.md). Only the last of
 * those is here: this app no longer records screens, so the capture pipeline,
 * the partial-file commit dance and the container repair that existed to
 * survive an FFmpeg crash mid-recording all went with it.
 *
 * What remains is the part every transcription path depends on — a file the
 * user already has, measured and reduced to something Azure or whisper.cpp
 * will accept.
 */

export interface FfmpegDeps {
  paths: AppPaths;
  logger: Logger;
  /** Re-read per call so an edit in Settings takes effect immediately. */
  settings: () => MediaSettings;
}

export class MediaToolMissingError extends Error {
  override readonly name = "MediaToolMissingError";
}

export class FfmpegService {
  constructor(private readonly deps: FfmpegDeps) {}

  private async ffmpeg(): Promise<string> {
    const tools = await resolveMediaTools(this.deps.settings(), this.deps.paths);
    if (tools.ffmpeg.command === null) throw new MediaToolMissingError(tools.ffmpeg.status.message);
    return tools.ffmpeg.command;
  }

  private async ffprobe(): Promise<string> {
    const tools = await resolveMediaTools(this.deps.settings(), this.deps.paths);
    if (tools.ffprobe.command === null)
      throw new MediaToolMissingError(tools.ffprobe.status.message);
    return tools.ffprobe.command;
  }

  // --- container work -------------------------------------------------------

  /** Duration in milliseconds, or 0 when the file carries no usable stream. */
  async durationMs(path: string): Promise<number> {
    const command = await this.ffprobe();
    try {
      const { stdout } = await run(
        command,
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          path,
        ],
        { timeout: 30_000, windowsHide: true },
      );
      const seconds = Number.parseFloat(stdout.trim());
      return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Extract the audio of a media file as MP3.
   *
   * Meetly uploads audio, never video: "MP4 audio is extracted locally as MP3
   * before upload" (meetly-lite/README.md). Doing it here rather than sending
   * the MP4 turns a 400 MB upload into a 20 MB one and keeps the video, which
   * is the more revealing artefact, on the device.
   */
  async extractMp3(input: string, output: string): Promise<void> {
    const command = await this.ffmpeg();
    await mkdir(dirname(output), { recursive: true });
    await run(
      command,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        input,
        "-vn",
        "-acodec",
        "libmp3lame",
        "-q:a",
        "4",
        output,
      ],
      { timeout: 900_000, windowsHide: true },
    );
  }

  /**
   * Normalise any input to 16 kHz mono PCM WAV.
   *
   * whisper.cpp accepts nothing else, and feeding it anything else is the most
   * common way to get an empty transcript rather than an error.
   */
  async toWhisperWav(input: string, output: string): Promise<void> {
    const command = await this.ffmpeg();
    await mkdir(dirname(output), { recursive: true });
    await run(
      command,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        input,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        output,
      ],
      { timeout: 900_000, windowsHide: true },
    );
  }

  /** Scratch space for conversions, kept out of the user's own folders. */
  scratchPath(name: string): string {
    return join(this.deps.paths.tools, "scratch", name);
  }
}
