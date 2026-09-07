import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuditLog,
  MyIqPublisher,
  createLogger,
  ensureAppPaths,
  probeMcpServer,
  resolveAppPaths,
  type AppPaths,
} from "@iq/core";
import { MYIQ_SNAPSHOT_FILE, MyIqSnapshot } from "@iq/shared";

/**
 * Publishing My IQ is the only outward-facing surface in the product: another
 * app spawns the server and reads through it. So these tests are about the
 * promise attached to that, not about the plumbing — the data is sample data,
 * it is read-only, and the guarantee survives a snapshot that claims otherwise.
 */

const ENTRY = resolve(__dirname, "..", "packages", "myiq-mcp", "dist", "index.js");

let root: string;
let paths: AppPaths;

const actor = { oid: "oid-1", tenantId: "tid-1" };

const cell = {
  id: "iqcell_01",
  name: "Release evidence pack",
  version: 3,
  origin: "editor",
  faces: ["Assemble the evidence pack"],
  reach: ["SharePoint"],
  runs: 42,
  completionRate: 0.93,
  approver: "ada@example.com",
};

/** Two sample memories and one real one, to prove the filter. */
const MEMORIES = [
  {
    id: "mem_sample_01",
    subject: "reporting",
    fact: "Quarterly decks open with the reliability metric.",
    memoryType: "procedural",
    status: "approved",
  },
  {
    id: "mem_sample_02",
    subject: "dependencies",
    fact: "Major-version upgrades need a security review.",
    memoryType: "factual",
    status: "approved",
  },
  {
    id: "mem_a1b2c3",
    subject: "payroll",
    fact: "Something a real person actually told the assistant.",
    memoryType: "factual",
    status: "approved",
  },
];

function publisher(over: { sampleData?: boolean; isSamples?: boolean } = {}): MyIqPublisher {
  return new MyIqPublisher({
    paths,
    audit: new AuditLog(paths),
    logger: createLogger("error"),
    sampleDataEnabled: () => over.sampleData ?? true,
    listMemories: async () => MEMORIES,
    vaultState: async () => ({ isSamples: over.isSamples ?? true }),
    listNotes: async () => [{ path: "programs/launch.md", title: "Launch" }],
    serverEntry: () => ENTRY,
  });
}

const snapshotOnDisk = (): MyIqSnapshot =>
  JSON.parse(readFileSync(join(paths.myiq, MYIQ_SNAPSHOT_FILE), "utf8")) as MyIqSnapshot;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "iq-myiq-"));
  paths = resolveAppPaths(root);
  await ensureAppPaths(paths);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("MyIqPublisher", () => {
  it("refuses to publish while sample data is off", async () => {
    await expect(
      publisher({ sampleData: false }).publish({ cells: [cell], connectome: null }, actor, "corr-1"),
    ).rejects.toThrow(/sample data/i);
  });

  /**
   * Declining is not the same as publishing nothing: only the first can tell
   * someone what to do about it, and only the first leaves no file behind for
   * a client to read.
   */
  it("writes nothing at all when it refuses", async () => {
    await publisher({ sampleData: false })
      .publish({ cells: [cell], connectome: null }, actor, "corr-1")
      .catch(() => undefined);

    const status = await publisher({ sampleData: false }).status();
    expect(status.published).toBe(false);
  });

  it("publishes only memories it can prove are samples", async () => {
    const result = await publisher().publish({ cells: [cell], connectome: null }, actor, "corr-1");

    expect(result.droppedMemories).toBe(1);
    expect(snapshotOnDisk().memories.map((memory) => memory.id)).toEqual([
      "mem_sample_01",
      "mem_sample_02",
    ]);
  });

  it("skips the knowledge vault when it is not the sample one", async () => {
    const result = await publisher({ isSamples: false }).publish(
      { cells: [cell], connectome: null },
      actor,
      "corr-1",
    );

    expect(result.skippedVault).toBe(true);
    expect(snapshotOnDisk().notes).toEqual([]);
  });

  it("stamps every snapshot as sample-data-only", async () => {
    await publisher().publish({ cells: [cell], connectome: null }, actor, "corr-1");

    expect(snapshotOnDisk().sampleDataOnly).toBe(true);
  });

  /**
   * The name and the sharing decision are the publisher's answer to "whose IQ
   * is this, and who is it for". A reader on the other side of MCP sees a
   * directory, and "My IQ" for every entry is a directory with no information
   * in it — so both travel with the snapshot and both come back on `status()`.
   */
  it("keeps the name and the sharing decision the publisher gave", async () => {
    await publisher().publish(
      { name: "  Delivery IQ  ", shared: true, cells: [cell], connectome: null },
      actor,
      "corr-1",
    );

    expect(snapshotOnDisk().name).toBe("Delivery IQ");
    expect(snapshotOnDisk().shared).toBe(true);

    const status = await publisher().status();
    expect(status.name).toBe("Delivery IQ");
    expect(status.shared).toBe(true);
  });

  it("falls back to a name rather than publishing an unnamed IQ", async () => {
    await publisher().publish({ name: "   ", cells: [cell], connectome: null }, actor, "corr-1");

    expect(snapshotOnDisk().name).toBe("My IQ");
    // Not shared unless somebody said so. Sharing is a decision, and a default
    // that shares is a decision made on the publisher's behalf.
    expect(snapshotOnDisk().shared).toBe(false);
  });

  it("reports no name at all before anything is published", async () => {
    const status = await publisher().status();

    expect(status.published).toBe(false);
    expect(status.name).toBe("");
    expect(status.shared).toBe(false);
  });

  it("reports how another app should spawn the server", async () => {
    const status = await publisher().status();

    // Never process.execPath: in a packaged build that is Electron, and handing
    // a client an Electron binary to run as a stdio server fails in a way that
    // reads as our defect.
    expect(status.endpoint.command).toBe("node");
    expect(status.endpoint.args).toEqual([ENTRY]);
    expect(JSON.parse(status.endpoint.clientConfig)).toMatchObject({
      servers: { "my-iq": { type: "stdio", command: "node" } },
    });
  });
});

describe("the my iq mcp server, against the real binary", () => {
  const probe = (home: string) =>
    probeMcpServer({
      id: "my-iq",
      transport: "stdio",
      command: "node",
      args: [ENTRY],
      env: { IQ_HOME: home },
      url: "",
      headers: {},
    });

  it("advertises its five read-only tools before anything is published", async () => {
    const result = await probe(root);

    expect(result.error).toBe("");
    expect(result.ok).toBe(true);
    expect(result.serverName).toBe("my-iq");
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "myiq_connectome_summary",
      "myiq_get_cell",
      "myiq_list_cells",
      "myiq_list_memories",
      "myiq_search_knowledge",
    ]);
  }, 60_000);

  /**
   * The second lock. The app only ever writes `sampleDataOnly: true`, so this
   * is what a change on the writing side would have to get past — a snapshot
   * holding real records is refused by the reader rather than served.
   */
  it("refuses a snapshot that is not marked sample-data-only", async () => {
    const home = mkdtempSync(join(tmpdir(), "iq-myiq-unmarked-"));
    try {
      mkdirSync(join(home, "myiq"), { recursive: true });
      writeFileSync(
        join(home, "myiq", MYIQ_SNAPSHOT_FILE),
        JSON.stringify({
          schemaVersion: 1,
          publishedAt: new Date().toISOString(),
          sampleDataOnly: false,
          cells: [cell],
          connectome: null,
          memories: [],
          notes: [],
        }),
        "utf8",
      );

      const answer = await callTool(home, "myiq_list_cells", {});

      expect(answer.isError).toBe(true);
      expect(text(answer)).toMatch(/not a valid sample-data snapshot/i);
      expect(text(answer)).not.toContain(cell.name);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  it("says what to do when nothing has been published", async () => {
    const answer = await callTool(root, "myiq_list_cells", {});

    expect(answer.isError).toBe(true);
    expect(text(answer)).toMatch(/press Publish/i);
  }, 60_000);

  it("serves the published cells, and marks them as sample data", async () => {
    await publisher().publish({ cells: [cell], connectome: null }, actor, "corr-1");

    const answer = await callTool(root, "myiq_list_cells", {});

    expect(answer.isError).toBeUndefined();
    expect(text(answer)).toContain(cell.name);
    expect(text(answer)).toMatch(/sample data/i);
  }, 60_000);

  it("carries the analysis limits alongside its findings", async () => {
    await publisher().publish(
      {
        cells: [cell],
        connectome: {
          hash: "c0ffee",
          nodeCount: 12,
          edgeCount: 30,
          windowDays: 30,
          findings: [
            { kind: "fragility", title: "One approver", detail: "d", action: "Name a second." },
          ],
          limits: ["Run history is generated, not observed."],
          generatedAt: new Date().toISOString(),
        },
      },
      actor,
      "corr-1",
    );

    const answer = await callTool(root, "myiq_connectome_summary", {});

    // A finding is a claim about how someone's work hangs together; the limits
    // are what the analysis could not see. Serving one without the other would
    // strip exactly the qualification the report exists to carry.
    expect(text(answer)).toContain("One approver");
    expect(text(answer)).toContain("Run history is generated, not observed.");
  }, 60_000);
});

/** Read the text out of an MCP tool result. */
function text(result: Record<string, unknown>): string {
  const content = (result["content"] ?? []) as Array<{ text?: string }>;
  return content.map((part) => part.text ?? "").join("\n");
}

/**
 * Drive one `tools/call` against the real server.
 *
 * Hand-rolled rather than reusing `probeMcpServer`, which deliberately never
 * invokes anything — inspection proves reachability and must not be able to
 * cause a side effect, so it cannot be the thing that tests a call.
 */
async function callTool(
  home: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { spawn } = await import("node:child_process");
  return await new Promise((settle, fail) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: { ...process.env, IQ_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", fail);
    child.on("close", () => {
      const lines = out.split("\n").filter((line) => line.trim() !== "");
      for (const line of lines) {
        const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
        if (message.id === 2 && message.result) {
          settle(message.result);
          return;
        }
      }
      fail(new Error(`no tools/call response in: ${out}`));
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: args },
      })}\n`,
    );
    child.stdin.end();
  });
}
