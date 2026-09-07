/**
 * The renderer's sample handling, in one place.
 *
 * Everything a surface needs to offer, load, clear or hide a worked example
 * comes from here. Nothing else in the renderer should import a sample
 * constant, count one, or decide whether an offer is allowed — that was the
 * state this directory exists to end.
 */

export { useSamples, useSampleData, type Samples } from "./useSamples.js";
export { SAMPLE_COUNCIL, BLANK_MEMBER, type DraftMember } from "./council.js";
export { SAMPLE_EVOLUTION_RUN } from "./evolution.js";
export {
  SHARED_IQS,
  SHARED_IQ_TOOLS,
  SHARED_IQ_TOOL_ARGUMENT,
  SHARED_IQ_TOOL_DETAIL,
  findSharedIqs,
  sharedIqAsk,
  sharedIqChatPrompt,
  sharedIqClientConfig,
  sharedIqServerId,
  sharedIqSuggestions,
  sharedIqToolResult,
  sharedIqTopics,
  type SharedIq,
  type SharedIqAsk,
  type SharedIqCell,
  type SharedIqQuery,
  type SharedIqTool,
} from "./sharedIq.js";
// Only what a surface outside this directory actually needs. Counting, removing
// and un-removing the demo cells is the hook's business: a surface that does
// its own sample bookkeeping is the pattern this directory exists to end.
export { reconcileDemoIqCells, rememberRemoved } from "./iqcells.js";
