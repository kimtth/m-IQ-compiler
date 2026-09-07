import { isAutoApprovable, reduceTurn } from "@iq/shared";
import type {
  PendingApproval,
  PermissionDecision,
  RiskLevel,
  TurnEvent,
  TurnState,
} from "@iq/shared";

/**
 * The approval queue.
 *
 * One pending request used to pass through six modules on its way to a card and
 * back: `SessionsService.appendEvent` allocated its `seq`, `reduceTurn` folded
 * it, `Chat.tsx` de-duplicated by `seq`, flattened the turns, grouped them,
 * applied the `*_always` first-member rule, and `applySessionRules` swept the
 * rest — in another process. Exactly one of those was reachable from a test:
 * `groupApprovals`, which had been pulled out here *for testability*, and which
 * is the only one that never held a bug.
 *
 * Every recorded failure lived in the other five. The `seq` collision (measured:
 * four settlements, one distinct number) surfaced as the de-dup silently
 * discarding settlements, leaving a card nothing could remove. Auto-approval
 * was broken by `risk` being dropped in the fold. The first-member rule is
 * correct only because of a sweep in a different process, and that reasoning
 * lived in a twelve-line comment inside a React component.
 *
 * So the module boundary moved to the invariant that actually matters — **a
 * request is shown once and settles once** — and the ordering rule now sits
 * beside the interruption rule, because a lost settlement is an approval defect
 * rather than a transcript one. `groupApprovals` is an internal step of it.
 */

/** One pending request, with the turn it belongs to. */
export interface Waiting {
  turn: TurnState;
  approval: PendingApproval;
}

export interface ApprovalGroup {
  key: string;
  toolName: string;
  family: string;
  /**
   * What these calls would do, as the privileged side classified it.
   *
   * One value for the whole group is exact, not an approximation: the key is
   * family plus tool name, so every member is the same tool and carries the
   * same risk. The card needs it to know whether "always" is a promise the
   * policy will keep.
   */
  risk: RiskLevel;
  requiredScopes: readonly string[];
  /** Distinct request lines to show; the rest are counted, not listed. */
  summaries: string[];
  remaining: number;
  members: Waiting[];
}

/**
 * One answer to post back, addressed the way the channel expects it.
 *
 * The queue returns these rather than reaching for the bridge itself, so the
 * rule that decides *how many* answers a click produces can be tested without a
 * `window`.
 */
export interface ApprovalAnswer {
  turnId: string;
  toolCallId: string;
  decision: PermissionDecision;
}

/** Enough to see what kind of thing is being asked for without a wall of text. */
export const MAX_SUMMARIES = 3;

/**
 * Live turn events, ordered by `seq` and de-duplicated.
 *
 * Immutable, and {@link record} returns the same log when it has nothing to
 * add — which is how a caller tells a duplicate delivery from a real one
 * without repeating the comparison.
 */
export interface TurnEventLog {
  readonly byTurn: ReadonlyMap<string, readonly TurnEvent[]>;
}

export const EMPTY_LOG: TurnEventLog = { byTurn: new Map() };

/**
 * Take one live event into the log.
 *
 * Keyed by `seq` so a duplicate delivery cannot double-append, and sorted by it
 * because the transport does not promise order. The cost of that key is what
 * the collision exploited: two events sharing a number are one event as far as
 * this is concerned, and the one it keeps is the one that arrived first. That
 * is a real limitation, and it is why `appendEvent` holds a lock around
 * allocating the number; stated here so the next reader need not rediscover it.
 */
export function record(log: TurnEventLog, event: TurnEvent): TurnEventLog {
  const existing = log.byTurn.get(event.turnId) ?? [];
  if (existing.some((candidate) => candidate.seq === event.seq)) return log;
  const byTurn = new Map(log.byTurn);
  byTurn.set(
    event.turnId,
    [...existing, event].sort((a, b) => a.seq - b.seq),
  );
  return { byTurn };
}

/**
 * The conversation's turns: the restored snapshot, with live folds winning.
 *
 * Turn state is always the fold of that turn's events, never patched directly,
 * so a live stream and a reload produce the same result. Restored order is
 * kept, and turns that started after hydration follow in arrival order.
 */
export function turnsIn(
  log: TurnEventLog,
  sessionId: string | null,
  restored: readonly TurnState[],
): TurnState[] {
  if (sessionId === null) return [];

  const live = new Map<string, TurnState>();
  for (const list of log.byTurn.values()) {
    const state = reduceTurn([...list]);
    if (state.sessionId === sessionId) live.set(state.turnId, state);
  }

  const ordered: TurnState[] = [];
  for (const snapshot of restored) {
    ordered.push(live.get(snapshot.turnId) ?? snapshot);
    live.delete(snapshot.turnId);
  }
  for (const state of live.values()) ordered.push(state);
  return ordered;
}

/** Every request still waiting on a person, across the conversation's turns. */
export function waiting(turns: readonly TurnState[]): Waiting[] {
  return turns.flatMap((turn) => turn.pendingApprovals.map((approval) => ({ turn, approval })));
}

/**
 * What auto-approval would answer, right now.
 *
 * Keyed on `PendingApproval.risk`, which is the privileged side's own
 * classification. The renderer used to keep a list of six "safe" Microsoft read
 * families instead, which knew nothing about the SDK's built-ins — so a turn
 * that fetched a URL was never answered and sat until it timed out.
 *
 * Answered through the same channel as a click, so the decision is recorded in
 * the audit log identically.
 */
export function autoAnswers(turns: readonly TurnState[]): ApprovalAnswer[] {
  return waiting(turns)
    .filter((entry) => isAutoApprovable(entry.approval.risk))
    .map((entry) => ({
      turnId: entry.turn.turnId,
      toolCallId: entry.approval.toolCallId,
      decision: "allow" as const,
    }));
}

/**
 * The cards to show, for a conversation in a given approval mode.
 *
 * In `auto_safe` the requests the effect is about to answer are withheld: a
 * card that appears and vanishes on its own is not a decision anyone made.
 */
export function cardsFor(
  turns: readonly TurnState[],
  approvalMode: "ask" | "auto_safe",
): ApprovalGroup[] {
  const all = waiting(turns);
  const shown =
    approvalMode === "auto_safe"
      ? all.filter((entry) => !isAutoApprovable(entry.approval.risk))
      : all;
  return groupApprovals(shown);
}

/**
 * Answer a whole card.
 *
 * A session rule (`*_always`) is answered for the **first member only**: the
 * broker re-evaluates the rest against the new rule, which is the same path a
 * request arriving *after* the rule takes. Sending all seventeen would race
 * that sweep and log a "no pending approval" warning for each one it had
 * already settled. `allow`/`deny` establish no rule, so every member is sent,
 * which is what keeps the audit log one record per call either way.
 */
export function answer(group: ApprovalGroup, decision: PermissionDecision): ApprovalAnswer[] {
  const remembers = decision === "allow_always" || decision === "deny_always";
  const targets = remembers ? group.members.slice(0, 1) : group.members;
  return targets.map((entry) => ({
    turnId: entry.turn.turnId,
    toolCallId: entry.approval.toolCallId,
    decision,
  }));
}

/**
 * Collapse pending requests to one entry per tool.
 *
 * A model does not ask for one slide at a time: "create a deck about X" arrives
 * as one `office_create_document` and seventeen `office_add_content` calls,
 * raised together and all waiting at once. Seventeen cards for one intent is
 * not consent, it is an endurance test.
 *
 * Grouping is by family and tool name, never by summary: those seventeen calls
 * differ only in which slide they target, and treating each as its own question
 * turns one decision — "may this turn add content to this deck" — into
 * seventeen. Every member is kept so the answer is still recorded per call,
 * which is what the audit log needs.
 *
 * Order of first appearance is preserved, so the list does not reshuffle as
 * members settle.
 */
export function groupApprovals(entries: readonly Waiting[]): ApprovalGroup[] {
  const byTool = new Map<string, ApprovalGroup>();

  for (const entry of entries) {
    const { family, toolName, summary, requiredScopes, risk } = entry.approval;
    const key = `${family}:${toolName}`;
    let group = byTool.get(key);
    if (!group) {
      group = {
        key,
        toolName,
        family,
        risk,
        requiredScopes: [...requiredScopes],
        summaries: [],
        remaining: 0,
        members: [],
      };
      byTool.set(key, group);
    }
    group.members.push(entry);
    if (group.summaries.length < MAX_SUMMARIES && !group.summaries.includes(summary)) {
      group.summaries.push(summary);
    }
  }

  for (const group of byTool.values()) {
    group.remaining = group.members.length - group.summaries.length;
  }
  return [...byTool.values()];
}
