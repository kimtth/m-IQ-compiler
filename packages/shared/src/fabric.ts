import { z } from "zod";

/**
 * Microsoft Fabric contracts.
 *
 * Co-create mode uses the GitHub Copilot SDK as an agentic coding loop to create
 * Microsoft Fabric artifacts through the Fabric REST API and verify them. This
 * module follows three product rules.
 *
 * **The Azure identity is the only credential.** Fabric is reached with a
 * token for `https://api.fabric.microsoft.com`, minted from the same Azure CLI
 * session everything else here uses. No key, connection string or secret
 * appears in this module, so a Fabric connection is safe to persist and safe to
 * show.
 *
 * **Artifact creation is an agentic run, not a fixed template.** A
 * lakehouse worth having depends on the data it is built from, so the pipeline
 * is a governed agent turn with real Fabric knowledge in front of it rather
 * than a switch statement over seven artifact kinds.
 *
 * **Fabric API guidance is resolved at run time.** The agent is grounded on
 * `microsoft/skills-for-fabric` — the upstream Microsoft skill bundle —
 * resolved from the machine at run time. Fabric's APIs move; a vendored
 * snapshot of how to call them is a liability with a shelf life, and
 * {@link FabricSkillPack} exists so the app can say exactly which version it is
 * standing on.
 */

/** Fabric workspace and item ids are GUIDs. Checked before anything is dialled. */
export const FABRIC_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const FABRIC_API_ROOT = "https://api.fabric.microsoft.com/v1";

/**
 * The published Fabric Data Agent surface is an OpenAI-compatible Assistants
 * API and versions independently of the Fabric item API.
 */
export const DATA_AGENT_API_VERSION = "2024-05-01-preview";

/**
 * A Fabric connection, as the user registers it in *Connections & access*.
 *
 * There is no key field and there never will be, for the same reason the Speech
 * and Foundry registries have none: the resource is reached with the signed-in
 * Azure identity. A workspace id is a network destination, not a secret.
 *
 * **The workspace and nothing else.** The Data Agent used to be a field here
 * and is now {@link FabricDataAgentConnectionInput}, because they are two
 * different decisions with two different lifetimes: a tenant may let a user
 * create artifacts and publish no Data Agent at all, and the reverse — asking
 * questions of a published agent while never building anything — is just as
 * common, and used to require registering a workspace the user had no use for.
 */
export const FabricConnectionInput = z.object({
  displayName: z.string().min(1).max(120).default("Microsoft Fabric"),
  workspaceId: z
    .string()
    .trim()
    .regex(FABRIC_GUID, "the workspace id must be the GUID from the Fabric workspace URL"),
  /** Cosmetic; the id is what is dialled. Filled in from the API when listed. */
  workspaceName: z.string().max(200).default(""),
});
export type FabricConnectionInput = z.input<typeof FabricConnectionInput>;
export type FabricConnection = z.infer<typeof FabricConnectionInput>;

export const FabricStatus = z.discriminatedUnion("state", [
  /** No workspace registered; the Fabric surface stays inert. */
  z.object({ state: z.literal("not_configured"), message: z.string() }),
  z.object({
    state: z.literal("ready"),
    /** Always the Azure identity. Stated as a field so the UI can say it plainly. */
    auth: z.literal("entra"),
    displayName: z.string(),
    workspaceId: z.string(),
    workspaceName: z.string(),
    source: z.enum(["user", "environment"]),
    editable: z.boolean(),
  }),
]);
export type FabricStatus = z.infer<typeof FabricStatus>;

/**
 * How a Data Agent is reached.
 *
 * The two routes are reachable by different people. `workspace` composes the
 * endpoint from the registered Fabric workspace and the Data Agent's item id,
 * which is what someone who can see the agent in the portal already has.
 * `direct` takes the published URL verbatim, which is what someone who was
 * *sent* an agent has and who may have no rights on the workspace at all.
 *
 * Both dial the same API with the same token. The difference is only what the
 * user has to know.
 */
export const FabricDataAgentMode = z.enum(["workspace", "direct"]);
export type FabricDataAgentMode = z.infer<typeof FabricDataAgentMode>;

export const FabricDataAgentConnectionInput = z
  .object({
    displayName: z.string().min(1).max(120).default("Fabric Data Agent"),
    mode: FabricDataAgentMode.default("workspace"),
    /**
     * Workspace mode. Empty falls back to the registered Fabric workspace,
     * which is the ordinary case; it is settable so an agent in a *different*
     * workspace can be reached without re-registering the one being built in.
     */
    workspaceId: z.string().trim().default(""),
    /** Workspace mode: the Data Agent item's GUID, from its portal URL. */
    dataAgentId: z.string().trim().default(""),
    /** Direct mode: the published URL, verbatim. */
    url: z.string().trim().max(2048).default(""),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "workspace") {
      if (!FABRIC_GUID.test(value.dataAgentId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dataAgentId"],
          message: "the Data Agent id must be the GUID from its Fabric URL",
        });
      }
      if (value.workspaceId !== "" && !FABRIC_GUID.test(value.workspaceId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["workspaceId"],
          message: "the workspace id must be a GUID, or empty to use the registered workspace",
        });
      }
      return;
    }
    if (!/^https:\/\//i.test(value.url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "the published Data Agent URL must be an https URL",
      });
    }
  });
export type FabricDataAgentConnectionInput = z.input<typeof FabricDataAgentConnectionInput>;
export type FabricDataAgentConnection = z.infer<typeof FabricDataAgentConnectionInput>;

/**
 * The Assistants base URL for a workspace-mode connection.
 *
 * Kept in a single place on purpose: the `aiassistant/openai` suffix is not
 * guessable, and a second copy of it is a second thing to get wrong.
 */
export const dataAgentUrlFor = (workspaceId: string, dataAgentId: string): string =>
  `${FABRIC_API_ROOT}/workspaces/${workspaceId}/dataagents/${dataAgentId}/aiassistant/openai`;

export const FabricDataAgentStatus = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_configured"), message: z.string() }),
  /**
   * Registered in workspace mode, but there is no workspace to compose the URL
   * from. Distinct from `not_configured` because the user did their part and
   * the remedy is somewhere else entirely.
   */
  z.object({ state: z.literal("needs_workspace"), message: z.string(), displayName: z.string() }),
  z.object({
    state: z.literal("ready"),
    auth: z.literal("entra"),
    displayName: z.string(),
    mode: FabricDataAgentMode,
    /** Host only: the path carries workspace and item ids. */
    host: z.string(),
    /** Resolved workspace, when the mode composes one. Empty for `direct`. */
    workspaceId: z.string().default(""),
    source: z.enum(["user", "environment"]),
    editable: z.boolean(),
  }),
]);
export type FabricDataAgentStatus = z.infer<typeof FabricDataAgentStatus>;

/**
 * One workspace the signed-in identity can see.
 *
 * Listing exists because the id is a GUID and the user has several. Typing a
 * GUID from memory is not a real option, and pasting the wrong one is silent —
 * it registers fine and the first sign of trouble is a lakehouse in someone
 * else's workspace. The picker turns that into a named choice.
 *
 * `capacityId` is carried because a workspace with none cannot be written to:
 * Fabric refuses every write on it with a 403 that reads like a permission
 * problem. Better to say so in the picker than to debug it after the fact.
 */
export const FabricWorkspace = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string().default(""),
  /** Empty when the workspace sits on no capacity. */
  capacityId: z.string().default(""),
});
export type FabricWorkspace = z.infer<typeof FabricWorkspace>;

/** One item already in the workspace, as the Fabric item API reports it. */
export const FabricItem = z.object({
  id: z.string(),
  displayName: z.string(),
  /** `Lakehouse`, `SemanticModel`, `Notebook`, … — Fabric's own vocabulary. */
  type: z.string(),
  description: z.string().default(""),
  workspaceId: z.string(),
});
export type FabricItem = z.infer<typeof FabricItem>;

/**
 * The workspace item list, with the time it was read.
 *
 * The list is cached on disk so the surface opens with items already on it.
 * `fetchedAt` is part of the answer rather than a detail of the cache: a list
 * read an hour ago is still useful, but only if the reader can see that is
 * what it is.
 */
export const FabricItemList = z.object({
  workspaceId: z.string(),
  items: z.array(FabricItem).default([]),
  /** ISO time of the last successful read. Empty when never read. */
  fetchedAt: z.string().default(""),
});
export type FabricItemList = z.infer<typeof FabricItemList>;

/**
 * What a co-creation run was asked to produce.
 *
 * The artifact set uses Fabric names rather than app labels. A run may target
 * any subset; asking for a semantic model over a lakehouse that does not exist
 * yet is a normal request, and the agent orders the work.
 */
export const FabricArtifactKind = z.enum([
  "etl",
  "lakehouse",
  "semanticModel",
  "ontology",
  "graph",
  "dataAgent",
  "validationSql",
]);
export type FabricArtifactKind = z.infer<typeof FabricArtifactKind>;

export const FABRIC_ARTIFACT_LABELS = {
  etl: "ETL scripts",
  lakehouse: "Lakehouse",
  semanticModel: "Semantic model",
  ontology: "Ontology",
  graph: "Graph",
  dataAgent: "Data Agent",
  validationSql: "Validation SQL",
} as const satisfies Record<FabricArtifactKind, string>;

export const FabricRunStatus = z.enum(["preparing", "running", "succeeded", "failed", "cancelled"]);
export type FabricRunStatus = z.infer<typeof FabricRunStatus>;

/**
 * One co-creation run.
 *
 * `sourceFiles` is the allow-list, not a folder. Source reads are limited to
 * files explicitly present in the workspace list because a pipeline pointed at a
 * folder ingests whatever happens to be in it, which is how unrelated local
 * data ends up described in a shared Fabric workspace.
 */
export const FabricRun = z.object({
  id: z.string(),
  workspaceId: z.string(),
  status: FabricRunStatus,
  objective: z.string(),
  kinds: z.array(FabricArtifactKind),
  /** Workspace-relative paths the user chose. Nothing else is read. */
  sourceFiles: z.array(z.string()).default([]),
  /** Session that ran the pipeline, so the reasoning stays inspectable. */
  sessionId: z.string().nullable().default(null),
  /** Absolute path to this run's own output directory. */
  outputDir: z.string().default(""),
  /** Items the run reports having created, by Fabric id. */
  created: z.array(FabricItem).default([]),
  /** Which skills-for-fabric release grounded the run. */
  skillPackVersion: z.string().default(""),
  summary: z.string().default(""),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable().default(null),
  error: z.string().nullable().default(null),
  correlationId: z.string(),
});
export type FabricRun = z.infer<typeof FabricRun>;

/**
 * The upstream Microsoft Fabric skill bundle, as resolved on this machine.
 *
 * `microsoft/skills-for-fabric` ships focused bundles (`fabric-authoring`,
 * `fabric-consumption`, …), each a directory of `SKILL.md` files plus shared
 * `common/` references. This shape is what the app reports and what the agent's
 * prompt is built from, so a run can always answer "which guidance produced
 * this?" with a version rather than a shrug.
 */
export const FabricSkillEntry = z.object({
  name: z.string(),
  /** First line of the SKILL.md frontmatter description. */
  description: z.string().default(""),
  /** Absolute path to the skill directory holding SKILL.md. */
  directory: z.string(),
  /** Which bundle it came from, e.g. `fabric-authoring`. */
  bundle: z.string(),
});
export type FabricSkillEntry = z.infer<typeof FabricSkillEntry>;

/**
 * One `agents/<Name>.agent.md` from a bundle.
 *
 * A bundle ships more than skills. An agent file is a persona plus a routing
 * policy over the skills beside it, and it is the artifact that decides *which*
 * skill answers a request — so a reader who can see the skills but not the
 * agents can see the vocabulary and not the grammar.
 */
export const FabricAgentEntry = z.object({
  name: z.string(),
  description: z.string().default(""),
  /** Absolute path to the `.agent.md` file. */
  path: z.string(),
  bundle: z.string(),
});
export type FabricAgentEntry = z.infer<typeof FabricAgentEntry>;

/**
 * One shared `common/<NAME>.md` reference.
 *
 * Listed by name and path only. These are the documents the skills point at
 * for the parts they have in common, so they are worth being able to open —
 * but summarising them here would duplicate content this app does not own.
 */
export const FabricReferenceEntry = z.object({
  name: z.string(),
  path: z.string(),
  bundle: z.string(),
});
export type FabricReferenceEntry = z.infer<typeof FabricReferenceEntry>;

/**
 * One bundle in the resolved pack, as its own `plugin.json` describes it.
 *
 * The pack is not one thing with one version: `fabric-authoring` and
 * `fabric-consumption` ship and move separately, so "which guidance produced
 * this?" is only answerable per bundle.
 */
export const FabricBundleEntry = z.object({
  name: z.string(),
  description: z.string().default(""),
  version: z.string().default(""),
  /** MCP servers the bundle declares in its `.mcp.json`, by name. */
  mcpServers: z.array(z.string()).default([]),
});
export type FabricBundleEntry = z.infer<typeof FabricBundleEntry>;

export const FabricSkillPack = z.object({
  available: z.boolean(),
  /**
   * Where the bundle was found. `prepared` is the copy
   * `pnpm prepare:fabric-skills` downloaded; `copilot` is an existing
   * `/plugin install …@fabric-collection`; `setting` and `environment` are
   * explicit overrides.
   */
  source: z.enum(["setting", "environment", "prepared", "copilot", "missing"]).default("missing"),
  root: z.string().default(""),
  /** Release the resolved copy reports, when it declares one. */
  version: z.string().default(""),
  bundles: z.array(z.string()).default([]),
  /** The same bundles with what each of them declares about itself. */
  bundleDetails: z.array(FabricBundleEntry).default([]),
  skills: z.array(FabricSkillEntry).default([]),
  agents: z.array(FabricAgentEntry).default([]),
  references: z.array(FabricReferenceEntry).default([]),
  /** What is missing and how to get it. Empty when available. */
  message: z.string().default(""),
});
export type FabricSkillPack = z.infer<typeof FabricSkillPack>;

export const FABRIC_SKILLS_REPO = "https://github.com/microsoft/skills-for-fabric";

export const FABRIC_SKILLS_HINT =
  `The Microsoft Fabric skill bundle was not found. Run \`pnpm prepare:fabric-skills\` to download ` +
  `the latest release of ${FABRIC_SKILLS_REPO}, install it into GitHub Copilot CLI with ` +
  `\`/plugin install fabric-skills@fabric-collection\`, or point IQ_FABRIC_SKILLS at a clone. ` +
  `Fabric co-creation runs without it are refused rather than guessed at.`;

/** One answer from the published Fabric Data Agent, with its run trace. */
export const FabricAnswer = z.object({
  answer: z.string(),
  /** Thread, run status and tool calls — enough to explain a wrong answer. */
  trace: z.array(z.string()).default([]),
  threadId: z.string().default(""),
});
export type FabricAnswer = z.infer<typeof FabricAnswer>;

/** One question and what came back, kept whether or not it worked. */
export const DataAgentExchange = z.object({
  id: z.string(),
  question: z.string(),
  /** The answer, or the failure message when `failed` is true. */
  answer: z.string(),
  trace: z.array(z.string()).default([]),
  failed: z.boolean().default(false),
  askedAt: z.string().datetime(),
});
export type DataAgentExchange = z.infer<typeof DataAgentExchange>;

/**
 * One Data Agent conversation.
 *
 * The id is also the session id sent to the Data Agent, so a new conversation
 * here is a new thread there. That is the whole point of the New conversation
 * button: without it, every question a user ever asked shared one server-side
 * thread, and an unrelated question inherited context from the last one.
 *
 * A failed exchange is kept. "It could not answer that" is a fact about the
 * warehouse and the question, and dropping it makes the transcript lie.
 */
export const DataAgentChat = z.object({
  id: z.string(),
  /** The first question, shortened. Empty until something is asked. */
  title: z.string().default(""),
  exchanges: z.array(DataAgentExchange).default([]),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DataAgentChat = z.infer<typeof DataAgentChat>;

/**
 * Bounded file context handed to a run.
 *
 * The caps keep readable text inlined per file and in total, and anything past
 * that is summarised through the context-creation path rather than truncated
 * silently in the middle of a schema.
 */
export const MAX_INLINE_FILE_BYTES = 64 * 1024;
export const MAX_INLINE_TOTAL_BYTES = 256 * 1024;
