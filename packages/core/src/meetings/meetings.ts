import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import {
  IMPORTABLE_MEDIA_EXTENSIONS,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_DURATION_MS,
  MeetingRecord,
  MIN_TRANSCRIBABLE_BYTES,
  RECORDING_NOTICE_VERSION,
  RecordingConsent,
  TranscriptSegment,
  newCorrelationId,
  newMeetingId,
  noticeTextFor,
  type AudioSource,
  type MeetingTranscript,
  type TranscriptionEngine,
  type TranscriptionResult,
} from "@iq/shared";
import { appendJsonl, readJson, readJsonl, writeJsonAtomic } from "../util/jsonl.js";
import { KeyedMutex } from "../util/lock.js";
import type { AppPaths } from "../config/paths.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { Logger } from "../util/logger.js";
import type { SpeechService } from "../speech/speech.js";
import type { FfmpegService } from "../media/ffmpeg.js";
import type { WhisperService } from "../media/whisper.js";
import type { AudioCapture, AudioSidecar } from "../media/audio.js";

/**
 * Meeting capture, transcription and notes.
 *
 * Consent is the spine of this service rather than a checkbox in front of it.
 * The backlog held this back for one reason: it "would require an explicit
 * recording-consent design" (docs/02-backlog.md row 31), so the design
 * makes consent explicit at every boundary:
 *
 *  - `start()` refuses without a signed-in Entra identity, the current notice
 *    version and an explicit `participantsInformed`. There is no code path that
 *    begins capture without a stored `RecordingConsent`.
 *  - The consent, including who acknowledged it, is written to the audit log
 *    before the first byte of audio is accepted, and the refusal is audited too.
 *  - Audio is deleted as soon as a transcript exists unless retention was
 *    explicitly requested. The transcript is what the product needs; the audio
 *    is the more sensitive artefact and is not kept "just in case".
 *
 * Two engines produce transcripts and the choice is the user's, not this
 * service's: Azure AI Speech sends the audio to the tenant's resource, Local
 * Whisper keeps it on the device. The consent names the engine and the meeting
 * records it, because "was this room's audio uploaded?" is a question someone
 * will ask about a specific meeting months later, and a service-wide default
 * cannot answer it.
 *
 * Storage mirrors the rest of the app: a small mutable index rewritten
 * atomically, and append-only files for anything that only grows.
 *
 * The recording itself is the exception, and deliberately so. The renderer used
 * to capture with `MediaRecorder` and hand over a chunk every few seconds for
 * this service to append; it cannot capture system output on Windows, so
 * "record the other participants" recorded silence. Capture now runs in the
 * `iq-audio` sidecar, which writes the WAV directly and is the only thing that
 * touches it. The cost of that is a header that is only correct once the
 * sidecar finalises the file — see {@link repairWavHeader}.
 */

/**
 * How often a live recording's size is re-read from disk.
 *
 * The same cadence the renderer's chunks used to arrive at, for the same
 * reason: every update rewrites the meetings index.
 */
const AUDIO_MEASURE_INTERVAL_MS = 5_000;

export interface MeetingsDeps {
  paths: AppPaths;
  speech: SpeechService;
  /** Local transcription. Its own readiness is reported, never assumed. */
  whisper: WhisperService;
  /**
   * The native capture sidecar. It records the audio and owns the file.
   *
   * Its readiness is reported separately so the surface can disable system
   * audio with a reason instead of offering a source that records silence.
   */
  audio: AudioSidecar;
  /** Container work: MP4 to MP3 for uploads, and duration probing for imports. */
  ffmpeg: FfmpegService;
  /** The engine a new capture starts with, from media settings. */
  defaultEngine: () => TranscriptionEngine;
  /**
   * The bound project root, or null when none is bound.
   *
   * A recording is a work artifact, so it belongs with the user's other work
   * rather than in an application data directory. Injected the same way
   * {@link ImageService} takes it, so this service still knows nothing about
   * the project registry.
   */
  projectDir: () => string | null;
  audit: AuditLog;
  logger: Logger;
  publish: (meeting: MeetingRecord) => void;
  /** The signed-in user. Null blocks capture: consent must be attributable. */
  currentAccount: () => { oid: string; tenantId: string; username: string } | null;
  /**
   * Runs the note-writing turn. Injected so this service stays free of the
   * agent runtime, in the same way the scheduler is.
   */
  writeNotes: (input: {
    meeting: MeetingRecord;
    transcript: MeetingTranscript;
    signal?: AbortSignal;
  }) => Promise<{ body: string; sessionId: string }>;
  now?: () => Date;
}

export class MeetingsStore {
  constructor(private readonly paths: AppPaths) {}

  private get indexFile(): string {
    return join(this.paths.meetings, "meetings.json");
  }

  dir(meetingId: string): string {
    return join(this.paths.meetings, meetingId);
  }

  audioFile(meetingId: string): string {
    return join(this.dir(meetingId), "audio.wav");
  }

  transcriptFile(meetingId: string): string {
    return join(this.dir(meetingId), "transcript.jsonl");
  }

  notesFile(meetingId: string): string {
    return join(this.dir(meetingId), "notes.md");
  }

  async list(): Promise<MeetingRecord[]> {
    const raw = await readJson<unknown>(this.indexFile, []);
    if (!Array.isArray(raw)) return [];
    const out: MeetingRecord[] = [];
    for (const entry of raw) {
      const parsed = MeetingRecord.safeParse(entry);
      if (parsed.success) out.push(parsed.data);
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async get(meetingId: string): Promise<MeetingRecord | null> {
    return (await this.list()).find((entry) => entry.id === meetingId) ?? null;
  }

  async save(meeting: MeetingRecord): Promise<void> {
    const all = await this.list();
    const index = all.findIndex((entry) => entry.id === meeting.id);
    if (index >= 0) all[index] = meeting;
    else all.push(meeting);
    await writeJsonAtomic(this.indexFile, all);
  }

  async remove(meetingId: string): Promise<void> {
    await writeJsonAtomic(
      this.indexFile,
      (await this.list()).filter((entry) => entry.id !== meetingId),
    );
    await rm(this.dir(meetingId), { recursive: true, force: true });
  }
}

export class MeetingsService {
  private readonly store: MeetingsStore;
  /** Serialises transcription and note runs per meeting. */
  private readonly lock = new KeyedMutex();
  /** Captures in flight, by meeting. Empty between recordings. */
  private readonly captures = new Map<string, AudioCapture>();
  /** When each meeting's `audioBytes` was last read from disk. */
  private readonly lastMeasured = new Map<string, number>();

  constructor(private readonly deps: MeetingsDeps) {
    this.store = new MeetingsStore(deps.paths);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * What a user must acknowledge, and whether capture is possible at all.
   *
   * Both engines are reported, not just the default one: the picker has to be
   * able to say *why* Local Whisper is unavailable while offering Azure, and a
   * status that only described the current choice would make the other option
   * look broken for no stated reason.
   */
  async notice(engine?: TranscriptionEngine): Promise<{
    version: string;
    engine: TranscriptionEngine;
    text: string;
    speech: ReturnType<SpeechService["status"]>;
    whisper: { ready: boolean; message: string };
    /**
     * Whether the capture sidecar is present.
     *
     * It used to gate one source: a browser engine cannot capture system
     * output on Windows, so "the other participants" needed `iq-audio` while a
     * microphone did not. The sidecar now records both, so this gates the
     * recorder as well and is folded into `blocked`. It stays a field of its
     * own because the source tick still needs its own reason.
     */
    systemAudio: { ready: boolean; message: string };
    signedIn: boolean;
    /** Why a recording cannot be made right now, or "" when it can. */
    blocked: string;
  }> {
    const chosen = engine ?? this.deps.defaultEngine();
    const speech = this.deps.speech.status();
    const whisper = await this.deps.whisper.readiness();
    const systemAudio = await this.deps.audio.readiness();
    const engineBlocked =
      chosen === "whisper"
        ? whisper.ready
          ? ""
          : whisper.message
        : speech.state === "ready"
          ? ""
          : speech.message;
    // The engine is named first: it is the choice the user just made, and
    // fixing the recorder is no use if the transcript still cannot be produced.
    const blocked = engineBlocked || (systemAudio.ready ? "" : systemAudio.message);

    return {
      version: RECORDING_NOTICE_VERSION,
      engine: chosen,
      text: noticeTextFor(chosen),
      speech,
      whisper,
      systemAudio,
      signedIn: this.deps.currentAccount() !== null,
      blocked,
    };
  }

  list(): Promise<MeetingRecord[]> {
    return this.store.list();
  }

  get(meetingId: string): Promise<MeetingRecord | null> {
    return this.store.get(meetingId);
  }

  private async publish(meeting: MeetingRecord): Promise<MeetingRecord> {
    await this.store.save(meeting);
    this.deps.publish(meeting);
    return meeting;
  }

  private async requireMeeting(meetingId: string): Promise<MeetingRecord> {
    const meeting = await this.store.get(meetingId);
    if (!meeting) throw new Error(`unknown meeting ${meetingId}`);
    return meeting;
  }

  /**
   * Where a meeting's audio actually is.
   *
   * Read from the record rather than derived from the current project: a
   * recording made in one project must still be findable after the user binds
   * another, and every reader here — transcribe, retry, discard, the boot
   * repair — has to agree with whatever the capture chose. An empty field is a
   * meeting recorded before captures went to the project, which is why the
   * old location is the fallback rather than an error.
   */
  private audioPath(meeting: MeetingRecord): string {
    return meeting.audioFile || this.store.audioFile(meeting.id);
  }

  /**
   * Where a new capture should be written.
   *
   * Inside the bound project when there is one, under `meetings/`, named for
   * the day and the title so the directory is readable without opening
   * anything. Falls back to the app's own meeting directory when no project
   * is bound — a recording must not be refused for want of one, because the
   * consent has already been given and the meeting is already happening.
   */
  private async captureTarget(
    meetingId: string,
    title: string,
    startedAt: string,
  ): Promise<{ audioFile: string; audioProjectPath: string }> {
    const root = this.deps.projectDir();
    if (root === null) {
      return { audioFile: this.store.audioFile(meetingId), audioProjectPath: "" };
    }
    const stem = `${startedAt.slice(0, 10)}-${slug(title)}-${meetingId.slice(-6)}`;
    // Always spelled with `/`: a project-relative path is what the navigator
    // and every other reader match on, and a bare `join` gives `meetings\x` on
    // Windows, which silently matches nothing.
    const relative = `meetings/${stem}.wav`;
    const absolute = join(root, "meetings", `${stem}.wav`);
    await mkdir(dirname(absolute), { recursive: true });
    return { audioFile: absolute, audioProjectPath: relative };
  }

  // --- capture -------------------------------------------------------------

  /**
   * Begin a capture.
   *
   * Every refusal is audited, not just logged: a record that someone tried to
   * record without acknowledging the notice is exactly the sort of thing an
   * investigation needs, and it costs one line.
   */
  async start(input: {
    title: string;
    sources: AudioSource[];
    noticeVersion: string;
    participantsInformed: true;
    engine?: TranscriptionEngine;
    retainAudio?: boolean;
    calendarEventId?: string;
  }): Promise<MeetingRecord> {
    const correlationId = newCorrelationId();
    const account = this.deps.currentAccount();
    const engine = input.engine ?? this.deps.defaultEngine();

    const refuse = async (reason: string): Promise<Error> => {
      await this.deps.audit.record({
        actor: account
          ? { kind: "user", oid: account.oid, tenantId: account.tenantId }
          : { kind: "system" },
        action: "meeting.capture_refused",
        family: "meetings",
        outcome: "denied",
        correlationId,
        reason,
      });
      return new Error(reason);
    };

    if (!account) {
      throw await refuse(
        "recording requires a signed-in Microsoft 365 account, so the consent is attributable",
      );
    }
    if (input.noticeVersion !== RECORDING_NOTICE_VERSION) {
      throw await refuse(
        `the recording notice has changed (acknowledged ${input.noticeVersion}, current ${RECORDING_NOTICE_VERSION}); read it again before recording`,
      );
    }
    if (input.participantsInformed !== true) {
      throw await refuse("recording requires confirming that every participant has been informed");
    }
    if (input.sources.length === 0) {
      throw await refuse("recording requires at least one audio source");
    }

    // Capturing audio we could never transcribe would collect the sensitive
    // artefact and deliver none of the value. Which check applies depends on
    // the engine, because the two have entirely different prerequisites.
    const readiness = await this.engineReadiness(engine);
    if (!readiness.ready) throw await refuse(readiness.message);

    const startedAt = this.now().toISOString();
    const consent = RecordingConsent.parse({
      noticeVersion: RECORDING_NOTICE_VERSION,
      acknowledgedByOid: account.oid,
      acknowledgedByTenantId: account.tenantId,
      acknowledgedByUsername: account.username,
      acknowledgedAt: startedAt,
      participantsInformed: true,
      sources: input.sources,
      engine,
      retainAudio: input.retainAudio ?? false,
    });

    const meetingId = newMeetingId();
    const target = await this.captureTarget(meetingId, input.title.trim(), startedAt);

    const meeting = MeetingRecord.parse({
      id: meetingId,
      title: input.title.trim(),
      status: "recording",
      consent,
      engine,
      origin: "capture",
      sourceFile: "",
      audioFile: target.audioFile,
      audioProjectPath: target.audioProjectPath,
      recordingId: null,
      calendarEventId: input.calendarEventId ?? null,
      startedAt,
      endedAt: null,
      audioBytes: 0,
      audioRetained: true,
      durationMs: 0,
      segmentCount: 0,
      locale: this.deps.speech.defaultLocale,
      notesSessionId: null,
      notesUpdatedAt: null,
      error: null,
      correlationId,
    });

    await mkdir(this.store.dir(meeting.id), { recursive: true });

    // The sidecar owns the file from here. It is started *before* the meeting
    // is published so that a device already held by another application fails
    // now, with its own message, rather than leaving a row that says
    // "recording" over an hour of nothing.
    try {
      this.captures.set(
        meeting.id,
        await this.deps.audio.start({
          out: this.audioPath(meeting),
          microphone: input.sources.includes("microphone") ? "default" : undefined,
          system: input.sources.includes("system"),
          onLevel: () => void this.measure(meeting.id),
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await rm(this.store.dir(meeting.id), { recursive: true, force: true });
      await this.deps.audit.record({
        actor: { kind: "user", oid: account.oid, tenantId: account.tenantId },
        action: "meeting.capture_started",
        family: "meetings",
        outcome: "failed",
        correlationId,
        resources: [meeting.id],
        reason: message,
      });
      throw new Error(`the capture could not be started: ${message}`);
    }

    await this.deps.audit.record({
      actor: { kind: "user", oid: account.oid, tenantId: account.tenantId },
      action: "meeting.capture_started",
      family: "meetings",
      outcome: "allowed",
      correlationId,
      resources: [meeting.id],
      reason: `notice ${RECORDING_NOTICE_VERSION} acknowledged by ${account.username}; engine ${engine}; sources ${input.sources.join(
        "+",
      )}; audio ${consent.retainAudio ? "retained" : "discarded after transcription"}`,
    });

    return this.publish(meeting);
  }

  /** Whether an engine could produce a transcript right now, and why not. */
  private async engineReadiness(
    engine: TranscriptionEngine,
  ): Promise<{ ready: boolean; message: string }> {
    if (engine === "whisper") return this.deps.whisper.readiness();
    const speech = this.deps.speech.status();
    return speech.state === "ready"
      ? { ready: true, message: "" }
      : { ready: false, message: speech.message };
  }

  /**
   * Produce a transcript from a file with whichever engine was chosen.
   *
   * The single place the engine branch lives. A live capture and an imported
   * file reach it by different routes but must not differ in *where the audio
   * goes*, and one branch is far easier to keep honest than three.
   */
  private async transcribeWith(input: {
    engine: TranscriptionEngine;
    path: string;
    mimeType: string;
    locale: string;
    correlationId: string;
    diarize: boolean;
  }): Promise<TranscriptionResult> {
    if (input.engine === "whisper") {
      return this.deps.whisper.transcribeFile({
        mediaPath: input.path,
        locale: input.locale,
        correlationId: input.correlationId,
      });
    }
    const audio = await readFile(input.path);
    return this.deps.speech.transcribe({
      audio,
      mimeType: input.mimeType,
      diarize: input.diarize,
      correlationId: input.correlationId,
    });
  }

  /**
   * Bring a recording's `audioBytes` up to date from the file on disk.
   *
   * The renderer used to hand over a chunk every few seconds and this service
   * added its length to the record, which made `audioBytes` a running total it
   * maintained itself. Nothing appends any more, so the file is the only thing
   * that knows how big it is.
   *
   * Called from the sidecar's level events rather than a timer of its own, and
   * throttled to the cadence the old chunks arrived at: every publish rewrites
   * the index atomically, and doing that ten times a second for an hour is not
   * a live byte counter, it is a disk load. A failure here is swallowed on
   * purpose — the number that decides anything is taken again at stop.
   */
  private async measure(meetingId: string): Promise<void> {
    const now = Date.now();
    if (now - (this.lastMeasured.get(meetingId) ?? 0) < AUDIO_MEASURE_INTERVAL_MS) return;
    this.lastMeasured.set(meetingId, now);
    try {
      const meeting = await this.store.get(meetingId);
      if (!meeting || meeting.status !== "recording") return;
      const audioBytes = await fileBytes(this.audioPath(meeting));
      if (audioBytes === meeting.audioBytes) return;
      await this.publish({ ...meeting, audioBytes });
    } catch {
      // Not worth failing a recording over.
    }
  }

  /**
   * Stop the capture and transcribe.
   *
   * Safe to call twice: a meeting that is no longer recording is returned as-is
   * rather than re-transcribed, so a duplicated "stop" from a closing window
   * cannot send the same audio to Azure a second time.
   */
  async stop(meetingId: string): Promise<MeetingRecord> {
    return this.lock.withLock(`stop:${meetingId}`, async () => {
      const meeting = await this.requireMeeting(meetingId);
      if (meeting.status !== "recording") return meeting;

      const capture = this.captures.get(meetingId);
      this.captures.delete(meetingId);
      this.lastMeasured.delete(meetingId);

      // Stopping is also what finalises the WAV: the header carries the sample
      // count and is only correct once the sidecar has rewritten it, so nothing
      // may read the file before this returns.
      let captured: { durationMs: number; bytes: number } | null = null;
      if (capture) {
        try {
          captured = await capture.stop();
        } catch (error) {
          this.deps.logger.warn("iq-audio did not finish cleanly", {
            meetingId,
            error: error instanceof Error ? error.message : String(error),
          });
          // Whatever reached disk is still there; it is only the header that
          // never got its sizes. Repaired here for the same reason the boot
          // reconciler repairs it — the samples are not the part that broke.
          await repairWavHeader(this.audioPath(meeting));
        }
      }

      const endedAt = this.now().toISOString();
      const wallClockMs = Math.max(0, Date.parse(endedAt) - Date.parse(meeting.startedAt));
      // The sidecar's clock is the one the file was written against, so it is
      // preferred: it and the file agree by construction.
      const durationMs = captured && captured.durationMs > 0 ? captured.durationMs : wallClockMs;
      const audioBytes = await fileBytes(this.audioPath(meeting));

      if (audioBytes < MIN_TRANSCRIBABLE_BYTES) {
        await this.deps.audit.record({
          actor: { kind: "system" },
          action: "meeting.capture_stopped",
          family: "meetings",
          outcome: "failed",
          correlationId: meeting.correlationId,
          resources: [meeting.id],
          reason: `only ${audioBytes} bytes captured; nothing to transcribe`,
        });
        await rm(this.audioPath(meeting), { force: true });
        return this.publish({
          ...meeting,
          status: "failed",
          endedAt,
          durationMs,
          audioBytes,
          audioRetained: false,
          // Not "no audio was captured": the capture writes silence for a
          // silent source, so a file this small means the recording was this
          // short. A quiet meeting produces a full-length file and a thin
          // transcript, which is a different thing to say.
          error:
            audioBytes === 0
              ? "no audio file was produced; the capture did not run"
              : "the recording was too short to transcribe",
        });
      }

      const stopping = await this.publish({
        ...meeting,
        status: "transcribing",
        endedAt,
        durationMs,
        audioBytes,
      });

      await this.deps.audit.record({
        actor: { kind: "system" },
        action: "meeting.capture_stopped",
        family: "meetings",
        outcome: "succeeded",
        correlationId: meeting.correlationId,
        resources: [meeting.id],
        reason: `${audioBytes} bytes over ${Math.round(durationMs / 1000)}s`,
      });

      try {
        const result = await this.transcribeWith({
          engine: stopping.engine,
          path: this.audioPath(stopping),
          mimeType: "audio/wav",
          locale: stopping.locale,
          diarize: true,
          correlationId: stopping.correlationId,
        });

        await writeFile(this.store.transcriptFile(meetingId), "", "utf8");
        await appendJsonl(this.store.transcriptFile(meetingId), result.segments);

        // Retention is a decision the user already made at consent time; it is
        // applied here rather than left to a cleanup job that might not run.
        let audioRetained = stopping.consent.retainAudio;
        if (!audioRetained) {
          await rm(this.audioPath(stopping), { force: true });
          await this.deps.audit.record({
            actor: { kind: "system" },
            action: "meeting.audio_discarded",
            family: "meetings",
            outcome: "succeeded",
            correlationId: stopping.correlationId,
            resources: [meeting.id],
            reason: "audio discarded after transcription, as consented",
          });
        }

        return this.publish({
          ...stopping,
          status: "transcribed",
          segmentCount: result.segments.length,
          locale: result.locale,
          durationMs: result.durationMs > 0 ? result.durationMs : durationMs,
          audioRetained,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.logger.warn("meeting transcription failed", { meetingId, error: message });
        await this.deps.audit.record({
          actor: { kind: "system" },
          action: "meeting.transcribe",
          family: "meetings",
          outcome: "failed",
          correlationId: stopping.correlationId,
          resources: [meeting.id],
          reason: message,
        });
        // Keep audio on failure regardless of the retention choice, so the
        // captured evidence is not lost with the failed transcription.
        return this.publish({ ...stopping, status: "failed", error: message });
      }
    });
  }

  // --- imports -------------------------------------------------------------

  /**
   * Transcribe a media file the user already has.
   *
   * Meetly Lite's batch path: "transcribe one WAV, MP3, or MP4 file up to
   * 250 MB and two hours", with "MP4 audio extracted locally as MP3 before
   * upload" (meetly-lite/README.md). Both limits are enforced here rather than
   * left to Azure, because discovering a size cap as a 413 after uploading
   * 250 MB over a hotel connection is not a failure mode worth shipping.
   *
   * The user's file is never copied, moved or deleted. It is read, and — for a
   * video — reduced to audio in scratch space that is removed afterwards. That
   * is why an import's `audioRetained` is false and `discardAudio` is a no-op
   * for one: there is no app-owned audio to discard, and deleting the user's
   * own file because they asked to tidy a transcript would be indefensible.
   *
   * Consent is still required and still names the engine. The audio is someone
   * else's voice whether this app recorded it or not.
   */
  async importFile(input: {
    path: string;
    title?: string;
    noticeVersion: string;
    participantsInformed: true;
    engine?: TranscriptionEngine;
    locale?: string;
    /** Set when the file is one of this app's own screen recordings. */
    recordingId?: string;
  }): Promise<MeetingRecord> {
    const correlationId = newCorrelationId();
    const account = this.deps.currentAccount();
    const engine = input.engine ?? this.deps.defaultEngine();

    const refuse = async (reason: string): Promise<Error> => {
      await this.deps.audit.record({
        actor: account
          ? { kind: "user", oid: account.oid, tenantId: account.tenantId }
          : { kind: "system" },
        action: "meeting.capture_refused",
        family: "meetings",
        outcome: "denied",
        correlationId,
        reason,
      });
      return new Error(reason);
    };

    if (!account) {
      throw await refuse(
        "transcribing a recording requires a signed-in Microsoft 365 account, so the consent is attributable",
      );
    }
    if (input.noticeVersion !== RECORDING_NOTICE_VERSION) {
      throw await refuse(
        `the recording notice has changed (acknowledged ${input.noticeVersion}, current ${RECORDING_NOTICE_VERSION}); read it again before transcribing`,
      );
    }
    if (input.participantsInformed !== true) {
      throw await refuse("transcribing requires confirming that every participant has been informed");
    }

    const extension = extname(input.path).toLowerCase();
    if (!(IMPORTABLE_MEDIA_EXTENSIONS as readonly string[]).includes(extension)) {
      throw await refuse(
        `${extension || "this file"} cannot be transcribed; choose one of ${IMPORTABLE_MEDIA_EXTENSIONS.join(", ")}`,
      );
    }

    let bytes: number;
    try {
      bytes = (await stat(input.path)).size;
    } catch {
      throw await refuse(`there is no file at ${input.path}`);
    }
    if (bytes > MAX_IMPORT_BYTES) {
      throw await refuse(
        `${(bytes / (1024 * 1024)).toFixed(0)} MB is over the ${MAX_IMPORT_BYTES / (1024 * 1024)} MB limit for one transcription`,
      );
    }

    const readiness = await this.engineReadiness(engine);
    if (!readiness.ready) throw await refuse(readiness.message);

    // Duration is best-effort: without ffprobe there is no way to ask, and
    // refusing every import because a helper binary is absent would be worse
    // than letting the service enforce its own cap.
    const probedMs = await this.deps.ffmpeg.durationMs(input.path).catch(() => 0);
    if (probedMs > MAX_IMPORT_DURATION_MS) {
      throw await refuse(
        `${Math.round(probedMs / 60_000)} minutes is over the ${MAX_IMPORT_DURATION_MS / 3_600_000}-hour limit for one transcription`,
      );
    }

    const startedAt = this.now().toISOString();
    const consent = RecordingConsent.parse({
      noticeVersion: RECORDING_NOTICE_VERSION,
      acknowledgedByOid: account.oid,
      acknowledgedByTenantId: account.tenantId,
      acknowledgedByUsername: account.username,
      acknowledgedAt: startedAt,
      participantsInformed: true,
      // An import has no live source; the file is the source.
      sources: ["system"],
      engine,
      retainAudio: false,
    });

    const meeting = MeetingRecord.parse({
      id: newMeetingId(),
      title: (input.title ?? "").trim() || basenameOf(input.path),
      status: "transcribing",
      consent,
      engine,
      origin: "import",
      sourceFile: input.path,
      recordingId: input.recordingId ?? null,
      calendarEventId: null,
      startedAt,
      endedAt: startedAt,
      audioBytes: bytes,
      audioRetained: false,
      durationMs: probedMs,
      segmentCount: 0,
      locale: input.locale ?? this.deps.speech.defaultLocale,
      notesSessionId: null,
      notesUpdatedAt: null,
      error: null,
      correlationId,
    });

    await mkdir(this.store.dir(meeting.id), { recursive: true });
    const pending = await this.publish(meeting);

    await this.deps.audit.record({
      actor: { kind: "user", oid: account.oid, tenantId: account.tenantId },
      action: "meeting.file_imported",
      family: "meetings",
      outcome: "allowed",
      correlationId,
      resources: [meeting.id],
      reason: `notice ${RECORDING_NOTICE_VERSION} acknowledged by ${account.username}; engine ${engine}; ${(
        bytes /
        (1024 * 1024)
      ).toFixed(1)} MB ${extension} file`,
    });

    return this.lock.withLock(`stop:${meeting.id}`, async () => {
      // Video goes to Azure as MP3, never as MP4: it is an order of magnitude
      // smaller and the picture is the more revealing artefact of the two.
      const needsExtraction = engine === "azure" && (extension === ".mp4" || extension === ".m4a");
      const scratch = needsExtraction
        ? this.deps.ffmpeg.scratchPath(`import-${meeting.id}.mp3`)
        : null;

      try {
        if (scratch !== null) await this.deps.ffmpeg.extractMp3(input.path, scratch);

        const result = await this.transcribeWith({
          engine,
          path: scratch ?? input.path,
          mimeType: mimeFor(scratch === null ? extension : ".mp3"),
          locale: pending.locale,
          diarize: true,
          correlationId,
        });

        await writeFile(this.store.transcriptFile(meeting.id), "", "utf8");
        await appendJsonl(this.store.transcriptFile(meeting.id), result.segments);

        return this.publish({
          ...pending,
          status: "transcribed",
          segmentCount: result.segments.length,
          locale: result.locale,
          durationMs: result.durationMs > 0 ? result.durationMs : pending.durationMs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.logger.warn("imported transcription failed", { meetingId: meeting.id, error: message });
        await this.deps.audit.record({
          actor: { kind: "system" },
          action: "meeting.transcribe",
          family: "meetings",
          outcome: "failed",
          correlationId,
          resources: [meeting.id],
          reason: message,
        });
        return this.publish({ ...pending, status: "failed", error: message });
      } finally {
        if (scratch !== null) await rm(scratch, { force: true });
      }
    });
  }

  // --- transcript and notes -----------------------------------------------

  async transcript(meetingId: string): Promise<MeetingTranscript> {
    const meeting = await this.requireMeeting(meetingId);
    const segments: TranscriptSegment[] = [];
    for (const row of await readJsonl(this.store.transcriptFile(meetingId))) {
      const parsed = TranscriptSegment.safeParse(row);
      if (parsed.success) segments.push(parsed.data);
    }
    return {
      meetingId,
      locale: meeting.locale,
      durationMs: meeting.durationMs,
      segments,
    };
  }

  async notes(meetingId: string): Promise<string | null> {
    try {
      return await readFile(this.store.notesFile(meetingId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * Turn the transcript into notes with an agent turn.
   *
   * The transcript is meeting participants' words, so it is untrusted input in
   * exactly the sense the M365 tools mean: the prompt says so explicitly, and
   * the note-writing session is a fresh one that has no tool families at all,
   * so a transcript that asks the agent to send mail has nothing to send it
   * with.
   */
  async generateNotes(meetingId: string): Promise<MeetingRecord> {
    return this.lock.withLock(`notes:${meetingId}`, async () => {
      const meeting = await this.requireMeeting(meetingId);
      if (meeting.status === "recording" || meeting.status === "transcribing") {
        throw new Error("wait for the transcript before generating notes");
      }

      const transcript = await this.transcript(meetingId);
      if (transcript.segments.length === 0) {
        throw new Error("this meeting has no transcript to write notes from");
      }

      const pending = await this.publish({ ...meeting, status: "notes_pending", error: null });

      try {
        const { body, sessionId } = await this.deps.writeNotes({ meeting: pending, transcript });
        await writeFile(this.store.notesFile(meetingId), body, "utf8");

        await this.deps.audit.record({
          actor: { kind: "agent", sessionId, turnId: sessionId },
          action: "meeting.notes_written",
          family: "meetings",
          outcome: "succeeded",
          correlationId: pending.correlationId,
          resources: [meetingId],
          reason: `${body.length} characters from ${transcript.segments.length} segments`,
        });

        return this.publish({
          ...pending,
          status: "ready",
          notesSessionId: sessionId,
          notesUpdatedAt: this.now().toISOString(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.deps.audit.record({
          actor: { kind: "system" },
          action: "meeting.notes_written",
          family: "meetings",
          outcome: "failed",
          correlationId: pending.correlationId,
          resources: [meetingId],
          reason: message,
        });
        // Back to "transcribed", not "failed": the transcript is intact and the
        // notes can be asked for again.
        return this.publish({ ...pending, status: "transcribed", error: message });
      }
    });
  }

  // --- retention -----------------------------------------------------------

  /** Delete the audio, keeping the transcript and notes. */
  async discardAudio(meetingId: string): Promise<MeetingRecord> {
    const meeting = await this.requireMeeting(meetingId);
    // An import's audio is the user's own file, sitting where they put it. This
    // app read it; it does not own it, and must not delete it to satisfy a
    // control that means "tidy up after yourself".
    if (meeting.origin === "import") return meeting;

    await rm(this.audioPath(meeting), { force: true });
    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "meeting.audio_discarded",
      family: "meetings",
      outcome: "succeeded",
      correlationId: meeting.correlationId,
      resources: [meetingId],
      reason: "audio deleted on request",
    });
    return this.publish({ ...meeting, audioRetained: false });
  }

  /** Delete the recording, its transcript and its notes. */
  async delete(meetingId: string): Promise<void> {
    const meeting = await this.requireMeeting(meetingId);
    // The audio first, and separately, because it is not always in the store.
    // A capture made with a project bound is written into that project by
    // `captureTarget`, so removing the store directory alone left the WAV on
    // disk — the one thing "Delete" is asked to get rid of. An import's
    // `sourceFile` is never touched: `audioPath` does not point at it.
    await rm(this.audioPath(meeting), { force: true });
    await this.store.remove(meetingId);
    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "meeting.deleted",
      family: "meetings",
      outcome: "succeeded",
      correlationId: meeting.correlationId,
      resources: [meetingId],
      reason: `deleted "${meeting.title}" including transcript and notes`,
    });
    this.deps.publish({ ...meeting, status: "discarded" });
  }

  /**
   * Fail captures left "recording" or "transcribing" by a crash.
   *
   * A capture cannot be resumed: the sidecar died with the process that spawned
   * it. Whatever audio reached disk is kept — and made readable — so the user
   * can still ask for a transcript.
   */
  async reconcileOnBoot(): Promise<number> {
    let repaired = 0;
    for (const meeting of await this.store.list()) {
      if (meeting.status !== "recording" && meeting.status !== "transcribing") continue;
      repaired += 1;

      // This is the whole cost of letting the sidecar own the file. A streaming
      // WAV writer stamps its header with placeholder sizes and only corrects
      // them when it finalises, which a killed process never does — so the
      // samples are on disk under a header that says the recording is empty,
      // and every decoder believes the header rather than the file. Repairing
      // it here is what keeps a crash worth seconds instead of the meeting.
      const audioBytes = await repairWavHeader(this.audioPath(meeting));

      await this.publish({
        ...meeting,
        status: "failed",
        endedAt: meeting.endedAt ?? this.now().toISOString(),
        audioBytes: audioBytes > 0 ? audioBytes : meeting.audioBytes,
        error: "the recording was interrupted; it was not resumed automatically",
      });
      await this.deps.audit.record({
        actor: { kind: "system" },
        action: "meeting.capture_interrupted",
        family: "meetings",
        outcome: "failed",
        correlationId: meeting.correlationId,
        resources: [meeting.id],
        reason: `interrupted while ${meeting.status}; ${audioBytes} bytes of audio recovered`,
      });
    }
    return repaired;
  }
}

/** A canonical RIFF/WAVE header: 12 bytes of RIFF, 24 of `fmt `, 8 of `data`. */
const WAV_HEADER_BYTES = 44;

/**
 * A meeting title as a filename fragment.
 *
 * The title is whatever the user typed, and it lands in a directory they open
 * in their own file manager, so it is reduced to what every filesystem this app
 * runs on accepts. Truncated as well as filtered: a title can be a sentence,
 * and Windows still refuses a path over 260 characters by default.
 */
const slug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "meeting";

/**
 * Rewrite the size fields of a WAV that was never finalised, and report the
 * file's size.
 *
 * A streaming writer cannot know how long a recording will be, so it stamps the
 * header with placeholders and patches the two size fields when it closes. That
 * only happens on the clean stop path. Kill the process and the samples are all
 * there under a header claiming the `data` chunk holds nothing — a file full of
 * audio that every decoder reads as zero samples.
 *
 * This is arithmetic, not recovery: both fields sit at fixed offsets and both
 * are implied by the file's length, so there is nothing to guess. `RIFF` counts
 * everything after its own 8-byte prefix; `data` counts everything after the
 * header.
 *
 * A file whose header is not the canonical layout is left exactly as it is —
 * patching guessed offsets in something this app did not write would turn a
 * readable file into an unreadable one.
 */
async function repairWavHeader(path: string): Promise<number> {
  const handle = await open(path, "r+").catch(() => null);
  if (handle === null) return 0;
  try {
    const size = (await handle.stat()).size;
    if (size <= WAV_HEADER_BYTES) return size;

    const header = Buffer.alloc(WAV_HEADER_BYTES);
    await handle.read(header, 0, WAV_HEADER_BYTES, 0);
    if (
      header.toString("latin1", 0, 4) !== "RIFF" ||
      header.toString("latin1", 8, 12) !== "WAVE" ||
      header.toString("latin1", 36, 40) !== "data"
    ) {
      return size;
    }

    const riffSize = size - 8;
    const dataSize = size - WAV_HEADER_BYTES;
    if (header.readUInt32LE(4) === riffSize && header.readUInt32LE(40) === dataSize) return size;

    const field = Buffer.alloc(4);
    field.writeUInt32LE(riffSize, 0);
    await handle.write(field, 0, 4, 4);
    field.writeUInt32LE(dataSize, 0);
    await handle.write(field, 0, 4, 40);
    return size;
  } finally {
    await handle.close();
  }
}

/** The size of a file, or 0 when there is no file. */
async function fileBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** Render a transcript for a prompt, with speakers and timestamps preserved. */
export function formatTranscript(transcript: MeetingTranscript, limit = 40_000): string {
  const lines = transcript.segments.map(
    (segment) => `[${formatOffset(segment.startMs)}] ${segment.speaker ?? "Unknown"}: ${segment.text}`,
  );
  const body = lines.join("\n");
  return body.length <= limit
    ? body
    : `${body.slice(0, limit)}\n[transcript truncated at ${limit} characters]`;
}

function formatOffset(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** A default meeting title for an import: the file's name without its suffix. */
function basenameOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const stem = name.replace(/\.[^.]+$/, "");
  return stem === "" ? "Imported recording" : stem;
}

/**
 * The MIME type Azure is told the bytes are.
 *
 * `.m4a` is declared as `audio/mp4` rather than guessed from the extension
 * string, because the container is MP4 and calling it `audio/m4a` is how a
 * perfectly good upload gets rejected as an unsupported format.
 */
function mimeFor(extension: string): string {
  switch (extension) {
    case ".wav":
      return "audio/wav";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
    case ".mp4":
      return "audio/mp4";
    default:
      return "application/octet-stream";
  }
}
