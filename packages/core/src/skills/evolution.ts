import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EvolutionScore,
  MAX_SKILL_BODY_BYTES,
  SkillEvolutionRun,
  type EvolutionConstraint,
  type SkillEvolutionInput,
  type SkillEvolutionStatus,
  type SkillRecord,
} from "@iq/shared";
import type { AppPaths } from "../config/paths.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { Logger } from "../util/logger.js";
import type { SkillStore } from "./store.js";
import { STALE_GITHUB_ENV, copilotExecutable } from "../runtime/copilot/copilot-runtime.js";
import { blockedPackageHost } from "../mcp/probe.js";

/**
 * Skill evolution, driven by the GEPA sidecar.
 *
 * The third producer of skill proposals, alongside `propose_skill` and the
 * memory curator — and the only one that improves a skill that already exists.
 * Like both of the others it ends at a *proposal*: the human approval step is
 * untouched, because a skill is prompt surface and an optimizer that could
 * install one would be an optimizer that edits its own instructions.
 *
 * The sidecar is its own venv at `<IQ_HOME>/tools/evolve-py`, deliberately not
 * the research one at `tools/research-py` or the MarkItDown one at `tools/py`:
 * different owner, different lifecycle, and DSPy is a heavy dependency set that
 * has no business being able to break a Fabric extraction on an upgrade.
 */

const VENV_DIR = "evolve-py";

/** A run is a series of model calls with nobody watching each one. */
/**
 * How long a run may take before it is abandoned.
 *
 * **MEASURED, and the first value was wrong.** A rollout against Copilot costs
 * ~43 seconds (39 rollouts in 27m48s, bug-triage over a 12-example set), so the
 * default budget of 40 spends ~28 minutes in GEPA alone — before generating the
 * evaluation set, scoring the baseline, measuring the winner and running the
 * semantic gate, which together add another ~7. At the original 30 minutes
 * *every run at the default budget* would have been killed just before it
 * proposed anything, and reported as "exceeded its time budget" — which reads
 * as the run being pathological rather than the clock being wrong.
 *
 * The budget, not the clock, is the cost control: it is the number the user
 * sets, it is what bounds the model calls, and the run is cancellable at any
 * point. This is only a backstop against a wedged child.
 */
const RUN_TIMEOUT_MS = 90 * 60_000;

export interface SkillEvolutionDeps {
  paths: AppPaths;
  skills: SkillStore;
  audit: AuditLog;
  logger: Logger;
  /**
   * The model for the role, as `{provider}:{ref}`.
   *
   * Resolved by the caller rather than read here, so evolution has no model
   * setting of its own — it uses the app's registered default, which is the
   * only place a model is configured.
   */
  model: () => Promise<{ id: string; ref: string } | null>;
  correlationId: () => string;
  /** Injected by tests. */
  spawnImpl?: typeof spawn;
}

/** One frame from the sidecar. */
type Frame =
  | { type: "status"; status: string; detail: string }
  | { type: "candidate"; iteration: number; score: Record<string, number>; feedback: string }
  | { type: "constraint"; name: string; passed: boolean; message: string }
  | { type: "done"; body: string; best: Record<string, number>; baseline: Record<string, number> }
  | { type: "error"; problem: string };

export class SkillEvolution {
  private run: SkillEvolutionRun | null = null;
  private child: ChildProcess | null = null;
  private listeners = new Set<(run: SkillEvolutionRun) => void>();

  constructor(private readonly deps: SkillEvolutionDeps) {}

  onChanged(listener: (run: SkillEvolutionRun) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private get venvDir(): string {
    return join(this.deps.paths.tools, VENV_DIR);
  }

  get python(): string {
    return process.platform === "win32"
      ? join(this.venvDir, "Scripts", "python.exe")
      : join(this.venvDir, "bin", "python");
  }

  /**
   * Whether a run could start, and what to do about it if not.
   *
   * Every precondition the privileged side would refuse on is answered here, so
   * the surface can disable the control *with the reason* instead of offering
   * it and reporting a failure afterwards.
   */
  async status(): Promise<SkillEvolutionStatus> {
    if (!existsSync(this.python)) {
      return {
        ready: false,
        version: "",
        message:
          "Skill evolution is not prepared. Run `pnpm prepare:evolve` to create its Python 3.13 environment — nothing is installed system-wide.",
        run: this.run,
      };
    }

    const probe = await this.capture([this.python, "-m", "iq_evolve", "--version"], 60_000);
    const version = /iq-evolve\s+([\d.]+)/.exec(probe.stdout)?.[1] ?? "";
    if (probe.code !== 0 || version === "") {
      const blocked = blockedPackageHost(probe.stderr);
      return {
        ready: false,
        version: "",
        message:
          blocked !== ""
            ? blocked
            : "The evolution environment exists but does not run. Delete it and run `pnpm prepare:evolve` again.",
        run: this.run,
      };
    }

    const model = await this.deps.model();
    if (model === null) {
      return {
        ready: false,
        version,
        message:
          "Skill evolution needs a GitHub Copilot model. Set one as the Reasoning default in Control Center \u2192 Connections \u2014 the optimizer runs through the Copilot CLI, which holds your existing sign-in.",
        run: this.run,
      };
    }

    return { ready: true, version, message: "", run: this.run };
  }

  /** Stop the run in flight. The proposal is only ever written on a clean finish. */
  cancel(): void {
    if (this.child === null) return;
    this.child.kill();
    this.child = null;
    if (this.run !== null) {
      this.publish({ ...this.run, status: "cancelled", finishedAt: new Date().toISOString() });
    }
  }

  /**
   * Evolve one skill.
   *
   * Resolves when the run finishes. Progress is published as it arrives, so a
   * caller that only wants to watch can subscribe and ignore the promise.
   */
  async evolve(input: SkillEvolutionInput, correlationId: string): Promise<SkillEvolutionRun> {
    const ready = await this.status();
    if (!ready.ready) throw new Error(ready.message);
    if (this.child !== null) throw new Error("an evolution run is already in flight");

    const skills = await this.deps.skills.list();
    const skill = skills.find((entry) => entry.name === input.name);
    if (!skill) throw new Error(`no skill named "${input.name}"`);

    const markdown = await readFile(join(skill.path, "SKILL.md"), "utf8");
    const model = await this.deps.model();
    if (model === null) throw new Error("no model is available for skill evolution");

    const started: SkillEvolutionRun = SkillEvolutionRun.parse({
      id: correlationId,
      skillName: skill.name,
      status: "preparing",
      modelId: model.id,
      startedAt: new Date().toISOString(),
      budget: input.budget,
    });
    this.publish(started);

    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "skill.evolve",
      family: "skills",
      outcome: "succeeded",
      correlationId,
      resources: [skill.name],
      reason: `started with a budget of ${input.budget} evaluations on ${model.id}`,
    });

    const finished = await this.drive(skill, markdown, input.budget, model);
    this.child = null;

    if (finished.status === "succeeded") {
      await this.deps.audit.record({
        actor: { kind: "system" },
        action: "skill.evolve",
        family: "skills",
        outcome: "succeeded",
        correlationId,
        resources: [skill.name, finished.proposal],
        reason: `proposed a rewrite scoring ${finished.best?.composite.toFixed(2) ?? "?"} against ${finished.baseline?.composite.toFixed(2) ?? "?"}`,
      });
    } else {
      await this.deps.audit.record({
        actor: { kind: "system" },
        action: "skill.evolve",
        family: "skills",
        outcome: "failed",
        correlationId,
        resources: [skill.name],
        reason: finished.problem,
      });
    }

    this.publish(finished);
    return finished;
  }

  /** Spawn the sidecar and fold its frames into the run. */
  private async drive(
    skill: SkillRecord,
    markdown: string,
    budget: number,
    model: { id: string; ref: string },
  ): Promise<SkillEvolutionRun> {
    await mkdir(this.deps.paths.tools, { recursive: true });
    const spawnImpl = this.deps.spawnImpl ?? spawn;

    // The same `copilot` binary the app drives from TypeScript. The CLI's
    // credential store belongs to the binary, so pointing the sidecar at a
    // different one — or leaving it to find something on PATH — is what makes a
    // signed-in machine ask the sidecar to sign in again. There is no key to
    // pass: that is the whole reason Copilot was chosen over an endpoint.
    const cli = copilotExecutable() ?? "";
    const child = spawnImpl(this.python, ["-m", "iq_evolve"], {
      env: {
        ...inheritedEnv(),
        ...(model.ref ? { IQ_EVOLVE_MODEL: model.ref } : {}),
        ...(cli ? { IQ_EVOLVE_COPILOT_CLI: cli } : {}),
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdin?.write(
      JSON.stringify({
        name: skill.name,
        markdown,
        budget,
        limit: MAX_SKILL_BODY_BYTES,
      }),
    );
    child.stdin?.end();

    let current = this.run ?? SkillEvolutionRun.parse({ id: "", skillName: skill.name, status: "preparing", startedAt: new Date().toISOString() });
    let evolved = "";
    let problem = "";
    let buffer = "";
    let stderr = "";

    const apply = (frame: Frame): void => {
      switch (frame.type) {
        case "status":
          current = { ...current, status: statusOf(frame.status, current.status) };
          break;
        case "candidate": {
          const score = EvolutionScore.parse(frame.score);
          const candidate = {
            iteration: frame.iteration,
            score,
            feedback: frame.feedback,
          };
          const best =
            current.best === null || score.composite > current.best.composite ? score : current.best;
          current = {
            ...current,
            // The baseline is the first thing scored, before any mutation.
            baseline: current.baseline ?? score,
            best,
            // Bounded: a long run judges hundreds of examples and the surface
            // shows the recent ones. The best score is carried separately, so
            // trimming the list never loses the result.
            candidates: [...current.candidates, candidate].slice(-40),
          };
          break;
        }
        case "constraint": {
          const constraint: EvolutionConstraint = {
            name: frame.name,
            passed: frame.passed,
            message: frame.message,
          };
          current = { ...current, constraints: [...current.constraints, constraint] };
          break;
        }
        case "done":
          evolved = frame.body;
          current = {
            ...current,
            best: EvolutionScore.parse(frame.best),
            baseline: EvolutionScore.parse(frame.baseline),
          };
          break;
        case "error":
          problem = frame.problem;
          break;
      }
      this.publish(current);
    };

    await new Promise<void>((settle) => {
      const timer = setTimeout(() => {
        problem = problem || "The evolution run exceeded its time budget.";
        child.kill();
      }, RUN_TIMEOUT_MS);

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        // A frame split across a chunk boundary is the normal case on a busy
        // pipe; the partial line is held until its newline arrives.
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim() === "") continue;
          try {
            apply(JSON.parse(line) as Frame);
          } catch {
            this.deps.logger.warn("unreadable frame from the evolution sidecar", { line });
          }
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-8_000);
      });
      child.on("error", (error) => {
        problem = problem || error.message;
        clearTimeout(timer);
        settle();
      });
      child.on("close", () => {
        clearTimeout(timer);
        settle();
      });
    });

    if (evolved !== "" && problem === "") {
      const name = skill.name;
      try {
        await this.deps.skills.propose(
          {
            name,
            description: skill.description,
            body: evolved,
            allowedTools: skill.allowedTools,
            // Not a session's work: it belongs to the run, and naming a session
            // that never existed would make the audit trail lie.
            sourceSessionId: "",
            sourceTurnId: current.id,
            rationale: `Evolved with GEPA over ${current.candidates.length} evaluations, scoring ${current.best?.composite.toFixed(2) ?? "?"} against the original's ${current.baseline?.composite.toFixed(2) ?? "?"}.`,
          },
          current.id,
        );
        return {
          ...current,
          status: "succeeded",
          proposal: name,
          finishedAt: new Date().toISOString(),
        };
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
    }

    if (problem === "") {
      const blocked = blockedPackageHost(stderr);
      problem =
        blocked !== "" ? blocked : "The evolution run ended without proposing anything.";
    }
    return { ...current, status: "failed", problem, finishedAt: new Date().toISOString() };
  }

  private publish(run: SkillEvolutionRun): void {
    this.run = run;
    for (const listener of this.listeners) listener(run);
  }

  private capture(
    argv: string[],
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const spawnImpl = this.deps.spawnImpl ?? spawn;
    return new Promise((settle) => {
      const [command, ...args] = argv as [string, ...string[]];
      const child = spawnImpl(command, args, {
        env: inheritedEnv(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => (stdout += chunk));
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => (stderr += chunk));
      child.on("error", () => {
        clearTimeout(timer);
        settle({ code: -1, stdout, stderr });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        settle({ code: code ?? -1, stdout, stderr });
      });
    });
  }
}

/** Map a sidecar status onto the run's, ignoring anything unrecognised. */
function statusOf(reported: string, current: SkillEvolutionRun["status"]): SkillEvolutionRun["status"] {
  switch (reported) {
    case "preparing":
    case "baseline":
    case "evolving":
    case "validating":
      return reported;
    default:
      return current;
  }
}

/**
 * The child inherits this process's whole environment, minus a few keys.
 *
 * That is the opposite of the research sidecar, which passes an allow-list.
 * The difference is deliberate: the evolution child shells out to build tools
 * that read settings nobody has enumerated, so naming what may pass would
 * break them one variable at a time.
 *
 * `STALE_GITHUB_ENV` is stripped for the same reason the research sidecar
 * strips it: an inherited token takes priority over the credential store and
 * then fails in a way that names nothing.
 */
function inheritedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of STALE_GITHUB_ENV) delete env[key];
  return env;
}
