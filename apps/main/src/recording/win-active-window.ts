import { createRequire } from "node:module";
import { basename, extname } from "node:path";

/**
 * The foreground window on Windows, read through Win32 directly.
 *
 * This is the backbone of the timeline: almost every step boundary is "the user
 * moved to a different application". It is worth a native dependency because
 * the alternatives are worse in exactly the environment this app targets — a
 * scripted host needs `Add-Type`, which managed fleets running PowerShell in
 * Constrained Language Mode block outright, and losing window tracking there
 * would leave a recording with nothing in it.
 *
 * koffi is loaded lazily and defensively. On a machine where it cannot load,
 * every read returns null and the recording carries on with clipboard events
 * and frames — a poorer timeline rather than no feature at all.
 */

/** Access rights sufficient to ask a process for its image path, and no more. */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const GW_CHILD = 5;
const GW_HWNDNEXT = 2;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const MAX_TEXT_CHARS = 32_768;
/** Bound on the UWP child search, so a pathological tree cannot stall a poll. */
const MAX_UWP_CHILDREN = 256;

/**
 * Executable names worth translating.
 *
 * The analyst reasons about these strings, and "msedge" reads as noise where
 * "Microsoft Edge" reads as an application. Anything absent falls back to the
 * executable name, which looks raw but is never misleading.
 */
const DISPLAY_NAMES: Record<string, string> = {
  chrome: "Google Chrome",
  msedge: "Microsoft Edge",
  firefox: "Firefox",
  brave: "Brave",
  opera: "Opera",
  vivaldi: "Vivaldi",
  code: "Visual Studio Code",
  explorer: "File Explorer",
  winword: "Microsoft Word",
  excel: "Microsoft Excel",
  powerpnt: "Microsoft PowerPoint",
  outlook: "Microsoft Outlook",
  onenote: "Microsoft OneNote",
  teams: "Microsoft Teams",
  ms_teams: "Microsoft Teams",
  applicationframehost: "Windows app",
};

export interface ActiveWindowInfo {
  app: string;
  title: string;
  pid: number;
  path: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

interface Win32 {
  getForegroundWindow: () => unknown;
  getWindow: (window: unknown, relation: number) => unknown;
  getWindowThreadProcessId: (window: unknown, out: Buffer) => number;
  getWindowTextLength: (window: unknown) => number;
  getWindowText: (window: unknown, out: Buffer, max: number) => number;
  getWindowRect: (window: unknown, out: Buffer) => number;
  dwmGetWindowAttribute: (window: unknown, attribute: number, out: Buffer, size: number) => number;
  openProcess: (access: number, inherit: number, pid: number) => unknown;
  queryFullProcessImageName: (
    handle: unknown,
    flags: number,
    out: Buffer,
    size: Buffer,
  ) => number;
  closeHandle: (handle: unknown) => number;
}

interface KoffiLibrary {
  func: (name: string, result: string, args: string[]) => (...values: never[]) => never;
}

interface KoffiModule {
  load: (library: string) => KoffiLibrary;
}

/** null once loading has been tried and failed; undefined before the attempt. */
let win32: Win32 | null | undefined;

function load(): Win32 | null {
  if (win32 !== undefined) return win32;
  if (process.platform !== "win32") {
    win32 = null;
    return null;
  }
  try {
    // Required rather than imported so that loading this module on any platform,
    // in any test, cannot fail on a missing native binary.
    const koffi = createRequire(import.meta.url)("koffi") as KoffiModule;
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");
    const dwmapi = koffi.load("dwmapi.dll");
    const fn = <T>(lib: KoffiLibrary, name: string, result: string, args: string[]): T =>
      lib.func(name, result, args) as unknown as T;

    win32 = {
      getForegroundWindow: fn(user32, "GetForegroundWindow", "void *", []),
      getWindow: fn(user32, "GetWindow", "void *", ["void *", "uint32"]),
      getWindowThreadProcessId: fn(user32, "GetWindowThreadProcessId", "uint32", [
        "void *",
        "void *",
      ]),
      getWindowTextLength: fn(user32, "GetWindowTextLengthW", "int32", ["void *"]),
      getWindowText: fn(user32, "GetWindowTextW", "int32", ["void *", "void *", "int32"]),
      getWindowRect: fn(user32, "GetWindowRect", "int32", ["void *", "void *"]),
      dwmGetWindowAttribute: fn(dwmapi, "DwmGetWindowAttribute", "int32", [
        "void *",
        "uint32",
        "void *",
        "uint32",
      ]),
      openProcess: fn(kernel32, "OpenProcess", "void *", ["uint32", "int32", "uint32"]),
      queryFullProcessImageName: fn(kernel32, "QueryFullProcessImageNameW", "int32", [
        "void *",
        "uint32",
        "void *",
        "void *",
      ]),
      closeHandle: fn(kernel32, "CloseHandle", "int32", ["void *"]),
    };
  } catch {
    win32 = null;
  }
  return win32;
}

export function readActiveWindow(): ActiveWindowInfo | null {
  const api = load();
  if (api === null) return null;

  let window = api.getForegroundWindow();
  if (!window) return null;

  let pid = processIdFor(api, window);
  let imagePath = processPathFor(api, pid);

  // A UWP app runs inside ApplicationFrameHost, which would otherwise report
  // every Store app as the same application. The real process owns a child
  // window, so descend until a different pid appears.
  if (basename(imagePath).toLowerCase() === "applicationframehost.exe") {
    const child = findUwpOwner(api, window, pid);
    if (child) {
      window = child;
      pid = processIdFor(api, child);
      imagePath = processPathFor(api, pid);
    }
  }

  const executable = basename(imagePath, extname(imagePath));
  return {
    app: DISPLAY_NAMES[executable.toLowerCase()] ?? executable ?? "unknown",
    title: windowTitle(api, window),
    pid,
    path: imagePath,
    bounds: windowBounds(api, window),
  };
}

function processIdFor(api: Win32, window: unknown): number {
  const out = Buffer.alloc(4);
  api.getWindowThreadProcessId(window, out);
  return out.readUInt32LE(0);
}

function processPathFor(api: Win32, pid: number): string {
  if (!pid) return "";
  const handle = api.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) return "";
  try {
    const out = Buffer.alloc(MAX_TEXT_CHARS * 2);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(MAX_TEXT_CHARS);
    if (!api.queryFullProcessImageName(handle, 0, out, size)) return "";
    return out.subarray(0, size.readUInt32LE(0) * 2).toString("utf16le");
  } catch {
    return "";
  } finally {
    api.closeHandle(handle);
  }
}

function windowTitle(api: Win32, window: unknown): string {
  const length = Math.min(MAX_TEXT_CHARS - 1, Math.max(0, api.getWindowTextLength(window)));
  if (length === 0) return "";
  const out = Buffer.alloc((length + 1) * 2);
  const written = api.getWindowText(window, out, length + 1);
  return written > 0 ? out.subarray(0, written * 2).toString("utf16le") : "";
}

/**
 * The window's on-screen rectangle.
 *
 * DWM's extended frame bounds are asked for first because `GetWindowRect`
 * includes the invisible resize border, which on Windows 10/11 is several
 * pixels of nothing — enough to make a cropped frame miss the window edge.
 */
function windowBounds(api: Win32, window: unknown): ActiveWindowInfo["bounds"] {
  const rect = Buffer.alloc(16);
  const dwm = api.dwmGetWindowAttribute(
    window,
    DWMWA_EXTENDED_FRAME_BOUNDS,
    rect,
    rect.byteLength,
  );
  if (dwm !== 0 && !api.getWindowRect(window, rect)) return undefined;
  const left = rect.readInt32LE(0);
  const top = rect.readInt32LE(4);
  const right = rect.readInt32LE(8);
  const bottom = rect.readInt32LE(12);
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function findUwpOwner(api: Win32, root: unknown, frameHostPid: number): unknown | null {
  const queue: unknown[] = [root];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_UWP_CHILDREN) {
    const parent = queue.shift();
    let child = api.getWindow(parent, GW_CHILD);
    while (child && visited++ < MAX_UWP_CHILDREN) {
      const childPid = processIdFor(api, child);
      if (childPid && childPid !== frameHostPid) return child;
      queue.push(child);
      child = api.getWindow(child, GW_HWNDNEXT);
    }
  }
  return null;
}
