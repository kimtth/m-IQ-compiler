import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuditLog,
  DEFAULT_TENANT_POLICY,
  MemoryStore,
  SkillCurator,
  SkillStore,
  composeSkillProposal,
  createLogger,
  derivationSignature,
  ensureAppPaths,
  resolveAppPaths,
  slugifySubject,
  type AppPaths,
} from "@iq/core";
import { SKILL_NAME_PATTERN, type MemoryRecord } from "@iq/shared";

/**
 * Automatic derivation is the one place where the agent's own claims can shape
 * future behaviour without a person typing anything, so the properties worth
 * pinning are the safety ones: only approved memories count, a subject needs
 * enough evidence before it compiles, the output is a proposal rather than a
 * live skill, and re-running the pass over an unchanged corpus is a no-op.
 */

const at = (day: number): string => `2026-01-0${day}T00:00:00.000Z`;

const memory = (overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: "mem_1",
  subject: "status reports",
  fact: "Send the weekly status on Friday morning.",
  rationale: "stated by the user",
  citations: ['User input: "always on Friday"'],
  scope: "user",
  status: "approved",
  toolFamilies: ["m365.mail"],
  sourceSessionId: "ses_1",
  sourceTurnId: "trn_1",
  createdAt: at(1),
  updatedAt: at(1),
  decidedBy: { oid: "oid-1", tenantId: "tid-1" },
  decidedAt: at(1),
  derivedSkill: null,
  ...overrides,
});

describe("slugifySubject", () => {
  it("folds spacing and casing so one subject is one skill", () => {
    expect(slugifySubject("Status Reports")).toBe("status-reports");
    expect(slugifySubject("  status   reports  ")).toBe("status-reports");
  });

  it("produces a name the Agent Skills spec accepts", () => {
    const name = `learned-${slugifySubject("Mail Triage & Follow-ups!")}`;
    expect(SKILL_NAME_PATTERN.test(name)).toBe(true);
  });

  it("returns empty for a subject with nothing usable in it", () => {
    expect(slugifySubject("!!!")).toBe("");
  });
});

describe("derivationSignature", () => {
  it("ignores ordering, so listing order cannot trigger a re-derivation", () => {
    const a = memory({ id: "mem_a" });
    const b = memory({ id: "mem_b" });
    expect(derivationSignature([a, b])).toBe(derivationSignature([b, a]));
  });

  it("changes when a memory is edited and re-approved", () => {
    const before = memory();
    const after = memory({ updatedAt: at(2) });
    expect(derivationSignature([before])).not.toBe(derivationSignature([after]));
  });

  it("changes when a memory joins the group", () => {
    const one = memory({ id: "mem_a" });
    const two = memory({ id: "mem_b" });
    expect(derivationSignature([one])).not.toBe(derivationSignature([one, two]));
  });
});

describe("composeSkillProposal", () => {
  const memories = [
    memory({ id: "mem_a", fact: "Send the weekly status on Friday morning." }),
    memory({ id: "mem_b", fact: "Keep the status under ten bullet points.", updatedAt: at(2), toolFamilies: ["m365.files"] }),
  ];
  const proposal = composeSkillProposal("status reports", "learned-status-reports", memories, 1);

  it("quotes every fact so a reviewer can check it against what they said", () => {
    for (const entry of memories) {
      expect(proposal.body).toContain(entry.fact);
      expect(proposal.body).toContain(entry.id);
    }
  });

  it("carries the union of the tool families the memories imply", () => {
    expect(proposal.allowedTools).toEqual(["m365.files", "m365.mail"]);
  });

  it("attributes the proposal to the most recent contributing turn", () => {
    expect(proposal.sourceTurnId).toBe("trn_1");
    expect(proposal.description).toContain("status reports");
  });
});

describe("SkillCurator", () => {
  let root: string;
  let paths: AppPaths;
  let memories: MemoryStore;
  let skills: SkillStore;

  const approver = { oid: "oid-1", tenantId: "tid-1" };
  const policy = { ...DEFAULT_TENANT_POLICY, minMemoriesPerDerivedSkill: 2 };

  const build = (overrides: Partial<typeof policy> = {}): SkillCurator => {
    const effective = { ...policy, ...overrides };
    const audit = new AuditLog(paths);
    const logger = createLogger("error", {});
    memories = new MemoryStore(paths, audit, logger);
    skills = new SkillStore(paths, audit, effective, logger, join(root, "bundled"));
    return new SkillCurator({
      memories,
      skills,
      policy: effective,
      audit,
      logger,
      correlationId: () => "cor_test",
    });
  };

  const capture = async (fact: string, subject = "status reports"): Promise<string> => {
    const record = await memories.record(
      {
        subject,
        fact,
        rationale: "taught by the user",
        citations: [],
        scope: "user",
        toolFamilies: [],
        sourceSessionId: "ses_1",
        sourceTurnId: "trn_1",
      },
      "cor_test",
    );
    return record.id;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "iq-curator-"));
    paths = resolveAppPaths(root);
    ensureAppPaths(paths);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("ignores memories a human has not approved", async () => {
    const curator = build();
    await capture("Send the status on Friday.");
    await capture("Keep it under ten bullets.");

    expect(await curator.run()).toEqual([]);
    expect(await skills.listProposals()).toEqual([]);
  });

  it("waits until a subject has enough approved evidence", async () => {
    const curator = build();
    const first = await capture("Send the status on Friday.");
    await memories.approve(first, approver, "cor_test");

    expect(await curator.run()).toEqual([]);

    const second = await capture("Keep it under ten bullets.");
    await memories.approve(second, approver, "cor_test");

    const derived = await curator.run();
    expect(derived).toHaveLength(1);
    expect(derived[0]?.skillName).toBe("learned-status-reports");
    expect(derived[0]?.change).toBe("created");
  });

  it("produces a proposal, never a loadable skill", async () => {
    const curator = build();
    for (const fact of ["Send the status on Friday.", "Keep it under ten bullets."]) {
      const id = await capture(fact);
      await memories.approve(id, approver, "cor_test");
    }
    await curator.run();

    const proposals = await skills.listProposals();
    expect(proposals.map((entry) => entry.name)).toEqual(["learned-status-reports"]);

    // The skill exists only as a pending review, and is excluded from the set
    // the runtime is allowed to load.
    const records = await skills.list();
    expect(records.find((entry) => entry.name === "learned-status-reports")).toBeUndefined();
    const config = await skills.resolveSessionSkillConfig();
    expect(config.disabled).not.toContain("learned-status-reports");
  });

  it("is idempotent: an unchanged corpus produces nothing on a second pass", async () => {
    const curator = build();
    for (const fact of ["Send the status on Friday.", "Keep it under ten bullets."]) {
      const id = await capture(fact);
      await memories.approve(id, approver, "cor_test");
    }

    expect(await curator.run()).toHaveLength(1);
    expect(await curator.run()).toEqual([]);
  });

  it("recompiles at a higher revision when a new memory is approved", async () => {
    const curator = build();
    for (const fact of ["Send the status on Friday.", "Keep it under ten bullets."]) {
      const id = await capture(fact);
      await memories.approve(id, approver, "cor_test");
    }
    await curator.run();

    const third = await capture("Copy the leadership alias.");
    await memories.approve(third, approver, "cor_test");

    const derived = await curator.run();
    expect(derived).toHaveLength(1);
    expect(derived[0]?.change).toBe("updated");
    expect(derived[0]?.revision).toBe(2);
    expect(derived[0]?.memoryIds).toHaveLength(3);
  });

  it("keeps unrelated subjects in separate skills", async () => {
    const curator = build();
    for (const fact of ["Send the status on Friday.", "Keep it under ten bullets."]) {
      const id = await capture(fact);
      await memories.approve(id, approver, "cor_test");
    }
    for (const fact of ["Archive newsletters unread.", "Flag anything from the CFO."]) {
      const id = await capture(fact, "mail triage");
      await memories.approve(id, approver, "cor_test");
    }

    const derived = await curator.run();
    expect(derived.map((entry) => entry.skillName).sort()).toEqual([
      "learned-mail-triage",
      "learned-status-reports",
    ]);
  });

  it("derives nothing when tenant policy forbids it", async () => {
    const curator = build({ allowAutomaticSkillDerivation: false });
    for (const fact of ["Send the status on Friday.", "Keep it under ten bullets."]) {
      const id = await capture(fact);
      await memories.approve(id, approver, "cor_test");
    }

    expect(curator.enabled).toBe(false);
    expect(await curator.run()).toEqual([]);
    expect(await skills.listProposals()).toEqual([]);
  });

  it("stamps contributing memories with the skill they were compiled into", async () => {
    const curator = build();
    for (const fact of ["Send the status on Friday.", "Keep it under ten bullets."]) {
      const id = await capture(fact);
      await memories.approve(id, approver, "cor_test");
    }
    await curator.run();

    const approved = await memories.list({ status: "approved" });
    expect(approved.every((entry) => entry.derivedSkill === "learned-status-reports")).toBe(true);
  });

  it("does not re-queue an identical fact twice", async () => {
    build();
    const first = await capture("Send the status on Friday.");
    const again = await capture("send the status on friday.");
    expect(again).toBe(first);
    expect(await memories.list()).toHaveLength(1);
  });

  /**
   * Editing is the one way an approved claim can change without a new decision,
   * so the rule that an edit costs the approval is pinned here rather than left
   * to the UI. Approved memories are exactly what the curator compiles into
   * skills; without this, edited wording would reach a prompt surface on the
   * strength of a signature given for different wording.
   */
  it("returns an edited approved memory to review, and drops it from derivation", async () => {
    const curator = build();
    const first = await capture("Send the status on Friday.");
    const second = await capture("Keep it under ten bullets.");
    await memories.approve(first, approver, "cor_test");
    await memories.approve(second, approver, "cor_test");
    await curator.run();

    const edited = await memories.update(
      {
        id: first,
        subject: "status reports",
        fact: "Send the status on Thursday.",
        rationale: "the meeting moved",
      },
      "cor_test",
      approver,
    );

    expect(edited.fact).toBe("Send the status on Thursday.");
    expect(edited.status).toBe("pending");
    expect(edited.decidedBy).toBeNull();
    expect(edited.decidedAt).toBeNull();
    // The proposal it fed was built from the old wording, so the link is stale.
    expect(edited.derivedSkill).toBeNull();
    expect((await memories.list({ status: "approved" })).map((row) => row.id)).toEqual([second]);
  });

  it("keeps the status of a memory that was never approved", async () => {
    build();
    const id = await capture("Send the status on Friday.");
    const edited = await memories.update(
      { id, subject: "status reports", fact: "Send it on Thursday.", rationale: "" },
      "cor_test",
    );
    // Nothing to invalidate: no approval was ever attached to this claim.
    expect(edited.status).toBe("pending");
  });

  it("treats an edit that changes nothing as a no-op, keeping the approval", async () => {
    build();
    const id = await capture("Send the status on Friday.");
    await memories.approve(id, approver, "cor_test");

    const same = await memories.update(
      {
        id,
        subject: "status reports",
        fact: "Send the status on Friday.",
        rationale: "taught by the user",
      },
      "cor_test",
      approver,
    );

    // Opening the editor and pressing Save must not cost an approval.
    expect(same.status).toBe("approved");
    expect(same.decidedBy).toEqual(approver);
  });
});
