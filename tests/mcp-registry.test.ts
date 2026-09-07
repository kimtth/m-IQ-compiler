import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuditLog,
  DEFAULT_TENANT_POLICY,
  McpRegistry,
  createLogger,
  ensureAppPaths,
  resolveAppPaths,
  type AppPaths,
} from "@iq/core";
import { MCP_CATALOG, MCP_SEEDED_SERVER_IDS, McpServerInput, catalogEntryToInput } from "@iq/shared";

/**
 * An MCP server is a third party supplying tools the agent may call, so the
 * registry is a consent record rather than a connection pool. These tests pin
 * the consent properties, not the plumbing: nothing is live until someone
 * enables it, a grant is per tool rather than per server, a grant cannot be
 * given for something nobody has read a description of, and repointing a server
 * does not carry consent across to a different party.
 */

let root: string;
let paths: AppPaths;
let registry: McpRegistry;

const actor = { oid: "oid-1", tenantId: "tid-1" };

const input = (over: Partial<McpServerInput> = {}): McpServerInput => ({
  id: "docs",
  label: "Docs server",
  transport: "stdio",
  command: "node",
  args: ["server.js"],
  env: {},
  url: "",
  headers: {},
  ...over,
});

/** Pretend the server was inspected, so approval tests can run without one. */
async function pretendDiscovered(id: string, tools: string[]): Promise<void> {
  const file = join(paths.config, "mcp-servers.json");
  const { readFile, writeFile } = await import("node:fs/promises");
  const state = JSON.parse(await readFile(file, "utf8")) as {
    servers: Array<{ id: string; discoveredTools: unknown[]; state: string }>;
  };
  const server = state.servers.find((entry) => entry.id === id);
  if (!server) throw new Error("no such server");
  server.discoveredTools = tools.map((name) => ({ name, description: "" }));
  server.state = "ok";
  await writeFile(file, JSON.stringify(state), "utf8");
}

/** Force a reload so the fixture above is observed. */
function reopen(): McpRegistry {
  return new McpRegistry({
    paths,
    audit: new AuditLog(paths),
    policy: DEFAULT_TENANT_POLICY,
    logger: createLogger("error"),
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "iq-mcp-"));
  paths = resolveAppPaths(root);
  await ensureAppPaths(paths);
  registry = reopen();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("McpRegistry", () => {
  it("adds a server inert: not enabled, nothing approved, never inspected", async () => {
    const record = await registry.upsert(input(), actor, "corr-1");

    expect(record.enabled).toBe(false);
    expect(record.approvedTools).toEqual([]);
    expect(record.state).toBe("never_inspected");
  });

  it("never returns secret values, only the keys that are set", async () => {
    const record = await registry.upsert(
      input({ env: { API_TOKEN: "s3cret" } }),
      actor,
      "corr-1",
    );

    expect(record.envKeys).toEqual(["API_TOKEN"]);
    expect(JSON.stringify(record)).not.toContain("s3cret");
  });

  it("keeps existing secrets when an edit sends none", async () => {
    await registry.upsert(input({ env: { API_TOKEN: "s3cret" } }), actor, "corr-1");
    const edited = await registry.upsert(input({ label: "Renamed" }), actor, "corr-2");

    expect(edited.envKeys).toEqual(["API_TOKEN"]);
  });

  it("refuses to approve a tool the server has not advertised", async () => {
    await registry.upsert(input(), actor, "corr-1");

    await expect(registry.setApprovedTools("docs", ["search"], actor, "corr-2")).rejects.toThrow(
      /inspect the server first/i,
    );
  });

  /**
   * The regression behind "I cannot tick anything after inspecting".
   *
   * `inspect` deliberately keeps an approval for a tool that stops being
  * advertised, so the caller's current set legitimately contains a name that
  * is no longer discovered. The guard must not reject the whole update when
  * the UI resends that current set.
   */
  it("carries an approval for a tool that is no longer advertised", async () => {
    await registry.upsert(input(), actor, "corr-1");
    await pretendDiscovered("docs", ["search", "get_debug_link"]);

    const live = reopen();
    await live.setApprovedTools("docs", ["search", "get_debug_link"], actor, "corr-2");

    // The server stops offering it, the way a proxy does when what it proxies
    // changes underneath.
    await pretendDiscovered("docs", ["search", "fetch"]);
    const after = reopen();

    const record = await after.setApprovedTools(
      "docs",
      ["search", "get_debug_link", "fetch"],
      actor,
      "corr-3",
    );

    expect(record.approvedTools).toEqual(["fetch", "get_debug_link", "search"]);
  });

  it("still refuses a name that was never advertised and never approved", async () => {
    await registry.upsert(input(), actor, "corr-1");
    await pretendDiscovered("docs", ["search"]);

    const live = reopen();
    await live.setApprovedTools("docs", ["search"], actor, "corr-2");

    await expect(
      live.setApprovedTools("docs", ["search", "delete_everything"], actor, "corr-3"),
    ).rejects.toThrow(/unknown tools delete_everything/i);
  });

  it("lets a stale approval be dropped", async () => {
    await registry.upsert(input(), actor, "corr-1");
    await pretendDiscovered("docs", ["search", "get_debug_link"]);

    const live = reopen();
    await live.setApprovedTools("docs", ["search", "get_debug_link"], actor, "corr-2");
    await pretendDiscovered("docs", ["search"]);

    const after = reopen();
    const record = await after.setApprovedTools("docs", ["search"], actor, "corr-3");

    expect(record.approvedTools).toEqual(["search"]);
  });

  it("refuses to enable a server with nothing approved", async () => {
    await registry.upsert(input(), actor, "corr-1");

    await expect(registry.setEnabled("docs", true, actor, "corr-2")).rejects.toThrow(
      /approve at least one tool/i,
    );
  });

  it("gates by individual tool, not by server", async () => {
    await registry.upsert(input(), actor, "corr-1");
    await pretendDiscovered("docs", ["search", "delete_everything"]);

    const live = reopen();
    await live.setApprovedTools("docs", ["search"], actor, "corr-2");
    await live.setEnabled("docs", true, actor, "corr-3");

    expect((await live.gate("search")).allowed).toBe(true);
    expect((await live.gate("delete_everything")).allowed).toBe(false);
  });

  it("recognises a qualified tool name from the runtime", async () => {
    await registry.upsert(input(), actor, "corr-1");
    await pretendDiscovered("docs", ["search"]);

    const live = reopen();
    await live.setApprovedTools("docs", ["search"], actor, "corr-2");
    await live.setEnabled("docs", true, actor, "corr-3");

    expect((await live.gate("docs/search")).allowed).toBe(true);
    // The joiner the Copilot SDK uses. Denying this shape denied every real
    // call: the tool was approved, the server was on, and the runtime asked by
    // the only name it has.
    expect((await live.gate("docs-search")).allowed).toBe(true);
    expect((await live.gate("docs.search")).allowed).toBe(true);
    // The prefix is the server id, not a wildcard.
    expect((await live.gate("other-search")).allowed).toBe(false);
    expect((await live.gate("docs-delete_everything")).allowed).toBe(false);
  });

  it("stops gating as soon as the server is disabled", async () => {
    await registry.upsert(input(), actor, "corr-1");
    await pretendDiscovered("docs", ["search"]);

    const live = reopen();
    await live.setApprovedTools("docs", ["search"], actor, "corr-2");
    await live.setEnabled("docs", true, actor, "corr-3");
    await live.setEnabled("docs", false, actor, "corr-4");

    expect((await live.gate("search")).allowed).toBe(false);
  });

  it("clears approvals when the server is pointed somewhere else", async () => {
    await registry.upsert(input(), actor, "corr-1");
    await pretendDiscovered("docs", ["search"]);

    const live = reopen();
    await live.setApprovedTools("docs", ["search"], actor, "corr-2");
    await live.setEnabled("docs", true, actor, "corr-3");

    const moved = await live.upsert(input({ command: "python" }), actor, "corr-4");
    expect(moved.approvedTools).toEqual([]);
    expect(moved.enabled).toBe(false);
    expect((await live.gate("search")).allowed).toBe(false);
  });

  it("offers only enabled servers with approved tools to a session", async () => {
    await registry.upsert(input(), actor, "corr-1");
    await registry.upsert(input({ id: "other", label: "Other" }), actor, "corr-2");
    await pretendDiscovered("docs", ["search"]);

    const live = reopen();
    await live.setApprovedTools("docs", ["search"], actor, "corr-3");
    await live.setEnabled("docs", true, actor, "corr-4");

    const servers = await live.resolveSessionServers();
    expect(Object.keys(servers)).toEqual(["docs"]);
    expect(servers["docs"]).toMatchObject({ tools: ["search"] });
  });

  /**
   * The regression behind "the Work IQ connection is unstable".
   *
   * The runtime starts every enabled server when it builds a session and
   * carries on without the ones that miss its handshake budget. Work IQ needs
   * 26 to 30 seconds of a 60 second budget it shares with every other server
   * starting at the same moment, so it is dropped some of the time — and the
   * record went on saying `ok` from the last manual Inspect, which is why it
   * looked random rather than slow.
   */
  it("records a server that failed to start for a session", async () => {
    await registry.upsert(input(), actor, "corr-1");
    await pretendDiscovered("docs", ["search"]);

    const live = reopen();
    await live.setApprovedTools("docs", ["search"], actor, "corr-2");
    await live.setEnabled("docs", true, actor, "corr-3");

    expect(await live.recordRuntimeStatus("docs", false, "handshake did not complete")).toBe(true);

    const [record] = await live.list();
    expect(record?.state).toBe("failed");
    expect(record?.lastError).toBe("handshake did not complete");
    // A server that did not start has not been un-approved and has not been
    // switched off. Next session it gets another go.
    expect(record?.enabled).toBe(true);
    expect(record?.approvedTools).toEqual(["search"]);
    expect(Object.keys(await live.resolveSessionServers())).toEqual(["docs"]);
  });

  it("ignores a runtime status for a server it does not own, and repeats", async () => {
    await registry.upsert(input(), actor, "corr-1");

    expect(await registry.recordRuntimeStatus("someone-elses", false, "boom")).toBe(false);
    expect(await registry.recordRuntimeStatus("docs", false, "boom")).toBe(true);
    // Unchanged status must not rewrite the file on every turn.
    expect(await registry.recordRuntimeStatus("docs", false, "boom")).toBe(false);
    expect(await registry.recordRuntimeStatus("docs", true, "")).toBe(true);

    const [record] = await registry.list();
    expect(record?.state).toBe("ok");
    expect(record?.lastError).toBe("");
  });

  it("makes every configured server inert when tenant policy forbids MCP", async () => {
    await registry.upsert(input(), actor, "corr-1");
    await pretendDiscovered("docs", ["search"]);

    const restricted = new McpRegistry({
      paths,
      audit: new AuditLog(paths),
      policy: { ...DEFAULT_TENANT_POLICY, allowUserMcpServers: false },
      logger: createLogger("error"),
    });

    expect(await restricted.resolveSessionServers()).toEqual({});
    expect((await restricted.gate("search")).allowed).toBe(false);
    await expect(restricted.upsert(input(), actor, "corr-2")).rejects.toThrow(/tenant policy/i);
  });
});

/**
 * The catalog is a shortcut through the typing, not through the consent. These
 * tests pin that: an entry is a valid server definition, it lands as inert as
 * anything typed by hand, and the tools it *claims* it will advertise grant
 * nothing until the server has actually been inspected.
 */
describe("MCP catalog", () => {
  it("every entry is a valid server definition", () => {
    expect(MCP_CATALOG.length).toBeGreaterThan(0);
    for (const entry of MCP_CATALOG) {
      const parsed = McpServerInput.parse(catalogEntryToInput(entry));
      expect(parsed.id).toBe(entry.id);
      expect(entry.transport === "stdio" ? parsed.command : parsed.url).not.toBe("");
      // A suggestion the user cannot judge is worse than no suggestion.
      expect(entry.summary).not.toBe("");
      expect(entry.docsUrl).toMatch(/^https:\/\//);
    }
    expect(MCP_CATALOG.map((entry) => entry.id)).toContain("markitdown");
  });

  it("ships MarkItDown as an installed executable with its reach stated up front", () => {
    const entry = MCP_CATALOG.find((candidate) => candidate.id === "markitdown");
    expect(entry).toBeDefined();
    expect(entry?.vendor).toBe("Microsoft");
    expect(entry?.transport).toBe("stdio");
    // Not `uvx markitdown-mcp`: that builds the environment on first use and
    // loses the runtime's 60 second handshake budget doing it, every session.
    expect(`${entry?.command} ${entry?.args.join(" ")}`.trim()).toBe("markitdown-mcp");
    expect(entry?.prerequisite).toContain("uv tool install markitdown-mcp");
    expect(entry?.expectedTools.map((tool) => tool.name)).toEqual(["convert_to_markdown"]);
    // It reads file: URIs, which the project tree does not bound.
    expect(entry?.caution).toMatch(/file:/);
    expect(entry?.prerequisite).not.toBe("");
  });

  it("adding a catalog entry grants nothing", async () => {
    const entry = MCP_CATALOG.find((candidate) => candidate.id === "markitdown")!;
    const record = await registry.upsert(catalogEntryToInput(entry), actor, "corr-1");

    expect(record).toMatchObject({ enabled: false, approvedTools: [], state: "never_inspected" });
    // The claimed tool is not a discovered tool, so it cannot be approved yet…
    await expect(
      registry.setApprovedTools("markitdown", ["convert_to_markdown"], actor, "corr-2"),
    ).rejects.toThrow(/inspect the server first/i);
    // …and it is not callable in the meantime.
    expect((await registry.gate("convert_to_markdown")).allowed).toBe(false);
    expect(await registry.resolveSessionServers()).toEqual({});
  });
});

/**
 * Seeding puts a server in the list on first run. The tests below exist to pin
 * the two things that make that acceptable: it grants nothing, and it happens
 * once — a seeded server that reappeared after being removed would make the
 * remove button a lie.
 */
describe("seeded MCP servers", () => {
  it("registers the seeded ids on first load, inert", async () => {
    const servers = await registry.list();

    expect(servers.map((server) => server.id)).toEqual([...MCP_SEEDED_SERVER_IDS]);
    for (const server of servers) {
      expect(server).toMatchObject({
        enabled: false,
        approvedTools: [],
        discoveredTools: [],
        state: "never_inspected",
      });
    }
    // Nothing seeded is reachable by a session, and nothing it may advertise
    // later is callable.
    expect(await registry.resolveSessionServers()).toEqual({});
  });

  it("seeds Power BI modeling from the catalog definition", async () => {
    const seeded = (await registry.list()).find((server) => server.id === "powerbi-modeling");
    const entry = MCP_CATALOG.find((candidate) => candidate.id === "powerbi-modeling");

    expect(entry).toBeDefined();
    expect(seeded).toBeDefined();
    expect(seeded?.transport).toBe("stdio");
    // `--start` is load-bearing, not decoration: without it the package prints
    // a banner and calls Console.ReadKey(), which throws the moment stdin is a
    // pipe — so the server dies before answering. Pinned because dropping the
    // argument leaves a seeded row that can never work.
    expect(`${seeded?.command} ${seeded?.args.join(" ")}`).toBe(
      "npx -y @microsoft/powerbi-modeling-mcp --start",
    );
    expect(seeded?.label).toContain(entry?.label);
  });

  it("seeds Work IQ from the catalog definition, as the local CLI", async () => {
    const seeded = (await registry.list()).find((server) => server.id === "workiq");
    const entry = MCP_CATALOG.find((candidate) => candidate.id === "workiq");

    expect(entry).toBeDefined();
    expect(seeded).toBeDefined();
    // The catalog contract uses the local stdio CLI and passes it no token.
    expect(seeded?.transport).toBe("stdio");
    expect(`${seeded?.command} ${seeded?.args.join(" ")}`).toBe("npx -y @microsoft/workiq mcp");
    expect(seeded?.url).toBe("");
    // Listing it is not granting it.
    expect(seeded?.enabled).toBe(false);
    expect(seeded?.approvedTools).toEqual([]);
  });

  it("does not bring a removed server back on the next launch", async () => {
    for (const id of MCP_SEEDED_SERVER_IDS) await registry.remove(id, actor, "corr-1");
    expect(await registry.list()).toEqual([]);

    expect(await reopen().list()).toEqual([]);
  });

  /*
   * Seeding once and a catalog that can be corrected are in conflict, and the
   * conflict is not hypothetical: Work IQ was seeded pointing at Microsoft's
   * hosted endpoint, that endpoint turned out to answer 401 to this app no
   * matter what anyone consents to, and the catalog moved to the local CLI.
   * Every profile already seeded kept the broken row, because `seeded` said
   * the question had been answered.
   */
  describe("a seeded server whose catalog definition has since changed", () => {
    // The file is written lazily, by the first read that seeds it.
    beforeEach(async () => {
      await registry.list();
    });

    /** Put the profile back the way the old catalog left it. */
    const asStaleHttp = async (over: Record<string, unknown> = {}): Promise<void> => {
      const file = join(paths.config, "mcp-servers.json");
      const { readFile, writeFile } = await import("node:fs/promises");
      const state = JSON.parse(await readFile(file, "utf8")) as {
        servers: Array<Record<string, unknown>>;
      };
      const server = state.servers.find((entry) => entry["id"] === "workiq");
      if (!server) throw new Error("workiq was not seeded");
      Object.assign(server, {
        transport: "http",
        command: "",
        args: [],
        url: "https://legacy-mcp.example.com/api",
        headers: { Authorization: "Bearer stale" },
        discoveredTools: [{ name: "ask", description: "" }],
        state: "failed",
        lastError: "server answered 401",
        ...over,
      });
      await writeFile(file, JSON.stringify(state), "utf8");
    };

    it("is repointed at the catalog on the next launch", async () => {
      await asStaleHttp();

      const repaired = (await reopen().list()).find((server) => server.id === "workiq");

      expect(repaired?.transport).toBe("stdio");
      expect(`${repaired?.command} ${repaired?.args.join(" ")}`).toBe(
        "npx -y @microsoft/workiq mcp",
      );
      expect(repaired?.url).toBe("");
      // What the old target reported was about the old target.
      expect(repaired?.state).toBe("never_inspected");
      expect(repaired?.discoveredTools).toEqual([]);
      expect(repaired?.lastError).toBe("");
      // A credential for an endpoint we no longer call is kept for no reason.
      expect(repaired?.headerKeys).toEqual([]);
    });

    it("is left alone once a tool has been approved", async () => {
      // An approval names a specific third party reached a specific way, so
      // repointing one that carries approvals would carry that consent across
      // to a different party. The stale row survives instead, and the user is
      // the one who decides.
      await asStaleHttp({ approvedTools: ["ask"] });

      const kept = (await reopen().list()).find((server) => server.id === "workiq");

      expect(kept?.transport).toBe("http");
      expect(kept?.url).toBe("https://legacy-mcp.example.com/api");
      expect(kept?.approvedTools).toEqual(["ask"]);
    });

    it("is left alone while it is switched on", async () => {
      await asStaleHttp({ enabled: true });

      const kept = (await reopen().list()).find((server) => server.id === "workiq");

      expect(kept?.transport).toBe("http");
      expect(kept?.enabled).toBe(true);
    });

    it("does not rewrite the file when nothing has drifted", async () => {
      const file = join(paths.config, "mcp-servers.json");
      const { readFile } = await import("node:fs/promises");
      const before = await readFile(file, "utf8");

      await reopen().list();

      expect(await readFile(file, "utf8")).toBe(before);
    });
  });

  it("seeds nothing when tenant policy forbids user MCP servers", async () => {
    const restricted = new McpRegistry({
      paths,
      audit: new AuditLog(paths),
      policy: { ...DEFAULT_TENANT_POLICY, allowUserMcpServers: false },
      logger: createLogger("error"),
    });

    expect(await restricted.list()).toEqual([]);
  });
});
