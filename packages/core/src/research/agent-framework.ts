import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ResearchGraph, parseModelId, type ResearchNode } from "@iq/shared";
import type { AppPaths } from "../config/paths.js";
import type { Logger } from "../util/logger.js";
import { STALE_GITHUB_ENV, copilotExecutable } from "../runtime/copilot/copilot-runtime.js";

/**
 * The Microsoft Agent Framework research workflow, as a governed sidecar.
 *
 * Agent Framework is Python; this app is TypeScript. Rather than reimplement
 * its orchestration in the renderer's language — which is how the pipeline came
 * to be a hand-rolled fan-out in the first place — the workflow runs where the
 * framework lives, in `native/iq-research`, and talks to us the way `iq-audio`
 * does: a process we resolve at run time and drive over stdio.
 *
 * The properties that follow from that choice, and why each is deliberate:
 *
 *  - **The framework owns the orchestration and reports on it.** The planner,
 *    the parallel researchers, the manager's round cycle and the writer are a
 *    `WorkflowBuilder` graph the framework validates before it runs — it
 *    refused an untyped back-edge during development, which is exactly the
 *    class of mistake a hand-rolled loop makes silently. What we receive is its
 *    event stream, so the picture the user sees is the framework's account of
 *    the run rather than our guess at it.
 *  - **Absence is a downgrade, not a failure.** No Python, or no prepared
 *    environment, means the in-process pipeline runs instead and every surface
 *    says so. Nothing about research depends on this being installed.
 *  - **The model is passed in per run, never configured here.** The app already
 *    knows which deployment the user chose for the research role; a second
 *    place to configure a model is a second place for it to be wrong. The key
 *    travels in the child's environment and is never written to disk or logged.
 */

/** The sidecar's own venv. Deliberately not the MarkItDown one under `tools/py`:
 *  a different owner, a different lifecycle, and a much heavier dependency set —
 *  sharing them would mean a Fabric extraction and a research run could break
 *  each other on an upgrade. */
const VENV_DIR = "research-py";

/**
 * A run that has produced *nothing* for this long is not running.
 *
 * Idle, not total: one gathering turn legitimately takes minutes now that the
 * researcher fetches pages, so a hard cap would kill healthy work. The timer is
 * restarted by every event, which is exactly what "still producing" means.
 */
const IDLE_TIMEOUT_MS = 10 * 60_000;

export interface ResearchSidecarStatus {
  ready: boolean;
  /** The interpreter that would run it, or "" when none was found. */
  python: string;
  version: string;
  /** Why it is not ready, with the remedy. Empty when it is. */
  message: string;
}

export interface ResearchSidecarRequest {
  topic: string;
  questions?: readonly string[];
  maxRounds?: number;
  maxParallel?: number;
  /**
   * Model the Copilot CLI should use, e.g. `claude-sonnet-4`.
   *
   * This is the **bare ref**, not a catalogue id: `parseModelId("copilot:gpt-5")
   * .ref`. Use {@link researchModelFor} rather than passing a literal.
   *
   * Optional on purpose, and with no default anywhere in this app: a model name
   * baked into code is a name that will be deprecated on someone else's
   * schedule. Left empty, the CLI picks its own current default, which is the
   * only choice that stays correct without maintenance.
   */
  model?: string;
  /**
   * An explicit `copilot` executable. Defaults to the one the app itself runs,
   * which is what makes the sidecar share the app's sign-in.
   */
  copilotCli?: string;
}

/**
 * The model a research run should ask for, from the app's own catalogue.
 *
 * There is no separate setting for this and there must not be: the model is
 * already chosen in Control Center → Connections, as the default for the
 * `research` role, and a second place to configure it is a second place for it
 * to be wrong — which is the whole argument for using Copilot here at all.
 *
 * Returns "" when the role resolves to something that is not a Copilot model.
 * That is not a failure: the sidecar then lets the CLI pick, and the run still
 * happens. Passing a Foundry deployment name to the Copilot CLI would not.
 */
export function researchModelFor(modelId: string | null): string {
  if (!modelId) return "";
  const parsed = parseModelId(modelId);
  return parsed?.provider === "copilot" ? parsed.ref : "";
}

/** Everything the sidecar can say. A line we cannot parse is dropped, not fatal. */
export type SidecarEvent =
  | { type: "started"; version: string; topic: string }
  | { type: "node"; id: string; kind: ResearchNode["kind"]; label: string; status: ResearchNode["status"]; detail: string; round: number }
  | { type: "edge"; from: string; to: string }
  | { type: "node_status"; id: string; status: ResearchNode["status"]; detail: string }
  | { type: "trace"; executor: string; status: string }
  | { type: "done"; graph: unknown; result: unknown }
  | { type: "error"; message: string; graph?: unknown };

export interface ResearchSidecarDeps {
  paths: AppPaths;
  logger: Logger;
  /** Injectable so tests never spawn Python. */
  spawnImpl?: typeof spawn;
}

export class ResearchSidecar {
  constructor(private readonly deps: ResearchSidecarDeps) {}

  private get venvDir(): string {
    return join(this.deps.paths.tools, VENV_DIR);
  }

  /** The venv's interpreter, wherever this platform puts it. */
  get python(): string {
    return process.platform === "win32"
      ? join(this.venvDir, "Scripts", "python.exe")
      : join(this.venvDir, "bin", "python");
  }

  /**
   * Whether the workflow can run, and what to do about it if not.
   *
   * Probed by actually running `--version`, not by looking for a file: a venv
   * left half-created by an interrupted install has an interpreter that does
   * not import, and reporting that as ready would move the failure to the
   * middle of a research run.
   */
  async status(): Promise<ResearchSidecarStatus> {
    if (!existsSync(this.python)) {
      return {
        ready: false,
        python: "",
        version: "",
        message:
          "The Agent Framework research workflow is not prepared. Run `pnpm prepare:research` to create its Python 3.13 environment — nothing is installed system-wide.",
      };
    }
    const probe = await this.capture([this.python, "-m", "iq_research", "--version"], 60_000, {});
    const version = /iq-research\s+([\d.]+)/.exec(probe.stdout)?.[1] ?? "";
    if (probe.code !== 0 || version === "") {
      return {
        ready: false,
        python: this.python,
        version: "",
        message:
          "The research environment exists but does not run. Delete it and run `pnpm prepare:research` again.",
      };
    }
    return { ready: true, python: this.python, version, message: "" };
  }

  /**
   * Run one research workflow, streaming its graph as it is built.
   *
   * The events arrive as JSON lines; a partial line is held until its newline
   * arrives, because a graph frame split across two chunk boundaries is the
   * normal case on a busy pipe and dropping it would leave a node stuck
   * "running" forever.
   */
  async run(
    request: ResearchSidecarRequest,
    onEvent: (event: SidecarEvent) => void,
    signal?: AbortSignal,
  ): Promise<{ graph: ResearchGraph; result: unknown; problem: string }> {
    const ready = await this.status();
    if (!ready.ready) return { graph: ResearchGraph.parse({}), result: null, problem: ready.message };

    await mkdir(this.deps.paths.tools, { recursive: true });
    const spawnImpl = this.deps.spawnImpl ?? spawn;
    // The same `copilot` binary the app drives from TypeScript. The CLI's
    // credential store belongs to the binary, so pointing the sidecar at a
    // different one — or leaving it to find something on PATH — is what makes a
    // signed-in machine ask the sidecar to sign in again.
    const cli = request.copilotCli ?? copilotExecutable() ?? "";
    const child = spawnImpl(this.python, ["-m", "iq_research"], {
      // The workflow's model is GitHub Copilot, driven through that CLI, so
      // there is no key to pass: it authenticates with the credential this app
      // already holds. That is the whole reason it was chosen over an
      // OpenAI-style client — one credential, one place it can expire.
      env: {
        ...allowListedEnv(),
        ...(request.model ? { IQ_RESEARCH_MODEL: request.model } : {}),
        ...(cli ? { IQ_RESEARCH_COPILOT_CLI: cli } : {}),
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let graph = ResearchGraph.parse({});
    let result: unknown = null;
    let problem = "";
    let buffer = "";
    /** Set once the idle timer exists; every event pushes it back. */
    let resetIdle: () => void = () => undefined;

    const apply = (event: SidecarEvent): void => {
      switch (event.type) {
        case "node":
          graph = ResearchGraph.parse({
            nodes: [
              ...graph.nodes.filter((node) => node.id !== event.id),
              {
                id: event.id,
                kind: event.kind,
                label: event.label,
                status: event.status,
                detail: event.detail,
                round: event.round,
              },
            ],
            edges: graph.edges,
          });
          break;
        case "edge":
          graph = ResearchGraph.parse({
            nodes: graph.nodes,
            edges: [...graph.edges, { from: event.from, to: event.to }],
          });
          break;
        case "node_status":
          graph = ResearchGraph.parse({
            nodes: graph.nodes.map((node) =>
              node.id === event.id
                ? { ...node, status: event.status, detail: event.detail || node.detail }
                : node,
            ),
            edges: graph.edges,
          });
          break;
        case "done": {
          const parsed = ResearchGraph.safeParse(event.graph);
          if (parsed.success) graph = parsed.data;
          result = event.result;
          break;
        }
        case "error":
          problem = event.message;
          break;
        default:
          break;
      }
      onEvent(event);
      resetIdle();
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line === "") continue;
        try {
          apply(JSON.parse(line) as SidecarEvent);
        } catch {
          // A line we cannot parse is a defect in the sidecar, not a reason to
          // abandon a run that is otherwise producing a graph.
          this.deps.logger.warn("research sidecar emitted an unparsable line", {
            line: line.slice(0, 200),
          });
        }
      }
    });

    // stderr is the sidecar's diagnostics channel by design, so it is logged
    // rather than treated as failure — a Python warning is not a failed run.
    child.stderr?.on("data", (chunk: Buffer) => {
      this.deps.logger.debug("research sidecar", { detail: chunk.toString("utf8").trim().slice(0, 500) });
    });

    child.stdin?.end(
      JSON.stringify({
        topic: request.topic,
        questions: request.questions ?? [],
        maxRounds: request.maxRounds ?? 2,
        maxParallel: request.maxParallel ?? 3,
      }),
    );

    const exit = await new Promise<number | null>((resolveExit) => {
      let timer: NodeJS.Timeout;
      const idle = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          child.kill();
          problem = problem || "the research workflow produced nothing for ten minutes";
        }, IDLE_TIMEOUT_MS);
      };
      idle();
      // Every frame is evidence of life, so every frame buys another window.
      resetIdle = idle;

      const abort = (): void => {
        child.kill();
        problem = problem || "the research workflow was cancelled";
      };
      signal?.addEventListener("abort", abort, { once: true });
      child.on("error", (error: Error) => {
        problem = problem || error.message;
        clearTimeout(timer);
        resolveExit(null);
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolveExit(code);
      });
    });

    if (exit !== 0 && problem === "") {
      problem = `the research workflow exited with code ${exit}`;
    }
    return { graph, result, problem };
  }

  private capture(
    argv: readonly string[],
    timeoutMs: number,
    env: NodeJS.ProcessEnv,
  ): Promise<{ code: number | null; stdout: string }> {
    const [command, ...args] = argv;
    return new Promise((resolveCapture) => {
      const spawnImpl = this.deps.spawnImpl ?? spawn;
      const child = spawnImpl(command!, args, {
        env: { ...allowListedEnv(), ...env },
        windowsHide: true,
      });
      let stdout = "";
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolveCapture({ code: null, stdout });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolveCapture({ code, stdout });
      });
    });
  }
}

/**
 * The environment a child needs and nothing else — the same allow-list
 * OfficeCLI gets. Nothing outside this list reaches the sidecar.
 */
function allowListedEnv(): NodeJS.ProcessEnv {
  const allow = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "windir",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "LANG",
    "LC_ALL",
    // Where the Copilot CLI keeps its credential and session state. Forwarding
    // these is how the sidecar inherits the sign-in the app already did — it
    // reads the same store, it does not get a token handed to it.
    "COPILOT_HOME",
    "GITHUB_COPILOT_BASE_DIRECTORY",
    "APPDATA",
    "LOCALAPPDATA",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // The same strip `runtimeEnv()` does for the app's own runtime, and for the
  // same reason: an inherited GitHub token takes priority over the CLI's stored
  // device-flow credential and then fails as "No model available", which gives
  // no hint that authentication is the cause. Allow-listing them here — which
  // this file originally did — would reintroduce exactly that bug in a second
  // process.
  for (const key of STALE_GITHUB_ENV) delete env[key];
  // Unbuffered, so a graph frame reaches the app when it is emitted rather than
  // when Python's block buffer happens to fill.
  env["PYTHONUNBUFFERED"] = "1";
  env["PYTHONIOENCODING"] = "utf-8";
  return env;
}
