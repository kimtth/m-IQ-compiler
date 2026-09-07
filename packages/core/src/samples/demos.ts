import type {
  AppSurface,
  CouncilRun,
  DataAgentChat,
  DraftTurnEvent,
  ImageRun,
  RecordingAnalysis,
  RecordingBuild,
  RecordingRecord,
  ResearchRun,
  SessionEvent,
  SubMode,
  TurnEvent,
} from "@iq/shared";

/**
 * One worked conversation per feature, each starting from an empty surface.
 *
 * # Why this module exists
 *
 * The `project` module ships one conversation, and it is the only one. Every
 * other feature — Work IQ, Research, Council, Data Agent, Image, the two
 * recorders — could only be shown by running it, which needs a tenant, a Fabric
 * capacity, a microphone or a model. So a demo either signed in and hoped, or
 * it appended a new question to whatever conversation happened to be open, and
 * the screen ended up showing one feature's history under another feature's
 * heading.
 *
 * These are the outputs, written straight to the log. Open the rail, pick the
 * conversation, and the surface shows the real input and the real output in the
 * app's own chat — the tool cards, the untrusted marking, the token usage, all
 * of it rendered by the same components a live turn uses.
 *
 * # What is real and what is staged
 *
 * The rendering is real. The content is fabricated, and the log says so at
 * every turn: `agentId` is `sample-data` and `model` is `sample-data`, the same
 * tell `project.ts` uses. Nothing here claims a model or a tenant produced it.
 *
 * The tool names are not invented. They are the names the servers actually
 * publish — `m365_list_calendar`, `fabric_ask_data_agent` — because a card
 * showing a tool that does not exist is the one lie that would survive into a
 * screenshot and out into the world.
 *
 * # The rule this module exists to enforce
 *
 * One conversation per feature, and each one starts empty. A demo never types
 * into another demo's thread. That is what "no contradiction between the chat
 * and the screen" reduces to in practice.
 */

const PREFIX = "ses_sample_demo_";
const TURN_PREFIX = "trn_sample_demo_";

/** Fabricated, and the log says so. Same tell as `project.ts`. */
const AGENT_ID = "sample-data";
const MODEL = "sample-data";

export interface DemoConversation {
  /** Short, stable key. The session id is this with a fixed prefix. */
  readonly key: string;
  readonly title: string;
  readonly mode: string;
  readonly subMode: SubMode | null;
  /**
   * The surface this conversation belongs on, or `null` for a sub-mode.
   *
   * A place is one or the other. Meeting Recordings is a surface, so a demo
   * that named a sub-mode instead landed the reader on Skill Recording — a
   * pane that hides the chat, so the transcript they were sent to read was not
   * rendered at all.
   */
  readonly surface: AppSurface | null;
  readonly toolFamilies: readonly string[];
  readonly at: string;
  readonly events: readonly DraftTurnEvent[];
}

export const demoSessionId = (key: string): string => `${PREFIX}${key}`;
export const isDemoSession = (sessionId: string): boolean => sessionId.startsWith(PREFIX);

/** A user message with no attachments, which is how every one of these starts. */
const ask = (content: string): DraftTurnEvent => ({
  type: "user_message",
  content,
  attachments: [],
});

/**
 * A tool call that ran and came back.
 *
 * Both halves are emitted because the surface renders them as one card and
 * needs the pair: the request carries the risk and the resources, the
 * completion carries the result and whether it is trusted.
 */
const toolCall = (options: {
  id: string;
  name: string;
  family: string;
  risk: "read" | "write";
  summary: string;
  args: unknown;
  result: unknown;
  /** True when the payload came from outside — M365 content, a sub-agent, the web. */
  untrusted?: boolean;
  resources?: readonly string[];
}): DraftTurnEvent[] => [
  {
    type: "tool_call_requested",
    request: {
      toolCallId: options.id,
      toolName: options.name,
      family: options.family,
      risk: options.risk,
      summary: options.summary,
      requiredScopes: [],
      resources: [...(options.resources ?? [])],
    },
    args: options.args,
  },
  {
    type: "tool_call_completed",
    toolCallId: options.id,
    toolName: options.name,
    ok: true,
    result: options.result,
    untrusted: options.untrusted ?? false,
  },
];

/* ------------------------------------------------------------------ *
 * Chat · Conversation — Microsoft 365 through the Work IQ MCP server
 * ------------------------------------------------------------------ */

/*
 * A note on the shape of these answers.
 *
 * `MessageBody` understands three things: `**bold**`, `` `inline code` `` and
 * fenced blocks. It does not understand tables, headings or lists, and says so
 * — a parser that half-understood them would change more text than it
 * improved. So anything columnar goes in a fence, where it lands in a real
 * `.code-block` and stays aligned, and everything else is prose.
 *
 * This is the whole reason to seed the app rather than draw a picture of it:
 * the constraint is real, and a mockup would never have hit it.
 */

const WORKIQ_ANSWER = [
  "**Tuesday 2 September — 4 meetings.**",
  "",
  "```",
  "09:30 – 10:00   Portal release check             3 attendees",
  "11:00 – 12:00   Customer review · Bright Path    5 attendees",
  "14:00 – 14:30   Quality review standup           4 attendees",
  "16:00 – 17:00   Change board · CHANGE-2214       6 attendees",
  "```",
  "",
  "One free block: **12:00 – 14:00**.",
  "",
  "Reading the calendar needed no approval, because nothing left the tenant.",
  "Sending a message would have stopped for one.",
].join("\n");

const WORKIQ: DemoConversation = {
  key: "workiq",
  title: "What meetings do I have tomorrow?",
  mode: "chat",
  subMode: "conversation",
  surface: null,
  toolFamilies: ["workiq", "m365"],
  at: "2026-09-01T08:04:00.000Z",
  events: [
    ask("What meetings do I have tomorrow, and who is attending?"),
    ...toolCall({
      id: "tc_demo_workiq_01",
      name: "workiq-search_paths",
      family: "workiq",
      risk: "read",
      summary: "Find the calendar path for the signed-in account",
      args: { query: "calendar" },
      result: { paths: ["/me/calendar/events"] },
    }),
    ...toolCall({
      id: "tc_demo_workiq_02",
      name: "m365_list_calendar",
      family: "m365",
      risk: "read",
      summary: "List calendar events for 2 September",
      args: { start: "2026-09-02T00:00:00Z", end: "2026-09-02T23:59:59Z" },
      untrusted: true,
      result: {
        events: [
          { start: "09:30", end: "10:00", subject: "Portal release check", attendees: 3 },
          { start: "11:00", end: "12:00", subject: "Customer review · Bright Path", attendees: 5 },
          { start: "14:00", end: "14:30", subject: "Quality review standup", attendees: 4 },
          { start: "16:00", end: "17:00", subject: "Change board · CHANGE-2214", attendees: 6 },
        ],
      },
    }),
    { type: "assistant_message", content: WORKIQ_ANSWER },
    { type: "turn_completed", usage: { inputTokens: 2_140, outputTokens: 310 } },
  ],
};

/* ------------------------------------------------------------------ *
 * Chat · Research
 * ------------------------------------------------------------------ */

const RESEARCH_ANSWER = [
  "**Research: sovereign cloud** — written to `project/research/sovereign-cloud.md`,",
  "12.8 KB of Markdown.",
  "",
  "**Executive summary.** A sovereign cloud is a cloud environment designed to",
  "satisfy a jurisdiction's digital-sovereignty requirements: data governance,",
  "residency, access, encryption keys, compliance and operational authority. [3][4]",
  "",
  "**Sources.**",
  "",
  "```",
  " [3]  Sovereign Cloud          cloud.google.com",
  " [4]  Azure data residency     azure.microsoft.com",
  "[15]  Oracle Sovereign Cloud   oracle.com",
  "```",
  "",
  "Every question in the plan was answered with at least one citation. Nothing is",
  "asserted here that no source was found for.",
].join("\n");

/**
 * The report itself, as the Research surface renders it.
 *
 * Longer than the chat answer above and deliberately so: the chat says what
 * was produced, the report *is* what was produced. It is written in full
 * Markdown — headings, lists, a table — because the Research pane renders a
 * document rather than a chat bubble, and the document is the deliverable the
 * feature exists to make.
 */
const RESEARCH_REPORT = [
  "# Sovereign cloud",
  "",
  "## Executive summary",
  "",
  "A sovereign cloud is a cloud environment designed to satisfy a jurisdiction's",
  "digital-sovereignty requirements: data governance, residency, access, encryption",
  "keys, compliance and operational authority. [3][4]",
  "",
  "The term is defined by the providers who sell it, not by a standards body, so",
  "two offerings using the same words can guarantee materially different things.",
  "Residency claims are broadly comparable across the major providers. Key custody",
  "and operator access are not, and those are the two that decide whether the",
  "arrangement means anything. [15]",
  "",
  "## What the requirements cover",
  "",
  "| Requirement | Consistent across providers? |",
  "| --- | --- |",
  "| Data residency | Yes |",
  "| Data governance | Yes |",
  "| Compliance attestation | Yes |",
  "| Encryption-key custody | No — varies |",
  "| Operational authority | No — varies most |",
  "",
  "## Where the sources disagree",
  "",
  "They do not, on the definition. Every source consulted describes the same set of",
  "requirements. The disagreement is entirely about which of them a given product",
  "actually delivers, which is a claim about products rather than about the term.",
  "",
  "## What this report could not answer",
  "",
  "- No independent audit of any provider's operational-authority claim was found.",
  "- Pricing is out of scope: none of the sources state it without a sales contact.",
  "",
  "## Sources",
  "",
  "- [3] Sovereign Cloud — cloud.google.com",
  "- [4] Azure data residency — azure.microsoft.com",
  "- [15] Oracle Sovereign Cloud — oracle.com",
].join("\n");

const RESEARCH: DemoConversation = {
  key: "research",
  title: "Research · sovereign cloud",
  mode: "chat",
  subMode: "research",
  surface: null,
  toolFamilies: ["web", "knowledge"],
  at: "2026-09-01T08:20:00.000Z",
  events: [
    ask("sovereign cloud"),
    ...toolCall({
      id: "tc_demo_research_01",
      name: "web_fetch",
      family: "web",
      risk: "read",
      summary: "Read 3 of 15 sources found for the plan",
      args: { urls: ["cloud.google.com", "azure.microsoft.com", "oracle.com"] },
      untrusted: true,
      result: { fetched: 15, cited: 15 },
    }),
    { type: "assistant_message", content: RESEARCH_ANSWER },
    { type: "turn_completed", usage: { inputTokens: 38_400, outputTokens: 3_260 } },
  ],
};

/* ------------------------------------------------------------------ *
 * Chat · Council
 * ------------------------------------------------------------------ */

const COUNCIL_ANSWER = [
  "**Council verdict — confidence: medium.**",
  "",
  "**Recommendation.** Do not ship on the promised date with the checks failing.",
  "Run a 48-hour diagnostic gate, and hold the release the moment the failure",
  "reproduces.",
  "",
  "**Dissent · Customer trust.** Send the two-week notice today. A moved date is",
  "recoverable; a broken portal in front of a customer is not.",
  "",
  "**Dissent · Delivery.** Send no notice yet. Replanning costs become real the",
  "moment they are announced.",
  "",
  "7 decision criteria and 5 open questions are recorded in",
  "`project/council/verdict.md`. The dissent is kept, not resolved.",
].join("\n");

const COUNCIL: DemoConversation = {
  key: "council",
  title: "Council · ship or hold the portal release",
  mode: "chat",
  subMode: "team",
  surface: null,
  toolFamilies: ["knowledge"],
  at: "2026-09-01T08:41:00.000Z",
  events: [
    ask(
      "The customer portal release is failing 3% of its automated checks. Do we ship on " +
        "the promised date, or hold two weeks?",
    ),
    ...toolCall({
      id: "tc_demo_council_01",
      name: "knowledge_search",
      family: "knowledge",
      risk: "read",
      summary: "Give each member the portal release record to argue from",
      args: { query: "customer portal release checks", members: ["Delivery", "Customer trust", "Quality review"] },
      result: { notes: 6, members: 3 },
    }),
    { type: "assistant_message", content: COUNCIL_ANSWER },
    { type: "turn_completed", usage: { inputTokens: 21_700, outputTokens: 1_840 } },
  ],
};

/* ------------------------------------------------------------------ *
 * Chat · Data Agent — the published Fabric endpoint
 * ------------------------------------------------------------------ */

const DATA_AGENT_ANSWER = [
  "**4 customers** had more than two open issues last quarter.",
  "",
  "```",
  "Bright Path          5 open",
  "Northwind Retail     4 open",
  "Lakeside Health      3 open",
  "Contoso Logistics    3 open",
  "```",
  "",
  "The query the agent generated:",
  "",
  "```dax",
  "EVALUATE",
  "  FILTER(",
  "    SUMMARIZECOLUMNS(",
  "      Customer[Name],",
  '      "Open", CALCULATE(COUNTROWS(Issue), Issue[Status] = "Open")',
  "    ),",
  "    [Open] > 2",
  "  )",
  "```",
  "",
  "It stays on screen so you can read what was asked of the model, not only what",
  "came back.",
].join("\n");

const DATA_AGENT: DemoConversation = {
  key: "dataagent",
  title: "Data Agent · customers with open issues",
  mode: "chat",
  subMode: "dataagent",
  surface: null,
  toolFamilies: ["fabric"],
  at: "2026-09-01T09:02:00.000Z",
  events: [
    ask("Which customers had more than two open issues last quarter?"),
    ...toolCall({
      id: "tc_demo_dataagent_01",
      name: "fabric_ask_data_agent",
      family: "fabric",
      risk: "read",
      summary: "Put the question to the published Data Agent",
      args: { question: "Which customers had more than two open issues last quarter?" },
      untrusted: true,
      result: {
        rows: [
          { customer: "Bright Path", open: 5 },
          { customer: "Northwind Retail", open: 4 },
          { customer: "Lakeside Health", open: 3 },
          { customer: "Contoso Logistics", open: 3 },
        ],
      },
    }),
    { type: "assistant_message", content: DATA_AGENT_ANSWER },
    { type: "turn_completed", usage: { inputTokens: 3_980, outputTokens: 520 } },
  ],
};

/* ------------------------------------------------------------------ *
 * Co-create · Office
 * ------------------------------------------------------------------ */

/** What the caller asks for. A bare name, the way a person would say it. */
export const DEMO_DECK_NAME = "checkout-api-26-2-release-review.pptx";

/**
 * Where it actually lands.
 *
 * OfficeCLI gives a bare name a folder of its own, so the deck the transcript
 * asks for by name is on disk one level down. The tool result below says so,
 * because that is what the real tool returns.
 */
export const DEMO_DECK_PATH = `checkout-api-26-2-release-review/${DEMO_DECK_NAME}`;

/** One `office_add_many` instruction: what to add, where, and how it looks. */
export interface DeckItem {
  target: string;
  type: string;
  properties: readonly string[];
}

/**
 * The deck, slide by slide, exactly as OfficeCLI is asked to build it.
 *
 * # Why this is not six bullet lists
 *
 * The app's own `officecli-pptx` skill opens with the rule "a slide whose only
 * content is a bulleted list is not finished", and the first version of this
 * demo was six such slides. A demo that breaks the product's own documented
 * standard argues against the product. So each slide here is built on a
 * different pattern — cover, cards, chart, flowchart, table, statement — which
 * is the skill's second rule: never the same layout twice in a row.
 *
 * # Why the geometry is written out
 *
 * The skill's third rule: a `shape` with no `x`/`y`/`width`/`height` is dropped
 * into a default box that lands on the title and overflows after four lines.
 * Every shape below is placed. The numbers come from the skill's verified
 * canvas — 960 × 540pt, content band x 66 → 894, cards at x 66 / 355 / 644.
 *
 * The visual system follows Fluent: Segoe UI, open off-white canvases,
 * Microsoft blue for hierarchy, restrained semantic colours, soft neutral
 * cards, 8pt-aligned spacing and rounded corners. It is a presentation, not a
 * screenshot of Fluent controls, so each slide still has one clear story.
 */
const DECK: readonly { title: string; items: readonly DeckItem[] }[] = [
  {
    title: "Checkout API 26.2",
    items: [
      {
        target: "/",
        type: "slide",
        properties: ["layout=Title Only", "title=Checkout API 26.2", "background=F7F9FC"],
      },
      {
        target: "/slide[1]",
        type: "shape",
        properties: [
          "geometry=roundRect", "x=66pt", "y=145pt", "width=190pt", "height=34pt",
          "fill=EBF3FC", "line=none", "text=RELEASE REVIEW  ·  WEEK 36",
          "font=Segoe UI", "size=11", "bold=true", "color=0F6CBD", "align=center", "valign=middle",
        ],
      },
      {
        target: "/slide[1]",
        type: "shape",
        properties: [
          "geometry=roundRect", "x=66pt", "y=205pt", "width=510pt", "height=210pt",
          "fill=FFFFFF", "line=E1DFDD", "lineWidth=1pt", "shadow=000000",
          "text=One release decision.\nOne unverified authentication change.\nOne clear 48-hour gate.",
          "font=Segoe UI", "size=25", "bold=true", "color=242424", "margin=24pt", "valign=middle",
        ],
      },
      {
        target: "/slide[1]",
        type: "shape",
        properties: [
          "geometry=roundRect", "x=610pt", "y=145pt", "width=284pt", "height=270pt",
          "gradient=0F6CBD-115EA3-90", "line=none", "shadow=000000",
          "text=48\nHOURS\n\nDIAGNOSTIC GATE",
          "font=Segoe UI", "size=29", "bold=true", "color=FFFFFF", "align=center", "valign=middle",
        ],
      },
      {
        target: "/slide[1]",
        type: "shape",
        properties: [
          "text=CHANGE-2214  ·  Checkout authentication",
          "x=66pt", "y=445pt", "width=828pt", "height=34pt",
          "font=Segoe UI", "size=15", "color=616161", "fill=none", "valign=middle",
        ],
      },
    ],
  },
  {
    title: "Release readiness at a glance",
    items: [
      {
        target: "/",
        type: "slide",
        properties: ["layout=Title Only", "title=Release readiness at a glance", "background=F7F9FC"],
      },
      {
        target: "/slide[2]",
        type: "shape",
        properties: [
          "geometry=roundRect", "x=66pt", "y=155pt", "width=250pt", "height=180pt",
          "fill=FFFFFF", "line=E1DFDD", "lineWidth=1pt", "shadow=000000", "margin=20pt",
          "text=RELEASE SCOPE\n\n6\nchanges",
          "font=Segoe UI", "color=242424", "size=19", "bold=true", "align=left", "valign=middle",
        ],
      },
      {
        target: "/slide[2]",
        type: "shape",
        properties: [
          "geometry=roundRect", "x=355pt", "y=155pt", "width=250pt", "height=180pt",
          "fill=FFFFFF", "line=C7E0F4", "lineWidth=2pt", "shadow=000000", "margin=20pt",
          "text=QUALITY SIGNAL\n\n3%\nchecks failing",
          "font=Segoe UI", "color=0F6CBD", "size=19", "bold=true", "align=left", "valign=middle",
        ],
      },
      {
        target: "/slide[2]",
        type: "shape",
        properties: [
          "geometry=roundRect", "x=644pt", "y=155pt", "width=250pt", "height=180pt",
          "fill=FFF4CE", "line=FCE100", "lineWidth=1pt", "shadow=000000", "margin=20pt",
          "text=DECISION NEEDED\n\n1\nat risk",
          "font=Segoe UI", "color=8A3707", "size=19", "bold=true", "align=left", "valign=middle",
        ],
      },
      {
        target: "/slide[2]",
        type: "shape",
        properties: [
          "geometry=roundRect", "x=66pt", "y=365pt", "width=828pt", "height=92pt",
          "fill=EBF3FC", "line=none", "margin=20pt",
          "text=CHANGE-2214 has no recorded integration or validation run. The release is ready except for this evidence gap.",
          "font=Segoe UI", "color=115EA3", "size=18", "bold=true", "align=left", "valign=middle",
        ],
      },
    ],
  },
  {
    title: "The quality signal is moving the wrong way",
    items: [
      {
        target: "/",
        type: "slide",
        properties: ["layout=Title Only", "title=The quality signal is moving the wrong way", "background=F7F9FC"],
      },
      {
        target: "/slide[3]",
        type: "shape",
        properties: [
          "geometry=roundRect", "x=52pt", "y=140pt", "width=590pt", "height=350pt",
          "fill=FFFFFF", "line=E1DFDD", "lineWidth=1pt", "shadow=000000",
        ],
      },
      {
        target: "/slide[3]",
        type: "chart",
        properties: [
          "chartType=column",
          "categories=Week 31,Week 32,Week 33,Week 34,Week 35,Week 36",
          "data=Failing checks:1.1,0.9,1.4,2.2,2.7,3.0",
          "x=72pt", "y=165pt", "width=550pt", "height=300pt",
          "legend=none", "title=Failing checks (%)",
        ],
      },
      {
        target: "/slide[3]",
        type: "shape",
        properties: [
          "geometry=roundRect", "x=672pt", "y=140pt", "width=236pt", "height=350pt",
          "gradient=EBF3FC-FFFFFF-90", "line=C7E0F4", "lineWidth=1pt", "margin=18pt", "valign=top",
          "font=Segoe UI", "size=16", "color=242424",
          "text=TREND\n\n4 weeks rising\n\nEVIDENCE GAP\n\nNo validation run for CHANGE-2214\n\nDECISION\n\nReproduce before release",
        ],
      },
    ],
  },
  {
    title: "CHANGE-2214 · failure path",
    items: [
      {
        target: "/",
        type: "slide",
        properties: ["layout=Title Only", "title=CHANGE-2214 · failure path", "background=F7F9FC"],
      },
      {
        target: "/slide[4]",
        type: "shape",
        properties: [
          "geometry=roundRect", "x=52pt", "y=142pt", "width=856pt", "height=272pt",
          "fill=FFFFFF", "line=E1DFDD", "lineWidth=1pt", "shadow=000000",
        ],
      },
      {
        target: "/slide[4]",
        type: "diagram",
        properties: [
          "mermaid=flowchart LR; A[Retry storm] --> B[Token refresh dropped]; B --> C[Signed with a rotated token]; C --> D{Auth check}; D -->|reject| E[Portal 401]",
          "render=native",
          "x=76pt", "y=170pt", "width=808pt", "height=210pt",
        ],
      },
      {
        target: "/slide[4]",
        type: "shape",
        properties: [
          "geometry=roundRect", "x=52pt", "y=438pt", "width=856pt", "height=68pt",
          "fill=FFF4CE", "line=none", "margin=18pt",
          "text=The upstream fix is planned. It is not yet verified in Checkout API 26.2.",
          "font=Segoe UI", "color=8A3707", "size=18", "bold=true", "align=left", "valign=middle",
        ],
      },
    ],
  },
  {
    title: "Two options · one reversible choice",
    items: [
      {
        target: "/",
        type: "slide",
        properties: ["layout=Title Only", "title=Two options · one reversible choice", "background=F7F9FC"],
      },
      {
        target: "/slide[5]",
        type: "table",
        properties: [
          "data=OPTION,COST,RISK;Ship in week 36,No schedule change,Unverified authentication path reaches customers;Hold for 48 hours,Two days of contingency,Decision backed by a reproducible result",
          "style=medium2", "firstRow=true",
          "x=66pt", "y=158pt", "width=828pt", "height=205pt",
        ],
      },
      {
        target: "/slide[5]",
        type: "shape",
        properties: [
          "geometry=roundRect", "x=66pt", "y=397pt", "width=828pt", "height=88pt",
          "gradient=0F6CBD-115EA3-0", "line=none", "shadow=000000", "margin=20pt",
          "text=RECOMMENDATION   Hold 48 hours and run the diagnostic gate.",
          "font=Segoe UI", "color=FFFFFF", "size=20", "bold=true", "align=left", "valign=middle",
        ],
      },
    ],
  },
  {
    title: "Run the 48-hour diagnostic gate",
    items: [
      {
        target: "/",
        type: "slide",
        properties: ["layout=Title Only", "title=Run the 48-hour diagnostic gate", "background=F7F9FC"],
      },
      {
        target: "/slide[6]",
        type: "shape",
        properties: [
          "geometry=roundRect", "x=66pt", "y=155pt", "width=828pt", "height=196pt",
          "gradient=0F6CBD-5B5FC7-0", "line=none", "shadow=000000", "margin=24pt",
          "text=48 HOURS\n\nReproduce → isolate → decide",
          "font=Segoe UI", "color=FFFFFF", "size=28", "bold=true", "align=center", "valign=middle",
        ],
      },
      {
        target: "/slide[6]",
        type: "shape",
        properties: [
          "geometry=roundRect", "x=66pt", "y=381pt", "width=252pt", "height=104pt",
          "fill=FFFFFF", "line=E1DFDD", "lineWidth=1pt", "shadow=000000",
          "text=01  REPRODUCE\nExercise the rotated-token path",
          "font=Segoe UI", "color=242424", "size=15", "bold=true", "margin=14pt", "valign=middle",
        ],
      },
      {
        target: "/slide[6]",
        type: "shape",
        properties: [
          "geometry=roundRect", "x=354pt", "y=381pt", "width=252pt", "height=104pt",
          "fill=FFFFFF", "line=E1DFDD", "lineWidth=1pt", "shadow=000000",
          "text=02  ISOLATE\nConfirm whether users can reach it",
          "font=Segoe UI", "color=242424", "size=15", "bold=true", "margin=14pt", "valign=middle",
        ],
      },
      {
        target: "/slide[6]",
        type: "shape",
        properties: [
          "geometry=roundRect", "x=642pt", "y=381pt", "width=252pt", "height=104pt",
          "fill=EBF3FC", "line=C7E0F4", "lineWidth=1pt", "shadow=000000",
          "text=03  DECIDE\nRelease or hold with named owner",
          "font=Segoe UI", "color=115EA3", "size=15", "bold=true", "margin=14pt", "valign=middle",
        ],
      },
      {
        target: "/slide[6]",
        type: "notes",
        properties: [
          "text=The ask is 48 hours, not a delay. If the gate expires without a reproduction, the release goes on the promised date.",
        ],
      },
    ],
  },
];

/** The slide titles, in order — what the answer lists and the reader sees. */
export const DEMO_DECK_TITLES: readonly string[] = DECK.map((slide) => slide.title);

/**
 * Every element, flattened into the single `office_add_many` call that builds
 * the deck.
 *
 * One call, not one per slide. Later items target what earlier ones create, so
 * a slide and everything on it have to go together — and each call is a
 * separate approval card, so building this a piece at a time would ask the
 * reader to approve the same decision thirty times.
 */
export const DEMO_DECK_ITEMS: readonly DeckItem[] = DECK.flatMap((slide) => slide.items);

/** What each slide is built from, for the answer. Ordered with the titles. */
const DECK_PATTERNS = [
  "cover",
  "three KPI cards",
  "column chart + note",
  "flowchart",
  "comparison table",
  "closing statement",
];

const OFFICE_ANSWER = [
  `I have written **${DEMO_DECK_NAME}** for the Checkout API 26.2 release review — six slides, each on a different pattern,`,
  "and not one of them a wall of bullets.",
  "",
  "```",
  ...DEMO_DECK_TITLES.map(
    (title, index) => `${index + 1}  ${title.padEnd(34)}${DECK_PATTERNS[index]}`,
  ),
  "```",
  "",
  `All ${DEMO_DECK_ITEMS.length} elements went in one call, so that is one approval rather than ${DEMO_DECK_ITEMS.length}.`,
  "The completed deck is open in the Office preview beside this conversation.",
].join("\n");

const OFFICE: DemoConversation = {
  key: "office",
  title: "Office · Checkout API 26.2 release review",
  mode: "cocreate",
  subMode: "office",
  surface: null,
  toolFamilies: ["office"],
  at: "2026-09-01T09:26:00.000Z",
  events: [
    ask(
      "Build a six-slide release review deck for Checkout API 26.2 and the CHANGE-2214 " +
        "authentication risk. Show the failing-check trend, the end-to-end failure path, " +
        "the two release options, and the 48-hour diagnostic gate. Design it with charts " +
        "and diagrams where they earn their place, not six pages of bullets.",
    ),
    ...toolCall({
      id: "tc_demo_office_01",
      name: "office_create_document",
      family: "office",
      risk: "write",
      summary: `Create a new Office document at ${DEMO_DECK_NAME}`,
      args: { path: DEMO_DECK_NAME },
      resources: [DEMO_DECK_NAME],
      result: { path: DEMO_DECK_PATH },
    }),
    ...toolCall({
      id: "tc_demo_office_02",
      name: "office_add_many",
      family: "office",
      risk: "write",
      summary: `Add 6 slides and everything on them to ${DEMO_DECK_PATH}`,
      args: { path: DEMO_DECK_PATH, items: DEMO_DECK_ITEMS.length },
      resources: [DEMO_DECK_PATH],
      result: { added: DEMO_DECK_ITEMS.length },
    }),
    { type: "assistant_message", content: OFFICE_ANSWER },
    { type: "turn_completed", usage: { inputTokens: 9_120, outputTokens: 880 } },
  ],
};

/* ------------------------------------------------------------------ *
 * Co-create · Browser
 * ------------------------------------------------------------------ */

export const DEMO_BROWSER_URL =
  "https://learn.microsoft.com/en-us/azure/well-architected/pillars";

const BROWSER: DemoConversation = {
  key: "browser",
  title: "Browser · Azure Well-Architected pillars",
  mode: "cocreate",
  subMode: null,
  surface: "browser",
  toolFamilies: ["browser"],
  at: "2026-09-01T09:18:00.000Z",
  events: [
    ask(
      "Open the Microsoft Azure Well-Architected Framework pillars page and summarize the " +
        "five pillars I should use for this architecture review.",
    ),
    ...toolCall({
      id: "tc_demo_browser_01",
      name: "open_browser_pane",
      family: "browser",
      risk: "write",
      summary: `Open ${DEMO_BROWSER_URL} in the visible browser pane`,
      args: {
        url: DEMO_BROWSER_URL,
        reason: "Show the source page beside the conversation while reviewing it",
      },
      resources: ["learn.microsoft.com"],
      result: {
        ok: true,
        url: DEMO_BROWSER_URL,
        title: "Microsoft Azure Well-Architected Framework pillars",
      },
    }),
    ...toolCall({
      id: "tc_demo_browser_02",
      name: "read_browser_page",
      family: "browser",
      risk: "read",
      summary: "Read the visible Azure Well-Architected pillars page",
      args: { reason: "Identify the five framework pillars from the source" },
      untrusted: true,
      resources: ["learn.microsoft.com"],
      result: {
        ok: true,
        url: DEMO_BROWSER_URL,
        title: "Microsoft Azure Well-Architected Framework pillars",
        pillars: [
          "Reliability",
          "Security",
          "Cost Optimization",
          "Operational Excellence",
          "Performance Efficiency",
        ],
      },
    }),
    {
      type: "assistant_message",
      content: [
        "Use these five pillars for the architecture review:",
        "",
        "- **Reliability** — recover from failures and continue to function.",
        "- **Security** — protect confidentiality, integrity, and availability.",
        "- **Cost Optimization** — control spend while preserving business value.",
        "- **Operational Excellence** — improve operations through observability and automation.",
        "- **Performance Efficiency** — scale and adapt efficiently as demand changes.",
        "",
        "The Microsoft Learn source remains open in the Browser pane beside this answer.",
      ].join("\n"),
    },
    { type: "turn_completed", usage: { inputTokens: 2_180, outputTokens: 410 } },
  ],
};

/*
 * Image Creation and Skill Recording have no conversation here.
 *
 * Both hide the chat pane — `SUBMODE_HIDES_PANES` lists `chat` for each — so a
 * seeded transcript on either is a row in the rail that leads to a screen which
 * cannot render it. The reader clicks a demo and arrives at a blank surface.
 *
 * Their demos are records instead: Image Creation gets a finished run
 * (`DEMO_IMAGE_RUN`) pointing at a real generated image, and Skill Recording
 * keeps its own recording list, which is what its pane reads.
 */

/* ------------------------------------------------------------------ *
 * Co-create · Meeting recording
 * ------------------------------------------------------------------ */

const MEETING_ANSWER = [
  "**Change board · CHANGE-2214** — 32:14. Transcribed on the device.",
  "",
  "```",
  "11:42  decision  Hold the portal release until the failure reproduces",
  "19:05  decision  Customer update goes out Thursday, not today",
  "24:30  action    Rebuild the review pack with dated evidence",
  "28:12  action    Book the 48-hour diagnostic gate",
  "```",
  "",
  "Every line keeps the timestamp it came from. Nothing is filed until you approve",
  "it.",
].join("\n");

const MEETING: DemoConversation = {
  key: "meeting",
  title: "Meeting · change board CHANGE-2214",
  mode: "cocreate",
  subMode: null,
  surface: "meetings",
  toolFamilies: ["recordings"],
  at: "2026-09-01T10:35:00.000Z",
  events: [
    ask("Here is the change board recording — 32 minutes. Pull out the decisions and actions."),
    ...toolCall({
      id: "tc_demo_meeting_01",
      name: "meeting_transcribe",
      family: "recordings",
      risk: "read",
      summary: "Transcribe 32:14 of audio on the device",
      args: { durationSeconds: 1_934, onDevice: true },
      result: { segments: 214, decisions: 2, actions: 2 },
    }),
    { type: "assistant_message", content: MEETING_ANSWER },
    { type: "turn_completed", usage: { inputTokens: 27_300, outputTokens: 720 } },
  ],
};

export const DEMO_CONVERSATIONS: readonly DemoConversation[] = [
  WORKIQ,
  RESEARCH,
  COUNCIL,
  DATA_AGENT,
  BROWSER,
  OFFICE,
  MEETING,
];

export const DEMO_COUNT = DEMO_CONVERSATIONS.length;

/** Session ids this module owns, so a clear can only ever delete its own. */
export const demoSessionIds = (): string[] =>
  DEMO_CONVERSATIONS.map((demo) => demoSessionId(demo.key));

/** Turn ids this module owns. One turn each: these are single question/answer pairs. */
export const demoTurnIds = (): string[] =>
  DEMO_CONVERSATIONS.map((demo) => `${TURN_PREFIX}${demo.key}`);

/**
 * The turn log for one demo, stamped with its id, sequence and time.
 *
 * The `turn_created` event is prepended here rather than written into each
 * definition, because every one of them is identical apart from the mode — and
 * eight hand-written copies of the same snapshot is eight chances to let one
 * drift and claim a real model produced it.
 */
export const demoTurnLog = (
  demo: DemoConversation,
): { turnId: string; at: string; events: TurnEvent[] } => {
  const turnId = `${TURN_PREFIX}${demo.key}`;
  const events: DraftTurnEvent[] = [
    {
      type: "turn_created",
      sessionId: demoSessionId(demo.key),
      agentId: AGENT_ID,
      snapshot: {
        model: MODEL,
        skills: [],
        toolFamilies: [...demo.toolFamilies],
        mode: demo.mode,
        // Free text on the turn: "where the turn ran". A surface is a place a
        // turn can run, and naming it is truer than naming the sub-mode it
        // covers.
        subMode: demo.subMode ?? demo.surface ?? "conversation",
        projectId: null,
      },
      correlationId: `cor_sample_demo_${demo.key}`,
    },
    ...demo.events,
  ];
  return {
    turnId,
    at: demo.at,
    events: events.map((event, seq) => ({ ...event, turnId, seq, at: demo.at }) as TurnEvent),
  };
};

/**
 * The session log: created, one turn, and the surface it belongs on.
 *
 * `source` is `work` rather than `navigation` because the place came from what
 * the conversation did, not from where a window happened to be pointing. That
 * distinction is what stops opening one demo from re-filing another.
 */
export const demoSessionEvents = (
  demo: DemoConversation,
  turnId: string,
): SessionEvent[] => [
  {
    type: "session_created",
    sessionId: demoSessionId(demo.key),
    at: demo.at,
    title: demo.title,
    origin: "interactive",
    parentSessionId: null,
  },
  {
    type: "turn_appended",
    sessionId: demoSessionId(demo.key),
    at: demo.at,
    turnId,
  },
  /*
   * `chosen`, not `work`, and the difference is the whole point of the module.
   *
   * A `work` place is an inference, and the fold takes the last one written.
   * The shell writes its own as soon as the conversation is observed from
   * wherever the window happens to be pointing, so a demo seeded as `work`
   * gets quietly reassigned: the Data agent thread was overwritten with
   * `conversation` and opened on the wrong pane, which is the same class of
   * bug as a browsing conversation surfacing on the Fabric tab.
   *
   * Where a demo belongs is a statement, not a guess. `chosen` outranks `work`
   * in the fold and `setPlace` refuses to let an inference overwrite it, so
   * the thread opens on the surface its answer is about — every time, whatever
   * the window was showing when the sample loaded.
   */
  {
    type: "place_changed",
    sessionId: demoSessionId(demo.key),
    at: demo.at,
    place: { subMode: demo.subMode, surface: demo.surface },
    source: "chosen",
  },
];

/* ------------------------------------------------------------------ *
 * The surfaces a turn log cannot reach
 * ------------------------------------------------------------------ */

/**
 * Council, Research, Data Agent, Image Creation and Skill Recording keep their
 * own records.
 *
 * Chat's other three sub-modes do not render the conversation transcript.
 * `Council.tsx` reads council runs, `Research.tsx` reads research runs and
 * `DataAgent.tsx` reads Data Agent chats — each keyed on its own selection,
 * none of them on the active session. Sending a reader to one of those panes
 * with only a seeded turn log behind it shows them whatever was last open
 * there, which is how the Data Agent surface came to greet a first-time
 * reader with two raw `CapacityNotActive` errors from someone else's run.
 *
 * So the demo for each of the three is written twice: once as a conversation,
 * which is what the rail lists and what the transcript shows, and once as a
 * record in the store its pane actually reads. The two carry the same question
 * and the same answer on purpose — the whole complaint being fixed here is a
 * screen that disagrees with the words next to it.
 *
 * Image Creation and Skill Recording go further: both hide the chat pane
 * outright, so their demo is only the record. There is no transcript to keep in
 * step, and no conversation for the rail to offer that would land the reader on
 * a pane which cannot show it.
 *
 * The ids are fixed rather than minted. Loading the samples twice has to
 * replace these records, not stack second copies of them beside the first.
 */

export const DEMO_COUNCIL_RUN_ID = "cnl_sample_demo_portal";
export const DEMO_RESEARCH_RUN_ID = "rsr_sample_demo_sovereign";
export const DEMO_DATA_AGENT_CHAT_ID = "dac_sample_demo_issues";
export const DEMO_IMAGE_RUN_ID = "img_sample_demo_qbr";

/**
 * Where the sample image is written, relative to the sample project.
 *
 * Image Creation saves into the active project and the surface reads it back
 * through `project:read`, which refuses anything outside that directory. So
 * the bytes have to land there and the run has to point at the same place.
 */
export const DEMO_IMAGE_PATH = "images/qbr-infographic.jpg";

const DEMO_IMAGE_PROMPT =
  "A flat vector infographic for a quarterly business review. A 2x2 grid of four " +
  "panels labelled Revenue, Cost, Headcount, Risk. Each panel shows one large " +
  "number and one short caption under it. Deep navy background, white text, a " +
  "single orange accent colour. Clean geometric shapes, no photographs, no " +
  "gradients, no logos.";

/**
 * One finished image run.
 *
 * `dataUrl` is left empty because that is what a run looks like after a
 * restart: the index keeps the request and the path, and the surface fetches
 * the bytes back from the project. Seeding a data URL would make the demo the
 * one case in the app that behaves differently from every other saved image.
 */
export const DEMO_IMAGE_RUN: ImageRun = {
  id: DEMO_IMAGE_RUN_ID,
  threadId: "thr_sample_demo_qbr",
  status: "succeeded",
  request: {
    prompt: DEMO_IMAGE_PROMPT,
    operation: "generate",
    size: "1024x1024",
    quality: "auto",
    count: 1,
    modelId: "sample-data",
    sourcePath: "",
    maskPath: "",
    maskDataUrl: "",
    parentImageId: "",
    projectId: null,
  },
  images: [
    {
      id: "gim_sample_demo_qbr",
      dataUrl: "",
      savedPath: DEMO_IMAGE_PATH,
      provenance: {
        modelId: "sample-data",
        deploymentName: "gpt-image-2",
        endpointHost: "sample-data.local",
        operation: "generate",
        prompt: DEMO_IMAGE_PROMPT,
        size: "1024x1024",
        quality: "auto",
        sourcePath: "",
        maskPath: "",
        maskRegion: false,
        createdAt: "2026-09-01T09:48:00.000Z",
        projectId: null,
        correlationId: "cor_sample_demo_image",
      },
    },
  ],
  error: "",
  startedAt: "2026-09-01T09:47:52.000Z",
  finishedAt: "2026-09-01T09:48:00.000Z",
};

/**
 * A real recording id, not a readable one.
 *
 * `RecordingStore.dir()` refuses anything that is not
 * `YYYYMMDD-HHMMSS-xxxxxxxx` with eight hex digits — it builds a path from this
 * and an id like `../../skills` would turn a delete into a recursive removal
 * elsewhere. A friendlier id such as `…-sampledemo` therefore throws on the way
 * in and again on the way out, which is a hard failure in the middle of loading
 * and of clearing rather than a bad-looking dropdown entry.
 */
export const DEMO_RECORDING_ID = "20260901-094200-5a3d0e17";

/**
 * One finished recording, reconstructed and built into a skill.
 *
 * Skill Recording hides the chat pane too, so this is the whole demo. Without
 * it the pane opens on "Nothing has been recorded yet", and getting past that
 * needs a real screen capture, a model to reconstruct it and a person to
 * approve the result — three things a demo machine does not have.
 *
 * The record is honest about what is missing. `hasVideo` and `hasNarration`
 * are false and the frame count is zero, because no screen and no microphone
 * were captured; a seeded frame gallery would be the one part of this feature
 * that is a picture of itself. What is seeded is the part worth reading: the
 * reconstruction, and the generalised skill that came out of it.
 */
export const DEMO_RECORDING: RecordingRecord = {
  id: DEMO_RECORDING_ID,
  title: "Weekly release readiness check",
  status: "analysed",
  platform: "win32",
  appVersion: "sample-data",
  startedAt: "2026-09-01T09:42:00.000Z",
  endedAt: "2026-09-01T09:48:12.000Z",
  durationMs: 372_000,
  eventCount: 148,
  frameCount: 0,
  hasVideo: false,
  hasNarration: false,
  narrationTranscribed: false,
  analysisConsent: null,
  analysisRevision: 2,
  analysisApproved: true,
  builtSkillName: "release-readiness-check",
  builtJobId: null,
  error: null,
  correlationId: "cor_sample_demo_recording",
};

/**
 * The reconstruction, at revision 2.
 *
 * Revision 2 rather than 1 so the feedback log has something in it. The first
 * pass read the export as the point of the task; the person who watched it
 * said the point was the comparison, and the second pass says so. That
 * correction is the feature — a reconstruction nobody argued with is just a
 * transcript.
 */
export const DEMO_RECORDING_ANALYSIS: RecordingAnalysis = {
  version: 1,
  recordingId: DEMO_RECORDING_ID,
  revision: 2,
  createdAt: "2026-09-01T09:52:30.000Z",
  title: "Weekly release readiness check",
  intent:
    "Collect the week's release-readiness evidence for the checkout API and write it up as a " +
    "short note the change board can read before the meeting.",
  intentConfidence: "high",
  intentRationale:
    "Every step feeds the same document, and the run ends when that document is saved. The " +
    "build dashboard and the incident list are only opened to be read off, never edited.",
  steps: [
    {
      id: "s1",
      title: "Opened the release dashboard for the checkout API",
      detail:
        "Filtered to the last seven days and read off the pass rate, the failing suite names " +
        "and the date of the last green build.",
      startMs: 4_000,
      endMs: 71_000,
      apps: ["Browser"],
      evidence: ["nav:releases/checkout-api?window=7d", "click:filter-last-7-days"],
      confidence: "high",
    },
    {
      id: "s2",
      title: "Listed the open incidents against the same service",
      detail:
        "Sorted by severity and copied the two that were still open, with their ages in days.",
      startMs: 71_000,
      endMs: 138_000,
      apps: ["Browser"],
      evidence: ["nav:incidents?service=checkout-api&state=open", "click:sort-severity"],
      confidence: "high",
    },
    {
      id: "s3",
      title: "Compared this week's numbers against last week's note",
      detail:
        "Opened the previous week's readiness note and put the two pass rates side by side. " +
        "This is the step the first pass missed.",
      startMs: 138_000,
      endMs: 205_000,
      apps: ["Office"],
      evidence: ["open:notes/readiness-2026-08-25.docx"],
      confidence: "medium",
    },
    {
      id: "s4",
      title: "Wrote the readiness note and saved it beside the last one",
      detail:
        "Four headings — pass rate, open incidents, change since last week, recommendation — " +
        "and a one-line verdict at the top.",
      startMs: 205_000,
      endMs: 372_000,
      apps: ["Office"],
      evidence: ["save:notes/readiness-2026-09-01.docx"],
      confidence: "high",
    },
  ],
  feedbackLog: [
    {
      revision: 2,
      at: "2026-09-01T09:52:04.000Z",
      overall:
        "The export was not the point. The point is the comparison with last week — that is " +
        "what the change board asks about first.",
      steps: [{ stepId: "s3", note: "This step was dropped. It is the one that matters." }],
    },
  ],
  approved: true,
  approvedAt: "2026-09-01T09:53:10.000Z",
  sessionId: demoSessionId("recording-analysis"),
};

/**
 * The skill built from the approved reconstruction.
 *
 * The values are the generalisation: the recorded run named one service and
 * one window, and a skill that hard-codes them repeats that run instead of
 * learning from it.
 */
export const DEMO_RECORDING_BUILD: RecordingBuild = {
  version: 1,
  recordingId: DEMO_RECORDING_ID,
  kind: "skill",
  name: "release-readiness-check",
  description:
    "Collect release-readiness evidence for a service and write it up as a note for the " +
    "change board. Use before a release decision meeting.",
  allowedTools: ["browser_open", "browser_read", "office_create_document"],
  body:
    "Read the release dashboard for {{service}} over the last {{window}}. Note the pass " +
    "rate, the failing suites and the date of the last green build.\n\n" +
    "List the open incidents for the same service, sorted by severity, with their ages.\n\n" +
    "Open the previous readiness note and compare the two pass rates. Say whether the " +
    "number moved, and by how much.\n\n" +
    "Write the note with four headings — pass rate, open incidents, change since last " +
    "week, recommendation — and put a one-line verdict at the top. Save it beside the " +
    "previous one.",
  values: [
    { id: "service", name: "Service", value: "checkout-api" },
    { id: "window", name: "Dashboard window", value: "7 days" },
  ],
  plan: {
    kind: "skill",
    name: "release-readiness-check",
    title: "Release readiness check",
    description:
      "Collect release-readiness evidence for a service and write it up as a note for the " +
      "change board. Use before a release decision meeting.",
    summary:
      "Four steps: read the dashboard, list the open incidents, compare against last week, " +
      "write the note.",
    generalization:
      "The recorded run was one service over one week. Both are named values, so the same " +
      "procedure runs for any service and any window without editing the body.",
    values: [
      { id: "service", name: "Service", value: "checkout-api" },
      { id: "window", name: "Dashboard window", value: "7 days" },
    ],
    steps: [
      {
        kind: "calculation",
        title: "Read the release dashboard",
        text: "Read the pass rate, failing suites and last green build for {{service}} over {{window}}.",
        tool: "browser_read",
      },
      {
        kind: "calculation",
        title: "List open incidents",
        text: "List open incidents for {{service}} by severity, with the age of each in days.",
        tool: "browser_read",
      },
      {
        kind: "calculation",
        title: "Compare against last week",
        text: "Open the previous readiness note and state how the pass rate moved.",
        tool: "",
      },
      {
        kind: "action",
        title: "Write the readiness note",
        text: "Write the note under four headings with a one-line verdict, and save it beside the previous one.",
        tool: "office_create_document",
      },
    ],
    allowedTools: ["browser_open", "browser_read", "office_create_document"],
    trigger: null,
  },
  createdAt: "2026-09-01T09:55:00.000Z",
  skillName: "release-readiness-check",
  jobId: null,
  sessionId: demoSessionId("recording-build"),
};

const COUNCIL_MEMBERS = [
  { id: "cm_delivery", name: "Delivery", stance: "Protect the promised date and the plan behind it." },
  { id: "cm_trust", name: "Customer trust", stance: "Speak for the customer who is told about this." },
  { id: "cm_quality", name: "Quality review", stance: "Refuse to sign off on evidence that is not there." },
] as const;

const contribution = (
  n: number,
  /**
   * The engine's numbering, not the reader's: the opening is round 0 and the
   * rebuttals count from 1. The pane displays `round + 1`, so a fixture that
   * counted from 1 put its opening under a heading reading "Round 2".
   */
  round: number,
  phase: "opening" | "rebuttal" | "convergence",
  member: (typeof COUNCIL_MEMBERS)[number],
  summary: string,
  argument: string,
  at: string,
) => ({
  id: `cnt_sample_demo_${String(n).padStart(2, "0")}`,
  round,
  phase,
  memberId: member.id,
  memberName: member.name,
  stance: member.stance,
  modelId: MODEL,
  summary,
  argument,
  toolCalls: [],
  at,
});

/** The council debate the Team surface shows when nothing has been run. */
export const DEMO_COUNCIL_RUN: CouncilRun = {
  id: DEMO_COUNCIL_RUN_ID,
  question:
    "The customer portal release is failing 3% of its automated checks. Do we ship on the " +
    "promised date, or hold two weeks?",
  title: "Ship or hold the portal release",
  sessionId: demoSessionId("council"),
  projectId: null,
  members: COUNCIL_MEMBERS.map((member) => ({
    id: member.id,
    name: member.name,
    stance: member.stance,
    modelId: MODEL,
    skills: [],
    toolFamilies: ["knowledge"],
  })),
  roundBudget: 3,
  roundsRun: 1,
  phase: "verdict",
  status: "complete",
  contributions: [
    contribution(
      1,
      0,
      "opening",
      COUNCIL_MEMBERS[0],
      "Ship. A 3% failure rate is noise, and the date has been promised.",
      "The train leaves in week 36 and the date is in front of the customer already. " +
        "Three per cent of the checks are failing and none of them has been tied to a " +
        "defect a user would meet. Holding costs two weeks of everyone's plan to buy " +
        "certainty we may not need.",
      "2026-09-01T08:41:20.000Z",
    ),
    contribution(
      2,
      0,
      "opening",
      COUNCIL_MEMBERS[2],
      "Hold. Nothing in the record says the fix was ever validated.",
      "CR-2214 is marked at risk and there is no integration or validation run recorded " +
        "against it. That is not a judgement that the release is broken — it is the " +
        "statement that we do not know, and shipping on the promised date converts an " +
        "unknown into a promise.",
      "2026-09-01T08:41:44.000Z",
    ),
    contribution(
      3,
      0,
      "opening",
      COUNCIL_MEMBERS[1],
      "Tell the customer now, whatever we decide.",
      "The customer was told week 36 in writing. If the date is at risk, the expensive " +
        "thing is not the delay — it is the customer learning about it from a broken " +
        "portal instead of from us.",
      "2026-09-01T08:42:05.000Z",
    ),
    contribution(
      4,
      1,
      "rebuttal",
      COUNCIL_MEMBERS[0],
      "A notice sent today cannot be taken back.",
      "Quality review is asking for evidence, not claiming a defect. Those are different " +
        "requests and only one of them needs the date moved. Announce a slip and the " +
        "replanning costs become real immediately, whether or not the failure reproduces.",
      "2026-09-01T08:43:10.000Z",
    ),
    contribution(
      5,
      1,
      "rebuttal",
      COUNCIL_MEMBERS[2],
      "Forty-eight hours of diagnosis would settle it either way.",
      "Reproduce the failing checks against the release build. If it reproduces, the hold " +
        "is decided by evidence rather than by argument. If it does not, we ship on the " +
        "date with the record to show why.",
      "2026-09-01T08:43:52.000Z",
    ),
  ],
  verdict: {
    recommendation:
      "Do not ship on the promised date with the checks failing. Run a 48-hour diagnostic " +
      "gate, and hold the release the moment the failure reproduces.",
    criteria: [
      "Whether a failing check has been tied to a defect a user would meet",
      "Whether CR-2214 has an integration run recorded against it",
      "What the customer has already been told in writing",
      "The cost of a moved date against the cost of a broken portal",
      "Whether the failure reproduces against the release build",
      "Who owns the decision if the gate expires undecided",
      "What is said to the customer in each of the two outcomes",
    ],
    strongestFor:
      "The date is promised and no failing check has been traced to user-visible harm.",
    strongestAgainst:
      "There is no validation run on record for CR-2214, so the release is unverified rather than verified-good.",
    dissent: [
      {
        memberId: "cm_trust",
        memberName: "Customer trust",
        position:
          "Send the two-week notice today. A moved date is recoverable; a broken portal in " +
          "front of a customer is not.",
      },
      {
        memberId: "cm_delivery",
        memberName: "Delivery",
        position:
          "Send no notice yet. Replanning costs become real the moment they are announced.",
      },
    ],
    confidence: "medium",
    openQuestions: [
      "Which of the failing checks are new in this build?",
      "Is there an integration run for CR-2214 anywhere outside this project?",
      "Who signs off if the 48 hours expire without a reproduction?",
      "What does the customer hear if the date moves?",
      "Does the fix ship in 4.3 or in a patch on 4.2?",
    ],
    path: "project/council/verdict.md",
    at: "2026-09-01T08:44:30.000Z",
  },
  estimatedTokens: 21_700,
  injections: [],
  correlationId: "",
  error: "",
  createdAt: "2026-09-01T08:41:00.000Z",
  updatedAt: "2026-09-01T08:44:30.000Z",
};

const cite = (ref: string, title: string) => ({
  kind: "url" as const,
  ref,
  title,
  retrievedAt: "2026-09-01T08:21:40.000Z",
});

/** The finished research run the Research surface shows. */
export const DEMO_RESEARCH_RUN: ResearchRun = {
  id: DEMO_RESEARCH_RUN_ID,
  topic: "sovereign cloud",
  sessionId: null,
  projectId: null,
  status: "complete",
  questions: [
    {
      id: "rq_sample_demo_01",
      question: "What does 'sovereign cloud' mean, and who defines it?",
      status: "answered",
      statusLine: "Answered from 5 sources",
      findings:
        "A sovereign cloud is a cloud environment designed to satisfy a jurisdiction's " +
        "digital-sovereignty requirements. The term is defined by providers rather than by " +
        "a standards body, so the guarantees differ between them.",
      citations: [
        cite("cloud.google.com", "Sovereign Cloud"),
        cite("azure.microsoft.com", "Azure data residency"),
      ],
      conflicts: [],
      sources: ["cloud.google.com", "azure.microsoft.com", "oracle.com"],
      error: "",
      startedAt: "2026-09-01T08:20:30.000Z",
      finishedAt: "2026-09-01T08:21:40.000Z",
      taskId: "",
      round: 1,
      parentId: "",
    },
    {
      id: "rq_sample_demo_02",
      question: "Which requirements does it actually cover?",
      status: "answered",
      statusLine: "Answered from 6 sources",
      findings:
        "Consistently: data governance, residency, access control, encryption-key custody, " +
        "compliance attestation and operational authority. Operational authority — who may " +
        "administer the environment — is the one that varies most between offerings.",
      citations: [cite("azure.microsoft.com", "Azure data residency")],
      conflicts: [],
      sources: ["azure.microsoft.com", "oracle.com"],
      error: "",
      startedAt: "2026-09-01T08:20:30.000Z",
      finishedAt: "2026-09-01T08:21:55.000Z",
      taskId: "",
      round: 1,
      parentId: "",
    },
    {
      id: "rq_sample_demo_03",
      question: "How do the major providers differ in what they guarantee?",
      status: "answered",
      statusLine: "Answered from 4 sources",
      findings:
        "The residency claims are broadly comparable. The differences are in key custody " +
        "and in who holds operator access, which is where a comparison has to be read " +
        "closely rather than summarised.",
      citations: [cite("oracle.com", "Oracle Sovereign Cloud")],
      conflicts: [],
      sources: ["oracle.com", "cloud.google.com"],
      error: "",
      startedAt: "2026-09-01T08:20:30.000Z",
      finishedAt: "2026-09-01T08:22:10.000Z",
      taskId: "",
      round: 1,
      parentId: "",
    },
  ],
  report: {
    markdown: RESEARCH_REPORT,
    path: "project/research/sovereign-cloud.md",
    generatedAt: "2026-09-01T08:23:00.000Z",
    coverage: [
      "No independent audit of any provider's operational-authority claim was found.",
      "Pricing is out of scope: none of the sources state it without a sales contact.",
    ],
  },
  planId: "",
  round: 1,
  maxRounds: 2,
  maxParallel: 3,
  ledger: [
    {
      round: 1,
      assessment:
        "Every question in the plan was answered with at least one citation, and no two " +
        "sources contradicted each other on the definition. A second round would add " +
        "provider detail the topic did not ask for.",
      weak: [],
      followUps: [],
      stopped: "The plan was answered; nothing was left thin enough to justify another round.",
      at: "2026-09-01T08:22:30.000Z",
    },
  ],
  feedback: [],
  pendingRewrite: false,
  // Empty on purpose. The graph is the Agent Framework sidecar's own report of
  // what it executed, and this run had no sidecar behind it. Drawing one would
  // be a picture of nothing — the same rule `ResearchRun.graph` states.
  graph: { nodes: [], edges: [] },
  writerModelId: MODEL,
  correlationId: "",
  error: "",
  createdAt: "2026-09-01T08:20:00.000Z",
  updatedAt: "2026-09-01T08:23:00.000Z",
};

/** The Data Agent conversation the Fabric surface shows without a capacity. */
export const DEMO_DATA_AGENT_CHAT: DataAgentChat = {
  id: DEMO_DATA_AGENT_CHAT_ID,
  title: "Which customers had more than two open issues last quarter?",
  exchanges: [
    {
      id: "dax_sample_demo_01",
      question: "Which customers had more than two open issues last quarter?",
      answer: DATA_AGENT_ANSWER,
      trace: [
        "resolved the published Data Agent endpoint",
        "read the semantic model: Customer, Issue",
        "generated a DAX query and ran it",
        "4 rows returned",
      ],
      failed: false,
      askedAt: "2026-09-01T09:02:00.000Z",
    },
  ],
  startedAt: "2026-09-01T09:02:00.000Z",
  updatedAt: "2026-09-01T09:02:00.000Z",
};
