import { z } from "zod";
import { TranscriptSegment } from "./speech.js";
import { TranscriptionEngine } from "./media.js";

/**
 * Meeting capture contracts.
 *
 * The backlog deferred meeting recording and note generation on one ground
 * only: it "would require an explicit recording-consent design"
 * (docs/02-backlog.md row 31). This module is that design, so the capability is
 * expressible without weakening consent.
 *
 * Three rules make consent real rather than decorative:
 *
 *  1. Capture cannot start without a `RecordingConsent` naming a signed-in
 *     Entra identity that acknowledged the current notice. It is stored with
 *     the recording and written to the audit log, so "who authorised this" is
 *     answerable months later.
 *  2. The notice is versioned. Raising `RECORDING_NOTICE_VERSION` invalidates
 *     every earlier acknowledgement, so a change in what is captured is
 *     re-consented rather than inherited.
 *  3. Audio retention is opted into, not out of. The default discards the audio
 *     once a transcript exists, because the transcript is what the product
 *     needs and the audio is the more sensitive artefact.
 *
 * There are two notices, not one, because there are two materially different
 * things to consent to. Sending a room's audio to a cloud service and running a
 * model on the device are not the same disclosure, and a single notice would
 * have to be wrong about one of them. The engine is recorded on the meeting and
 * on the consent, so a reader can always tell which happened.
 */

export const RECORDING_NOTICE_VERSION = "2026-02";

export const RECORDING_NOTICE = `IQ Compiler will capture audio from this device and send it to your
organisation's Azure AI Speech resource to produce a transcript.

Before you start:
- Tell every participant that the meeting is being recorded and transcribed.
- Recording without notice may be unlawful in your jurisdiction and may breach
  your organisation's policy.
- The recording, the transcript and the notes are stored locally on this device
  and are readable by anyone who can sign in to it.

You are recorded as the person who authorised this capture.`;

export const RECORDING_NOTICE_LOCAL = `IQ Compiler will capture audio from this device and transcribe it on this
device with a local Whisper model. The audio is not uploaded anywhere.

Before you start:
- Tell every participant that the meeting is being recorded and transcribed.
- Recording without notice may be unlawful in your jurisdiction and may breach
  your organisation's policy.
- The recording, the transcript and the notes are stored locally on this device
  and are readable by anyone who can sign in to it.

You are recorded as the person who authorised this capture.`;

/** The notice that matches an engine. Never show one for the other. */
export const noticeTextFor = (engine: TranscriptionEngine): string =>
  engine === "whisper" ? RECORDING_NOTICE_LOCAL : RECORDING_NOTICE;

/** What the capture draws audio from. */
export const AudioSource = z.enum(["microphone", "system"]);
export type AudioSource = z.infer<typeof AudioSource>;

export const RecordingConsent = z.object({
  noticeVersion: z.string(),
  /** Entra object id of the person who acknowledged the notice. */
  acknowledgedByOid: z.string().min(1),
  acknowledgedByTenantId: z.string().min(1),
  acknowledgedByUsername: z.string().min(1),
  acknowledgedAt: z.string().datetime(),
  /**
   * The affirmation itself. Typed as a literal `true` so that "no answer" and
   * "answered no" cannot both arrive as a falsy value that some caller reads as
   * consent.
   */
  participantsInformed: z.literal(true),
  sources: z.array(AudioSource).min(1),
  /** Which engine the notice that was shown described. */
  engine: TranscriptionEngine.default("azure"),
  /** Keep the audio after transcription. Off by default. */
  retainAudio: z.boolean().default(false),
});
export type RecordingConsent = z.infer<typeof RecordingConsent>;

export const MeetingStatus = z.enum([
  "recording",
  "transcribing",
  "transcribed",
  "notes_pending",
  "ready",
  "failed",
  "discarded",
]);
export type MeetingStatus = z.infer<typeof MeetingStatus>;

/**
 * Where the audio came from.
 *
 * `capture` is a live recording this app made. `import` is a file the user
 * already had — including one of its own screen recordings. The distinction
 * matters for retention: deleting an import's "audio" must never delete the
 * user's own file, so the two are stored differently and the record says which
 * it is.
 */
export const MeetingOrigin = z.enum(["capture", "import"]);
export type MeetingOrigin = z.infer<typeof MeetingOrigin>;

export const MeetingRecord = z.object({
  id: z.string(),
  title: z.string().min(1),
  status: MeetingStatus,
  consent: RecordingConsent,
  /** Defaulted so meetings recorded before engines existed still parse. */
  engine: TranscriptionEngine.default("azure"),
  origin: MeetingOrigin.default("capture"),
  /** Imports only: the file the user pointed at. Never written to. */
  sourceFile: z.string().default(""),
  /**
   * Where the recording is on disk, absolutely.
   *
   * Captures land in the bound project when there is one — a recording is a
   * work artifact, and a user looking for "the audio from that meeting" should
   * find it beside the deck and the notes rather than in an application data
   * directory they have no reason to know about. It is recorded on the meeting
   * rather than recomputed, because the project can be rebound afterwards and
   * a path derived from *today's* project would then point at nothing.
   *
   * Empty means the pre-project location under `<IQ_HOME>/meetings/<id>/`,
   * which is also where a capture goes when no project is bound.
   */
  audioFile: z.string().default(""),
  /** Project-relative form of {@link audioFile}, for display. "" when outside. */
  audioProjectPath: z.string().default(""),
  /** Set when the audio came from one of this app's screen recordings. */
  recordingId: z.string().nullable().default(null),
  /** Graph event id when the capture was started from a calendar entry. */
  calendarEventId: z.string().nullable().default(null),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable().default(null),
  /** Bytes of audio accepted so far. */
  audioBytes: z.number().int().min(0).default(0),
  /** True while an audio file still exists on disk. */
  audioRetained: z.boolean().default(false),
  durationMs: z.number().int().min(0).default(0),
  segmentCount: z.number().int().min(0).default(0),
  locale: z.string().default("en-US"),
  /** Session that produced the notes, so the reasoning stays inspectable. */
  notesSessionId: z.string().nullable().default(null),
  notesUpdatedAt: z.string().datetime().nullable().default(null),
  error: z.string().nullable().default(null),
  correlationId: z.string(),
});
export type MeetingRecord = z.infer<typeof MeetingRecord>;

export const MeetingTranscript = z.object({
  meetingId: z.string(),
  locale: z.string(),
  durationMs: z.number().int().min(0),
  segments: z.array(TranscriptSegment),
});
export type MeetingTranscript = z.infer<typeof MeetingTranscript>;

/** A meeting is only worth transcribing once some audio actually arrived. */
export const MIN_TRANSCRIBABLE_BYTES = 2_048;
