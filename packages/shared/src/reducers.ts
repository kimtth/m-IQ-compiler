import type { TurnEvent } from "./events.js";
import type { PendingApproval, ToolCallState, TurnState } from "./session.js";

/**
 * Fold a durable turn log into turn state.
 *
 * This must stay a pure function of the event list: the UI replays it after a
 * missed live event, and the runtime replays it to resume a crash-interrupted
 * turn. A proposed event batch is reduced before it is persisted or published,
 * so replay and live updates observe the same state transition.
 */
export function reduceTurn(events: readonly TurnEvent[]): TurnState {
  const state: TurnState = {
    turnId: "",
    sessionId: "",
    status: "running",
    model: "",
    activeSkills: [],
    messages: [],
    pendingApprovals: [],
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    error: null,
    retryable: false,
    lastSeq: -1,
  };

  for (const event of events) {
    state.turnId = event.turnId;
    state.lastSeq = Math.max(state.lastSeq, event.seq);

    switch (event.type) {
      case "turn_created":
        state.sessionId = event.sessionId;
        state.model = event.snapshot.model;
        state.activeSkills = [...event.snapshot.skills];
        state.status = "running";
        break;

      case "user_message":
        state.messages.push({ role: "user", content: event.content });
        break;

      case "assistant_message":
        state.messages.push({ role: "assistant", content: event.content });
        break;

      case "reasoning_delta":
        break;

      case "tool_call_requested": {
        const approval: PendingApproval = {
          toolCallId: event.request.toolCallId,
          toolName: event.request.toolName,
          family: event.request.family,
          risk: event.request.risk,
          summary: event.request.summary,
          requiredScopes: [...event.request.requiredScopes],
        };
        state.pendingApprovals.push(approval);
        state.toolCalls.push({
          toolCallId: event.request.toolCallId,
          toolName: event.request.toolName,
          family: event.request.family,
          summary: event.request.summary,
          status: "awaiting_approval",
          output: null,
          error: null,
          untrusted: false,
        });
        break;
      }

      case "tool_permission_settled": {
        state.pendingApprovals = state.pendingApprovals.filter(
          (approval) => approval.toolCallId !== event.toolCallId,
        );
        const call = find(state.toolCalls, event.toolCallId);
        // A denial is terminal; an allow only means the tool may now run.
        if (call) {
          const denied =
            event.outcome.decision === "deny" || event.outcome.decision === "deny_always";
          call.status = denied ? "denied" : "running";
        }
        break;
      }

      case "tool_call_completed": {
        state.pendingApprovals = state.pendingApprovals.filter(
          (approval) => approval.toolCallId !== event.toolCallId,
        );
        const call = settling(state.toolCalls, event.toolCallId, event.toolName);
        if (call) {
          call.status = event.ok ? "succeeded" : "failed";
          call.untrusted = event.untrusted;
          const rendered = render(event.result);
          if (event.ok) call.output = rendered;
          else call.error = rendered;
        }
        break;
      }

      case "turn_suspended":
        state.status = "suspended";
        break;

      case "turn_completed":
        state.status = "completed";
        state.usage = {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
        };
        break;

      case "turn_failed":
        state.status = "failed";
        state.error = event.error;
        state.retryable = event.retryable;
        break;

      case "turn_cancelled":
        state.status = "cancelled";
        state.error = event.reason;
        break;
    }
  }

  return state;
}

/** A turn is settled when no further work can advance it without new input. */
export function isTerminal(status: TurnState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function find(calls: ToolCallState[], toolCallId: string): ToolCallState | undefined {
  return calls.find((call) => call.toolCallId === toolCallId);
}

/**
 * Which recorded call a completion belongs to.
 *
 * The ids do not match, and cannot: the Copilot SDK's permission handler is
 * handed only `{ sessionId }` — no tool-call id — so the id on
 * `tool_call_requested` is one we minted while the id here is the SDK's own.
 * Every real turn log shows it: `tc_3815c84c…` requested, `toolu_016rKAW…`
 * completed. Nothing ever matched, so **no tool call ever left "running" and no
 * result was ever attached** — which is why every entry in the transcript read
 * "No output recorded." and a finished conversation still showed work in
 * progress.
 *
 * So: match on the id when it does line up (our own runtime paths, and any
 * future SDK that supplies one), then on the tool name, and only then fall back
 * to the oldest call still running. The fallback is a guess and is worth being
 * explicit about — if two calls to the *same* tool finish out of order their
 * outputs are swapped. That costs a display detail; the alternative was every
 * call in every conversation stuck running forever.
 *
 * Done in the fold rather than at write time on purpose: it repairs the logs
 * that already exist, which is where the user's history lives.
 */
function settling(
  calls: ToolCallState[],
  toolCallId: string,
  toolName: string,
): ToolCallState | undefined {
  const exact = find(calls, toolCallId);
  if (exact) return exact;

  const open = calls.filter(
    (call) => call.status === "running" || call.status === "awaiting_approval",
  );
  if (toolName !== "") {
    const named = open.find((call) => call.toolName === toolName);
    if (named) return named;
  }
  return open[0];
}

/**
 * Tool results are `unknown` on the wire. Render them for display only — the
 * UI never interprets the shape, so a tool that changes its result format
 * cannot break the transcript.
 */
function render(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
