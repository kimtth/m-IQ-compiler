import { access, constants, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { ToolStatus, type MediaSettings } from "@iq/shared";
import type { AppPaths } from "../config/paths.js";

const run = promisify(execFile);

/**
 * Resolving the external media executables.
 *
 * FFmpeg and whisper.cpp are not dependencies in the npm sense: they are large
 * native binaries with their own licences (the bundled FFmpeg build is GPLv3),
 * so the app drives whichever copy the machine has rather than shipping one.
 * `iq-audio` is ours but is resolved the same way for a different reason — it
 * is a Rust crate in this repo, and requiring a Rust toolchain to produce a
 * working app would be a worse trade than reporting its absence.
 *
 * That makes "which copy?" a real question with a wrong answer, and this module
 * is the single place it is answered.
 *
 * The order is fixed and deliberate:
 *
 *   1. an explicit path in media settings — a user who chose one is never
 *      quietly overridden;
 *   2. `IQ_FFMPEG` / `IQ_FFPROBE` / `IQ_WHISPER` / `IQ_AUDIO`, for headless and
 *      CI hosts;
 *   3. the copy `pnpm prepare:ffmpeg` downloaded (or `pnpm prepare:audio`
 *      built) under `<IQ_HOME>/tools`;
 *   4. whatever is on PATH.
 *
 * A miss is not an error. It is reported as a {@link ToolStatus} naming the
 * step that would fix it, because every surface that uses these tools has to be
 * usable on a machine that has neither.
 */

const EXE = process.platform === "win32" ? ".exe" : "";

export interface ToolResolution {
  status: ToolStatus;
  /** The command to spawn, or null when nothing was found. */
  command: string | null;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first line of a tool's version banner.
 *
 * Doubles as the liveness check for a name resolved from PATH, where the file
 * cannot be stat'd: if it will not answer `-version`, it is not usable, and
 * saying so now beats failing four seconds into a recording.
 */
async function versionOf(command: string, flag: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await run(command, [flag], {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const line = `${stdout}${stderr}`.split(/\r?\n/).find((row) => row.trim() !== "");
    return line?.trim() ?? "";
  } catch {
    return null;
  }
}

/** Where `pnpm prepare:ffmpeg` puts what it downloads. */
export function preparedToolsDir(paths: AppPaths): string {
  return join(paths.tools, "bin");
}

async function resolveOne(input: {
  name: string;
  setting: string;
  envVar: string;
  paths: AppPaths;
  versionFlag: string;
  missingMessage: string;
}): Promise<ToolResolution> {
  const candidates: Array<{ command: string; source: ToolStatus["source"]; mustExist: boolean }> = [];

  if (input.setting.trim() !== "") {
    candidates.push({ command: input.setting.trim(), source: "setting", mustExist: true });
  }
  const fromEnv = process.env[input.envVar];
  if (fromEnv && fromEnv.trim() !== "") {
    candidates.push({ command: fromEnv.trim(), source: "environment", mustExist: true });
  }
  candidates.push({
    command: join(preparedToolsDir(input.paths), `${input.name}${EXE}`),
    source: "prepared",
    mustExist: true,
  });
  // Bare name last: PATH is the least explicit answer, so it never shadows one
  // the user or the prepare step gave.
  candidates.push({ command: input.name, source: "path", mustExist: false });

  for (const candidate of candidates) {
    if (candidate.mustExist && !(await isExecutableFile(candidate.command))) continue;
    const version = await versionOf(candidate.command, input.versionFlag);
    if (version === null) continue;
    return {
      command: candidate.command,
      status: ToolStatus.parse({
        available: true,
        path: candidate.command,
        version,
        source: candidate.source,
        message: "",
      }),
    };
  }

  return {
    command: null,
    status: ToolStatus.parse({
      available: false,
      path: "",
      version: "",
      source: "missing",
      message: input.missingMessage,
    }),
  };
}

export interface ResolvedMediaTools {
  ffmpeg: ToolResolution;
  ffprobe: ToolResolution;
  whisper: ToolResolution;
  whisperModel: ToolStatus;
  iqAudio: ToolResolution;
}

/**
 * A whisper.cpp model is a file, not an executable, so it gets its own check.
 *
 * The three conditions are the ones that actually go wrong (meetly-lite's
 * Architecture.md lists the same set): the path points at something, that
 * something is a file rather than the folder it lives in, and it carries the
 * `.bin` extension a `ggml` model has. Anything past that is whisper's job to
 * reject, with a far better message than this could invent.
 */
async function resolveModel(path: string): Promise<ToolStatus> {
  const trimmed = path.trim();
  if (trimmed === "") {
    return ToolStatus.parse({
      message:
        "No Whisper model is selected. Download a ggml-*.bin model from huggingface.co/ggerganov/whisper.cpp and choose it in Meeting Recordings → Settings.",
    });
  }

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(trimmed);
  } catch {
    return ToolStatus.parse({
      path: trimmed,
      message: `No file at ${trimmed}. Whisper model paths are absolute and are not resolved relative to the app.`,
    });
  }

  if (!info.isFile()) {
    return ToolStatus.parse({
      path: trimmed,
      message: `${trimmed} is a folder. Select the ggml-*.bin file itself.`,
    });
  }
  if (!trimmed.toLowerCase().endsWith(".bin")) {
    return ToolStatus.parse({
      path: trimmed,
      message: `${trimmed} is not a .bin file. whisper.cpp models are ggml-*.bin.`,
    });
  }

  return ToolStatus.parse({
    available: true,
    path: trimmed,
    version: `${(info.size / (1024 * 1024)).toFixed(0)} MB`,
    source: "setting",
  });
}

export async function resolveMediaTools(
  settings: MediaSettings,
  paths: AppPaths,
): Promise<ResolvedMediaTools> {
  const [ffmpeg, ffprobe, whisper, whisperModel, iqAudio] = await Promise.all([
    resolveOne({
      name: "ffmpeg",
      setting: settings.ffmpegPath,
      envVar: "IQ_FFMPEG",
      paths,
      versionFlag: "-version",
      missingMessage:
        "FFmpeg was not found. Run `pnpm prepare:ffmpeg` to download it, or set its path in Meeting Recordings → Settings. Transcribing an MP4 needs it, to extract the audio.",
    }),
    resolveOne({
      name: "ffprobe",
      setting: settings.ffprobePath,
      envVar: "IQ_FFPROBE",
      paths,
      versionFlag: "-version",
      missingMessage:
        "ffprobe was not found. It ships alongside FFmpeg; run `pnpm prepare:ffmpeg` or set its path in Meeting Recordings → Settings.",
    }),
    resolveOne({
      name: "whisper-cli",
      setting: settings.whisperPath,
      envVar: "IQ_WHISPER",
      paths,
      versionFlag: "--help",
      missingMessage:
        "whisper.cpp was not found. Run `pnpm prepare:whisper` to download a build, or set the path to whisper-cli in Meeting Recordings → Settings. Local transcription needs it.",
    }),
    resolveModel(settings.whisperModelPath),
    resolveOne({
      name: "iq-audio",
      setting: settings.iqAudioPath,
      envVar: "IQ_AUDIO",
      paths,
      versionFlag: "--version",
      missingMessage:
        "The iq-audio capture sidecar was not found. Run `pnpm prepare:audio` to build it from native/iq-audio, or set its path in Meeting Recordings \u2192 Settings. Recording the other participants' audio needs it \u2014 a browser engine cannot capture system output on Windows.",
    }),
  ]);

  return { ffmpeg, ffprobe, whisper, whisperModel, iqAudio };
}
