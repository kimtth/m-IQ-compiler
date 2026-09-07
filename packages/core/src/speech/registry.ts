import { join } from "node:path";
import { SpeechResourceInput, type SpeechResource } from "@iq/shared";
import { readJson, writeJsonAtomic } from "../util/jsonl.js";
import { KeyedMutex } from "../util/lock.js";
import { speechConfigFromEnv, type SpeechConfig } from "./speech.js";
import type { AppPaths } from "../config/paths.js";
import type { AuditLog } from "../audit/audit-log.js";
import { hostOf as sharedHostOf, UNNAMED_ENDPOINT } from "../util/text.js";

/**
 * The registered Azure AI Speech resource.
 *
 * A deliberate sibling of {@link ModelRegistry}: the user adds a destination in
 * *Connections & access*, it is persisted as atomic JSON, and it is reached
 * with the signed-in Azure identity. Nothing secret is written — `speech.json`
 * holds a custom domain endpoint, a locale and a voice — so key authentication
 * is not merely discouraged here, it has no representation.
 *
 * A registration written before the endpoint existed held a region and an ARM
 * resource id. Neither can be turned into a custom domain, and the regional
 * host it described rejects the only credential this app has, so such a record
 * fails to parse and is dropped rather than carried forward as a destination
 * that would 401.
 *
 * Exactly one resource may be registered at a time. Voice input, spoken replies
 * and meeting transcription all speak to "the" Speech resource; a list would
 * only raise the question of which one a given turn used.
 *
 * Environment variables remain a host-level fallback for headless runs, but a
 * user registration always wins, and an environment entry is reported as
 * non-editable rather than silently overwritten.
 */

interface StoredState {
  resource: SpeechResource | null;
  registeredAt: string | null;
}

const EMPTY: StoredState = { resource: null, registeredAt: null };

export interface SpeechRegistryDeps {
  paths: AppPaths;
  audit: AuditLog;
  correlationId: () => string;
}

export class SpeechRegistry {
  private state: StoredState = { ...EMPTY };
  private loaded = false;
  private readonly mutex = new KeyedMutex();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: SpeechRegistryDeps) {}

  private get file(): string {
    return join(this.deps.paths.config, "speech.json");
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
    // The file is user-editable; a shape that no longer parses is dropped
    // rather than allowed to point voice at a destination we cannot describe.
    const parsed = SpeechResourceInput.safeParse(raw.resource);
    this.state = {
      resource: parsed.success ? parsed.data : null,
      registeredAt: typeof raw.registeredAt === "string" ? raw.registeredAt : null,
    };
    this.loaded = true;
  }

  /**
   * What the service should use right now.
   *
   * Synchronous, because {@link SpeechService.status} is synchronous and is
   * called on every render of the connections card. {@link load} is awaited once
   * at startup, so by the time the UI can ask, the answer is already in memory.
   */
  current(): SpeechConfig | null {
    if (this.state.resource) return toConfig(this.state.resource);
    return speechConfigFromEnv();
  }

  /** Add or replace the registration. Validation lives here, not in the handler. */
  async register(input: unknown): Promise<SpeechConfig> {
    await this.load();
    const resource = SpeechResourceInput.parse(input);

    this.state = { resource, registeredAt: new Date().toISOString() };
    await this.persist();

    await this.record(
      "speech.register",
      hostOf(resource.endpoint),
      `${resource.displayName} · managed identity`,
    );
    this.notify();
    return toConfig(resource);
  }

  /** Remove the registration. Voice goes inert; it does not fall back silently. */
  async remove(): Promise<void> {
    await this.load();
    if (!this.state.resource) throw new Error("no Azure AI Speech resource is registered.");
    const removed = this.state.resource;

    this.state = { ...EMPTY };
    await this.persist();

    await this.record(
      "speech.remove",
      hostOf(removed.endpoint),
      `${removed.displayName} removed`,
    );
    this.notify();
  }

  private async persist(): Promise<void> {
    await this.mutex.withLock("speech", () => writeJsonAtomic(this.file, this.state));
  }

  private async record(action: string, resource: string, reason: string): Promise<void> {
    await this.deps.audit.record({
      actor: { kind: "system" },
      action,
      family: "speech",
      outcome: "succeeded",
      correlationId: this.deps.correlationId(),
      resources: [resource],
      reason,
    });
  }
}

function toConfig(resource: SpeechResource): SpeechConfig {
  return {
    displayName: resource.displayName,
    // Stored trimmed so every URL built from it can append its own path.
    endpoint: resource.endpoint.replace(/\/+$/, ""),
    locale: resource.locale,
    voice: resource.voice,
    source: "user",
  };
}

/** Only the host reaches the audit log — never a full Speech URL. */
const hostOf = (endpoint: string): string => sharedHostOf(endpoint, UNNAMED_ENDPOINT);
