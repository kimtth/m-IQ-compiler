import type { DraftTurnEvent, SessionEvent, TurnEvent } from "@iq/shared";

/**
 * A worked project and the conversation that produced it.
 *
 * # Why this module exists
 *
 * The other five modules fill surfaces that are lists — memories, jobs, plans,
 * notes, cells. None of them fills the two surfaces a new user looks at first:
 * the thread and the canvas. A fresh install shows "Create a conversation to
 * begin" beside "No document under generation yet", which are accurate and
 * teach nothing. Neither can be filled by signing in, either, because both are
 * *outputs* — you get them by spending a turn, which costs tokens and needs an
 * identity the reader may not have yet.
 *
 * So this module ships the output: a project with files in it, a document the
 * canvas can render, and the conversation that would have produced them.
 *
 * # What is real and what is staged
 *
 * The project is real: a directory the registry created and bound, with files
 * actually written into it. The document is real too — OfficeCLI builds it
 * here, exactly as it would during a turn, so the preview renders a genuine
 * `.docx` rather than a picture of one.
 *
 * The conversation is staged. Its turn log is written directly rather than run,
 * because running it needs a model. That is why every turn carries the sample
 * agent id and a `model` of `sample-data`: anyone reading the log can see at a
 * glance that no model produced it. The same reason `SAMPLE_DECIDER` exists in
 * `memories.ts`.
 *
 * # Why it needs OfficeCLI
 *
 * The document is generated, not shipped as a binary blob in the source tree.
 * That keeps the repository free of a `.docx` nobody can review in a diff, and
 * it means the file the reader previews was built by the same tool the agent
 * uses. The cost is a hard dependency: without OfficeCLI this module refuses to
 * load and says so, the same way the knowledge module refuses when the graph is
 * off. A half-loaded project with an unreadable document would be worse.
 */

/** Fixed so loading twice adds nothing and clearing can only remove a sample. */
export const SAMPLE_PROJECT_NAME = "Checkout API release";
export const SAMPLE_SESSION_ID = "ses_sample_project";
const SAMPLE_TURN_PREFIX = "trn_sample_project_";

export const isSampleSession = (sessionId: string): boolean => sessionId === SAMPLE_SESSION_ID;

/**
 * The document the canvas renders.
 *
 * `create` gives a document a folder of its own, so the file lands at
 * `<name>/<name>.docx`. That is OfficeCLI's rule, not ours, and the stored path
 * has to match it or the preview opens nothing.
 */
export const SAMPLE_DOCUMENT_NAME = "Release readiness review.docx";
export const SAMPLE_DOCUMENT_PATH = `Release readiness review/${SAMPLE_DOCUMENT_NAME}`;

/**
 * The report body, as Markdown.
 *
 * OfficeCLI's `markdown` element expands a Markdown subset into ordinary Word
 * elements — headings, paragraphs, lists, tables — so the result is an editable
 * document rather than one block of text. Writing it this way means the content
 * is reviewable in a diff, which a `.docx` never is.
 */
export const SAMPLE_DOCUMENT_MARKDOWN = [
  "# Release readiness review",
  "",
  "Checkout API 26.2 · train leaves week 36 · prepared from the change tracker and",
  "the upstream escalation note held in this project.",
  "",
  "## Where the release stands",
  "",
  "| Area | Component | Change | Status | Owner |",
  "| --- | --- | --- | --- | --- |",
  "| Auth | nw-auth-sdk | CR-2214 | At risk | ravi |",
  "| Ledger | nw-ledger | CR-2251 | In validation | mei |",
  "| Charts | chart-kit | CR-2270 | In validation | ravi |",
  "| Payouts | payout-screen | CR-2263 | Merged | dana |",
  "| Secrets | nw-secrets | CR-2288 | Merged | mei |",
  "| Tracing | nw-trace | CR-2291 | Merged | dana |",
  "",
  "## Auth",
  "",
  "`nw-auth-sdk` 4.2 drops a token refresh under retry storms, so a request can be",
  "signed with a token that has already been rotated. Halbert Auth has accepted the",
  "finding and is cutting 4.3.",
  "",
  "Week 35 is the date for the **tagged release**, not for the fix in our build.",
  "Nothing in this project records an integration or a validation run, so there is",
  "no evidence that the fix is in a build before the train leaves in week 36.",
  "",
  "## Ledger and charts",
  "",
  "CR-2251 and CR-2270 are both in validation. Neither carries a finding. These are",
  "open items, not risks.",
  "",
  "## The decision that cannot wait",
  "",
  "Whether to fork `nw-auth-sdk`.",
  "",
  "- Holding a fork costs maintenance now, against a maintainer who may still",
  "  deliver.",
  "- Not holding one puts the train on a single-maintainer library hitting a date",
  "  it has already missed once.",
  "",
  "Owner: dana. Needed this week.",
  "",
].join("\n");

/** Plain files, so the navigator shows a project rather than one folder. */
export const SAMPLE_PROJECT_FILES: readonly { path: string; text: string }[] = [
  {
    path: "notes/upstream-escalation.md",
    text: [
      "# Halbert Auth — escalation, week 31",
      "",
      "`nw-auth-sdk` 4.2 drops a token refresh under retry storms, so a request can be",
      "signed with a token that has already been rotated. Halbert Auth has accepted the",
      "finding and is cutting 4.3. Their date for a tagged release is week 35, which is",
      "one week inside the release train and leaves no float.",
      "",
      "Dana owns the escalation. The decision needed this week is whether to fork the",
      "SDK or accept the single-maintainer risk to the train.",
      "",
    ].join("\n"),
  },
  {
    path: "data/change-status.csv",
    text: [
      "component,change,area,state,owner",
      "nw-auth-sdk,CR-2214,Token refresh race,At risk,ravi",
      "nw-ledger,CR-2251,Write path under retry storms,In validation,mei",
      "chart-kit,CR-2270,Upgrade for release 24.3,In validation,ravi",
      "payout-screen,CR-2263,Form validation,Merged,dana",
      "nw-secrets,CR-2288,Rotation window,Merged,mei",
      "nw-trace,CR-2291,Span attribute cleanup,Merged,dana",
      "",
    ].join("\n"),
  },
];

/**
 * The conversation, as it is written to the log.
 *
 * Two turns rather than one. A single question and answer photographs as a
 * search box; what makes a thread a thread is the second question landing on
 * the first one's answer, and the second turn here is only intelligible because
 * of what the first one built.
 */
interface SampleTurn {
  /** Suffix of the fixed turn id. */
  readonly id: string;
  readonly at: string;
  readonly events: readonly DraftTurnEvent[];
}

const AT_ONE = "2026-01-08T09:12:00.000Z";
const AT_TWO = "2026-01-08T09:19:00.000Z";

/** No model produced these, and the log says so rather than implying otherwise. */
const SNAPSHOT = {
  model: "sample-data",
  skills: [] as string[],
  toolFamilies: ["office", "knowledge"] as string[],
  mode: "cocreate",
  subMode: "office",
};

const ASSISTANT_ONE = [
  "I have written **Release readiness review.docx** into the project.",
  "",
  "Where the release stands, from the change tracker and the escalation note:",
  "",
  "- **Auth — at risk.** `nw-auth-sdk` 4.2 drops a token refresh under retry",
  "  storms. Halbert Auth have accepted the finding and are cutting 4.3, but their",
  "  date is week 35 against a week 36 train. There is no float.",
  "- **Ledger and charts — in validation.** CR-2251 and CR-2270 are both mid-run.",
  "  Neither has a finding against it.",
  "- **Everything else — merged.** Payouts, secrets and tracing are closed out.",
  "",
  "The one decision that cannot wait is whether to fork `nw-auth-sdk`. Holding a",
  "fork costs maintenance now; not holding one puts the train on a single-maintainer",
  "library hitting a date it has already missed once.",
].join("\n");

const ASSISTANT_TWO = [
  "Week 35 is their *tag* date, not the date it is in our build. The tracker records",
  "the change, and the escalation note records the commitment — neither records an",
  "integration or a validation run. So the honest answer is that nothing in the",
  "project shows the fix in a build before the train leaves.",
  "",
  "I have added that distinction to the report under **Auth**, because reading week",
  "35 as an in-build date is the mistake the summary was inviting.",
].join("\n");

const TURNS: readonly SampleTurn[] = [
  {
    id: "01",
    at: AT_ONE,
    events: [
      {
        type: "turn_created",
        sessionId: SAMPLE_SESSION_ID,
        agentId: "sample-data",
        snapshot: { ...SNAPSHOT, projectId: null },
        correlationId: "cor_sample_project_01",
      },
      {
        type: "user_message",
        content:
          "Read the change tracker and the escalation note, then write me a release " +
          "readiness review for the Checkout API. Say plainly which areas are at risk and why.",
        attachments: [],
      },
      {
        type: "tool_call_requested",
        request: {
          toolCallId: "tc_sample_project_01",
          toolName: "office_create_document",
          family: "office",
          risk: "write",
          summary: `Create a new Office document at ${SAMPLE_DOCUMENT_NAME}`,
          requiredScopes: [],
          resources: [SAMPLE_DOCUMENT_NAME],
        },
        args: { path: SAMPLE_DOCUMENT_NAME },
      },
      {
        type: "tool_call_completed",
        toolCallId: "tc_sample_project_01",
        toolName: "office_create_document",
        ok: true,
        result: { path: SAMPLE_DOCUMENT_PATH },
        untrusted: false,
      },
      {
        type: "tool_call_requested",
        request: {
          toolCallId: "tc_sample_project_02",
          toolName: "office_add_many",
          family: "office",
          risk: "write",
          summary: `Add 1 element to ${SAMPLE_DOCUMENT_PATH}`,
          requiredScopes: [],
          resources: [SAMPLE_DOCUMENT_PATH],
        },
        args: { path: SAMPLE_DOCUMENT_PATH, items: [{ target: "/body", type: "markdown" }] },
      },
      {
        type: "tool_call_completed",
        toolCallId: "tc_sample_project_02",
        toolName: "office_add_many",
        ok: true,
        result: { ok: true },
        untrusted: false,
      },
      { type: "assistant_message", content: ASSISTANT_ONE },
      { type: "turn_completed", usage: { inputTokens: 4_180, outputTokens: 610 } },
    ],
  },
  {
    id: "02",
    at: AT_TWO,
    events: [
      {
        type: "turn_created",
        sessionId: SAMPLE_SESSION_ID,
        agentId: "sample-data",
        snapshot: { ...SNAPSHOT, projectId: null },
        correlationId: "cor_sample_project_02",
      },
      {
        type: "user_message",
        content: "Week 35 — is that when the fix is in our build, or when they tag it?",
        attachments: [],
      },
      { type: "assistant_message", content: ASSISTANT_TWO },
      { type: "turn_completed", usage: { inputTokens: 5_020, outputTokens: 240 } },
    ],
  },
];

export const SAMPLE_TURN_COUNT = TURNS.length;

/**
 * Stamp the drafts with their ids, sequence and time.
 *
 * The project id is filled in here because it is not known until the registry
 * has created the directory, and a turn that claims a project it could not have
 * touched is exactly the kind of small lie this sample must not tell.
 */
export const sampleTurnLogs = (
  projectId: string,
): { turnId: string; at: string; events: TurnEvent[] }[] =>
  TURNS.map((turn) => {
    const turnId = `${SAMPLE_TURN_PREFIX}${turn.id}`;
    return {
      turnId,
      at: turn.at,
      events: turn.events.map((event, index) => {
        const stamped = { ...event, turnId, seq: index, at: turn.at } as TurnEvent;
        return stamped.type === "turn_created"
          ? { ...stamped, snapshot: { ...stamped.snapshot, projectId } }
          : stamped;
      }),
    };
  });

/** The session log: creation, the turns in order, and where the thread belongs. */
export const sampleSessionEvents = (turnIds: readonly string[]): SessionEvent[] => [
  {
    type: "session_created",
    sessionId: SAMPLE_SESSION_ID,
    at: AT_ONE,
    title: "Release readiness for the Checkout API",
    origin: "interactive",
    parentSessionId: null,
  },
  ...turnIds.map((turnId, index) => ({
    type: "turn_appended" as const,
    sessionId: SAMPLE_SESSION_ID,
    at: index === 0 ? AT_ONE : AT_TWO,
    turnId,
  })),
  {
    type: "place_changed",
    sessionId: SAMPLE_SESSION_ID,
    at: AT_TWO,
    // The mode is not carried: `modeForPlace` derives it from the sub-mode, and
    // a second answer to the same question is one that can disagree.
    place: { subMode: "office", surface: null },
    source: "work",
  },
];

/** Turn ids this module owns, so a clear can only ever delete its own. */
export const sampleTurnIds = (): string[] => TURNS.map((turn) => `${SAMPLE_TURN_PREFIX}${turn.id}`);
