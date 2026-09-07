import { z } from "zod";
import { PermissionOutcome, PermissionRequest } from "./permission.js";
import { PlaceSource, SessionPlace } from "./mode.js";

/**
 * Durable turn events.
 *
 * External side-effect intent is persisted before the side effect begins. Every
 * event is appended to an append-only JSONL log; turn state is always a fold
 * over this log, never mutable in-memory truth. That is what makes a turn safe
 * to resume after a crash and safe to retry.
 */

export const TokenUsage = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

const base = {
  turnId: z.string(),
  seq: z.number().int().nonnegative(),
  at: z.string().datetime(),
};

export const TurnCreated = z.object({
  ...base,
  type: z.literal("turn_created"),
  sessionId: z.string(),
  agentId: z.string(),
  /** Immutable snapshot of the model/tool/skill configuration for this turn. */
  snapshot: z.object({
    model: z.string(),
    skills: z.array(z.string()).default([]),
    toolFamilies: z.array(z.string()).default([]),
    /**
     * Where the turn ran. Recorded on the turn itself, not only in the audit
     * log, so replaying a conversation shows which mode produced each answer
     * and which project it was allowed to touch.
     */
    mode: z.string().default("chat"),
    subMode: z.string().default("conversation"),
    projectId: z.string().nullable().default(null),
  }),
  correlationId: z.string(),
});

export const UserMessage = z.object({
  ...base,
  type: z.literal("user_message"),
  content: z.string(),
  attachments: z.array(z.object({ path: z.string(), mime: z.string() })).default([]),
});

export const AssistantMessage = z.object({
  ...base,
  type: z.literal("assistant_message"),
  content: z.string(),
});

export const ReasoningDelta = z.object({
  ...base,
  type: z.literal("reasoning_delta"),
  content: z.string(),
});

export const ToolCallRequested = z.object({
  ...base,
  type: z.literal("tool_call_requested"),
  request: PermissionRequest,
  args: z.unknown(),
});

export const ToolPermissionSettled = z.object({
  ...base,
  type: z.literal("tool_permission_settled"),
  toolCallId: z.string(),
  outcome: PermissionOutcome,
});

export const ToolCallCompleted = z.object({
  ...base,
  type: z.literal("tool_call_completed"),
  toolCallId: z.string(),
  /**
   * The tool that finished, when the runtime could name it.
   *
   * Needed because `toolCallId` alone does not identify the call it belongs to:
   * the Copilot SDK's permission handler is given no tool-call id at all
   * (`PermissionHandler` receives only `{ sessionId }`), so the id on the
   * *request* is one we minted and the id here is the SDK's own. They have
   * never matched. The name is what lets the fold pair them up.
   */
  toolName: z.string().default(""),
  ok: z.boolean(),
  result: z.unknown(),
  /** Set when the tool result came from an untrusted source (M365 content, sub-agent output). */
  untrusted: z.boolean().default(false),
});

export const TurnSuspended = z.object({
  ...base,
  type: z.literal("turn_suspended"),
  waitingOn: z.enum(["permission", "ask_human", "async_tool", "sub_agent"]),
});

export const TurnCompleted = z.object({
  ...base,
  type: z.literal("turn_completed"),
  usage: TokenUsage,
});

export const TurnFailed = z.object({
  ...base,
  type: z.literal("turn_failed"),
  error: z.string(),
  /** Whether a retry of this turn is expected to succeed. */
  retryable: z.boolean().default(false),
});

export const TurnCancelled = z.object({
  ...base,
  type: z.literal("turn_cancelled"),
  reason: z.string(),
});

export const TurnEvent = z.discriminatedUnion("type", [
  TurnCreated,
  UserMessage,
  AssistantMessage,
  ReasoningDelta,
  ToolCallRequested,
  ToolPermissionSettled,
  ToolCallCompleted,
  TurnSuspended,
  TurnCompleted,
  TurnFailed,
  TurnCancelled,
]);
export type TurnEvent = z.infer<typeof TurnEvent>;

/**
 * A turn event before it is stamped with its position in the log.
 *
 * Distributive on purpose: a plain `Omit<TurnEvent, ...>` would collapse the
 * union into a single object type and lose the discriminated-union narrowing
 * that keeps each event's payload honest.
 */
export type DraftTurnEvent<T = TurnEvent> = T extends unknown
  ? Omit<T, "turnId" | "seq" | "at">
  : never;

export type TurnStatus =
  | "running"
  | "suspended"
  | "completed"
  | "failed"
  | "cancelled";

/** Session-level ordering log, kept separate from turn logs. */
export const SessionEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session_created"),
    sessionId: z.string(),
    at: z.string().datetime(),
    title: z.string(),
    /** Distinguishes interactive sessions from unattended ones in the audit trail. */
    origin: z.enum(["interactive", "scheduled", "sub_agent"]).default("interactive"),
    parentSessionId: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("turn_appended"),
    sessionId: z.string(),
    at: z.string().datetime(),
    turnId: z.string(),
  }),
  z.object({
    type: z.literal("title_changed"),
    sessionId: z.string(),
    at: z.string().datetime(),
    title: z.string(),
  }),
  /**
   * The conversation was moved to a different mode or canvas tab.
   *
   * Recorded on the session rather than derived from the last turn, because
   * the place changes without a turn being taken: asking for a deck in Chat
   * opens Co-create → Office by itself, and opening the Browser beside a
   * thread is navigation, not a message.
   *
   * A place change is navigation and not activity, so folders must not let it
   * advance `updatedAt` — the rail is ordered by that, and merely looking at a
   * conversation would otherwise push it to the top of the list.
   */
  z.object({
    type: z.literal("place_changed"),
    sessionId: z.string(),
    at: z.string().datetime(),
    place: SessionPlace,
    /**
     * Which of the two placers wrote this, and therefore how much it counts.
     *
     * Readers do not simply take the last one. A place derived from the
     * conversation's own work outranks one derived from where the window was
     * pointing, so selecting a deck conversation and glancing at another tab
     * cannot re-file it. Defaulted for records written before the distinction
     * existed: those came from the shell.
     */
    source: PlaceSource.default("navigation"),
  }),
  /**
   * The user emptied the conversation without discarding it.
   *
   * Recorded rather than applied by rewriting the log, because the log is
   * append-only everywhere else and a clear is a thing that *happened* — the
   * audit trail should be able to say the history was reset at a point in time,
   * not silently present a session that looks as though it were never used.
   * Readers fold this by ignoring every turn appended before it.
   */
  z.object({
    type: z.literal("history_cleared"),
    sessionId: z.string(),
    at: z.string().datetime(),
  }),
]);
export type SessionEvent = z.infer<typeof SessionEvent>;
