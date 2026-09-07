import { z } from "zod";
import { SampleModuleId } from "./samples.js";
import { PermissionDecision } from "./permission.js";
import { ScheduledJob, Trigger, RetryPolicy } from "./schedule.js";
import { SkillProposal } from "./skill.js";
import { SkillEvolutionInput } from "./evolution.js";
import { McpServerInput } from "./mcp.js";
import { MyIqPublishInput } from "./myiq.js";
import { AudioMimeType, MAX_AUDIO_BASE64_CHARS, MAX_SYNTHESIS_CHARS, SpeechResourceInput } from "./speech.js";
import { AudioSource } from "./meeting.js";
import { AnalysisFeedback, AnalysisStep, BuildKind, RecordingPlan } from "./recording.js";
import { MediaSettingsInput, TranscriptionEngine } from "./media.js";
import { MemoryEdit, MemoryStatus } from "./memory.js";
import { FoundryModelInput, ModelRole } from "./model.js";
import {
  FabricArtifactKind,
  FabricConnectionInput,
  FabricDataAgentConnectionInput,
} from "./fabric.js";
import { ImageRequest } from "./image.js";
import { ResearchRefineInput, ResearchStartInput } from "./research.js";
import { CouncilRenameInput, CouncilStartInput } from "./council.js";
import { OfficePreviewFormat } from "./office.js";
import { SessionPlace, SubMode } from "./mode.js";
import { BrowserInput } from "./browser.js";
/**
 * The response shapes, imported through the barrel.
 *
 * Type-only, so nothing is emitted and the cycle with `index.ts` is erased.
 * `ScheduledJob` and `RecordingPlan` are absent because they are already
 * imported above as *values*: the request schemas parse them.
 */
import type {
  AuditRecord,
  AuthStatus,
  BrowserState,
  CopilotAuthStatus,
  CouncilPreset,
  CouncilRun,
  DataAgentChat,
  FabricAnswer,
  FabricDataAgentStatus,
  FabricItemList,
  FabricRun,
  FabricSkillPack,
  FabricStatus,
  FabricWorkspace,
  ImageRun,
  JobRun,
  KnowledgeGraph,
  KnowledgeHit,
  KnowledgeNodeDetail,
  KnowledgeSource,
  KnowledgeSummary,
  KnowledgeVaultState,
  McpInspectResult,
  McpServerRecord,
  MediaSettings,
  MediaStatus,
  MeetingRecord,
  MeetingTranscript,
  MemoryDerivation,
  MemoryRecord,
  ModelCatalog,
  MyIqPublishResult,
  MyIqStatus,
  OfficeDocument,
  OfficePreview,
  OfficeRender,
  OfficeStatus,
  RecorderStatus,
  RecordingAnalysis,
  RecordingBuild,
  RecordingRecord,
  ResearchRun,
  SampleStatus,
  SessionSummary,
  SessionSweep,
  SkillEvolutionStatus,
  SkillImportPreview,
  SkillRecord,
  SpeechStatus,
  SpeechTestResult,
  TenantSummary,
  TurnState,
  ProjectFile,
  ProjectListing,
  ProjectRecord
} from "./index.js";


/**
 * Typed IPC contract.
 *
 * The renderer is untrusted. Its only route into privileged code is this
 * contract, validated in the preload before it reaches main
 * (rowboat/mermaid.md section 2: "The preload exposes only the typed IPC surface
 * rather than Node or Electron APIs"; ms-scout/mermaid.md section 1: "their only
 * runtime boundary is the typed IPC contract"; orca/code-review-guide.md:
 * renderer is explicitly untrusted).
 */

export const IPC_REQUEST_SCHEMAS = {
  // --- the worked examples ------------------------------------------------
  /**
   * One family for every sample set in the app.
   *
   * There used to be a seed/clear pair per surface — `memory:seedSamples`,
   * `knowledge:clearSamples`, and so on — which meant five answers to "is any
   * of this made up?" and a global flag that governed none of them. The module
   * is a value now, not a channel name, so adding a sixth set adds no surface
   * area here at all.
   *
   * Payload-free beyond the module id, exactly as the per-surface channels
   * were: the UI chooses *whether* to load a set, never what is in it.
   */
  "samples:status": z.tuple([]),
  "samples:setEnabled": z.tuple([z.object({ enabled: z.boolean() })]),
  "samples:load": z.tuple([z.object({ module: SampleModuleId })]),
  "samples:clear": z.tuple([z.object({ module: SampleModuleId })]),

  // --- identity -----------------------------------------------------------
  "auth:status": z.tuple([]),
  /**
   * Sign in to Microsoft. The optional tenant id is a *preference*, not a
   * registration: blank means the account's home tenant.
   */
  "auth:signIn": z.tuple([z.object({ tenantId: z.string().nullable() }).optional()]),
  "auth:signOut": z.tuple([]),
  /** Request incremental consent for one capability, at first use. */
  "auth:consent": z.tuple([z.object({ capability: z.string() })]),
  /** The tenant the next Microsoft sign-in will target, or null for home. */
  "auth:tenant": z.tuple([]),
  "auth:setTenant": z.tuple([z.object({ tenantId: z.string().nullable() })]),
  /** GitHub Copilot connection state, read from the agent runtime. */
  "auth:copilotStatus": z.tuple([]),
  /**
   * Tenants the signed-in account can reach. Offered as a picker so switching
   * never requires pasting a GUID twice.
   */
  "auth:tenants": z.tuple([]),
  /**
   * Switch tenant after launch. Invalidates cached resource tokens and any
   * Foundry entry bound to the previous tenant, so it is a distinct channel
   * from `auth:setTenant`, which only records a preference for the next sign-in.
   */
  "auth:switchTenant": z.tuple([z.object({ tenantId: z.string().nullable() })]),

  // --- sessions and turns -------------------------------------------------
  "sessions:list": z.tuple([]),
  "sessions:create": z.tuple([
    z.object({
      title: z.string().optional(),
      /**
       * The destination the user picked when they started the conversation.
       *
       * This is the one place the shell may state where a conversation
       * belongs, and it is legitimate for the reason every other such message
       * was not: it is sent once, before the conversation exists, in answer to
       * a question the user was actually asked. It is stamped `chosen` on the
       * privileged side — the payload carries no source — and a place the
       * shell could not show is refused there rather than written.
       */
      place: SessionPlace.optional(),
    }),
  ]),
  /**
   * Name a conversation.
   *
   * A session names itself from the message it opened with, so this is the
   * correction rather than the only way one gets a name — but it has to exist:
   * the list is how a conversation is found again, and an auto-title taken from
   * a first question is often not what the thread turned out to be about.
   */
  "sessions:rename": z.tuple([
    z.object({ sessionId: z.string(), title: z.string().min(1).max(120) }),
  ]),
  "sessions:delete": z.tuple([z.object({ sessionId: z.string() })]),
  /**
   * Remove conversation data nothing can reach any more.
   *
   * `apply: false` reports what a sweep would remove and touches nothing, so
   * the user sees the count before they agree to it. `keepSessionId` is the
   * conversation on screen: it may well be empty, because it was just created,
   * and deleting it out from under the person looking at it would be absurd.
   */
  "sessions:sweep": z.tuple([
    z.object({ apply: z.boolean(), keepSessionId: z.string().max(200).default("") }),
  ]),
  /*
   * There is deliberately no `sessions:setPlace`.
   *
   * The shell used to send one whenever the mode, sub-mode or canvas tab
   * changed with a conversation selected. Every such message is ambiguous —
   * looking at a tab is not a statement about where the selected conversation
   * belongs — and on a real profile one deck conversation collected nine of
   * them, burying the correct place under six meaningless clicks. Where a
   * conversation belongs is either stated once on `sessions:create`, or
   * inferred on the privileged side from what the conversation did. Neither is
   * a report of where the window is pointing.
   */
  /** Empty a conversation's history while keeping the conversation itself. */
  "sessions:clear": z.tuple([z.object({ sessionId: z.string() })]),
  "sessions:sendMessage": z.tuple([
    z.object({
      sessionId: z.string(),
      content: z.string().min(1),
      skills: z.array(z.string()).default([]),
      /** Where the user was standing. Stamped onto the turn and the audit. */
      subMode: SubMode.default("conversation"),
      projectId: z.string().nullable().default(null),
      /** Per-turn model override from the composer; "" uses the role default. */
      modelId: z.string().default(""),
    }),
  ]),
  "sessions:getTurn": z.tuple([z.object({ turnId: z.string() })]),
  /** Every turn of a session, folded, so a reopened session shows its history. */
  "sessions:turns": z.tuple([z.object({ sessionId: z.string() })]),
  "sessions:stopTurn": z.tuple([z.object({ turnId: z.string(), reason: z.string() })]),
  /** Explicit resume path for a turn interrupted by a crash. */
  "sessions:resume": z.tuple([z.object({ sessionId: z.string() })]),
  "sessions:respondToPermission": z.tuple([
    z.object({
      turnId: z.string(),
      toolCallId: z.string(),
      decision: PermissionDecision,
    }),
  ]),

  // --- skills -------------------------------------------------------------
  "skills:list": z.tuple([]),
  "skills:setEnabled": z.tuple([z.object({ name: z.string(), enabled: z.boolean() })]),
  "skills:listProposals": z.tuple([]),
  "skills:propose": z.tuple([SkillProposal]),
  /** Human approval promotes an agent-authored skill to loadable. */
  "skills:approve": z.tuple([z.object({ name: z.string() })]),
  "skills:archive": z.tuple([z.object({ name: z.string() })]),
  /**
   * Import is two channels, not one: the user inspects a bundle and only then
   * installs it. A skill is prompt surface, so it is never accepted unseen.
   */
  "skills:chooseImport": z.tuple([]),
  "skills:inspectImport": z.tuple([z.object({ source: z.string() })]),
  "skills:import": z.tuple([z.object({ source: z.string() })]),
  "skills:approveInstalled": z.tuple([z.object({ name: z.string() })]),
  "skills:export": z.tuple([z.object({ name: z.string() })]),
  "skills:remove": z.tuple([z.object({ name: z.string() })]),

  /**
   * Skill evolution.
   *
   * `skills:evolve` starts a long run that spends model calls and ends at a
   * proposal — never at an installed skill, so the approval channels above are
   * still the only way anything becomes loadable. Status is separate because
   * the surface has to ask the same precondition question the privileged side
   * would refuse on, rather than offering the control and reporting a failure.
   */
  "skills:evolutionStatus": z.tuple([]),
  "skills:evolve": z.tuple([SkillEvolutionInput]),
  "skills:cancelEvolve": z.tuple([]),

  /**
   * MCP servers. Configuration, inspection, per-tool approval and enablement
   * are separate channels because they are separate decisions: nothing here
   * connects as a side effect of anything else.
   */
  "mcp:list": z.tuple([]),
  "mcp:upsert": z.tuple([McpServerInput]),
  "mcp:remove": z.tuple([z.object({ id: z.string() })]),
  "mcp:inspect": z.tuple([z.object({ id: z.string() })]),
  "mcp:approveTools": z.tuple([z.object({ id: z.string(), tools: z.array(z.string()) })]),
  "mcp:setEnabled": z.tuple([z.object({ id: z.string(), enabled: z.boolean() })]),

  /**
   * Publishing My IQ over MCP.
   *
   * The other direction from `mcp:*`, which is about servers this app calls.
   * `myiq:publish` carries the IQ Cell library because it lives in the
   * renderer's own storage and the privileged side cannot read it; everything
   * else in the snapshot is gathered privileged-side, where it can be filtered
   * against what is provably sample data. There is deliberately no channel for
   * *reading* the snapshot back into the app — it is written for other programs
   * to read, and a round trip through here would make it look like state this
   * app keeps.
   */
  "myiq:status": z.tuple([]),
  "myiq:publish": z.tuple([MyIqPublishInput]),

  // --- memory -------------------------------------------------------------
  "memory:list": z.tuple([
    z.object({ status: MemoryStatus.optional(), subject: z.string().optional() }).default({}),
  ]),
  /** Approving a memory is what makes it eligible for skill derivation. */
  "memory:approve": z.tuple([z.object({ id: z.string() })]),
  "memory:reject": z.tuple([z.object({ id: z.string() })]),
  /**
   * Correct a memory's subject, fact or rationale.
   *
   * Provenance is not in the payload and never will be: who proposed a memory,
   * from which turn, and who decided it are the record's value.
   */
  "memory:update": z.tuple([MemoryEdit]),
  "memory:delete": z.tuple([z.object({ id: z.string() })]),
  /** Compiled skill proposals and the memories each was built from. */
  "memory:derivations": z.tuple([]),
  /** Run a derivation pass on demand, e.g. after changing the threshold. */
  "memory:derive": z.tuple([]),

  // --- scheduler ----------------------------------------------------------
  "jobs:list": z.tuple([]),
  "jobs:create": z.tuple([
    z.object({
      name: z.string().min(1),
      objective: z.string().min(1),
      trigger: Trigger,
      toolFamilies: z.array(z.string()).default([]),
      skills: z.array(z.string()).default([]),
      retry: RetryPolicy.optional(),
    }),
  ]),
  "jobs:update": z.tuple([ScheduledJob.partial().extend({ id: z.string() })]),
  "jobs:setEnabled": z.tuple([z.object({ id: z.string(), enabled: z.boolean() })]),
  "jobs:runNow": z.tuple([z.object({ id: z.string() })]),
  "jobs:delete": z.tuple([z.object({ id: z.string() })]),
  "jobs:runs": z.tuple([z.object({ jobId: z.string(), limit: z.number().int().max(200).default(50) })]),

  // --- orchestration ------------------------------------------------------
  "orchestration:plans": z.tuple([]),
  "orchestration:plan": z.tuple([z.object({ planId: z.string() })]),
  "orchestration:cancel": z.tuple([z.object({ planId: z.string() })]),
  "orchestration:resolveGate": z.tuple([
    z.object({ gateId: z.string(), approved: z.boolean() }),
  ]),

  // --- knowledge graph ----------------------------------------------------
  "knowledge:graph": z.tuple([]),
  /**
   * Turn everything in the vault's `source/` into Obsidian notes, then rebuild
   * the graph from them. This replaced a bare reindex: rebuilding an index over
   * raw files draws a scattering of dots, because raw files link to nothing.
   */
  "knowledge:ingest": z.tuple([]),
  /** Pick files with the OS dialog and copy them into the vault's `source/`. */
  "knowledge:addSources": z.tuple([]),
  /** What is waiting in `source/`, which is not the same as what is indexed. */
  "knowledge:sources": z.tuple([]),
  /** Delete one file from `source/`. Refused for anything outside it. */
  "knowledge:removeSource": z.tuple([z.object({ path: z.string().min(1).max(1024) })]),
  "knowledge:search": z.tuple([
    z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(100).default(20) }),
  ]),
  "knowledge:node": z.tuple([z.object({ id: z.string().min(1) })]),
  /** The directory the graph indexes: the chosen vault, or the project. */
  "knowledge:vault": z.tuple([]),
  /** Pick a vault with the OS dialog; main owns the dialog, not the renderer. */
  "knowledge:chooseVault": z.tuple([]),
  /** Set the vault, or null to fall back to the project. Triggers a reindex. */
  "knowledge:setVault": z.tuple([
    z.object({ directory: z.string().max(4096).nullable() }),
  ]),

  // --- projects ---------------------------------------------------------
  /** Named projects: the unit of scoping for everything else. */
  "projects:list": z.tuple([]),
  "projects:create": z.tuple([
    z.object({ name: z.string().min(1).max(120), directory: z.string().max(4096).default("") }),
  ]),
  /** Pick a directory with the OS dialog; main owns the dialog, not the renderer. */
  "projects:choose": z.tuple([]),
  /** Adopt a chosen directory and bind it, in one step. */
  "projects:open": z.tuple([z.object({ directory: z.string().min(1).max(4096) })]),
  "projects:bind": z.tuple([z.object({ projectId: z.string().nullable() })]),
  "projects:remove": z.tuple([z.object({ projectId: z.string() })]),

  // --- project navigator ------------------------------------------------
  /** Paths are project-relative; main resolves and proves containment. */
  "project:list": z.tuple([z.object({ path: z.string().max(4096).default("") })]),
  "project:read": z.tuple([z.object({ path: z.string().min(1).max(4096) })]),
  /**
   * Show one project file in the OS file manager.
   *
   * The renderer names a project-relative path and nothing else: it cannot
   * ask for an arbitrary location, and main proves containment before handing
   * anything to the shell.
   */
  "project:reveal": z.tuple([z.object({ path: z.string().min(1).max(4096) })]),

  // --- models -------------------------------------------------------------
  /** One registry, edited only from Connections & access. */
  "models:catalog": z.tuple([]),
  "models:upsert": z.tuple([FoundryModelInput]),
  "models:remove": z.tuple([z.object({ id: z.string() })]),
  /** Minimal round-trip against one entry; stores the last-tested timestamp. */
  "models:test": z.tuple([z.object({ id: z.string() })]),
  "models:setDefault": z.tuple([
    z.object({
      role: ModelRole,
      modelId: z.string().nullable(),
      /** Null sets the global role default; a project id scopes it. */
      projectId: z.string().nullable().default(null),
    }),
  ]),

  // --- Office authoring ---------------------------------------------------
  /** OfficeCLI discovery and version. Never a command line from the renderer. */
  "office:status": z.tuple([]),
  "office:install": z.tuple([]),
  /**
   * Office artifacts already in the bound project, newest first.
   *
   * The surface needs this because `office:changed` only speaks about this
   * session. Without it, opening Office after a restart shows an empty preview
   * beside a project that already holds the deck the user wants to look at.
   */
  "office:documents": z.tuple([]),
  "office:preview": z.tuple([
    z.object({ path: z.string().min(1).max(4096), format: OfficePreviewFormat.default("html") }),
  ]),
  /**
   * Render through PowerPoint or Word rather than OfficeCLI's HTML view.
   *
   * A separate channel because it is a separate cost — 8–12 seconds, and it
   * starts an Office application. `page` null renders the whole document as one
   * contact sheet.
   */
  "office:render": z.tuple([
    z.object({
      path: z.string().min(1).max(4096),
      page: z.number().int().positive().max(10_000).nullable().default(null),
    }),
  ]),
  /**
   * Note the document a conversation is working on, and ask for it back.
   *
   * The preview was global: it followed the newest mutation from anywhere, so
   * moving between two conversations that each build something left the wrong
   * document on screen. These two make it belong to the conversation.
   *
   * The project is not a parameter. The privileged side reads the bound one, so
   * a renderer cannot file a document under a project it is not in.
   */
  "office:remember": z.tuple([
    z.object({
      sessionId: z.string().min(1).max(200),
      path: z.string().min(1).max(4096),
    }),
  ]),
  "office:recall": z.tuple([z.object({ sessionId: z.string().min(1).max(200) })]),

  // --- image creation -----------------------------------------------------
  "images:generate": z.tuple([ImageRequest]),
  "images:runs": z.tuple([]),
  /** Persist one generated image plus its provenance into the project. */
  "images:save": z.tuple([
    z.object({ runId: z.string(), imageId: z.string(), path: z.string().max(4096).default("") }),
  ]),
  /**
   * Drop one run from the history the surface shows.
   *
   * It forgets the run; it does not touch the project. An image that was
   * saved is a file the person owns, and deleting a card in a history list is
   * not consent to delete their file.
   */
  "images:delete": z.tuple([z.object({ runId: z.string() })]),
  /**
   * Drop a whole image conversation from the history.
   *
   * The surface lists conversations, so this is the delete it can offer.
   * Same rule as `images:delete`: it forgets, it does not touch the project.
   */
  "images:deleteThread": z.tuple([z.object({ threadId: z.string().min(1).max(200) })]),

  // --- research -----------------------------------------------------------
  "research:list": z.tuple([]),
  "research:start": z.tuple([ResearchStartInput]),
  "research:get": z.tuple([z.object({ runId: z.string() })]),
  /** Edit the plan before or between gathering passes. */
  "research:updatePlan": z.tuple([
    z.object({
      runId: z.string(),
      questions: z.array(z.object({ id: z.string().optional(), question: z.string().min(1) })),
    }),
  ]),
  "research:approvePlan": z.tuple([z.object({ runId: z.string() })]),
  /** Re-run one question without restarting the report. */
  "research:rerunQuestion": z.tuple([z.object({ runId: z.string(), questionId: z.string() })]),
  "research:write": z.tuple([z.object({ runId: z.string() })]),
  /**
   * Act on a reader's note about a finished report.
   *
   * Separate from `updatePlan` because the reader supplies prose, not
   * questions: deciding what to ask is the manager's turn, and it happens on
   * the privileged side where the plan's ceiling is enforced.
   */
  "research:refine": z.tuple([ResearchRefineInput]),
  "research:cancel": z.tuple([z.object({ runId: z.string() })]),
  /** Delete durable Research data. A report already written to the project stays there. */
  "research:delete": z.tuple([z.object({ runId: z.string() })]),

  // --- council (Chat → Team) ----------------------------------------------
  "council:presets": z.tuple([]),
  "council:savePreset": z.tuple([
    z.object({ name: z.string().min(1).max(80), description: z.string().max(400).default(""), members: CouncilStartInput.shape.members }),
  ]),
  "council:deletePreset": z.tuple([z.object({ id: z.string() })]),
  "council:list": z.tuple([]),
  "council:start": z.tuple([CouncilStartInput]),
  "council:get": z.tuple([z.object({ runId: z.string() })]),
  /** Inject a constraint or a challenge at a round boundary. */
  "council:inject": z.tuple([z.object({ runId: z.string(), text: z.string().min(1).max(2_000) })]),
  "council:forceVerdict": z.tuple([z.object({ runId: z.string() })]),
  "council:cancel": z.tuple([z.object({ runId: z.string() })]),
  /**
   * Name a run, or clear the name so it is called by its question again.
   *
   * Only the label. The question the members were given is not editable here
   * or anywhere — it is quoted in the transcript, the verdict and the audit
   * record, and a history whose question could be rewritten afterwards would
   * not be a history.
   */
  "council:rename": z.tuple([CouncilRenameInput]),
  /** Delete a run and its transcript. The exported verdict is left in place. */
  "council:delete": z.tuple([z.object({ runId: z.string() })]),

  // --- built-in browser ---------------------------------------------------
  "browser:state": z.tuple([]),
  /**
   * Reopen the page this conversation was last on, if there is one.
   *
   * A closed pane forgets its page, and so does a restart, so returning to the
   * browser meant an empty pane and a URL to find again. The last URL is
   * remembered in main and re-navigated through the same policy check as any
   * other navigation — a site that is denied now stays denied.
   *
   * Remembered per conversation, because a page belongs to the work that
   * opened it: one thread reading a paper and another watching a dashboard
   * should each come back to their own page, not to whichever was open last.
   * An empty id means no conversation is selected, and nothing is remembered
   * under it.
   */
  "browser:restore": z.tuple([z.object({ sessionId: z.string().max(200) })]),
  /** Navigation is policy-checked in main; the renderer only proposes a URL. */
  "browser:navigate": z.tuple([z.object({ url: z.string().min(1).max(4096) })]),
  "browser:back": z.tuple([]),
  "browser:forward": z.tuple([]),
  "browser:reload": z.tuple([]),
  "browser:stop": z.tuple([]),
  "browser:close": z.tuple([]),
  /**
   * User input forwarded into the page.
   *
   * Validated here rather than trusted, because this channel is the one place
   * the renderer can cause an act inside a remote page. The schema bounds
   * coordinates and text length; the main process still checks that a page is
   * open and that the pane is visible before dispatching.
   */
  "browser:input": z.tuple([BrowserInput]),
  /**
   * Layout: how large to render the page, and whether the tab is showing.
   * The size drives the real viewport, and visibility starts and stops the
   * screencast so a hidden tab costs nothing.
   */
  "browser:setBounds": z.tuple([
    z.object({
      x: z.number().int().min(-10_000).max(20_000),
      y: z.number().int().min(-10_000).max(20_000),
      width: z.number().int().min(0).max(20_000),
      height: z.number().int().min(0).max(20_000),
      visible: z.boolean().default(true),
    }),
  ]),

  // --- speech: voice input and spoken replies -----------------------------
  "speech:status": z.tuple([]),
  /** Connection check shown in Connections & access; a GET, never a synthesis. */
  "speech:test": z.tuple([]),
  /**
   * Register the Azure AI Speech resource, or replace the current one.
   *
   * There is no key field by design: the resource is reached with the signed-in
   * Azure identity, so this payload is a destination, not a credential.
   */
  "speech:register": z.tuple([SpeechResourceInput]),
  "speech:remove": z.tuple([]),
  /**
   * Transcribe one push-to-talk clip. The renderer holds the microphone; the
   * privileged side holds the credential and does the network call, so the
   * Speech key or Entra token is never reachable from renderer code.
   */
  "speech:transcribe": z.tuple([
    z.object({
      audioBase64: z.string().min(1).max(MAX_AUDIO_BASE64_CHARS),
      mimeType: AudioMimeType,
      locale: z.string().optional(),
    }),
  ]),
  "speech:synthesize": z.tuple([
    z.object({
      text: z.string().min(1).max(MAX_SYNTHESIS_CHARS),
      voice: z.string().optional(),
    }),
  ]),

  // --- meetings -----------------------------------------------------------
  /** The notice for one engine. Omitting the engine asks for the default. */
  "meetings:notice": z.tuple([
    z.object({ engine: TranscriptionEngine.optional() }).default({}),
  ]),
  "meetings:list": z.tuple([]),
  "meetings:get": z.tuple([z.object({ meetingId: z.string() })]),
  /**
   * Start a capture. `participantsInformed` is a literal `true` in the schema,
   * so a client that omits it is rejected at the boundary rather than reaching
   * a handler that might treat "undefined" as "not refused".
   */
  "meetings:start": z.tuple([
    z.object({
      title: z.string().min(1),
      sources: z.array(AudioSource).min(1),
      noticeVersion: z.string().min(1),
      participantsInformed: z.literal(true),
      engine: TranscriptionEngine.optional(),
      retainAudio: z.boolean().default(false),
      calendarEventId: z.string().optional(),
    }),
  ]),
  /**
   * Transcribe a file the user already has.
   *
   * The path is absolute and unconstrained on purpose: unlike every project
   * channel, this one names a file the user picked in an OS dialog, so
   * containment under the project root would refuse the normal case. It is
   * read and never written, and the extension allow-list is enforced in the
   * service.
   */
  "meetings:importFile": z.tuple([
    z.object({
      path: z.string().min(1).max(4096),
      title: z.string().max(200).optional(),
      noticeVersion: z.string().min(1),
      participantsInformed: z.literal(true),
      engine: TranscriptionEngine.optional(),
      locale: z.string().max(20).optional(),
      recordingId: z.string().optional(),
    }),
  ]),
  /**
   * Stop capture and transcribe. Idempotent for a meeting already stopped.
   *
   * There is no matching channel to send audio: the `iq-audio` sidecar writes
   * the recording itself, so no captured audio crosses this boundary at all.
   */
  "meetings:stop": z.tuple([z.object({ meetingId: z.string() })]),
  "meetings:transcript": z.tuple([z.object({ meetingId: z.string() })]),
  "meetings:notes": z.tuple([z.object({ meetingId: z.string() })]),
  "meetings:generateNotes": z.tuple([z.object({ meetingId: z.string() })]),
  /** Delete the audio but keep the transcript and notes. */
  "meetings:discardAudio": z.tuple([z.object({ meetingId: z.string() })]),
  "meetings:delete": z.tuple([z.object({ meetingId: z.string() })]),

  // --- local media tooling ------------------------------------------------
  /** Which external tools resolved, and where finished recordings go. */
  "media:status": z.tuple([]),
  "media:settings": z.tuple([]),
  "media:saveSettings": z.tuple([MediaSettingsInput]),
  /** OS file pickers. The privileged side owns the dialog; nothing is read here. */
  "media:pickFile": z.tuple([
    z.object({ kind: z.enum(["whisperModel", "media", "executable"]) }),
  ]),
  "media:pickDirectory": z.tuple([]),

  // --- skill recording ------------------------------------------------------
  /**
   * Live recorder state and the recording library. Both are reads; nothing
   * here starts a capture.
   */
  "recording:status": z.tuple([]),
  "recording:list": z.tuple([]),
  "recording:get": z.tuple([z.object({ recordingId: z.string().min(1).max(120) })]),
  /**
   * The two notices, and which of them this user has already acknowledged.
   *
   * Returned rather than hard-coded in the renderer so that raising a notice
   * version invalidates acknowledgements everywhere at once.
   */
  "recording:notice": z.tuple([]),
  /**
   * Begin a capture.
   *
   * The payload says what to capture, never where to put it: the privileged
   * side owns the session directory, so a renderer cannot aim a recording at an
   * arbitrary path. `acknowledgedNoticeVersion` is checked against the current
   * one on the privileged side; a stale value is refused rather than upgraded.
   */
  "recording:start": z.tuple([
    z.object({
      acknowledgedNoticeVersion: z.string().min(1).max(40),
      captureVideo: z.boolean().default(true),
      captureNarration: z.boolean().default(false),
      /** Empty means the host's default input. */
      microphone: z.string().max(200).default(""),
    }),
  ]),
  "recording:stop": z.tuple([]),
  /** Throw the in-flight capture away. Keeps the record, deletes the media. */
  "recording:discard": z.tuple([]),
  /** Pin a note to the timeline while recording. */
  "recording:marker": z.tuple([z.object({ note: z.string().min(1).max(500) })]),
  "recording:rename": z.tuple([
    z.object({ recordingId: z.string().min(1).max(120), title: z.string().min(1).max(120) }),
  ]),
  "recording:delete": z.tuple([z.object({ recordingId: z.string().min(1).max(120) })]),
  /** Open the session directory so a person can inspect what was captured. */
  "recording:reveal": z.tuple([z.object({ recordingId: z.string().min(1).max(120) })]),

  /**
   * Reconstruct what happened. This is the egress, so it carries the consent.
   *
   * The consent payload is the acknowledgement only — the identity on it is
   * stamped from the signed-in account on the privileged side, because a
   * renderer that could name who authorised an upload could name anyone.
   */
  "recording:analyse": z.tuple([
    z.object({
      recordingId: z.string().min(1).max(120),
      acknowledgedNoticeVersion: z.string().min(1).max(40),
      contentReviewed: z.literal(true),
    }),
  ]),
  "recording:analysis": z.tuple([z.object({ recordingId: z.string().min(1).max(120) })]),
  /** Another pass, informed by what the user says is wrong. */
  "recording:reanalyse": z.tuple([
    z.object({
      recordingId: z.string().min(1).max(120),
      feedback: AnalysisFeedback,
    }),
  ]),
  /** Hand-edit the reconstruction rather than argue with it. */
  "recording:editAnalysis": z.tuple([
    z.object({
      recordingId: z.string().min(1).max(120),
      title: z.string().max(120).optional(),
      intent: z.string().min(1).max(2_000).optional(),
      steps: z.array(AnalysisStep).max(200).optional(),
    }),
  ]),
  "recording:approveAnalysis": z.tuple([
    z.object({ recordingId: z.string().min(1).max(120), approved: z.boolean() }),
  ]),
  "recording:cancelAnalysis": z.tuple([z.object({ recordingId: z.string().min(1).max(120) })]),

  /** Propose how the recorded run generalises. Reads an approved analysis. */
  "recording:plan": z.tuple([
    z.object({ recordingId: z.string().min(1).max(120), kind: BuildKind }),
  ]),
  /** Refine the proposal in natural language before anything is written. */
  "recording:replan": z.tuple([
    z.object({
      recordingId: z.string().min(1).max(120),
      feedback: z.string().min(1).max(4_000),
    }),
  ]),
  /** Hand-edit the plan — in particular the named values. */
  "recording:editPlan": z.tuple([
    z.object({ recordingId: z.string().min(1).max(120), plan: RecordingPlan }),
  ]),
  /**
   * Write the artifact.
   *
   * A skill lands in the proposals staging area and an automation lands
   * disabled; neither runs until a human approves it on its own surface.
   */
  "recording:build": z.tuple([z.object({ recordingId: z.string().min(1).max(120) })]),
  "recording:getBuild": z.tuple([z.object({ recordingId: z.string().min(1).max(120) })]),
  "recording:cancelBuild": z.tuple([z.object({ recordingId: z.string().min(1).max(120) })]),

  // --- Microsoft Fabric ----------------------------------------------------
  "fabric:status": z.tuple([]),
  "fabric:save": z.tuple([FabricConnectionInput]),
  "fabric:remove": z.tuple([]),
  /** Every workspace the signed-in identity can see, so the id can be picked. */
  "fabric:workspaces": z.tuple([]),
  /** Cheapest round-trip against the project; also learns its display name. */
  "fabric:test": z.tuple([]),
  /**
   * Items already in the project, so a run does not duplicate them.
   *
   * `refresh: false` answers from the cached list when there is one, which is
   * what opening the surface does. `refresh: true` always calls Fabric.
   */
  "fabric:items": z.tuple([z.object({ refresh: z.boolean() })]),
  /** Which skills-for-fabric release is grounding runs, and where it came from. */
  "fabric:skillPack": z.tuple([]),
  "fabric:setSkillPackPath": z.tuple([z.object({ path: z.string().max(4096) })]),
  /** Candidate source documents under the bound project, for the intake list. */
  "fabric:candidates": z.tuple([]),
  /** Whether document extraction is available, and why not if it is not. */
  "fabric:contextStatus": z.tuple([]),
  /** Create the local Python environment MarkItDown runs in. */
  "fabric:prepareContext": z.tuple([]),
  "fabric:runs": z.tuple([]),
  "fabric:run": z.tuple([
    z.object({
      objective: z.string().min(1).max(4_000),
      kinds: z.array(FabricArtifactKind).default([]),
      /** Project-relative paths. An allow-list, never a folder. */
      sourceFiles: z.array(z.string().max(4096)).max(50).default([]),
    }),
  ]),
  "fabric:cancel": z.tuple([]),
  /** Ask the connected Data Agent a question about the data. */
  "fabric:ask": z.tuple([
    z.object({
      question: z.string().min(1).max(2_000),
      sessionId: z.string().min(1).max(120),
    }),
  ]),

  // --- Fabric Data Agent ---------------------------------------------------
  "dataAgent:status": z.tuple([]),
  "dataAgent:save": z.tuple([FabricDataAgentConnectionInput]),
  "dataAgent:remove": z.tuple([]),
  "dataAgent:test": z.tuple([]),
  /** Every stored conversation, newest activity first. */
  "dataAgent:chats": z.tuple([]),
  /** Start one. Its id is the session id the next question is asked under. */
  "dataAgent:newChat": z.tuple([]),
  "dataAgent:deleteChat": z.tuple([z.object({ chatId: z.string().min(1).max(120) })]),
  "dataAgent:clearChats": z.tuple([]),

  // --- governance ---------------------------------------------------------
  "audit:query": z.tuple([
    z.object({
      correlationId: z.string().optional(),
      family: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
  ]),
  "policy:get": z.tuple([]),
} as const;

export type IpcChannel = keyof typeof IPC_REQUEST_SCHEMAS;

export type IpcRequestArgs<C extends IpcChannel> = z.infer<(typeof IPC_REQUEST_SCHEMAS)[C]>;

/**
 * The arguments a *caller* supplies, before the schema fills its defaults.
 *
 * Distinct from {@link IpcRequestArgs}, which is what the handler receives.
 * `z.input` and `z.infer` differ wherever a field has a `.default()` or is
 * `.optional()` — `sessions:sendMessage` is the clearest case: the renderer has
 * never sent `subMode` or `projectId` and never needed to, because the schema
 * supplies them. Typing the caller on the output shape would demand fields the
 * boundary exists to provide.
 */
export type IpcRequestInput<C extends IpcChannel> = z.input<(typeof IPC_REQUEST_SCHEMAS)[C]>;

/**
 * What each channel answers with.
 *
 * The request half of this contract has always been a schema. The response half
 * had **no interface at all**: `bridge.call<T>(channel)` was an unchecked
 * assertion at 129 call sites, and the only thing connecting a handler's return
 * to the renderer's belief about it was that someone had written the same type
 * name in two files. Changing a response shape touched one file and was caught
 * by nothing.
 *
 * Declared as types rather than zod schemas on purpose. Runtime validation
 * belongs on the renderer→main direction, which is the untrusted one and which
 * {@link validateIpcRequest} already covers. Main→renderer is trusted, so what
 * was missing there was never a guard — it was a contract.
 *
 * Seven channels are deliberately absent, and answer `unknown`:
 * `fabric:contextStatus`, `knowledge:ingest`, `meetings:notice`,
 * `orchestration:plans`, `recording:notice`, `skills:listProposals` and
 * `projects:list`. Their shapes live in `@iq/core` or in the renderer, and a
 * shape only one side declares is not a contract — putting it here would move
 * the lie rather than remove it.
 */
export interface IpcResults {
"audit:query": AuditRecord[];
  "auth:copilotStatus": CopilotAuthStatus;
  "auth:status": AuthStatus;
  "auth:tenant": { tenantId: string | null };
  "auth:tenants": TenantSummary[];
  "browser:navigate": BrowserState;
  "browser:back": BrowserState;
  "browser:forward": BrowserState;
  "browser:reload": BrowserState;
  "browser:stop": BrowserState;
  "browser:close": BrowserState;
  "browser:state": BrowserState;
  "browser:restore": BrowserState;
  "council:list": CouncilRun[];
  "council:presets": CouncilPreset[];
  "council:rename": CouncilRun;
  "council:start": CouncilRun;
  "dataAgent:status": FabricDataAgentStatus;
  "dataAgent:test": { answer: string };
  "dataAgent:chats": DataAgentChat[];
  "dataAgent:newChat": DataAgentChat;
  "dataAgent:deleteChat": { ok: true };
  "dataAgent:clearChats": { ok: true };
  "fabric:ask": FabricAnswer;
  "fabric:candidates": Array<{ path: string; bytes: number }>;
  "fabric:items": FabricItemList;
  "fabric:run": FabricRun;
  "fabric:runs": FabricRun[];
  "fabric:skillPack": FabricSkillPack;
  "fabric:status": FabricStatus;
  "fabric:test": { name: string };
  "fabric:workspaces": FabricWorkspace[];
  "images:delete": { ok: true };
  "images:deleteThread": { ok: true };
  "images:generate": ImageRun;
  "images:runs": ImageRun[];
  "jobs:list": ScheduledJob[];
  "jobs:runs": JobRun[];
  "knowledge:addSources": { added: number; skipped: number; vault: KnowledgeVaultState };
  "knowledge:chooseVault": { directory: string };
  "knowledge:graph": { graph: KnowledgeGraph; summary: KnowledgeSummary };
  "knowledge:node": KnowledgeNodeDetail;
  "knowledge:removeSource": { sources: KnowledgeSource[] };
  "knowledge:search": KnowledgeHit[];
  "knowledge:setVault": { vault: KnowledgeVaultState; summary: KnowledgeSummary };
  "knowledge:sources": KnowledgeSource[];
  "knowledge:vault": KnowledgeVaultState;
  "mcp:inspect": McpInspectResult;
  "mcp:list": McpServerRecord[];
  "media:pickFile": { path: string | null };
  "media:saveSettings": MediaSettings;
  "media:settings": MediaSettings;
  "media:status": MediaStatus;
  "meetings:importFile": MeetingRecord;
  "meetings:list": MeetingRecord[];
  "meetings:notes": { body: string | null };
  "meetings:start": MeetingRecord;
  "meetings:stop": MeetingRecord;
  "meetings:transcript": MeetingTranscript;
  "memory:derivations": MemoryDerivation[];
  "memory:list": MemoryRecord[];
  "memory:update": MemoryRecord;
  "models:catalog": ModelCatalog;
  "myiq:publish": MyIqPublishResult;
  "myiq:status": MyIqStatus;
  "office:documents": OfficeDocument[];
  "office:preview": OfficePreview;
  "office:render": OfficeRender;
  "office:remember": { ok: true };
  /** The remembered path, or "" when this conversation has none in this project. */
  "office:recall": string;
  "office:status": OfficeStatus;
  "recording:analyse": RecordingAnalysis;
  "recording:analysis": RecordingAnalysis | null;
  "recording:approveAnalysis": RecordingAnalysis;
  "recording:build": RecordingBuild;
  "recording:editAnalysis": RecordingAnalysis;
  "recording:editPlan": RecordingPlan;
  "recording:getBuild": RecordingBuild | null;
  "recording:list": RecordingRecord[];
  "recording:plan": RecordingPlan;
  "recording:reanalyse": RecordingAnalysis;
  "recording:replan": RecordingPlan;
  "recording:start": RecordingRecord;
  "recording:status": RecorderStatus;
  "recording:stop": RecordingRecord;
  "research:list": ResearchRun[];
  "research:start": ResearchRun;
  "research:delete": { ok: true };
  "samples:setEnabled": SampleStatus;
  "samples:load": { status: SampleStatus; message: string };
  "samples:clear": { status: SampleStatus; message: string };
  "samples:status": SampleStatus;
  "sessions:create": { sessionId: string };
  "sessions:list": SessionSummary[];
  "sessions:sweep": SessionSweep;
  "sessions:turns": TurnState[];
  "skills:chooseImport": { source: string };
  "skills:evolutionStatus": SkillEvolutionStatus;
  "skills:export": { destination: string };
  "skills:inspectImport": SkillImportPreview;
  "skills:list": SkillRecord[];
  "speech:register": SpeechStatus;
  "speech:remove": SpeechStatus;
  "speech:status": SpeechStatus;
  "speech:synthesize": { audioBase64: string; mimeType: string };
  "speech:test": SpeechTestResult;
  "speech:transcribe": { text: string };
  "project:list": ProjectListing;
  "project:read": ProjectFile;
  "projects:choose": { directory: string };
  "projects:open": { project: ProjectRecord };
}

/**
 * The response type for a channel, or `unknown` when it has none declared.
 *
 * `unknown` rather than `void`: a channel missing from {@link IpcResults} does
 * answer something, we have just not written down what. `void` would claim it
 * answers nothing, which is a different and false statement.
 */
export type IpcResult<C extends IpcChannel> = C extends keyof IpcResults
  ? IpcResults[C]
  : unknown;


export const isIpcChannel = (value: string): value is IpcChannel =>
  Object.prototype.hasOwnProperty.call(IPC_REQUEST_SCHEMAS, value);

/**
 * Validate a renderer request before it reaches privileged code. Throws on an
 * unknown channel so that new capabilities cannot be reached by guessing.
 */
export function validateIpcRequest(channel: string, args: unknown[]): unknown[] {
  if (!isIpcChannel(channel)) {
    throw new Error(`unknown IPC channel: ${channel}`);
  }
  const schema = IPC_REQUEST_SCHEMAS[channel];
  return schema.parse(args) as unknown[];
}

/** Push channels: main to renderer. Renderer may only subscribe to these. */
export const IPC_EVENT_CHANNELS = [
  "turns:event",
  "sessions:index",
  "auth:status",
  "jobs:run",
  "orchestration:update",
  "knowledge:changed",
  "browser:changed",
  /** One screencast frame from the page the browser pane is showing. */
  "browser:frame",
  "meetings:changed",
  "memory:changed",
  /** Model registry changed, or an entry was tested. */
  "models:changed",
  /** Speech registration finished loading, or the registered destination changed. */
  "speech:changed",
  /** An OfficeCLI mutation landed, so an open canvas preview can refresh. */
  "office:changed",
  "images:run",
  "research:changed",
  /** One node or edge of a research run's reasoning graph, as it happens. */
  "research:graph",
  /** Progress of a skill-evolution run. Long-running, and worth watching. */
  "skills:evolutionChanged",
  "council:changed",
  /** The sample-data flag, or one module's samples, changed. */
  "samples:changed",
  /** A Fabric co-creation run changed state. */
  "fabric:changed",
  "projects:changed",
  /** A file appeared, changed or went away inside the bound project. */
  "project:filesChanged",
  /**
   * Live recorder state.
   *
   * Pushed rather than polled because the recording indicator must be honest:
   * a UI that asks every few seconds whether it is recording will, for those
   * few seconds, be wrong about the one thing it must never be wrong about.
   */
  "recording:status",
  /** A recording's record changed — stopped, transcribed, analysed, built. */
  "recording:changed",
  /** One line of progress from a running analyse or build. */
  "recording:progress",
] as const;

export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[number];

export const isIpcEventChannel = (value: string): value is IpcEventChannel =>
  (IPC_EVENT_CHANNELS as readonly string[]).includes(value);
