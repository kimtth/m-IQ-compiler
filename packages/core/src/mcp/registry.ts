import { join } from "node:path";
import {
  MCP_CATALOG,
  MCP_SEEDED_SERVER_IDS,
  McpServerInput,
  type McpCatalogEntry,
  type McpInspectResult,
  type McpServerRecord,
  type McpToolDescriptor,
} from "@iq/shared";
import { readJson, writeJsonAtomic } from "../util/jsonl.js";
import { probeMcpServer } from "./probe.js";
import type { AppPaths } from "../config/paths.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { TenantPolicy } from "../policy/tenant-policy.js";
import type { Logger } from "../util/logger.js";

/**
 * On-demand MCP servers.
 *
 * An MCP server is a third party supplying tools the agent may call, so this
 * registry is a consent record rather than a connection pool. Three rules give
 * it its shape:
 *
 *  1. **Nothing connects automatically.** Adding a server stores configuration
 *     and nothing else. It is inert until someone enables it.
 *  2. **Inspect before granting.** A probe lists what the server advertises so
 *     the tools can be read before any of them is approved.
 *  3. **Approval is per tool, not per server.** A server that later advertises
 *     a new tool does not gain the right to call it; the allow-list is by name,
 *     so growth on the server's side is inert until a person approves it.
 *
 * Approved tools then run through the same permission policy and audit trail as
 * built-in ones — the SDK raises an `mcp` permission request per call, which is
 * routed through our broker, and `gate()` below is the deny floor underneath it.
 */

/** Stored shape. Unlike the record sent to the UI, this holds secret values. */
interface StoredServer {
  id: string;
  label: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  approvedTools: string[];
  discoveredTools: McpToolDescriptor[];
  state: "never_inspected" | "ok" | "failed";
  lastError: string;
  lastInspectedAt: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredState {
  servers: StoredServer[];
  /**
   * Catalog ids already offered to this install.
   *
   * Recorded separately from the servers themselves so that removing a seeded
   * server is a decision rather than a delay: without this, the next launch
   * would put it straight back and the remove button would appear broken.
   */
  seeded: string[];
}

/** Everything needed to run one approved stdio server, secrets included. */
export interface ConverterTarget {
  id: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

const EMPTY: StoredState = { servers: [], seeded: [] };

/**
 * Move a seeded server onto the catalog's current definition of it.
 *
 * **Only a server nobody has granted anything to.** An approval names a
 * specific third party reached a specific way, so repointing one that carries
 * approvals — or that is switched on — would silently carry that consent
 * across to a different party. That is the exact thing `upsert` refuses to do
 * when a user edits a server, and it is not made acceptable by the app being
 * the one doing the editing.
 *
 * Anything the old target reported goes with it: what it advertised, whether
 * it worked, and the environment and headers it was reached with. A bearer
 * token left behind for an endpoint we no longer call is a credential kept for
 * no reason, and a tool list from the old party would be a claim about the new
 * one.
 *
 * A user who deliberately edited a seeded server and then never enabled it
 * loses that edit. That is the accepted cost: the alternative is a row that
 * can never work again and offers no way to say so.
 */
function repointToCatalog(server: StoredServer, entry: McpCatalogEntry, now: string): boolean {
  if (server.enabled || server.approvedTools.length > 0) return false;

  const unchanged =
    server.transport === entry.transport &&
    server.command === entry.command &&
    server.url === entry.url &&
    server.args.length === entry.args.length &&
    server.args.every((arg, index) => arg === entry.args[index]);
  if (unchanged) return false;

  server.transport = entry.transport;
  server.command = entry.command;
  server.args = [...entry.args];
  server.url = entry.url;
  server.env = {};
  server.headers = {};
  server.discoveredTools = [];
  server.state = "never_inspected";
  server.lastError = "";
  server.lastInspectedAt = "";
  server.updatedAt = now;
  return true;
}

export interface McpRegistryDeps {
  paths: AppPaths;
  audit: AuditLog;
  policy: TenantPolicy;
  logger: Logger;
}

export class McpRegistry {
  private state: StoredState = EMPTY;
  private loaded = false;

  constructor(private readonly deps: McpRegistryDeps) {}

  private get file(): string {
    return join(this.deps.paths.config, "mcp-servers.json");
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const raw = await readJson<StoredState>(this.file, EMPTY);
    // Copied, not aliased: `readJson` hands back the fallback object itself
    // when the file is absent, so keeping its arrays would make every registry
    // in the process share one module-level list.
    this.state = {
      servers: Array.isArray(raw.servers) ? [...raw.servers] : [],
      seeded: Array.isArray(raw.seeded) ? [...raw.seeded] : [],
    };
    this.loaded = true;
    if (this.seedDefaults()) await this.persist();
  }

  /**
   * Register the seeded catalog entries, once each — and keep an untouched one
   * pointing at what the catalog now says.
   *
   * Deliberately not a grant: each one lands disabled, never inspected and
   * with an empty approval list, which is the same state the add form
   * produces. The only thing this saves anyone is finding the catalog.
   *
  * The repair exists because seeding-once and a catalog that can be corrected
  * are in conflict. Work IQ moved from an HTTP catalog entry to its supported
  * local CLI transport.
   * Without this, every profile that had already been seeded kept the broken
   * row for ever, because `seeded` said the question had been answered.
   *
   * Returns whether anything changed, so a launch with nothing to do does not
   * rewrite the file.
   */
  private seedDefaults(): boolean {
    // A tenant that has turned user-configured servers off should not find one
    // sitting in the list, however inert it is.
    if (!this.deps.policy.allowUserMcpServers) return false;

    const now = new Date().toISOString();
    let changed = false;

    for (const id of MCP_SEEDED_SERVER_IDS) {
      const known = this.state.seeded.includes(id);
      if (!known) {
        this.state.seeded.push(id);
        changed = true;
      }

      const entry = MCP_CATALOG.find((candidate) => candidate.id === id);
      if (entry === undefined) continue;

      const existing = this.state.servers.find((server) => server.id === id);
      if (existing !== undefined) {
        if (repointToCatalog(existing, entry, now)) {
          changed = true;
          this.deps.logger.info("seeded mcp server repointed to the catalog definition", {
            id,
            transport: entry.transport,
          });
        }
        continue;
      }

      // Absent and already recorded as seeded means someone removed it. That
      // is an answer, and it has to survive the next launch.
      if (known) continue;

      this.state.servers.push({
        id: entry.id,
        label: `${entry.label} (${entry.vendor})`,
        transport: entry.transport,
        command: entry.command,
        args: [...entry.args],
        env: {},
        url: entry.url,
        headers: {},
        enabled: false,
        approvedTools: [],
        discoveredTools: [],
        state: "never_inspected",
        lastError: "",
        lastInspectedAt: "",
        createdAt: now,
        updatedAt: now,
      });
      this.deps.logger.info("mcp server offered from the catalog", { id, enabled: false });
    }

    if (changed) {
      this.state.servers.sort((a, b) => a.id.localeCompare(b.id));
    }
    return changed;
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.file, this.state);
  }

  private find(id: string): StoredServer {
    const server = this.state.servers.find((entry) => entry.id === id);
    if (!server) throw new Error(`no MCP server named "${id}"`);
    return server;
  }

  async list(): Promise<McpServerRecord[]> {
    await this.ensureLoaded();
    return this.state.servers.map(redact);
  }

  /**
   * The one server allowed to convert a file to Markdown, or null.
   *
   * Returns the unredacted target, which `list()` deliberately does not: the
   * environment can hold a credential, and it stays inside core. Every
   * condition is checked here rather than at the call site, because "is this
   * approved" is the registry's question and answering it anywhere else is how
   * an approval model drifts into a suggestion.
   */
  async converterTarget(tool: string): Promise<ConverterTarget | null> {
    await this.ensureLoaded();
    const server = this.state.servers.find(
      (entry) => entry.enabled && entry.transport === "stdio" && entry.approvedTools.includes(tool),
    );
    if (!server || server.command.trim() === "") return null;
    return { id: server.id, command: server.command, args: server.args, env: server.env };
  }

  /**
   * Add or replace a server definition.
   *
   * Editing a server clears its approvals. The user approved a set of tools on
   * a particular endpoint or command; pointing the same id somewhere else and
   * keeping the grants would silently transfer consent to a different party.
   */
  async upsert(input: McpServerInput, actor: Actor, correlationId: string): Promise<McpServerRecord> {
    if (!this.deps.policy.allowUserMcpServers) {
      await this.deny(actor, "mcp.configure", input.id, correlationId, "tenant policy");
      throw new Error("connecting MCP servers is disabled by tenant policy");
    }

    const parsed = McpServerInput.parse(input);
    await this.ensureLoaded();

    const now = new Date().toISOString();
    const existing = this.state.servers.find((entry) => entry.id === parsed.id);
    const changedTarget =
      existing !== undefined &&
      (existing.transport !== parsed.transport ||
        existing.command !== parsed.command ||
        existing.url !== parsed.url ||
        existing.args.join("\u0000") !== parsed.args.join("\u0000"));

    const server: StoredServer = {
      ...parsed,
      // Absent secret maps mean "leave as they were": the UI cannot read values
      // back, so it cannot resend them, and an edit must not wipe a token.
      env: Object.keys(parsed.env).length > 0 ? parsed.env : (existing?.env ?? {}),
      headers:
        Object.keys(parsed.headers).length > 0 ? parsed.headers : (existing?.headers ?? {}),
      enabled: changedTarget ? false : (existing?.enabled ?? false),
      approvedTools: changedTarget ? [] : (existing?.approvedTools ?? []),
      discoveredTools: changedTarget ? [] : (existing?.discoveredTools ?? []),
      state: changedTarget ? "never_inspected" : (existing?.state ?? "never_inspected"),
      lastError: changedTarget ? "" : (existing?.lastError ?? ""),
      lastInspectedAt: changedTarget ? "" : (existing?.lastInspectedAt ?? ""),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.state.servers = [
      ...this.state.servers.filter((entry) => entry.id !== parsed.id),
      server,
    ].sort((a, b) => a.id.localeCompare(b.id));
    await this.persist();

    await this.deps.audit.record({
      actor: { kind: "user", oid: actor.oid, tenantId: actor.tenantId },
      action: existing ? "mcp.update" : "mcp.add",
      family: "mcp",
      outcome: "succeeded",
      correlationId,
      resources: [parsed.id],
      reason: changedTarget ? "target changed; approvals cleared" : "",
    });

    return redact(server);
  }

  async remove(id: string, actor: Actor, correlationId: string): Promise<void> {
    await this.ensureLoaded();
    this.find(id);
    this.state.servers = this.state.servers.filter((entry) => entry.id !== id);
    await this.persist();

    await this.deps.audit.record({
      actor: { kind: "user", oid: actor.oid, tenantId: actor.tenantId },
      action: "mcp.remove",
      family: "mcp",
      outcome: "succeeded",
      correlationId,
      resources: [id],
    });
  }

  /**
   * Connect once, read what the server advertises, disconnect.
   *
   * Discovery does not grant anything. A tool that disappears from the
   * advertised list keeps its approval recorded but becomes uncallable, and a
   * newly advertised tool arrives unapproved.
   */
  async inspect(id: string, actor: Actor, correlationId: string): Promise<McpInspectResult> {
    await this.ensureLoaded();
    const server = this.find(id);

    const result = await probeMcpServer({
      id: server.id,
      transport: server.transport,
      command: server.command,
      args: server.args,
      env: server.env,
      url: server.url,
      headers: server.headers,
    });

    server.state = result.ok ? "ok" : "failed";
    server.lastError = result.error;
    server.lastInspectedAt = new Date().toISOString();
    if (result.ok) server.discoveredTools = result.tools;
    server.updatedAt = server.lastInspectedAt;
    await this.persist();

    await this.deps.audit.record({
      actor: { kind: "user", oid: actor.oid, tenantId: actor.tenantId },
      action: "mcp.inspect",
      family: "mcp",
      outcome: result.ok ? "succeeded" : "failed",
      correlationId,
      resources: [id],
      reason: result.ok ? `advertised ${result.tools.length} tools` : result.error,
    });

    return result;
  }

  /**
   * Record what the agent runtime found when it actually started a server.
   *
   * Inspect is a probe run on demand from the MCP page; this is the other
   * thing that connects to a server, and until now nothing came back from it.
   * The runtime starts every enabled server when it builds a session, gives
   * each one a fixed handshake budget, and drops the ones that miss it. A
   * dropped server left no mark anywhere: the stored record kept the `ok` from
   * the last manual Inspect, the MCP page kept showing it enabled, and the only
   * symptom was the model announcing mid-conversation that a tool it had a
   * moment ago was gone. That is the whole of "the Work IQ connection is
   * unstable" — it is not random, it is a race nobody was told about.
   *
   * Measured on this install: Work IQ needs 26 to 30 seconds to initialise
   * (roughly 4 for `npx` to resolve the package, the rest for the proxy to sign
   * in and register its remote tools) against a 60 second budget it shares with
   * every other server starting at the same moment. It wins that race most of
   * the time and loses it some of the time.
   *
   * Only `state` and `lastError` move. A server that failed to start has not
   * had its approvals withdrawn, has not stopped being enabled, and has not
   * been inspected — so `approvedTools`, `enabled`, `discoveredTools` and
   * `lastInspectedAt` are left exactly as the user left them. Ids the runtime
   * reports that we do not own are ignored rather than added: the runtime also
   * loads servers from its own configuration, and this registry is a record of
   * what *this app* was asked to connect.
   *
   * Returns whether anything changed, so a steady stream of "still connected"
   * does not rewrite the file on every turn.
   */
  async recordRuntimeStatus(id: string, ok: boolean, error: string): Promise<boolean> {
    await this.ensureLoaded();
    const server = this.state.servers.find((entry) => entry.id === id);
    if (server === undefined) return false;

    const state = ok ? "ok" : "failed";
    const lastError = ok ? "" : error;
    if (server.state === state && server.lastError === lastError) return false;

    server.state = state;
    server.lastError = lastError;
    server.updatedAt = new Date().toISOString();
    await this.persist();

    if (!ok) {
      this.deps.logger.warn("mcp server failed to start for a session", { id, error });
    }
    return true;
  }

  /**
   * Approve or revoke individual tools by name.
   *
   * The guard is on what is being **granted**, not on the whole list. A tool
   * that stops being advertised keeps its approval on the record (see
   * `inspect`), so the caller's current set legitimately contains names that
   * are no longer in `discoveredTools` — and rejecting the whole call for one
   * of those made every subsequent approval impossible. Measured on a real
   * Work IQ server: `get_debug_link` had been approved, the server stopped
   * offering it, and from then on every tick of another tool was refused with
   * "unknown tools get_debug_link" while the checkbox silently stayed put.
   *
   * Carrying an existing approval through is not new consent: it was given
   * against a description that was read at the time. Consent to something
   * nobody has ever read a description of is still refused.
   */
  async setApprovedTools(
    id: string,
    tools: string[],
    actor: Actor,
    correlationId: string,
  ): Promise<McpServerRecord> {
    await this.ensureLoaded();
    const server = this.find(id);

    const advertised = new Set(server.discoveredTools.map((tool) => tool.name));
    const alreadyApproved = new Set(server.approvedTools);
    const unknown = tools.filter((tool) => !advertised.has(tool) && !alreadyApproved.has(tool));
    if (unknown.length > 0) {
      throw new Error(`inspect the server first: unknown tools ${unknown.join(", ")}`);
    }

    server.approvedTools = [...new Set(tools)].sort();
    server.updatedAt = new Date().toISOString();
    await this.persist();

    await this.deps.audit.record({
      actor: { kind: "user", oid: actor.oid, tenantId: actor.tenantId },
      action: "mcp.approveTools",
      family: "mcp",
      outcome: "succeeded",
      correlationId,
      resources: [id, ...server.approvedTools],
    });

    return redact(server);
  }

  /** Enabling requires at least one approved tool; otherwise it is meaningless. */
  async setEnabled(
    id: string,
    enabled: boolean,
    actor: Actor,
    correlationId: string,
  ): Promise<McpServerRecord> {
    await this.ensureLoaded();
    const server = this.find(id);

    if (enabled && server.approvedTools.length === 0) {
      throw new Error("approve at least one tool before enabling this server");
    }

    server.enabled = enabled;
    server.updatedAt = new Date().toISOString();
    await this.persist();

    await this.deps.audit.record({
      actor: { kind: "user", oid: actor.oid, tenantId: actor.tenantId },
      action: enabled ? "mcp.enable" : "mcp.disable",
      family: "mcp",
      outcome: "succeeded",
      correlationId,
      resources: [id],
    });

    return redact(server);
  }

  /**
   * The server map handed to a Copilot session.
   *
   * Only enabled servers with at least one approved tool appear, and each is
   * declared with its approved tool list, so the model is not even offered
   * anything that has not been granted.
   */
  async resolveSessionServers(): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    if (!this.deps.policy.allowUserMcpServers) return {};

    const out: Record<string, unknown> = {};
    for (const server of this.state.servers) {
      if (!server.enabled || server.approvedTools.length === 0) continue;
      out[server.id] =
        server.transport === "stdio"
          ? {
              type: "local",
              command: server.command,
              args: server.args,
              env: server.env,
              tools: server.approvedTools,
            }
          : {
              type: "http",
              url: server.url,
              headers: server.headers,
              tools: server.approvedTools,
            };
    }
    return out;
  }

  /**
   * Deny floor for a single MCP tool call.
   *
   * The session configuration above already limits what is offered; this is the
   * check that holds even if a server advertises something else at call time,
   * or if the runtime ever offers a tool we did not ask for.
   *
   * It has to accept the *qualified* name, because that is the only name the
   * runtime ever reports. A server is registered under its id and its tools are
   * granted by bare name, but the SDK hands both back joined together —
   * `workiq-ask` for `ask` on `workiq`. Matching only the bare name meant this
   * floor denied every call the session config had just authorised: Work IQ was
   * enabled, `ask` was approved, and every call came back "MCP tool
   * \"workiq-ask\" has not been approved" with no approval card, because the
   * rejection happens before the policy chain that would have raised one.
   */
  async gate(toolName: string): Promise<{ allowed: boolean; reason: string }> {
    await this.ensureLoaded();
    if (!this.deps.policy.allowUserMcpServers) {
      return { allowed: false, reason: "MCP servers are disabled by tenant policy" };
    }

    for (const server of this.state.servers) {
      if (!server.enabled) continue;
      if (server.approvedTools.some((tool) => matchesGrant(toolName, server.id, tool))) {
        return { allowed: true, reason: `approved on MCP server ${server.id}` };
      }
    }
    return { allowed: false, reason: `MCP tool "${toolName}" has not been approved` };
  }

  private async deny(
    actor: Actor,
    action: string,
    resource: string,
    correlationId: string,
    reason: string,
  ): Promise<void> {
    await this.deps.audit.record({
      actor: { kind: "user", oid: actor.oid, tenantId: actor.tenantId },
      action,
      family: "mcp",
      outcome: "denied",
      correlationId,
      resources: [resource],
      reason,
    });
  }
}

/**
 * Does a tool name from the runtime match one grant on one server?
 *
 * The bare name matches, and so does the name a host qualifies with the server
 * it came from. Hosts disagree about the joiner — the Copilot SDK uses `-`,
 * others use `.`, `/`, `:` or `_` — so all of them are accepted.
 *
 * The prefix has to be the whole server id, not "everything up to the last
 * separator". Two of the seeded ids contain a hyphen themselves, so splitting
 * on the joiner and keeping the tail is guesswork that happens to work only
 * while no tool name contains one.
 */
function matchesGrant(toolName: string, serverId: string, grant: string): boolean {
  if (toolName === grant) return true;
  if (!toolName.startsWith(serverId)) return false;
  const rest = toolName.slice(serverId.length);
  return rest.length === grant.length + 1 && "-./:_".includes(rest[0] ?? "") && rest.slice(1) === grant;
}

export interface Actor {
  oid: string;
  tenantId: string;
}

/** Strip secret values, keeping their key names so the user can see what is set. */
function redact(server: StoredServer): McpServerRecord {
  return {
    id: server.id,
    label: server.label,
    transport: server.transport,
    command: server.command,
    args: server.args,
    envKeys: Object.keys(server.env).sort(),
    url: server.url,
    headerKeys: Object.keys(server.headers).sort(),
    enabled: server.enabled,
    approvedTools: server.approvedTools,
    discoveredTools: server.discoveredTools,
    state: server.state,
    lastError: server.lastError,
    lastInspectedAt: server.lastInspectedAt,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}
