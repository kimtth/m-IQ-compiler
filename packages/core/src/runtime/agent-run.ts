/**
 * The contract for running one headless agent turn.
 *
 * Research, the council and Fabric all need "ask a model this prompt and give
 * me the answer" with no conversation attached, and all three are handed the
 * body by the orchestrator. The contract lives here rather than inside any one
 * of them because none of the three owns it: Fabric importing a type from
 * `research/` would say something untrue about where the dependency lies.
 *
 * `modelId` is optional on purpose. Research and the council resolve a model
 * for a role and name it; a Fabric run has no opinion about which model builds
 * an item and takes the runtime default. Absent or empty means exactly that.
 */

/**
 * What a headless turn is *for*, in a form a title can be composed from.
 *
 * Kept structured rather than a free string so every caller states the same two
 * things and the wording is decided in one place ({@link titleForLabel}). The
 * session title is a durable record — it is written to the session log and read
 * back when a run is audited — so it must not drift per call site.
 */
export interface AgentRunLabel {
  kind: "council" | "research" | "fabric";
  /** What this particular turn is, e.g. `Chair · verdict`. May be empty. */
  detail: string;
}

/** What the injected agent runner accepts. The orchestrator supplies the body. */
export interface AgentRunRequest {
  prompt: string;
  /** Names this turn in the durable session log. */
  label: AgentRunLabel;
  /** Catalogue id. Absent or empty means the runtime default. */
  modelId?: string;
  toolFamilies: string[];
  skills?: string[];
  signal?: AbortSignal;
}

/** What the injected agent runner returns: the text plus a tool-call summary. */
export interface AgentRunResult {
  text: string;
  toolCalls: Array<{ name: string; summary: string; ok: boolean }>;
}

export type RunAgent = (input: AgentRunRequest) => Promise<AgentRunResult>;

const KIND_TITLE: Record<AgentRunLabel["kind"], string> = {
  council: "Council",
  research: "Research",
  fabric: "Fabric",
};

/** Session titles are a list column, not a document. */
const MAX_DETAIL = 120;

/**
 * Compose the session title for a headless turn.
 *
 * Every `sub_agent` session was titled "Headless run", so a council run left a
 * dozen identical rows in the store with nothing to tell them apart. The title
 * is not shown in the rail — `sub_agent` sessions are deliberately not listed —
 * but it is what a person reads when they open the session log to find out what
 * a run actually did.
 */
export function titleForLabel(label: AgentRunLabel): string {
  const head = KIND_TITLE[label.kind];
  const detail = label.detail.replace(/\s+/g, " ").trim();
  if (detail === "") return head;
  const clipped =
    detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL - 1).trimEnd()}…` : detail;
  return `${head} · ${clipped}`;
}
