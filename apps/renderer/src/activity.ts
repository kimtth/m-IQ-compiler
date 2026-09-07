import type { ToolCallState, TurnStatus } from "@iq/shared";

/**
 * One turn's tool activity, folded into something a person can read.
 *
 * Its own module, and pure, for the same reason `approvals.ts` is: this decides
 * how much of a turn's machinery the reader has to look at, which deserves a
 * test, and importing `Chat.tsx` into one would drag in the IPC bridge and
 * `window`.
 *
 * The problem it solves: a turn that builds a deck makes four `copilot.read`
 * calls, six `copilot.write` calls and a handful of `office_*` calls, and each
 * one used to render as its own card — a status pill, the tool name, the family
 * repeated after it, and a body saying "No output recorded." Twenty cards, most
 * of them empty, for one action the user asked for once. The transcript became
 * the log file rather than the conversation.
 *
 * So identical calls collapse into one step with a count, and the whole thing
 * reduces to a single line until someone asks for more.
 */

/** Worst-first, so a step's state is the most serious of its calls. */
const SEVERITY: Record<ToolCallState["status"], number> = {
  failed: 4,
  denied: 3,
  awaiting_approval: 2,
  running: 1,
  succeeded: 0,
};

export interface ActivityStep {
  /** `family:toolName`, stable across a turn. */
  key: string;
  toolName: string;
  family: string;
  /** The tool name as prose, e.g. `office_add_many` → "add many". */
  label: string;
  /**
   * Whether the family is worth printing beside the label.
   *
   * The SDK's built-ins arrive as `toolName: "copilot.read"`, `family:
   * "copilot.read"` — printing both gave every row "copilot.read copilot.read",
   * which is exactly the duplication people saw.
   */
  showFamily: boolean;
  /** The most serious status among the calls in this step. */
  status: ToolCallState["status"];
  calls: ToolCallState[];
  /** True when at least one call in the step has something to show. */
  hasDetail: boolean;
}

export interface Activity {
  steps: ActivityStep[];
  /** Individual calls, not steps — "12 steps" would undercount the work. */
  total: number;
  running: number;
  failed: number;
  /** The single line shown while collapsed. */
  headline: string;
}

/**
 * Turn a tool name into something readable.
 *
 * `copilot.read` → "read", `office_add_many` → "add many". The family prefix is
 * dropped **only when it really is the family** — it is shown beside the name,
 * and repeating it there was half the duplication people complained about. A
 * name that merely starts with similar letters keeps them.
 */
export function describeTool(toolName: string, family = ""): string {
  let bare = toolName;
  for (const separator of [".", "_"]) {
    const prefix = `${family}${separator}`;
    if (family !== "" && bare.toLowerCase().startsWith(prefix.toLowerCase())) {
      bare = bare.slice(prefix.length);
      break;
    }
  }
  return bare.replace(/[_-]+/g, " ").trim() || toolName;
}

/**
 * Fold a turn's tool calls into steps, newest activity first in the headline.
 *
 * Grouping is by `family:toolName` and never by summary: six
 * `office_add_content` calls differ only in which slide they target, and
 * listing them separately says nothing the count does not. Order of first
 * appearance is kept so the list does not reshuffle as calls settle.
 *
 * **`turnStatus` is what stops a finished conversation showing work in
 * progress.** A call's own status is not enough: the Copilot SDK hands its
 * permission handler no tool-call id, so a completion can go unmatched and
 * leave a call marked "running" in a turn that ended an hour ago. The fold
 * repairs what it can (see `settling` in `@iq/shared`); this is the backstop
 * for what it cannot — the turn is over, therefore nothing is running, and
 * saying otherwise is the only reading a reader cannot argue with.
 */
export function summarizeActivity(
  calls: readonly ToolCallState[],
  turnStatus: TurnStatus = "running",
): Activity {
  const live = turnStatus === "running" || turnStatus === "suspended";
  const steps: ActivityStep[] = [];
  const byKey = new Map<string, ActivityStep>();

  for (const call of calls) {
    const key = `${call.family}:${call.toolName}`;
    let step = byKey.get(key);
    if (!step) {
      const label = describeTool(call.toolName, call.family);
      step = {
        key,
        toolName: call.toolName,
        family: call.family,
        label,
        showFamily: call.family !== "" && call.family !== label && call.family !== call.toolName,
        status: call.status,
        calls: [],
        hasDetail: false,
      };
      byKey.set(key, step);
      steps.push(step);
    }
    step.calls.push(call);
    if (SEVERITY[call.status] > SEVERITY[step.status]) step.status = call.status;
    if (detailOf(call) !== "") step.hasDetail = true;
  }

  const running = live ? calls.filter((call) => call.status === "running").length : 0;
  const waiting = live ? calls.filter((call) => call.status === "awaiting_approval").length : 0;
  const failed = calls.filter(
    (call) => call.status === "failed" || call.status === "denied",
  ).length;

  return {
    steps,
    total: calls.length,
    running,
    failed,
    headline: headlineFor(calls, { running, waiting, failed }),
  };
}

/** What a call has to show, or "" when it has nothing — most do not. */
export function detailOf(call: ToolCallState): string {
  return (call.error ?? call.output ?? "").trim();
}

/**
 * The one line shown while collapsed.
 *
 * While work is in flight it names what is happening now, because that is the
 * only thing the user cannot already see. Once the turn is done it reports the
 * shape of what was done, and says nothing about how — the answer above it is
 * the point, not the plumbing that produced it.
 */
function headlineFor(
  calls: readonly ToolCallState[],
  counts: { running: number; waiting: number; failed: number },
): string {
  if (calls.length === 0) return "";

  if (counts.waiting > 0) {
    return counts.waiting === 1 ? "Waiting for your approval" : `Waiting for ${counts.waiting} approvals`;
  }

  if (counts.running > 0) {
    // The last one started is the one still on screen in the user's mind.
    const latest = [...calls].reverse().find((call) => call.status === "running");
    const name = latest ? describeTool(latest.toolName, latest.family) : "working";
    return counts.running > 1 ? `${name} — and ${counts.running - 1} more` : name;
  }

  const steps = `${calls.length} step${calls.length === 1 ? "" : "s"}`;
  if (counts.failed > 0) return `${steps} · ${counts.failed} failed`;
  return steps;
}
