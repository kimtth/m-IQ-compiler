import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import type { AzureFailureKind } from "@iq/shared";

/**
 * Thin wrapper around the Azure CLI.
 *
 * IQ Compiler has no Entra application registration of its own, so Microsoft
 * identity is borrowed from the CLI's first-party client, the way
 * `AzureCliCredential` does. Every call is a plain process invocation, which is
 * what lets the whole identity layer be tested without a network or a browser.
 */

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injected so tests (and non-Windows hosts) can substitute the invocation. */
export type RunCli = (args: readonly string[], timeoutMs?: number) => Promise<CliResult>;

/** A real executable plus the arguments that must precede the CLI's own. */
export interface AzCommand {
  readonly command: string;
  readonly prefixArgs: readonly string[];
  /** How it was found, for the log line when sign-in fails. */
  readonly via: "path" | "python" | "shell";
}

export class AzureCliMissingError extends Error {
  readonly kind = "cli_missing";
  constructor() {
    super(
      "Azure CLI was not found. Install it from https://aka.ms/azure-cli and restart IQ Compiler. " +
        "No app registration, client id or tenant id is required.",
    );
    this.name = "AzureCliMissingError";
  }
}

const isFile = (candidate: string): boolean => {
  try {
    accessSync(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

/** First match for `name` across PATH, or null. */
function onPath(names: readonly string[]): string | null {
  const dirs = (process.env["PATH"] ?? "").split(delimiter).filter((entry) => entry.length > 0);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir.replace(/^"|"$/g, ""), name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

let cachedCommand: AzCommand | null | undefined;

/**
 * Find something we can actually `spawn`.
 *
 * On Windows the Azure CLI is only ever a `.cmd` shim, and since the fix for
 * CVE-2024-27980 Node refuses to spawn a batch file unless a shell is involved
 * — the failure is a bare `spawn EINVAL`, which says nothing useful. Handing the
 * command to `cmd.exe` would fix the symptom but put user-supplied text (a
 * tenant id, a resource URI) on a shell command line, so it is the last resort
 * rather than the first.
 *
 * The shim itself shows the better answer: `az.cmd` does nothing but run
 * `..\python.exe -IBm azure.cli %*`. That interpreter is a real executable next
 * to the shim, so invoking it directly is both spawnable and shell-free, and the
 * arguments stay a proper argv the way they do on every other platform.
 */
export function resolveAzCommand(): AzCommand | null {
  if (cachedCommand !== undefined) return cachedCommand;
  cachedCommand = findAzCommand();
  return cachedCommand;
}

/** Test seam: forget a resolution so a changed PATH is picked up. */
export function resetAzCommandCache(): void {
  cachedCommand = undefined;
}

function findAzCommand(): AzCommand | null {
  if (process.platform !== "win32") {
    // `az` is a shebang script; spawn resolves it through PATH and the kernel
    // runs its interpreter, so there is nothing to unwrap.
    return { command: "az", prefixArgs: [], via: "path" };
  }

  // A real .exe, if some future installer ships one, needs no unwrapping.
  const exe = onPath(["az.exe"]);
  if (exe) return { command: exe, prefixArgs: [], via: "path" };

  const shim = onPath(["az.cmd", "az.bat"]);
  if (!shim) return null;

  // The MSI layout: wbin\az.cmd runs ..\python.exe -IBm azure.cli.
  const python = resolvePath(dirname(shim), "..", "python.exe");
  if (isFile(python)) return { command: python, prefixArgs: ["-IBm", "azure.cli"], via: "python" };

  // Fallback for layouts we do not recognise. Arguments are validated before
  // they reach the command line, so this cannot become a shell injection.
  return { command: process.env["ComSpec"] ?? "cmd.exe", prefixArgs: ["/d", "/s", "/c", shim], via: "shell" };
}

/**
 * Arguments that are safe to place on a `cmd.exe` command line.
 *
 * Every argument this app passes is a CLI verb, a flag, a GUID, a domain or an
 * https resource URI, so the conservative set below costs nothing. Anything
 * carrying a shell metacharacter is refused outright rather than escaped: a
 * tenant id is user input, and quoting rules for `cmd.exe` are subtle enough
 * that refusing is the only version of this that is obviously correct.
 */
const SHELL_SAFE = /^[A-Za-z0-9._:/@=+-]+$/;

function assertShellSafe(args: readonly string[]): void {
  for (const arg of args) {
    if (!SHELL_SAFE.test(arg)) {
      throw new Error(`refusing to pass ${JSON.stringify(arg)} to the Azure CLI through a shell`);
    }
  }
}

export const spawnAzureCli: RunCli = (args, timeoutMs = 300_000) =>
  new Promise<CliResult>((resolve, reject) => {
    const az = resolveAzCommand();
    if (!az) {
      reject(new AzureCliMissingError());
      return;
    }
    if (az.via === "shell") assertShellSafe(args);

    const child = spawn(az.command, [...az.prefixArgs, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanEnv(),
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // A resolution that no longer works — the CLI was uninstalled or moved
      // mid-session — must not stay cached, or every retry repeats it.
      resetAzCommandCache();
      reject(
        error.code === "ENOENT" || error.code === "EINVAL" ? new AzureCliMissingError() : error,
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

/**
 * Strip inherited Azure credential overrides before shelling out.
 *
 * A stale `AZURE_*` service-principal triplet in the parent environment makes
 * the CLI authenticate as something other than the signed-in user, which then
 * fails in ways that look nothing like an identity problem.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_TENANT_ID"]) {
    delete env[key];
  }
  return env;
}

/**
 * How an Azure CLI failure should be surfaced to the user.
 *
 * This is the shared `AzureFailureKind` contract, not a private vocabulary: the
 * renderer keys its recovery affordance (retry, sign in, open the tenant picker,
 * install the CLI) off exactly these values, so classification here and the
 * recovery UI there cannot drift. The contract renamed the two kinds whose old
 * names misdescribed the remedy — `tenant_not_member` became `wrong_tenant`
 * because AADSTS50020 is a membership problem the tenant picker fixes, and the
 * US spelling `canceled` became `cancelled` to match the enum — and added
 * `expired`, which needs a fresh interactive sign-in rather than a plain retry.
 */
export type CliFailureKind = AzureFailureKind;

export interface CliFailure {
  kind: CliFailureKind;
  message: string;
}

/**
 * Turn CLI stderr into something actionable.
 *
 * The distinctions that matter are the ones with different remedies: install the
 * CLI, sign in again, retry after consent, or pick a different tenant. Order is
 * deliberate — the tenant-membership and consent codes are checked before the
 * generic "not signed in" hints, because an AADSTS failure often also carries a
 * "run az login" line and misclassifying it would send the user to the wrong fix.
 */
export function classifyCliFailure(stderr: string, code: number): CliFailure {
  const text = stderr.trim();
  const lower = text.toLowerCase();

  if (lower.includes("aadsts50020") || (lower.includes("user account") && lower.includes("does not exist in tenant"))) {
    return {
      kind: "wrong_tenant",
      message:
        "That account is not a member of the requested tenant. Open the tenant picker and choose a tenant this " +
        "account can access, or clear the tenant id to use your home tenant. This is not a permissions problem — " +
        "the account simply does not belong to that tenant.",
    };
  }
  if (
    lower.includes("aadsts65004") ||
    lower.includes("aadsts65001") ||
    lower.includes("aadsts53003") ||
    lower.includes("interaction_required") ||
    lower.includes("conditional access") ||
    lower.includes("consent")
  ) {
    return {
      kind: "consent_required",
      message:
        "This resource needs consent or a conditional-access check. Complete the prompt in the browser, or ask a " +
        "tenant administrator to approve Azure CLI access, then try again.",
    };
  }
  if (
    lower.includes("aadsts700082") ||
    lower.includes("aadsts50173") ||
    lower.includes("aadsts700084") ||
    lower.includes("refresh token has expired") ||
    lower.includes("token has expired") ||
    lower.includes("token is expired")
  ) {
    return {
      kind: "expired",
      message: "Your Azure session has expired. Sign in again to continue.",
    };
  }
  if (
    lower.includes("please run 'az login'") ||
    lower.includes("please run 'az account set'") ||
    (lower.includes("az login") && lower.includes("not logged in")) ||
    lower.includes("no subscription found") ||
    lower.includes("interactive authentication is needed")
  ) {
    return { kind: "not_signed_in", message: "Not signed in to Azure. Connect your Microsoft account to continue." };
  }
  if (lower.includes("cancel") || lower.includes("aadsts50199") || lower.includes("user canceled")) {
    return { kind: "cancelled", message: "Sign-in was cancelled. Try connecting again when you are ready." };
  }
  return {
    kind: "failed",
    message: text.length > 0 ? firstLines(text, 4) : `Azure CLI exited with code ${code}.`,
  };
}

function firstLines(text: string, count: number): string {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(0, count)
    .join(" ");
}

export class AzureCliError extends Error {
  constructor(readonly failure: CliFailure) {
    super(failure.message);
    this.name = "AzureCliError";
  }
}

/** Parse CLI JSON output, tolerating the banner lines the CLI sometimes emits. */
export function parseCliJson<T>(stdout: string): T {
  const trimmed = stdout.trim();
  const start = trimmed.search(/[[{]/);
  if (start < 0) throw new Error("Azure CLI returned no JSON output");
  return JSON.parse(trimmed.slice(start)) as T;
}
