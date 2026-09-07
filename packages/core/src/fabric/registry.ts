import { join } from "node:path";
import {
  FabricConnectionInput,
  FabricDataAgentConnectionInput,
  FabricDataAgentStatus,
  FabricStatus,
  dataAgentUrlFor,
  type FabricConnection,
  type FabricDataAgentConnection,
} from "@iq/shared";
import { readJson, writeJsonAtomic } from "../util/jsonl.js";
import type { AppPaths } from "../config/paths.js";
import type { AuditLog } from "../audit/audit-log.js";
import { hostOf as sharedHostOf } from "../util/text.js";

/**
 * The registered Fabric workspace.
 *
 * One connection, not a list. The Foundry registry is a list because a user
 * genuinely runs several deployments at once; a Fabric co-creation run targets
 * the workspace it is going to create things in, and offering five of them in a
 * picker is how something lands in the wrong one.
 *
 * Held in memory after load because `status()` is called on every render of the
 * Fabric surface and the connections card, and both of those are synchronous.
 *
 * There is no secret here — a workspace GUID — so the whole record is safe to
 * read back to the renderer. That is a property of the design rather than an
 * accident: Fabric is reached with the Azure identity, so there is nothing to
 * redact.
 *
 * The Data Agent lives in {@link FabricDataAgentRegistry} rather than here. It
 * was a field on this record and the coupling was wrong in both directions:
 * someone who only wanted to ask questions had to register a workspace they
 * never built in, and removing the workspace silently took the Q\&A with it.
 */

export const FABRIC_SETUP_HINT =
  "No Microsoft Fabric workspace is registered. Add one in Connections & access with the workspace GUID from its Fabric URL — it is reached with your Azure identity, so no key is needed or stored.";

interface FabricState {
  connection: FabricConnection | null;
  /** An explicit skills-for-fabric path, when the user chose one. */
  skillPackPath: string;
}

export interface FabricRegistryDeps {
  paths: AppPaths;
  audit: AuditLog;
  correlationId: () => string;
}

/** Host-level fallback for headless runs, mirroring `speechConfigFromEnv`. */
export function fabricConnectionFromEnv(): FabricConnection | null {
  const workspaceId = process.env["IQ_FABRIC_WORKSPACE_ID"];
  if (!workspaceId) return null;

  const parsed = FabricConnectionInput.safeParse({
    displayName: process.env["IQ_FABRIC_NAME"] ?? "Microsoft Fabric (environment)",
    workspaceId,
    workspaceName: process.env["IQ_FABRIC_WORKSPACE_NAME"] ?? "",
  });
  return parsed.success ? parsed.data : null;
}

export class FabricRegistry {
  private state: FabricState = { connection: null, skillPackPath: "" };
  private fromEnvironment = false;

  constructor(private readonly deps: FabricRegistryDeps) {}

  private get file(): string {
    return join(this.deps.paths.config, "fabric.json");
  }

  async load(): Promise<void> {
    const raw = await readJson<{ connection?: unknown; skillPackPath?: unknown }>(this.file, {});
    const parsed = FabricConnectionInput.safeParse(raw.connection);
    const skillPackPath = typeof raw.skillPackPath === "string" ? raw.skillPackPath : "";

    if (parsed.success) {
      this.state = { connection: parsed.data, skillPackPath };
      this.fromEnvironment = false;
      return;
    }

    // Nothing registered by the user: the environment is the fallback, exactly
    // as it is for Speech. An environment entry is not editable in the UI,
    // because editing it would write a file the host is about to override.
    const fromEnv = fabricConnectionFromEnv();
    this.state = { connection: fromEnv, skillPackPath };
    this.fromEnvironment = fromEnv !== null;
  }

  current(): FabricConnection | null {
    return this.state.connection;
  }

  skillPackPath(): string {
    return this.state.skillPackPath;
  }

  status(): FabricStatus {
    const connection = this.state.connection;
    if (connection === null) {
      return { state: "not_configured", message: FABRIC_SETUP_HINT };
    }

    return {
      state: "ready",
      auth: "entra",
      displayName: connection.displayName,
      workspaceId: connection.workspaceId,
      workspaceName: connection.workspaceName,
      source: this.fromEnvironment ? "environment" : "user",
      editable: !this.fromEnvironment,
    };
  }

  async save(input: FabricConnectionInput): Promise<FabricConnection> {
    const connection = FabricConnectionInput.parse(input);
    this.state = { ...this.state, connection };
    this.fromEnvironment = false;
    await this.persist();

    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "fabric.connection_saved",
      family: "fabric",
      outcome: "succeeded",
      correlationId: this.deps.correlationId(),
      resources: [connection.workspaceId],
      reason: `workspace ${connection.workspaceId}`,
    });

    return connection;
  }

  async setSkillPackPath(path: string): Promise<void> {
    this.state = { ...this.state, skillPackPath: path.trim() };
    await this.persist();
  }

  async remove(): Promise<void> {
    const previous = this.state.connection;
    this.state = { ...this.state, connection: null };
    await this.persist();
    // Reload so an environment entry reappears rather than leaving the app
    // claiming nothing is configured when the host says otherwise.
    await this.load();

    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "fabric.connection_removed",
      family: "fabric",
      outcome: "succeeded",
      correlationId: this.deps.correlationId(),
      resources: previous ? [previous.workspaceId] : [],
      reason: "the Fabric workspace registration was removed",
    });
  }

  /** Record the workspace's real name once the API has told us what it is. */
  async noteWorkspaceName(name: string): Promise<void> {
    const connection = this.state.connection;
    if (connection === null || name === "" || connection.workspaceName === name) return;
    this.state = { ...this.state, connection: { ...connection, workspaceName: name } };
    await this.persist();
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.file, {
      connection: this.fromEnvironment ? null : this.state.connection,
      skillPackPath: this.state.skillPackPath,
    });
  }
}

const hostOf = (url: string): string => sharedHostOf(url, "");

// --- data agent --------------------------------------------------------------

export const DATA_AGENT_SETUP_HINT =
  "No Fabric Data Agent is connected. Add one in Connections & access — either by the Data Agent's id in your Fabric workspace, or by pasting a published Data Agent URL. It is reached with your Azure identity, so no key is needed or stored.";

export const DATA_AGENT_NEEDS_WORKSPACE_HINT =
  "This Data Agent is connected by workspace, but no Fabric workspace is registered and the connection names none of its own. Register a Fabric workspace, or switch the connection to a published URL.";

export interface FabricDataAgentRegistryDeps {
  paths: AppPaths;
  audit: AuditLog;
  correlationId: () => string;
  /** The registered workspace, when there is one. Read, never written. */
  workspaceId: () => string;
}

/**
 * Host-level fallback. Either route may be given.
 *
 * `IQ_FABRIC_DATA_AGENT_URL` keeps working as it did when the URL lived on the
 * Fabric connection, so a headless host that already sets it needs no change.
 */
export function dataAgentConnectionFromEnv(): FabricDataAgentConnection | null {
  const url = process.env["IQ_FABRIC_DATA_AGENT_URL"];
  const id = process.env["IQ_FABRIC_DATA_AGENT_ID"];

  const candidate =
    url && url.trim() !== ""
      ? { mode: "direct" as const, url: url.trim() }
      : id && id.trim() !== ""
        ? {
            mode: "workspace" as const,
            dataAgentId: id.trim(),
            workspaceId: process.env["IQ_FABRIC_DATA_AGENT_WORKSPACE_ID"] ?? "",
          }
        : null;
  if (candidate === null) return null;

  const parsed = FabricDataAgentConnectionInput.safeParse({
    displayName: process.env["IQ_FABRIC_DATA_AGENT_NAME"] ?? "Fabric Data Agent (environment)",
    ...candidate,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * The connected Fabric Data Agent.
 *
 * Separate from {@link FabricRegistry} because asking a published agent
 * questions and building artifacts in a workspace are different jobs done by
 * different people with different rights. Two modes, one endpoint: see
 * {@link FabricDataAgentConnectionInput}.
 *
 * `baseUrl()` is the single place either mode turns into a URL, so the caller
 * never has to know which route was chosen.
 */
export class FabricDataAgentRegistry {
  private connection: FabricDataAgentConnection | null = null;
  private fromEnvironment = false;

  constructor(private readonly deps: FabricDataAgentRegistryDeps) {}

  private get file(): string {
    return join(this.deps.paths.config, "fabric-data-agent.json");
  }

  async load(): Promise<void> {
    const raw = await readJson<{ connection?: unknown }>(this.file, {});
    const parsed = FabricDataAgentConnectionInput.safeParse(raw.connection);
    if (parsed.success) {
      this.connection = parsed.data;
      this.fromEnvironment = false;
      return;
    }

    const fromEnv = dataAgentConnectionFromEnv();
    this.connection = fromEnv;
    this.fromEnvironment = fromEnv !== null;
  }

  current(): FabricDataAgentConnection | null {
    return this.connection;
  }

  /**
   * The Assistants base URL, or "" when it cannot be composed.
   *
   * Workspace mode prefers the workspace named on the connection and falls back
   * to the registered one, so an agent in another workspace is reachable
   * without disturbing the workspace a run is building in.
   */
  baseUrl(): string {
    const connection = this.connection;
    if (connection === null) return "";
    if (connection.mode === "direct") return connection.url;

    const workspaceId = connection.workspaceId !== "" ? connection.workspaceId : this.deps.workspaceId();
    if (workspaceId === "" || connection.dataAgentId === "") return "";
    return dataAgentUrlFor(workspaceId, connection.dataAgentId);
  }

  status(): FabricDataAgentStatus {
    const connection = this.connection;
    if (connection === null) {
      return { state: "not_configured", message: DATA_AGENT_SETUP_HINT };
    }

    const url = this.baseUrl();
    if (url === "") {
      return {
        state: "needs_workspace",
        message: DATA_AGENT_NEEDS_WORKSPACE_HINT,
        displayName: connection.displayName,
      };
    }

    return {
      state: "ready",
      auth: "entra",
      displayName: connection.displayName,
      mode: connection.mode,
      // Host only. The path carries the workspace and item ids, which is the
      // same reason browser audit and Foundry record hosts.
      host: hostOf(url),
      workspaceId:
        connection.mode === "workspace"
          ? connection.workspaceId !== ""
            ? connection.workspaceId
            : this.deps.workspaceId()
          : "",
      source: this.fromEnvironment ? "environment" : "user",
      editable: !this.fromEnvironment,
    };
  }

  async save(input: FabricDataAgentConnectionInput): Promise<FabricDataAgentConnection> {
    const connection = FabricDataAgentConnectionInput.parse(input);
    this.connection = connection;
    this.fromEnvironment = false;
    await writeJsonAtomic(this.file, { connection });

    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "fabric.data_agent_saved",
      family: "fabric",
      outcome: "succeeded",
      correlationId: this.deps.correlationId(),
      resources: [connection.mode === "workspace" ? connection.dataAgentId : hostOf(connection.url)],
      reason: `data agent connected by ${connection.mode}`,
    });

    return connection;
  }

  async remove(): Promise<void> {
    this.connection = null;
    await writeJsonAtomic(this.file, { connection: null });
    // Reload so an environment entry reappears rather than leaving the app
    // claiming nothing is connected when the host says otherwise.
    await this.load();

    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "fabric.data_agent_removed",
      family: "fabric",
      outcome: "succeeded",
      correlationId: this.deps.correlationId(),
      reason: "the Fabric Data Agent connection was removed",
    });
  }
}
