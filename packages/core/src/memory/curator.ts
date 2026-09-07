import { createHash } from "node:crypto";
import {
  SKILL_NAME_PATTERN,
  type MemoryDerivationOutcome,
  type MemoryRecord,
  type SkillProposal,
} from "@iq/shared";
import { SingleFlight } from "../util/lock.js";
import type { MemoryStore } from "./store.js";
import type { SkillStore } from "../skills/store.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { TenantPolicy } from "../policy/tenant-policy.js";
import type { Logger } from "../util/logger.js";

/**
 * Skill curator: compiles approved memories into skill proposals.
 *
 * Approved memories can compile into skill proposals, but the derivation rules
 * are deliberately conservative:
 *
 *  - Only `approved` memories are eligible. A pending or rejected claim can
 *    never reach the prompt surface, even indirectly.
 *  - A subject must accumulate at least `minMemoriesPerDerivedSkill` approved
 *    facts before it compiles, so one offhand remark does not become a skill.
 *  - The output is a *proposal*, not a skill. It still needs the same human
 *    approval as anything the agent writes by hand, so automation shortens the
 *    authoring step and never the review step.
 *  - Derivation is idempotent: an unchanged set of memories produces the same
 *    signature and is skipped, so approving a tenth memory does not re-queue
 *    nine unchanged proposals.
 *  - Derived names are prefixed, so a compiled skill can never silently shadow
 *    a bundled or hand-written one of the same name.
 */

/** Prefix that marks a skill as machine-compiled from memories. */
export const DERIVED_SKILL_PREFIX = "learned";

export interface CuratorDeps {
  memories: MemoryStore;
  skills: SkillStore;
  policy: TenantPolicy;
  audit: AuditLog;
  logger: Logger;
  /** Correlation id factory for passes not triggered by a user request. */
  correlationId: () => string;
}

export class SkillCurator {
  private readonly single = new SingleFlight();

  constructor(private readonly deps: CuratorDeps) {}

  /** True when tenant policy permits compiling memories into proposals. */
  get enabled(): boolean {
    return (
      this.deps.policy.allowAgentAuthoredSkills && this.deps.policy.allowAutomaticSkillDerivation
    );
  }

  /**
   * Run one derivation pass over every approved memory.
   *
   * Safe to call on every approval and on boot: overlapping calls are dropped
   * rather than queued, and an unchanged corpus produces no proposals.
   */
  async run(correlationId = this.deps.correlationId()): Promise<MemoryDerivationOutcome[]> {
    const outcome = await this.single.run("curate", () => this.pass(correlationId));
    return outcome ?? [];
  }

  private async pass(correlationId: string): Promise<MemoryDerivationOutcome[]> {
    const approved = await this.deps.memories.list({ status: "approved" });
    const groups = groupBySubject(approved);
    const threshold = this.deps.policy.minMemoriesPerDerivedSkill;
    const eligible = [...groups.values()].filter((group) => group.memories.length >= threshold);

    if (eligible.length === 0) return [];

    if (!this.enabled) {
      // Recorded once per pass, not per group: the interesting fact is that
      // material existed and policy stopped it.
      await this.deps.audit.record({
        actor: { kind: "system" },
        action: "memory.derive",
        family: "memory",
        outcome: "denied",
        correlationId,
        resources: eligible.map((group) => derivedSkillName(group.slug)),
        reason: this.deps.policy.allowAgentAuthoredSkills
          ? "automatic skill derivation is disabled by tenant policy"
          : "agent-authored skills are disabled by tenant policy",
      });
      return [];
    }

    const outcomes: MemoryDerivationOutcome[] = [];

    for (const group of eligible) {
      const skillName = derivedSkillName(group.slug);
      if (!SKILL_NAME_PATTERN.test(skillName)) {
        this.deps.logger.warn("skipping memory subject with no usable slug", {
          subject: group.subject,
        });
        continue;
      }

      const signature = derivationSignature(group.memories);
      const previous = await this.deps.memories.derivationFor(group.slug);
      if (previous?.signature === signature) continue;

      const revision = (previous?.revision ?? 0) + 1;
      const proposal = composeSkillProposal(group.subject, skillName, group.memories, revision);

      try {
        await this.deps.skills.propose(proposal, correlationId);
      } catch (error) {
        // A single bad group must not stop the rest of the pass.
        this.deps.logger.warn("memory-derived proposal rejected", {
          skill: skillName,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      await this.deps.memories.recordDerivation({
        slug: group.slug,
        subject: group.subject,
        skillName,
        signature,
        memoryIds: group.memories.map((memory) => memory.id),
        derivedAt: new Date().toISOString(),
        revision,
      });

      await this.deps.audit.record({
        actor: { kind: "system" },
        action: "memory.derive",
        family: "memory",
        outcome: "succeeded",
        correlationId,
        resources: [skillName, ...group.memories.map((memory) => memory.id)],
        reason: `compiled ${group.memories.length} approved memories about "${group.subject}" into revision ${revision}`,
      });

      outcomes.push({
        slug: group.slug,
        skillName,
        memoryIds: group.memories.map((memory) => memory.id),
        revision,
        change: previous ? "updated" : "created",
      });
    }

    if (outcomes.length > 0) {
      this.deps.logger.info("derived skill proposals from approved memories", {
        count: outcomes.length,
      });
    }

    return outcomes;
  }
}

interface MemoryGroup {
  slug: string;
  subject: string;
  memories: MemoryRecord[];
}

/**
 * Group approved memories by the slug of their subject, so "Status reports" and
 * "status-reports" compile into one skill rather than two near-duplicates.
 */
export function groupBySubject(memories: readonly MemoryRecord[]): Map<string, MemoryGroup> {
  const groups = new Map<string, MemoryGroup>();
  for (const memory of memories) {
    const slug = slugifySubject(memory.subject);
    if (slug === "") continue;
    const existing = groups.get(slug);
    if (existing) existing.memories.push(memory);
    else groups.set(slug, { slug, subject: memory.subject, memories: [memory] });
  }
  // Oldest first, so the compiled skill reads in the order the user taught it.
  for (const group of groups.values()) {
    group.memories.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return groups;
}

/** Agent Skills slug rules: lowercase alphanumerics separated by single hyphens. */
export function slugifySubject(subject: string): string {
  return subject
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

export function derivedSkillName(slug: string): string {
  return `${DERIVED_SKILL_PREFIX}-${slug}`;
}

/**
 * Digest of exactly what produced a proposal.
 *
 * Includes each memory's `updatedAt` so that re-approving an edited fact counts
 * as a change, and is order-independent so that listing order cannot cause a
 * spurious re-derivation.
 */
export function derivationSignature(memories: readonly MemoryRecord[]): string {
  const material = memories
    .map((memory) => `${memory.id}@${memory.updatedAt}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/**
 * Render a group of memories as an Agent Skills proposal.
 *
 * The description is the only text always in context, so it names the subject
 * and says when to apply it. The body quotes each fact verbatim with its source
 * turn, which is what lets a reviewer check a compiled skill against what they
 * actually said.
 */
export function composeSkillProposal(
  subject: string,
  skillName: string,
  memories: readonly MemoryRecord[],
  revision: number,
): SkillProposal {
  const newest = memories.reduce((latest, memory) =>
    memory.updatedAt > latest.updatedAt ? memory : latest,
  );
  const allowedTools = [...new Set(memories.flatMap((memory) => memory.toolFamilies))].sort();
  const scopes = [...new Set(memories.map((memory) => memory.scope))].sort();

  const description =
    `Apply the user's confirmed conventions about ${subject}. Use whenever a task touches ${subject}; ` +
    `compiled from ${memories.length} approved ${memories.length === 1 ? "memory" : "memories"}.`;

  const lines: string[] = [
    `# ${titleCase(subject)}`,
    "",
    `Compiled automatically from ${memories.length} approved ${
      memories.length === 1 ? "memory" : "memories"
    } (revision ${revision}). Every rule below was confirmed by a person; nothing here was inferred without approval.`,
    "",
    "## Rules",
    "",
  ];

  for (const memory of memories) {
    lines.push(`- ${memory.fact}`);
    const notes: string[] = [`scope: ${memory.scope}`, `memory: ${memory.id}`];
    if (memory.citations.length > 0) notes.push(`source: ${memory.citations.join("; ")}`);
    lines.push(`  - _${notes.join(" · ")}_`);
  }

  lines.push(
    "",
    "## When this does not apply",
    "",
    "- The user contradicts a rule in the current conversation. Follow the user and propose an updated memory.",
    "- The rule would require a tool or permission this session does not have. Ask instead of working around it.",
    "",
    "## Provenance",
    "",
    `- Subject: ${subject}`,
    `- Scopes: ${scopes.join(", ")}`,
    `- Latest contributing memory: ${newest.id} (${newest.updatedAt})`,
  );

  return {
    name: skillName,
    description: description.slice(0, 1024),
    body: `${lines.join("\n")}\n`,
    allowedTools,
    sourceSessionId: newest.sourceSessionId,
    sourceTurnId: newest.sourceTurnId,
    rationale:
      `Automatically compiled from ${memories.length} approved ${
        memories.length === 1 ? "memory" : "memories"
      } about "${subject}". Review the quoted rules before approving; approving makes them loadable.`,
  };
}

function titleCase(value: string): string {
  return value.replace(/\b[a-z]/g, (character) => character.toUpperCase());
}
