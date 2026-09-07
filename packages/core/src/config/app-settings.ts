import { join } from "node:path";
import { AppSettingsInput, type AppSettings } from "@iq/shared";
import { readJson, writeJsonAtomic } from "../util/jsonl.js";
import type { AppPaths } from "./paths.js";
import type { AuditLog } from "../audit/audit-log.js";

/**
 * Settings about the app rather than about one workload.
 *
 * Shaped like {@link MediaSettingsStore} on purpose: loaded once, held in
 * memory, and read through a synchronous getter so a caller can take a
 * `() => AppSettings` and see an edit without being rebuilt.
 *
 * Nothing here is a secret, so the whole object goes back to the UI unredacted.
 */
export class AppSettingsStore {
  private settings: AppSettings = AppSettingsInput.parse({});

  constructor(
    private readonly paths: AppPaths,
    private readonly audit: AuditLog,
    private readonly correlationId: () => string,
  ) {}

  private get file(): string {
    return join(this.paths.config, "app.json");
  }

  async load(): Promise<AppSettings> {
    const raw = await readJson<unknown>(this.file, {});
    const parsed = AppSettingsInput.safeParse(raw);
    // A file written by a newer build, or hand-edited into nonsense, must not
    // stop the app booting: the defaults are a working configuration.
    this.settings = parsed.success ? parsed.data : AppSettingsInput.parse({});
    return this.settings;
  }

  current(): AppSettings {
    return this.settings;
  }

  async save(input: AppSettings): Promise<AppSettings> {
    const next = AppSettingsInput.parse(input);
    this.settings = next;
    await writeJsonAtomic(this.file, next);

    // Audited because turning sample data on puts made-up records beside real
    // ones. Someone reading a memory or a knowledge note months later needs to
    // be able to date when examples were being shown.
    await this.audit.record({
      actor: { kind: "system" },
      action: "app.settings_saved",
      family: "app",
      outcome: "succeeded",
      correlationId: this.correlationId(),
      reason: `sample data ${next.sampleData ? "shown" : "hidden"}`,
    });

    return next;
  }
}
