import { join } from "node:path";
import { MediaSettingsInput, type MediaSettings } from "@iq/shared";
import { readJson, writeJsonAtomic } from "../util/jsonl.js";
import type { AppPaths } from "../config/paths.js";
import type { AuditLog } from "../audit/audit-log.js";

/**
 * Persisted media settings.
 *
 * Held in memory after load because {@link MediaSettingsStore.current}
 * is read on every status render and every recording start; a synchronous
 * getter is what lets the FFmpeg service take a `() => MediaSettings` and pick
 * up an edit without being rebuilt.
 *
 * Nothing here is a secret — tool paths and transcription preferences — so the whole
 * object is safe to read back to the UI, which is why there is no redaction
 * step of the sort the MCP registry needs.
 */
export class MediaSettingsStore {
  private settings: MediaSettings = MediaSettingsInput.parse({});

  constructor(
    private readonly paths: AppPaths,
    private readonly audit: AuditLog,
    private readonly correlationId: () => string,
  ) {}

  private get file(): string {
    return join(this.paths.config, "media.json");
  }

  async load(): Promise<MediaSettings> {
    const raw = await readJson<unknown>(this.file, {});
    const parsed = MediaSettingsInput.safeParse(raw);
    // A settings file written by a newer build, or hand-edited into nonsense,
    // must not stop the app booting: defaults are a working configuration.
    this.settings = parsed.success ? parsed.data : MediaSettingsInput.parse({});
    return this.settings;
  }

  current(): MediaSettings {
    return this.settings;
  }

  async save(input: MediaSettingsInput): Promise<MediaSettings> {
    const next = MediaSettingsInput.parse(input);
    this.settings = next;
    await writeJsonAtomic(this.file, next);

    // Audited because it changes where audio goes: switching the default engine
    // from `whisper` to `azure` means later recordings leave the device, and
    // that is exactly the sort of change an investigation needs dated.
    await this.audit.record({
      actor: { kind: "system" },
      action: "media.settings_saved",
      family: "media",
      outcome: "succeeded",
      correlationId: this.correlationId(),
      reason: `engine ${next.defaultEngine}`,
    });

    return next;
  }
}
