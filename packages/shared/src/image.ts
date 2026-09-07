import { z } from "zod";

/**
 * Image Creation contracts.
 *
 * The only image provider is a Microsoft Foundry deployment selected in
 * Connections & access, reached with the Azure identity. Every generation
 * carries its provenance, and saving an image writes that provenance beside it
 * so an image in the project can always be traced back to the prompt and the
 * deployment that produced it.
 */

export const ImageOperation = z.enum(["generate", "edit", "variation"]);
export type ImageOperation = z.infer<typeof ImageOperation>;

export const ImageSize = z.enum(["1024x1024", "1024x1536", "1536x1024", "auto"]);
export type ImageSize = z.infer<typeof ImageSize>;

export const ImageQuality = z.enum(["low", "medium", "high", "auto"]);
export type ImageQuality = z.infer<typeof ImageQuality>;

/**
 * Ceiling on an inline mask, in base64 characters.
 *
 * A 1024×1536 PNG mask is a few hundred kilobytes even when most of it is one
 * flat colour, so the limit is generous. It exists because the value crosses
 * IPC from the untrusted renderer and every such field needs a bound.
 */
const MAX_MASK_CHARS = 8_000_000;

export const ImageRequest = z.object({
  /** Catalogue id of a Foundry entry advertising the `image` capability. */
  modelId: z.string().min(1),
  operation: ImageOperation.default("generate"),
  prompt: z.string().min(1).max(4_000),
  size: ImageSize.default("1024x1024"),
  quality: ImageQuality.default("auto"),
  count: z.number().int().min(1).max(4).default(1),
  /** Project-relative source image, required for `edit` and `variation`. */
  sourcePath: z.string().max(4096).default(""),
  /** Project-relative mask, optional and only meaningful for `edit`. */
  maskPath: z.string().max(4096).default(""),
  /**
   * A mask painted on the image in the surface, as a PNG data URL.
   *
   * This is the region selector, and it is a turn input rather than a project
   * artifact: it describes one edit and is meaningless afterwards, so it is
   * never written to disk and never stored on the run. Transparent pixels are
   * the area to change, which is the convention the image API already reads.
   *
   * It exists because the renderer has no way to write a file — deliberately —
   * so a mask it paints has to travel as bytes or not at all.
   */
  maskDataUrl: z.string().max(MAX_MASK_CHARS).default(""),
  /**
   * The image this turn continues from, or "" to start a new image.
   *
   * Naming the image rather than its path is what makes editing conversational:
   * the surface says "change that one", and the privileged side looks up where
   * the file landed. A path is also not an identity — two runs can be told to
   * save to the same place.
   */
  parentImageId: z.string().max(200).default(""),
  projectId: z.string().nullable().default(null),
});
export type ImageRequest = z.infer<typeof ImageRequest>;

/**
 * Everything needed to explain, reproduce or audit one image.
 *
 * The endpoint is recorded host-only for the same reason browser audit is:
 * a full URL can carry a token in its path.
 */
export const ImageProvenance = z.object({
  modelId: z.string(),
  deploymentName: z.string(),
  endpointHost: z.string(),
  operation: ImageOperation,
  prompt: z.string(),
  size: ImageSize,
  quality: ImageQuality,
  sourcePath: z.string().default(""),
  maskPath: z.string().default(""),
  /**
   * True when the edit was confined to a region painted in the surface.
   *
   * The mask itself is not kept, so without this the record would say the whole
   * image was regenerated when only a patch of it was — the difference matters
   * to anyone asked to explain the result.
   */
  maskRegion: z.boolean().default(false),
  createdAt: z.string().datetime(),
  projectId: z.string().nullable().default(null),
  correlationId: z.string(),
});
export type ImageProvenance = z.infer<typeof ImageProvenance>;

export const GeneratedImage = z.object({
  id: z.string(),
  /** Inline result, shown before the user decides to keep it. */
  dataUrl: z.string(),
  provenance: ImageProvenance,
  /** Project-relative path once saved, or "" while it is only in memory. */
  savedPath: z.string().default(""),
});
export type GeneratedImage = z.infer<typeof GeneratedImage>;

export const ImageRunStatus = z.enum(["running", "succeeded", "failed"]);
export type ImageRunStatus = z.infer<typeof ImageRunStatus>;

export const ImageRun = z.object({
  id: z.string(),
  /**
   * The image conversation this run belongs to.
   *
   * Empty means the run is a conversation of one — which is what every run
   * written before threads existed is, and what a fresh prompt starts. Read it
   * through {@link imageThreadId} rather than directly.
   */
  threadId: z.string().default(""),
  status: ImageRunStatus,
  request: ImageRequest,
  images: z.array(GeneratedImage).default([]),
  error: z.string().default(""),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable().default(null),
});
export type ImageRun = z.infer<typeof ImageRun>;

/** File name written next to a saved image, holding its provenance. */
export const imageProvenanceFile = (imagePath: string): string => `${imagePath}.provenance.json`;

/** The conversation a run belongs to. A run that starts one is its own thread. */
export const imageThreadId = (run: ImageRun): string => (run.threadId === "" ? run.id : run.threadId);

/**
 * One image conversation: a first prompt and every edit made to what came back.
 *
 * Making an image is not a single-shot request. The first result is a draft,
 * and the work is what follows — "warmer light", "lose the text", "same but
 * portrait". So the unit the surface lists is the conversation, not the run.
 */
export interface ImageThread {
  id: string;
  /** Oldest first: the order the conversation is read in. */
  runs: ImageRun[];
  /** What was asked for first. It is what the thread is about. */
  title: string;
  /** The most recent run's start, for sorting and for the list. */
  updatedAt: string;
}

/**
 * Group runs into conversations.
 *
 * Takes the history newest first — the order the service and the IPC channel
 * hand it over — and answers newest conversation first, each with its runs the
 * other way round. Grouping is by {@link imageThreadId}, so a history written
 * before threads existed comes back as one conversation per run rather than as
 * one enormous thread or as nothing.
 */
export function imageThreads(runs: readonly ImageRun[]): ImageThread[] {
  const byId = new Map<string, ImageRun[]>();
  for (const run of runs) {
    const id = imageThreadId(run);
    const bucket = byId.get(id);
    if (bucket) bucket.push(run);
    else byId.set(id, [run]);
  }
  return [...byId].map(([id, members]) => {
    const ordered = [...members].reverse();
    return {
      id,
      runs: ordered,
      title: ordered[0]?.request.prompt ?? "",
      updatedAt: members[0]?.startedAt ?? "",
    };
  });
}
