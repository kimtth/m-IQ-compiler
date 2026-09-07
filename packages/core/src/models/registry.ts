import { join } from "node:path";
import {
  FoundryModelInput,
  ModelDefaults,
  copilotModelId,
  foundryModelId,
  parseModelId,
  resolveModelForRole,
  type FoundryModelEntry,
  type ModelCapability,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelRole,
  type ModelTestResult,
} from "@iq/shared";
import { readJson, writeJsonAtomic } from "../util/jsonl.js";
import { KeyedMutex } from "../util/lock.js";
import type { FoundryClient } from "./foundry-client.js";
import type { AppPaths } from "../config/paths.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { Logger } from "../util/logger.js";
import { hostOf as sharedHostOf } from "../util/text.js";

/**
 * The one registry every model surface reads.
 *
 * The composer's picker, Control Center → Models and Connections & access are
 * three views of this single store, which is the whole point: they can never
 * disagree about what exists or which model a role resolves to. It is a
 * deliberate sibling of {@link McpRegistry} — same atomic-JSON persistence, same
 * change-listener fan-out — because both are consent-and-configuration records
 * that the UI must be able to trust after a crash.
 *
 * Two providers, and the asymmetry between them is intentional. GitHub Copilot
 * models are *advertised* by the SDK for the signed-in account and are never
 * editable here; they arrive through the injected {@link copilotModels}
 * callback so this class stays free of the runtime. Foundry entries are
 * *configured* by the user and are the only thing persisted. If the Copilot
 * side cannot be read the catalogue still returns every Foundry entry and sets
 * `copilotError`; a broken advertised catalogue must never hide the models the
 * user configured by hand.
 *
 * No secret is ever stored. A Foundry entry is a network destination plus a
 * capability claim; it is reached with the Azure identity, so `models.json`
 * holds nothing that would be dangerous to read.
 */

interface StoredState {
  entries: FoundryModelEntry[];
  defaults: ModelDefaults;
}

const EMPTY: StoredState = { entries: [], defaults: { roles: {}, projects: {} } };

export type CopilotModel = {
  id: string;
  name: string;
  available: boolean;
  capabilities?: string[];
};

export interface ModelRegistryDeps {
  paths: AppPaths;
  logger: Logger;
  audit: AuditLog;
  client: FoundryClient;
  /** The SDK's advertised catalogue for the signed-in account. May throw. */
  copilotModels: () => Promise<CopilotModel[]>;
  correlationId: () => string;
}

export class ModelRegistry {
  private state: StoredState = clone(EMPTY);
  private loaded = false;
  private readonly mutex = new KeyedMutex();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: ModelRegistryDeps) {}

  private get file(): string {
    return join(this.deps.paths.config, "models.json");
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const raw = await readJson<Partial<StoredState>>(this.file, EMPTY);
    // Re-validate on the way in: the file is user-editable, and a shape that no
    // longer parses must not poison the whole catalogue.
    const defaults = ModelDefaults.safeParse(raw.defaults);
    this.state = {
      entries: Array.isArray(raw.entries) ? raw.entries.filter(isFoundryEntry) : [],
      defaults: defaults.success ? defaults.data : { roles: {}, projects: {} },
    };
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await this.mutex.withLock("models", () => writeJsonAtomic(this.file, this.state));
  }

  // --- reads ----------------------------------------------------------------

  /**
   * The unified catalogue: advertised Copilot models first, configured Foundry
   * entries after. Foundry ids and endpoints are exposed host-only, never as the
   * full URL, matching the browser and image-provenance audit rule.
   */
  async catalog(): Promise<ModelCatalog> {
    await this.load();

    const entries: ModelCatalogEntry[] = [];
    let copilotError: string | null = null;

    try {
      for (const model of await this.deps.copilotModels()) {
        entries.push({
          // The SDK identifier — not the display name — is what a session is
          // created with, so it is the ref every other surface must store.
          id: copilotModelId(model.id),
          provider: "copilot",
          displayName: model.name || model.id,
          capabilities: normaliseCapabilities(model.capabilities),
          editable: false,
          endpointHost: "",
          projectIds: [],
          lastTest: null,
          available: model.available,
        });
      }
    } catch (error) {
      copilotError = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn("copilot catalogue unavailable", { message: copilotError });
    }

    for (const entry of this.state.entries) {
      entries.push(this.toCatalogEntry(entry));
    }

    return { entries, defaults: this.state.defaults, copilotError };
  }

  /** The raw Foundry entry behind a catalogue id, or null for a Copilot id. */
  async entry(id: string): Promise<FoundryModelEntry | null> {
    await this.load();
    const rawId = this.toFoundryId(id);
    if (rawId === null) return null;
    return this.state.entries.find((entry) => entry.id === rawId) ?? null;
  }

  /**
   * Layered default resolution.
   *
   * Precedence is: a per-project override for the role, then the role default,
   * then the first eligible entry advertising the capability the role requires.
   * A referenced id that no longer advertises the required capability is skipped
   * rather than returned, so a stale default degrades to a working one instead
   * of handing back a model that cannot do the job.
   *
   * The rule itself lives in `@iq/shared` so that a surface offering a model
   * picker opens on the same answer this returns. Two copies of it drifted
   * once already.
   */
  async resolve(role: ModelRole, projectId?: string | null): Promise<ModelCatalogEntry | null> {
    const catalog = await this.catalog();
    return resolveModelForRole(catalog, role, projectId ?? null);
  }

  // --- mutations ------------------------------------------------------------

  /**
   * Add or replace a Foundry entry.
   *
   * The shape is validated here, not in the handler: an entry without a
   * deployment name is a destination the agent would later be pointed at and
   * fail on, so it is refused up front with the fix named.
   */
  async upsert(input: FoundryModelInput): Promise<FoundryModelEntry> {
    await this.load();
    const parsed = FoundryModelInput.parse(input);

    if (!parsed.deploymentName.trim()) {
      throw new Error("a Foundry entry needs a deployment name — set it in Control Center → Models.");
    }

    const now = new Date().toISOString();
    const id = parsed.id?.trim() || newEntryId();
    const existing = this.state.entries.find((entry) => entry.id === id);

    const entry: FoundryModelEntry = {
      ...parsed,
      id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      // Re-pointing an entry invalidates any prior verification: a token that
      // reached the old destination proves nothing about the new one.
      lastTest: existing && !retargeted(existing, parsed) ? existing.lastTest : null,
    };

    this.state.entries = [
      ...this.state.entries.filter((candidate) => candidate.id !== id),
      entry,
    ].sort((a, b) => a.displayName.localeCompare(b.displayName));
    await this.persist();

    await this.audit(existing ? "model.update" : "model.add", foundryModelId(id), existing ? "updated" : "added");
    this.notify();
    return entry;
  }

  async remove(id: string): Promise<void> {
    await this.load();
    const rawId = this.toFoundryId(id);
    if (rawId === null) throw new Error(`"${id}" is not a Foundry entry; Copilot models cannot be removed.`);
    if (!this.state.entries.some((entry) => entry.id === rawId)) {
      throw new Error(`no model entry "${id}".`);
    }

    this.state.entries = this.state.entries.filter((entry) => entry.id !== rawId);
    // Drop any default that pointed at the removed entry so nothing resolves to
    // a destination that no longer exists.
    this.pruneDefaults(foundryModelId(rawId));
    await this.persist();

    await this.audit("model.remove", foundryModelId(rawId), "removed");
    this.notify();
  }

  /** Run the Test control's round-trip and record its result on the entry. */  async test(id: string): Promise<ModelTestResult> {
    await this.load();
    const rawId = this.toFoundryId(id);
    const entry = rawId === null ? undefined : this.state.entries.find((candidate) => candidate.id === rawId);
    if (!entry) throw new Error(`no Foundry entry "${id}" to test.`);

    const result = await this.deps.client.probe(entry);
    entry.lastTest = result;
    entry.updatedAt = new Date().toISOString();
    await this.persist();

    await this.audit(
      "model.test",
      foundryModelId(entry.id),
      result.state === "reachable" ? "reachable" : result.state,
      result.state === "reachable" ? "succeeded" : "failed",
    );
    this.notify();
    return result;
  }

  async setDefault(role: ModelRole, modelId: string | null, projectId?: string | null): Promise<void> {
    await this.load();

    if (projectId) {
      const forProject = { ...(this.state.defaults.projects[projectId] ?? {}) };
      if (modelId) forProject[role] = modelId;
      else delete forProject[role];
      this.state.defaults.projects = {
        ...this.state.defaults.projects,
        [projectId]: forProject,
      };
    } else {
      const roles = { ...this.state.defaults.roles };
      if (modelId) roles[role] = modelId;
      else delete roles[role];
      this.state.defaults.roles = roles;
    }

    await this.persist();
    await this.audit(
      "model.setDefault",
      modelId ?? "(cleared)",
      `${role}${projectId ? ` @ ${projectId}` : ""}`,
    );
    this.notify();
  }

  /**
   * Clear every Foundry entry's last test result.
   *
   * Called when the tenant changes: a verification recorded against one tenant's
   * token says nothing about access in another, so nothing may keep claiming to
   * be "reachable" until it is re-tested under the new identity.
   */
  async invalidateTests(reason: string): Promise<void> {
    await this.load();
    let changed = false;
    for (const entry of this.state.entries) {
      if (entry.lastTest !== null) {
        entry.lastTest = null;
        entry.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (!changed) return;
    await this.persist();
    await this.audit("model.invalidateTests", "(all foundry)", reason);
    this.notify();
  }

  // --- internals ------------------------------------------------------------

  private toCatalogEntry(entry: FoundryModelEntry): ModelCatalogEntry {
    return {
      id: foundryModelId(entry.id),
      provider: "foundry",
      displayName: entry.displayName,
      capabilities: entry.capabilities,
      editable: true,
      endpointHost: hostOf(entry.endpoint),
      projectIds: entry.projectIds,
      lastTest: entry.lastTest,
      available: true,
    };
  }

  /** Accept a catalogue id (`foundry:x`) or a bare entry id; reject Copilot ids. */
  private toFoundryId(id: string): string | null {
    const parsed = parseModelId(id);
    if (parsed) return parsed.provider === "foundry" ? parsed.ref : null;
    return id;
  }

  private pruneDefaults(catalogId: string): void {
    const roles = { ...this.state.defaults.roles };
    for (const [role, value] of Object.entries(roles)) {
      if (value === catalogId) delete roles[role as ModelRole];
    }
    this.state.defaults.roles = roles;

    const projects: ModelDefaults["projects"] = {};
    for (const [projectId, map] of Object.entries(this.state.defaults.projects)) {
      const kept: Record<string, string | null> = {};
      for (const [role, value] of Object.entries(map)) {
        if (value !== catalogId) kept[role] = value;
      }
      projects[projectId] = kept;
    }
    this.state.defaults.projects = projects;
  }

  private async audit(
    action: string,
    resource: string,
    reason: string,
    outcome: "succeeded" | "failed" = "succeeded",
  ): Promise<void> {
    await this.deps.audit.record({
      actor: { kind: "system" },
      action,
      family: "models",
      outcome,
      correlationId: this.deps.correlationId(),
      resources: [resource],
      reason,
    });
  }
}

function isFoundryEntry(value: unknown): value is FoundryModelEntry {
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";
}

/** Only the capability names our contract knows survive; anything else is dropped. */
function normaliseCapabilities(capabilities: string[] | undefined): ModelCapability[] {
  const known: ModelCapability[] = ["chat", "reasoning", "vision", "image", "embeddings"];
  const set = new Set<ModelCapability>(["chat"]);
  for (const capability of capabilities ?? []) {
    if ((known as string[]).includes(capability)) set.add(capability as ModelCapability);
  }
  return [...set];
}

/*
 * Project scoping and role resolution live in `@iq/shared`, as
 * `modelInProject` and `resolveModelForRole`. A private copy of either here
 * is how the registry and the renderer came to disagree about which model a
 * role resolves to — the surface picked the first image-capable entry while
 * the setting that was supposed to decide it had no observable effect.
 */

/** True when an edit changed where the entry points, not merely how it is labelled. */
function retargeted(existing: FoundryModelEntry, next: FoundryModelInput): boolean {
  return (
    existing.endpoint !== next.endpoint ||
    existing.deploymentName !== next.deploymentName ||
    existing.apiVersion !== next.apiVersion
  );
}

function newEntryId(): string {
  return `fm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const hostOf = (url: string): string => sharedHostOf(url, "");

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
