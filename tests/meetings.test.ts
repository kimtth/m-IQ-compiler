import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuditLog,
  MeetingsService,
  formatTranscript,
  parseFastTranscription,
  resolveAppPaths,
  type Scheduler,
} from "@iq/core";
import { RECORDING_NOTICE_VERSION, type MeetingRecord } from "@iq/shared";

/**
 * Recording, transcription and meeting notes.
 *
 * The interesting behaviour here is not the happy path: it is that capture
 * refuses without attributable consent, that a transcript is normalised before
 * anything reads it, and that a note which fails to regenerate keeps its
 * previous body instead of erasing itself.
 */

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as never;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "iq-meetings-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// --- transcription ----------------------------------------------------------

describe("parseFastTranscription", () => {
  it("normalises Azure phrases into ordered segments", () => {
    const result = parseFastTranscription(
      {
        durationMilliseconds: 4200,
        combinedPhrases: [{ text: "Hello there. General agreement." }],
        phrases: [
          { offsetMilliseconds: 0, durationMilliseconds: 1500, text: "Hello there.", speaker: 1 },
          {
            offsetMilliseconds: 1500,
            durationMilliseconds: 2700,
            text: "General agreement.",
            speaker: 2,
          },
        ],
      },
      "en-US",
    );

    expect(result.durationMs).toBe(4200);
    expect(result.locale).toBe("en-US");
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toMatchObject({ index: 0, startMs: 0, endMs: 1500 });
    expect(result.segments[1]?.endMs).toBe(4200);
    expect(result.text).toContain("Hello there.");
  });

  it("keeps a speakerless response usable", () => {
    const result = parseFastTranscription(
      {
        combinedPhrases: [{ text: "one two three" }],
        phrases: [{ offsetMilliseconds: 0, durationMilliseconds: 900, text: "one two three" }],
      },
      "en-GB",
    );

    expect(result.segments[0]?.speaker).toBeNull();
    expect(result.text).toBe("one two three");
  });

  it("falls back to the phrases when no combined text is returned", () => {
    const result = parseFastTranscription(
      { phrases: [{ offsetMilliseconds: 0, durationMilliseconds: 10, text: "salvaged" }] },
      "en-US",
    );
    expect(result.text).toBe("salvaged");
  });

  it("survives a response with nothing recognisable in it", () => {
    const result = parseFastTranscription({}, "en-US");
    expect(result.text).toBe("");
    expect(result.segments).toEqual([]);
    expect(result.durationMs).toBe(0);
  });
});

describe("formatTranscript", () => {
  it("labels each speaker turn so notes can attribute a decision", () => {
    const text = formatTranscript({
      meetingId: "meeting_1",
      locale: "en-US",
      durationMs: 2000,
      segments: [
        { index: 0, speaker: "Speaker 1", startMs: 0, endMs: 1000, text: "We ship Friday." },
        { index: 1, speaker: "Speaker 2", startMs: 1000, endMs: 2000, text: "Agreed." },
      ],
    });

    expect(text).toContain("Speaker 1");
    expect(text).toContain("We ship Friday.");
    expect(text).toContain("Agreed.");
  });
});

// --- consent ----------------------------------------------------------------

/**
 * A 16 kHz mono WAV, laid out exactly as the `iq-audio` sidecar writes one.
 *
 * `finalized: false` reproduces what a killed process leaves behind: the
 * samples are all on disk, but the two size fields still hold the placeholders
 * the header was stamped with, so every decoder reads the file as empty.
 */
function wav(samples: number, finalized = true): Buffer {
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(finalized ? 36 + data.length : 0, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(finalized ? data.length : 0, 40);
  return Buffer.concat([header, data]);
}

function meetingsFixture(options: {
  signedIn?: boolean;
  speechReady?: boolean;
  whisperReady?: boolean;
  audioReady?: boolean;
  defaultEngine?: "azure" | "whisper";
  /** The bound project. Unbound by default, which is the app's own state. */
  projectDir?: string | null;
  /** How much audio the fake capture writes. One second by default. */
  captureSamples?: number;
}): {
  service: MeetingsService;
  audit: AuditLog;
  published: MeetingRecord[];
  captures: string[];
} {
  const paths = resolveAppPaths(root);
  const audit = new AuditLog(paths);
  const published: MeetingRecord[] = [];

  const speech = {
    defaultLocale: "en-US",
    status: () =>
      options.speechReady === false
        ? { state: "not_configured" as const, message: "Azure AI Speech is not configured" }
        : {
            state: "ready" as const,
            auth: "entra" as const,
            region: "westeurope",
            locale: "en-US",
            voice: "en-US-AvaMultilingualNeural",
            synthesis: true,
          },
    // Duration is deliberately 0: it lets the assertions below see the length
    // the capture reported rather than one the transcriber overrode.
    transcribe: async () => ({
      segments: [{ index: 0, speaker: null, startMs: 0, endMs: 1_000, text: "hello" }],
      text: "hello",
      locale: "en-US",
      durationMs: 0,
    }),
  } as never;

  const whisper = {
    readiness: async () =>
      options.whisperReady === false
        ? { ready: false, message: "No Whisper model is selected" }
        : { ready: true, message: "" },
  } as never;

  const ffmpeg = { durationMs: async () => 0 } as never;

  // System audio needs the native sidecar. A machine without it must still be
  // able to record a microphone, so its absence is the fixture's default.
  //
  // `start` writes a real WAV rather than returning a stub, because the service
  // no longer keeps a running byte total: it measures the file. A fake that
  // wrote nothing would test arithmetic that has been deleted.
  const captures: string[] = [];
  const samples = options.captureSamples ?? 16_000;
  const audio = {
    readiness: async () =>
      options.audioReady === true
        ? { ready: true, message: "" }
        : { ready: false, message: "The iq-audio capture sidecar was not found" },
    start: async (input: { out: string }) => {
      captures.push(input.out);
      await writeFile(input.out, wav(samples));
      return {
        stop: async () => ({
          path: input.out,
          durationMs: samples / 16,
          bytes: samples * 2,
        }),
        cancel: () => undefined,
      };
    },
  } as never;

  const service = new MeetingsService({
    paths,
    speech,
    whisper,
    audio,
    ffmpeg,
    defaultEngine: () => options.defaultEngine ?? "azure",
    projectDir: () => options.projectDir ?? null,
    audit,
    logger: silentLogger,
    publish: (meeting) => published.push(meeting),
    currentAccount: () =>
      options.signedIn === false
        ? null
        : { oid: "oid-1", tenantId: "tenant-1", username: "ada@contoso.com" },
    writeNotes: async () => ({ body: "notes", sessionId: "session_1" }),
  });

  return { service, audit, published, captures };
}

const validStart = {
  title: "Contoso sync",
  sources: ["microphone" as const],
  noticeVersion: RECORDING_NOTICE_VERSION,
  participantsInformed: true as const,
};

describe("MeetingsService.start", () => {
  it("records once consent, identity and transcription are all in place", async () => {
    const { service, published } = meetingsFixture({});
    const meeting = await service.start(validStart);

    expect(meeting.status).toBe("recording");
    expect(meeting.consent.acknowledgedByOid).toBe("oid-1");
    expect(meeting.consent.noticeVersion).toBe(RECORDING_NOTICE_VERSION);
    expect(published).toHaveLength(1);
  });

  it("refuses when nobody is signed in, because consent must be attributable", async () => {
    const { service } = meetingsFixture({ signedIn: false });
    await expect(service.start(validStart)).rejects.toThrow(/signed-in/i);
    expect(await service.list()).toEqual([]);
  });

  it("refuses when the acknowledged notice is not the current one", async () => {
    const { service } = meetingsFixture({});
    await expect(
      service.start({ ...validStart, noticeVersion: "1999-01" }),
    ).rejects.toThrow(/notice has changed/i);
  });

  it("refuses when no audio source was chosen", async () => {
    const { service } = meetingsFixture({});
    await expect(service.start({ ...validStart, sources: [] })).rejects.toThrow(/audio source/i);
  });

  it("refuses when the audio could never be transcribed", async () => {
    const { service } = meetingsFixture({ speechReady: false });
    await expect(service.start(validStart)).rejects.toThrow(/not configured/i);
  });

  it("audits every refusal, so an attempt to record leaves a trace", async () => {
    const { service, audit } = meetingsFixture({ signedIn: false });
    await expect(service.start(validStart)).rejects.toThrow();

    const records = await audit.query({ family: "meetings", limit: 10 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ action: "meeting.capture_refused", outcome: "denied" });
  });

  it("defaults to discarding audio once a transcript exists", async () => {
    const { service } = meetingsFixture({});
    const meeting = await service.start(validStart);
    expect(meeting.consent.retainAudio).toBe(false);
  });

  /**
   * The engine is the one decision here that changes where audio goes, so it is
   * checked from three angles: the prerequisite that applies, the record that
   * remembers it, and the notice that described it.
   */
  it("checks the prerequisite of the chosen engine, not of the other one", async () => {
    // Azure absent, Whisper present: a local capture must still be allowed.
    const local = meetingsFixture({ speechReady: false, whisperReady: true });
    const meeting = await local.service.start({ ...validStart, engine: "whisper" });
    expect(meeting.engine).toBe("whisper");
    expect(meeting.consent.engine).toBe("whisper");

    // And the converse: no model means no local capture, even with Azure ready.
    const missingModel = meetingsFixture({ whisperReady: false });
    await expect(
      missingModel.service.start({ ...validStart, engine: "whisper" }),
    ).rejects.toThrow(/Whisper model/i);
  });

  it("shows the notice that matches the engine, and says what blocks it", async () => {
    const { service } = meetingsFixture({
      speechReady: false,
      whisperReady: true,
      audioReady: true,
    });

    const cloud = await service.notice("azure");
    expect(cloud.text).toContain("send it to your");
    expect(cloud.blocked).toMatch(/not configured/i);

    const local = await service.notice("whisper");
    expect(local.text).toContain("not uploaded anywhere");
    expect(local.blocked).toBe("");
  });

  it("reports the capture sidecar as its own reason, and as what blocks the recorder", async () => {
    // The sidecar used to gate one source. It records both now, so its absence
    // blocks the recorder — but the source tick still needs its own reason,
    // which is why the two are reported separately and say the same thing.
    const without = meetingsFixture({});
    const blocked = await without.service.notice("azure");
    expect(blocked.systemAudio.ready).toBe(false);
    expect(blocked.systemAudio.message).toMatch(/iq-audio/i);
    expect(blocked.blocked).toMatch(/iq-audio/i);

    const withSidecar = meetingsFixture({ audioReady: true });
    const ready = await withSidecar.service.notice("azure");
    expect(ready.systemAudio).toEqual({ ready: true, message: "" });
    expect(ready.blocked).toBe("");
  });

  it("names the engine before the recorder when both are unavailable", async () => {
    // Repairing the capture is no use if the transcript still cannot be made.
    const { service } = meetingsFixture({ speechReady: false });
    expect((await service.notice("azure")).blocked).toMatch(/not configured/i);
  });

  it("records the origin, so an import is never mistaken for a capture", async () => {
    const { service } = meetingsFixture({});
    const meeting = await service.start(validStart);
    expect(meeting.origin).toBe("capture");
    expect(meeting.sourceFile).toBe("");
  });
});

/**
 * The recording file.
 *
 * The sidecar owns it now: nothing appends, so `audioBytes` has to come from
 * the file, and the header it writes is only correct once it finalises. Both of
 * those are new failure modes and both are pinned here.
 */
describe("MeetingsService capture files", () => {
  it("measures the recording from the file on disk, not from a running total", async () => {
    const { service, captures } = meetingsFixture({});
    const started = await service.start(validStart);
    expect(captures[0]?.endsWith("audio.wav")).toBe(true);

    const stopped = await service.stop(started.id);
    // 16 000 samples of 16-bit mono, plus the 44-byte header.
    expect(stopped.audioBytes).toBe(32_044);
    expect(stopped.durationMs).toBe(1_000);
  });

  it("calls a short recording short, rather than claiming nothing was heard", async () => {
    // The capture writes silence for a silent source, so a small file means a
    // brief recording — not a microphone that produced nothing, which is what
    // this used to say.
    const { service } = meetingsFixture({ captureSamples: 100 });
    const started = await service.start(validStart);
    const stopped = await service.stop(started.id);

    expect(stopped.status).toBe("failed");
    expect(stopped.error).toMatch(/too short/i);
    expect(stopped.error).not.toMatch(/no audio was captured/i);
  });

  it("repairs a WAV whose header was never finalised, so a crash costs seconds", async () => {
    const { service, published, captures } = meetingsFixture({});
    const started = await service.start(validStart);
    const file = captures[0] as string;

    // What a killed process leaves behind: every sample on disk, under a header
    // whose size fields were never rewritten.
    await writeFile(file, wav(16_000, false));

    expect(await service.reconcileOnBoot()).toBe(1);

    const repaired = await readFile(file);
    expect(repaired.readUInt32LE(40)).toBe(32_000);
    expect(repaired.readUInt32LE(4)).toBe(32_036);

    const failed = published.at(-1);
    expect(failed?.status).toBe("failed");
    expect(failed?.audioBytes).toBe(32_044);
  });

  it("leaves a file it did not write exactly as it found it", async () => {
    const { service, captures } = meetingsFixture({});
    const started = await service.start(validStart);
    expect(started.status).toBe("recording");

    const foreign = Buffer.from("not a wav at all, but long enough to look like one".repeat(4));
    await writeFile(captures[0] as string, foreign);

    await service.reconcileOnBoot();
    expect(await readFile(captures[0] as string)).toEqual(foreign);
  });
});

/**
 * Where a recording lands.
 *
 * A recording is a work artifact, so it belongs with the user's other work
 * rather than in an application data directory they have no reason to open.
 * The path is recorded on the meeting rather than recomputed, because the
 * project can be rebound afterwards and a path derived from *today's*
 * project would then point at nothing.
 */
describe("MeetingsService — where the audio is written", () => {
  it("records into the bound project", async () => {
    const project = join(root, "bound-project");
    const { service, captures } = meetingsFixture({ projectDir: project });

    const started = await service.start(validStart);

    expect(captures[0]?.startsWith(project)).toBe(true);
    expect(started.audioFile).toBe(captures[0]);
    // Project-relative and spelled with `/`: that is the form the navigator
    // and every other reader match on, and `join` gives `meetings\x` here.
    expect(started.audioProjectPath).toMatch(/^meetings\/\d{4}-\d{2}-\d{2}-contoso-sync-\w+\.wav$/);
  });

  it("falls back to the app's own directory when nothing is bound", async () => {
    // A recording must not be refused for want of a project: the consent has
    // been given and the meeting is already happening.
    const { service, captures } = meetingsFixture({});
    const started = await service.start(validStart);

    expect(captures[0]?.startsWith(root)).toBe(true);
    expect(started.audioProjectPath).toBe("");
  });

  it("transcribes and discards the file it actually wrote", async () => {
    const project = join(root, "bound-project-2");
    const { service, captures } = meetingsFixture({ projectDir: project });

    const started = await service.start(validStart);
    const stopped = await service.stop(started.id);

    expect(stopped.status).toBe("transcribed");
    // Retention was not consented to, so the project copy is the one removed
    // — a reader that still pointed at the old location would leave the audio
    // on disk after telling the user it had been discarded.
    expect(stopped.audioRetained).toBe(false);
    expect(existsSync(captures[0] as string)).toBe(false);
  });

  it("deletes the file it actually wrote, not just the store directory", async () => {
    // Retention was consented to, so the WAV survives the transcript and
    // "Delete" is the only thing left that removes it. `store.remove` clears
    // the app's own directory, which is not where a project recording is, so
    // deleting a meeting used to leave the audio in the project.
    const project = join(root, "bound-project-3");
    const { service, captures } = meetingsFixture({ projectDir: project });

    const started = await service.start({ ...validStart, retainAudio: true });
    const stopped = await service.stop(started.id);
    expect(stopped.audioRetained).toBe(true);
    expect(existsSync(captures[0] as string)).toBe(true);

    await service.delete(started.id);

    expect(existsSync(captures[0] as string)).toBe(false);
    expect(await service.get(started.id)).toBeNull();
  });
});
