/**
 * The directory Connectome IQ shows: My IQs other people published.
 *
 * Fixture data, and only fixture data. There is no exchange behind Connectome
 * IQ — no server, no tenant, no sync — so this file is the whole of what the
 * surface knows about other people's IQs. It exists to answer a question the
 * product could not otherwise show: once everyone's work compiles into an IQ,
 * what does the hub of them look like, and how would you read one without
 * copying it into your app.
 *
 * The shape is deliberately the same shape a real one would have, because that
 * is the claim being demonstrated. Every field here already exists in
 * `MyIqSnapshot` — the file the publisher writes and `@iq/myiq-mcp` serves — so
 * a directory of real IQs would be a directory of those files and nothing new.
 *
 * The people, teams and work are invented. The vocabulary matches the rest of
 * the demo material: projects, customer work, operations, quality review and
 * communications, so a reader follows it without industry knowledge.
 */

export interface SharedIqCell {
  name: string;
  version: number;
  /** What the cell does, in one line. `MyIqCell.faces`, joined. */
  does: string;
  reach: string[];
  runs: number;
  /** 0–1. Shown as a percentage. */
  completion: number;
  approver: string;
}

export interface SharedIqFinding {
  title: string;
  detail: string;
  action: string;
}

export interface SharedIq {
  id: string;
  /** What the publisher called it, in their own publish dialog. */
  name: string;
  owner: string;
  team: string;
  /** One line: what this IQ is about. */
  summary: string;
  topics: string[];
  /** ISO date. Shown as a date, never as a time. */
  publishedAt: string;
  /** Days of run history the analysis covered. */
  windowDays: number;
  /** The analysis hash, exactly as My IQ prints it. */
  hash: string;
  edgeCount: number;
  cells: SharedIqCell[];
  memories: { subject: string; fact: string }[];
  notes: { path: string; title: string }[];
  findings: SharedIqFinding[];
  /** What the analysis could not see. Never separated from the findings. */
  limits: string[];
}

/**
 * Five IQs, one per work area the demo material already uses.
 *
 * Five rather than twenty because the surface is read, not scrolled, and every
 * row here has to be worth opening. The picker above them searches and filters
 * anyway: a real directory is a tenant's worth of people, and a surface that
 * only worked at five would be demonstrating the wrong thing.
 */
export const SHARED_IQS: readonly SharedIq[] = [
  {
    id: "shared_projects",
    name: "Project delivery IQ",
    owner: "Dana Okafor",
    team: "Delivery",
    summary: "How weekly project reporting is put together, and what it depends on.",
    topics: ["Projects", "Reporting", "Scheduling"],
    publishedAt: "2026-01-18",
    windowDays: 90,
    hash: "3f7a1c04",
    edgeCount: 9,
    cells: [
      {
        name: "Write the weekly project update",
        version: 6,
        does: "Collect the week's changes and write the update the team reads on Monday",
        reach: ["Project files", "Microsoft 365 calendar"],
        runs: 214,
        completion: 0.96,
        approver: "dana",
      },
      {
        name: "Flag project dates at risk",
        version: 4,
        does: "Compare committed dates against the plan and name the ones that will slip",
        reach: ["Project files"],
        runs: 132,
        completion: 0.91,
        approver: "dana",
      },
      {
        name: "Prepare the Monday leadership update",
        version: 3,
        does: "Turn the weekly update into a deck leadership reads in ten minutes",
        reach: ["Project files"],
        runs: 48,
        completion: 0.88,
        approver: "dana",
      },
    ],
    memories: [
      { subject: "reporting", fact: "The weekly update always opens with dates at risk." },
      { subject: "reporting", fact: "A date is only 'committed' once the customer has seen it." },
    ],
    notes: [
      { path: "projects/weekly-update.md", title: "How the weekly update is written" },
      { path: "projects/dates-at-risk.md", title: "What counts as a date at risk" },
    ],
    findings: [
      {
        title: "Three cells depend on one reading of the plan",
        detail:
          "The update, the risk flag and the leadership deck all read the same plan file, so a wrong plan is wrong in three places at once.",
        action: "Check the plan before the Monday run rather than after it.",
      },
      {
        title: "The leadership deck lags the update it summarises",
        detail: "It runs on average four hours later, so a late change reaches the team and not leadership.",
        action: "Run the deck from the update, not from the plan.",
      },
    ],
    limits: [
      "Run history covers 90 days. Anything quarterly appears once or not at all.",
      "Nothing inside a document is read; only what the cells declare.",
    ],
  },
  {
    id: "shared_support",
    name: "Customer support IQ",
    owner: "Marco Bianchi",
    team: "Customer support",
    summary: "How incoming requests are grouped, answered and escalated.",
    topics: ["Customer work", "Escalation", "Answers"],
    publishedAt: "2026-01-22",
    windowDays: 30,
    hash: "a2d90b6e",
    edgeCount: 7,
    cells: [
      {
        name: "Group similar customer requests",
        version: 8,
        does: "Cluster the week's requests so the same answer is written once",
        reach: ["Support inbox"],
        runs: 402,
        completion: 0.94,
        approver: "marco",
      },
      {
        name: "Prepare a clear answer for a common question",
        version: 5,
        does: "Draft the answer, cite the note it came from, and hold it for review",
        reach: ["Support inbox", "Knowledge notes"],
        runs: 288,
        completion: 0.9,
        approver: "marco",
      },
      {
        name: "Escalate what support cannot close",
        version: 2,
        does: "Hand the request on with what was already tried attached",
        reach: ["Support inbox"],
        runs: 61,
        completion: 0.97,
        approver: "priya",
      },
    ],
    memories: [
      { subject: "support", fact: "An answer cites the note it came from or it does not go out." },
      { subject: "support", fact: "Escalations carry what was already tried." },
    ],
    notes: [
      { path: "support/common-answers.md", title: "Answers we send often" },
      { path: "support/escalation.md", title: "When to escalate" },
    ],
    findings: [
      {
        title: "Grouping and answering are effectively one step",
        detail: "They ran within a minute of each other in 96% of the window, and never apart by more than an hour.",
        action: "Treat them as one procedure when either is changed.",
      },
      {
        title: "Escalation is the only cell a second person approves",
        detail: "Everything else is approved by its author, so escalation is the only place a second reader sees the work.",
        action: "Decide whether that is intended before adding a fourth cell.",
      },
    ],
    limits: [
      "Run history covers 30 days.",
      "No message content is read. Coupling comes from what the cells declare and when they ran.",
    ],
  },
  {
    id: "shared_operations",
    name: "Operations IQ",
    owner: "Yuki Tanaka",
    team: "Operations",
    summary: "The daily and weekly operations checks, and where they overlap.",
    topics: ["Operations", "Checks", "Handover"],
    publishedAt: "2026-01-09",
    windowDays: 90,
    hash: "c48e2071",
    edgeCount: 12,
    cells: [
      {
        name: "Run the morning readiness check",
        version: 11,
        does: "Walk the standing checklist and record what is not ready",
        reach: ["Operations files"],
        runs: 640,
        completion: 0.99,
        approver: "yuki",
      },
      {
        name: "Write the shift handover",
        version: 7,
        does: "Summarise what the next shift needs to know and what was left open",
        reach: ["Operations files"],
        runs: 618,
        completion: 0.98,
        approver: "yuki",
      },
      {
        name: "Chase what the check left open",
        version: 3,
        does: "Follow up every item the readiness check recorded as not ready",
        reach: ["Operations files", "Microsoft 365 calendar"],
        runs: 210,
        completion: 0.82,
        approver: "yuki",
      },
    ],
    memories: [
      { subject: "operations", fact: "A handover names open items even when there are none." },
      { subject: "operations", fact: "The readiness check runs before the shift, never during it." },
    ],
    notes: [
      { path: "operations/readiness.md", title: "The morning readiness checklist" },
      { path: "operations/handover.md", title: "What a handover has to say" },
    ],
    findings: [
      {
        title: "The chase cell completes least often of the three",
        detail: "82% against 98% and 99%. It is the only one that waits on someone outside operations.",
        action: "Look at what it is waiting for before treating the number as a fault.",
      },
      {
        title: "Readiness and handover are the most tightly coupled pair here",
        detail: "They share every declared path and run within the same hour on 92% of days.",
        action: "Change them together or neither.",
      },
    ],
    limits: [
      "Run history covers 90 days.",
      "Weekend shifts are in the window but are a fifth of the runs, so weekend-only patterns are weak.",
    ],
  },
  {
    id: "shared_quality",
    name: "Quality review IQ",
    owner: "Priya Raman",
    team: "Quality",
    summary: "What gets reviewed, by whom, and what the review has to produce.",
    topics: ["Quality review", "Approval", "Evidence"],
    publishedAt: "2026-01-25",
    windowDays: 90,
    hash: "9b105fd3",
    edgeCount: 6,
    cells: [
      {
        name: "Assemble the evidence pack",
        version: 9,
        does: "Gather everything a reviewer needs into one place before the review starts",
        reach: ["Quality files", "SharePoint"],
        runs: 96,
        completion: 0.93,
        approver: "priya",
      },
      {
        name: "Check a change against the standard",
        version: 6,
        does: "Read the change beside the standard it has to meet and record the gaps",
        reach: ["Quality files"],
        runs: 154,
        completion: 0.89,
        approver: "priya",
      },
      {
        name: "Record the review decision",
        version: 4,
        does: "Write down what was decided, by whom, and on what evidence",
        reach: ["Quality files"],
        runs: 149,
        completion: 1,
        approver: "priya",
      },
    ],
    memories: [
      { subject: "quality", fact: "A decision records the evidence it was made on." },
      { subject: "quality", fact: "A gap without a standard cited is not a gap." },
    ],
    notes: [
      { path: "quality/evidence-pack.md", title: "What goes in an evidence pack" },
      { path: "quality/standards.md", title: "The standards we review against" },
    ],
    findings: [
      {
        title: "Every check produces a decision, but not every pack produces a check",
        detail: "96 packs, 154 checks, 149 decisions. Packs are assembled for reviews that then do not happen.",
        action: "Find out what cancels a review after the pack is built.",
      },
      {
        title: "One person approves all three",
        detail: "This is the most concentrated approval in the directory.",
        action: "Name a second approver before the volume grows.",
      },
    ],
    limits: [
      "Run history covers 90 days.",
      "The analysis reads declared reach, not the contents of any evidence pack.",
    ],
  },
  {
    id: "shared_comms",
    name: "Communications IQ",
    owner: "Sofia Lindqvist",
    team: "Communications",
    summary: "How announcements are drafted, checked and sent.",
    topics: ["Communications", "Announcements", "Review"],
    publishedAt: "2026-01-14",
    windowDays: 30,
    hash: "5e6c88a9",
    edgeCount: 5,
    cells: [
      {
        name: "Draft the announcement",
        version: 5,
        does: "Write the announcement from the decision it is announcing",
        reach: ["Communications files"],
        runs: 74,
        completion: 0.95,
        approver: "sofia",
      },
      {
        name: "Check the announcement reads plainly",
        version: 3,
        does: "Flag jargon, hedging and anything that needs a second reading",
        reach: ["Communications files"],
        runs: 71,
        completion: 0.92,
        approver: "sofia",
      },
      {
        name: "Send and file the announcement",
        version: 2,
        does: "Send it, then file the sent version beside the decision",
        reach: ["Communications files", "SharePoint"],
        runs: 68,
        completion: 0.99,
        approver: "sofia",
      },
    ],
    memories: [
      { subject: "communications", fact: "An announcement names the decision it came from." },
      { subject: "communications", fact: "Nothing goes out that needs a second reading." },
    ],
    notes: [
      { path: "communications/plain-language.md", title: "Writing plainly" },
      { path: "communications/announcements.md", title: "How an announcement is filed" },
    ],
    findings: [
      {
        title: "The three cells are a straight line, not a web",
        detail: "Five couplings across three cells, all consecutive. This is the least entangled IQ in the directory.",
        action: "Nothing. A short chain is a good result, not a missing one.",
      },
      {
        title: "Three drafts never reached send",
        detail: "74 drafts, 68 sends. The gap is not recorded anywhere the analysis can see.",
        action: "Record why a draft is dropped, or the gap stays unexplained.",
      },
    ],
    limits: [
      "Run history covers 30 days.",
      "Whether an announcement landed well is not measured. Only that it was sent.",
    ],
  },
];

/**
 * Every topic in the directory, in alphabetical order, each named once.
 *
 * Derived from the IQs rather than kept beside them. A hand-written list of
 * topics goes stale in the one direction nobody notices: it keeps offering a
 * topic no IQ carries any more, and pressing it returns nothing with no way to
 * tell an empty result from a broken filter.
 */
export function sharedIqTopics(iqs: readonly SharedIq[]): string[] {
  return [...new Set(iqs.flatMap((iq) => iq.topics))].sort((left, right) =>
    left.localeCompare(right),
  );
}

/** How the directory is narrowed. The two parts are independent and both optional. */
export interface SharedIqQuery {
  /** Free text. Every word has to match, though not all in the same field. */
  term: string;
  /** One topic, spelled as `SharedIq.topics` spells it. Empty means every topic. */
  topic: string;
}

/**
 * The text an IQ can be found by.
 *
 * Who published it, what they called it, what it is about, and what its cells
 * do. The cell names are in because the question somebody arrives with is
 * usually "whose IQ knows about escalations", and that word lives in a cell
 * name rather than in a title.
 *
 * The findings, memories and notes are deliberately out. They are the IQ's
 * contents, and matching them would return a whole IQ on the strength of one
 * word buried in a footnote — a hit the reader cannot see on the card and
 * cannot explain. Reading the contents is what the tool console is for.
 */
function searchableText(iq: SharedIq): string {
  return [
    iq.name,
    iq.owner,
    iq.team,
    iq.summary,
    ...iq.topics,
    ...iq.cells.map((cell) => cell.name),
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * The directory, narrowed to what somebody is looking for.
 *
 * Words are ANDed, so every extra word makes the result smaller. That is the
 * only behaviour that lets somebody type their way down to one row; ORing them
 * means the third word widens the list and the reader stops trusting the box.
 *
 * The order is the directory's own and never relevance. This is a list of
 * people's work, and a list that reshuffles itself while you type is one you
 * cannot point at or come back to.
 *
 * Pure, so it can be checked without a browser.
 */
export function findSharedIqs(iqs: readonly SharedIq[], query: SharedIqQuery): SharedIq[] {
  const words = query.term.toLowerCase().split(/\s+/).filter((word) => word !== "");
  return iqs.filter((iq) => {
    if (query.topic !== "" && !iq.topics.includes(query.topic)) return false;
    if (words.length === 0) return true;
    const text = searchableText(iq);
    return words.every((word) => text.includes(word));
  });
}

/**
 * The name a client files an IQ's server under.
 *
 * One per IQ, and stable, because connecting several at once is the normal
 * case: a client's configuration is a map keyed by name, so two IQs sharing a
 * key would silently be one server.
 */
export const sharedIqServerId = (iq: SharedIq): string => `iq-${iq.id.replace(/^shared_/, "")}`;

/**
 * The MCP configuration for reading shared IQs.
 *
 * The same stdio shape `MyIqPublisher.endpoint()` reports for your own IQ,
 * pointed at those people's homes instead of yours. It is shown rather than
 * fetched because there is nothing to fetch: this is a demonstration of what a
 * client would be given, and pretending otherwise would be the one dishonest
 * thing on the surface.
 *
 * It takes a list, not one IQ. An IQ is served over MCP, and MCP clients hold
 * many servers at once — so reading five people's IQs side by side is the shape
 * the exchange actually has, and a config that could only ever name one would
 * teach the opposite.
 */
export function sharedIqClientConfig(iqs: readonly SharedIq[]): string {
  const servers: Record<string, unknown> = {};
  for (const iq of iqs) {
    servers[sharedIqServerId(iq)] = {
      type: "stdio",
      command: "node",
      args: ["<path to>/packages/myiq-mcp/dist/index.js"],
      env: { IQ_HOME: `<${iq.owner}'s IQ home>` },
    };
  }
  return JSON.stringify({ servers }, null, 2);
}

/** The five read-only tools `@iq/myiq-mcp` serves, in the order it lists them. */
export const SHARED_IQ_TOOLS = [
  "myiq_list_cells",
  "myiq_get_cell",
  "myiq_search_knowledge",
  "myiq_list_memories",
  "myiq_connectome_summary",
] as const;

export type SharedIqTool = (typeof SHARED_IQ_TOOLS)[number];

const SAMPLE_NOTE =
  "\n\n(Sample data, published from IQ Compiler for demonstration. It describes no real person, system or workload.)";

/**
 * What a client would get back from one of the five tools.
 *
 * The wording tracks `packages/myiq-mcp/src/index.ts` deliberately: the point
 * of showing a tool result on this surface is that it is the result, not a
 * paraphrase of one. If the server's output changes and this does not, the
 * surface is teaching something that is no longer true.
 *
 * Pure, so it can be checked without a browser.
 */
export function sharedIqToolResult(iq: SharedIq, tool: SharedIqTool, argument: string): string {
  const query = argument.trim();
  switch (tool) {
    case "myiq_list_cells": {
      const lines = iq.cells.map(
        (cell) =>
          `- ${cell.name} (v${cell.version}) — ${cell.runs} runs at ${Math.round(cell.completion * 100)}% completion; ` +
          `reaches ${cell.reach.join(", ")}`,
      );
      return `${iq.name} — ${iq.cells.length} IQ Cells:\n${lines.join("\n")}${SAMPLE_NOTE}`;
    }
    case "myiq_get_cell": {
      if (query === "") return "Name an IQ Cell by id or name.";
      const found = iq.cells.find((cell) => cell.name.toLowerCase().includes(query.toLowerCase()));
      if (found === undefined) {
        return `No published IQ Cell matches "${query}". Use myiq_list_cells to see them.`;
      }
      return (
        [
          `${found.name} (version ${found.version})`,
          `What it does: ${found.does}`,
          `Declared reach: ${found.reach.join(", ")}`,
          `Runs: ${found.runs} at ${Math.round(found.completion * 100)}% completion`,
          `Approver: ${found.approver}`,
        ].join("\n") + SAMPLE_NOTE
      );
    }
    case "myiq_search_knowledge": {
      if (query === "") return "Give a query to search for.";
      const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
      const hits = iq.notes.filter((note) =>
        words.every((word) => `${note.title} ${note.path}`.toLowerCase().includes(word)),
      );
      if (hits.length === 0) return `Nothing matches "${query}".${SAMPLE_NOTE}`;
      const lines = hits.map((note) => `- ${note.title} — ${note.path}`);
      return `${hits.length} of ${iq.notes.length} notes match:\n${lines.join("\n")}${SAMPLE_NOTE}`;
    }
    case "myiq_list_memories": {
      const lines = iq.memories.map((memory) => `- [approved] ${memory.subject}: ${memory.fact}`);
      return `${iq.memories.length} memories:\n${lines.join("\n")}${SAMPLE_NOTE}`;
    }
    case "myiq_connectome_summary": {
      const findings = iq.findings
        .map((finding) => `- ${finding.title}: ${finding.detail}\n  Next: ${finding.action}`)
        .join("\n");
      const limits = iq.limits.map((limit) => `- ${limit}`).join("\n");
      return (
        [
          `${iq.cells.length} IQ Cells, ${iq.edgeCount} couplings, over ${iq.windowDays} days.`,
          `Analysis ${iq.hash}, published ${iq.publishedAt}.`,
          "",
          "Findings:",
          findings,
          "",
          "What this analysis could not see:",
          limits,
        ].join("\n") + SAMPLE_NOTE
      );
    }
  }
}

/** Which tools take an argument, and what to call it in the box. */
export const SHARED_IQ_TOOL_ARGUMENT: Record<SharedIqTool, string> = {
  myiq_list_cells: "",
  myiq_get_cell: "IQ Cell name",
  myiq_search_knowledge: "Words to match",
  myiq_list_memories: "",
  myiq_connectome_summary: "",
};

/** One line each, so a reader picking a tool knows what they are about to call. */
export const SHARED_IQ_TOOL_DETAIL: Record<SharedIqTool, string> = {
  myiq_list_cells: "Every published IQ Cell, with its runs and completion rate",
  myiq_get_cell: "One IQ Cell in full — what it does, what it reaches, who approved it",
  myiq_search_knowledge: "The note titles and paths this IQ published",
  myiq_list_memories: "The approved conventions behind the work",
  myiq_connectome_summary: "The analysis: findings, and what it could not see",
};

/** Which tool a question asks for, and the argument taken from the question. */
export interface SharedIqAsk {
  tool: SharedIqTool;
  argument: string;
}

const MEMORY_WORDS = ["memory", "memories", "convention", "conventions", "rule", "rules"];
const ANALYSIS_WORDS = [
  "analysis",
  "finding",
  "findings",
  "summary",
  "summarise",
  "summarize",
  "risk",
  "risks",
  "coupling",
  "couplings",
  "depend",
  "depends",
  "overlap",
  "limit",
  "limits",
  "miss",
  "missing",
  // The surface's own words for the limits section. Somebody who read "what
  // this analysis could not see" and typed it back should land on it.
  "see",
  "blind",
  "gap",
  "gaps",
];
const NOTE_WORDS = ["note", "notes", "knowledge", "document", "documents", "doc", "docs"];
/** Words that carry no subject, so they are never the thing being searched for. */
const STOP_WORDS = new Set([
  "a", "about", "any", "anything", "are", "as", "at", "be", "by", "can", "could", "did", "do",
  "does", "find", "for", "from", "get", "give", "has", "have", "how", "i", "in", "is", "it",
  "its", "know", "list", "me", "my", "of", "on", "or", "read", "say", "says", "search", "show",
  "some", "something", "tell", "that", "the", "their", "there", "they", "this", "to", "was",
  "we", "were", "what", "which", "who", "with", "would", "you", "your",
]);

/**
 * Route a question to one of the five tools.
 *
 * A keyword match, deliberately — there is no model behind this console and the
 * surface says so. What it buys is that a reader can type the question they
 * actually have instead of learning five tool names first; the tool it picked
 * is always shown beside the answer, so a wrong guess is visible rather than
 * silently answering something else.
 *
 * Order matters: a question naming an IQ Cell is about that cell even when it
 * also says "what does", and a question about the analysis is about the
 * analysis even when it names a cell in passing. So the specific subjects are
 * asked for first and the catch-all is the cheapest, safest answer — the list.
 *
 * Pure, so it can be checked without a browser.
 */
export function sharedIqAsk(iq: SharedIq, question: string): SharedIqAsk {
  const asked = question.trim().toLowerCase();
  if (asked === "") return { tool: "myiq_list_cells", argument: "" };
  const words = asked.split(/[^a-z0-9]+/).filter((word) => word.length > 0);
  const says = (list: string[]): boolean => list.some((word) => words.includes(word));

  if (says(MEMORY_WORDS)) return { tool: "myiq_list_memories", argument: "" };
  if (says(ANALYSIS_WORDS)) return { tool: "myiq_connectome_summary", argument: "" };

  // A cell the question names outright. Matched on the cell's own words rather
  // than the whole title, because nobody quotes a title exactly.
  const named = iq.cells.find((cell) => {
    const title = cell.name.toLowerCase();
    if (asked.includes(title)) return true;
    const distinct = title.split(/[^a-z0-9]+/).filter((word) => word.length > 3);
    return distinct.length > 0 && distinct.every((word) => asked.includes(word));
  });
  if (named !== undefined) return { tool: "myiq_get_cell", argument: named.name };

  if (says(NOTE_WORDS)) {
    const subject = words.filter((word) => !STOP_WORDS.has(word) && !NOTE_WORDS.includes(word));
    return { tool: "myiq_search_knowledge", argument: subject.join(" ") };
  }

  return { tool: "myiq_list_cells", argument: "" };
}

/**
 * Openers for the console.
 *
 * With one IQ connected they name one of its own IQ Cells — a suggestion that
 * works for every entry in the directory teaches nothing about the entry in
 * front of you. With several, they ask the question several servers are for:
 * the same thing of all of them, so the differences are the answer.
 */
export function sharedIqSuggestions(iqs: readonly SharedIq[]): string[] {
  if (iqs.length === 0) return [];
  if (iqs.length > 1) {
    return [
      "What IQ Cells does each hold?",
      "What did each analysis find?",
      "What conventions do they follow?",
      "What could they not see?",
    ];
  }
  const first = iqs[0]!.cells[0]?.name ?? "";
  return [
    "What IQ Cells does this hold?",
    ...(first === "" ? [] : [`What does "${first}" do?`]),
    "What did the analysis find?",
    "What conventions does it follow?",
  ];
}

/**
 * The request handed to a real conversation.
 *
 * Written out rather than sent: the composer is where the user finishes it and
 * presses send, so opening an IQ in chat can never become a turn nobody asked
 * for. It carries the three things a model would otherwise have to be told
 * twice — which IQs, how to reach them, and which tools they serve.
 *
 * Plural throughout. Several IQs answering the same question is the point of
 * serving them over MCP, and a message that named one would quietly drop the
 * other four the user had connected.
 */
export function sharedIqChatPrompt(iqs: readonly SharedIq[], question: string): string {
  if (iqs.length === 0) return "";
  const asked = question.trim();
  const one = iqs.length === 1;
  return [
    one
      ? `Read the published IQ "${iqs[0]!.name}" (${iqs[0]!.owner}, ${iqs[0]!.team}) over MCP and answer:`
      : `Read these ${iqs.length} published IQs over MCP and answer, naming which one each part of the answer came from:`,
    "",
    asked === "" ? "- " : asked,
    "",
    ...(one
      ? []
      : [
          "The IQs:",
          ...iqs.map((iq) => `- ${iq.name} — ${iq.owner}, ${iq.team}. Served as ${sharedIqServerId(iq)}.`),
          "",
        ]),
    one
      ? "It is served by the read-only stdio server below. Add it in Control Center → MCP servers,"
      : "Each is a read-only stdio server of its own. Add them in Control Center → MCP servers,",
    one
      ? "inspect it, and approve the tools you need before asking."
      : "inspect each one, and approve the tools you need before asking. They are separate servers, so compare their answers rather than assuming they agree.",
    "",
    "```json",
    sharedIqClientConfig(iqs),
    "```",
    "",
    `Every server serves the same five tools: ${SHARED_IQ_TOOLS.join(", ")}.`,
    "",
    one
      ? "This IQ is sample data published for demonstration. It describes no real person or workload."
      : "These IQs are sample data published for demonstration. They describe no real person or workload.",
  ].join("\n");
}
