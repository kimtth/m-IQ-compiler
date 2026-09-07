import { z } from "zod";
import { TurnEvent, type TurnStatus } from "./events.js";
import { DEFAULT_SESSION_PLACE, SessionPlace } from "./mode.js";
import type { RiskLevel } from "./permission.js";

export const SessionSummary = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  turnCount: z.number().int().nonnegative(),
  /** Set when the session was created by a scheduled job or a sub-agent task. */
  origin: z.enum(["interactive", "scheduled", "sub_agent"]).default("interactive"),
  parentSessionId: z.string().nullable().default(null),
  /**
   * Where the conversation is connected — the mode and canvas tab to restore
   * when it is selected in the rail. Defaulted, so a session recorded before
   * places existed opens on the thread rather than nowhere.
   */
  place: SessionPlace.default(DEFAULT_SESSION_PLACE),
  /**
   * Whether a place was ever recorded, as distinct from being the default one.
   *
   * The two are not the same question and collapsing them makes the backfill
   * impossible: "this conversation belongs on the thread" and "nobody has ever
   * asked where this conversation belongs" both read as the default place, so
   * a one-time inference pass could not tell which sessions it had already
   * looked at and would re-read every turn log on every launch.
   */
  placeKnown: z.boolean().default(false),
  /**
   * Whether the place was *chosen* rather than inferred.
   *
   * A conversation started from the destination picker says what it is for
   * before it has done anything, and that statement outranks every later
   * inference. Carried on the summary because {@link SessionsService.setPlace}
   * is where a `work` record has to defer, and it has only the summary to ask.
   */
  placeChosen: z.boolean().default(false),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

/**
 * What a sweep of the conversation store found, or removed.
 *
 * Conversation history is append-only and nothing ever tidied it, so the store
 * accumulates three kinds of debris: threads created and never spoken to, the
 * private sessions a council or research run leaves behind after its parent is
 * deleted, and turn logs no session references — the residue of a crash
 * between writing a turn and recording it.
 *
 * The same shape answers "what would this remove?" and "what did it remove?",
 * because a destructive action the user cannot preview first is one they have
 * to run to understand.
 */
export const SessionSweep = z.object({
  /** False for a preview: nothing on disk was touched. */
  applied: z.boolean(),
  /** Conversations that never held a single turn. */
  emptySessions: z.number().int().nonnegative(),
  /** Sub-agent sessions whose parent conversation is gone. */
  abandonedRuns: z.number().int().nonnegative(),
  /** Turn logs no surviving session refers to. */
  orphanTurns: z.number().int().nonnegative(),
  /** Remembered browser pages filed under conversations that no longer exist. */
  strandedPages: z.number().int().nonnegative(),
});
export type SessionSweep = z.infer<typeof SessionSweep>;

export type PendingApproval = {
  toolCallId: string;
  toolName: string;
  family: string;
  /**
   * What the call would do, as the privileged side classified it.
   *
   * Carried rather than re-derived. Without it the surface has to guess from
   * the family name, which means keeping a second list of "safe" families in
   * renderer code — and that list drifts the moment a tool is added. It drifted:
   * auto-approval covered six hand-written families and silently missed every
   * SDK built-in, so the mode that says it answers for you did not.
   */
  risk: RiskLevel;
  summary: string;
  requiredScopes: string[];
};

/**
 * A tool invocation as the user sees it. Kept as part of the fold rather than
 * derived in the UI, so a live stream and a reload render the same trace.
 */
export type ToolCallState = {
  toolCallId: string;
  toolName: string;
  family: string;
  summary: string;
  status: "awaiting_approval" | "running" | "succeeded" | "failed" | "denied";
  /** Result rendered for display; long output is collapsed by the UI. */
  output: string | null;
  error: string | null;
  /** Result came from an untrusted source (M365 content, sub-agent output). */
  untrusted: boolean;
};

/** Folded view of a turn log. This is the only way turn state is derived. */
export type TurnState = {
  turnId: string;
  sessionId: string;
  status: TurnStatus;
  model: string;
  activeSkills: string[];
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  pendingApprovals: PendingApproval[];
  toolCalls: ToolCallState[];
  usage: { inputTokens: number; outputTokens: number };
  error: string | null;
  retryable: boolean;
  lastSeq: number;
};

export type { TurnEvent };
