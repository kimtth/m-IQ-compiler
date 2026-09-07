import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  FrameRecord,
  NarrationTranscript,
  RecEvent,
  RecordingAnalysis,
  RecordingBuild,
  RecordingRecord,
  SessionBundle,
} from "@iq/shared";
import type { AppPaths } from "../config/paths.js";
import { appendJsonl, readJson, readJsonl, writeJsonAtomic } from "../util/jsonl.js";

/**
 * On-disk layout for skill recordings.
 *
 * One directory per recording, and a single index file listing them. The index
 * exists so that "what recordings are there?" is one read rather than a scan of
 * every directory, and so a directory left behind by a crash mid-delete is
 * invisible rather than half-present.
 *
 * ```
 * <IQ_HOME>/recordings/
 *   recordings.json          the index: RecordingRecord[]
 *   <id>/
 *     events.jsonl           the timeline, append-only
 *     video.webm             low-rate screen capture, when there was one
 *     frames/                extracted stills, named frame-000123.jpg
 *     frames.json            FrameRecord[] — the manifest for the above
 *     narration.wav          narration audio, when it was captured
 *     narration.json         NarrationTranscript
 *     bundle.json            deterministic SessionBundle handed to the analyst
 *     analysis.json          the current RecordingAnalysis
 *     build.json             the current RecordingBuild
 * ```
 *
 * Every derived file is rebuildable from `events.jsonl`, `frames/` and
 * `narration.wav`, which is what makes it safe to delete one and re-run.
 */

/** Files inside a recording directory, named once so nothing spells them twice. */
export const RECORDING_FILES = {
  events: "events.jsonl",
  video: "video.webm",
  frames: "frames",
  frameManifest: "frames.json",
  narrationAudio: "narration.wav",
  narration: "narration.json",
  bundle: "bundle.json",
  analysis: "analysis.json",
  build: "build.json",
} as const;

/** How a frame file is named. Enforced so a manifest cannot name a path. */
export const FRAME_FILE_PATTERN = /^frame-\d{6}\.jpg$/;

export const frameFileName = (index: number): string =>
  `frame-${String(index).padStart(6, "0")}.jpg`;

/**
 * Recording ids are `YYYYMMDD-HHMMSS-xxxxxxxx`.
 *
 * Sortable by name, so a directory listing is chronological without reading
 * anything, and suffixed with randomness so two recordings started in the same
 * second cannot collide.
 */
const ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{8}$/;

export const isRecordingId = (value: string): boolean => ID_PATTERN.test(value);

export function newRecordingId(now: Date, random: () => number = Math.random): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = Math.floor(random() * 0x1_0000_0000)
    .toString(16)
    .padStart(8, "0");
  return `${stamp}-${suffix}`;
}

export class RecordingStore {
  constructor(private readonly paths: AppPaths) {}

  private get indexFile(): string {
    return join(this.paths.recordings, "recordings.json");
  }

  /**
   * The directory for a recording.
   *
   * The id is validated rather than trusted. It reaches here from an IPC
   * payload, and an id of `../../skills` would otherwise turn a delete into an
   * arbitrary recursive removal.
   */
  dir(recordingId: string): string {
    if (!isRecordingId(recordingId)) throw new Error(`invalid recording id: ${recordingId}`);
    return join(this.paths.recordings, recordingId);
  }

  file(recordingId: string, name: keyof typeof RECORDING_FILES): string {
    return join(this.dir(recordingId), RECORDING_FILES[name]);
  }

  framePath(recordingId: string, frameFile: string): string {
    if (!FRAME_FILE_PATTERN.test(frameFile)) {
      throw new Error(`invalid frame file: ${frameFile}`);
    }
    return join(this.dir(recordingId), RECORDING_FILES.frames, frameFile);
  }

  async ensureDir(recordingId: string): Promise<string> {
    const dir = this.dir(recordingId);
    await mkdir(join(dir, RECORDING_FILES.frames), { recursive: true });
    return dir;
  }

  // --- the index ----------------------------------------------------------

  async list(): Promise<RecordingRecord[]> {
    const raw = await readJson<unknown>(this.indexFile, []);
    if (!Array.isArray(raw)) return [];
    const out: RecordingRecord[] = [];
    for (const entry of raw) {
      const parsed = RecordingRecord.safeParse(entry);
      if (parsed.success) out.push(parsed.data);
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async get(recordingId: string): Promise<RecordingRecord | null> {
    return (await this.list()).find((entry) => entry.id === recordingId) ?? null;
  }

  async save(record: RecordingRecord): Promise<void> {
    const all = await this.list();
    const index = all.findIndex((entry) => entry.id === record.id);
    if (index >= 0) all[index] = record;
    else all.push(record);
    await writeJsonAtomic(this.indexFile, all);
  }

  /**
   * Delete the index entry first, then the directory.
   *
   * The reverse order can leave an entry pointing at nothing, which every
   * reader then has to defend against. This order can leave an orphaned
   * directory, which nothing reads and {@link sweepOrphans} removes.
   */
  async remove(recordingId: string): Promise<void> {
    await writeJsonAtomic(
      this.indexFile,
      (await this.list()).filter((entry) => entry.id !== recordingId),
    );
    await rm(this.dir(recordingId), { recursive: true, force: true });
  }

  /** Directories with no index entry — the residue of an interrupted delete. */
  async sweepOrphans(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.paths.recordings);
    } catch {
      return 0;
    }
    const known = new Set((await this.list()).map((entry) => entry.id));
    let removed = 0;
    for (const entry of entries) {
      if (!isRecordingId(entry) || known.has(entry)) continue;
      await rm(join(this.paths.recordings, entry), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  // --- the timeline -------------------------------------------------------

  async appendEvents(recordingId: string, events: readonly RecEvent[]): Promise<void> {
    await appendJsonl(this.file(recordingId, "events"), events);
  }

  /**
   * The timeline, in order.
   *
   * Unparseable records are skipped rather than fatal. A log written by an
   * older build with an event type this one has never heard of is still a
   * usable timeline, and refusing the whole file would make every past
   * recording unreadable the first time the schema moves.
   */
  async readEvents(recordingId: string): Promise<RecEvent[]> {
    const raw = await readJsonl(this.file(recordingId, "events"));
    const out: RecEvent[] = [];
    for (const entry of raw) {
      const parsed = RecEvent.safeParse(entry);
      if (parsed.success) out.push(parsed.data);
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  // --- derived artifacts --------------------------------------------------

  async readFrames(recordingId: string): Promise<FrameRecord[]> {
    const raw = await readJson<unknown>(this.file(recordingId, "frameManifest"), []);
    if (!Array.isArray(raw)) return [];
    const out: FrameRecord[] = [];
    for (const entry of raw) {
      const parsed = FrameRecord.safeParse(entry);
      if (parsed.success) out.push(parsed.data);
    }
    return out.sort((a, b) => a.tMs - b.tMs);
  }

  async writeFrames(recordingId: string, frames: readonly FrameRecord[]): Promise<void> {
    await writeJsonAtomic(this.file(recordingId, "frameManifest"), frames);
  }

  async readNarration(recordingId: string): Promise<NarrationTranscript | null> {
    const raw = await readJson<unknown>(this.file(recordingId, "narration"), null);
    if (raw === null) return null;
    const parsed = NarrationTranscript.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  async writeNarration(recordingId: string, transcript: NarrationTranscript): Promise<void> {
    await writeJsonAtomic(this.file(recordingId, "narration"), transcript);
  }

  async writeBundle(recordingId: string, bundle: SessionBundle): Promise<void> {
    await writeJsonAtomic(this.file(recordingId, "bundle"), bundle);
  }

  async readAnalysis(recordingId: string): Promise<RecordingAnalysis | null> {
    const raw = await readJson<unknown>(this.file(recordingId, "analysis"), null);
    if (raw === null) return null;
    const parsed = RecordingAnalysis.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  async writeAnalysis(recordingId: string, analysis: RecordingAnalysis): Promise<void> {
    await writeJsonAtomic(this.file(recordingId, "analysis"), analysis);
  }

  async readBuild(recordingId: string): Promise<RecordingBuild | null> {
    const raw = await readJson<unknown>(this.file(recordingId, "build"), null);
    if (raw === null) return null;
    const parsed = RecordingBuild.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  async writeBuild(recordingId: string, build: RecordingBuild): Promise<void> {
    await writeJsonAtomic(this.file(recordingId, "build"), build);
  }

  /** Bytes of screen video on disk. Zero means none was captured, or it went. */
  async videoBytes(recordingId: string): Promise<number> {
    try {
      return (await stat(this.file(recordingId, "video"))).size;
    } catch {
      return 0;
    }
  }
}
