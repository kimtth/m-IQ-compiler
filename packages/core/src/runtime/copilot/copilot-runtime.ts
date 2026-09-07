import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  CopilotClient,
  RuntimeConnection,
  type CopilotSession,
  type PermissionRequest as SdkPermissionRequest,
  type PermissionRequestResult,
  type SessionEvent as SdkSessionEvent,
} from "@github/copilot-sdk";
import {
  TurnEvent,
  newToolCallId,
  type CopilotAuthStatus,
  type DraftTurnEvent,
  type PermissionRequest,
  type RiskLevel,
  type TokenUsage,
} from "@iq/shared";
import type { TurnRepo } from "../turns/fs-repo.js";
import type { ToolContext, ToolRegistry, ApprovalBroker } from "../tools/registry.js";
import type { Logger } from "../../util/logger.js";

/**
 * GitHub Copilot SDK runtime bridge.
 *
 * The SDK is the agent runtime: it owns planning, model calls, tool invocation
 * and its own session store. IQ Compiler does not reimplement any of that.
 * What this bridge adds is the governance and durability layer:
 *
 *  - every SDK event that matters is mirrored into our append-only turn log, so
 *    a turn can be replayed after a crash independently of the SDK's store, even
 *    if a live stream is missed;
 *  - permission requests for the SDK's *built-in* tools are routed through our
 *    policy chain rather than auto-approved;
 *  - our own Microsoft tools are registered as SDK tools but gated internally
 *    by ToolRegistry, so the approval and audit record is written before the
 *    side effect begins.
 */

export interface AgentSessionSpec {
  /** Our session id. Also used as the SDK session id so the two stores align. */
  sessionId: string;
  model: string;
  /** Tool families this session may use. Empty means every registered family. */
  allowedFamilies: string[];
  skillDirectories: string[];
  disabledSkills: string[];
  workingDirectory: string;
  /** Extra system-prompt content appended to the SDK foundation. */
  systemPromptAppendix?: string;
  /** Work IQ / Microsoft MCP servers to attach to this session. */
  mcpServers?: Record<string, unknown>;
}

export interface RunTurnSpec {
  sessionId: string;
  turnId: string;
  correlationId: string;
  prompt: string;
  signal?: AbortSignal;
  /** Wall-clock cap. A hung model call must not hold the session forever. */
  timeoutMs?: number;
}

/**
 * How long one interactive turn may take.
 *
 * This budget is **wall clock, and the user is inside it**: a turn that suspends
 * on an approval card is still spending it, and so is every subprocess a tool
 * runs. Building a six-slide deck is one `office_create_document` plus six
 * `office_add_content` calls, each of which may stop and wait for a person to
 * read a card and click — at five minutes that turn died on the approval queue
 * and reported `Timeout after 300000ms waiting for session.idle`, which reads as
 * a product fault and is really a stopwatch running while nobody is being asked
 * to hurry.
 *
 * Thirty minutes is not a licence to hang: cancellation is immediate and
 * user-driven, `session.error` still fails the turn at once, and each tool keeps
 * its own much shorter cap (OfficeCLI is 60s a call). This is only the outer
 * bound for "the turn as a whole has stopped making progress".
 *
 * Unattended work is *not* covered by this: a scheduled job carries its own
 * `timeoutMs` (10 minutes by default) precisely because no one is watching it.
 */
export const INTERACTIVE_TURN_TIMEOUT_MS = 30 * 60_000;

/**
 * How long one turn that nobody is watching may take.
 *
 * A third of the interactive budget, because the reason that one is generous
 * does not apply: there is no card to read and no person to wait for, so time
 * spent here is time spent stuck. Thirty minutes was being spent that way on
 * every delegated question \u2014 a sub-agent suspended on an approval it could not
 * receive burned the full interactive budget, was retried once, and cost an
 * hour and two Copilot sessions to produce nothing.
 *
 * The deadlock itself is fixed in `SessionsService.decide`; this is the cap
 * that keeps a merely slow unattended turn from looking the same way.
 */
export const UNATTENDED_TURN_TIMEOUT_MS = 10 * 60_000;

export interface RunTurnResult {
  status: "completed" | "failed" | "cancelled";
  assistantText: string;
  usage: TokenUsage;
  error: string | null;
}

export interface CopilotRuntimeDeps {
  turnRepo: TurnRepo;
  toolRegistry: ToolRegistry;
  broker: ApprovalBroker;
  logger: Logger;
  /** Emits every durable event so the UI can stream without polling. */
  publish: (event: TurnEvent) => void;
  /**
   * Deny floor for MCP tool calls.
   *
   * The session is configured with only approved tools, but a server is a third
   * party and the runtime is not ours: this is the check that still holds if a
   * call arrives for something nobody approved.
   */
  mcpGate?: (toolName: string) => Promise<{ allowed: boolean; reason: string }>;
  /**
   * Told whether each configured MCP server actually came up.
   *
   * The runtime starts every server the session declares and carries on without
   * the ones that fail, so a server can be enabled, approved and completely
   * absent at the same time. Nothing else in the app hears about that.
   */
  onMcpServerStatus?: (status: { id: string; ok: boolean; error: string }) => void;
  clientFactory?: () => CopilotClient;
}

/**
 * Environment for the spawned Copilot runtime process.
 *
 * The SDK launches the CLI with `process.execPath`. Inside Electron that is
 * `electron.exe`, which would start a second GUI instance and exit instead of
 * running the runtime; `ELECTRON_RUN_AS_NODE` makes it behave as plain Node.
 *
 * Inherited GitHub token variables are stripped. A stale or wrongly scoped
 * token in the parent environment takes priority over the SDK's own stored
 * credential and then surfaces as "No model available" — a failure that gives
 * no hint that authentication is the cause. Letting the runtime use its own
 * device-flow credential keeps the connection state legible.
 */
function runtimeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  for (const key of STALE_GITHUB_ENV) delete env[key];
  return env;
}

export const STALE_GITHUB_ENV = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_COPILOT_TOKEN",
  "COPILOT_API_KEY",
] as const;

const require_ = createRequire(import.meta.url);

/**
 * Locate the native `copilot` executable shipped in the platform package.
 *
 * Running the CLI's JavaScript entry point under Electron does not work even
 * with `ELECTRON_RUN_AS_NODE`: the CLI parses its arguments with commander,
 * which switches to Electron argument conventions whenever
 * `process.versions.electron` is present and then treats the script path as a
 * positional argument. The native executable has no such ambiguity, so it is
 * preferred whenever it can be found. Returning null falls back to the SDK's
 * own resolution, which is correct outside Electron.
 */
/**
 * The native `copilot` executable the app itself runs, for anything else that
 * needs to speak to the same CLI.
 *
 * Exported because the research sidecar is a *second* process that drives this
 * same binary from Python, and it must be the same one: the CLI's credential
 * store belongs to the binary, so a sidecar that found a different `copilot` on
 * PATH — or none — would be asked to sign in on a machine that already is.
 * Sharing the executable is what makes "the app is signed in" mean the sidecar
 * is too.
 */
export function copilotExecutable(): string | null {
  return bundledExecutable();
}

function bundledExecutable(): string | null {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const candidates =
    process.platform === "linux"
      ? [`@github/copilot-linux-${process.arch}`, `@github/copilot-linuxmusl-${process.arch}`]
      : [`@github/copilot-${process.platform}-${process.arch}`];

  for (const name of candidates) {
    try {
      // The platform packages are optional dependencies of `@github/copilot`,
      // so resolution has to start from that package rather than from here.
      // Their root export points straight at the native executable.
      const hostRequire = createRequire(require_.resolve("@github/copilot/package.json"));
      const resolved = hostRequire.resolve(name);
      if (path.basename(resolved) === `copilot${suffix}` && existsSync(resolved)) return resolved;
    } catch {
      // Try the next candidate; a missing platform package is not fatal.
    }
  }
  return null;
}

function defaultClient(): CopilotClient {
  const executable = bundledExecutable();
  return new CopilotClient({
    env: runtimeEnv(),
    ...(executable ? { connection: RuntimeConnection.forStdio({ path: executable }) } : {}),
  });
}

/**
 * The parts of a session specification that the SDK cannot change live.
 *
 * The key stays in memory and is never logged. In particular, an MCP server's
 * environment can contain a secret, so it must not be included in diagnostics.
 */
function sessionConfigKey(spec: AgentSessionSpec): string {
  return JSON.stringify({
    model: spec.model,
    allowedFamilies: spec.allowedFamilies,
    skillDirectories: spec.skillDirectories,
    disabledSkills: spec.disabledSkills,
    workingDirectory: spec.workingDirectory,
    systemPromptAppendix: spec.systemPromptAppendix ?? "",
    mcpServers: stableConfigValue(spec.mcpServers ?? {}),
  });
}

/** Sort object keys so equivalent MCP records produce the same session key. */
function stableConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableConfigValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableConfigValue(entry)]),
    );
  }
  return value;
}

export class CopilotRuntime {
  private client: CopilotClient | null = null;
  private readonly sessions = new Map<string, CopilotSession>();
  /** Configuration each cached session was built with, so a changed tool surface can rebuild it. */
  private readonly sessionConfigKeys = new Map<string, string>();
  /** Per-turn monotonic sequence, so durable events keep a total order. */
  private readonly sequences = new Map<string, number>();

  constructor(private readonly deps: CopilotRuntimeDeps) {}

  async start(): Promise<void> {
    if (this.client) return;
    this.client = this.deps.clientFactory?.() ?? defaultClient();
    await this.client.start();
    this.deps.logger.info("copilot runtime started");
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.disconnect().catch(() => undefined);
    }
    this.sessions.clear();
    this.sessionConfigKeys.clear();
    if (this.client) {
      const errors = await this.client.stop();
      for (const error of errors) this.deps.logger.warn("copilot shutdown error", { error: error.message });
      this.client = null;
    }
  }

  private requireClient(): CopilotClient {
    if (!this.client) throw new Error("copilot runtime is not started");
    return this.client;
  }

  /**
   * Read the Copilot connection state from the SDK.
   *
   * IQ Compiler never stores or refreshes the credential itself; it reports what
   * the runtime says so the UI can ask for a sign-in before a turn is attempted
   * rather than after one fails.
   */
  async authStatus(): Promise<CopilotAuthStatus> {
    if (!this.client) return { state: "unknown" };
    try {
      const status = await this.client.getAuthStatus();
      if (!status.isAuthenticated) {
        return {
          state: "signed_out",
          message:
            status.statusMessage ??
            "Sign in to GitHub Copilot to enable the agent runtime. Run `copilot` in a terminal and complete the device-code flow.",
        };
      }
      return {
        state: "signed_in",
        login: status.login ?? null,
        host: status.host ?? null,
        authType: status.authType ?? null,
      };
    } catch (error) {
      return { state: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * The Copilot side of the model catalogue.
   *
   * The SDK does advertise a real catalogue for the signed-in account —
   * `CopilotClient.listModels()` returns `ModelInfo[]` (id, display name and a
   * capability/limits block) — so this is a faithful read rather than a
   * hand-maintained guess. It is shaped into the neutral row the model registry
   * merges with Foundry entries, keeping the runtime out of the registry.
   *
   * The SDK's capability block only describes vision and reasoning-effort
   * support explicitly; every advertised model can chat, so `chat` is always
   * present and the other two are added when the SDK reports them. A model whose
   * policy state is `disabled` is returned but marked unavailable, so the picker
   * can show it greyed rather than silently dropping it. Before the runtime has
   * started there is nothing to ask, and an empty list is the honest answer.
   */
  async listModels(): Promise<
    Array<{ id: string; name: string; available: boolean; capabilities: string[] }>
  > {
    if (!this.client) return [];
    const models = await this.client.listModels();
    return models.map((model) => {
      const capabilities = ["chat"];
      if (model.capabilities?.supports?.vision) capabilities.push("vision");
      if (model.capabilities?.supports?.reasoningEffort) capabilities.push("reasoning");
      return {
        id: model.id,
        name: model.name ?? model.id,
        available: model.policy ? model.policy.state !== "disabled" : true,
        capabilities,
      };
    });
  }

  /**
   * Get or create the SDK session backing one IQ Compiler session.
   *
   * Resume is attempted first so that a restart continues the same conversation
   * rather than silently starting a fresh one.
   */
  async ensureSession(spec: AgentSessionSpec): Promise<CopilotSession> {
    const existing = this.sessions.get(spec.sessionId);
    const configKey = sessionConfigKey(spec);
    if (existing) {
      // The SDK cannot change a live session's model, tool set or MCP servers.
      // Rebuild the handle from the durable session when any of them changes.
      // This matters when Work IQ is enabled after a conversation already
      // exists: without it, the server remains absent until the app restarts.
      if (this.sessionConfigKeys.get(spec.sessionId) === configKey) return existing;
      await existing.disconnect().catch(() => undefined);
      this.sessions.delete(spec.sessionId);
      this.sessionConfigKeys.delete(spec.sessionId);
      this.deps.logger.info("rebuilding copilot session for a configuration change", {
        sessionId: spec.sessionId,
      });
    }

    const client = this.requireClient();
    const contextRef = { current: null as ToolContext | null };

    const config = {
      model: spec.model,
      clientName: "IQ Compiler",
      workingDirectory: spec.workingDirectory,
      skillDirectories: spec.skillDirectories,
      disabledSkills: spec.disabledSkills,
      tools: this.deps.toolRegistry.toSdkTools(
        spec.allowedFamilies,
        () => {
          const context = contextRef.current;
          if (!context) throw new Error("tool invoked outside an active turn");
          return context;
        },
      ),
      onPermissionRequest: (request: SdkPermissionRequest): Promise<PermissionRequestResult> =>
        this.decideBuiltinPermission(request, contextRef),
      // Registered here rather than with `session.on` after the fact, because
      // the MCP servers start *during* the create/resume call: the SDK
      // documents `onEvent` as the hook that is attached before the RPC is
      // issued, and a listener added afterwards misses every startup result.
      onEvent: (event: SdkSessionEvent): void => this.noteMcpStatus(event),
      ...(spec.systemPromptAppendix
        ? { systemMessage: { mode: "append" as const, content: spec.systemPromptAppendix } }
        : {}),
      ...(spec.mcpServers ? { mcpServers: spec.mcpServers as never } : {}),
    };

    let session: CopilotSession;
    try {
      session = await client.resumeSession(spec.sessionId, config);
      this.deps.logger.info("resumed copilot session", { sessionId: spec.sessionId });
    } catch {
      session = await client.createSession({ ...config, sessionId: spec.sessionId });
      this.deps.logger.info("created copilot session", { sessionId: spec.sessionId });
    }

    // Stash the context holder so tool handlers and the permission handler can
    // reach the currently executing turn.
    contextHolders.set(session, contextRef);
    this.sessions.set(spec.sessionId, session);
    this.sessionConfigKeys.set(spec.sessionId, configKey);
    return session;
  }

  /**
   * Report what became of each MCP server the session asked for.
   *
   * The runtime starts every configured server in parallel when it builds a
   * session, gives each a fixed handshake budget, and carries on without the
   * ones that miss it. Nothing fails: the session comes up, the turn runs, and
   * the tools from the missing server are simply not there. Without this, the
   * app had no idea — the MCP page went on showing the state of the last manual
   * Inspect, and the only sign was the model saying mid-conversation that a
   * tool it had a moment ago was gone.
   *
   * `pending` is skipped because it is the question, not the answer, and the
   * settled event always follows. `disabled` and `not_configured` describe the
   * runtime's own configuration rather than a connection attempt, so they say
   * nothing about a server this app asked for.
   */
  private noteMcpStatus(event: SdkSessionEvent): void {
    const settle = (name: unknown, status: unknown, error: unknown): void => {
      if (typeof name !== "string" || name === "") return;
      if (status !== "connected" && status !== "failed" && status !== "needs-auth") return;
      this.deps.onMcpServerStatus?.({
        id: name,
        ok: status === "connected",
        error:
          typeof error === "string" && error !== ""
            ? error
            : status === "needs-auth"
              ? "the server requires sign-in before it can connect"
              : "the server did not start for this session",
      });
    };

    if (event.type === "session.mcp_server_status_changed") {
      const data = eventData(event);
      settle(data["serverName"], data["status"], data["error"]);
      return;
    }
    if (event.type === "session.mcp_servers_loaded") {
      const servers = eventData(event)["servers"];
      if (!Array.isArray(servers)) return;
      for (const entry of servers) {
        if (entry === null || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        settle(record["name"], record["status"], record["error"]);
      }
    }
  }

  /**
   * Execute one turn, mirroring SDK events into the durable log as they arrive.
   *
   * The mirror is written before the promise resolves, so if the process dies
   * mid-turn the log still shows exactly how far the turn got.
   */
  async runTurn(session: CopilotSession, spec: RunTurnSpec): Promise<RunTurnResult> {
    const contextRef = contextHolders.get(session);
    if (contextRef) {
      contextRef.current = {
        sessionId: spec.sessionId,
        turnId: spec.turnId,
        correlationId: spec.correlationId,
        logger: this.deps.logger.child({
          sessionId: spec.sessionId,
          turnId: spec.turnId,
          correlationId: spec.correlationId,
        }),
      };
    }

    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let assistantText = "";
    let failure: string | null = null;

    const appendChain: Array<Promise<void>> = [];
    const record = (event: TurnEvent): void => {
      appendChain.push(
        this.deps.turnRepo
          .append(spec.turnId, [event])
          .then(() => this.deps.publish(event))
          .catch((error: unknown) => {
            this.deps.logger.error("failed to persist turn event", {
              turnId: spec.turnId,
              error: error instanceof Error ? error.message : String(error),
            });
          }),
      );
    };

    const unsubscribe = session.on((event: SdkSessionEvent) => {
      switch (event.type) {
        case "assistant.message": {
          const content = readString(event, "content");
          if (content) {
            assistantText = content;
            record(this.event(spec.turnId, { type: "assistant_message", content }));
          }
          const outputTokens = readNumber(event, "outputTokens");
          if (outputTokens) usage.outputTokens += outputTokens;
          break;
        }
        case "assistant.reasoning_delta": {
          const content = readString(event, "content") ?? readString(event, "delta");
          if (content) {
            record(this.event(spec.turnId, { type: "reasoning_delta", content }));
          }
          break;
        }
        case "assistant.usage": {
          usage.inputTokens += readNumber(event, "inputTokens") ?? 0;
          usage.outputTokens += readNumber(event, "outputTokens") ?? 0;
          break;
        }
        case "tool.execution_complete": {
          const toolCallId = readString(event, "toolCallId") ?? newToolCallId();
          record(
            this.event(spec.turnId, {
              type: "tool_call_completed",
              toolCallId,
              // The SDK gives the permission handler no tool-call id, so this
              // id will not match the one on the request. The name is what lets
              // the fold pair them; without it the transcript can only guess.
              toolName: readToolName(event),
              ok: readBoolean(event, "success") ?? true,
              result: readToolResult(event),
              // Anything a tool returns re-enters the model context and is
              // outside our trust boundary.
              untrusted: true,
            }),
          );
          break;
        }
        case "session.error": {
          failure = readString(event, "message") ?? "session error";
          break;
        }
        default:
          break;
      }
    });

    try {
      if (spec.signal?.aborted) throw new AbortError("cancelled before start");

      const onAbort = (): void => void session.abort().catch(() => undefined);
      spec.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        await session.sendAndWait(
          { prompt: spec.prompt },
          spec.timeoutMs ?? INTERACTIVE_TURN_TIMEOUT_MS,
        );
      } finally {
        spec.signal?.removeEventListener("abort", onAbort);
      }

      await Promise.all(appendChain);

      if (spec.signal?.aborted) {
        const event = this.event(spec.turnId, { type: "turn_cancelled", reason: "cancelled by user" });
        await this.deps.turnRepo.append(spec.turnId, [event]);
        this.deps.publish(event);
        return { status: "cancelled", assistantText, usage, error: "cancelled by user" };
      }

      if (failure) {
        const event = this.event(spec.turnId, {
          type: "turn_failed",
          error: failure,
          retryable: true,
        });
        await this.deps.turnRepo.append(spec.turnId, [event]);
        this.deps.publish(event);
        return { status: "failed", assistantText, usage, error: failure };
      }

      const event = this.event(spec.turnId, { type: "turn_completed", usage });
      await this.deps.turnRepo.append(spec.turnId, [event]);
      this.deps.publish(event);
      return { status: "completed", assistantText, usage, error: null };
    } catch (error) {
      await Promise.all(appendChain);
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = error instanceof AbortError || spec.signal?.aborted === true;
      const event = cancelled
        ? this.event(spec.turnId, { type: "turn_cancelled", reason: message })
        : this.event(spec.turnId, { type: "turn_failed", error: message, retryable: true });
      await this.deps.turnRepo.append(spec.turnId, [event]);
      this.deps.publish(event);
      return {
        status: cancelled ? "cancelled" : "failed",
        assistantText,
        usage,
        error: message,
      };
    } finally {
      unsubscribe();
      if (contextRef) contextRef.current = null;
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await session.disconnect().catch(() => undefined);
    this.sessions.delete(sessionId);
    this.sessionConfigKeys.delete(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.closeSession(sessionId);
    await this.client?.deleteSession(sessionId).catch(() => undefined);
  }

  /** Allocate the next sequence number and stamp a durable event. */
  private event(turnId: string, partial: DraftTurnEvent): TurnEvent {
    const seq = (this.sequences.get(turnId) ?? -1) + 1;
    this.sequences.set(turnId, seq);
    return TurnEvent.parse({ ...partial, turnId, seq, at: new Date().toISOString() });
  }

  /** Seed the sequence counter from the durable log when resuming a turn. */
  primeSequence(turnId: string, lastSeq: number): void {
    this.sequences.set(turnId, lastSeq);
  }

  /**
   * Route an SDK built-in tool permission request through our policy chain.
   *
   * Without this the SDK would apply its own defaults; instead every built-in
   * side effect lands in the same approval and audit path as our Microsoft
   * tools, and an unknown request kind fails closed.
   */
  private async decideBuiltinPermission(
    request: SdkPermissionRequest,
    contextRef: { current: ToolContext | null },
  ): Promise<PermissionRequestResult> {
    const context = contextRef.current;
    if (!context) return { kind: "reject", feedback: "no active turn" };

    const normalized = normalizeSdkPermission(request);

    // An MCP call is checked against the user's per-tool grants before the
    // policy chain even sees it, so an unapproved tool cannot be allowed by a
    // broad "allow always" the user gave for something else.
    if (normalized.family === "copilot.mcp" && this.deps.mcpGate) {
      const gate = await this.deps.mcpGate(normalized.toolName);
      if (!gate.allowed) return { kind: "reject", feedback: gate.reason };
    }

    const outcome = await this.deps.broker.decide(normalized, context);

    if (outcome.decision === "allow" || outcome.decision === "allow_always") {
      return { kind: "approve-once" };
    }
    return { kind: "reject", feedback: outcome.reason };
  }
}

/** Ties an SDK session to the turn context its handlers should see. */
const contextHolders = new WeakMap<CopilotSession, { current: ToolContext | null }>();

class AbortError extends Error {
  override readonly name = "AbortError";
}

/**
 * Map an SDK permission request onto our normalized shape.
 *
 * Risk assignment is intentionally pessimistic: an unrecognised kind is treated
 * as destructive so it can never slip through a read-only fast path.
 *
 * Exported for test. This table is what auto-approval answers against, so "a
 * URL fetch is external, not read" is a claim worth pinning rather than a
 * detail buried in a private function.
 */
export function normalizeSdkPermission(request: SdkPermissionRequest): PermissionRequest {
  const kind = (request as { kind?: string }).kind ?? "unknown";

  const RISK: Record<string, RiskLevel> = {
    read: "read",
    path: "read",
    write: "write",
    memory: "write",
    shell: "destructive",
    url: "external",
    mcp: "external",
    "custom-tool": "external",
    hook: "external",
    "extension-management": "destructive",
    "extension-permission-access": "destructive",
  };

  return {
    toolCallId: newToolCallId(),
    toolName: (request as { toolName?: string }).toolName ?? `copilot.${kind}`,
    family: `copilot.${kind}`,
    risk: RISK[kind] ?? "destructive",
    summary: describeSdkPermission(request, kind),
    requiredScopes: [],
    resources: collectResources(request),
  };
}

function describeSdkPermission(request: SdkPermissionRequest, kind: string): string {
  const record = request as unknown as Record<string, unknown>;
  if (kind === "shell" && Array.isArray(record["commands"])) {
    return `Run shell command: ${(record["commands"] as unknown[]).join(" && ").slice(0, 200)}`;
  }
  if (kind === "write" && typeof record["fileName"] === "string") {
    return `Write file ${record["fileName"]}`;
  }
  if (kind === "read" && typeof record["fileName"] === "string") {
    return `Read file ${record["fileName"]}`;
  }
  if (kind === "url" && typeof record["url"] === "string") {
    return `Fetch URL ${record["url"]}`;
  }
  if (kind === "mcp" && typeof record["toolName"] === "string") {
    return `Call MCP tool ${record["toolName"]}`;
  }
  return `Copilot requested a ${kind} permission`;
}

function collectResources(request: SdkPermissionRequest): string[] {
  const record = request as unknown as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["fileName", "url", "toolName", "path"]) {
    const value = record[key];
    if (typeof value === "string") out.push(value);
  }
  return out;
}

// --- defensive readers over loosely typed SDK event payloads ----------------

function eventData(event: SdkSessionEvent): Record<string, unknown> {
  const data = (event as { data?: unknown }).data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

function readString(event: SdkSessionEvent, key: string): string | null {
  const value = eventData(event)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(event: SdkSessionEvent, key: string): number | null {
  const value = eventData(event)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(event: SdkSessionEvent, key: string): boolean | null {
  const value = eventData(event)[key];
  return typeof value === "boolean" ? value : null;
}

/**
 * What a tool actually returned, for the transcript to show.
 *
 * This was hardcoded to `null`, so the `result` field the event schema has
 * always carried was always empty and every entry in the transcript read "No
 * output recorded." — which is most of what made the transcript worth
 * collapsing in the first place.
 *
 * `detailedContent` is the SDK's own UI-facing field and falls back to
 * `content`, the shorter text sent to the model. Truncated on the way in:
 * this is a durable log, a tool can return a whole file, and a transcript is
 * not a place to read one.
 */
function readToolResult(event: SdkSessionEvent): string | null {
  const result = eventData(event)["result"];
  if (!result || typeof result !== "object") return null;

  const record = result as Record<string, unknown>;
  const detailed = record["detailedContent"];
  const content = record["content"];
  const text = typeof detailed === "string" && detailed !== "" ? detailed : content;
  if (typeof text !== "string" || text === "") return null;

  return text.length > MAX_TOOL_RESULT_CHARS
    ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n… truncated`
    : text;
}

/** Enough to see what a tool did, short of storing whatever file it read. */
const MAX_TOOL_RESULT_CHARS = 4_000;

/**
 * The tool a completion belongs to, as best the SDK reports it.
 *
 * `ToolExecutionCompleteEvent` has no `toolName` of its own — the name, when it
 * is there at all, hangs off `toolDescription`. Returns "" rather than a
 * placeholder, because the fold treats an empty name as "no name given" and
 * falls back to arrival order; a made-up name would match the wrong call.
 */
function readToolName(event: SdkSessionEvent): string {
  const direct = readString(event, "toolName");
  if (direct) return direct;

  const description = eventData(event)["toolDescription"];
  if (description && typeof description === "object") {
    const named = (description as Record<string, unknown>)["toolName"];
    if (typeof named === "string" && named.length > 0) return named;
    const name = (description as Record<string, unknown>)["name"];
    if (typeof name === "string" && name.length > 0) return name;
  }
  return "";
}
