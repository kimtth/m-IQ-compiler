import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BrowserWindow,
  app as electronApp,
  shell,
} from "electron";
import { App, emitterOver, type AppEmitter } from "@iq/core";
import type { IpcEventChannel } from "@iq/shared";
import { BrowserPane } from "./browser-pane.js";
import { createCollectors } from "./recording/collectors.js";
import { WindowScreenRecorder } from "./recording/screen-recorder.js";
import { registerIpcHandlers } from "./ipc/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.resolve(here, "..", "..", "preload", "dist", "index.js");
const RENDERER_DIST = path.resolve(here, "..", "..", "renderer", "dist", "index.html");

let window: BrowserWindow | null = null;
let core: App | null = null;
let pane: BrowserPane | null = null;

/**
 * Windows detaches stdio from GUI processes, so a crash in the main process is
 * otherwise invisible apart from Electron's generic error dialog. Everything
 * fatal is appended to a file next to the rest of the app state.
 */
function recordFatal(scope: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const line = `${new Date().toISOString()} ${scope} ${detail}\n`;
  process.stderr.write(line);
  try {
    const dir = electronApp.getPath("userData");
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "main-crash.log"), line);
  } catch {
    // Nothing further can be done if even the crash log is unwritable.
  }
}

process.on("uncaughtException", (error) => recordFatal("uncaughtException", error));
process.on("unhandledRejection", (reason) => recordFatal("unhandledRejection", reason));

/**
 * Renderer diagnostics.
 *
 * A renderer that fails to execute shows an empty window and nothing else:
 * its console is not connected to the main process's stdio, so a script that
 * is blocked or throws at import time is completely silent. These listeners
 * surface that on the same stream as everything else.
 */
function attachRendererDiagnostics(target: BrowserWindow): void {
  const write = (line: string): void => {
    process.stderr.write(`${new Date().toISOString()} renderer ${line}\n`);
  };

  target.webContents.on("console-message", (_event, level, message, line, source) => {
    if (level >= 2) write(`console[${level}] ${message} (${source}:${line})`);
  });
  target.webContents.on("did-fail-load", (_event, code, description, url) => {
    write(`did-fail-load ${code} ${description} ${url}`);
  });
  target.webContents.on("preload-error", (_event, preloadPath, error) => {
    write(`preload-error ${preloadPath} ${error.stack ?? error.message}`);
  });
  target.webContents.on("render-process-gone", (_event, details) => {
    write(`render-process-gone ${details.reason} ${details.exitCode}`);
  });
}

/**
 * Renderer window.
 *
 * The security flags are the point of this function: the renderer runs
 * sandboxed with no Node integration and context isolation on, so its only
 * route to privileged code is the preload's validated bridge. The renderer is
 * untrusted by design, and this is what that boundary means concretely.
 */
function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "IQ Compiler",
    // Light is the default theme, so the pre-paint flash must be light too.
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  created.once("ready-to-show", () => created.show());

  // The browser runs in its own OS process now, so closing the window must
  // reap it or an orphaned Edge would keep the profile locked.
  created.on("closed", () => {
    void pane?.close();
  });

  // Opt-in smoke check: prove the renderer actually painted, which a log line
  // cannot. Used during development and by the launch check in the README.
  const shotPath = process.env["IQ_CAPTURE_TO"];
  if (shotPath) {
    created.webContents.once("did-finish-load", () => {
      setTimeout(() => {
        void created.webContents
          .capturePage()
          .then((image) => writeFileSync(shotPath, image.toPNG()))
          .catch((error) => recordFatal("capture", error));
      }, 4_000);
    });
  }

  attachRendererDiagnostics(created);
  configureMediaPermissions(created);

  // Navigation and popups are the classic escape hatches out of a sandboxed
  // renderer, so both are refused and sent to the real browser instead.
  created.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  created.webContents.on("will-navigate", (event, url) => {
    if (url !== created.webContents.getURL()) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  /**
   * End-to-end harness.
   *
   * Opt-in and off by default. It only tells the renderer to open past the
   * sign-in card so a test can drive the surfaces that need no identity; it
   * hands out nothing, because every privileged handler still demands a real
   * token. The renderer shows a banner while the flag is on, so a harness
   * window is never mistaken for a signed-in one.
   */
  const harness = process.env["IQ_E2E"] === "1";
  const devServer = process.env["IQ_RENDERER_URL"];
  if (devServer) {
    void created.loadURL(
      harness ? `${devServer}${devServer.includes("?") ? "&" : "?"}e2e=1` : devServer,
    );
  } else if (harness) {
    void created.loadFile(RENDERER_DIST, { query: { e2e: "1" } });
  } else {
    void created.loadFile(RENDERER_DIST);
  }

  return created;
}

/**
 * Push one fact to the renderer, dropping it when no window is listening.
 *
 * Typed on {@link IpcEventChannel} rather than `string`: this is the only place
 * a channel name is written by hand in this process, and an unchecked one
 * pushes to nothing while compiling perfectly.
 */
function sendToWindow(channel: IpcEventChannel, payload: unknown): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(channel, payload);
}

/**
 * The app's broadcasts, over that send.
 *
 * Which channel each broadcast belongs to is `@iq/core`'s `EMITTER_CHANNELS`,
 * not this file's. The host used to restate all 22 pairings here, which made it
 * the third of four places the same mapping was written down.
 */
function createEmitter(): AppEmitter {
  return emitterOver(sendToWindow);
}

/**
 * Audio capture permissions.
 *
 * The renderer is sandboxed, so `getUserMedia` and `getDisplayMedia` only work
 * if the main process grants them. Both are granted narrowly:
 *
 *  - Only audio. A `media` request that asks for video is refused, so a
 *    compromised renderer cannot turn on the camera or read the screen. That is
 *    also why the display-media handler passes `video: undefined`.
 *  - Only for our own window. Anything else is denied outright.
 *  - Everything else Electron can be asked for — geolocation, notifications,
 *    HID, serial, MIDI — stays denied, because none of it is used.
 *
 * `audio: "loopback"` is what makes capturing a Teams or a browser meeting
 * possible without a virtual audio cable: Windows mixes the system output back
 * in. On platforms where loopback is unavailable, the microphone source alone
 * still works.
 */
function configureMediaPermissions(target: BrowserWindow): void {
  const scoped = target.webContents.session;

  scoped.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (contents !== target.webContents) return callback(false);
    if (permission !== "media") return callback(false);
    const wanted = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    return callback(wanted.every((type) => type === "audio"));
  });

  scoped.setPermissionCheckHandler((contents, permission, _origin, details) => {
    if (contents !== null && contents !== target.webContents) return false;
    if (permission !== "media") return false;
    return (details as { mediaType?: string }).mediaType !== "video";
  });

  scoped.setDisplayMediaRequestHandler(
    (_request, callback) => {
      // Audio only. No video source is offered back, so "capture system audio"
      // cannot become "capture the screen".
      callback({ audio: "loopback" });
    },
    { useSystemPicker: false },
  );
}

/** The pane is built after the app, so every consumer reaches it late-bound. */
function requirePane(): BrowserPane {
  if (!pane) throw new Error("the browser pane is not available");
  return pane;
}

/** Same late binding for hooks the app calls back into after construction. */
function requireCore(): App {
  if (!core) throw new Error("the application is not available");
  return core;
}

async function bootstrap(): Promise<void> {  core = await App.create({
    openBrowser: async (url) => shell.openExternal(url),
    // The pane is constructed after the app (it needs the policy and audit log
    // the app owns), so the tool reaches it through this late-bound hook.
    browserPane: {
      open: async (url) => requirePane().agentHost().open(url),
      read: async () => requirePane().agentHost().read(),
      back: async () => requirePane().agentHost().back(),
      forward: async () => requirePane().agentHost().forward(),
      reload: async () => requirePane().agentHost().reload(),
      close: async () => requirePane().agentHost().close(),
    },
    emit: createEmitter(),
    appVersion: electronApp.getVersion(),
    // Recording needs Electron for both halves: a window to capture the
    // screen from, and the OS APIs behind the foreground window and clipboard.
    // Core owns the state machine and receives them as interfaces, so it stays
    // testable headlessly and a platform with neither still records a timeline.
    screenRecorder: () =>
      new WindowScreenRecorder(requireCore().logger.child({ component: "recording" })),
    recordingCollectors: () => createCollectors({ captureUrls: true }),
    ...(process.env["IQ_LOG_LEVEL"] ? { logLevel: process.env["IQ_LOG_LEVEL"] as "debug" } : {}),
  });

  core.entra.onStatusChange((status) => {
    sendToWindow("auth:status", status);
  });

  pane = new BrowserPane(
    core,
    (state) => {
      sendToWindow("browser:changed", state);
    },
    (frame) => {
      sendToWindow("browser:frame", frame);
    },
  );

  registerIpcHandlers(core, () => window?.webContents ?? null, () => requirePane());

  // The window opens before the agent runtime is ready so a slow start shows
  // an interface rather than nothing.
  window = createWindow();
  await core.start();
}

// A second instance would race the first for the same on-disk logs and token
// cache, so it is refused and simply focuses the existing window.
if (!electronApp.requestSingleInstanceLock()) {
  electronApp.quit();
} else {
  electronApp.on("second-instance", () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  void electronApp.whenReady().then(async () => {
    try {
      await bootstrap();
    } catch (error) {
      recordFatal("bootstrap", error);
      electronApp.quit();
    }
  });

  electronApp.on("window-all-closed", () => {
    if (process.platform !== "darwin") void shutdown();
  });

  electronApp.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) window = createWindow();
  });

  electronApp.on("before-quit", () => void shutdown());
}

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await pane?.dispose().catch(() => undefined);
  // Stop the scheduler and coordinator first so nothing new starts while the
  // runtime is tearing down.
  await core?.stop().catch(() => undefined);
  electronApp.quit();
}
