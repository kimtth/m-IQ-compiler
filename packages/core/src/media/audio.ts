import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { AudioDevices, type MediaSettings } from "@iq/shared";
import type { Logger } from "../util/logger.js";
import type { AppPaths } from "../config/paths.js";
import { resolveMediaTools } from "./tools.js";
import { MediaToolMissingError } from "./ffmpeg.js";

const run = promisify(execFile);

/**
 * The native capture sidecar.
 *
 * The renderer used to record with `MediaRecorder`, and for a microphone that
 * works. It cannot capture system output on Windows — `getDisplayMedia` audio
 * is tab-scoped in Chromium — so "record the other participants" recorded
 * silence, and the FFmpeg alternative wanted a DirectShow filter that is not on
 * a normal machine. `native/iq-audio` is a cpal sidecar that does it properly
 * through WASAPI loopback; this class is the only thing in the app that knows
 * how to talk to it.
 *
 * It is a spawned process rather than a native module on purpose: a native
 * binding would put a Rust toolchain in the install path of an Electron app.
 * The cost of that choice is a protocol, which is why it is written down here
 * and parsed in exactly one place.
 *
 * ## Protocol
 * One process per recording. Newline-delimited JSON leaves on stdout, nothing
 * else does, and diagnostics go to stderr. Closing stdin stops the capture and
 * finalises the WAV — there is no stop command, because a parent that died has
 * closed stdin too, and a half-written WAV is worse than a short one.
 */

/** Emitted while a capture runs, roughly ten times a second. */
export interface AudioLevels {
  microphone: number;
  system: number;
  mix: number;
}

/** What a finished capture produced. */
export interface AudioCaptureResult {
  path: string;
  durationMs: number;
  bytes: number;
}

export interface AudioCaptureOptions {
  /** Absolute path of the WAV to write. */
  out: string;
  /** Device name from {@link AudioSidecar.devices}, or undefined for the default. */
  microphone?: string;
  /** Capture system output as well. Only meaningful where loopback is supported. */
  system?: boolean;
  onLevel?: (levels: AudioLevels) => void;
}

/** A capture in flight. Resolve it by calling {@link AudioCapture.stop}. */
export interface AudioCapture {
  /** Close stdin, wait for the sidecar to finalise the file, and return it. */
  stop(): Promise<AudioCaptureResult>;
  /** Abandon the capture. The partial file is left where it is. */
  cancel(): void;
}

export interface AudioSidecarDeps {
  paths: AppPaths;
  logger: Logger;
  settings: () => MediaSettings;
}

/** Enumerating devices should be instant; a hang here is a broken install. */
const DEVICES_TIMEOUT_MS = 15_000;

/** Finalising a WAV is a flush and a header rewrite, not a conversion. */
const STOP_TIMEOUT_MS = 30_000;

export class AudioSidecar {
  constructor(private readonly deps: AudioSidecarDeps) {}

  /** Whether a capture could start right now, and why not if it could not. */
  async readiness(): Promise<{ ready: boolean; message: string }> {
    const tools = await resolveMediaTools(this.deps.settings(), this.deps.paths);
    return tools.iqAudio.status.available
      ? { ready: true, message: "" }
      : { ready: false, message: tools.iqAudio.status.message };
  }

  /**
   * The machine's capture devices, as the sidecar sees them.
   *
   * `loopbackSupported` comes from the sidecar rather than from
   * `process.platform` here, so the one component that actually knows whether
   * it can capture system output is the one that answers.
   */
  async devices(): Promise<AudioDevices> {
    const command = await this.command();
    const { stdout } = await run(command, ["devices"], {
      timeout: DEVICES_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });

    const event = firstEvent(stdout);
    if (event === null || event["kind"] !== "devices") {
      throw new Error("iq-audio did not report any devices");
    }
    return AudioDevices.parse({
      inputs: event["inputs"],
      outputs: event["outputs"],
      loopbackSupported: event["loopback_supported"],
    });
  }

  /**
   * Start capturing to `options.out`.
   *
   * Resolves once the sidecar has confirmed it is recording, so a caller that
   * shows "recording" is not claiming something that has not happened yet: a
   * device that is in use by another application fails here, before the user
   * has spent an hour on a file with nothing in it.
   */
  async start(options: AudioCaptureOptions): Promise<AudioCapture> {
    const command = await this.command();

    const args = ["capture", "--out", options.out];
    if (options.microphone) args.push("--mic", options.microphone);
    if (options.system) args.push("--system");

    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    return this.attach(child, options);
  }

  private async command(): Promise<string> {
    const tools = await resolveMediaTools(this.deps.settings(), this.deps.paths);
    if (tools.iqAudio.command === null) {
      throw new MediaToolMissingError(tools.iqAudio.status.message);
    }
    return tools.iqAudio.command;
  }

  private attach(
    child: ChildProcessWithoutNullStreams,
    options: AudioCaptureOptions,
  ): Promise<AudioCapture> {
    return new Promise<AudioCapture>((resolveStart, rejectStart) => {
      let started = false;
      let stopped: AudioCaptureResult | null = null;
      let failure: string | null = null;
      const waiters: Array<{
        resolve: (result: AudioCaptureResult) => void;
        reject: (error: Error) => void;
      }> = [];

      const settle = (): void => {
        while (waiters.length > 0) {
          const waiter = waiters.shift();
          if (!waiter) break;
          if (stopped) waiter.resolve(stopped);
          else waiter.reject(new Error(failure ?? "iq-audio ended without finishing the recording"));
        }
      };

      const stderr: string[] = [];
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr.push(chunk);
        this.deps.logger.warn("iq-audio", { detail: chunk.trim() });
      });

      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const event = parseEvent(line);
        if (event === null) return;

        switch (event["kind"]) {
          case "started":
            started = true;
            resolveStart(capture);
            break;
          case "level":
            options.onLevel?.({
              microphone: Number(event["microphone"] ?? 0),
              system: Number(event["system"] ?? 0),
              mix: Number(event["mix"] ?? 0),
            });
            break;
          case "stopped":
            stopped = {
              path: String(event["path"] ?? options.out),
              durationMs: Number(event["duration_ms"] ?? 0),
              bytes: Number(event["bytes"] ?? 0),
            };
            break;
          case "error":
            failure = String(event["message"] ?? "iq-audio reported an error");
            break;
          default:
            break;
        }
      });

      child.on("error", (error) => {
        failure = error.message;
        if (!started) rejectStart(error);
        settle();
      });

      child.on("close", (code) => {
        if (stopped === null && failure === null && code !== 0) {
          failure = `iq-audio exited with code ${code}: ${stderr.join("").trim()}`;
        }
        if (!started) {
          rejectStart(new Error(failure ?? "iq-audio exited before it started recording"));
          return;
        }
        settle();
      });

      const capture: AudioCapture = {
        stop: () =>
          new Promise<AudioCaptureResult>((resolve, reject) => {
            if (stopped) {
              resolve(stopped);
              return;
            }
            if (failure !== null) {
              reject(new Error(failure));
              return;
            }
            waiters.push({ resolve, reject });
            // Closing stdin is the stop signal. The timer is a backstop, not
            // the mechanism: a sidecar that will not finalise its WAV must not
            // hold the meeting open forever.
            const timer = setTimeout(() => {
              child.kill();
            }, STOP_TIMEOUT_MS);
            child.once("close", () => clearTimeout(timer));
            child.stdin.end();
          }),
        cancel: () => {
          child.kill();
        },
      };
    });
  }
}

function parseEvent(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    // Not our protocol. Dropped rather than thrown: a stray line on stdout
    // should not end a recording that is otherwise working.
    return null;
  }
}

function firstEvent(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.split(/\r?\n/)) {
    const event = parseEvent(line);
    if (event !== null) return event;
  }
  return null;
}
