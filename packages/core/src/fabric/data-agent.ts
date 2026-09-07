import { DATA_AGENT_API_VERSION, FabricAnswer } from "@iq/shared";
import type { Logger } from "../util/logger.js";
import { hostOf as sharedHostOf } from "../util/text.js";

/**
 * The published Fabric Data Agent.
 *
 * This adapter acquires a Fabric token, resolves or creates a per-session
 * Fabric thread, submits the user message, polls the run, and streams the
 * assistant response. The surface is OpenAI-compatible Assistants, so the
 * sequence is create assistant → resolve thread → post message → create run →
 * poll → read messages and steps.
 *
 * Three details are non-obvious, and each is the difference between working and
 * not, because none is discoverable from the shape of the API:
 *
 *  - **The thread endpoint is not the Assistants one.** A Fabric thread is
 *    addressed on a `/threads/fabric?tag="<name>"` route under a rewritten base
 *    URL, so the same conversation can be resumed by name instead of by an id
 *    this app would have to store.
 *  - **`aiskills` is the old spelling of `dataagents`.** URLs copied from the
 *    portal still carry it; rewriting is cheaper than telling every user their
 *    correct URL is wrong.
 *  - **The assistant is cached per URL and session.** Creating one per message
 *    works and quietly litters the workspace.
 *
 * The answer is untrusted content. It is data returned by a service that
 * queried the user's own warehouse; it is never treated as instructions, which
 * is why this module returns a string and a trace rather than anything a caller
 * could mistake for a tool call.
 */

export interface DataAgentDeps {
  logger: Logger;
  /** Acquire an Azure access token for `azure.fabric`. */
  token: (correlationId: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}

const POLL_INTERVAL_MS = 2_000;
const RUN_TIMEOUT_MS = 120_000;

export class FabricDataAgentClient {
  private readonly fetchImpl: typeof fetch;
  /** Keyed by `<base url>::<session>`; cleared with the process. */
  private readonly assistants = new Map<string, string>();

  constructor(private readonly deps: DataAgentDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async ask(input: {
    baseUrl: string;
    question: string;
    /** Names the Fabric thread, so one conversation keeps its context. */
    sessionId: string;
    correlationId: string;
    signal?: AbortSignal;
  }): Promise<FabricAnswer> {
    const base = normalizeBaseUrl(input.baseUrl);
    if (base === "") {
      throw new Error(
        "No published Fabric Data Agent URL is registered. Add one in Connections & access to ask questions of your data.",
      );
    }

    const token = await this.deps.token(input.correlationId);
    const trace: string[] = ["Fabric Data Agent."];

    const cacheKey = `${base}::${input.sessionId}`;
    let assistantId = this.assistants.get(cacheKey) ?? "";
    if (assistantId === "") {
      // `model` is required by the Assistants schema and ignored by Fabric: the
      // Data Agent decides what answers, not the caller.
      const assistant = await this.post(agentUrl(base, "assistants"), token, { model: "not used" });
      assistantId = String((assistant as { id?: unknown }).id ?? "");
      if (assistantId !== "") this.assistants.set(cacheKey, assistantId);
    }

    const thread = await this.get(threadUrl(base, `iq-compiler-${input.sessionId}`), token);
    const threadId = String((thread as { id?: unknown }).id ?? "");
    if (threadId === "" || assistantId === "") {
      throw new Error("the Fabric Data Agent did not return a usable assistant or thread id");
    }
    trace.push(`Thread: ${String((thread as { name?: unknown }).name ?? threadId)}.`);

    await this.post(agentUrl(base, `threads/${encodeURIComponent(threadId)}/messages`), token, {
      role: "user",
      content: input.question,
    });

    const run = await this.post(agentUrl(base, `threads/${encodeURIComponent(threadId)}/runs`), token, {
      assistant_id: assistantId,
    });

    const settled = await this.awaitRun(base, token, threadId, String((run as { id?: unknown }).id ?? ""), input.signal);
    trace.push(`Run status: ${String((settled as { status?: unknown }).status ?? "unknown")}.`);

    const messages = await this.get(
      agentUrl(base, `threads/${encodeURIComponent(threadId)}/messages`, { order: "asc" }),
      token,
    );
    const steps = await this.get(
      agentUrl(
        base,
        `threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(
          String((settled as { id?: unknown }).id ?? ""),
        )}/steps`,
      ),
      token,
    ).catch(() => ({}));

    for (const call of toolCallNames(steps)) trace.push(`Tool call: ${call}.`);

    return FabricAnswer.parse({
      answer: assistantText(messages),
      trace: [...new Set(trace)],
      threadId,
    });
  }

  private async awaitRun(
    base: string,
    token: string,
    threadId: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = agentUrl(
      base,
      `threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}`,
    );
    const deadline = Date.now() + RUN_TIMEOUT_MS;

    let run = await this.get(url, token);
    while (["queued", "in_progress"].includes(String((run as { status?: unknown }).status))) {
      if (signal?.aborted) throw new Error("the Fabric Data Agent question was cancelled");
      if (Date.now() > deadline) {
        throw new Error(
          `the Fabric Data Agent run did not finish within ${RUN_TIMEOUT_MS / 1000} seconds`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      run = await this.get(url, token);
    }
    return run;
  }

  // --- transport ------------------------------------------------------------

  private get(url: string, token: string): Promise<unknown> {
    return this.request(url, token, { method: "GET" });
  }

  private post(url: string, token: string, body: unknown): Promise<unknown> {
    return this.request(url, token, { method: "POST", body: JSON.stringify(body) });
  }

  private async request(url: string, token: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        // Fabric correlates server-side traces by this header; a support case
        // without one is unanswerable.
        ActivityId: crypto.randomUUID(),
        ...init.headers,
      },
    });

    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      // Host only, never the full URL: a Data Agent URL carries the workspace
      // and item id in its path.
      this.deps.logger.debug("fabric data agent call failed", {
        host: hostOf(url),
        status: response.status,
      });
      throw new Error(`the Fabric Data Agent returned HTTP ${response.status}: ${text}`);
    }

    const text = await response.text();
    return text.trim() === "" ? {} : (JSON.parse(text) as unknown);
  }
}

// --- URL construction --------------------------------------------------------

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function agentUrl(base: string, path: string, params: Record<string, string> = {}): string {
  const url = new URL(`${normalizeBaseUrl(base)}/${path.replace(/^\/+/, "")}`);
  url.searchParams.set("api-version", DATA_AGENT_API_VERSION);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * The Fabric thread route.
 *
 * Three rewrites, each of which exists because a URL a user can legitimately
 * paste does not already point here: `aiskills` is the pre-rename spelling of
 * `dataagents`, the Assistants surface hangs off `/openai` which the thread
 * route does not use, and `aiassistant` lives under a `__private` prefix.
 */
export function threadUrl(base: string, threadName: string): string {
  let root = normalizeBaseUrl(base);
  if (root.includes("aiskills")) root = root.replace("aiskills", "dataagents");
  root = root.replace(/\/openai$/i, "").replace("/aiassistant", "/__private/aiassistant");

  const url = new URL(`${root}/threads/fabric`);
  url.searchParams.set("tag", `"${threadName}"`);
  return url.toString();
}

// --- response shaping --------------------------------------------------------

/** The latest assistant message, flattened out of the content-part array. */
export function assistantText(messages: unknown): string {
  const data = (messages as { data?: unknown }).data;
  if (!Array.isArray(data)) return "The Fabric Data Agent returned no messages.";

  const latest = data.filter((row) => (row as { role?: unknown }).role === "assistant").at(-1);
  const content = (latest as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "The Fabric Data Agent returned no answer.";

  const parts: string[] = [];
  for (const item of content) {
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string" && text.trim() !== "") parts.push(text.trim());
    else {
      const value = (text as { value?: unknown } | undefined)?.value;
      if (typeof value === "string" && value.trim() !== "") parts.push(value.trim());
    }
  }

  return parts.join("\n").trim() || "The Fabric Data Agent returned no answer.";
}

/** Tool names from the run steps, so a wrong answer can be traced to a query. */
export function toolCallNames(steps: unknown): string[] {
  const data = (steps as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const names: string[] = [];
  for (const step of data) {
    const calls = (step as { step_details?: { tool_calls?: unknown } }).step_details?.tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const name = (call as { function?: { name?: unknown } }).function?.name;
      if (typeof name === "string" && name.trim() !== "") names.push(name);
    }
  }
  return [...new Set(names)];
}

const hostOf = (url: string): string => sharedHostOf(url, "(unparseable)");
