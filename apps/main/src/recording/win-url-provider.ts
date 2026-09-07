import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The active tab's URL of the frontmost browser, on Windows.
 *
 * A window title tells you someone was in a browser; the URL tells you what
 * they were doing. It is the single richest non-video signal in the timeline,
 * and Windows exposes no scripting bridge for it — the only route is to read
 * the frontmost window's UI Automation tree and pull the address bar's value.
 *
 * UIA lives in the .NET `UIAutomationClient` / `UIAutomationTypes` assemblies,
 * which are reliably present only in Windows PowerShell 5.1 (in-box on every
 * Windows 10/11), and loading them costs the better part of a second. Spawning
 * per read would therefore blow any sane timeout, so a single host process is
 * kept alive: it loads UIA once, then answers one request per stdin line.
 *
 * Every failure — no host, timeout, no address bar, a policy that forbids
 * `Add-Type` — resolves null rather than throwing. The URL is an enrichment;
 * the recording is still worth having without it.
 */

/** ASCII record separator: cannot occur in a URL or a window title. */
const SEP = String.fromCharCode(30);
const READY = "READY";
const REQUEST_TIMEOUT_MS = 2_000;
/** Give up on the host after this many consecutive failed starts. */
const MAX_START_ATTEMPTS = 2;

/**
 * Browser families we can read. Matched loosely on a family token because the
 * reported application name varies with channel ("Microsoft Edge Beta").
 */
const BROWSER_TOKENS = ["chrome", "chromium", "edge", "brave", "opera", "vivaldi", "firefox", "arc"];

export function isBrowserApp(app: string): boolean {
  const lower = app.toLowerCase();
  return BROWSER_TOKENS.some((token) => lower.includes(token));
}

/**
 * The reader. Prints `READY` once UIA has loaded, then one line per request:
 * `<url><SEP><title>`, or an empty line when nothing could be read.
 *
 * The walk is bounded in both nodes and depth, and prunes `Document` subtrees
 * so it never descends into the web page's own accessibility tree — which is
 * huge, lazily realised, and would make a URL read cost more than the frame it
 * is annotating.
 */
const UIA_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class IqRecNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
$SEP = [char]30
$AE = [System.Windows.Automation.AutomationElement]
$editType = [System.Windows.Automation.ControlType]::Edit
$docType  = [System.Windows.Automation.ControlType]::Document
$valuePattern = [System.Windows.Automation.ValuePattern]::Pattern
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Read-Value($el) {
  try {
    $vp = $el.GetCurrentPattern($valuePattern)
    if ($vp -ne $null) { return $vp.Current.Value }
  } catch {}
  return ""
}

function Looks-Url($v) {
  if ([string]::IsNullOrWhiteSpace($v)) { return $false }
  if ($v.Contains('://')) { return $true }
  if ((-not $v.Contains(' ')) -and $v.Contains('.')) { return $true }
  return $false
}

function Read-Url {
  $h = [IqRecNative]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { return "" }
  $root = $AE::FromHandle($h)
  if ($root -eq $null) { return "" }
  $title = ""
  try { $title = $root.Current.Name } catch {}

  $queue = New-Object System.Collections.Generic.Queue[object]
  $queue.Enqueue(@($root, 0))
  $seen = 0
  $best = ""
  while ($queue.Count -gt 0 -and $seen -lt 600) {
    $item = $queue.Dequeue()
    $el = $item[0]; $depth = $item[1]
    $seen++
    $ct = $null
    try { $ct = $el.Current.ControlType } catch {}
    if ($ct -eq $docType) { continue }
    if ($ct -eq $editType) {
      $v = Read-Value $el
      if (Looks-Url $v) {
        $n = ""; $id = ""
        try { $n = $el.Current.Name } catch {}
        try { $id = $el.Current.AutomationId } catch {}
        if ($id -eq 'omnibox' -or $id -eq 'addressEditBox' -or $id -eq 'urlbar-input' -or $n -like '*address*' -or $n -like '*enter address*' -or $n -like '*search or enter*') {
          return "$v$SEP$title"
        }
        if ($best -eq "") { $best = $v }
      }
    }
    if ($depth -lt 8) {
      $child = $walker.GetFirstChild($el)
      while ($child -ne $null) {
        $queue.Enqueue(@($child, $depth + 1))
        $child = $walker.GetNextSibling($child)
      }
    }
  }
  if ($best -ne "") { return "$best$SEP$title" }
  return ""
}

[Console]::Out.WriteLine('${READY}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $out = ""
  try { $out = Read-Url } catch { $out = "" }
  [Console]::Out.WriteLine($out)
  [Console]::Out.Flush()
}
`;

/**
 * Turn an address-bar value into something parseable, or reject it.
 *
 * Address bars usually hide the scheme, so `github.com/foo` has to be restored
 * to a URL. Anything with whitespace or without a dot is a half-typed search
 * term, and emitting those would fill the timeline with keystroke noise
 * disguised as navigation.
 */
function normalizeUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  if (!/\s/.test(value) && value.includes(".")) return `https://${value}`;
  return null;
}

export interface ActiveUrl {
  url: string;
  title?: string;
}

export class WindowsUrlProvider {
  private proc: ChildProcess | null = null;
  private reader: Interface | null = null;
  private scriptDir: string | null = null;
  private ready = false;
  private busy = false;
  private disposed = false;
  private startAttempts = 0;
  private waiter: ((line: string) => void) | null = null;

  supports(app: string): boolean {
    return process.platform === "win32" && isBrowserApp(app);
  }

  async get(app: string): Promise<ActiveUrl | null> {
    if (this.disposed || !this.supports(app)) return null;
    this.ensureHost();
    // A read already in flight means the previous one has not answered yet.
    // Queuing would only deepen the backlog, so this poll simply skips.
    if (!this.proc || !this.ready || this.busy) return null;

    const line = await this.request();
    if (line === null) return null;
    const [rawUrl, title] = line.split(SEP);
    const url = normalizeUrl(rawUrl ?? "");
    if (!url) return null;
    return { url, title: title?.trim() || undefined };
  }

  dispose(): void {
    this.disposed = true;
    this.killHost();
  }

  private request(): Promise<string | null> {
    return new Promise((resolve) => {
      const proc = this.proc;
      if (!proc?.stdin?.writable) return resolve(null);
      this.busy = true;
      let settled = false;
      const done = (line: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiter = null;
        this.busy = false;
        resolve(line);
      };
      const timer = setTimeout(() => {
        // Resolve before recycling: a late answer arriving after the next
        // request was sent would otherwise be read as that request's result.
        done(null);
        this.killHost();
      }, REQUEST_TIMEOUT_MS);
      this.waiter = done;
      try {
        proc.stdin.write("get\n");
      } catch {
        done(null);
      }
    });
  }

  private ensureHost(): void {
    if (this.proc || this.disposed || this.startAttempts >= MAX_START_ATTEMPTS) return;
    this.startAttempts += 1;
    try {
      this.scriptDir = mkdtempSync(join(tmpdir(), "iq-uia-"));
      const scriptPath = join(this.scriptDir, "read-url.ps1");
      writeFileSync(scriptPath, UIA_SCRIPT, "utf8");

      const proc = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
      );
      this.proc = proc;
      proc.on("error", () => this.killHost());
      proc.on("exit", () => this.killHost());

      if (proc.stdout) {
        this.reader = createInterface({ input: proc.stdout });
        this.reader.on("line", (line) => {
          if (!this.ready) {
            // Anything before READY is assembly-loading chatter, not an answer.
            if (line.trim() === READY) this.ready = true;
            return;
          }
          this.waiter?.(line);
        });
      }
    } catch {
      this.killHost();
    }
  }

  private killHost(): void {
    const proc = this.proc;
    this.proc = null;
    this.ready = false;
    this.busy = false;
    // A pending read must be released, or its caller waits for the timeout on
    // a process that is already gone.
    this.waiter?.("");
    this.waiter = null;
    this.reader?.close();
    this.reader = null;
    try {
      proc?.stdin?.end();
      proc?.kill();
    } catch {
      // Already dead; nothing to do.
    }
    if (this.scriptDir) {
      try {
        rmSync(this.scriptDir, { recursive: true, force: true });
      } catch {
        // A temp directory left behind is harmless.
      }
      this.scriptDir = null;
    }
  }
}
