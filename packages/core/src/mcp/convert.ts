import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveSpawnTarget } from "../util/executable.js";
import type { ConverterTarget } from "./registry.js";

/**
 * Calling one approved MCP tool, for one purpose: converting a file to Markdown.
 *
 * `probe.ts` deliberately never invokes anything — its job is to let a person
 * read what a server advertises *before* deciding whether any of it may be
 * called. This is the other side of that decision, and it is written narrowly
 * rather than as a general client, because a general "call any tool" path in
 * privileged code is exactly the thing the approval model exists to prevent.
 *
 * Three conditions, all required, none of them inferable:
 *
 *  - the server is configured and **enabled**;
 *  - `convert_to_markdown` is in its **approved** tools;
 *  - the caller is ingest, converting a file the user themselves put in the
 *    vault's `source/`.
 *
 * MarkItDown is Microsoft's converter (`uvx markitdown-mcp`). It is not bundled
 * — it needs `uv` on PATH — so the absence of a converter is the normal case
 * and every caller has to handle it.
 *
 * What comes back is a document's contents. It is untrusted text to be quoted,
 * never instructions to follow, and it is written into a note whose frontmatter
 * records which file it came from.
 */

const CONVERT_TOOL = "convert_to_markdown";
/**
 * Long, because the first `uvx markitdown-mcp` fetches and builds the server
 * before it can answer. The probe uses the same allowance for the same reason.
 */
const TIMEOUT_MS = 180_000;
const MAX_BYTES = 4 * 1024 * 1024;

/** The tool name the registry is asked to find an approval for. */
export const CONVERT_TO_MARKDOWN = CONVERT_TOOL;

/**
 * Convert one local file to Markdown.
 *
 * Returns null rather than throwing when the converter fails: ingest continues,
 * reports the file as unreadable, and the person who added it finds out. A
 * conversion failure is not a reason to abandon the other sources.
 */
export async function convertToMarkdown(
  target: ConverterTarget,
  absolutePath: string,
): Promise<string | null> {
  try {
    return await callStdio(target, pathToFileURL(absolutePath).href);
  } catch {
    return null;
  }
}

interface JsonRpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

async function callStdio(target: ConverterTarget, uri: string): Promise<string | null> {
  // `shell: false` with an explicit argument list. A server command is
  // user-supplied configuration, and a shell would turn it into a command line.
  // Resolved first so a Windows `.cmd` shim launches at all; see
  // `util/executable.ts`.
  const resolved = await resolveSpawnTarget(target);
  const child = spawn(resolved.command, resolved.args, {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...target.env },
  });

  const pending = new Map<number, (message: JsonRpcResponse) => void>();
  let buffer = "";
  let bytes = 0;

  const died = new Promise<never>((_, reject) => {
    child.on("error", (error) => reject(new Error(error.message)));
    child.on("exit", (code) => reject(new Error(`converter exited (${code ?? "signal"})`)));
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
      try {
        const message = JSON.parse(line) as JsonRpcResponse;
        if (typeof message.id === "number") pending.get(message.id)?.(message);
      } catch {
        // Servers sometimes log to stdout. Not JSON-RPC, not our business.
      }
    }
  });

  const send = (request: unknown, id: number): Promise<JsonRpcResponse> => {
    const answered = new Promise<JsonRpcResponse>((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify(request)}\n`);
    return answered;
  };

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("converter timed out")), TIMEOUT_MS).unref?.();
  });

  try {
    await Promise.race([
      send(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "IQ Compiler", version: "0.1.0" },
          },
        },
        1,
      ),
      died,
      timeout,
    ]);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const answer = await Promise.race([
      send(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: CONVERT_TOOL, arguments: { uri } },
        },
        2,
      ),
      died,
      timeout,
    ]);

    if (answer.error) return null;
    return readText(answer.result);
  } finally {
    child.stdin.end();
    child.kill();
  }
}

/** MCP returns content as a list of parts; only the text ones are of use here. */
function readText(result: Record<string, unknown> | undefined): string | null {
  const content = result?.["content"];
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  const joined = parts.join("\n\n").trim();
  return joined === "" ? null : joined;
}
