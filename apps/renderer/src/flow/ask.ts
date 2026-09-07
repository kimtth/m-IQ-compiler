import type { FlowGraph, TurnState } from "@iq/shared";
import { isTerminal } from "@iq/shared";
import { call, callAs } from "../bridge.js";
import { draftFromMermaid } from "./fromMermaid.js";

/**
 * "Describe your process" — plain English in, a diagram out.
 *
 * Drawing a flow from nothing is the slowest part of writing one down, and the
 * person who knows the process is rarely the person who enjoys dragging boxes.
 * This asks the agent for the same Mermaid flowchart the canvas exports, then
 * parses it back onto the canvas, so the answer arrives as an editable diagram
 * rather than a wall of text.
 *
 * It opens no new privileged surface. The three channels below are the ones
 * the composer already uses to send a message and read the reply, so a
 * diagram drawn this way is stamped, audited and approved exactly like any
 * other turn.
 */

/**
 * The instruction, appended to what the user typed.
 *
 * Explicit about the fenced block and about the five shapes, because the
 * parser reads shapes rather than words: an answer that draws a decision as a
 * box produces a diagram that says the wrong thing rather than one that fails
 * to parse.
 */
const INSTRUCTION = [
  "",
  "Draw this as a Mermaid flowchart.",
  "",
  "Reply with exactly one fenced ```mermaid block and nothing else.",
  "Use `flowchart TD`. Use only these shapes:",
  "- ([Stadium]) for where the flow begins and for each outcome",
  "- [Box] for a step someone or something does",
  "- {Diamond} for a decision, with the answer written on each arrow leaving it",
  "- [[Subroutine]] for a flow described elsewhere",
  "- (Round) for a document, record or dataset the flow handles",
  "",
  "Label every arrow that leaves a decision. Keep labels short.",
].join("\n");

export interface DiagramAnswer {
  /** The parsed diagram, or null when the reply was not a diagram this reads. */
  readonly graph: FlowGraph | null;
  /** What the agent actually said. Shown when `graph` is null. */
  readonly text: string;
}

/** How long to wait for the turn to finish, and how often to look. */
const POLL_MS = 600;
const POLL_LIMIT = 300;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Ask for a diagram and wait for it.
 *
 * Returns `graph: null` rather than throwing when the reply cannot be parsed.
 * A half-parsed diagram would silently assert a process nobody described, so
 * the caller shows the raw text and puts nothing on the canvas.
 */
export const askForDiagram = async (
  prompt: string,
  projectId: string | null,
): Promise<DiagramAnswer> => {
  const { sessionId } = await call("sessions:create", {
    title: `Diagram: ${prompt.slice(0, 60)}`,
  });

  const { turnId } = await callAs<{ turnId: string }>("sessions:sendMessage", {
    sessionId,
    content: `${prompt}\n${INSTRUCTION}`,
    skills: ["flow-modeling"],
    subMode: "flow",
    projectId,
  });

  let turn: TurnState | null = null;
  for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
    turn = await callAs<TurnState>("sessions:getTurn", { turnId });
    if (isTerminal(turn.status)) break;
    await pause(POLL_MS);
  }

  if (turn === null) return { graph: null, text: "" };
  if (turn.error !== null) throw new Error(turn.error);

  const text =
    [...turn.messages].reverse().find((message) => message.role === "assistant")?.content ?? "";

  return { graph: draftFromMermaid(text, prompt.slice(0, 80), projectId), text };
};
