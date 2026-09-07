import { spawn } from "node:child_process";
import type { McpInspectResult, McpToolDescriptor, McpTransport } from "@iq/shared";
import { resolveSpawnTarget } from "../util/executable.js";

/**
 * A deliberately minimal MCP client, used only to ask a server what it offers.
 *
 * The Copilot SDK runs MCP servers during a turn; this does not duplicate that.
 * Its only job is the inspection step the governance model requires — connect,
 * ask for the tool list, disconnect — so a person can read what a server
 * advertises *before* deciding whether any of it may be called. Because the
 * probe never invokes a tool, it stays small and holds no long-lived state.
 *
 * Both transports speak JSON-RPC 2.0: stdio frames messages as newline
 * delimited JSON, and Streamable HTTP posts them to an endpoint.
 */

/** A probe is a user-facing operation, so it must fail quickly and visibly. */
const TIMEOUT_MS = 15_000;
/**
 * A locally spawned server gets much longer, because the first run is not the
 * server being slow — it is a package manager fetching it.
 *
 * `uvx markitdown-mcp` resolves, downloads and builds an environment before the
 * server has a chance to say anything, and on a cold cache or a slow connection
 * that is minutes, not seconds. At fifteen seconds the app reported "server did
 * not answer in time" for a server that was working exactly as documented, and
 * the only way through was to run the command in a terminal first.
 */
const STDIO_TIMEOUT_MS = 180_000;
const MAX_BYTES = 4 * 1024 * 1024;

export interface McpProbeTarget {
  id: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
}

export async function probeMcpServer(target: McpProbeTarget): Promise<McpInspectResult> {
  try {
    const result =
      target.transport === "stdio" ? await probeStdio(target) : await probeHttp(target);
    return { id: target.id, ok: true, ...result, error: "" };
  } catch (error) {
    return {
      id: target.id,
      ok: false,
      serverName: "",
      serverVersion: "",
      tools: [],
      warning: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

interface ProbeOutcome {
  serverName: string;
  serverVersion: string;
  tools: McpToolDescriptor[];
  /**
   * A complaint the server made while starting successfully.
   *
  * Empty for almost every server. It exists because a proxy can answer
  * `tools/list` after an optional remote tool set fails to load. The probe
  * would otherwise report a clean success with a short list, which is
  * indistinguishable from a server that simply offers few tools.
   */
  warning: string;
}

const INITIALIZE = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "IQ Compiler", version: "0.1.0" },
  },
};

const LIST_TOOLS = { jsonrpc: "2.0" as const, id: 2, method: "tools/list", params: {} };

/**
 * Probe a stdio server.
 *
 * The child is spawned with `shell: false` and an explicit argument list. A
 * server command is user-supplied configuration, and running it through a shell
 * would turn a configuration field into an arbitrary command line.
 *
 * The command is resolved first (see `util/executable.ts`). On Windows that is
 * the difference between working and not: `spawn` does not consult `PATHEXT`,
 * so a bare `npx` fails with `ENOENT` on a machine where `npx.cmd` is right
 * there on `PATH` — and the honest-looking error sends the user to reinstall
 * Node, which was never the problem.
 */
async function probeStdio(target: McpProbeTarget): Promise<ProbeOutcome> {
  if (target.command.trim() === "") throw new Error("no command configured");

  const resolved = await resolveSpawnTarget(target);
  if (resolved.via === "shim_unsupported") {
    throw new Error(shimProblem(target.command, resolved.resolvedPath));
  }

  const child = spawn(resolved.command, resolved.args, {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...target.env },
  });

  const pending = new Map<number, (message: JsonRpcResponse) => void>();
  let buffer = "";
  let bytes = 0;
  let stderr = "";

  const finished = new Promise<never>((_, reject) => {
    child.on("error", (error) => reject(new Error(startupProblem(target, error))));
    child.on("exit", (code) => reject(new Error(describeExit(code, stderr))));
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    // Kept from the END, and generously: a launcher preamble plus a server's
    // own banner can run to thousands of characters before the line that
    // explains the crash.
    stderr = (stderr + chunk).slice(-8_000);
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) {
      child.kill();
      return;
    }
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line === "") continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue; // Servers sometimes log to stdout; ignore what is not JSON-RPC.
      }
      if (typeof message.id === "number") pending.get(message.id)?.(message);
    }
  });

  const send = (request: unknown, id: number): Promise<JsonRpcResponse> => {
    const answered = new Promise<JsonRpcResponse>((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify(request)}\n`);
    return answered;
  };

  try {
    const initialize = await race([send(INITIALIZE, 1), finished], STDIO_TIMEOUT_MS, target.command);
    const info = unwrap(initialize);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );

    const listed = await race([send(LIST_TOOLS, 2), finished], STDIO_TIMEOUT_MS, target.command);
    return {
      ...serverInfo(info),
      tools: readTools(unwrap(listed)),
      warning: startupComplaint(stderr),
    };
  } finally {
    child.stdin.end();
    child.kill();
  }
}

/** Probe an HTTP server. Streamable HTTP may answer as JSON or as one SSE frame. */
async function probeHttp(target: McpProbeTarget): Promise<ProbeOutcome> {
  const endpoint = parseEndpoint(target.url);

  const post = async (body: unknown): Promise<JsonRpcResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...target.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await describeHttpFailure(response, endpoint));
      const text = (await response.text()).slice(0, MAX_BYTES);
      return parseHttpBody(text);
    } finally {
      clearTimeout(timer);
    }
  };

  const info = unwrap(await post(INITIALIZE));
  const listed = unwrap(await post(LIST_TOOLS));
  // An HTTP server has no side channel to complain on: a failure is a status
  // code, and `describeHttpFailure` has already read it.
  return { ...serverInfo(info), tools: readTools(listed), warning: "" };
}

/**
 * Say what an HTTP server actually refused, rather than only its status code.
 *
 * "server answered 401" is the single most common outcome of inspecting a
 * hosted MCP server and it was also the least useful sentence the app could
 * have produced: every remote server needs a token, so the status alone tells
 * a reader nothing they had not already guessed, and the response carried the
 * whole explanation in a header that was being thrown away.
 *
 * A 401 from an MCP server is specified: RFC 9728 puts a `WWW-Authenticate`
 * challenge on it naming the authorization server, the client the resource
 * will talk to, and a metadata document listing the scopes. Reading those back
 * turns "it said no" into "it wants scope X from tenant endpoint Y, issued to
 * client Z" — which is the difference between a dead end and a next step.
 */
async function describeHttpFailure(response: Response, endpoint: string): Promise<string> {
  const body = trim((await response.text().catch(() => "")).slice(0, 600));
  const unauthorized = response.status === 401 || response.status === 403;
  const challenge = parseChallenge(response.headers.get("www-authenticate") ?? "");

  if (!unauthorized || Object.keys(challenge).length === 0) {
    return `server answered ${response.status}${body === "" ? "" : `: ${body}`}`;
  }

  const named = challenge["resource_metadata"];
  const metadata = named === undefined ? null : await readResourceMetadata(named, endpoint);

  const parts = [
    `server answered ${response.status}: it needs an OAuth access token${
      metadata?.resource_name === undefined ? "" : ` for ${metadata.resource_name}`
    }`,
  ];
  const scopes = metadata?.scopes_supported ?? [];
  if (scopes.length > 0) parts.push(`scope ${scopes.join(", ")}`);
  const issuer = metadata?.authorization_servers?.[0] ?? challenge["authorization_uri"];
  if (issuer !== undefined) parts.push(`from ${issuer}`);
  // The resource names the client it will accept a token from. When that is not
  // this app, no amount of signing in here will help, and saying so is the
  // point — the remedy is a token obtained elsewhere and pasted in as a header.
  if (challenge["client_id"] !== undefined) {
    parts.push(`issued to client ${challenge["client_id"]}`);
  }
  parts.push("Add it as an Authorization header on this server");
  return parts.join(" · ");
}

/** `WWW-Authenticate: Bearer k="v", k2="v2"` as a map. Unknown keys are kept. */
function parseChallenge(header: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [, key, value] of header.matchAll(/([a-z_]+)="([^"]*)"/gi)) {
    if (key !== undefined && value !== undefined && value !== "") found[key.toLowerCase()] = value;
  }
  return found;
}

interface ProtectedResourceMetadata {
  resource_name?: string;
  scopes_supported?: string[];
  authorization_servers?: string[];
}

/**
 * The RFC 9728 metadata document the challenge points at.
 *
 * **Same origin as the endpoint, and https, or it is not read.** The URL comes
 * from a remote server's response header, so following it anywhere it likes
 * would make inspecting a server a request the server gets to aim — at a cloud
 * metadata service, or at something inside the network this app is running in.
 * The document is only ever used to make an error message legible, so a refusal
 * to read it costs a sentence and nothing else.
 */
async function readResourceMetadata(
  url: string,
  endpoint: string,
): Promise<ProtectedResourceMetadata | null> {
  try {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.origin !== new URL(endpoint).origin) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(target, { signal: controller.signal });
      if (!response.ok) return null;
      return JSON.parse((await response.text()).slice(0, 64 * 1024)) as ProtectedResourceMetadata;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * Endpoints must be https, with loopback the single exception.
 *
 * A local server on 127.0.0.1 is the normal way to run MCP during development
 * and never leaves the machine; anything else carries headers that may contain
 * a token, and must not travel in clear text.
 */
export function parseEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("not a valid URL");
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("MCP endpoints must use https, except on loopback");
  }
  return url.toString();
}

function parseHttpBody(text: string): JsonRpcResponse {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as JsonRpcResponse;

  // Server-sent events: take the first `data:` payload that parses.
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      return JSON.parse(payload) as JsonRpcResponse;
    } catch {
      continue;
    }
  }
  throw new Error("server did not answer with JSON-RPC");
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

function unwrap(message: JsonRpcResponse): Record<string, unknown> {
  if (message.error) throw new Error(message.error.message ?? "server returned an error");
  return (message.result ?? {}) as Record<string, unknown>;
}

function serverInfo(result: Record<string, unknown>): {
  serverName: string;
  serverVersion: string;
} {
  const info = result["serverInfo"];
  if (!info || typeof info !== "object") return { serverName: "", serverVersion: "" };
  const record = info as Record<string, unknown>;
  return {
    serverName: typeof record["name"] === "string" ? record["name"] : "",
    serverVersion: typeof record["version"] === "string" ? record["version"] : "",
  };
}

/**
 * Read the advertised tool list.
 *
 * Descriptions come from an untrusted party and are shown to a person who is
 * about to grant access, so they are truncated and stripped of control
 * characters rather than rendered as the server wrote them.
 */
export function readTools(result: Record<string, unknown>): McpToolDescriptor[] {
  const raw = result["tools"];
  if (!Array.isArray(raw)) return [];

  const tools: McpToolDescriptor[] = [];
  for (const entry of raw.slice(0, 500)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = record["name"];
    if (typeof name !== "string" || name === "") continue;
    tools.push({
      name: name.slice(0, 200),
      description:
        typeof record["description"] === "string" ? trim(record["description"], 500) : "",
    });
  }
  return tools;
}

function trim(text: string, limit = 500): string {
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

/**
 * Lines a launcher prints on its way to running the real program.
 *
 * `npx` emits one `npm warn Unknown env config "…"` per unrecognised setting,
 * and a corporate .npmrc easily has a dozen. They arrive first, so a naive
 * head-of-stderr report is entirely warnings and the exception that actually
 * killed the server is cut off — which is exactly how a working Power BI
 * server read as "server exited (3762504530): npm warn Unknown env config…".
 */
const LAUNCHER_NOISE = /^(npm|pnpm|yarn) (warn|WARN|notice|noticed)\b/;

/**
 * The hosts a package runner must reach before the server it fetches exists.
 *
 * `uvx` and `npx -y` do not ship the server: they resolve and download it on
 * first use, so on a machine that cannot reach these, the server is not broken
 * — it was never delivered.
 */
const PACKAGE_HOSTS =
  /\b(files\.pythonhosted\.org|pypi\.org|registry\.npmjs\.org|registry\.yarnpkg\.com)\b/;

/**
 * A connection that never completed, as opposed to a host that answered badly.
 *
 * A 404 or a 403 is the registry talking. These are the connection being taken
 * away underneath it, which is what filtering looks like from inside the
 * process.
 */
const TRANSPORT_FAILURE =
  /received fatal alert|handshake\s*failure|error sending request|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|self[- ]signed certificate|unable to (verify|get) local issuer/i;

/**
 * A package host that could not be reached at all.
 *
 * Endpoint-security or network-filtering policy can terminate a TLS handshake
 * to a package host before a package runner downloads the server. A typical
 * runner reports
 *
 *   error: Request failed after 3 retries in 8.3s
 *     Caused by: Failed to fetch: `https://files.pythonhosted.org/…/starlette-1.4.1-py3-none-any.whl.metadata`
 *     Caused by: error sending request for url (…)
 *     Caused by: client error (Connect)
 *     Caused by: received fatal alert: HandshakeFailure
 *
 * This app cannot work around that policy. The diagnostic names the blocked
 * host and directs the user to the system or package-manager configuration.
 *
 * Narrow on purpose. It fires only when a known package host appears *and* the
 * connection itself failed; a registry answering 404 for a misspelt package is
 * a different problem with a different answer.
 */
export function blockedPackageHost(stderr: string): string {
  const host = PACKAGE_HOSTS.exec(stderr)?.[1];
  if (host === undefined || !TRANSPORT_FAILURE.test(stderr)) return "";
  return (
    `The connection to ${host} did not complete, so the server was never downloaded — this is ` +
    "what an endpoint-security or network-filtering policy looks like from here, not an " +
    "outage. On Windows, Defender Network Protection records it as event 1126 in the " +
    '"Microsoft-Windows-Windows Defender/Operational" log. Nothing in this app can route ' +
    "around it: the host has to be allowed, or the package tool pointed at a mirror that is " +
    "(uv and pip read UV_INDEX_URL and PIP_INDEX_URL; npm reads its own registry setting)."
  );
}

/**
 * What a dead server's exit code and output actually say.
 *
 * Three rules keep the message useful:
 *
 *  - **Drop the launcher's own chatter, and read from the END.** A crash
 *    message is the last thing written, never the first.
 *  - **Translate the exit code when it means something.** Windows reports an
 *    unhandled .NET exception as 0xE0434352, which as an unsigned decimal is
 *    3762504530 and looks like line noise. Node also reports it as the signed
 *    -532462766 depending on how the process was reaped, so both are matched.
 *  - **Name a blocked package host as a policy, not as a failure of the
 *    server.** See {@link blockedPackageHost}.
 *
 * Exported for direct tests of the user-facing diagnostic.
 */
export function describeExit(code: number | null, stderr: string): string {
  const meaningful = stderr
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !LAUNCHER_NOISE.test(line.trim()))
    .slice(-12)
    .join(" ");

  const CLR_UNHANDLED = [3_762_504_530, -532_462_766];
  const reason =
    code !== null && CLR_UNHANDLED.includes(code)
      ? "exited on an unhandled .NET exception (0xE0434352)"
      : `exited (${code ?? "signal"})`;

  const blocked = blockedPackageHost(stderr);
  const detail = meaningful === "" ? "" : `: ${trim(meaningful, 700)}`;
  return `server ${reason}${detail}${blocked === "" ? "" : ` — ${blocked}`}`;
}

/**
 * A failure a server reported while nonetheless starting.
 *
 * Only lines that say something went wrong, and only from a run that
 * succeeded. A server may remain available while an optional remote tool set
 * fails to load, so the probe result needs both facts.
 *
 * Deliberately narrow. Anything broader turns every chatty server's startup
 * log into an alarm, and an alarm that is usually wrong is ignored when it is
 * right.
 *
 * Exported for direct tests of the user-facing diagnostic.
 */
const COMPLAINT =
  /\b(fail(ed|ure)?|error|unauthori[sz]ed|denied|unavailable|not\s+(be\s+)?available)\b/i;

export function startupComplaint(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !LAUNCHER_NOISE.test(line) && COMPLAINT.test(line));
  return lines.length === 0 ? "" : trim(lines.slice(-6).join(" "), 700);
}

/**
 * Say what actually went wrong, rather than repeating the syscall.
 *
 * `spawn uvx ENOENT` is accurate and useless: it names a program the reader may
 * never have heard of and does not say what to do. The runner is the missing
 * prerequisite far more often than the server is, so it gets named.
 */
function startupProblem(target: McpProbeTarget, error: NodeJS.ErrnoException): string {
  if (error.code !== "ENOENT") return `could not start server: ${error.message}`;

  const runner = target.command.toLowerCase();
  if (runner === "uvx" || runner === "uv") {
    return (
      `"${target.command}" is not on PATH. This server runs through uv, which is not bundled ` +
      "with this app — install it (`pip install uv`, or see astral.sh/uv) and inspect again."
    );
  }
  if (runner === "npx" || runner === "node" || runner === "npm") {
    return (
      `"${target.command}" is not on PATH. This server needs Node.js installed and on PATH — ` +
      "if it is installed, the app may have been started before PATH was set, so restart it."
    );
  }
  return `"${target.command}" is not on PATH, so there is nothing to start.`;
}

/**
 * A batch shim that was found and cannot be started.
 *
 * Worth its own message because it is the opposite of "not installed": the file
 * is right there, and telling someone to install what they already have is how
 * an hour disappears. Windows refuses to spawn `.cmd` without a shell (the fix
 * for CVE-2024-27980), and this app will not use one for a command that came
 * out of a settings field.
 */
function shimProblem(command: string, resolvedPath: string): string {
  return (
    `"${command}" resolves to the Windows batch shim ${resolvedPath}, which cannot be started ` +
    "without a shell — and this app will not run a configured command through one. The script " +
    "behind the shim could not be found either. Point the command at the program itself, for " +
    "example `node` with the server's entry script as its first argument."
  );
}

function race<T>(promises: Array<Promise<T>>, ms = TIMEOUT_MS, command = ""): Promise<T> {
  return Promise.race([
    ...promises,
    new Promise<T>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `server did not answer within ${Math.round(ms / 1000)}s` +
                (command === "uvx" || command === "uv"
                  ? ". A first uvx run downloads and builds the server before it can reply; run it " +
                    "once in a terminal to warm the cache, then inspect again."
                  : "."),
            ),
          ),
        ms,
      ),
    ),
  ]);
}
