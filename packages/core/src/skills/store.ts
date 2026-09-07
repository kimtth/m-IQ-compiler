import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SkillProposal,
  SKILL_NAME_PATTERN,
  type SkillExportResult,
  type SkillImportPreview,
  type SkillRecord,
  type SkillReviewState,
} from "@iq/shared";
import { readJson, writeJsonAtomic } from "../util/jsonl.js";
import { discoverSkills, serializeSkillMarkdown } from "./loader.js";
import { exportBundle, inspectBundle, installBundle } from "./transfer.js";
import type { AppPaths } from "../config/paths.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { TenantPolicy } from "../policy/tenant-policy.js";
import type { Logger } from "../util/logger.js";

/**
 * Skill store and lifecycle.
 *
 * The store tracks agent-created skills through review, archive, restore, pin,
 * backup and rollback. Bundled skills are installed locally on startup, and
 * enabled skills are injected into the system prompt.
 *
 * Agent-authored skills deliberately stay unloadable until a human approves
 * them. Promotion from memory into skill has its own approval workflow so the
 * audit trail can show who accepted that behaviour.
 */

interface SkillState {
  enabled: Record<string, boolean>;
  review: Record<string, SkillReviewState>;
}

const EMPTY_STATE: SkillState = { enabled: {}, review: {} };

export class SkillStore {
  private state: SkillState = EMPTY_STATE;
  private loaded = false;

  constructor(
    private readonly paths: AppPaths,
    private readonly audit: AuditLog,
    private readonly policy: TenantPolicy,
    private readonly logger: Logger,
    /** Directory of skills that ship with the product. */
    private readonly bundledDir: string,
  ) {}

  private get stateFile(): string {
    return join(this.paths.config, "skills-state.json");
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.state = await readJson<SkillState>(this.stateFile, EMPTY_STATE);
    this.state.enabled ??= {};
    this.state.review ??= {};
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.stateFile, this.state);
  }

  /** All known skills: bundled first, then user- and agent-authored. */
  async list(): Promise<SkillRecord[]> {
    await this.ensureLoaded();

    const reviewOf = (name: string): SkillReviewState => this.state.review[name] ?? "approved";
    const enabledOf = (name: string): boolean => this.state.enabled[name] ?? true;

    const bundled = await discoverSkills(this.bundledDir, "bundled", () => "approved", enabledOf);
    const local = await discoverSkills(this.paths.skills, "user", reviewOf, enabledOf);

    for (const entry of [...bundled, ...local]) {
      if (entry.error) {
        this.logger.warn("skipping invalid skill", { name: entry.record.name, error: entry.error });
      }
    }

    const records = [...bundled, ...local].filter((entry) => !entry.error).map((entry) => entry.record);

    // A locally authored skill of the same name shadows a bundled one.
    const byName = new Map<string, SkillRecord>();
    for (const record of records) byName.set(record.name, record);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Directories the Copilot session may load skills from, plus the names to
   * disable. Only approved and enabled skills are loadable; everything else is
   * passed as a disabled name so the runtime does not surface it.
   */
  async resolveSessionSkillConfig(): Promise<{ directories: string[]; disabled: string[] }> {
    const records = await this.list();
    const disabled = records
      .filter((record) => !record.enabled || record.review !== "approved")
      .map((record) => record.name);
    return { directories: [this.bundledDir, this.paths.skills], disabled };
  }

  async setEnabled(name: string, enabled: boolean, correlationId: string): Promise<void> {
    await this.ensureLoaded();
    this.state.enabled[name] = enabled;
    await this.persist();
    await this.audit.record({
      actor: { kind: "system" },
      action: enabled ? "skill.enable" : "skill.disable",
      family: "skills",
      outcome: "succeeded",
      correlationId,
      resources: [name],
    });
  }

  // --- authoring from approved memories ------------------------------------

  private proposalFile(name: string): string {
    return join(this.paths.skillProposals, `${name}.json`);
  }

  /**
   * Record an agent-authored skill proposal.
   *
   * The proposal is written to a staging area, never to the live skill
   * directory, so a proposal can never take effect without the approval step.
   */
  async propose(proposal: SkillProposal, correlationId: string): Promise<void> {
    if (!this.policy.allowAgentAuthoredSkills) {
      await this.audit.record({
        actor: { kind: "agent", sessionId: proposal.sourceSessionId, turnId: proposal.sourceTurnId },
        action: "skill.propose",
        family: "skills",
        outcome: "denied",
        correlationId,
        resources: [proposal.name],
        reason: "agent-authored skills are disabled by tenant policy",
      });
      throw new Error("agent-authored skills are disabled by tenant policy");
    }

    const parsed = SkillProposal.parse(proposal);
    if (!SKILL_NAME_PATTERN.test(parsed.name)) {
      throw new Error(`invalid skill name "${parsed.name}"`);
    }

    await mkdir(this.paths.skillProposals, { recursive: true });
    await writeJsonAtomic(this.proposalFile(parsed.name), {
      ...parsed,
      proposedAt: new Date().toISOString(),
    });

    await this.ensureLoaded();
    this.state.review[parsed.name] = "pending_review";
    await this.persist();

    await this.audit.record({
      actor: { kind: "agent", sessionId: parsed.sourceSessionId, turnId: parsed.sourceTurnId },
      action: "skill.propose",
      family: "skills",
      outcome: "succeeded",
      correlationId,
      resources: [parsed.name],
      reason: parsed.rationale,
    });
  }

  async listProposals(): Promise<Array<SkillProposal & { proposedAt: string }>> {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(this.paths.skillProposals).catch(() => [] as string[]);
    const out: Array<SkillProposal & { proposedAt: string }> = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const raw = await readJson<unknown>(join(this.paths.skillProposals, file), null);
      if (!raw) continue;
      const parsed = SkillProposal.safeParse(raw);
      if (!parsed.success) continue;
      out.push({
        ...parsed.data,
        proposedAt: (raw as { proposedAt?: string }).proposedAt ?? new Date(0).toISOString(),
      });
    }
    return out;
  }

  /**
   * Promote a reviewed proposal into a loadable skill. This is the only path by
   * which agent-authored content becomes part of the prompt surface.
   */
  async approve(name: string, approver: { oid: string; tenantId: string }, correlationId: string): Promise<SkillRecord> {
    const raw = await readJson<unknown>(this.proposalFile(name), null);
    if (!raw) throw new Error(`no pending proposal named "${name}"`);
    const proposal = SkillProposal.parse(raw);

    const dir = join(this.paths.skills, proposal.name);
    await mkdir(dir, { recursive: true });

    const markdown = serializeSkillMarkdown(
      {
        name: proposal.name,
        description: proposal.description,
        ...(proposal.allowedTools.length > 0 ? { "allowed-tools": proposal.allowedTools } : {}),
      },
      proposal.body,
    );

    // Write-then-rename so a reader never observes a half-written SKILL.md.
    const temp = join(dir, `SKILL.md.${process.pid}.tmp`);
    await writeFile(temp, markdown, "utf8");
    await rename(temp, join(dir, "SKILL.md"));

    await this.ensureLoaded();
    this.state.review[proposal.name] = "approved";
    this.state.enabled[proposal.name] ??= true;
    await this.persist();

    await this.audit.record({
      actor: { kind: "user", oid: approver.oid, tenantId: approver.tenantId },
      action: "skill.approve",
      family: "skills",
      outcome: "succeeded",
      correlationId,
      resources: [proposal.name],
      reason: `promoted proposal from turn ${proposal.sourceTurnId}`,
    });

    const records = await this.list();
    const record = records.find((entry) => entry.name === proposal.name);
    if (!record) throw new Error(`approved skill "${proposal.name}" failed to load`);
    return record;
  }

  /** Archive keeps the files but makes the skill unloadable, so it can be restored. */
  async archive(name: string, correlationId: string): Promise<void> {
    await this.ensureLoaded();
    this.state.review[name] = "archived";
    this.state.enabled[name] = false;
    await this.persist();
    await this.audit.record({
      actor: { kind: "system" },
      action: "skill.archive",
      family: "skills",
      outcome: "succeeded",
      correlationId,
      resources: [name],
    });
  }

  // --- import and export ----------------------------------------------------

  /**
   * Look at a candidate bundle without installing it.
   *
   * Separating inspection from installation is the point of the feature: a
   * skill is prompt surface, so the user must be able to read what it declares
   * — above all which tool families it asks for — before anything is copied.
   */
  async inspectImport(source: string): Promise<SkillImportPreview> {
    const installed = new Set((await this.list()).map((record) => record.name));
    const bundle = await inspectBundle(source, (name) => installed.has(name));
    return bundle.preview;
  }

  /**
   * Install an inspected bundle.
   *
   * Installing is not enabling. The skill lands as `pending_review` and
   * disabled, so it takes a second, explicitly human act before its text can
   * reach the agent — the same rule agent-authored skills follow.
   */
  async importFrom(
    source: string,
    actor: { oid: string; tenantId: string },
    correlationId: string,
  ): Promise<SkillImportPreview> {
    const installed = new Set((await this.list()).map((record) => record.name));
    const bundle = await inspectBundle(source, (name) => installed.has(name));

    if (bundle.preview.problems.length > 0) {
      await this.audit.record({
        actor: { kind: "user", oid: actor.oid, tenantId: actor.tenantId },
        action: "skill.import",
        family: "skills",
        outcome: "denied",
        correlationId,
        resources: [bundle.preview.name],
        reason: bundle.preview.problems.join("; "),
      });
      throw new Error(`bundle is not a valid skill: ${bundle.preview.problems.join("; ")}`);
    }

    await mkdir(this.paths.skills, { recursive: true });
    await installBundle(bundle, bundle.files, this.paths.skills);

    await this.ensureLoaded();
    this.state.review[bundle.preview.name] = "pending_review";
    this.state.enabled[bundle.preview.name] = false;
    await this.persist();

    await this.audit.record({
      actor: { kind: "user", oid: actor.oid, tenantId: actor.tenantId },
      action: "skill.import",
      family: "skills",
      outcome: "succeeded",
      correlationId,
      resources: [bundle.preview.name],
      reason: `imported from ${bundle.preview.source}, pending review`,
    });

    return bundle.preview;
  }

  /**
   * Approve an installed-but-unreviewed skill.
   *
   * `approve` promotes a staged proposal; this promotes something already on
   * disk, which is the shape an import arrives in. Keeping them separate keeps
   * each audit record honest about what was actually reviewed.
   */
  async approveInstalled(
    name: string,
    approver: { oid: string; tenantId: string },
    correlationId: string,
  ): Promise<SkillRecord> {
    const records = await this.list();
    const record = records.find((entry) => entry.name === name);
    if (!record) throw new Error(`no installed skill named "${name}"`);

    await this.ensureLoaded();
    this.state.review[name] = "approved";
    this.state.enabled[name] = true;
    await this.persist();

    await this.audit.record({
      actor: { kind: "user", oid: approver.oid, tenantId: approver.tenantId },
      action: "skill.approve",
      family: "skills",
      outcome: "succeeded",
      correlationId,
      resources: [name],
      reason: `approved installed skill declaring tools: ${record.allowedTools.join(", ") || "none"}`,
    });

    return { ...record, review: "approved", enabled: true };
  }

  /** Write a skill out as a portable, specification-compliant directory. */
  async exportTo(
    name: string,
    destination: string,
    actor: { oid: string; tenantId: string },
    correlationId: string,
  ): Promise<SkillExportResult> {
    const record = (await this.list()).find((entry) => entry.name === name);
    if (!record) throw new Error(`no skill named "${name}"`);

    const result = await exportBundle(record.path, record.name, destination);

    await this.audit.record({
      actor: { kind: "user", oid: actor.oid, tenantId: actor.tenantId },
      action: "skill.export",
      family: "skills",
      outcome: "succeeded",
      correlationId,
      resources: [name],
      reason: `exported to ${result.destination}`,
    });

    return result;
  }

  /** Remove an imported or authored skill entirely. Bundled skills are not removable. */
  async remove(name: string, correlationId: string): Promise<void> {
    const record = (await this.list()).find((entry) => entry.name === name);
    if (!record) throw new Error(`no skill named "${name}"`);
    if (record.origin === "bundled") {
      throw new Error("bundled skills cannot be removed; disable it instead");
    }

    await rm(join(this.paths.skills, record.name), { recursive: true, force: true });

    await this.ensureLoaded();
    delete this.state.review[name];
    delete this.state.enabled[name];
    await this.persist();

    await this.audit.record({
      actor: { kind: "system" },
      action: "skill.remove",
      family: "skills",
      outcome: "succeeded",
      correlationId,
      resources: [name],
    });
  }
}
