import { join } from "node:path";
import { AuditRecord, newAuditId, type AuditActor } from "@iq/shared";
import { appendJsonl, readJsonl } from "../util/jsonl.js";
import type { AppPaths } from "../config/paths.js";

export interface AuditQuery {
  correlationId?: string;
  family?: string;
  limit: number;
}

/**
 * Append-only audit log, partitioned by UTC day.
 *
 * Every governed action ends in an audit record: sign-in, consent, tool side
 * effects, skill approvals, scheduled runs and sub-agent dispatch.
 *
 * The log is never rewritten. Retention and export are handled downstream; this
 * class only guarantees that a record, once written, stays written.
 */
export class AuditLog {
  constructor(private readonly paths: AppPaths) {}

  private fileFor(date: Date): string {
    return join(this.paths.audit, `${date.toISOString().slice(0, 10)}.jsonl`);
  }

  async record(input: {
    actor: AuditActor;
    action: string;
    family: string;
    outcome: AuditRecord["outcome"];
    correlationId: string;
    scopes?: string[];
    resources?: string[];
    reason?: string;
  }): Promise<AuditRecord> {
    const now = new Date();
    const record = AuditRecord.parse({
      id: newAuditId(),
      at: now.toISOString(),
      actor: input.actor,
      action: input.action,
      family: input.family,
      outcome: input.outcome,
      correlationId: input.correlationId,
      scopes: input.scopes ?? [],
      resources: input.resources ?? [],
      reason: input.reason ?? "",
    });
    await appendJsonl(this.fileFor(now), [record]);
    return record;
  }

  /** Read back recent records, newest first. Scans at most `days` daily files. */
  async query(query: AuditQuery, days = 30): Promise<AuditRecord[]> {
    const results: AuditRecord[] = [];
    const cursor = new Date();

    for (let day = 0; day < days && results.length < query.limit; day += 1) {
      const raw = await readJsonl(this.fileFor(cursor));
      for (let index = raw.length - 1; index >= 0; index -= 1) {
        const parsed = AuditRecord.safeParse(raw[index]);
        if (!parsed.success) continue;
        const record = parsed.data;
        if (query.correlationId && record.correlationId !== query.correlationId) continue;
        if (query.family && record.family !== query.family) continue;
        results.push(record);
        if (results.length >= query.limit) break;
      }
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }

    return results;
  }
}
