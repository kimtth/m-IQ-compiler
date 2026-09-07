import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SAMPLE_JOBS,
  SAMPLE_PLANS,
  ScheduleStore,
  Scheduler,
  isSampleJob,
  isSamplePlan,
  resolveAppPaths,
} from "@iq/core";
import { createKnowledgeTools } from "../packages/core/src/knowledge/tools.js";
import { createWorkIqTools } from "../packages/core/src/workiq/workiq-tools.js";

/**
 * The two sample sets that could act on their own.
 *
 * Memories and knowledge notes are inert — the worst a bad sample does there is
 * mislead a reader. An automation and a plan are not: one is a schedule and the
 * other a fan-out of sub-agents, so a careless example would spend tokens and
 * touch a mailbox because somebody pressed "Load" to see what the surface looks
 * like. Everything below is that guarantee written down.
 */

/**
 * The tools a sample job's families actually resolve to.
 *
 * This list used to be a set of family names spelled `workiq.read`,
 * `m365.mail.read` and so on. Not one of them is a family the product
 * registers, so the test proved only that the samples matched the test's own
 * invented vocabulary — and a job naming an unregistered family gets zero
 * tools, silently. The guarantee is now read off the declarations: every tool
 * reachable from a sample job must be `risk: "read"`.
 */
const TOOLS_BY_FAMILY = new Map<string, { name: string; risk: string }[]>();
for (const tool of [
  ...createWorkIqTools({ client: {} as never, gate: {} as never, currentOid: () => null }),
  ...createKnowledgeTools({ knowledge: {} as never }),
]) {
  const bucket = TOOLS_BY_FAMILY.get(tool.family) ?? [];
  bucket.push({ name: tool.name, risk: tool.risk });
  TOOLS_BY_FAMILY.set(tool.family, bucket);
}

describe("sample automations", () => {
  it("are all disabled, so loading examples never starts work", () => {
    expect(SAMPLE_JOBS.length).toBeGreaterThan(0);
    for (const job of SAMPLE_JOBS) expect(job.enabled).toBe(false);
  });

  it("name families that exist, so a sample is never a job with no tools", () => {
    for (const job of SAMPLE_JOBS) {
      for (const family of job.toolFamilies) expect(TOOLS_BY_FAMILY.has(family)).toBe(true);
    }
  });

  it("hold only read-only tool families, so a mistaken enable cannot send", () => {
    for (const job of SAMPLE_JOBS) {
      for (const family of job.toolFamilies) {
        for (const tool of TOOLS_BY_FAMILY.get(family) ?? []) {
          expect(tool.risk, `${job.id} reaches ${tool.name}`).toBe("read");
        }
      }
    }
  });

  it("carry fixed ids, so seeding is idempotent and clearing cannot overreach", () => {
    const ids = SAMPLE_JOBS.map((job) => job.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(isSampleJob(id)).toBe(true);
    // A job the user wrote must never match.
    expect(isSampleJob("job_01HQ")).toBe(false);
  });

  it("show more than one trigger shape, which is what the surface teaches", () => {
    expect(new Set(SAMPLE_JOBS.map((job) => job.trigger.kind)).size).toBeGreaterThan(1);
  });

  it("are skipped by the scheduler while sample data is switched off", async () => {
    // The second lock. A sample is written disabled and re-disabled on every
    // load, so one only runs because somebody switched it on. This covers the
    // case that is not deliberate: samples turned off months later, an enabled
    // example forgotten in the list, and an unattended turn still firing every
    // Monday against a fixture nobody remembers agreeing to.
    const root = mkdtempSync(join(tmpdir(), "iq-samples-"));
    try {
      const paths = resolveAppPaths(root);
      const store = new ScheduleStore(paths);
      const executed: string[] = [];
      let showSamples = false;

      const scheduler = new Scheduler({
        store,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        publish: () => undefined,
        sampleDataEnabled: () => showSamples,
        audit: async () => undefined,
        execute: async (job) => {
          executed.push(job.id);
          return { sessionId: "ses", summary: "" };
        },
      });

      await scheduler.seedSamples();
      // Enabled by hand, which is the only way this state is ever reached.
      for (const job of SAMPLE_JOBS) await scheduler.setEnabled(job.id, true);

      await scheduler.start(3_600_000);
      scheduler.stop();
      expect(executed).toEqual([]);

      // And the converse: with samples on, the same enabled job is eligible.
      // Asserted as "not skipped for being a sample" rather than "ran", since
      // a cron job is only due when its schedule says so.
      showSamples = true;
      const eligible = (await scheduler.listJobs()).filter(
        (job) => isSampleJob(job.id) && job.enabled,
      );
      expect(eligible).toHaveLength(SAMPLE_JOBS.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("sample delegated plans", () => {
  it("are already finished, so the coordinator has nothing to dispatch", () => {
    expect(SAMPLE_PLANS.length).toBeGreaterThan(0);
    for (const doc of SAMPLE_PLANS) {
      expect(doc.plan.status).toBe("succeeded");
      for (const task of doc.tasks) expect(task.status).toBe("succeeded");
      // A pending gate would ask a question about work that never happened.
      for (const gate of doc.gates) expect(gate.resolution).not.toBe("pending");
    }
  });

  it("name no session, rather than pointing at ones that do not exist", () => {
    for (const doc of SAMPLE_PLANS) {
      for (const task of doc.tasks) expect(task.sessionId).toBeNull();
    }
  });

  it("show a real shape: a fan-out, and a task that waited on all of it", () => {
    const doc = SAMPLE_PLANS[0];
    expect(doc).toBeDefined();
    if (!doc) return;
    const independent = doc.tasks.filter((task) => task.dependsOn.length === 0);
    const joins = doc.tasks.filter((task) => task.dependsOn.length > 1);
    expect(independent.length).toBeGreaterThan(1);
    expect(joins.length).toBeGreaterThan(0);
    // Every dependency must name a task in the same plan, or the graph is a lie.
    const ids = new Set(doc.tasks.map((task) => task.id));
    for (const task of doc.tasks) {
      for (const dependency of task.dependsOn) expect(ids.has(dependency)).toBe(true);
    }
  });

  it("carry fixed ids that cannot match a plan the user ran", () => {
    for (const doc of SAMPLE_PLANS) expect(isSamplePlan(doc.plan.id)).toBe(true);
    expect(isSamplePlan("plan_01HQ")).toBe(false);
  });
});
