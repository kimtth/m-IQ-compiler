import { join } from "node:path";
import {
  MemoryDerivation,
  MemoryInput,
  MemoryRecord,
  newMemoryId,
  type MemoryStatus,
} from "@iq/shared";
import { readJson, writeJsonAtomic } from "../util/jsonl.js";
import { KeyedMutex } from "../util/lock.js";
import { SAMPLE_MEMORIES, isSampleMemory } from "../samples/memories.js";
import type { AppPaths } from "../config/paths.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { Logger } from "../util/logger.js";

/**
 * Durable memory store.
 *
 * Two properties are required because a memory is an input to automatic skill
 * derivation and has to be trustworthy:
 *
 *  1. A memory captured by the agent starts as `pending` and has no effect at
 *     all until a person approves it, so nothing the model asserts about the
 *     user can influence future behaviour on its own.
 *  2. Every transition is audited with the approver's Entra object id, which is
 *     what makes a derived skill traceable back to a human decision.
 *
 * The whole set is a single atomically written document rather than an
 * append-only log, because memories mutate (approve, reject, supersede) and the
 * set is small by construction. Mutations are serialised through a mutex so two
 * approvals cannot interleave and lose one another's write.
 */

interface MemoryState {
  memories: MemoryRecord[];
  /** Derivation bookkeeping, keyed by subject slug. */
  derivations: Record<string, MemoryDerivation>;
}

const EMPTY_STATE: MemoryState = { memories: [], derivations: {} };

export interface MemoryListFilter {
  status?: MemoryStatus;
  subject?: string;
}

export type MemoryListener = (reason: "recorded" | "approved" | "rejected" | "deleted") => void;

export class MemoryStore {
  private state: MemoryState = EMPTY_STATE;
  private loaded = false;
  private readonly mutex = new KeyedMutex();
  private listener: MemoryListener | null = null;

  constructor(
    private readonly paths: AppPaths,
    private readonly audit: AuditLog,
    private readonly logger: Logger,
  ) {}

  /** Set by the container so the curator can react to an approval. */
  onChanged(listener: MemoryListener): void {
    this.listener = listener;
  }

  private get file(): string {
    return join(this.paths.memories, "memories.json");
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const raw = await readJson<MemoryState>(this.file, EMPTY_STATE);
    const memories: MemoryRecord[] = [];
    for (const entry of raw.memories ?? []) {
      const parsed = MemoryRecord.safeParse(entry);
      // One unreadable record must not cost the user every other memory.
      if (parsed.success) memories.push(parsed.data);
      else this.logger.warn("skipping unreadable memory record", { error: parsed.error.message });
    }

    const derivations: Record<string, MemoryDerivation> = {};
    for (const [slug, entry] of Object.entries(raw.derivations ?? {})) {
      const parsed = MemoryDerivation.safeParse(entry);
      if (parsed.success) derivations[slug] = parsed.data;
    }

    this.state = { memories, derivations };
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.file, this.state);
  }

  private notify(reason: Parameters<MemoryListener>[0]): void {
    try {
      this.listener?.(reason);
    } catch (error) {
      this.logger.warn("memory listener failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async list(filter: MemoryListFilter = {}): Promise<MemoryRecord[]> {
    await this.ensureLoaded();
    return this.state.memories
      .filter((memory) => (filter.status ? memory.status === filter.status : true))
      .filter((memory) => (filter.subject ? memory.subject === filter.subject : true))
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<MemoryRecord | null> {
    await this.ensureLoaded();
    return this.state.memories.find((memory) => memory.id === id) ?? null;
  }

  /**
   * Put the demo memory set in the store, for a person who asked for it.
   *
   * This is the one place records enter already decided, and it is deliberately
   * not a general import: the set is a fixed constant in `samples.ts`, so the
   * caller chooses whether to load the samples, not what a memory says. Eight of
   * them arrive settled so the settled list and Compile are reachable without
   * an Entra sign-in, which real approval requires — they are marked as decided
   * by `sample-data`, because no person decided them and the trail should not
   * pretend otherwise.
   *
   * Keyed on the fixed sample ids, so loading twice adds nothing and never
   * disturbs a record the tester has since approved, rejected or forgotten.
   */
  async seedSamples(correlationId: string): Promise<{ added: number; total: number }> {
    const result = await this.mutex.withLock("memories", async () => {
      await this.ensureLoaded();

      const known = new Set(this.state.memories.map((memory) => memory.id));
      const missing = SAMPLE_MEMORIES.filter((sample) => !known.has(sample.id));
      if (missing.length === 0) {
        return { added: 0, total: this.state.memories.length };
      }

      this.state.memories.push(...missing.map((sample) => ({ ...sample })));
      await this.persist();

      await this.audit.record({
        // Not "user": loading a demo fixture is not a sign-in, and there may be
        // no account at all. Not "agent" either — a person asked for this.
        actor: { kind: "system" },
        action: "memory.seedSamples",
        family: "memory",
        outcome: "succeeded",
        correlationId,
        resources: missing.map((sample) => sample.id),
        reason: `loaded ${missing.length} sample memories`,
      });

      return { added: missing.length, total: this.state.memories.length };
    });

    if (result.added > 0) this.notify("recorded");
    return result;
  }

  /**
   * Take the demo memory set back out again.
   *
   * Loading samples into a store that also holds real memories has to be
   * reversible, or the demo is a one-way change to the user's own data. The
   * filter is the fixed `mem_sample_` prefix, so nothing the assistant actually
   * proposed can be swept out by this — `record` mints ids that never carry it.
   */
  async clearSamples(correlationId: string): Promise<{ removed: number; total: number }> {
    const result = await this.mutex.withLock("memories", async () => {
      await this.ensureLoaded();

      const doomed = this.state.memories.filter((memory) => isSampleMemory(memory.id));
      if (doomed.length === 0) {
        return { removed: 0, total: this.state.memories.length };
      }

      this.state.memories = this.state.memories.filter((memory) => !isSampleMemory(memory.id));
      await this.persist();

      await this.audit.record({
        actor: { kind: "system" },
        action: "memory.clearSamples",
        family: "memory",
        outcome: "succeeded",
        correlationId,
        resources: doomed.map((memory) => memory.id),
        reason: `removed ${doomed.length} sample memories`,
      });

      return { removed: doomed.length, total: this.state.memories.length };
    });

    if (result.removed > 0) this.notify("deleted");
    return result;
  }

  /**
   * Capture a memory. Always lands as `pending`: the agent proposes, it never
   * decides.
   */
  async record(input: MemoryInput, correlationId: string): Promise<MemoryRecord> {
    const parsed = MemoryInput.parse(input);

    const record = await this.mutex.withLock("memories", async () => {
      await this.ensureLoaded();

      const duplicate = this.state.memories.find(
        (memory) =>
          memory.status !== "rejected" &&
          memory.subject.toLowerCase() === parsed.subject.toLowerCase() &&
          memory.fact.trim().toLowerCase() === parsed.fact.trim().toLowerCase(),
      );
      // Re-asserting a known fact is common; returning the existing record keeps
      // the review queue from filling with copies of the same claim.
      if (duplicate) return duplicate;

      const now = new Date().toISOString();
      const created = MemoryRecord.parse({
        id: newMemoryId(),
        subject: parsed.subject,
        fact: parsed.fact,
        rationale: parsed.rationale,
        citations: parsed.citations,
        scope: parsed.scope,
        status: "pending",
        memoryType: parsed.memoryType,
        toolFamilies: parsed.toolFamilies,
        sourceSessionId: parsed.sourceSessionId,
        sourceTurnId: parsed.sourceTurnId,
        createdAt: now,
        updatedAt: now,
        decidedBy: null,
        decidedAt: null,
        derivedSkill: null,
      });

      this.state.memories.push(created);
      await this.persist();

      await this.audit.record({
        actor: { kind: "agent", sessionId: parsed.sourceSessionId, turnId: parsed.sourceTurnId },
        action: "memory.record",
        family: "memory",
        outcome: "succeeded",
        correlationId,
        resources: [created.id],
        reason: created.fact,
      });

      return created;
    });

    this.notify("recorded");
    return record;
  }

  async approve(
    id: string,
    approver: { oid: string; tenantId: string },
    correlationId: string,
  ): Promise<MemoryRecord> {
    return this.decide(id, "approved", approver, correlationId);
  }

  async reject(
    id: string,
    approver: { oid: string; tenantId: string },
    correlationId: string,
  ): Promise<MemoryRecord> {
    return this.decide(id, "rejected", approver, correlationId);
  }

  private async decide(
    id: string,
    status: Extract<MemoryStatus, "approved" | "rejected">,
    approver: { oid: string; tenantId: string },
    correlationId: string,
  ): Promise<MemoryRecord> {
    const updated = await this.mutex.withLock("memories", async () => {
      await this.ensureLoaded();
      const memory = this.state.memories.find((entry) => entry.id === id);
      if (!memory) throw new Error(`unknown memory ${id}`);

      memory.status = status;
      memory.decidedBy = { oid: approver.oid, tenantId: approver.tenantId };
      memory.decidedAt = new Date().toISOString();
      memory.updatedAt = memory.decidedAt;

      if (status === "approved") {
        // A newer approved fact retires an older identical one, so a derived
        // skill never repeats the same rule twice.
        for (const other of this.state.memories) {
          if (other.id === memory.id) continue;
          if (other.status !== "approved") continue;
          if (other.subject.toLowerCase() !== memory.subject.toLowerCase()) continue;
          if (other.fact.trim().toLowerCase() !== memory.fact.trim().toLowerCase()) continue;
          other.status = "superseded";
          other.updatedAt = memory.updatedAt;
        }
      }

      await this.persist();

      await this.audit.record({
        actor: { kind: "user", oid: approver.oid, tenantId: approver.tenantId },
        action: status === "approved" ? "memory.approve" : "memory.reject",
        family: "memory",
        outcome: "succeeded",
        correlationId,
        resources: [memory.id],
        reason: memory.fact,
      });

      return memory;
    });

    this.notify(status === "approved" ? "approved" : "rejected");
    return updated;
  }

  /**
   * Correct a memory's subject, fact or rationale.
   *
   * **An edit to an approved memory returns it to `pending`.** That is the
   * whole design of this method and it is not a convenience to be optimised
   * away. Approval attaches a named person to a specific claim; letting the
   * claim change underneath that approval would leave the record asserting that
   * someone signed off on wording they never read — and approved memories are
   * exactly what the curator compiles into skills, so the edited text would
   * reach a prompt surface on the strength of a signature for different text.
   * Re-approval is one click, and it is the click that makes the record true.
   *
   * A pending or rejected memory keeps its status: there is no approval to
   * invalidate. Provenance is never editable, so the audit trail survives.
   */
  async update(
    edit: { id: string; subject: string; fact: string; rationale: string },
    correlationId: string,
    editor: { oid: string; tenantId: string } | null = null,
  ): Promise<MemoryRecord> {
    let reapproval = false;

    const updated = await this.mutex.withLock("memories", async () => {
      await this.ensureLoaded();
      const memory = this.state.memories.find((entry) => entry.id === edit.id);
      if (!memory) throw new Error(`unknown memory ${edit.id}`);

      const subject = edit.subject.trim();
      const fact = edit.fact.trim();
      if (subject === "") throw new Error("a memory needs a subject");
      if (fact === "") throw new Error("a memory needs a fact");

      const unchanged =
        memory.subject === subject &&
        memory.fact === fact &&
        memory.rationale === edit.rationale.trim();
      if (unchanged) return memory;

      reapproval = memory.status === "approved";

      memory.subject = subject;
      memory.fact = fact;
      memory.rationale = edit.rationale.trim();
      memory.updatedAt = new Date().toISOString();

      if (reapproval) {
        memory.status = "pending";
        memory.decidedBy = null;
        memory.decidedAt = null;
        // The derived skill was compiled from the old wording, so the link is
        // stale. The curator re-derives on the next approval.
        memory.derivedSkill = null;
      }

      await this.persist();

      await this.audit.record({
        actor: editor
          ? { kind: "user", oid: editor.oid, tenantId: editor.tenantId }
          : { kind: "system" },
        action: "memory.update",
        family: "memory",
        outcome: "succeeded",
        correlationId,
        resources: [memory.id],
        reason: reapproval
          ? `edited an approved memory, which returns it to review: ${memory.fact}`
          : `edited: ${memory.fact}`,
      });

      return memory;
    });

    // "recorded" rather than "approved": an edit never triggers derivation, and
    // one that returned a memory to pending has just removed it from the set
    // the curator is allowed to read.
    this.notify("recorded");
    return updated;
  }

  async delete(id: string, correlationId: string): Promise<void> {
    await this.mutex.withLock("memories", async () => {
      await this.ensureLoaded();
      const before = this.state.memories.length;
      this.state.memories = this.state.memories.filter((memory) => memory.id !== id);
      if (this.state.memories.length === before) throw new Error(`unknown memory ${id}`);
      await this.persist();
      await this.audit.record({
        actor: { kind: "system" },
        action: "memory.delete",
        family: "memory",
        outcome: "succeeded",
        correlationId,
        resources: [id],
      });
    });
    this.notify("deleted");
  }

  // --- derivation bookkeeping ------------------------------------------------

  async derivations(): Promise<MemoryDerivation[]> {
    await this.ensureLoaded();
    return Object.values(this.state.derivations).sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async derivationFor(slug: string): Promise<MemoryDerivation | null> {
    await this.ensureLoaded();
    return this.state.derivations[slug] ?? null;
  }

  /**
   * Commit the result of one derivation: remember the signature, and stamp the
   * contributing memories so the UI can show what a skill was built from.
   */
  async recordDerivation(derivation: MemoryDerivation): Promise<void> {
    await this.mutex.withLock("memories", async () => {
      await this.ensureLoaded();
      const parsed = MemoryDerivation.parse(derivation);
      this.state.derivations[parsed.slug] = parsed;
      const ids = new Set(parsed.memoryIds);
      for (const memory of this.state.memories) {
        if (ids.has(memory.id)) memory.derivedSkill = parsed.skillName;
      }
      await this.persist();
    });
  }
}
