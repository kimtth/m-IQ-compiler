import { z } from "zod";

/**
 * The worked examples, as one contract.
 *
 * Every surface that ships examples used to own its own Load/Clear pair, its
 * own idea of "is this loaded", and its own channel to ask. Five different
 * answers to one question is why nobody could say what was real, and why the
 * flag that was supposed to govern all of it governed none of it.
 *
 * There is one hub now — `core/samples` — and this is what it speaks.
 */

export const SampleModuleId = z.enum([
  "memories",
  "knowledge",
  "iqcells",
  "automations",
  "plans",
  "project",
  "demos",
]);
export type SampleModuleId = z.infer<typeof SampleModuleId>;

/**
 * Where a module's samples actually live.
 *
 * `app` means the privileged side owns them: they are on disk under IQ_HOME and
 * the hub can report and change them. `device` means the renderer's own storage
 * — the demo IQ Cell library is `localStorage`, scoped to the browser profile,
 * so the privileged side cannot see it and must not claim to. Reporting a count
 * it cannot read would be a lie that only shows up on someone else's machine.
 */
export const SampleOwner = z.enum(["app", "device"]);
export type SampleOwner = z.infer<typeof SampleOwner>;

/**
 * The device-owned module, described once.
 *
 * The privileged side cannot read this module and must not claim to — but it
 * still has to *list* it, because the user asked one question and a list that
 * silently omits a module is not an answer. So both sides need the same two
 * sentences, and both used to hold their own copy: byte-identical strings in
 * `core/samples/samples-service.ts` and `renderer/samples/useSamples.ts`, with
 * nothing to keep them that way.
 *
 * The duplication was the visible cost of a deeper one — the IQ Cell library is
 * a store with one hard-wired `localStorage` implementation and no seam, so the
 * `device` case had to leak into the shared contract to be presentable at all.
 */
export const DEVICE_SAMPLE_MODULE = {
  id: "iqcells",
  label: "IQ Cell library & My IQ",
  detail: "The demo cells My IQ maps, published as ordinary records.",
  owner: "device",
} as const satisfies { id: SampleModuleId; label: string; detail: string; owner: SampleOwner };

export const SampleModuleStatus = z.object({
  id: SampleModuleId,
  /** How the surface names itself. */
  label: z.string(),
  /** What the examples are, in one sentence. */
  detail: z.string(),
  owner: SampleOwner,
  loaded: z.boolean(),
  /** What is there right now, in the module's own units. */
  summary: z.string(),
  /**
   * Set when the module's samples could act on their own and something about
   * them is worth saying out loud — an automation that is enabled, say.
   */
  warning: z.string().default(""),
});
export type SampleModuleStatus = z.infer<typeof SampleModuleStatus>;

export const SampleStatus = z.object({
  /** The global switch. Off hides every offer; it deletes nothing. */
  enabled: z.boolean(),
  modules: z.array(SampleModuleStatus),
});
export type SampleStatus = z.infer<typeof SampleStatus>;
