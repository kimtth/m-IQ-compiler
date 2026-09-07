import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAppPaths, ensureAppPaths, type AppPaths } from "../packages/core/src/config/paths.js";
import { createLogger } from "../packages/core/src/util/logger.js";
import {
  ResearchSidecar,
  researchModelFor,
  type SidecarEvent,
} from "../packages/core/src/research/agent-framework.js";

/**
 * The Node side of the Agent Framework sidecar: the boundary, not the model.
 *
 * The workflow itself is Python and is covered by `native/iq-research/tests`,
 * which runs the real `WorkflowBuilder` graph against a scripted `ask`. What
 * belongs here is what this file is responsible for — reassembling a JSON-lines
 * stream into a graph, sharing the app's Copilot sign-in, and choosing a model
 * from the app's own catalogue.
 *
 * Driven with a fake spawn rather than the real sidecar **on purpose**. An
 * earlier version of this suite ran the actual workflow: once web permission
 * was granted and the turn budget raised, it spent three minutes of real
 * Copilot calls per run. A test that costs money and network to prove a string
 * parser is a test nobody keeps.
 */

interface Wire {
  spawn: unknown;
  emit: (line: string) => void;
  close: (code: number) => void;
  env: () => NodeJS.ProcessEnv;
  stdin: () => string;
}

/** One stand-in child process. */
function fakeChild(): EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  kill: () => void;
  written: () => string;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: Writable;
    kill: () => void;
    written: () => string;
  };
  child.stdout = new Readable({ read: () => undefined });
  child.stderr = new Readable({ read: () => undefined });
  let text = "";
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      text += String(chunk);
      done();
    },
  });
  child.kill = () => undefined;
  child.written = () => text;
  return child;
}

/**
 * A spawn that answers `status()`'s probe from one pipe and hands the run its
 * own. Separate children on purpose: sharing one would replay the probe's
 * version line into the run's line reader, which is a condition the real
 * sidecar never produces.
 */
function fakeSpawn(): Wire {
  const run = fakeChild();
  let seen: NodeJS.ProcessEnv = {};
  let probed = false;

  const spawn = (_command: string, _args: readonly string[], options: Record<string, unknown>) => {
    if (!probed) {
      probed = true;
      const probe = fakeChild();
      setImmediate(() => {
        probe.stdout.push("iq-research 9.9.9\n");
        probe.emit("close", 0);
      });
      return probe;
    }
    seen = (options["env"] as NodeJS.ProcessEnv) ?? {};
    return run;
  };

  return {
    spawn,
    emit: (line) => {
      run.stdout.push(`${line}\n`);
    },
    close: (code) => {
      run.emit("close", code);
    },
    env: () => seen,
    stdin: () => run.written(),
  };
}

const IQ_HOME = process.env["IQ_HOME"] ?? join(homedir(), ".iq-compiler");
const PREPARED = join(
  IQ_HOME,
  "tools",
  "research-py",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);

describe("ResearchSidecar", () => {
  let root: string;
  let paths: AppPaths;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "iq-research-"));
    paths = resolveAppPaths(root);
    ensureAppPaths(paths);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("says how to prepare it when the environment is absent", async () => {
    // Absence is a downgrade, not a failure: the message has to carry the fix.
    const status = await new ResearchSidecar({ paths, logger: createLogger("error") }).status();
    expect(status.ready).toBe(false);
    expect(status.message).toMatch(/prepare:research/);
  }, 60_000);

  it.skipIf(!existsSync(PREPARED))(
    "reports itself ready by running the workflow, not by finding a file",
    async () => {
      // A venv left half-created by an interrupted install has an interpreter
      // that does not import; reporting that as ready moves the failure into
      // the middle of a research run.
      const sidecar = new ResearchSidecar({
        paths: { ...paths, tools: join(IQ_HOME, "tools") },
        logger: createLogger("error"),
      });
      const status = await sidecar.status();
      expect(status.ready).toBe(true);
      expect(status.version).toMatch(/^\d+\.\d+\.\d+$/);
    },
    120_000,
  );

  describe("the event stream", () => {
    /** A sidecar whose probe passes and whose child the test drives. */
    const wired = (): Wire & { sidecar: ResearchSidecar } => {
      const wire = fakeSpawn();
      const sidecar = new ResearchSidecar({
        paths,
        logger: createLogger("error"),
        spawnImpl: wire.spawn as never,
      });
      // `status()` stats the interpreter before probing it, so give it one that
      // exists. Which binary is irrelevant — the spawn is fake.
      Object.defineProperty(sidecar, "python", { get: () => process.execPath });
      return Object.assign(wire, { sidecar });
    };

    /** Wait until `run` has got past its readiness probe and spawned the child. */
    const settle = async (wire: Wire): Promise<void> => {
      for (let tick = 0; tick < 200; tick += 1) {
        if (wire.stdin() !== "") return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("the sidecar never spawned its worker");
    };

    it("reassembles a graph from the line stream", async () => {
      const wire = wired();
      const events: SidecarEvent[] = [];
      const run = wire.sidecar.run({ topic: "T" }, (event) => events.push(event));
      await settle(wire);

      wire.emit(
        '{"type":"node","id":"plan","kind":"plan","label":"Plan","status":"pending","detail":"","round":1}',
      );
      wire.emit('{"type":"edge","from":"plan","to":"research"}');
      wire.emit('{"type":"node_status","id":"plan","status":"done","detail":"3 questions"}');
      wire.close(0);

      const outcome = await run;
      expect(outcome.problem).toBe("");
      expect(outcome.graph.nodes).toHaveLength(1);
      expect(outcome.graph.nodes[0]?.status).toBe("done");
      expect(outcome.graph.nodes[0]?.detail).toBe("3 questions");
      expect(outcome.graph.edges).toEqual([{ from: "plan", to: "research" }]);
      expect(events.map((event) => event.type)).toEqual(["node", "edge", "node_status"]);
    }, 30_000);

    it("keeps going when the sidecar emits a line it cannot parse", async () => {
      // A malformed line is a defect in the sidecar, not a reason to abandon a
      // run that is otherwise producing a graph.
      const wire = wired();
      const run = wire.sidecar.run({ topic: "T" }, () => undefined);
      await settle(wire);
      wire.emit("not json");
      wire.emit(
        '{"type":"node","id":"plan","kind":"plan","label":"Plan","status":"done","detail":"","round":1}',
      );
      wire.close(0);

      const outcome = await run;
      expect(outcome.graph.nodes).toHaveLength(1);
      expect(outcome.problem).toBe("");
    }, 30_000);

    it("hands the sidecar the app's own Copilot binary, never a bare name", async () => {
      // The CLI's credential store belongs to the binary. A sidecar that found
      // a different `copilot` on PATH would be asked to sign in on a machine
      // that already is.
      const wire = wired();
      const run = wire.sidecar.run({ topic: "T", copilotCli: "C:/app/copilot.exe" }, () => undefined);
      await settle(wire);
      wire.close(0);
      await run;

      expect(wire.env()["IQ_RESEARCH_COPILOT_CLI"]).toBe("C:/app/copilot.exe");
    }, 30_000);

    it("never passes a GitHub token, because one would shadow the sign-in", async () => {
      // The same strip the app's own runtime does: an inherited token takes
      // priority over the CLI's stored device-flow credential and then fails as
      // "No model available", with no hint that authentication is the cause.
      // This file originally allow-listed GH_TOKEN, which would have
      // reintroduced that bug in a second process.
      process.env["GH_TOKEN"] = "stale";
      process.env["GITHUB_TOKEN"] = "stale";
      try {
        const wire = wired();
        const run = wire.sidecar.run({ topic: "T" }, () => undefined);
        await settle(wire);
        wire.close(0);
        await run;

        expect(wire.env()["GH_TOKEN"]).toBeUndefined();
        expect(wire.env()["GITHUB_TOKEN"]).toBeUndefined();
      } finally {
        delete process.env["GH_TOKEN"];
        delete process.env["GITHUB_TOKEN"];
      }
    }, 30_000);

    it("sends the request on stdin, so a topic never lands in argv", async () => {
      const wire = wired();
      const run = wire.sidecar.run(
        { topic: "secret topic", maxRounds: 3, maxParallel: 2 },
        () => undefined,
      );
      await settle(wire);
      wire.close(0);
      await run;

      expect(JSON.parse(wire.stdin())).toEqual({
        topic: "secret topic",
        questions: [],
        maxRounds: 3,
        maxParallel: 2,
      });
    }, 30_000);
  });

  describe("researchModelFor", () => {
    it("passes a Copilot model through as its bare ref", () => {
      // The catalogue id is `copilot:<ref>`; the CLI wants the ref. There is no
      // separate research-model setting and there must not be — the model is
      // already chosen as the `research` role default in Connections.
      expect(researchModelFor("copilot:claude-sonnet-4")).toBe("claude-sonnet-4");
    });

    it("names nothing for a model the Copilot CLI could not use", () => {
      // A Foundry deployment name handed to the Copilot CLI is not a model, it
      // is a failure. Empty lets the CLI pick, and the run still happens.
      expect(researchModelFor("foundry:my-deployment")).toBe("");
      expect(researchModelFor(null)).toBe("");
    });

    it("has no default of its own, so nothing here can be deprecated", () => {
      // `gpt-4.1-mini` was hardcoded once and was deprecated out from under it.
      expect(researchModelFor("")).toBe("");
    });
  });
});
