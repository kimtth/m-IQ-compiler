/**
 * Every worked example the app ships, in one place.
 *
 * Import sample data from here and nowhere else. The five data modules are
 * fixed constants — the renderer can ask for *these* sets and nothing else,
 * which is what keeps "load the examples" from being a side door that writes
 * arbitrary memories, notes, schedules, plans or projects.
 *
 * {@link SamplesService} is the hub: it owns the list of modules, the global
 * flag, and the decision about what is safe to load.
 */

export { SAMPLE_MEMORIES, isSampleMemory } from "./memories.js";
export {
  SAMPLE_SOURCE_FILES,
  SAMPLE_VAULT_NOTES,
  SAMPLE_VAULT_SUMMARY,
  type SampleNote,
} from "./vault.js";
export { SAMPLE_JOBS, isSampleJob } from "./automations.js";
export { SAMPLE_PLANS, isSamplePlan } from "./plans.js";
export {
  SAMPLE_DOCUMENT_MARKDOWN,
  SAMPLE_DOCUMENT_NAME,
  SAMPLE_DOCUMENT_PATH,
  SAMPLE_PROJECT_FILES,
  SAMPLE_PROJECT_NAME,
  SAMPLE_SESSION_ID,
  SAMPLE_TURN_COUNT,
  isSampleSession,
  sampleSessionEvents,
  sampleTurnIds,
  sampleTurnLogs,
} from "./project.js";
export {
  DEMO_CONVERSATIONS,
  DEMO_COUNCIL_RUN,
  DEMO_COUNCIL_RUN_ID,
  DEMO_COUNT,
  DEMO_DATA_AGENT_CHAT,
  DEMO_DATA_AGENT_CHAT_ID,
  DEMO_BROWSER_URL,
  DEMO_DECK_ITEMS,
  DEMO_DECK_NAME,
  DEMO_DECK_PATH,
  DEMO_DECK_TITLES,
  DEMO_IMAGE_PATH,
  DEMO_IMAGE_RUN,
  DEMO_IMAGE_RUN_ID,
  DEMO_RECORDING,
  DEMO_RECORDING_ANALYSIS,
  DEMO_RECORDING_BUILD,
  DEMO_RECORDING_ID,
  DEMO_RESEARCH_RUN,
  DEMO_RESEARCH_RUN_ID,
  demoSessionEvents,
  demoSessionId,
  demoSessionIds,
  demoTurnIds,
  demoTurnLog,
  isDemoSession,
  type DemoConversation,
} from "./demos.js";
export { SamplesService, type SamplesDeps } from "./samples-service.js";
