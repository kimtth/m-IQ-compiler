import { MemoryRecord } from "@iq/shared";

/**
 * The demo memory set.
 *
 * Why this exists at all: a memory is not part of a project. It lives in the
 * app's own store, so loading the sample project brings none with it, and a
 * fresh install shows an empty IQ Memories with nothing to demonstrate. The
 * only way to see the surface work was to talk to the agent until it proposed
 * something, which is not a demo.
 *
 * Why it is a fixed constant rather than an import path: the renderer can ask
 * for *this* set and nothing else. There is no channel that lets the UI, or an
 * agent driving it, write memory content of its own choosing — that would be a
 * side door around the review the feature exists for.
 *
 * Two arrive as proposals — one project-scoped, one user-scoped — so the
 * review step is visible without turning the pane into a queue nobody will work
 * through. The other seven arrive settled, six approved and one rejected, so
 * the settled list and the Compile path are reachable without an Entra sign-in,
 * which real approval requires. Those eight carry a `decidedBy` of
 * `sample-data` rather than a plausible object id: no person decided them, and
 * the audit trail should not imply one.
 *
 * All three durable memory types appear, because a pill nothing exercises is a
 * pill nobody trusts: most of the set is `procedural` (this is a project of
 * conventions), three are `factual`, and exactly one is `episodic` — a
 * rejected one-off observation, which is episodic and refused for the same
 * reason.
 *
 * Every citation names a note that exists in `sample-data/demo-project`.
 */

const SAMPLE_DECIDER = { oid: "sample-data", tenantId: "sample-data" } as const;

export const SAMPLE_MEMORY_ID_PREFIX = "mem_sample_";

/** Ids are fixed so loading twice adds nothing and a tester can spot them. */
export const SAMPLE_MEMORIES: readonly MemoryRecord[] = Object.freeze(
  [
    {
      id: "mem_sample_01",
      subject: "how we name project changes",
      fact:
        "Project changes use the format CHANGE-#### everywhere — messages, updates and meeting notes. Never write 'change request 2214' or 'CHANGE2214'.",
      rationale: "Three spellings were in use, so searching for one change missed most of its history.",
      citations: ["knowledge/projects/customer-portal.md"],
      scope: "project",
      status: "approved",
      memoryType: "factual",
      toolFamilies: ["project.read"],
      sourceSessionId: "ses_sample_a",
      sourceTurnId: "trn_sample_a1",
      createdAt: "2026-06-02T09:14:00.000Z",
      updatedAt: "2026-06-02T11:02:00.000Z",
      decidedBy: SAMPLE_DECIDER,
      decidedAt: "2026-06-02T11:02:00.000Z",
      derivedSkill: null,
    },
    {
      id: "mem_sample_02",
      subject: "what never goes in a customer update",
      fact:
        "A customer update never names an individual, never quotes an unapproved cost, and never states a cause the team has not checked. Describe what happened and the next step only.",
      rationale: "A draft named a person before the review was complete, which would have created an avoidable problem.",
      citations: ["knowledge/issues/customer-concern.md", "knowledge/policies/customer-updates.md"],
      scope: "project",
      status: "approved",
      memoryType: "procedural",
      toolFamilies: ["project.read", "project.write"],
      sourceSessionId: "ses_sample_b",
      sourceTurnId: "trn_sample_b3",
      createdAt: "2026-06-09T14:41:00.000Z",
      updatedAt: "2026-06-10T08:20:00.000Z",
      decidedBy: SAMPLE_DECIDER,
      decidedAt: "2026-06-10T08:20:00.000Z",
      derivedSkill: null,
    },
    {
      id: "mem_sample_03",
      subject: "which contract terms need legal review",
      fact:
        "Any contract term about ownership, liability limits or exclusivity goes to legal before it is shared outside the organisation. Price and delivery dates do not.",
      rationale: "Two drafts included exclusivity language that nobody had reviewed.",
      citations: ["knowledge/partners/bright-path.md", "knowledge/policies/contract-checks.md"],
      scope: "project",
      status: "approved",
      memoryType: "procedural",
      toolFamilies: ["project.read"],
      sourceSessionId: "ses_sample_c",
      sourceTurnId: "trn_sample_c2",
      createdAt: "2026-06-15T10:05:00.000Z",
      updatedAt: "2026-06-15T16:33:00.000Z",
      decidedBy: SAMPLE_DECIDER,
      decidedAt: "2026-06-15T16:33:00.000Z",
      derivedSkill: null,
    },
    {
      id: "mem_sample_04",
      subject: "review evidence must be dated",
      fact:
        "Every item used in a review carries its date and source. Evidence without both is treated as missing, not as complete.",
      rationale: "A review pack was assembled from undated reports and had to be rebuilt.",
      citations: ["knowledge/processes/check-completed-work.md"],
      scope: "project",
      status: "approved",
      memoryType: "factual",
      toolFamilies: ["project.read"],
      sourceSessionId: "ses_sample_d",
      sourceTurnId: "trn_sample_d1",
      createdAt: "2026-06-18T08:12:00.000Z",
      updatedAt: "2026-06-18T09:40:00.000Z",
      decidedBy: SAMPLE_DECIDER,
      decidedAt: "2026-06-18T09:40:00.000Z",
      derivedSkill: null,
    },
    {
      id: "mem_sample_05",
      subject: "source text is quoted before it is judged",
      fact:
        "When assessing a written rule, quote the relevant text before saying how it applies. Do not judge a shortened summary as if it were the source.",
      rationale: "A summary dropped an exception and the conclusion was wrong.",
      citations: ["knowledge/policies/contract-checks.md"],
      scope: "project",
      status: "pending",
      memoryType: "procedural",
      toolFamilies: ["project.read"],
      sourceSessionId: "ses_sample_d",
      sourceTurnId: "trn_sample_d4",
      createdAt: "2026-07-21T11:26:00.000Z",
      updatedAt: "2026-07-21T11:26:00.000Z",
      decidedBy: null,
      decidedAt: null,
      derivedSkill: null,
    },
    {
      id: "mem_sample_06",
      subject: "unverified public feedback",
      fact:
        "Public feedback is marked unverified until it is confirmed by a direct customer record. Never count it as verified evidence in a cost estimate.",
      rationale: "Public comments were briefly reported as confirmed requests in a leadership update.",
      citations: ["knowledge/issues/customer-concern.md"],
      scope: "project",
      status: "approved",
      memoryType: "procedural",
      toolFamilies: ["web.read"],
      sourceSessionId: "ses_sample_e",
      sourceTurnId: "trn_sample_e2",
      createdAt: "2026-07-23T15:03:00.000Z",
      updatedAt: "2026-07-23T16:47:00.000Z",
      decidedBy: SAMPLE_DECIDER,
      decidedAt: "2026-07-23T16:47:00.000Z",
      derivedSkill: null,
    },
    {
      id: "mem_sample_07",
      subject: "how the leadership update opens",
      fact:
        "The Monday leadership update opens with what changed since last week, then what is at risk, then what needs a decision. Never open with a status table.",
      rationale: "Readers stopped at the table and missed the asks.",
      citations: ["knowledge/projects/customer-portal.md"],
      scope: "project",
      status: "approved",
      memoryType: "procedural",
      toolFamilies: ["project.write"],
      sourceSessionId: "ses_sample_a",
      sourceTurnId: "trn_sample_a7",
      createdAt: "2026-07-24T07:48:00.000Z",
      updatedAt: "2026-07-24T10:15:00.000Z",
      decidedBy: SAMPLE_DECIDER,
      decidedAt: "2026-07-24T10:15:00.000Z",
      derivedSkill: null,
    },
    {
      id: "mem_sample_08",
      subject: "my working hours",
      fact:
        "Prefers unattended runs scheduled outside 09:00-18:00 Asia/Seoul, so a failure is not competing for attention with live work.",
      rationale: "Stated when setting up the first scheduled job.",
      citations: ["quoted by the user"],
      scope: "user",
      status: "pending",
      memoryType: "factual",
      toolFamilies: [],
      sourceSessionId: "ses_sample_f",
      sourceTurnId: "trn_sample_f1",
      createdAt: "2026-07-28T09:02:00.000Z",
      updatedAt: "2026-07-28T09:02:00.000Z",
      decidedBy: null,
      decidedAt: null,
      derivedSkill: null,
    },
    {
      id: "mem_sample_09",
      subject: "one-off review result",
      fact:
        "One successful review can be treated as proof that the whole process works without checking other weeks.",
      rationale: "Proposed after one analysis, but the result was specific to that week.",
      citations: ["knowledge/issues/repeated-error.md"],
      scope: "project",
      status: "rejected",
      // The one episode in the set, and the reason the distinction earns its
      // place: this was true of one week's result and of nothing else. A
      // record that reads like a convention but is really an observation from
      // a single run is exactly what must not be compiled into a standing
      // rule — which is why it is also the one that was refused.
      memoryType: "episodic",
      toolFamilies: ["project.read"],
      sourceSessionId: "ses_sample_g",
      sourceTurnId: "trn_sample_g5",
      createdAt: "2026-07-14T10:31:00.000Z",
      updatedAt: "2026-07-14T17:12:00.000Z",
      decidedBy: SAMPLE_DECIDER,
      decidedAt: "2026-07-14T17:12:00.000Z",
      derivedSkill: null,
    },
    // Parsed here rather than trusted: these go straight into the store, and a
    // record the loader has to skip is a demo step that silently does nothing.
  ].map((entry) => MemoryRecord.parse(entry)),
);

/** True for anything this module put in the store. */
export const isSampleMemory = (id: string): boolean => id.startsWith(SAMPLE_MEMORY_ID_PREFIX);
