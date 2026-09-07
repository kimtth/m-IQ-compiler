import { createWriteStream, type WriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, desktopCapturer, ipcMain, session, type IpcMainEvent } from "electron";
import type { CapturedFrame, ScreenRecorder } from "@iq/core";
import type { Logger } from "@iq/core";

/**
 * Screen capture in a window of its own.
 *
 * The application's main window refuses video outright — `configureMediaPermissions`
 * in index.ts denies any `media` request that asks for it, and offers no video
 * source to `getDisplayMedia`. That refusal is deliberate and stays: the
 * renderer displays untrusted model output, and it should never be one bug away
 * from reading the screen.
 *
 * So capture happens somewhere else entirely. This window runs on its own
 * `session` partition, which is the only reason the split works: permission
 * handlers are set per session, so granting video here cannot widen anything
 * the main window is allowed to do. The window is hidden, loads a page with no
 * scripts and no network access, and exists only while a recording is running.
 *
 * Capture is best-effort throughout. Every failure path ends with a recording
 * that has a timeline and no video, which is worse but still analysable —
 * failing the whole session because a display could not be enumerated would
 * throw away the part that was working.
 */

// This file compiles to `dist/recording/`, and `scripts/copy-assets.mjs` puts
// the page and its preload in that same directory. Both are therefore siblings
// of this module, not children of a nested folder.
const here = dirname(fileURLToPath(import.meta.url));
const CAPTURE_PRELOAD = join(here, "capture-preload.cjs");
const CAPTURE_PAGE = join(here, "capture.html");

/** Its own session, so granting video here grants it nowhere else. */
const CAPTURE_PARTITION = "iq-recorder-capture";

/**
 * One frame a second at 720p.
 *
 * The cost of screen capture is the compositor copying the framebuffer, not our
 * encoder, so the rate is what matters. Nobody watches this video: it exists to
 * recover a still near each event. A higher rate would buy nothing and make the
 * machine — and therefore the work being recorded — perceptibly slower.
 */
const FPS = 1;
const BITS_PER_SECOND = 500_000;
const MAX_WIDTH = 1280;
const MAX_HEIGHT = 720;
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 10_000;
/** A frame larger than this is not a screenshot; it is a bug or an attack. */
const MAX_FRAME_BYTES = 5 * 1024 * 1024;
const MAX_DIMENSION = 16_384;

interface FrameMessage {
  data: Uint8Array;
  epochMs: number;
  width: number;
  height: number;
  phash: string;
}

export class WindowScreenRecorder implements ScreenRecorder {
  private window: BrowserWindow | null = null;
  private stream: WriteStream | null = null;
  private videoFile = "";
  private bytes = 0;
  private startEpoch: number | null = null;
  private stopEpoch: number | null = null;
  private anchorEpoch = 0;
  private onFrame: ((frame: CapturedFrame) => void) | null = null;
  private resolveStarted: (() => void) | null = null;
  private resolveStopped: (() => void) | null = null;

  constructor(private readonly logger: Logger) {}

  private readonly handleChunk = (event: IpcMainEvent, chunk: Uint8Array): void => {
    if (!this.owns(event) || this.stream === null) return;
    const buffer = Buffer.from(chunk);
    this.bytes += buffer.byteLength;
    this.stream.write(buffer);
  };

  private readonly handleStarted = (event: IpcMainEvent, epoch: number): void => {
    if (!this.owns(event)) return;
    this.startEpoch = epoch;
    this.resolveStarted?.();
    this.resolveStarted = null;
  };

  private readonly handleFrame = (event: IpcMainEvent, frame: FrameMessage): void => {
    if (!this.owns(event) || this.onFrame === null) return;
    // The payload crosses a process boundary from the one place in the app that
    // touches raw screen pixels, so it is validated rather than trusted.
    if (
      !(frame?.data instanceof Uint8Array) ||
      frame.data.byteLength === 0 ||
      frame.data.byteLength > MAX_FRAME_BYTES ||
      !Number.isFinite(frame.epochMs) ||
      !validDimension(frame.width) ||
      !validDimension(frame.height)
    ) {
      this.logger.warn("ignored a captured frame with an implausible payload");
      return;
    }
    this.onFrame({
      bytes: frame.data,
      tMs: Math.max(0, Math.round(frame.epochMs - this.anchorEpoch)),
      phash: /^[0-9a-f]{16}$/i.test(frame.phash ?? "") ? frame.phash : "",
      width: Math.round(frame.width),
      height: Math.round(frame.height),
      source: "scene",
    });
  };

  private readonly handleFrameError = (event: IpcMainEvent, message: string): void => {
    if (this.owns(event)) this.logger.warn("frame sampling unavailable", { message });
  };

  private readonly handleStopped = (event: IpcMainEvent, epoch: number): void => {
    if (!this.owns(event)) return;
    this.stopEpoch = Number.isFinite(epoch) ? epoch : Date.now();
    this.resolveStopped?.();
    this.resolveStopped = null;
  };

  private readonly handleError = (event: IpcMainEvent, message: string): void => {
    if (!this.owns(event)) return;
    this.logger.warn("screen capture reported an error", { message });
    // Release anyone waiting: a recorder that never started must not make
    // start() or stop() sit out its full timeout.
    this.resolveStarted?.();
    this.resolveStarted = null;
    this.resolveStopped?.();
    this.resolveStopped = null;
  };

  private owns(event: IpcMainEvent): boolean {
    return this.window !== null && event.sender === this.window.webContents;
  }

  async start(input: {
    videoFile: string;
    startEpoch?: number;
    onFrame: (frame: CapturedFrame) => void;
  }): Promise<{ fps: number } | null> {    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 },
      });
      const source = sources[0];
      if (!source) {
        this.logger.warn("no screen source is available; recording without video");
        return null;
      }

      this.videoFile = input.videoFile;
      this.onFrame = input.onFrame;
      this.anchorEpoch = input.startEpoch ?? Date.now();
      this.bytes = 0;
      this.startEpoch = null;
      this.stopEpoch = null;
      this.stream = createWriteStream(this.videoFile);

      ipcMain.on("recorder:chunk", this.handleChunk);
      ipcMain.on("recorder:frame", this.handleFrame);
      ipcMain.on("recorder:frame-error", this.handleFrameError);
      ipcMain.on("recorder:started", this.handleStarted);
      ipcMain.on("recorder:stopped", this.handleStopped);
      ipcMain.on("recorder:error", this.handleError);

      const scoped = session.fromPartition(CAPTURE_PARTITION);
      this.lockDown(scoped);

      this.window = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: CAPTURE_PRELOAD,
          partition: CAPTURE_PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          // The preload needs `require("electron")` and the media APIs in the
          // same world, which the sandbox does not allow. The page it runs
          // against loads no script, has no network access and is never shown,
          // so there is nothing in it to escape from.
          sandbox: false,
          backgroundThrottling: false,
        },
      });
      await this.window.loadFile(CAPTURE_PAGE);

      const started = new Promise<void>((resolve) => {
        this.resolveStarted = resolve;
      });
      this.window.webContents.send("recorder:start", {
        sourceId: source.id,
        fps: FPS,
        bitsPerSecond: BITS_PER_SECOND,
        maxWidth: MAX_WIDTH,
        maxHeight: MAX_HEIGHT,
      });
      await Promise.race([started, delay(START_TIMEOUT_MS)]);

      if (this.startEpoch === null) {
        this.logger.warn("screen capture did not start; recording without video");
        await this.teardown();
        await rm(this.videoFile, { force: true }).catch(() => undefined);
        return null;
      }
      return { fps: FPS };
    } catch (error) {
      this.logger.warn("screen capture failed to start", { error });
      await this.teardown();
      await rm(this.videoFile, { force: true }).catch(() => undefined);
      return null;
    }
  }

  async stop(): Promise<{ durationMs: number; bytes: number } | null> {
    if (this.window === null || this.stream === null) {
      await this.teardown();
      return null;
    }

    const stopped = new Promise<void>((resolve) => {
      this.resolveStopped = resolve;
    });
    this.window.webContents.send("recorder:stop");
    await Promise.race([stopped, delay(STOP_TIMEOUT_MS)]);

    const stopEpoch = this.stopEpoch ?? Date.now();
    const startEpoch = this.startEpoch;
    const file = this.videoFile;
    await this.teardown();

    // The byte count is read back from disk rather than taken from the running
    // total: the total counts what was handed to the stream, and the file is
    // what an analysis can actually open.
    const bytes = await stat(file)
      .then((info) => info.size)
      .catch(() => 0);

    if (bytes === 0 || startEpoch === null) {
      await rm(file, { force: true }).catch(() => undefined);
      return null;
    }
    return { durationMs: Math.max(0, stopEpoch - startEpoch), bytes };
  }

  /**
   * Nothing but screen capture, and nothing but for this window.
   *
   * The partition is new, so it starts with Electron's defaults — which grant
   * more than this needs. Every other permission is denied explicitly so that
   * adding a capability here later has to be a deliberate act.
   */
  private lockDown(scoped: Electron.Session): void {
    scoped.setPermissionRequestHandler((contents, permission, callback) => {
      const mine = this.window !== null && contents === this.window.webContents;
      callback(mine && permission === "media");
    });
    scoped.setPermissionCheckHandler((contents, permission) => {
      const mine = this.window !== null && contents === this.window.webContents;
      return mine && permission === "media";
    });
    scoped.setDisplayMediaRequestHandler(
      (_request, callback) => {
        // Capture goes through getUserMedia with an explicit source id, so
        // there is no legitimate getDisplayMedia call to satisfy here.
        callback({});
      },
      { useSystemPicker: false },
    );
  }

  private async teardown(): Promise<void> {
    ipcMain.removeListener("recorder:chunk", this.handleChunk);
    ipcMain.removeListener("recorder:frame", this.handleFrame);
    ipcMain.removeListener("recorder:frame-error", this.handleFrameError);
    ipcMain.removeListener("recorder:started", this.handleStarted);
    ipcMain.removeListener("recorder:stopped", this.handleStopped);
    ipcMain.removeListener("recorder:error", this.handleError);
    this.resolveStarted = null;
    this.resolveStopped = null;
    this.onFrame = null;

    await new Promise<void>((resolve) => {
      if (this.stream === null) return resolve();
      this.stream.end(() => resolve());
    });
    this.stream = null;

    if (this.window !== null && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}

function validDimension(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= MAX_DIMENSION;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
