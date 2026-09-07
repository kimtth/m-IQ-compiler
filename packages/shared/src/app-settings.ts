import { z } from "zod";

/**
 * Settings that describe the app itself rather than any one surface.
 *
 * Deliberately tiny. Anything that belongs to a workload — media tools, the
 * model registry, MCP servers — is that workload's own store, because a single
 * "settings" object is where unrelated concerns go to become coupled.
 */
export const AppSettingsInput = z.object({
  /**
   * Whether the built-in sample data is offered and shown.
   *
   * Persisted here because it is a setting; everything else about it — which
   * modules it governs, what they contain, what loading one is allowed to do —
   * belongs to the samples hub in `core/samples`, and is reached through the
   * `samples:*` channels rather than through this file.
   *
   * On by default: a fresh install has nothing else in it, and an empty app is
   * a worse first impression than an obviously labelled example.
   */
  sampleData: z.boolean().default(true),
});

export type AppSettings = z.infer<typeof AppSettingsInput>;
