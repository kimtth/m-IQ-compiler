export { App, emitterOver, EMITTER_CHANNELS, type AppOptions, type AppEmitter } from "./container.js";

export { AuditLog, type AuditQuery } from "./audit/audit-log.js";
export { resolveAppPaths, ensureAppPaths, type AppPaths } from "./config/paths.js";
export { EntraAuth, type EntraAuthDeps } from "./entra/entra-auth.js";
export {
  AzureCliError,
  AzureCliMissingError,
  classifyCliFailure,
  parseCliJson,
  resetAzCommandCache,
  resolveAzCommand,
  spawnAzureCli,
  type AzCommand,
  type CliFailure,
  type CliFailureKind,
  type CliResult,
  type RunCli,
} from "./entra/azure-cli.js";
export { BrowserUrlPolicy, hostMatches } from "./browser/url-policy.js";
export { detectChallenge, type Challenge, type ChallengeKind } from "./browser/challenge.js";
export { normalizeSdkPermission } from "./runtime/copilot/copilot-runtime.js";
export {
  createBrowserTools,
  type BrowserPaneHost,
  type BrowserPageSnapshot,
  type BrowserElementMap,
  type BrowserActResult,
} from "./browser/tools.js";
export { KnowledgeGraphService } from "./knowledge/knowledge-graph.js";
export { KnowledgeVault } from "./knowledge/vault.js";
export * from "./samples/index.js";
export {
  ProjectService,
  type ProjectDeps,
} from "./project/project.js";
export { ProjectRegistry, type ProjectRegistryDeps } from "./project/registry.js";
export { createKnowledgeTools } from "./knowledge/tools.js";
export {
  GRAPH_VERSION,
  buildGraph,
  parseArtifact,
  stripFrontmatter,
  type Artifact,
} from "./knowledge/indexer.js";
export {
  MeetingsService,
  MeetingsStore,
  formatTranscript,
  type MeetingsDeps,
} from "./meetings/meetings.js";
export {
  RecordingStore,
  RECORDING_FILES,
  FRAME_FILE_PATTERN,
  frameFileName,
  isRecordingId,
  newRecordingId,
} from "./recording/store.js";
export { RecordingEventBus, type EventBusDeps } from "./recording/event-bus.js";
export {
  RecorderController,
  UNAVAILABLE_SCREEN_RECORDER,
  type CapturedFrame,
  type NarrationRecorder,
  type RecorderControllerDeps,
  type RecordingCollector,
  type ScreenRecorder,
  type StartRecordingInput,
} from "./recording/controller.js";
export { buildBundle, correlate } from "./recording/bundle.js";
export {
  NarrationTranscriber,
  SidecarNarrationRecorder,
} from "./recording/narration.js";
export { RecordingAnalyst, RecordingBuilder } from "./recording/analyst.js";
export { RecordingService, type RecordingServiceDeps } from "./recording/service.js";
export {
  resolveMediaTools,
  preparedToolsDir,
  type ResolvedMediaTools,
  type ToolResolution,
} from "./media/tools.js";
export { MediaSettingsStore } from "./media/settings.js";
export { AppSettingsStore } from "./config/app-settings.js";
export {
  FfmpegService,
  MediaToolMissingError,
  type FfmpegDeps,
} from "./media/ffmpeg.js";
export { WhisperService, parseWhisperJson, type WhisperDeps } from "./media/whisper.js";
export {
  AudioSidecar,
  type AudioCapture,
  type AudioCaptureOptions,
  type AudioCaptureResult,
  type AudioLevels,
  type AudioSidecarDeps,
} from "./media/audio.js";
export {
  resolveFabricSkillPack,
  preparedFabricSkillsDir,
  parseSkillDescription,
  skillCatalogue,
} from "./fabric/skill-pack.js";
export { FabricClient, FabricError } from "./fabric/fabric-client.js";
export {
  FabricDataAgentClient,
  agentUrl,
  threadUrl,
  assistantText,
  toolCallNames,
} from "./fabric/data-agent.js";
export {
  FabricRegistry,
  FabricDataAgentRegistry,
  fabricConnectionFromEnv,
  dataAgentConnectionFromEnv,
  FABRIC_SETUP_HINT,
  DATA_AGENT_SETUP_HINT,
  DATA_AGENT_NEEDS_WORKSPACE_HINT,
} from "./fabric/registry.js";
export { DataAgentChats, type DataAgentChatsDeps } from "./fabric/data-agent-chats.js";
export { OfficeFocus, type OfficeFocusDeps } from "./office/office-focus.js";
export { createFabricTools, type FabricToolDeps } from "./fabric/tools.js";
export { FabricContextBuilder, type FileContext } from "./fabric/context.js";
export { FabricService, type FabricServiceDeps } from "./fabric/fabric-service.js";
export {
  SpeechService,
  SpeechNotConfiguredError,
  speechConfigFromEnv,
  parseFastTranscription,
  SPEECH_SETUP_HINT,
  SPEECH_SCOPE,
  type SpeechConfig,
  type SpeechDeps,
  type TranscribeInput,
} from "./speech/speech.js";
export { SpeechRegistry, type SpeechRegistryDeps } from "./speech/registry.js";
export {
  Coordinator,
  PlanStore,
  assertAcyclic,
  type PlanDocument,
  type SubAgentRequest,
  type SubAgentResult,
} from "./orchestration/coordinator.js";
export { PermissionPolicy, newSessionRules, type SessionRules } from "./policy/permission-policy.js";
export {
  MemoryStore,
  type MemoryListFilter,
  type MemoryListener,
} from "./memory/store.js";
export {
  SkillCurator,
  DERIVED_SKILL_PREFIX,
  composeSkillProposal,
  derivationSignature,
  derivedSkillName,
  groupBySubject,
  slugifySubject,
  type CuratorDeps,
} from "./memory/curator.js";
export {
  TenantPolicy,
  DEFAULT_TENANT_POLICY,
  loadTenantPolicy,
  type ResolvedTenantPolicy,
  type PolicySource,
} from "./policy/tenant-policy.js";
export { CopilotRuntime } from "./runtime/copilot/copilot-runtime.js";
export { SessionRepo } from "./runtime/sessions/fs-repo.js";
export { SessionsService } from "./runtime/sessions/sessions.js";
export { TurnRepo } from "./runtime/turns/fs-repo.js";
export { createAgentTools } from "./runtime/tools/agent-tools.js";
export {
  ToolRegistry,
  type AnyGovernedTool,
  type ApprovalBroker,
  type GovernedTool,
  type ToolContext,
} from "./runtime/tools/registry.js";
export { Scheduler, ScheduleStore, backoffMs, validateCron } from "./scheduler/scheduler.js";
export {
  discoverSkills,
  parseSkillMarkdown,
  serializeSkillMarkdown,
  readSkillBody,
} from "./skills/loader.js";
export { McpRegistry, type McpRegistryDeps } from "./mcp/registry.js";
export { MyIqPublisher, myIqServerEntry, type MyIqPublisherDeps } from "./myiq/publisher.js";
export {
  probeMcpServer,
  describeExit,
  startupComplaint,
  blockedPackageHost,
  type McpProbeTarget,
} from "./mcp/probe.js";
export { SkillStore } from "./skills/store.js";
export { SkillEvolution, type SkillEvolutionDeps } from "./skills/evolution.js";
export {
  exportBundle,
  inspectBundle,
  installBundle,
  type BundleFile,
  type InspectedBundle,
} from "./skills/transfer.js";
export { createLogger, type Logger, type LogLevel } from "./util/logger.js";
export { readJson, writeJsonAtomic } from "./util/jsonl.js";
export {
  resolveSpawnTarget,
  whichCommand,
  type ResolvedSpawnTarget,
  type SpawnTarget,
} from "./util/executable.js";
export { NonRetryableError, TimeoutError, withRetry, withTimeout } from "./util/retry.js";
export { WorkIqConsentGate, WORKIQ_TERMS_VERSION } from "./workiq/consent-gate.js";
export {
  createWorkIqTools,
  McpWorkIqClient,
  type McpInvoker,
  type WorkIqClient,
} from "./workiq/workiq-tools.js";
