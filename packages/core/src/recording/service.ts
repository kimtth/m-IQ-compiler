import {
  MIN_ANALYSABLE_EVENTS,
  RecordingAnalysisConsent,
  RecordingBuild,
  SKILL_RECORDING_ANALYSIS_NOTICE,
  SKILL_RECORDING_CAPTURE_NOTICE,
  SKILL_RECORDING_NOTICE_VERSION,
  renderValues,
  type AnalysisFeedback,
  type AnalysisStep,
  type BuildKind,
  type RecordingAnalysis,
  type RecordingPlan,
  type RecordingProgress,
  type RecordingRecord,
  type RecorderStatus,
} from "@iq/shared";
import type { AuditLog } from "../audit/audit-log.js";
import type { SkillStore } from "../skills/store.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { Logger } from "../util/logger.js";
import { KeyedMutex } from "../util/lock.js";
import { RecordingAnalyst, RecordingBuilder } from "./analyst.js";
import { buildBundle } from "./bundle.js";
import type { RecorderController, StartRecordingInput } from "./controller.js";
import type { NarrationTranscriber } from "./narration.js";
import type { RecordingStore } from "./store.js";

/**
 * Everything after the recording stops.
 *
 * The controller owns capture; this owns the rest of the pipeline — bundle,
 * narration, analysis, approval, plan, build — and the one thing that pipeline
 * exists to protect: the point where screen content leaves the device.
 *
 * ## The consent boundary
 *
 * Capture is local. Analysis is not: it sends the bundle, which contains window
 * titles, URLs and clipboard previews from real work, to a model. That is this
 * application's first bulk egress of screen content, so it is gated separately
 * from capture, requires a signed-in account so the decision is attributable,
 * and requires the user to confirm they have actually looked at what is about
 * to be sent. `contentReviewed` is typed as a literal `true` in the contract
 * precisely so "not answered" and "answered no" cannot both read as consent.
 */

export interface RecordingServiceDeps {
  store: RecordingStore;
  controller: RecorderController;
  analyst: RecordingAnalyst;
  builder: RecordingBuilder;
  narration: NarrationTranscriber;
  skills: SkillStore;
  scheduler: Scheduler;
  audit: AuditLog;
  logger: Logger;
  appVersion: string;
  currentAccount: () => { oid: string; tenantId: string; username: string } | null;
  publish: (record: RecordingRecord) => void;
  publishProgress: (progress: RecordingProgress) => void;
  now?: () => Date;
}

export class RecordingService {
  /** One analysis or build per recording at a time. */
  private readonly locks = new KeyedMutex();
  private readonly running = new Map<string, AbortController>();
  private readonly plans = new Map<string, RecordingPlan>();

  constructor(private readonly deps: RecordingServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The two disclosures, so the UI never writes its own version of them. */
  notice(): {
    version: string;
    capture: string;
    analysis: string;
    signedIn: boolean;
  } {
    return {
      version: SKILL_RECORDING_NOTICE_VERSION,
      capture: SKILL_RECORDING_CAPTURE_NOTICE,
      analysis: SKILL_RECORDING_ANALYSIS_NOTICE,
      signedIn: this.deps.currentAccount() !== null,
    };
  }

  list(): Promise<RecordingRecord[]> {
    return this.deps.store.list();
  }

  // --- capture (delegated to the controller, which owns the state machine) --

  status(): RecorderStatus {
    return this.deps.controller.status();
  }

  start(input: StartRecordingInput): Promise<RecordingRecord> {
    return this.deps.controller.start(input);
  }

  stop(): Promise<RecordingRecord> {
    return this.deps.controller.stop();
  }

  discard(): Promise<void> {
    return this.deps.controller.discard();
  }

  marker(note: string): boolean {
    return this.deps.controller.marker(note);
  }

  /** Where the captured material lives, so a person can go and look at it. */
  directory(recordingId: string): string {
    return this.deps.store.dir(recordingId);
  }

  get(recordingId: string): Promise<RecordingRecord | null> {
    return this.deps.store.get(recordingId);
  }

  analysis(recordingId: string): Promise<RecordingAnalysis | null> {
    return this.deps.store.readAnalysis(recordingId);
  }

  build(recordingId: string): Promise<RecordingBuild | null> {
    return this.deps.store.readBuild(recordingId);
  }

  async rename(recordingId: string, title: string): Promise<RecordingRecord> {
    const record = await this.require(recordingId);
    const renamed = { ...record, title: title.trim().slice(0, 200) };
    await this.deps.store.save(renamed);
    this.deps.publish(renamed);
    return renamed;
  }

  /**
   * Put a finished recording, its reconstruction and its build on disk.
   *
   * For the sample data. Skill Recording is otherwise unshowable on a machine
   * that has never recorded anything: the pane opens on "Nothing has been
   * recorded yet", and getting past that needs a real capture, a model to
   * reconstruct it and a person to approve the result.
   *
   * No frames and no events are written, and the record says so — `hasVideo`
   * and `frameCount` are what they are because no screen was captured. The
   * demo is the reconstruction and the skill that came out of it, which is the
   * part of the feature worth reading.
   *
   * Nothing is audited: no analysis ran and no consent was given, so stamping
   * either would put a claim in the audit log that is not true.
   */
  async seed(input: {
    record: RecordingRecord;
    analysis: RecordingAnalysis;
    build: RecordingBuild;
  }): Promise<void> {
    await this.deps.store.ensureDir(input.record.id);
    await this.deps.store.save(input.record);
    await this.deps.store.writeAnalysis(input.record.id, input.analysis);
    await this.deps.store.writeBuild(input.record.id, input.build);
    this.deps.publish(input.record);
  }

  /**
   * Take a seeded recording back off disk.
   *
   * The counterpart to {@link seed}, and deliberately not {@link delete}. That
   * path closes the analysis and build sessions for the recording and writes a
   * `recording.deleted` entry to the audit log — both wrong here, because no
   * session was ever opened and nobody recorded anything to delete. Closing a
   * session that was never opened also blocked: clearing the samples stopped
   * dead at this line and the rest of the module was never written back.
   */
  async forget(recordingId: string): Promise<void> {
    await this.deps.store.remove(recordingId);
  }

  async delete(recordingId: string): Promise<void> {
    const record = await this.deps.store.get(recordingId);
    this.running.get(recordingId)?.abort();
    await this.deps.analyst.close(recordingId);
    await this.deps.store.remove(recordingId);
    await this.deps.audit.record({
      actor: this.actor(),
      action: "recording.deleted",
      family: "recording",
      outcome: "succeeded",
      correlationId: record?.correlationId ?? recordingId,
      resources: [recordingId],
    });
  }

  /** Stop whatever is running for this recording. */
  cancel(recordingId: string): boolean {
    const controller = this.running.get(recordingId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  // --- analysis -----------------------------------------------------------

  /**
   * Reconstruct the recording, with consent.
   *
   * The gate is here rather than in the analyst because the analyst is also the
   * revision path, and a check that only runs on the first call is not a gate.
   * Consent is stamped once, on the record, from the signed-in identity — never
   * from anything the renderer sent.
   */
  async analyse(input: {
    recordingId: string;
    acknowledgedNoticeVersion: string;
    contentReviewed: true;
  }): Promise<RecordingAnalysis> {
    return this.locks.withLock(input.recordingId, async () => {
      const record = await this.require(input.recordingId);
      const account = this.deps.currentAccount();

      const refuse = async (reason: string): Promise<Error> => {
        await this.deps.audit.record({
          actor: this.actor(),
          action: "recording.analysis_refused",
          family: "recording",
          outcome: "denied",
          correlationId: record.correlationId,
          resources: [record.id],
          reason,
        });
        return new Error(reason);
      };

      if (account === null) {
        throw await refuse(
          "analysing a recording sends screen content to a model, so it requires a " +
            "signed-in Microsoft 365 account and an attributable decision",
        );
      }
      if (input.acknowledgedNoticeVersion !== SKILL_RECORDING_NOTICE_VERSION) {
        throw await refuse(
          `the recording notice has changed (acknowledged ${input.acknowledgedNoticeVersion}, ` +
            `current ${SKILL_RECORDING_NOTICE_VERSION}); read it again before analysing`,
        );
      }
      if (input.contentReviewed !== true) {
        throw await refuse("analysing requires confirming that the captured content was reviewed");
      }

      const events = await this.deps.store.readEvents(record.id);
      if (!RecordingAnalyst.analysable(events)) {
        throw await refuse(
          `this recording holds fewer than ${MIN_ANALYSABLE_EVENTS} meaningful events; ` +
            "there is nothing to reconstruct",
        );
      }

      const consent =
        record.analysisConsent ??
        RecordingAnalysisConsent.parse({
          noticeVersion: SKILL_RECORDING_NOTICE_VERSION,
          acknowledgedByOid: account.oid,
          acknowledgedByTenantId: account.tenantId,
          acknowledgedByUsername: account.username,
          acknowledgedAt: this.now().toISOString(),
          contentReviewed: true,
        });

      await this.deps.audit.record({
        actor: this.actor(),
        action: "recording.analysis_started",
        family: "recording",
        outcome: "allowed",
        correlationId: record.correlationId,
        resources: [record.id],
        reason: `events=${events.length} frames=${record.frameCount}`,
      });

      return this.runAnalysis({ ...record, analysisConsent: consent }, events);
    });
  }

  /** Another pass, with the user's corrections. Consent was given already. */
  async reanalyse(recordingId: string, feedback?: AnalysisFeedback): Promise<RecordingAnalysis> {
    return this.locks.withLock(recordingId, async () => {
      const record = await this.require(recordingId);
      if (record.analysisConsent === null) {
        throw new Error("this recording has not been analysed yet");
      }
      const events = await this.deps.store.readEvents(recordingId);
      return this.runAnalysis(record, events, feedback);
    });
  }

  private async runAnalysis(
    record: RecordingRecord,
    events: Awaited<ReturnType<RecordingStore["readEvents"]>>,
    feedback?: AnalysisFeedback,
  ): Promise<RecordingAnalysis> {
    const controller = new AbortController();
    this.running.set(record.id, controller);
    await this.update({ ...record, status: "analysing", error: null });

    try {
      this.progress(record.id, "analysing", "reading the narration");
      // Narration is waited for, not raced: a transcript that lands after the
      // analyst has read the timeline explains nothing to anyone.
      const narration = record.hasNarration
        ? await this.deps.narration.ensure(record.id, record.correlationId)
        : null;

      this.progress(record.id, "analysing", "assembling the session bundle");
      const frames = await this.deps.store.readFrames(record.id);
      const startEpoch = new Date(record.startedAt).getTime();
      const bundle = buildBundle({
        recordingId: record.id,
        platform: record.platform,
        appVersion: record.appVersion,
        startEpoch,
        stopEpoch: record.endedAt === null ? null : new Date(record.endedAt).getTime(),
        events,
        frames,
      });
      await this.deps.store.writeBundle(record.id, bundle);

      this.progress(record.id, "analysing", "reconstructing what happened");
      const previous = await this.deps.store.readAnalysis(record.id);
      const analysis = await this.deps.analyst.analyse({
        recordingId: record.id,
        bundle,
        narration,
        correlationId: record.correlationId,
        signal: controller.signal,
        ...(feedback ? { feedback } : {}),
        previous,
      });
      await this.deps.store.writeAnalysis(record.id, analysis);

      await this.update({
        ...record,
        status: "analysed",
        // A recording the user never named takes the analyst's title, so the
        // library reads as a list of tasks rather than a list of timestamps.
        title: record.title || analysis.title,
        narrationTranscribed: narration !== null,
        analysisRevision: analysis.revision,
        analysisApproved: false,
        error: null,
      });

      await this.deps.audit.record({
        actor: this.actor(),
        action: "recording.analysed",
        family: "recording",
        outcome: "succeeded",
        correlationId: record.correlationId,
        resources: [record.id],
        reason: `revision=${analysis.revision} steps=${analysis.steps.length}`,
      });
      return analysis;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.update({ ...record, status: "ready", error: message });
      await this.deps.audit.record({
        actor: this.actor(),
        action: "recording.analysed",
        family: "recording",
        outcome: "failed",
        correlationId: record.correlationId,
        resources: [record.id],
        reason: message,
      });
      throw error;
    } finally {
      this.running.delete(record.id);
    }
  }

  /** Edit the reconstruction by hand. The user is the authority on this. */
  async editAnalysis(input: {
    recordingId: string;
    title?: string;
    intent?: string;
    steps?: AnalysisStep[];
  }): Promise<RecordingAnalysis> {
    const analysis = await this.requireAnalysis(input.recordingId);
    // Editing after approval would let the approved text and the built text
    // diverge, so approval is withdrawn rather than silently carried over.
    const edited: RecordingAnalysis = {
      ...analysis,
      title: input.title ?? analysis.title,
      intent: input.intent ?? analysis.intent,
      steps: input.steps ?? analysis.steps,
      approved: false,
      approvedAt: null,
    };
    await this.deps.store.writeAnalysis(input.recordingId, edited);
    const record = await this.require(input.recordingId);
    await this.update({ ...record, analysisApproved: false });
    return edited;
  }

  /**
   * The user accepts this as what happened, or withdraws that acceptance.
   *
   * A build reads an approved analysis and nothing else. This is the single
   * point where a person takes responsibility for the reconstruction before it
   * is generalised into something that may later run unattended.
   */
  async approveAnalysis(recordingId: string, approved: boolean): Promise<RecordingAnalysis> {
    const record = await this.require(recordingId);
    const analysis = await this.requireAnalysis(recordingId);
    const next: RecordingAnalysis = {
      ...analysis,
      approved,
      approvedAt: approved ? this.now().toISOString() : null,
    };
    await this.deps.store.writeAnalysis(recordingId, next);
    await this.update({ ...record, analysisApproved: approved });
    await this.deps.audit.record({
      actor: this.actor(),
      action: approved ? "recording.analysis_approved" : "recording.analysis_unapproved",
      family: "recording",
      outcome: "succeeded",
      correlationId: record.correlationId,
      resources: [recordingId],
      reason: `revision=${next.revision}`,
    });
    return next;
  }

  // --- build --------------------------------------------------------------

  /** Propose how this becomes a skill or an automation. Writes nothing. */
  async plan(input: {
    recordingId: string;
    kind: BuildKind;
    revise?: string;
  }): Promise<RecordingPlan> {
    return this.locks.withLock(input.recordingId, async () => {
      const record = await this.require(input.recordingId);
      const analysis = await this.requireAnalysis(input.recordingId);
      if (!analysis.approved) {
        throw new Error("approve the reconstruction before building anything from it");
      }

      const controller = new AbortController();
      this.running.set(record.id, controller);
      try {
        this.progress(record.id, "planning", "working out what generalises");
        const plan = await this.deps.builder.plan({
          recordingId: record.id,
          kind: input.kind,
          analysis,
          correlationId: record.correlationId,
          signal: controller.signal,
          ...(input.revise ? { revise: input.revise } : {}),
          previous: this.plans.get(record.id) ?? null,
        });
        this.plans.set(record.id, plan);
        return plan;
      } finally {
        this.running.delete(record.id);
      }
    });
  }

  /** Replace the proposed plan with the user's edited one. */
  editPlan(recordingId: string, plan: RecordingPlan): RecordingPlan {
    this.plans.set(recordingId, plan);
    return plan;
  }

  /**
   * Refine the current proposal in natural language.
   *
   * The kind comes from the plan already on the table rather than from the
   * caller, so "make it run every Monday" refines the automation it was asked
   * about instead of quietly re-targeting a skill at the scheduler.
   */
  replan(recordingId: string, feedback: string): Promise<RecordingPlan> {
    const current = this.plans.get(recordingId);
    if (!current) throw new Error("propose a plan before refining it");
    return this.plan({ recordingId, kind: current.kind, revise: feedback });
  }

  /**
   * Write the artifact.
   *
   * Neither output is live when this returns. A skill becomes a *proposal* in
   * the staging area, and an automation becomes a **disabled** job. Something
   * reconstructed by a model from a recording of one afternoon should not start
   * running on a schedule because a dialog was dismissed.
   */
  async buildFrom(input: { recordingId: string; plan?: RecordingPlan }): Promise<RecordingBuild> {
    return this.locks.withLock(input.recordingId, async () => {
      const record = await this.require(input.recordingId);
      const analysis = await this.requireAnalysis(input.recordingId);
      if (!analysis.approved) {
        throw new Error("approve the reconstruction before building anything from it");
      }
      const plan = input.plan ?? this.plans.get(input.recordingId);
      if (!plan) throw new Error("propose a plan before building");

      const controller = new AbortController();
      this.running.set(record.id, controller);
      try {
        this.progress(record.id, "building", "writing the procedure");
        const submission = await this.deps.builder.build({
          recordingId: record.id,
          plan,
          correlationId: record.correlationId,
          signal: controller.signal,
        });

        const sessionId = `recording-build-${record.id}`;
        const built = RecordingBuild.parse({
          version: 1,
          recordingId: record.id,
          kind: plan.kind,
          name: submission.name,
          description: submission.description,
          allowedTools: submission.allowedTools,
          body: submission.body,
          values: plan.values,
          plan,
          createdAt: this.now().toISOString(),
          sessionId,
        });

        const settled =
          plan.kind === "skill"
            ? await this.proposeSkill(record, built, sessionId)
            : await this.scheduleJob(record, built, plan);

        await this.deps.store.writeBuild(record.id, settled);
        await this.update({
          ...record,
          builtSkillName: settled.skillName,
          builtJobId: settled.jobId,
        });
        return settled;
      } finally {
        this.running.delete(record.id);
      }
    });
  }

  private async proposeSkill(
    record: RecordingRecord,
    built: RecordingBuild,
    sessionId: string,
  ): Promise<RecordingBuild> {
    await this.deps.skills.propose(
      {
        name: built.name,
        description: built.description,
        // Values are substituted here, deterministically, rather than by the
        // model: exactly one thing should decide what a named constant expands
        // to, and it should not be something that occasionally improvises.
        body: renderValues(built.body, built.values),
        allowedTools: built.allowedTools,
        sourceSessionId: sessionId,
        sourceTurnId: sessionId,
        rationale: `Recorded on ${record.startedAt} and reconstructed from a screen recording.`,
      },
      record.correlationId,
    );
    await this.deps.audit.record({
      actor: this.actor(),
      action: "recording.skill_proposed",
      family: "recording",
      outcome: "succeeded",
      correlationId: record.correlationId,
      resources: [record.id, built.name],
    });
    return { ...built, skillName: built.name };
  }

  private async scheduleJob(
    record: RecordingRecord,
    built: RecordingBuild,
    plan: RecordingPlan,
  ): Promise<RecordingBuild> {
    const job = await this.deps.scheduler.createJob({
      name: plan.title,
      objective: renderValues(
        [built.description, "", built.body].join("\n"),
        built.values,
      ),
      trigger: plan.trigger ?? { kind: "manual" },
      // Disabled. The user turns it on from Automations, having read what it
      // will do, rather than discovering it ran overnight.
      enabled: false,
      toolFamilies: built.allowedTools,
      skills: [],
    });
    await this.deps.audit.record({
      actor: this.actor(),
      action: "recording.automation_created",
      family: "recording",
      outcome: "succeeded",
      correlationId: record.correlationId,
      resources: [record.id, job.id],
      reason: `trigger=${job.trigger.kind} enabled=false`,
    });
    return { ...built, jobId: job.id };
  }

  // --- housekeeping -------------------------------------------------------

  async reconcileOnBoot(): Promise<void> {
    const closed = await this.deps.controller.reconcileOnBoot();
    if (closed > 0) {
      this.deps.logger.info("closed recordings interrupted by a restart", { count: closed });
    }
  }

  private async require(recordingId: string): Promise<RecordingRecord> {
    const record = await this.deps.store.get(recordingId);
    if (record === null) throw new Error(`no such recording: ${recordingId}`);
    return record;
  }

  private async requireAnalysis(recordingId: string): Promise<RecordingAnalysis> {
    const analysis = await this.deps.store.readAnalysis(recordingId);
    if (analysis === null) throw new Error("this recording has not been analysed yet");
    return analysis;
  }

  private async update(record: RecordingRecord): Promise<void> {
    await this.deps.store.save(record);
    this.deps.publish(record);
  }

  private progress(recordingId: string, phase: RecordingProgress["phase"], message: string): void {
    this.deps.publishProgress({ recordingId, phase, message });
  }

  private actor(): { kind: "user"; oid: string; tenantId: string } | { kind: "system" } {
    const account = this.deps.currentAccount();
    return account
      ? { kind: "user", oid: account.oid, tenantId: account.tenantId }
      : { kind: "system" };
  }
}
