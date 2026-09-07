#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { MYIQ_SNAPSHOT_FILE, MyIqSnapshot } from "@iq/shared";

/**
 * The My IQ MCP server.
 *
 * This is the one thing in the product that faces outwards: another app — VS
 * Code, Claude Desktop, anything speaking MCP — spawns it and reads My IQ
 * through it. It exists to answer "how would my knowledge, cells and analysis
 * be useful somewhere else?", so it is built to be as boring and as narrow as
 * that question allows.
 *
 * What it can do:
 *   - read exactly one file, `<IQ_HOME>/myiq/published.json`
 *   - answer five read-only tools from what is in it
 *
 * What it cannot do, by construction rather than by policy:
 *   - write anything, anywhere
 *   - open a socket, resolve a name, or make a request
 *   - run a subprocess or a shell
 *   - read a path supplied by a caller. No tool takes a path argument, and the
 *     one path it does use is derived from the environment, so there is no
 *     input that can steer it at another file.
 *
 * It also refuses a snapshot that is not marked `sampleDataOnly`. The app only
 * writes marked ones, so this is a second lock on the same door: a future
 * change on the writing side that started including real records would fail
 * here rather than quietly serving them.
 *
 * No SDK. The protocol surface used is three methods over newline-delimited
 * JSON-RPC on stdio, and a dependency whose own transitive tree we would then
 * be shipping to other people's machines is a poor trade for that.
 */

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "my-iq";
const SERVER_VERSION = "0.1.0";

/** Where the app keeps its home. Same rule as `resolveAppPaths`. */
const iqHome = (): string => process.env["IQ_HOME"] ?? join(homedir(), ".iq-compiler");

const snapshotPath = (): string => join(iqHome(), "myiq", MYIQ_SNAPSHOT_FILE);

interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const NO_ARGS = { type: "object", properties: {}, additionalProperties: false } as const;

const TOOLS: ToolDescriptor[] = [
  {
    name: "myiq_list_cells",
    description:
      "List the IQ Cells published from My IQ. An IQ Cell is a compiled, versioned procedure: what it does, which systems it is declared to reach, how often it has run and who approved it. Sample data.",
    inputSchema: NO_ARGS,
  },
  {
    name: "myiq_get_cell",
    description:
      "Read one published IQ Cell in full, by its id or its name. Use myiq_list_cells first to find one. Sample data.",
    inputSchema: {
      type: "object",
      properties: {
        cell: { type: "string", description: "The IQ Cell's id, or its exact name." },
      },
      required: ["cell"],
      additionalProperties: false,
    },
  },
  {
    name: "myiq_search_knowledge",
    description:
      "Search the titles and paths of the notes in the published knowledge vault. Returns where a note is, not what it says. Sample data.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to match against note titles and paths." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "myiq_list_memories",
    description:
      "List the published memories — durable facts and conventions the assistant has been told to remember, each with its review status. Sample data.",
    inputSchema: NO_ARGS,
  },
  {
    name: "myiq_connectome_summary",
    description:
      "The My IQ analysis: how many cells and couplings were drawn, what the analysis found, and — always alongside — what it could not see. Sample data.",
    inputSchema: NO_ARGS,
  },
];

/**
 * The published snapshot, or a reason there is none.
 *
 * Read on every call rather than cached at startup, so a client left connected
 * across a re-publish sees the new material without being restarted.
 */
async function loadSnapshot(): Promise<
  { ok: true; snapshot: MyIqSnapshot } | { ok: false; reason: string }
> {
  const raw = await readFile(snapshotPath(), "utf8").catch(() => null);
  if (raw === null) {
    return {
      ok: false,
      reason:
        "Nothing has been published from My IQ yet. In IQ Compiler, open My IQ, run the analysis and press Publish.",
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: "The published snapshot could not be read as JSON." };
  }

  const parsed = MyIqSnapshot.safeParse(json);
  if (!parsed.success) {
    // The commonest way to land here is the sampleDataOnly literal failing,
    // which is the check doing its job, so it is named first.
    return {
      ok: false,
      reason:
        "The published snapshot is not a valid sample-data snapshot, so it will not be served. Re-publish from My IQ.",
    };
  }
  return { ok: true, snapshot: parsed.data };
}

/** Every tool answers with text; a client renders it, and nothing here is binary. */
const text = (body: string): Record<string, unknown> => ({
  content: [{ type: "text", text: body }],
});

const SAMPLE_NOTE =
  "\n\n(Sample data, published from IQ Compiler for demonstration. It describes no real person, system or workload.)";

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const loaded = await loadSnapshot();
  if (!loaded.ok) return { ...text(loaded.reason), isError: true };
  const snapshot = loaded.snapshot;

  switch (name) {
    case "myiq_list_cells": {
      // The name is on every listing because a client may be connected to more
      // than one of these at once, and "my-iq" is what all of them are called.
      const owner = snapshot.name === "" ? "My IQ" : snapshot.name;
      if (snapshot.cells.length === 0)
        return text(`${owner} published no IQ Cells.` + SAMPLE_NOTE);
      const lines = snapshot.cells.map(
        (cell) =>
          `- ${cell.name} (v${cell.version}, id ${cell.id}) — compiled in ${cell.origin}; ` +
          `${cell.runs} runs at ${Math.round(cell.completionRate * 100)}% completion; ` +
          `reaches ${cell.reach.length > 0 ? cell.reach.join(", ") : "nothing declared"}`,
      );
      return text(`${owner} — ${snapshot.cells.length} IQ Cells:\n${lines.join("\n")}${SAMPLE_NOTE}`);
    }

    case "myiq_get_cell": {
      const wanted = String(args["cell"] ?? "").trim();
      if (wanted === "") return { ...text("Name an IQ Cell by id or name."), isError: true };
      const found = snapshot.cells.find(
        (cell) => cell.id === wanted || cell.name.toLowerCase() === wanted.toLowerCase(),
      );
      if (!found) {
        return {
          ...text(`No published IQ Cell matches "${wanted}". Use myiq_list_cells to see them.`),
          isError: true,
        };
      }
      const body = [
        `${found.name} (version ${found.version})`,
        `Id: ${found.id}`,
        `Compiled in: ${found.origin}`,
        `What it does: ${found.faces.length > 0 ? found.faces.join("; ") : "not stated"}`,
        `Declared reach: ${found.reach.length > 0 ? found.reach.join(", ") : "nothing declared"}`,
        `Runs: ${found.runs} at ${Math.round(found.completionRate * 100)}% completion`,
        `Approver: ${found.approver || "not recorded"}`,
      ].join("\n");
      return text(body + SAMPLE_NOTE);
    }

    case "myiq_search_knowledge": {
      const query = String(args["query"] ?? "")
        .trim()
        .toLowerCase();
      if (query === "") return { ...text("Give a query to search for."), isError: true };
      if (snapshot.notes.length === 0) {
        return text(
          "No knowledge notes were published. The vault is only included when it holds the sample set." +
            SAMPLE_NOTE,
        );
      }
      const words = query.split(/\s+/).filter((word) => word.length > 0);
      const hits = snapshot.notes
        .filter((note) => {
          const haystack = `${note.title} ${note.path}`.toLowerCase();
          return words.every((word) => haystack.includes(word));
        })
        .slice(0, 25);
      if (hits.length === 0) return text(`Nothing matches "${query}".` + SAMPLE_NOTE);
      const lines = hits.map((note) => `- ${note.title} — ${note.path}`);
      return text(`${hits.length} of ${snapshot.notes.length} notes match:\n${lines.join("\n")}${SAMPLE_NOTE}`);
    }

    case "myiq_list_memories": {
      if (snapshot.memories.length === 0) return text("No memories were published." + SAMPLE_NOTE);
      const lines = snapshot.memories.map(
        (memory) => `- [${memory.status}, ${memory.memoryType}] ${memory.subject}: ${memory.fact}`,
      );
      return text(`${snapshot.memories.length} memories:\n${lines.join("\n")}${SAMPLE_NOTE}`);
    }

    case "myiq_connectome_summary": {
      const analysis = snapshot.connectome;
      if (analysis === null) {
        return text(
          "No My IQ analysis was published. Run the My IQ analysis before publishing to include one." +
            SAMPLE_NOTE,
        );
      }
      const findings =
        analysis.findings.length > 0
          ? analysis.findings
              .map((finding) => `- ${finding.title} (${finding.kind}): ${finding.detail}\n  Next: ${finding.action}`)
              .join("\n")
          : "- none";
      // The limits are not optional and are not a footnote. Every finding is a
      // claim about how someone's work hangs together; the limits are what the
      // analysis could not see, and separating them would strip the
      // qualification the report exists to carry.
      const limits =
        analysis.limits.length > 0 ? analysis.limits.map((limit) => `- ${limit}`).join("\n") : "- none stated";
      const body = [
        `${analysis.nodeCount} IQ Cells, ${analysis.edgeCount} couplings, over ${analysis.windowDays} days.`,
        `Analysis ${analysis.hash}, generated ${analysis.generatedAt}.`,
        "",
        "Findings:",
        findings,
        "",
        "What this analysis could not see:",
        limits,
      ].join("\n");
      return text(body + SAMPLE_NOTE);
    }

    default:
      return { ...text(`Unknown tool "${name}".`), isError: true };
  }
}

interface Request {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

async function handle(request: Request): Promise<Record<string, unknown> | null> {
  const { id, method } = request;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      };

    // Notifications carry no id and must not be answered.
    case "notifications/initialized":
      return null;

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    case "tools/call": {
      const params = request.params ?? {};
      const name = String(params["name"] ?? "");
      const args = (params["arguments"] as Record<string, unknown> | undefined) ?? {};
      // A tool that fails answers with `isError`, not a JSON-RPC error: the
      // distinction is "the model asked for something that did not work" versus
      // "the protocol broke", and clients treat them very differently.
      return { jsonrpc: "2.0", id, result: await callTool(name, args) };
    }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    default:
      if (id === undefined) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${String(method)}` },
      };
  }
}

function main(): void {
  const lines = createInterface({ input: process.stdin });
  // Requests are answered in arrival order. The work is a small file read, so
  // there is nothing to gain from overlapping them and a serial queue keeps the
  // output stream unambiguous.
  let queue: Promise<void> = Promise.resolve();

  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    queue = queue.then(async () => {
      let request: Request;
      try {
        request = JSON.parse(trimmed) as Request;
      } catch {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
        );
        return;
      }
      try {
        const response = await handle(request);
        if (response !== null) process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch (problem) {
        const message = problem instanceof Error ? problem.message : String(problem);
        if (request.id !== undefined) {
          process.stdout.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message } })}\n`,
          );
        }
      }
    });
  });

  lines.on("close", () => {
    void queue.then(() => process.exit(0));
  });
}

main();
