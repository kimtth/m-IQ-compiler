import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertAcyclic } from "@iq/core";
import type { OrchestrationPlan, OrchestrationTask } from "@iq/shared";
import { Coordinator, PlanStore } from "../packages/core/src/orchestration/coordinator.js";
import { ensureAppPaths, resolveAppPaths } from "../packages/core/src/config/paths.js";

/**
 * A dependency cycle in a plan would leave every task in the cycle permanently
 * `blocked`: the coordinator only promotes a task once its dependencies have
 * succeeded, so nothing would ever dispatch and the plan would hang rather than
 * fail. Rejecting the cycle at creation time is what makes that impossible.
 */

const at = "2026-01-01T00:00:00.000Z";

const plan: OrchestrationPlan = {
  id: "pln_1",
  objective: "test",
  parentSessionId: "ses_1",
  parentTurnId: null,
  maxParallel: 4,
  status: "running",
  createdAt: at,
  updatedAt: at,
};

const task = (id: string, dependsOn: string[]): OrchestrationTask => ({
  id,
  planId: plan.id,
  title: id,
  instruction: `do ${id}`,
  status: "blocked",
  dependsOn,
  toolFamilies: [],
  skills: [],
  sessionId: null,
  attempt: 0,
  maxAttempts: 2,
  result: null,
  error: null,
  createdAt: at,
  updatedAt: at,
});

describe("assertAcyclic", () => {
  it("accepts a diamond, which is the normal parallel shape", () => {
    const doc = {
      plan,
      tasks: [task("a", []), task("b", ["a"]), task("c", ["a"]), task("d", ["b", "c"])],
      gates: [],
    };
    expect(() => assertAcyclic(doc)).not.toThrow();
  });

  it("rejects a direct cycle", () => {
    const doc = { plan, tasks: [task("a", ["b"]), task("b", ["a"])], gates: [] };
    expect(() => assertAcyclic(doc)).toThrow(/dependency cycle/);
  });

  it("rejects a longer cycle", () => {
    const doc = {
      plan,
      tasks: [task("a", ["c"]), task("b", ["a"]), task("c", ["b"])],
      gates: [],
    };
    expect(() => assertAcyclic(doc)).toThrow(/dependency cycle/);
  });

  it("rejects a dependency on a task that does not exist", () => {
    const doc = { plan, tasks: [task("a", ["ghost"])], gates: [] };
    expect(() => assertAcyclic(doc)).toThrow(/unknown task ghost/);
  });

  it("accepts a plan with no dependencies at all", () => {
    const doc = { plan, tasks: [task("a", []), task("b", [])], gates: [] };
    expect(() => assertAcyclic(doc)).not.toThrow();
  });
});

/**
 * What a restart does to the tasks the dead process was running.
 *
 * A task's `running` status is persisted; the thing actually running it is an
 * in-memory `AbortController`, which a restart discards. `passPlan` counts a
 * persisted `running` as occupying a parallel slot, so re-registering the plan
 * without reconciling brought back `maxParallel` phantom tasks that blocked
 * every `ready` task behind them and kept `settleIfDone` from ever settling.
 *
 * Measured on a real research run: 3 tasks stuck `running` at attempt 2 of 2,
 * 4 stuck `ready`, the plan `running`, and the research surface reporting
 * "7 of 7 still gathering" with nothing left that could move it.
 */
describe("Coordinator boot reconciliation", () => {
  let root: string;
  let store: PlanStore;
  let coordinator: Coordinator;

  const interrupted = (id: string, attempt: number): OrchestrationTask => ({
    ...task(id, []),
    status: "running",
    attempt,
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "iq-plans-"));
    const paths = resolveAppPaths(root);
    await ensureAppPaths(paths);
    store = new PlanStore(paths);
    coordinator = new Coordinator({
      store,
      // Never dispatched: the poll loop is not started, so this pins the state
      // reconciliation alone rather than what happens next.
      delegate: async () => ({ result: "", sessionId: "" }),
      audit: async () => undefined,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      publish: () => undefined,
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns an interrupted task to ready while it still has attempts", async () => {
    await store.write({
      plan,
      tasks: [interrupted("a", 1), { ...task("b", []), status: "ready" }],
      gates: [],
    });

    await coordinator.trackOpenPlans();

    const doc = await store.read(plan.id);
    expect(doc?.tasks.map((entry) => entry.status)).toEqual(["ready", "ready"]);
    expect(doc?.tasks[0]?.error).toContain("interrupted");
    // The attempt already spent is not given back.
    expect(doc?.tasks[0]?.attempt).toBe(1);
  });

  it("fails an interrupted task that has used its attempts, rather than retrying forever", async () => {
    await store.write({ plan, tasks: [interrupted("a", 2)], gates: [] });

    await coordinator.trackOpenPlans();

    const doc = await store.read(plan.id);
    expect(doc?.tasks[0]?.status).toBe("failed");
    // Nothing is left unsettled, so the plan settles instead of polling a
    // batch that will never report.
    expect(doc?.plan.status).toBe("failed");
  });

  it("leaves a plan with nothing in flight alone", async () => {
    const before = {
      plan,
      tasks: [{ ...task("a", []), status: "succeeded" as const }, { ...task("b", []), status: "ready" as const }],
      gates: [],
    };
    await store.write(before);

    await coordinator.trackOpenPlans();

    const doc = await store.read(plan.id);
    expect(doc?.tasks.map((entry) => entry.status)).toEqual(["succeeded", "ready"]);
    expect(doc?.tasks.every((entry) => entry.error === null)).toBe(true);
  });

  it("cancels only the plans launched by the stopped parent turn", async () => {
    const stoppedPlan = {
      ...plan,
      id: "pln_stopped",
      parentTurnId: "turn_stopped",
    };
    const laterPlan = {
      ...plan,
      id: "pln_later",
      parentTurnId: "turn_later",
    };
    const stoppedTask = { ...task("task_stopped", []), planId: stoppedPlan.id, status: "running" as const };
    const laterTask = { ...task("task_later", []), planId: laterPlan.id, status: "running" as const };

    await store.write({ plan: stoppedPlan, tasks: [stoppedTask], gates: [] });
    await store.write({ plan: laterPlan, tasks: [laterTask], gates: [] });

    const cancelled = await coordinator.cancelPlansForTurn("ses_1", "turn_stopped", "stopped by user");

    expect(cancelled.map((doc) => doc.plan.id)).toEqual(["pln_stopped"]);
    expect((await store.read(stoppedPlan.id))?.plan.status).toBe("cancelled");
    expect((await store.read(stoppedPlan.id))?.tasks[0]?.status).toBe("cancelled");
    expect((await store.read(laterPlan.id))?.plan.status).toBe("running");
    expect((await store.read(laterPlan.id))?.tasks[0]?.status).toBe("running");
  });
});
