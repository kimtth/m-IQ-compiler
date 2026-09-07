import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  DEVICE_SAMPLE_MODULE,
  SampleModuleId,
  type CouncilRun,
  type DataAgentChat,
  type ImageRun,
  type RecordingAnalysis,
  type RecordingBuild,
  type RecordingRecord,
  type ResearchRun,
  type SampleModuleStatus,
  type SampleStatus,
} from "@iq/shared";
import { SAMPLE_JOBS, isSampleJob } from "./automations.js";
import {
  DEMO_CONVERSATIONS,
  DEMO_COUNCIL_RUN,
  DEMO_COUNCIL_RUN_ID,
  DEMO_COUNT,
  DEMO_DATA_AGENT_CHAT,
  DEMO_DATA_AGENT_CHAT_ID,
  DEMO_DECK_ITEMS,
  DEMO_DECK_NAME,
  DEMO_DECK_PATH,
  DEMO_IMAGE_PATH,
  DEMO_IMAGE_RUN,
  DEMO_IMAGE_RUN_ID,
  DEMO_RECORDING,
  DEMO_RECORDING_ANALYSIS,
  DEMO_RECORDING_BUILD,
  DEMO_RECORDING_ID,
  DEMO_RESEARCH_RUN,
  DEMO_RESEARCH_RUN_ID,
  demoSessionEvents,
  demoSessionId,
  demoSessionIds,
  demoTurnIds,
  demoTurnLog,
} from "./demos.js";
import { DEMO_IMAGE_JPEG_BASE64 } from "./demo-image-bytes.js";
import { SAMPLE_MEMORIES, isSampleMemory } from "./memories.js";
import { isSamplePlan } from "./plans.js";
import {
  SAMPLE_DOCUMENT_MARKDOWN,
  SAMPLE_DOCUMENT_NAME,
  SAMPLE_DOCUMENT_PATH,
  SAMPLE_PROJECT_FILES,
  SAMPLE_PROJECT_NAME,
  SAMPLE_SESSION_ID,
  SAMPLE_TURN_COUNT,
  sampleSessionEvents,
  sampleTurnIds,
  sampleTurnLogs,
} from "./project.js";
import { SAMPLE_VAULT_NOTES, SAMPLE_VAULT_SUMMARY } from "./vault.js";
import type { AppPaths } from "../config/paths.js";
import type { AppSettingsStore } from "../config/app-settings.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { Coordinator } from "../orchestration/coordinator.js";
import type { KnowledgeVault } from "../knowledge/vault.js";
import type { Logger } from "../util/logger.js";
import type { MemoryStore } from "../memory/store.js";
import type { OfficeCli } from "../office/officecli.js";
import type { OfficeFocus } from "../office/office-focus.js";
import type { ProjectRegistry } from "../project/registry.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { SessionRepo } from "../runtime/sessions/fs-repo.js";
import type { TurnRepo } from "../runtime/turns/fs-repo.js";

/**
 * One hub for every worked example in the app.
 *
 * # Why this exists
 *
 * Each surface used to own its own samples end to end: its own fixed data, its
 * own seed and clear, its own idea of "is this loaded", and its own IPC
 * channel. Five modules meant five answers to one question — *is any of what I
 * am looking at made up?* — and no single place that could be read to find out.
 * The global flag that was meant to govern all of it governed none of it,
 * because nothing owned the list of things it applied to.
 *
 * So the list lives here, and it is the only list: the Control Center surface,
 * the global flag and the audit trail all follow from {@link MODULES}.
 *
 * That is not the same as saying a sixth module is one edit. It is a row in
 * {@link MODULES}, a member of `SampleModuleId` in `@iq/shared`, and — if the
 * privileged side owns it — a case in each of `statusOf`, `loadOne` and
 * `clearOne`. This comment claimed "a row and nothing else" for a while, which
 * was checkably false and exactly the kind of thing a reader trusts.
 *
 * # What stays where it was
 *
 * The *writes* stay with the store that owns the file. `MemoryStore` holds the
 * mutex and the audit shape for memories; `KnowledgeVault` knows that the demo
 * vault is a directory it may delete and a user's vault is not. Moving those in
 * here would mean this class reaching into four sets of on-disk invariants it
 * does not own, which is a worse coupling than the one it removes.
 *
 * What moved is everything that was duplicated: the fixed data, the naming, the
 * loaded/not-loaded question, and the decision about what is safe to ship.
 *
 * # The safety rule
 *
 * Two of these modules can act on their own. An automation is a schedule and a
 * plan is a fan-out of sub-agents, so "load the examples to see what the
 * surface looks like" must never start work, spend tokens or touch a mailbox.
 * Sample jobs are therefore written disabled and *re-asserted* disabled on
 * every load — see {@link loadAutomations} — and the status says so out loud
 * when one has since been switched on.
 */

export interface SamplesDeps {
  paths: AppPaths;
  settings: AppSettingsStore;
  memories: MemoryStore;
  vault: KnowledgeVault;
  /** Rebuilds the knowledge index after the vault directory changes. */
  reindexKnowledge: (correlationId: string) => Promise<unknown>;
  /** Null when tenant policy has switched the knowledge graph off. */
  knowledgeEnabled: () => boolean;
  scheduler: Scheduler;
  coordinator: Coordinator;
  /** Creates, binds and forgets the sample project. */
  projects: ProjectRegistry;
  /** Builds the sample document, the same way a turn would. */
  office: OfficeCli;
  /** Files the document under the sample conversation, the same way a turn would. */
  officeFocus: OfficeFocus;
  sessions: SessionRepo;
  turns: TurnRepo;
  /**
   * The stores whose surfaces do not read the conversation transcript.
   *
   * Thunks rather than instances because all of them are constructed after
   * this service is. They are also the reason the "writes stay with the store"
   * rule below still holds: each one seeds itself, and this class only says
   * which record to seed.
   */
  council: () => { seed: (run: CouncilRun) => Promise<void>; delete: (runId: string) => Promise<void> };
  research: () => { seed: (run: ResearchRun) => Promise<void>; delete: (runId: string) => Promise<void> };
  dataAgentChats: () => {
    seed: (chat: DataAgentChat) => Promise<void>;
    delete: (chatId: string) => Promise<void>;
  };
  images: () => { seed: (run: ImageRun) => Promise<void>; delete: (runId: string) => Promise<void> };
  recordings: () => {
    seed: (input: {
      record: RecordingRecord;
      analysis: RecordingAnalysis;
      build: RecordingBuild;
    }) => Promise<void>;
    /** `forget`, not `delete`: nothing was recorded, so nothing is audited. */
    forget: (recordingId: string) => Promise<void>;
  };
  /** Re-publishes the conversation rail, which is otherwise fetched once. */
  announceSessions: () => Promise<void>;
  audit: AuditLog;
  logger: Logger;
  correlationId: () => string;
}

/** How each module names itself, and what its examples are for. */
const MODULES: Record<
  SampleModuleId,
  { label: string; detail: string; owner: "app" | "device" }
> = {
  memories: {
    label: "IQ Memories",
    detail:
      `${SAMPLE_MEMORIES.length} memories — two awaiting review, the rest settled so Compile ` +
      "can be tried without signing in.",
    owner: "app",
  },
  knowledge: {
    label: "IQ Knowledge",
    detail:
      `An Obsidian-style vault of ${SAMPLE_VAULT_NOTES.length} notes in the app's own samples ` +
      "directory, plus raw files waiting in source/ for Ingest to read.",
    owner: "app",
  },
  iqcells: {
    // The label and detail are `DEVICE_SAMPLE_MODULE` in `@iq/shared`, because
    // the renderer has to say the same two sentences about a module only it can
    // read. They were byte-identical copies with nothing keeping them so.
    label: DEVICE_SAMPLE_MODULE.label,
    detail: DEVICE_SAMPLE_MODULE.detail,
    // Held in the renderer's own storage, so the privileged side can neither
    // read nor change it. Reported as a row anyway: the user asked one question
    // and a list that silently omits a module is not an answer.
    owner: "device",
  },
  automations: {
    label: "Automations",
    detail:
      `${SAMPLE_JOBS.length} scheduled jobs across different trigger shapes — every one of them ` +
      "disabled, with read-only tools only.",
    owner: "app",
  },
  plans: {
    label: "Delegated plans",
    detail:
      "A finished plan: a three-way fan-out, a gate, and a task that waited on all of it. " +
      "Already succeeded, so nothing is dispatched.",
    owner: "app",
  },
  project: {
    label: "Project & conversation",
    detail:
      "A bound project holding a report, notes and a tracker, plus the two-turn conversation " +
      "that produced them. Needs OfficeCLI: the document is built, not shipped.",
    owner: "app",
  },
  demos: {
    label: "Feature demos",
    detail:
      `${DEMO_COUNT} conversations, each starting from an empty surface, plus the council ` +
      "run, research report, Data Agent thread, generated image, six-slide deck and screen " +
      "recording their panes read — so Work IQ, Research, Council, Data Agent, Office, " +
      "Image, Skill Recording and meeting notes can be shown without a tenant, a capacity " +
      "or a model. Needs OfficeCLI: the deck is built, not shipped.",
    owner: "app",
  },
};

/** Modules the privileged side can actually read and change. */
const APP_MODULES = SampleModuleId.options.filter((id) => MODULES[id].owner === "app");

export class SamplesService {
  constructor(private readonly deps: SamplesDeps) {}

  /** The global switch. Off hides every offer; it deletes nothing. */
  enabled(): boolean {
    return this.deps.settings.current().sampleData;
  }

  /**
   * Turn the offers on or off.
   *
   * Deliberately does not load or clear anything. Deleting a user's records as
   * a side effect of a preference would be indefensible, and silently writing
   * 110 notes because a checkbox was ticked is the same mistake pointing the
   * other way.
   */
  async setEnabled(enabled: boolean): Promise<SampleStatus> {
    await this.deps.settings.save({ ...this.deps.settings.current(), sampleData: enabled });
    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "samples.enabled_changed",
      family: "samples",
      outcome: "succeeded",
      correlationId: this.deps.correlationId(),
      reason: `sample data ${enabled ? "shown" : "hidden"}`,
    });
    return this.status();
  }

  /** Every module the privileged side owns, and whether it is loaded. */
  async status(): Promise<SampleStatus> {
    const modules: SampleModuleStatus[] = [];
    for (const id of APP_MODULES) modules.push(await this.statusOf(id));
    return { enabled: this.enabled(), modules };
  }

  private async statusOf(id: SampleModuleId): Promise<SampleModuleStatus> {
    const { label, detail, owner } = MODULES[id];
    const base = { id, label, detail, owner, warning: "" };

    switch (id) {
      case "memories": {
        const all = await this.deps.memories.list();
        const samples = all.filter((memory) => isSampleMemory(memory.id));
        return {
          ...base,
          loaded: samples.length > 0,
          summary: `${samples.length} of ${all.length} memories are samples`,
        };
      }
      case "knowledge": {
        const vault = await this.deps.vault.current();
        return {
          ...base,
          loaded: vault.isSamples,
          summary: vault.isSamples
            ? `The sample vault at ${vault.directory}`
            : "The vault is your own, not the sample one",
        };
      }
      case "automations": {
        const all = await this.deps.scheduler.listJobs();
        const samples = all.filter((job) => isSampleJob(job.id));
        const live = samples.filter((job) => job.enabled);
        return {
          ...base,
          loaded: samples.length > 0,
          summary: `${samples.length} of ${all.length} jobs are samples${
            samples.length > 0 ? `, ${samples.length - live.length} disabled` : ""
          }`,
          // The one state worth interrupting for. A sample is written disabled,
          // so an enabled one is a deliberate act — but it is also a scheduled
          // turn that will run unattended, and the surface should not make the
          // reader work that out from a list of names.
          warning:
            live.length === 0
              ? ""
              : `${live.length} sample ${live.length === 1 ? "automation is" : "automations are"} enabled and will run on schedule`,
        };
      }
      case "plans": {
        const all = await this.deps.coordinator.listPlans(500);
        const samples = all.filter((doc) => isSamplePlan(doc.plan.id));
        return {
          ...base,
          loaded: samples.length > 0,
          summary: `${samples.length} of ${all.length} plans are samples`,
        };
      }
      case "project": {
        const project = this.sampleProject();
        if (project === null) {
          return { ...base, loaded: false, summary: "No sample project is registered" };
        }
        const bound = this.deps.projects.active()?.id === project.id;
        const turns = (await this.deps.sessions.turnIds(SAMPLE_SESSION_ID)).length;
        return {
          ...base,
          loaded: true,
          summary:
            `"${project.name}" at ${project.directory}${bound ? ", bound" : ", not bound"}` +
            `, with a ${turns}-turn sample conversation`,
          // The project is where the agent writes. Loading the sample binds it,
          // and a user who then asks for a document in what they think is their
          // own project gets it in this one instead.
          warning: bound
            ? "The sample project is bound — anything the agent writes goes into it"
            : "",
        };
      }
      case "demos": {
        let present = 0;
        for (const sessionId of demoSessionIds()) {
          if ((await this.deps.sessions.turnIds(sessionId)).length > 0) present += 1;
        }
        return {
          ...base,
          loaded: present > 0,
          summary:
            present === 0
              ? "No demo conversations are in the rail"
              : `${present} of ${DEMO_COUNT} demo conversations are in the rail`,
        };
      }
      default:
        return { ...base, loaded: false, summary: "Held on this device" };
    }
  }

  /** Put one module's examples in place. Returns what to tell the user. */
  async load(id: SampleModuleId): Promise<{ status: SampleStatus; message: string }> {
    const message = await this.loadOne(id);
    await this.record("samples.loaded", id, message);
    return { status: await this.status(), message };
  }

  /** Take one module's examples back out. */
  async clear(id: SampleModuleId): Promise<{ status: SampleStatus; message: string }> {
    const message = await this.clearOne(id);
    await this.record("samples.cleared", id, message);
    return { status: await this.status(), message };
  }

  private async record(action: string, id: SampleModuleId, reason: string): Promise<void> {
    await this.deps.audit.record({
      actor: { kind: "system" },
      action,
      family: "samples",
      outcome: "succeeded",
      correlationId: this.deps.correlationId(),
      resources: [id],
      reason,
    });
  }

  private async loadOne(id: SampleModuleId): Promise<string> {
    switch (id) {
      case "memories": {
        const result = await this.deps.memories.seedSamples(this.deps.correlationId());
        return `Loaded ${result.added} sample memories.`;
      }
      case "knowledge": {
        this.requireKnowledge();
        const vault = await this.deps.vault.installSamples();
        await this.deps.reindexKnowledge(this.deps.correlationId());
        return `Wrote ${SAMPLE_VAULT_SUMMARY.notes} sample notes to ${vault.directory} and indexed them.`;
      }
      case "automations":
        return this.loadAutomations();
      case "plans": {
        const result = await this.deps.coordinator.seedSamples();
        return `Loaded ${result.added} sample plan. It is already complete — no sub-agents are started.`;
      }
      case "project":
        return this.loadProject();
      case "demos":
        return this.loadDemos();
      default:
        throw new Error(`${id} samples are held on this device, not by the app`);
    }
  }

  /**
   * Load the sample automations, disabled.
   *
   * The re-assert is the point. `seedSamples` skips a job that is already there
   * — correctly, because overwriting would discard a change the user made — so
   * a sample enabled on a previous visit would survive a "Load" that the reader
   * reasonably expects to hand them the shipped state back. Setting it here
   * means "Load examples" always leaves the schedule quiet, and the only way a
   * sample automation runs is that someone enabled it and left it enabled.
   */
  private async loadAutomations(): Promise<string> {
    const result = await this.deps.scheduler.seedSamples();
    let disabled = 0;
    for (const job of await this.deps.scheduler.listJobs()) {
      if (!isSampleJob(job.id) || !job.enabled) continue;
      await this.deps.scheduler.setEnabled(job.id, false);
      disabled += 1;
    }
    if (disabled > 0) {
      this.deps.logger.info("sample automations re-disabled on load", { count: disabled });
    }
    return (
      `Loaded ${result.added} sample automations. All are disabled — enable one only after ` +
      "reading what it would do."
    );
  }

  private async clearOne(id: SampleModuleId): Promise<string> {
    switch (id) {
      case "memories": {
        const result = await this.deps.memories.clearSamples(this.deps.correlationId());
        return `Removed ${result.removed} sample memories. Anything the assistant proposed is untouched.`;
      }
      case "knowledge": {
        this.requireKnowledge();
        await this.deps.vault.removeSamples();
        await this.deps.reindexKnowledge(this.deps.correlationId());
        return "Removed the sample vault and went back to indexing the project.";
      }
      case "automations": {
        const result = await this.deps.scheduler.clearSamples();
        return `Removed ${result.removed} sample automations. Jobs you wrote are untouched.`;
      }
      case "plans": {
        const result = await this.deps.coordinator.clearSamples();
        return `Removed ${result.removed} sample plan. Plans you ran are untouched.`;
      }
      case "project":
        return this.clearProject();
      case "demos":
        return this.clearDemos();
      default:
        throw new Error(`${id} samples are held on this device, not by the app`);
    }
  }

  private requireKnowledge(): void {
    if (!this.deps.knowledgeEnabled()) {
      throw new Error("the knowledge graph is disabled by tenant policy");
    }
  }

  /**
   * Write one conversation per feature, each into its own thread.
   *
   * Own thread is the whole point. Appending a demo question to whatever
   * conversation happened to be open is how a screenshot of the Fabric surface
   * ended up showing the Browser's history, and no amount of care during a
   * recording fixes that — the state has to be separate before the camera
   * starts.
   *
   * Deleted before written because both logs are append-only: appending the
   * same events again would double every conversation on each load.
   */
  private async loadDemos(): Promise<string> {
    for (const sessionId of demoSessionIds()) await this.deps.sessions.delete(sessionId);
    for (const turnId of demoTurnIds()) await this.deps.turns.delete(turnId);

    for (const demo of DEMO_CONVERSATIONS) {
      const log = demoTurnLog(demo);
      // The turn is written before the session references it, the same order
      // the runtime uses, so a session can never point at a turn that is
      // not there.
      await this.deps.turns.append(log.turnId, log.events);
      await this.deps.sessions.append(
        demoSessionId(demo.key),
        demoSessionEvents(demo, log.turnId),
      );
    }
    await this.deps.announceSessions();

    /*
     * Five of the features need a copy in the store their pane reads.
     *
     * Team, Research and Data agent do not render the conversation
     * transcript. Each has its own pane keyed on its own selection, so a
     * seeded turn log alone sends the reader to a surface showing whatever was
     * last open there — in practice, someone else's failed run. The record and
     * the conversation carry the same question and the same answer, because a
     * screen that disagrees with the transcript beside it is the exact fault
     * this module was written to remove.
     *
     * Image Creation and Skill Recording hide the chat pane outright, so they
     * have no conversation at all — only the records: a run and the image file
     * it points at, and a recording with the reconstruction and skill built
     * from it.
     */
    await this.deps.council().seed(DEMO_COUNCIL_RUN);
    await this.deps.research().seed(DEMO_RESEARCH_RUN);
    await this.deps.dataAgentChats().seed(DEMO_DATA_AGENT_CHAT);
    await this.seedDemoImage();
    await this.seedDemoDeck();
    await this.deps.recordings().seed({
      record: DEMO_RECORDING,
      analysis: DEMO_RECORDING_ANALYSIS,
      build: DEMO_RECORDING_BUILD,
    });

    return (
      `Loaded ${DEMO_COUNT} demo conversations, plus the council run, research report, ` +
      "Data Agent thread, image, six-slide deck and screen recording their surfaces read. " +
      "No model ran them — every turn is logged with a model of sample-data."
    );
  }

  /**
   * Write the sample image, then the run that points at it.
   *
   * That order matters. The surface reads the bytes back through
   * `project:read`, which refuses any path outside the active project, so a run
   * seeded before its file exists renders as "Not found" until the next load.
   *
   * Silently skipped when no project is bound. The demos module does not create
   * the project — that is the `project` module's job — and an image with
   * nowhere to live is not a reason to fail the whole load.
   */
  private async seedDemoImage(): Promise<void> {
    const directory = this.deps.projects.active()?.directory;
    if (directory === undefined) return;
    const file = join(directory, DEMO_IMAGE_PATH);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(DEMO_IMAGE_JPEG_BASE64, "base64"));
    await this.deps.images().seed(DEMO_IMAGE_RUN);
  }

  /**
   * Build the deck the Office conversation says it built, then point that
   * conversation at it.
   *
   * Both halves are needed, and the second is the one that was missing. The
   * Office surface picks its preview from the conversation's binding, and with
   * no binding falls back to the newest file in the project — which is the
   * `project` module's readiness note. So the transcript said it had written a
   * six-slide pptx while the canvas beside it rendered an unrelated docx. That
   * is the screen disagreeing with the chat, which is the one thing this module
   * exists to prevent.
   *
   * The deck is made by OfficeCLI rather than shipped as bytes, so the file the
   * reader opens is the file the tool card claims was written, made the same
   * way. The folder is removed first because `create` refuses to overwrite, and
   * a second load would otherwise fail.
   *
   * Skipped, without complaint, when no project is bound or when OfficeCLI is
   * not installed. Neither is a reason to fail the other seven features: this
   * runs last but one, and a throw here would leave the demos half-written,
   * which is the failure this module was rewritten to remove. Without OfficeCLI
   * the Office surface cannot render any preview anyway, so there is nothing
   * lost by not writing a file it could not have opened.
   *
   * Building and binding go together or not at all. A binding without the file
   * makes the surface open on a failed read, which reads as a broken feature.
   */
  private async seedDemoDeck(): Promise<void> {
    const project = this.deps.projects.active();
    if (project === undefined || project === null) return;
    if ((await this.deps.office.status()).state !== "ready") return;

    await rm(join(project.directory, dirname(DEMO_DECK_PATH)), {
      recursive: true,
      force: true,
    });
    await this.deps.office.invoke("create", [], { targetPath: DEMO_DECK_NAME });
    // One call for the whole deck. Later items target slides earlier ones
    // create, so they cannot be split across calls.
    await this.deps.office.addMany(
      DEMO_DECK_PATH,
      DEMO_DECK_ITEMS.map((item) => ({
        target: item.target,
        type: item.type,
        properties: [...item.properties],
      })),
    );
    // Flush the resident, or the file on disk stays empty until it idles out —
    // and the preview reads the disk.
    await this.deps.office.closeDocument(DEMO_DECK_PATH);

    await this.deps.officeFocus.remember(demoSessionId("office"), project.id, DEMO_DECK_PATH);
  }

  private async clearDemos(): Promise<string> {
    for (const sessionId of demoSessionIds()) await this.deps.sessions.delete(sessionId);
    for (const turnId of demoTurnIds()) await this.deps.turns.delete(turnId);
    await this.deps.announceSessions();
    await this.deps.council().delete(DEMO_COUNCIL_RUN_ID);
    await this.deps.research().delete(DEMO_RESEARCH_RUN_ID);
    await this.deps.dataAgentChats().delete(DEMO_DATA_AGENT_CHAT_ID);
    await this.deps.images().delete(DEMO_IMAGE_RUN_ID);
    await this.deps.recordings().forget(DEMO_RECORDING_ID);
    await this.forgetDemoDeck();
    return (
      `Removed ${DEMO_COUNT} demo conversations and the six records that go with them. ` +
      "Conversations, council runs, reports and recordings you made yourself are untouched."
    );
  }

  /**
   * Take the deck back out, and the binding with it.
   *
   * The binding goes second and unconditionally: an entry left pointing at a
   * file that has just been deleted makes the Office surface open on a failed
   * read, which is worse than the empty surface the clear was asking for.
   */
  private async forgetDemoDeck(): Promise<void> {
    const project = this.deps.projects.active();
    if (project !== undefined && project !== null) {
      await rm(join(project.directory, dirname(DEMO_DECK_PATH)), {
        recursive: true,
        force: true,
      });
    }
    await this.deps.officeFocus.forget(demoSessionId("office"));
  }

  /** The registered sample project, by its fixed name. Null when never loaded. */
  private sampleProject(): { id: string; name: string; directory: string } | null {
    // `list()` throws before `init()`. A status read must not be the thing that
    // brings the app down during start-up, and "not loaded" is the truthful
    // answer while the registry has not been read yet.
    try {
      return this.deps.projects.list().find((entry) => entry.name === SAMPLE_PROJECT_NAME) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Create the project, fill it, and write the conversation that made it.
   *
   * Order matters. The project has to exist and be bound before OfficeCLI is
   * asked for anything, because the binding *is* the boundary it refuses to
   * write outside of. And the turn logs are written last, because they name the
   * project id, which does not exist until the registry has made the directory.
   *
   * Idempotent: loading twice re-binds the same project and rewrites the same
   * files under the same fixed ids.
   */
  private async loadProject(): Promise<string> {
    const office = await this.deps.office.status();
    if (office.state !== "ready") {
      throw new Error(
        "this example needs OfficeCLI, which builds its document. Install it on " +
          "Co-create → Office, then load again.",
      );
    }

    const existing = this.sampleProject();
    const project =
      existing ?? (await this.deps.projects.create({ name: SAMPLE_PROJECT_NAME }));
    await this.deps.projects.bind(project.id);

    for (const file of SAMPLE_PROJECT_FILES) {
      const absolute = join(project.directory, file.path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, file.text, "utf8");
    }

    // `create` refuses to overwrite, so a reload would fail on the second pass.
    // Removing the folder first makes the load repeatable and means the
    // document always matches the Markdown in `project.ts` rather than whatever
    // an earlier version wrote.
    await rm(join(project.directory, dirname(SAMPLE_DOCUMENT_PATH)), {
      recursive: true,
      force: true,
    });
    await this.deps.office.invoke("create", [], { targetPath: SAMPLE_DOCUMENT_NAME });
    await this.deps.office.addMany(SAMPLE_DOCUMENT_PATH, [
      { target: "/body", type: "markdown", properties: [`markdown=${SAMPLE_DOCUMENT_MARKDOWN}`] },
    ]);
    // Flush the resident, or the file on disk stays empty until it idles out —
    // and the preview reads the disk.
    await this.deps.office.closeDocument(SAMPLE_DOCUMENT_PATH);

    await this.writeSampleConversation(project.id);
    // The conversation wrote this document, so opening that conversation has to
    // open it. Without this the Office surface has a project with one file in
    // it and nothing on screen, which reads as though the load failed.
    await this.deps.officeFocus.remember(SAMPLE_SESSION_ID, project.id, SAMPLE_DOCUMENT_PATH);

    return (
      `Loaded "${SAMPLE_PROJECT_NAME}" with ${SAMPLE_PROJECT_FILES.length + 1} files, and bound it. ` +
      `The ${SAMPLE_TURN_COUNT}-turn conversation that produced them is in the rail — no model ran it.`
    );
  }

  /**
   * Rewrite the conversation from scratch.
   *
   * Deleted first because both logs are append-only: appending the same events
   * again would double the conversation on every load.
   */
  private async writeSampleConversation(projectId: string): Promise<void> {
    await this.deps.sessions.delete(SAMPLE_SESSION_ID);
    for (const turnId of sampleTurnIds()) await this.deps.turns.delete(turnId);

    const logs = sampleTurnLogs(projectId);
    // The turn is written before the session references it, the same order the
    // runtime uses, so a session can never point at a turn that is not there.
    for (const log of logs) await this.deps.turns.append(log.turnId, log.events);
    await this.deps.sessions.append(
      SAMPLE_SESSION_ID,
      sampleSessionEvents(logs.map((log) => log.turnId)),
    );
    await this.deps.announceSessions();
  }

  /**
   * Take the project back out, files and all.
   *
   * This deletes a directory, which nothing else in this hub does except the
   * knowledge vault — and for the same reason. The app made this directory,
   * under its own state root, to hold examples. Forgetting the registry entry
   * and leaving the document behind would leave the reader with a folder of
   * invented parts data and nothing saying where it came from.
   *
   * The guard is what makes that safe: only a directory inside `paths.project`
   * is removed. A project the user pointed at their own documents folder is
   * forgotten, never deleted.
   */
  private async clearProject(): Promise<string> {
    await this.deps.sessions.delete(SAMPLE_SESSION_ID);
    for (const turnId of sampleTurnIds()) await this.deps.turns.delete(turnId);
    await this.deps.announceSessions();

    const project = this.sampleProject();
    if (project === null) return "There was no sample project to remove.";

    const managed = resolve(this.deps.paths.project);
    const directory = resolve(project.directory);
    const inside = directory !== managed && !relative(managed, directory).startsWith("..") &&
      !isAbsolute(relative(managed, directory));

    await this.deps.projects.remove(project.id);
    if (inside) {
      await rm(directory, { recursive: true, force: true });
      return `Removed "${project.name}", its files and its conversation.`;
    }
    this.deps.logger.warn("sample project directory left in place", { directory });
    return (
      `Forgot "${project.name}" and removed its conversation. Its files were left where ` +
      "they are: the directory is outside the app's own project folder."
    );
  }
}
