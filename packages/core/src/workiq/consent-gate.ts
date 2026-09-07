import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../util/jsonl.js";
import type { AppPaths } from "../config/paths.js";
import type { AuditLog } from "../audit/audit-log.js";

/**
 * Work IQ consent gate.
 *
 * Work IQ requires both M365 sign-in and explicit EULA acceptance before tools
 * run. The consent gate denies calls until acceptance is recorded.
 *
 * Acceptance is recorded per user object id, per terms version, so that a new
 * terms version re-gates the capability rather than silently inheriting an old
 * acceptance.
 */

export const WORKIQ_TERMS_VERSION = "2026-01";

interface ConsentFile {
  acceptances: Array<{ oid: string; tenantId: string; version: string; acceptedAt: string }>;
}

export class WorkIqConsentGate {
  private cache: ConsentFile | null = null;

  constructor(
    private readonly paths: AppPaths,
    private readonly audit: AuditLog,
  ) {}

  private get file(): string {
    return join(this.paths.config, "workiq-consent.json");
  }

  private async load(): Promise<ConsentFile> {
    this.cache ??= await readJson<ConsentFile>(this.file, { acceptances: [] });
    return this.cache;
  }

  async hasAccepted(oid: string, version = WORKIQ_TERMS_VERSION): Promise<boolean> {
    const data = await this.load();
    return data.acceptances.some(
      (entry) => entry.oid === oid && entry.version === version,
    );
  }

  async accept(
    account: { oid: string; tenantId: string },
    correlationId: string,
    version = WORKIQ_TERMS_VERSION,
  ): Promise<void> {
    const data = await this.load();
    if (!data.acceptances.some((entry) => entry.oid === account.oid && entry.version === version)) {
      data.acceptances.push({
        oid: account.oid,
        tenantId: account.tenantId,
        version,
        acceptedAt: new Date().toISOString(),
      });
      await writeJsonAtomic(this.file, data);
    }

    await this.audit.record({
      actor: { kind: "user", oid: account.oid, tenantId: account.tenantId },
      action: "workiq.terms.accept",
      family: "workiq",
      outcome: "succeeded",
      correlationId,
      reason: `accepted Work IQ terms ${version}`,
    });
  }

  /** Throw unless the gate is open. Called before any Work IQ tool executes. */
  async assertOpen(oid: string | null, correlationId: string): Promise<void> {
    if (!oid) throw new Error("Work IQ requires an active Microsoft 365 sign-in");
    if (await this.hasAccepted(oid)) return;

    await this.audit.record({
      actor: { kind: "system" },
      action: "workiq.gate",
      family: "workiq",
      outcome: "denied",
      correlationId,
      reason: `Work IQ terms ${WORKIQ_TERMS_VERSION} not accepted`,
    });
    throw new Error(
      `Work IQ is unavailable until the terms (version ${WORKIQ_TERMS_VERSION}) are accepted.`,
    );
  }
}
