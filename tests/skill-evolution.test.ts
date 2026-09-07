import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuditLog,
  DEFAULT_TENANT_POLICY,
  SkillEvolution,
  SkillStore,
  createLogger,
  ensureAppPaths,
  resolveAppPaths,
  type AppPaths,
} from "@iq/core";
import type { SkillEvolutionRun } from "@iq/shared";

/**
 * Skill evolution is the third producer of skill proposals, and the only one
 * that rewrites a skill that already exists. These tests pin the promises that
 * makes: it ends at a proposal and never at an installed skill, a rewrite that
 * fails a gate is not proposed at all, a rewrite that is not actually better is
 * not proposed either, and every precondition is answerable before the button
 * is pressed.
 *
 * The sidecar is faked. Driving the real optimizer would be minutes of real
 * model calls to prove a line parser, which is the mistake the research sidecar
 * tests were rewritten to remove.
 */

let root: string;
let paths: AppPaths;

/** Frames the fake sidecar will emit, in order. */
let script: string[] = [];
/** Exit code for the run child. */
let runExit = 0;

function fakeChild(frames: string[], exit: number): EventEmitter & Record<string, unknown> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child["stdout"] = stdout;
  child["stderr"] = stderr;
  child["stdin"] = new PassThrough();
  child["kill"] = () => {
    child.emit("close", 0);
    return true;
  };
  setImmediate(() => {
    for (const frame of frames) stdout.write(`${frame}\n`);
    stdout.end();
    stderr.end();
    child.emit("close", exit);
  });
  return child;
}

/**
 * Separate children for the `status()` probe and the run.
 *
 * Sharing one replays the probe's version line into the run's line reader,
 * which the research sidecar tests learned the hard way.
 */
function spawnImpl(): typeof import("node:child_process").spawn {
  return ((_command: string, args: readonly string[]) => {
    if (args.includes("--version")) {
      return fakeChild(["iq-evolve 0.1.0"], 0) as never;
    }
    return fakeChild(script, runExit) as never;
  }) as never;
}

function installSkill(name: string, body: string): void {
  const dir = join(paths.skills, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: A test skill\n---\n\n${body}`,
    "utf8",
  );
}

function evolution(over: { model?: unknown } = {}): SkillEvolution {
  const audit = new AuditLog(paths);
  const skills = new SkillStore(paths, audit, DEFAULT_TENANT_POLICY, createLogger("error"), join(paths.skills, ".bundled"));
  return new SkillEvolution({
    paths,
    skills,
    audit,
    logger: createLogger("error"),
    correlationId: () => "corr-1",
    model: async () =>
      (over.model === undefined
        ? {
            id: "copilot:claude-sonnet-4.5",
            ref: "claude-sonnet-4.5",
          }
        : over.model) as never,
    spawnImpl: spawnImpl(),
  });
}

const frame = (value: unknown): string => JSON.stringify(value);

const GOOD_SCORE = {
  correctness: 0.9,
  procedureFollowing: 0.9,
  conciseness: 0.9,
  lengthPenalty: 0,
  composite: 0.9,
};
const WEAK_SCORE = { ...GOOD_SCORE, composite: 0.4 };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "iq-evolve-"));
  paths = resolveAppPaths(root);
  await ensureAppPaths(paths);
  // A venv the probe will find. Its contents do not matter — spawn is faked.
  const bin = process.platform === "win32" ? join(paths.tools, "evolve-py", "Scripts") : join(paths.tools, "evolve-py", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, process.platform === "win32" ? "python.exe" : "python"), "", "utf8");
  installSkill("report-writing", "## Steps\n\n1. Read the source.\n2. Write the report.");
  script = [];
  runExit = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("SkillEvolution.status", () => {
  it("refuses when the environment is not prepared", async () => {
    rmSync(join(paths.tools, "evolve-py"), { recursive: true, force: true });

    const status = await evolution().status();

    expect(status.ready).toBe(false);
    expect(status.message).toMatch(/pnpm prepare:evolve/);
  });

  /**
   * The optimizer runs on GitHub Copilot through the Copilot CLI, which is the
   * credential the app already holds. A Foundry deployment name means nothing
   * to that CLI, so it is reported as a precondition rather than discovered
   * mid-run.
   */
  it("refuses when no Copilot model is available", async () => {
    const status = await evolution({ model: null }).status();

    expect(status.ready).toBe(false);
    expect(status.message).toMatch(/Copilot/i);
  });

  it("is ready with a venv and a Copilot model", async () => {
    const status = await evolution().status();

    expect(status.ready).toBe(true);
    expect(status.version).toBe("0.1.0");
  });
});

describe("SkillEvolution — what the sidecar is given", () => {
  /**
   * The point of running on Copilot rather than an endpoint: there is no key.
   * The CLI holds the credential against the binary, so the app passes a path
   * and nothing else — and a token that did leak into the child's environment
   * would take priority over the stored one and fail as "No model available",
   * naming nothing.
   */
  it("passes the Copilot binary and no credential at all", async () => {
    const environments: NodeJS.ProcessEnv[] = [];
    const service = new SkillEvolution({
      paths,
      skills: new SkillStore(paths, new AuditLog(paths), DEFAULT_TENANT_POLICY, createLogger("error"), join(paths.skills, ".bundled")),
      audit: new AuditLog(paths),
      logger: createLogger("error"),
      correlationId: () => "corr-1",
      model: async () => ({ id: "copilot:claude-sonnet-4.5", ref: "claude-sonnet-4.5" }),
      spawnImpl: ((_command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        if (args.includes("--version")) return fakeChild(["iq-evolve 0.1.0"], 0) as never;
        environments.push(options.env ?? {});
        return fakeChild(
          [frame({ type: "error", problem: "stopped for the test" })],
          0,
        ) as never;
      }) as never,
    });

    await service.evolve({ name: "report-writing", budget: 40 }, "corr-1");

    const env = environments[0] ?? {};
    expect(env["IQ_EVOLVE_MODEL"]).toBe("claude-sonnet-4.5");
    expect(env["IQ_EVOLVE_COPILOT_CLI"] ?? "").toMatch(/copilot/i);
    // No endpoint, no key: there is nothing of the sort to pass.
    expect(env["IQ_EVOLVE_API_KEY"]).toBeUndefined();
    expect(env["IQ_EVOLVE_BASE_URL"]).toBeUndefined();
    // And the stale-token strip the research sidecar needs applies here too.
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
    expect(env["GH_TOKEN"]).toBeUndefined();
  });
});

describe("SkillEvolution.evolve", () => {
  it("writes a proposal, and does not touch the installed skill", async () => {
    script = [
      frame({ type: "status", status: "baseline", detail: "" }),
      frame({ type: "candidate", iteration: 1, score: WEAK_SCORE, feedback: "step 2 is vague" }),
      frame({ type: "status", status: "evolving", detail: "" }),
      frame({ type: "candidate", iteration: 2, score: GOOD_SCORE, feedback: "better" }),
      frame({ type: "constraint", name: "size", passed: true, message: "900 of 15000 bytes" }),
      frame({
        type: "done",
        body: "---\nname: report-writing\n---\n\n## Steps\n\n1. Read every source.\n2. Write the report.",
        best: GOOD_SCORE,
        baseline: WEAK_SCORE,
      }),
    ];

    const service = evolution();
    const run = await service.evolve({ name: "report-writing", budget: 40 }, "corr-1");

    expect(run.status).toBe("succeeded");
    expect(run.proposal).toBe("report-writing");

    // The proposal is in the staging area; the installed skill is untouched.
    const audit = new AuditLog(paths);
    const store = new SkillStore(paths, audit, DEFAULT_TENANT_POLICY, createLogger("error"), join(paths.skills, ".bundled"));
    const proposals = await store.listProposals();
    expect(proposals.map((entry) => entry.name)).toContain("report-writing");
    expect(proposals[0]?.body).toContain("Read every source");

    const installed = await store.list();
    const record = installed.find((entry) => entry.name === "report-writing");
    expect(record?.review).toBe("pending_review");
  });

  it("keeps the baseline and the best score apart", async () => {
    script = [
      frame({ type: "candidate", iteration: 1, score: WEAK_SCORE, feedback: "" }),
      frame({ type: "candidate", iteration: 2, score: GOOD_SCORE, feedback: "" }),
      frame({ type: "done", body: "---\nname: report-writing\n---\n\nBetter", best: GOOD_SCORE, baseline: WEAK_SCORE }),
    ];

    const run = await evolution().evolve({ name: "report-writing", budget: 40 }, "corr-1");

    expect(run.baseline?.composite).toBeCloseTo(0.4);
    expect(run.best?.composite).toBeCloseTo(0.9);
  });

  /**
   * The gates are the whole reason scores are not the only thing measured: an
   * optimizer's failure mode is winning the metric by breaking something the
   * metric does not look at.
   */
  it("proposes nothing when the sidecar reports a failure", async () => {
    script = [
      frame({ type: "constraint", name: "purpose preserved", passed: false, message: "dropped the review step" }),
      frame({ type: "error", problem: "The rewrite scored well but did not pass its gates: purpose preserved" }),
    ];

    const service = evolution();
    const run = await service.evolve({ name: "report-writing", budget: 40 }, "corr-1");

    expect(run.status).toBe("failed");
    expect(run.problem).toMatch(/gates/i);
    expect(run.constraints.find((gate) => gate.name === "purpose preserved")?.passed).toBe(false);

    const store = new SkillStore(paths, new AuditLog(paths), DEFAULT_TENANT_POLICY, createLogger("error"), join(paths.skills, ".bundled"));
    expect(await store.listProposals()).toEqual([]);
  });

  it("reports progress as it arrives", async () => {
    script = [
      frame({ type: "status", status: "evolving", detail: "" }),
      frame({ type: "candidate", iteration: 1, score: GOOD_SCORE, feedback: "good" }),
      frame({ type: "done", body: "---\nname: report-writing\n---\n\nBetter", best: GOOD_SCORE, baseline: WEAK_SCORE }),
    ];

    const seen: SkillEvolutionRun[] = [];
    const service = evolution();
    service.onChanged((run) => seen.push(run));
    await service.evolve({ name: "report-writing", budget: 40 }, "corr-1");

    expect(seen.map((run) => run.status)).toContain("evolving");
    expect(seen.at(-1)?.status).toBe("succeeded");
  });

  it("refuses a skill that is not installed", async () => {
    await expect(evolution().evolve({ name: "no-such-skill", budget: 40 }, "corr-1")).rejects.toThrow(
      /no skill named/i,
    );
  });

  /**
   * A frame split across a chunk boundary is the normal case on a busy pipe.
   * Reassembly is pinned because dropping one leaves a run stuck mid-status.
   */
  it("survives a frame arriving in pieces", async () => {
    const body = frame({
      type: "done",
      body: "---\nname: report-writing\n---\n\nBetter",
      best: GOOD_SCORE,
      baseline: WEAK_SCORE,
    });
    script = [body.slice(0, 20), ""];
    // Rebuild the halves as one stream with the split mid-frame.
    const halves = [body.slice(0, 20), body.slice(20)];
    const service = new SkillEvolution({
      paths,
      skills: new SkillStore(paths, new AuditLog(paths), DEFAULT_TENANT_POLICY, createLogger("error"), join(paths.skills, ".bundled")),
      audit: new AuditLog(paths),
      logger: createLogger("error"),
      correlationId: () => "corr-1",
      model: async () => ({
        id: "copilot:claude-sonnet-4.5",
        ref: "claude-sonnet-4.5",
      }),
      spawnImpl: ((_command: string, args: readonly string[]) => {
        if (args.includes("--version")) return fakeChild(["iq-evolve 0.1.0"], 0) as never;
        const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
        const stdout = new PassThrough();
        child["stdout"] = stdout;
        child["stderr"] = new PassThrough();
        child["stdin"] = new PassThrough();
        child["kill"] = () => true;
        setImmediate(() => {
          stdout.write(halves[0] as string);
          setImmediate(() => {
            stdout.write(`${halves[1] as string}\n`);
            stdout.end();
            child.emit("close", 0);
          });
        });
        return child as never;
      }) as never,
    });

    const run = await service.evolve({ name: "report-writing", budget: 40 }, "corr-1");

    expect(run.status).toBe("succeeded");
  });
});
