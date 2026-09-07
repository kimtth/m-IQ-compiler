import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AppSettingsStore,
  AuditLog,
  Coordinator,
  DEMO_CONVERSATIONS,
  DEMO_COUNCIL_RUN_ID,
  DEMO_DATA_AGENT_CHAT_ID,
  DEMO_DECK_ITEMS,
  DEMO_DECK_NAME,
  DEMO_DECK_PATH,
  DEMO_DECK_TITLES,
  DEMO_IMAGE_RUN_ID,
  DEMO_RECORDING_ID,
  DEMO_IMAGE_PATH,
  DEMO_RESEARCH_RUN_ID,
  MemoryStore,
  PlanStore,
  ProjectRegistry,
  SAMPLE_JOBS,
  SAMPLE_MEMORIES,
  SAMPLE_PLANS,
  SAMPLE_PROJECT_NAME,
  SamplesService,
  ScheduleStore,
  Scheduler,
  SessionRepo,
  TurnRepo,
  demoSessionId,
  isSampleJob,
  resolveAppPaths,
} from "@iq/core";

/**
 * The samples hub.
 *
 * Every surface used to own its examples end to end, which meant five answers
 * to "is any of this made up?" and a global flag that governed none of them.
 * What this pins is the property that made centralising worth doing: one list,
 * one status, and every module round-tripping through it.
 */

const silent = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
} as never;

let root: string;
let samples: SamplesService;
let scheduler: Scheduler;
let projects: ProjectRegistry;
/** What the demo load asked the three record-keeping stores to write. */
let seededRecords: string[];
/** What clearing the demos asked them to remove. */
let removedRecords: string[];
/** What OfficeCLI reports when asked. Set per test; missing is the default. */
let officeState: "ready" | "missing";
/** Every OfficeCLI verb the load ran, in order. */
let officeCalls: string[];
/** Which document each conversation was bound to. An empty path is a release. */
let officeBindings: string[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "iq-samples-hub-"));
  seededRecords = [];
  removedRecords = [];
  officeState = "missing";
  officeCalls = [];
  officeBindings = [];
  const paths = resolveAppPaths(root);
  const audit = new AuditLog(paths);
  const settings = new AppSettingsStore(paths, audit, () => "cor_test");
  await settings.load();

  scheduler = new Scheduler({
    store: new ScheduleStore(paths),
    logger: silent,
    publish: () => undefined,
    audit: async () => undefined,
    execute: async () => ({ sessionId: "ses", summary: "" }),
  });

  projects = new ProjectRegistry({
    paths,
    logger: silent,
    audit,
    correlationId: () => "cor_test",
  });
  await projects.init();

  samples = new SamplesService({
    paths,
    settings,
    memories: new MemoryStore(paths, audit, silent),
    // The vault and the index are the one module that needs a real directory
    // and a real reindex; both are exercised by `sample-vault.test.ts`, so this
    // suite reports on it and never loads it.
    vault: { current: async () => ({ isSamples: false, directory: "" }) } as never,
    reindexKnowledge: async () => undefined,
    knowledgeEnabled: () => true,
    scheduler,
    coordinator: new Coordinator({
      store: new PlanStore(paths),
      logger: silent,
      publish: () => undefined,
      maxParallelCeiling: 4,
      delegate: async () => ({ status: "succeeded", result: "", error: null }) as never,
      audit: async () => undefined,
    }),
    projects,
    // No real OfficeCLI in a unit test, and none is downloaded to get one.
    // Recorded instead: what the suite has to pin is which verbs run, on which
    // path, and that nothing runs at all when the binary is missing.
    office: {
      status: async () => ({ state: officeState }),
      invoke: async (command: string, _flags: string[], options: { targetPath?: string }) => {
        officeCalls.push(`${command}:${options.targetPath ?? ""}`);
        return { code: 0, stdout: "", stderr: "" };
      },
      addMany: async (path: string, items: readonly unknown[]) => {
        officeCalls.push(`add:${path}:${items.length}`);
        return { code: 0, stdout: "", stderr: "" };
      },
      closeDocument: async (path: string) => void officeCalls.push(`close:${path}`),
    } as never,
    officeFocus: {
      remember: async (sessionId: string, _projectId: string | null, path: string) =>
        void officeBindings.push(`${sessionId}=${path}`),
      forget: async (sessionId: string) => void officeBindings.push(`${sessionId}=`),
    } as never,
    sessions: new SessionRepo(paths),
    turns: new TurnRepo(paths),
    // Recorded rather than performed. The surfaces that keep their own
    // records are covered by their own suites; what this one has to pin is
    // that loading the demos asks each of them exactly once, because the
    // failure being guarded against is a seeded conversation whose pane shows
    // somebody else's run.
    council: () => ({
      seed: async (run) => void seededRecords.push(`council:${run.id}`),
      delete: async (runId) => void removedRecords.push(`council:${runId}`),
    }),
    research: () => ({
      seed: async (run) => void seededRecords.push(`research:${run.id}`),
      delete: async (runId) => void removedRecords.push(`research:${runId}`),
    }),
    dataAgentChats: () => ({
      seed: async (chat) => void seededRecords.push(`dataagent:${chat.id}`),
      delete: async (chatId) => void removedRecords.push(`dataagent:${chatId}`),
    }),
    images: () => ({
      seed: async (run) => void seededRecords.push(`image:${run.id}`),
      delete: async (runId) => void removedRecords.push(`image:${runId}`),
    }),
    recordings: () => ({
      seed: async (input) => void seededRecords.push(`recording:${input.record.id}`),
      forget: async (recordingId) => void removedRecords.push(`recording:${recordingId}`),
    }),
    announceSessions: async () => undefined,
    audit,
    logger: silent,
    correlationId: () => "cor_test",
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("SamplesService", () => {
  it("reports every module the app owns, in one list", async () => {
    const status = await samples.status();
    // The device-held IQ Cell library is deliberately absent: it lives in the
    // renderer's storage and the privileged side must not claim to know it.
    expect(status.modules.map((module) => module.id)).toEqual([
      "memories",
      "knowledge",
      "automations",
      "plans",
      "project",
      "demos",
    ]);
    for (const module of status.modules) expect(module.loaded).toBe(false);
  });

  it("round-trips each module it owns", async () => {
    for (const id of ["memories", "automations", "plans"] as const) {
      const loaded = await samples.load(id);
      expect(loaded.status.modules.find((module) => module.id === id)?.loaded).toBe(true);

      const cleared = await samples.clear(id);
      expect(cleared.status.modules.find((module) => module.id === id)?.loaded).toBe(false);
    }
  });

  it("loads exactly the fixed sets and nothing else", async () => {
    await samples.load("memories");
    await samples.load("automations");
    await samples.load("plans");

    const status = await samples.status();
    const summary = (id: string): string =>
      status.modules.find((module) => module.id === id)?.summary ?? "";

    expect(summary("memories")).toContain(`${SAMPLE_MEMORIES.length} of ${SAMPLE_MEMORIES.length}`);
    expect(summary("automations")).toContain(`${SAMPLE_JOBS.length} of ${SAMPLE_JOBS.length}`);
    expect(summary("plans")).toContain(`${SAMPLE_PLANS.length} of ${SAMPLE_PLANS.length}`);
  });

  it("seeds the surfaces that do not read the conversation", async () => {
    /*
     * Team, Research and Data agent render their own records, not the thread.
     * A demo seeded only as a conversation therefore sends the reader to a
     * pane showing whatever ran there last — which, on a machine with no
     * Fabric capacity, was a pair of raw HTTP 404s. Loading the demos has to
     * write the record each of those panes actually reads.
     *
     * Image Creation is the same fault one step further out: it hides the chat
     * pane entirely, so it has no conversation at all and the run is the whole
     * demo. Its image has to live inside the bound project, because that is the
     * only place the surface is allowed to read from — so a project is bound
     * here, and the case with none is the test below.
     */
    const project = projects.active();
    if (project === null) throw new Error("the registry binds a project on init");

    await samples.load("demos");
    expect(seededRecords).toEqual([
      `council:${DEMO_COUNCIL_RUN_ID}`,
      `research:${DEMO_RESEARCH_RUN_ID}`,
      `dataagent:${DEMO_DATA_AGENT_CHAT_ID}`,
      `image:${DEMO_IMAGE_RUN_ID}`,
      `recording:${DEMO_RECORDING_ID}`,
    ]);
    // The bytes, not just the record. A run pointing at a file that is not
    // there renders as "Not found" on the surface, which is worse than an
    // empty one because it looks like the feature is broken.
    expect(existsSync(join(project.directory, DEMO_IMAGE_PATH))).toBe(true);

    // And clearing takes back exactly what it wrote, by the same fixed ids.
    await samples.clear("demos");
    expect(removedRecords).toEqual([
      `council:${DEMO_COUNCIL_RUN_ID}`,
      `research:${DEMO_RESEARCH_RUN_ID}`,
      `dataagent:${DEMO_DATA_AGENT_CHAT_ID}`,
      `image:${DEMO_IMAGE_RUN_ID}`,
      `recording:${DEMO_RECORDING_ID}`,
    ]);
  });

  /*
   * The Office demo is the one whose surface can contradict its own transcript.
   *
   * Office picks its preview from the conversation's binding and, with none,
   * falls back to the newest file in the project. So the deck the transcript
   * says it wrote has to exist and has to be bound, or the canvas renders the
   * `project` module's readiness note beside a chat claiming a six-slide pptx.
   * That is the exact fault the demos module exists to remove, and it shipped.
   */
  it("builds the deck the Office conversation claims, and binds it to that thread", async () => {
    officeState = "ready";

    await samples.load("demos");
    expect(officeCalls).toEqual([
      `create:${DEMO_DECK_NAME}`,
      `add:${DEMO_DECK_PATH}:${DEMO_DECK_ITEMS.length}`,
      `close:${DEMO_DECK_PATH}`,
    ]);
    // Six slides, and every one of them carrying something other than text —
    // which is the app's own rule for a finished deck.
    expect(DEMO_DECK_TITLES).toHaveLength(6);
    expect(DEMO_DECK_ITEMS.filter((item) => item.type === "slide")).toHaveLength(6);
    expect(DEMO_DECK_ITEMS.map((item) => item.type)).toEqual(
      expect.arrayContaining(["chart", "diagram", "table", "notes"]),
    );
    expect(officeBindings).toEqual([`${demoSessionId("office")}=${DEMO_DECK_PATH}`]);

    // Clearing releases the binding too. Left behind, it points the surface at
    // a file that has just been deleted, which reads as a broken feature.
    await samples.clear("demos");
    expect(officeBindings.at(-1)).toBe(`${demoSessionId("office")}=`);
  });

  it("keeps the Office transcript and bound deck on the same release review", () => {
    const office = DEMO_CONVERSATIONS.find((conversation) => conversation.key === "office");
    expect(office).toBeDefined();
    if (!office) return;

    const transcript = JSON.stringify(office);
    expect(office.title).toBe("Office · Checkout API 26.2 release review");
    expect(office.subMode).toBe("office");
    expect(transcript).toContain("Checkout API 26.2");
    expect(transcript).toContain("CHANGE-2214");
    expect(transcript).toContain(DEMO_DECK_NAME);
    expect(transcript).toContain(DEMO_DECK_PATH);
    expect(transcript).not.toMatch(/customer portal|portal review/i);
  });

  it("leaves the deck alone when OfficeCLI is not installed", async () => {
    // Seven other features do not depend on it, and this runs last but one:
    // throwing here would leave the demos half-written, which is the failure
    // the loader was rewritten to remove. Binding without building is equally
    // out — it opens the surface on a failed read.
    await samples.load("demos");
    expect(officeCalls).toEqual([]);
    expect(officeBindings).toEqual([]);
  });

  it("skips the sample image when no project is bound", async () => {
    // The demos module does not create the project — that is the `project`
    // module's job — and an image with nowhere legal to live is not a reason
    // to fail the other five conversations. Chat without a project is a
    // supported state, so this is a real path and not a defensive branch.
    await projects.bind(null);
    await samples.load("demos");
    expect(seededRecords).not.toContain(`image:${DEMO_IMAGE_RUN_ID}`);
  });

  it("leaves the schedule quiet, however the samples were left last time", async () => {    // The guarantee the surface makes: "Load examples" never hands anybody a
    // running automation. `seedSamples` skips a job that already exists, so a
    // sample enabled on a previous visit would otherwise survive the load that
    // a reader reasonably expects to give them the shipped state back.
    await samples.load("automations");
    for (const job of SAMPLE_JOBS) await scheduler.setEnabled(job.id, true);

    await samples.load("automations");
    const jobs = (await scheduler.listJobs()).filter((job) => isSampleJob(job.id));
    expect(jobs).toHaveLength(SAMPLE_JOBS.length);
    for (const job of jobs) expect(job.enabled).toBe(false);
  });

  it("says out loud when a sample automation has been switched on", async () => {
    await samples.load("automations");
    expect((await samples.status()).modules.find((m) => m.id === "automations")?.warning).toBe("");

    const first = SAMPLE_JOBS[0];
    expect(first).toBeDefined();
    if (!first) return;
    await scheduler.setEnabled(first.id, true);

    const warning = (await samples.status()).modules.find((m) => m.id === "automations")?.warning;
    expect(warning).toContain("enabled");
  });

  it("changes the flag without touching a single record", async () => {
    await samples.load("memories");
    const off = await samples.setEnabled(false);

    expect(off.enabled).toBe(false);
    // Turning the offers off is a preference. Deleting someone's records as a
    // side effect of one would be indefensible.
    expect(off.modules.find((module) => module.id === "memories")?.loaded).toBe(true);
  });

  /**
   * The project module is the only one with a hard dependency outside the app.
   *
   * Its document is built by OfficeCLI rather than shipped as a binary, so
   * without the tool there is no document — and a project registered around a
   * file that does not exist is worse than no project at all.
   */
  it("refuses to load the project when OfficeCLI cannot build its document", async () => {
    await expect(samples.load("project")).rejects.toThrow(/OfficeCLI/);
    // Nothing half-done. The registry is not empty — `init()` adopts the legacy
    // project directory — so what has to be absent is the sample by name.
    expect(projects.list().map((entry) => entry.name)).not.toContain(SAMPLE_PROJECT_NAME);
    expect((await samples.status()).modules.find((m) => m.id === "project")?.loaded).toBe(false);
  });

  it("clears a project that was never loaded without complaining", async () => {
    const cleared = await samples.clear("project");
    expect(cleared.message).toContain("no sample project");
  });
});
