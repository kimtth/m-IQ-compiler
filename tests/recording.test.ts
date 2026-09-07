import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuditLog,
  RecorderController,
  RecordingStore,
  UNAVAILABLE_SCREEN_RECORDER,
  buildBundle,
  correlate,
  newRecordingId,
  resolveAppPaths,
  type CapturedFrame,
  type RecordingCollector,
  type ScreenRecorder,
} from "@iq/core";
import {
  SKILL_RECORDING_NOTICE_VERSION,
  RecEvent,
  renderValues,
  slugifyRecordingName,
  type FrameRecord,
  type RecorderStatus,
  type RecordingRecord,
} from "@iq/shared";

/**
 * Skill Recording: capture, correlation and segmentation.
 *
 * The parts worth testing are the deterministic ones. Whether the model writes
 * a good description is not something a test can assert; whether a discarded
 * capture leaves media on disk, whether a frame taken between two events is
 * reported as unexplained rather than quietly attached to the nearest one, and
 * whether a stale notice version can start a recording all are.
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
  root = await mkdtemp(join(tmpdir(), "iq-recording-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const START_EPOCH = Date.UTC(2026, 7, 5, 9, 0, 0);

/** One timeline event, positioned in time the way a collector would emit it. */
function event(
  seq: number,
  offsetMs: number,
  type: string,
  payload: Record<string, unknown> = {},
): RecEvent {
  return RecEvent.parse({
    seq,
    t: offsetMs,
    epoch: START_EPOCH + offsetMs,
    type,
    source: "test",
    payload,
  });
}

function frame(tMs: number, file: string): FrameRecord {
  return { file, tMs, source: "scene", phash: "", width: 1280, height: 720 };
}

// --- correlation -------------------------------------------------------------

describe("correlate", () => {
  it("attaches a frame to the events beside it and carries the context forward", () => {
    const result = correlate({
      startEpoch: START_EPOCH,
      events: [
        event(1, 0, "app.activate", { app: "chrome.exe", title: "Invoices" }),
        event(2, 100, "browser.url", { url: "https://example.test/invoices" }),
      ],
      frames: [frame(300, "frame-000001.jpg"), frame(60_000, "frame-000002.jpg")],
    });

    const [near, later] = result.frames;
    expect(near?.nearestEventSeqs).toEqual([1, 2]);
    expect(near?.unexplained).toBe(false);
    expect(near?.app).toBe("chrome.exe");
    expect(near?.url).toBe("https://example.test/invoices");

    // A frame a minute later has no event beside it, but the context is still
    // known — that is more use to the analyst than a blank, and it must not be
    // mistaken for evidence that something happened at that moment.
    expect(later?.unexplained).toBe(true);
    expect(later?.nearestEventSeqs).toEqual([]);
    expect(later?.app).toBe("chrome.exe");
    expect(result.stats.unexplainedFrameCount).toBe(1);
  });

  it("reports an event no frame witnesses rather than smoothing it away", () => {
    const result = correlate({
      startEpoch: START_EPOCH,
      events: [
        event(1, 0, "app.activate", { app: "excel.exe", title: "Book1" }),
        event(2, 30_000, "clipboard.change", { textPreview: "ACME-4471" }),
      ],
      frames: [frame(0, "frame-000001.jpg")],
    });

    expect(result.silentEvents.map((entry) => entry.seq)).toEqual([2]);
    expect(result.silentEvents[0]?.nearestFrameGapMs).toBe(30_000);
    expect(result.stats.silentEventCount).toBe(1);
  });

  it("ignores events that say nothing about what the user did", () => {
    const result = correlate({
      startEpoch: START_EPOCH,
      events: [event(1, 0, "session.start"), event(2, 10, "video.start")],
      frames: [frame(5_000, "frame-000001.jpg")],
    });

    // Neither bookkeeping event counts as unwitnessed: they are not evidence of
    // anything a person did, so pairing them with frames would be noise.
    expect(result.silentEvents).toEqual([]);
    expect(result.frames[0]?.unexplained).toBe(true);
  });
});

// --- segmentation ------------------------------------------------------------

describe("buildBundle", () => {
  const bundleOf = (events: RecEvent[], frames: FrameRecord[] = []) =>
    buildBundle({
      recordingId: "20260805-090000-abcdef12",
      platform: "win32",
      appVersion: "1.2.3",
      startEpoch: START_EPOCH,
      stopEpoch: START_EPOCH + 120_000,
      events,
      frames,
    });

  it("breaks steps on application and URL changes, but not on title changes", () => {
    const bundle = bundleOf([
      event(1, 0, "session.start"),
      event(2, 100, "app.activate", { app: "chrome.exe", title: "Invoices" }),
      event(3, 200, "browser.url", { url: "https://example.test/a" }),
      // A title change alone is not a new step: a spreadsheet renames its
      // window on every save, and treating that as a boundary shreds one piece
      // of work into a dozen fragments.
      event(4, 5_000, "app.title-change", { title: "Invoices — edited" }),
      event(5, 10_000, "browser.url", { url: "https://example.test/b" }),
      event(6, 20_000, "app.activate", { app: "excel.exe", title: "Book1" }),
    ]);

    expect(bundle.steps).toHaveLength(3);
    expect(bundle.steps.map((step) => step.boundary)).toEqual([
      "start",
      "url-change",
      "app-change",
    ]);
    expect(bundle.steps[0]?.app).toBe("chrome.exe");
    expect(bundle.steps[0]?.titles).toContain("Invoices — edited");
    expect(bundle.steps[2]?.app).toBe("excel.exe");
  });

  it("keeps markers and clipboard previews on the step they happened in", () => {
    const bundle = bundleOf([
      event(1, 0, "app.activate", { app: "excel.exe", title: "Book1" }),
      event(2, 1_000, "clipboard.change", { textPreview: "ACME-4471" }),
      event(3, 2_000, "marker", { note: "this one is a duplicate" }),
    ]);

    expect(bundle.steps).toHaveLength(1);
    expect(bundle.steps[0]?.clipboardPreviews).toContain("ACME-4471");
    expect(bundle.steps[0]?.markers).toContain("this one is a duplicate");
  });

  it("is deterministic: the same capture always produces the same bundle", () => {
    const events = [
      event(1, 0, "app.activate", { app: "chrome.exe", title: "Invoices" }),
      event(2, 4_000, "browser.url", { url: "https://example.test/a" }),
    ];
    const frames = [frame(100, "frame-000001.jpg")];
    expect(JSON.stringify(bundleOf(events, frames))).toBe(
      JSON.stringify(bundleOf(events, frames)),
    );
  });

  it("survives a capture that was cut off, using the last event as the end", () => {
    const bundle = buildBundle({
      recordingId: "20260805-090000-abcdef12",
      platform: "win32",
      appVersion: "1.2.3",
      startEpoch: START_EPOCH,
      stopEpoch: null,
      events: [event(1, 0, "app.activate", { app: "chrome.exe" }), event(2, 9_000, "marker", { note: "x" })],
      frames: [],
    });

    expect(bundle.session.durationMs).toBe(9_000);
  });
});

// --- the capture state machine ----------------------------------------------

interface Harness {
  controller: RecorderController;
  store: RecordingStore;
  statuses: RecorderStatus[];
  published: RecordingRecord[];
  collector: { started: number; stopped: number; emit: (type: string, payload?: object) => void };
  screen: ScreenRecorder & { started: number; stopped: number };
}

async function harness(options: { screen?: ScreenRecorder } = {}): Promise<Harness> {
  const paths = resolveAppPaths(root);
  const store = new RecordingStore(paths);
  const statuses: RecorderStatus[] = [];
  const published: RecordingRecord[] = [];

  let emit: (event: { type: string; source: string; payload?: object }) => void = () => undefined;
  const collector = {
    started: 0,
    stopped: 0,
    emit: (type: string, payload: object = {}) => emit({ type, source: "test", payload }),
  };
  const recordingCollector: RecordingCollector = {
    name: "test",
    start: (sink) => {
      collector.started += 1;
      emit = sink as typeof emit;
    },
    stop: () => {
      collector.stopped += 1;
    },
  };

  const screen = Object.assign(options.screen ?? UNAVAILABLE_SCREEN_RECORDER, {
    started: 0,
    stopped: 0,
  }) as Harness["screen"];

  const controller = new RecorderController({
    store,
    audit: new AuditLog(paths),
    logger: silentLogger,
    appVersion: "1.2.3",
    collectors: () => [recordingCollector],
    screen: () => screen,
    narration: () => ({ start: async () => undefined, stop: async () => null }),
    currentAccount: () => ({ oid: "oid-1", tenantId: "tid-1", username: "a@b.test" }),
    publish: (record) => published.push(record),
    publishStatus: (status) => statuses.push(status),
  });

  return { controller, store, statuses, published, collector, screen };
}

const START = {
  acknowledgedNoticeVersion: SKILL_RECORDING_NOTICE_VERSION,
  captureVideo: false,
  captureNarration: false,
  microphone: "",
};

describe("RecorderController", () => {
  it("refuses to start against a notice version the user has not read", async () => {
    const { controller, store } = await harness();

    await expect(
      controller.start({ ...START, acknowledgedNoticeVersion: "1970-01" }),
    ).rejects.toThrow(/notice has changed/);
    // Refused, not upgraded: nothing was created for a consent that was never
    // given against the current wording.
    expect(await store.list()).toEqual([]);
    expect(controller.status().state).toBe("idle");
  });

  it("records, stops, and leaves a readable timeline", async () => {
    const { controller, store, collector } = await harness();

    const started = await controller.start(START);
    expect(controller.status()).toMatchObject({ state: "recording", recordingId: started.id });
    expect(collector.started).toBe(1);

    collector.emit("app.activate", { app: "chrome.exe", title: "Invoices" });
    expect(controller.marker("look here")).toBe(true);

    const stopped = await controller.stop();
    expect(stopped.status).toBe("ready");
    expect(stopped.endedAt).not.toBeNull();
    expect(collector.stopped).toBe(1);
    expect(controller.status().state).toBe("idle");

    const events = await store.readEvents(stopped.id);
    const types = events.map((entry) => entry.type);
    expect(types[0]).toBe("session.start");
    expect(types).toContain("app.activate");
    expect(types).toContain("marker");
    expect(types[types.length - 1]).toBe("session.stop");
    // Sequence numbers are the ordering the bundle depends on, so they must be
    // dense and monotonic even though the writes are batched.
    expect(events.map((entry) => entry.seq)).toEqual(events.map((_, index) => index));
  });

  it("refuses a second capture while one is running", async () => {
    const { controller } = await harness();
    await controller.start(START);
    await expect(controller.start(START)).rejects.toThrow(/already running/);
    await controller.stop();
  });

  it("discards the whole session directory rather than keeping an unusable one", async () => {
    const { controller, store } = await harness();

    const started = await controller.start(START);
    expect(await store.get(started.id)).not.toBeNull();

    await controller.discard();

    expect(await store.get(started.id)).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(controller.status().state).toBe("idle");
  });

  it("keeps recording when screen capture is unavailable", async () => {
    // Failing the whole session because a display could not be enumerated
    // throws away the timeline, which is the part that was working.
    const { controller, store } = await harness({
      screen: {
        start: async () => {
          throw new Error("no displays");
        },
        stop: async () => null,
      },
    });

    const started = await controller.start({ ...START, captureVideo: true });
    expect(started.hasVideo).toBe(false);
    expect(controller.status()).toMatchObject({ state: "recording", videoActive: false });

    const stopped = await controller.stop();
    expect(stopped.status).toBe("ready");
    expect((await store.readEvents(stopped.id)).length).toBeGreaterThan(0);
  });

  it("writes each captured frame once, with a manifest that matches", async () => {
    // Not `| null`: the callback is assigned inside the harness, which the
    // checker cannot see, so a nullable holder narrows to `never` at the call
    // and an optional call would swallow a harness that never started.
    let deliver!: (frame: CapturedFrame) => void;
    const { controller, store } = await harness({
      screen: {
        start: async (input) => {
          deliver = input.onFrame;
          return { fps: 1 };
        },
        stop: async () => ({ durationMs: 2_000, bytes: 1_024 }),
      },
    });

    const started = await controller.start({ ...START, captureVideo: true });
    expect(started.hasVideo).toBe(true);

    deliver({
      bytes: new Uint8Array([1, 2, 3]),
      tMs: 500,
      phash: "0123456789abcdef",
      width: 1280,
      height: 720,
      source: "scene",
    });
    // The frame is written asynchronously; let it land before stopping.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stopped = await controller.stop();
    const frames = await store.readFrames(stopped.id);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.file).toMatch(/^frame-\d{6}\.jpg$/);
    expect(stopped.frameCount).toBe(1);
    // The file name, the manifest entry and the timeline event must agree, or
    // the frame is unreachable to anything that reads the bundle.
    const captured = (await store.readEvents(stopped.id)).filter(
      (entry) => entry.type === "frame.captured",
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.payload["file"]).toBe(frames[0]?.file);
  });

  it("says nothing is recording rather than failing silently", async () => {
    const { controller } = await harness();
    expect(controller.marker("no capture")).toBe(false);
    await expect(controller.stop()).rejects.toThrow(/nothing is recording/);
  });
});

// --- the store's trust boundary ---------------------------------------------

describe("RecordingStore", () => {
  it("refuses an id that would escape the recordings directory", async () => {
    const store = new RecordingStore(resolveAppPaths(root));
    // Ids arrive from IPC payloads. `../../skills` would otherwise turn a
    // delete into an arbitrary recursive removal.
    expect(() => store.dir("../../skills")).toThrow(/invalid recording id/);
    expect(() => store.dir("not an id")).toThrow(/invalid recording id/);
    // `remove` is the dangerous one — it deletes a directory tree — so it must
    // refuse the id rather than resolve it relative to the recordings root.
    await expect(store.remove("../../skills")).rejects.toThrow(/invalid recording id/);
  });

  it("refuses a frame file name it did not generate", () => {
    const store = new RecordingStore(resolveAppPaths(root));
    const id = newRecordingId(new Date(START_EPOCH), () => 0.5);
    expect(() => store.framePath(id, "../../../etc/passwd")).toThrow(/invalid frame file/);
    expect(store.framePath(id, "frame-000001.jpg")).toContain("frame-000001.jpg");
  });

  it("mints ids that sort by time and survive a round trip", () => {
    const early = newRecordingId(new Date(START_EPOCH), () => 0.5);
    const late = newRecordingId(new Date(START_EPOCH + 60_000), () => 0.5);
    expect(early < late).toBe(true);
    const store = new RecordingStore(resolveAppPaths(root));
    expect(store.dir(early)).toContain(early);
  });
});

// --- generalisation ----------------------------------------------------------

describe("plan values", () => {
  it("substitutes named values into the procedure", () => {
    const body = "Open {{portal_url}} and search for {{supplier}}.";
    expect(
      renderValues(body, [
        { id: "portal_url", name: "Portal", value: "https://example.test" },
        { id: "supplier", name: "Supplier", value: "ACME" },
      ]),
    ).toBe("Open https://example.test and search for ACME.");
  });

  it("leaves an unknown token visible rather than erasing it", () => {
    // A surviving `{{invoice_id}}` is a legible defect. An empty string is a
    // procedure that silently does the wrong thing.
    expect(renderValues("Find {{invoice_id}}.", [{ id: "other", name: "x", value: "y" }])).toBe(
      "Find {{invoice_id}}.",
    );
  });

  it("coerces any title into a usable skill name", () => {
    expect(slugifyRecordingName("Chase vendor advisories — weekly!")).toBe(
      "chase-vendor-advisories-weekly",
    );
    expect(slugifyRecordingName("!!!")).toBe("recorded-skill");
  });
});
