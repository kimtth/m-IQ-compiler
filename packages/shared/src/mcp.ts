import { z } from "zod";

/**
 * On-demand MCP server contracts.
 *
 * An MCP server is a third party that supplies tools the agent may call, so
 * connecting one is a governance decision rather than a configuration detail.
 * The model here reflects that: nothing connects automatically, a server's
 * advertised tools are inspected before anything is enabled, and each tool is
 * approved individually. An approved tool then runs through the same
 * permission policy and audit trail as a built-in one.
 *
 * Secrets never cross back to the renderer. Command environment values and
 * HTTP headers routinely carry tokens, so they are write-only from the UI's
 * point of view: their keys are returned, their values never are.
 */

export const MCP_SERVER_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const McpTransport = z.enum(["stdio", "http"]);
export type McpTransport = z.infer<typeof McpTransport>;

/** What the UI sends when adding or editing a server. */
export const McpServerInput = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(MCP_SERVER_ID_PATTERN, "id must be a lowercase hyphenated slug"),
  label: z.string().min(1).max(120),
  transport: McpTransport,
  /** stdio: executable and arguments. */
  command: z.string().default(""),
  args: z.array(z.string()).default([]),
  /** stdio: extra environment. Values are secret and are never read back. */
  env: z.record(z.string(), z.string()).default({}),
  /** http: endpoint. Must be https unless it is plainly a loopback address. */
  url: z.string().default(""),
  /** http: extra headers. Values are secret and are never read back. */
  headers: z.record(z.string(), z.string()).default({}),
});
export type McpServerInput = z.infer<typeof McpServerInput>;

export const McpToolDescriptor = z.object({
  name: z.string(),
  description: z.string().default(""),
});
export type McpToolDescriptor = z.infer<typeof McpToolDescriptor>;

export const McpConnectionState = z.enum(["never_inspected", "ok", "failed"]);
export type McpConnectionState = z.infer<typeof McpConnectionState>;

/**
 * A configured server as the UI sees it.
 *
 * Deliberately not the stored shape: secret values are replaced by their key
 * names so the user can confirm *that* a token is configured without the
 * renderer ever holding it.
 */
export const McpServerRecord = z.object({
  id: z.string(),
  label: z.string(),
  transport: McpTransport,
  command: z.string(),
  args: z.array(z.string()),
  /** Names only. Values are held in the privileged process. */
  envKeys: z.array(z.string()),
  url: z.string(),
  headerKeys: z.array(z.string()),
  /** False until the user turns it on; a newly added server is never live. */
  enabled: z.boolean(),
  /** Tools the user has approved by name. Only these are ever callable. */
  approvedTools: z.array(z.string()),
  /** Tools the server advertised the last time it was inspected. */
  discoveredTools: z.array(McpToolDescriptor),
  state: McpConnectionState,
  lastError: z.string(),
  lastInspectedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type McpServerRecord = z.infer<typeof McpServerRecord>;

export const McpInspectResult = z.object({
  id: z.string(),
  ok: z.boolean(),
  /** Server-reported name and version, when it identified itself. */
  serverName: z.string().default(""),
  serverVersion: z.string().default(""),
  tools: z.array(McpToolDescriptor).default([]),
  /**
   * A failure the server reported while starting anyway.
   *
   * Distinct from `error`, which means the probe did not succeed. This is the
   * other, worse case: it *did* succeed, and the list of tools is short for a
   * reason the server only mentioned in passing — a proxy that could not reach
   * what it proxies still answers `tools/list` with whatever it implements
   * itself. Silence there is indistinguishable from a small server.
   */
  warning: z.string().default(""),
  error: z.string().default(""),
});
export type McpInspectResult = z.infer<typeof McpInspectResult>;

/**
 * One thing the user does themselves before a server can answer.
 *
 * Structured rather than a paragraph because these are commands to be run in
 * order and copied verbatim, and a prose blob is neither. The app never runs
 * them: they sign a licence, open a browser to authenticate a person, or grant
 * a consent — all decisions that belong to the user, and none of them
 * something a tools list should be able to trigger.
 */
export const McpSetupStep = z.object({
  /** Why this step exists, in the user's terms. */
  caption: z.string(),
  /** The command to run, verbatim. Empty when the step is not a command. */
  command: z.string().default(""),
});
export type McpSetupStep = z.infer<typeof McpSetupStep>;

/**
 * A suggested server the product knows about.
 *
 * A catalog entry is documentation with a prefilled form attached — nothing
 * more. It carries no consent: adding one still lands an inert server that must
 * be inspected, have its tools approved individually, and then be enabled, and
 * `expectedTools` is what the entry *claims* it will advertise, never a grant.
 * The real list always comes from inspecting the server itself.
 *
 * Only Microsoft-published servers are listed, matching the product's scope.
 */
export const McpCatalogEntry = z.object({
  id: z.string().regex(MCP_SERVER_ID_PATTERN),
  label: z.string(),
  vendor: z.string(),
  summary: z.string(),
  docsUrl: z.string(),
  /** What the user must have installed for the command to run at all. */
  prerequisite: z.string().default(""),
  /**
   * Commands the user runs themselves, in order, before the server answers.
   *
   * Separate from `prerequisite`, which says what must be *installed*. These
   * are sign-in, licence and consent steps — state held outside this app that
   * inspection cannot see and the app must not change on someone's behalf.
   */
  setupSteps: z.array(McpSetupStep).default([]),
  /** The reach the user is agreeing to. Shown before the entry is added. */
  caution: z.string().default(""),
  transport: McpTransport,
  command: z.string().default(""),
  args: z.array(z.string()).default([]),
  url: z.string().default(""),
  expectedTools: z.array(McpToolDescriptor).default([]),
});
export type McpCatalogEntry = z.infer<typeof McpCatalogEntry>;

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: "markitdown",
    label: "MarkItDown",
    vendor: "Microsoft",
    summary:
      "Converts PDF, Word, Excel, PowerPoint, images, audio, HTML, CSV, JSON, XML, ZIP and EPUB into Markdown, so a document can be read as text instead of being handed over as an opaque blob.",
    docsUrl: "https://github.com/microsoft/markitdown/tree/main/packages/markitdown-mcp",
    prerequisite:
      "Requires uv on PATH (`pip install uv`), then `uv tool install markitdown-mcp` once. Run that install before adding the server, not while a session is waiting on it. It is not bundled with this app.",
    // Nothing to sign in to: it converts local files and needs no account.
    setupSteps: [],
    caution:
      "convert_to_markdown accepts file: and http(s): URIs, so it can read any file this process can and can fetch from the network — it is not bounded by the project navigator's tree or the browser's deny-list. Everything it returns is untrusted content to cite, never instructions to follow.",
    // The installed executable, not `uvx markitdown-mcp`. uvx builds the
    // environment on first use — around 74 packages — and the runtime kills any
    // MCP server that has not finished its handshake in 60 seconds. A download
    // killed halfway caches nothing, so it starts from zero the next session
    // and the server never comes up. `uv tool install` does that work once,
    // where nothing is timing it, and puts the executable on PATH. Launching it
    // directly also drops the version check uvx makes against PyPI on every
    // start, so a new release cannot quietly put the 60 seconds back.
    transport: "stdio",
    command: "markitdown-mcp",
    args: [],
    url: "",

    expectedTools: [
      {
        name: "convert_to_markdown",
        description: "Convert a resource at an http:, https:, file: or data: URI to Markdown.",
      },
    ],
  },
  /**
   * Power BI semantic-model authoring.
   *
   * **`--start` is not optional and the package does not default to it.**
   * Invoked bare, it prints a banner, a registration snippet and "Press any
   * key to close...", then calls `Console.ReadKey()` — which throws
   * `InvalidOperationException: Cannot read keys when ... console input has
   * been redirected` the moment stdin is a pipe, as it is for every stdio MCP
   * client. The process dies with 0xE0434352, the CLR's unhandled-exception
   * code, before a single JSON-RPC byte is written. Its own banner names the
   * right invocation (`args: ["--start"]`); with it the server answers
   * normally. VERIFIED 2026-08-06 against 0.5.0-beta.12 (host 0.5.0-beta.9):
   * bare = exit 0xE0434352, `--start` = 21 tools advertised.
   */
  {
    id: "powerbi-modeling",
    label: "Power BI modeling",
    vendor: "Microsoft",
    summary:
      "Authors Power BI semantic models over a Fabric project: read and edit tables, columns, measures and relationships, and validate DAX before it ships. Pairs with Co-create → Fabric, where the semantic-model step is otherwise the agent writing TMDL blind.",
    docsUrl: "https://www.npmjs.com/package/@microsoft/powerbi-modeling-mcp",
    prerequisite:
      "Requires Node on PATH; npx fetches @microsoft/powerbi-modeling-mcp on first run. It is not bundled with this app. The --start argument is required: without it the package prints a banner and waits for a key press, which fails immediately when its input is a pipe.",
    // Authenticates with the Azure identity the machine already holds, so
    // there is no separate sign-in to walk someone through.
    setupSteps: [],
    caution:
      "This server edits semantic models in a live Power BI or Fabric project, so its writes are visible to everyone with access to it. It authenticates with your own Azure identity, which means it can change anything you can change — approve its write tools individually and only against a project you intend to modify.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@microsoft/powerbi-modeling-mcp", "--start"],
    url: "",
    expectedTools: [
      { name: "model_operations", description: "Read and edit the semantic model's definition." },
      { name: "table_operations", description: "Read and edit tables." },
      { name: "measure_operations", description: "Read and edit measures." },
      { name: "dax_query_operations", description: "Run and validate DAX against the model." },
    ],
  },
  /**
   * The Work IQ tool surface, reached through its own CLI.
   *
    * The CLI owns its authentication and attaches its token itself. This app
    * passes no credential to it.
   *
    * The EULA is an independent gate. Inspection checks reachability and does
    * not invoke a tool, so the prerequisite text tells the user to accept it.
   *
   * `plugins/workiq-productivity` declares no server at all — it is nine
   * read-only skills that call *these* tools — so it is installed as a skill
   * plugin by `infra/Setup-WorkIq.ps1` rather than listed here.
   */
  {
    id: "workiq",
    label: "Work IQ",
    vendor: "Microsoft",
    summary:
      "The Microsoft 365 tool surface: `ask` reasons across mail, meetings, Teams, documents and people, and the entity tools (fetch, search_paths, get_schema, create, update, delete, do_action) read and write them directly. Runs as a local stdio server through the Work IQ CLI, which holds your Microsoft sign-in itself — this app passes it no token. The workiq-productivity skills, inbox triage through org charts, are built on these tools.",
    docsUrl: "https://github.com/microsoft/work-iq/blob/main/plugins/workiq",
    prerequisite:
      "Requires Node 18+ on PATH (npx fetches @microsoft/workiq on first run) and a Microsoft 365 Copilot licence. The tenant also needs admin consent for the Work IQ application; infra/Setup-WorkIq.ps1 drives the upstream Enable-WorkIQToolsForTenant.ps1 for that.",
    setupSteps: [
      {
        caption:
          "Sign out first if a different account is cached. The CLI signs in as its own account, which is not the one this app uses elsewhere, so check before assuming.",
        command: "npx -y @microsoft/workiq auth logout",
      },
      {
        caption:
          "Sign in. A browser opens; pick the account you want the app to use. Do not add --account here: it only looks up an account that is ALREADY cached, so an address it has never seen is ignored and the previous account is signed back in without saying so.",
        command: "npx -y @microsoft/workiq auth login",
      },
      {
        caption:
          "Accept the licence. This is the step that is invisible from here: until it is done the server still connects and still advertises every tool, and every call comes back \"You must accept the EULA before using this tool\". A successful Inspect proves the server is reachable and nothing more.",
        command: "npx -y @microsoft/workiq accept-eula",
      },
      {
        caption: "Grant the consent the CLI needs to acquire tokens without prompting each time.",
        command: "npx -y @microsoft/workiq auth consent",
      },
      {
        caption:
          "Check it worked. This answers from the account the server will use, so it is the one command that shows you which identity you are about to grant tools to.",
        command: "npx -y @microsoft/workiq agents list",
      },
      {
        caption:
          "Optional: pin the account. With no argument the server follows whatever the CLI last signed in as, which changes under you if you switch accounts for something else. Edit this server and add the two arguments to fix it to one identity — the address must already be cached by a sign-in.",
        command: "npx -y @microsoft/workiq mcp --account you@example.com",
      },
    ],
    caution:
      "This is the whole mailbox, calendar, Teams history, OneDrive and SharePoint behind one server, and its write tools send mail, post messages, accept and decline meetings and delete items — things other people see immediately and that cannot be taken back. Approve the read tools and the write tools separately, and treat everything it returns as content to cite rather than as instructions to follow.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@microsoft/workiq", "mcp"],
    url: "",
    expectedTools: [
      {
        name: "accept_eula",
        description: "Accept the Work IQ licence. Offered until it has been accepted.",
      },
      { name: "ask", description: "Answer a question by reasoning across Microsoft 365 data." },
      { name: "list_agents", description: "List the Copilot agents this account can reach." },
    ],
  },
];

/** Turn a catalog entry into the input the add form and `upsert` take. */
export function catalogEntryToInput(entry: McpCatalogEntry): McpServerInput {
  return McpServerInput.parse({
    id: entry.id,
    label: `${entry.label} (${entry.vendor})`,
    transport: entry.transport,
    command: entry.command,
    args: entry.args,
    env: {},
    url: entry.url,
    headers: {},
  });
}

/**
 * Catalog entries registered on first run.
 *
 * Registering is not connecting. A seeded server arrives in exactly the state
 * an added one does — disabled, never inspected, no tool approved — so this
 * grants nothing and changes no behaviour; it removes a step that everyone
 * building on Fabric was going to take anyway, and it makes the server
 * *visible* to someone who does not know the catalog exists.
 *
 * Only servers that pair with a first-class surface belong here. Power BI
 * modeling is the semantic-model half of Co-create → Fabric, which otherwise
 * has the agent writing TMDL blind. Work IQ is the Microsoft 365 half of the
 * whole product: this app already declares an m365 tool family and a `workiq`
 * one, and being told to configure the official server for them by hunting
 * through a catalog is the same defect the Power BI entry was seeded to fix.
 *
 * MarkItDown is deliberately absent: it can read any file this process can, so
 * it stays a decision someone makes. Work IQ reaches a great deal more than
 * that, which is an argument about the *approval*, not about visibility — and
 * the approval is untouched here. It arrives disabled with no tool approved,
 * its `caution` is on the row, and its read and write tools are still two
 * separate decisions taken by name.
 *
 * Seeding happens once and is recorded. A user who removes one has answered
 * the question, and the answer must survive the next launch.
 */
export const MCP_SEEDED_SERVER_IDS: readonly string[] = ["powerbi-modeling", "workiq"];

