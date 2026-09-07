import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  ImageProvenance as ImageProvenanceSchema,
  ImageRun as ImageRunSchema,
  imageProvenanceFile,
  imageThreadId,
  type GeneratedImage,
  type ImageProvenance,
  type ImageRequest,
  type ImageRun,
} from "@iq/shared";
import type { ImageSources } from "../models/foundry-client.js";
import type { FoundryClient } from "../models/foundry-client.js";
import type { ModelRegistry } from "../models/registry.js";
import type { AuditLog } from "../audit/audit-log.js";
import { readJson, writeJsonAtomic } from "../util/jsonl.js";
import type { Logger } from "../util/logger.js";
import { hostOf as sharedHostOf, messageOf } from "../util/text.js";

/**
 * The Image Creation backend.
 *
 * The only image provider is a Microsoft Foundry deployment, resolved from the
 * model registry and reached with the Azure identity. This service adds three
 * things over the raw Foundry call, and each maps to a product requirement:
 *
 *  - **Provenance on every image.** A generated image is worthless as an audit
 *    subject unless it can be traced to the prompt and deployment that made it,
 *    so each carries full {@link ImageProvenance} — endpoint host only, never
 *    the full URL — and saving one writes that provenance beside the file.
 *  - **Capability enforcement.** A model that does not advertise `image` is
 *    refused before any call, so a chat deployment is never dialled for an image
 *    and the failure is a clear message rather than a 400 from the service.
 *  - **Containment on save.** Writing an image is the one place this service
 *    touches the filesystem, and it proves the target stays inside the bound
 *    project the same way {@link ProjectService} does: the path may not be
 *    absolute, may not climb out with `..`, and may not reach outside through a
 *    symlinked ancestor. The project tree is the visible boundary; a saved
 *    image must not be able to escape it.
 *
 * Runs are durable, the bytes are not.
 *
 * The history used to live in a field and nowhere else, and the consequence was
 * plain: generate two images, restart the app, and Image Creation came back
 * empty. The images were on disk the whole time — auto-save had put them in the
 * project with a provenance file each — but the surface that lists what was
 * asked for had forgotten every request, so there was no list and no grid.
 *
 * What is written is an index: the request, the status, the timings, and for
 * each image its id, its provenance and where it was saved. The base64 payload
 * is stripped. A run of four images is a few megabytes of data URL and a few
 * hundred bytes of index, and the payload is recoverable — the file is in the
 * project. The renderer reads it back through `project:read`, which is already
 * the containment-checked way this app turns a project file into something the
 * canvas can show.
 *
 * So an image generated with no project bound is still lost on restart. There
 * was nowhere to put it; the run survives, carrying its prompt and its result,
 * with nothing to display.
 */

/** The canvas shows a working set, not an archive; older runs fall off the end. */
const MAX_RUNS = 50;

export interface ImageServiceDeps {
  logger: Logger;
  audit: AuditLog;
  registry: ModelRegistry;
  client: FoundryClient;
  /** The bound project root, or null when no project is active. */
  projectDir: () => string | null;
  correlationId: () => string;
  /** Where the run index is kept, outside any project. */
  historyFile: string;
}

export class ImageService {
  private history: ImageRun[] = [];
  private readonly listeners = new Set<(run: ImageRun) => void>();
  /** The index is read once per process; every mutation writes it back. */
  private hydrated: Promise<void> | null = null;

  constructor(private readonly deps: ImageServiceDeps) {}

  onRun(listener: (run: ImageRun) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Most recent first, capped — the shape the canvas grid renders directly. */
  async runs(): Promise<ImageRun[]> {
    await this.load();
    return [...this.history];
  }

  /**
   * Put a finished run into the history without calling a model.
   *
   * This exists for the sample data, and it is deliberately narrow. Generating
   * a demo image needs a Foundry deployment, an image model and an image
   * credit; without those the surface opens empty and the feature cannot be
   * shown at all. Seeding writes the record for an image whose bytes are
   * already on disk, so the surface has something true to open on.
   *
   * The run is replaced by id rather than appended, so loading the samples
   * twice refreshes the demo instead of stacking a second copy of it. Nothing
   * is audited: no model was called, and no image was made.
   */
  async seed(run: ImageRun): Promise<void> {
    await this.load();
    const parsed = ImageRunSchema.parse(run);
    this.history = [parsed, ...this.history.filter((kept) => kept.id !== parsed.id)];
    await this.persist();
  }

  /**
   * Run one generation.
   *
   * The run object is returned whatever the outcome: a failed run is still a
   * legible card in the grid, carrying the error and its request, rather than a
   * thrown exception the UI has to reconstruct.
   *
   * A request may name the image it continues from instead of a source path.
   * That is what makes editing conversational — the surface says "change that
   * one" and this resolves where the file landed, joins the run to the same
   * conversation, and records the real source in the provenance.
   */
  async generate(request: ImageRequest): Promise<ImageRun> {
    await this.load();
    const correlationId = this.deps.correlationId();
    const startedAt = new Date().toISOString();
    const parent = this.findImage(request.parentImageId);
    const sourcePath =
      request.operation === "generate" || request.sourcePath !== ""
        ? request.sourcePath
        : (parent?.image.savedPath ?? "");
    const resolved: ImageRequest = { ...request, sourcePath };
    const run: ImageRun = {
      id: newRunId(),
      // A continuation joins its parent's conversation; anything else starts
      // one, and an empty thread id already means "this run is the thread".
      threadId: parent ? imageThreadId(parent.run) : "",
      status: "running",
      // The mask is a turn input, not a record. It is dropped here so it never
      // reaches the history, the index file or the emitted run.
      request: { ...resolved, maskDataUrl: "" },
      images: [],
      error: "",
      startedAt,
      finishedAt: null,
    };

    try {
      const entry = await this.deps.registry.entry(request.modelId);
      if (!entry) {
        throw new Error(
          `"${request.modelId}" is not a Foundry model; image generation needs a Foundry image deployment.`,
        );
      }
      if (!entry.capabilities.includes("image")) {
        throw new Error(
          `"${entry.displayName}" does not advertise image generation. Choose an image-capable model in Control Center → Models.`,
        );
      }
      if (
        entry.projectIds.length > 0 &&
        (request.projectId === null || !entry.projectIds.includes(request.projectId))
      ) {
        throw new Error(
          `"${entry.displayName}" is restricted to a different project. Choose an image model available in this project.`,
        );
      }

      const sources = await this.readSources(resolved, correlationId);
      const { images } = await this.deps.client.images(entry, resolved, sources);

      const endpointHost = hostOf(entry.endpoint);
      const generated: GeneratedImage[] = images.map((b64) => {
        const provenance: ImageProvenance = {
          modelId: request.modelId,
          deploymentName: entry.deploymentName,
          endpointHost,
          operation: request.operation,
          prompt: request.prompt,
          size: request.size,
          quality: request.quality,
          sourcePath,
          maskPath: request.maskPath,
          maskRegion: request.maskDataUrl !== "",
          createdAt: new Date().toISOString(),
          projectId: request.projectId,
          correlationId,
        };
        return {
          id: newImageId(),
          dataUrl: `data:image/png;base64,${b64}`,
          provenance,
          savedPath: "",
        };
      });

      run.images = generated;
      run.status = "succeeded";
      run.finishedAt = new Date().toISOString();

      // A generated image is a work artifact, so it lands in the project as
      // it is produced rather than living in a data URL until somebody
      // remembers to press Save. Two things went wrong without this: closing
      // the surface threw the image away, and an image the agent generated
      // during a turn was never on disk for the next step to use.
      //
      // Save-as still exists and still takes a path. This is the default
      // destination, not the only one.
      await this.autoSave(run, correlationId);

      await this.deps.audit.record({
        actor: { kind: "system" },
        action: "image.generate",
        family: "images",
        outcome: "succeeded",
        correlationId,
        resources: [entry.deploymentName, request.projectId ?? "(no project)"],
        reason: `${request.operation} × ${generated.length} on ${endpointHost}`,
      });
    } catch (error) {
      run.status = "failed";
      run.error = messageOf(error);
      run.finishedAt = new Date().toISOString();
      await this.deps.audit.record({
        actor: { kind: "system" },
        action: "image.generate",
        family: "images",
        outcome: "failed",
        correlationId,
        resources: [request.modelId, request.projectId ?? "(no project)"],
        reason: run.error,
      });
    }

    this.remember(run);
    await this.persist();
    return run;
  }

  /**
   * Persist one generated image into the bound project, with its provenance.
   *
   * Returns the project-relative path so the caller can open it in the canvas
   * and the navigator can highlight it. The bytes are never logged or audited;
   * only the deployment, the project and the destination path are recorded.
   *
   * This is "save as": every image is already written to `images/` as it is
   * generated. What this adds is a destination the user chose. An empty path
   * means "the default place" — the Save button in the surface sends no path,
   * and a path of "" resolves to the project root, which is a directory.
   */
  async save(runId: string, imageId: string, requestedPath: string): Promise<string> {
    await this.load();
    const run = this.history.find((candidate) => candidate.id === runId);
    const index = run?.images.findIndex((candidate) => candidate.id === imageId) ?? -1;
    const image = index >= 0 ? run?.images[index] : undefined;
    if (!run || !image) throw new Error("no such image in the current runs.");

    const path = requestedPath.trim() === "" ? defaultImagePath(run, index) : requestedPath;
    const written = await this.write(image, path);
    await this.persist();
    return written;
  }

  /**
   * Forget one run.
   *
   * It leaves the history list, and that is all it does. Files already written
   * to the project stay, and so does the audit entry: clearing a card off a
   * history dropdown is not consent to delete the person's images, and the
   * record of what was generated is not the user's to erase either.
   */
  async delete(runId: string): Promise<void> {
    await this.load();
    const index = this.history.findIndex((run) => run.id === runId);
    if (index < 0) return;
    this.history.splice(index, 1);
    await this.persist();
  }

  /**
   * Forget a whole conversation.
   *
   * The surface lists conversations, so this is the delete it can actually
   * offer. Removing one run out of the middle of a thread would leave the edits
   * that followed it pointing at a prompt nobody can read any more. Same rule
   * as {@link delete}: the files stay, the audit stays.
   */
  async deleteThread(threadId: string): Promise<void> {
    await this.load();
    const remaining = this.history.filter((run) => imageThreadId(run) !== threadId);
    if (remaining.length === this.history.length) return;
    this.history = remaining;
    await this.persist();
  }

  /**
   * The write itself, shared by save-as and by the automatic save.
   *
   * It takes the image rather than a pair of ids on purpose: the automatic save
   * runs before the finished run reaches `history`, so a lookup by id would find
   * nothing and every generated image would be dropped.
   */
  private async write(image: GeneratedImage, requestedPath: string): Promise<string> {
    const root = this.deps.projectDir();
    if (!root) throw new Error("bind a project before saving an image.");

    const { absolute, relativePath } = await this.resolveInside(root, requestedPath);

    const bytes = decodeDataUrl(image.dataUrl);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);

    const provenance: ImageProvenance = { ...image.provenance };
    await writeFile(
      `${absolute}.provenance.json`,
      `${JSON.stringify(provenance, null, 2)}\n`,
      "utf8",
    );

    image.savedPath = relativePath;

    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "image.save",
      family: "images",
      outcome: "succeeded",
      correlationId: this.deps.correlationId(),
      resources: [provenance.deploymentName, provenance.projectId ?? "(no project)", relativePath],
      reason: `saved ${imageProvenanceFile(relativePath)} beside the image`,
    });

    return relativePath;
  }

  // --- internals ------------------------------------------------------------

  /**
   * Put every image of a finished run into the project.
   *
   * Failure is recorded and swallowed: the generation succeeded, the bytes are
   * in the run, and turning "the disk is full" into "the image was never made"
   * would throw away the expensive half of the work. A run with no project
   * bound is left in memory — there is nowhere to put it, and refusing to
   * generate for want of a project would be a worse answer.
   */
  private async autoSave(run: ImageRun, correlationId: string): Promise<void> {
    if (this.deps.projectDir() === null) return;
    for (const [index, image] of run.images.entries()) {
      try {
        await this.write(image, defaultImagePath(run, index));
      } catch (error) {
        this.deps.logger.warn("generated image could not be saved to the project", {
          runId: run.id,
          error: messageOf(error),
        });
        await this.deps.audit.record({
          actor: { kind: "system" },
          action: "image.save",
          family: "images",
          outcome: "failed",
          correlationId,
          resources: [run.request.projectId ?? "(no project)"],
          reason: messageOf(error),
        });
      }
    }
  }

  /** Read the source and mask bytes for an edit/variation from the project. */
  private async readSources(request: ImageRequest, correlationId: string): Promise<ImageSources> {
    const sources: ImageSources = { correlationId };
    if (request.operation === "generate") return sources;

    const root = this.deps.projectDir();
    if (!root) throw new Error("bind a project before editing an image.");
    if (!request.sourcePath) {
      throw new Error(
        request.parentImageId === ""
          ? "an edit needs a project source image."
          : "the image being edited was never saved to the project, so there is nothing to read. Bind a project and generate it again.",
      );
    }

    const { readFile } = await import("node:fs/promises");
    const source = await this.resolveInside(root, request.sourcePath);
    sources.image = await readFile(source.absolute);
    sources.imageName = source.relativePath.split("/").pop() ?? "source.png";

    // A region painted in the surface wins over a mask file: it is the more
    // specific instruction, and it is the one the user just drew.
    if (request.maskDataUrl) {
      sources.mask = decodeDataUrl(request.maskDataUrl);
      sources.maskName = "mask.png";
    } else if (request.maskPath) {
      const mask = await this.resolveInside(root, request.maskPath);
      sources.mask = await readFile(mask.absolute);
      sources.maskName = mask.relativePath.split("/").pop() ?? "mask.png";
    }
    return sources;
  }

  /** Find a generated image anywhere in the history, with the run that made it. */
  private findImage(imageId: string): { run: ImageRun; image: GeneratedImage } | null {
    if (imageId === "") return null;
    for (const run of this.history) {
      const image = run.images.find((candidate) => candidate.id === imageId);
      if (image) return { run, image };
    }
    return null;
  }

  /**
   * Resolve a caller-supplied path against the project root and prove it stays
   * inside — the same guarantee {@link ProjectService} enforces for reads. The
   * root is realpath'd, and the deepest existing ancestor of the target is
   * realpath'd too, so a symlinked directory cannot redirect a write out of the
   * tree even though the destination file itself does not yet exist.
   */
  private async resolveInside(
    root: string,
    requested: string,
  ): Promise<{ absolute: string; relativePath: string }> {
    if (isAbsolute(requested)) throw new Error("path must be project-relative");
    const normalised = requested.replace(/\\/g, "/");

    const realRoot = await realpath(root).catch(() => resolve(root));
    const absolute = resolve(realRoot, normalised);
    const rel = relative(realRoot, absolute);
    if (rel === "") throw new Error("path must name a file inside the project");
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("path leaves the project");

    const realAncestor = await realpath(await deepestExisting(absolute)).catch(() => realRoot);
    const ancestorRel = relative(realRoot, realAncestor);
    if (ancestorRel.startsWith("..") || isAbsolute(ancestorRel)) {
      throw new Error("path leaves the project through a symlink");
    }

    return { absolute, relativePath: rel.split(sep).join("/") };
  }

  private remember(run: ImageRun): void {
    this.history.unshift(run);
    if (this.history.length > MAX_RUNS) this.history.length = MAX_RUNS;
    for (const listener of this.listeners) listener(run);
  }

  /**
   * Read the run index, once.
   *
   * A damaged or half-written index is dropped rather than thrown: losing the
   * list of past prompts is a nuisance, and refusing to generate a new image
   * because of it would be a worse answer to the same problem. Each run is
   * parsed on its own so one bad record costs one row, not the file.
   */
  private async load(): Promise<void> {
    this.hydrated ??= (async () => {
      const raw = await readJson<unknown[] | null>(this.deps.historyFile, null);
      if (raw === null) {
        this.history = await this.recover();
        if (this.history.length > 0) await this.persist();
        return;
      }
      if (!Array.isArray(raw)) return;
      const restored: ImageRun[] = [];
      for (const record of raw) {
        const parsed = ImageRunSchema.safeParse(record);
        if (parsed.success) restored.push(parsed.data);
        else
          this.deps.logger.warn("an image run could not be read; it is dropped from the history", {
            file: this.deps.historyFile,
          });
      }
      this.history = restored.slice(0, MAX_RUNS);
    })().catch((error: unknown) => {
      this.deps.logger.warn("the image history could not be read; starting empty", {
        file: this.deps.historyFile,
        error: messageOf(error),
      });
    });
    await this.hydrated;
  }

  /**
   * Rebuild the history from the project, once, when there is no index yet.
   *
   * Every image auto-save wrote is on disk with a `.provenance.json` beside it,
   * and that file holds everything the index does: the prompt, the operation,
   * the size, the quality, the deployment and the moment it was made. So the
   * first run of a build that persists the history does not start empty for
   * someone who has been generating images all along — their work comes back.
   *
   * Images are grouped by correlation id, which is what one generation shares.
   * The run id is synthesised from it; nothing downstream needs it to be the
   * original, because the only lookups by run id are save and delete, and both
   * take the id off the run they were handed.
   */
  private async recover(): Promise<ImageRun[]> {
    const root = this.deps.projectDir();
    if (root === null) return [];

    const dir = resolve(root, "images");
    const names = await readdir(dir).catch(() => [] as string[]);

    const groups = new Map<string, { provenance: ImageProvenance; savedPath: string }[]>();
    for (const name of names) {
      if (!name.endsWith(".provenance.json")) continue;
      const image = name.slice(0, -".provenance.json".length);
      try {
        const parsed = ImageProvenanceSchema.safeParse(
          JSON.parse(await readFile(resolve(dir, name), "utf8")),
        );
        if (!parsed.success) continue;
        const bucket = groups.get(parsed.data.correlationId) ?? [];
        bucket.push({ provenance: parsed.data, savedPath: `images/${image}` });
        groups.set(parsed.data.correlationId, bucket);
      } catch (error) {
        this.deps.logger.warn("a provenance file could not be read; its image is not recovered", {
          file: name,
          error: messageOf(error),
        });
      }
    }

    const runs: ImageRun[] = [];
    for (const [correlationId, members] of groups) {
      members.sort((a, b) => a.savedPath.localeCompare(b.savedPath));
      const first = members[0]!.provenance;
      runs.push({
        id: `run_recovered_${correlationId}`,
        threadId: "",
        status: "succeeded",
        request: {
          modelId: first.modelId,
          operation: first.operation,
          prompt: first.prompt,
          size: first.size,
          quality: first.quality,
          count: members.length,
          sourcePath: first.sourcePath,
          maskPath: first.maskPath,
          maskDataUrl: "",
          parentImageId: "",
          projectId: first.projectId,
        },
        images: members.map((member, index) => ({
          id: `img_recovered_${correlationId}_${index}`,
          dataUrl: "",
          provenance: member.provenance,
          savedPath: member.savedPath,
        })),
        error: "",
        startedAt: first.createdAt,
        finishedAt: first.createdAt,
      });
    }

    // Newest first, the order the surface reads.
    runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return runs.slice(0, MAX_RUNS);
  }

  /**
   * Write the index back, without the payload.
   *
   * `dataUrl` is emptied on the way out. It is the one field that is large, and
   * it is the one field that is recoverable: a saved image is a file in the
   * project, and the renderer reads it back through `project:read`. Keeping it
   * would put a few megabytes of base64 per run into a config file that is
   * rewritten on every save.
   *
   * A failure here is logged and swallowed. The generation happened, the file
   * is on disk, and turning "the index could not be written" into "the image
   * was never made" would throw away the expensive half of the work.
   */
  private async persist(): Promise<void> {
    const index = this.history.map((run) => ({
      ...run,
      images: run.images.map((image) => ({ ...image, dataUrl: "" })),
    }));
    try {
      await writeJsonAtomic(this.deps.historyFile, index);
    } catch (error) {
      this.deps.logger.warn("the image history could not be written", {
        file: this.deps.historyFile,
        error: messageOf(error),
      });
    }
  }
}

/** Walk up until an existing path is found, so a not-yet-created file can be checked. */
async function deepestExisting(path: string): Promise<string> {
  let current = path;
  for (;;) {
    const parent = dirname(current);
    if (await stat(current).then(() => true, () => false)) return current;
    if (parent === current) return current;
    current = parent;
  }
}

function decodeDataUrl(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(",");
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Buffer.from(payload, "base64");
}

/**
 * Where a generated image goes when nobody chose a path.
 *
 * Named for the prompt and the run rather than for a counter, because the
 * project navigator is the only place most of these are ever seen again and
 * `image-7.png` answers nothing. The run id makes it unique without a lookup —
 * two runs of the same prompt in the same second must not overwrite each other,
 * and asking the filesystem for a free name is a race.
 *
 * Always spelled with `/`: it is a project-relative path, and `resolveInside`
 * as well as every reader downstream matches on that form.
 */
function defaultImagePath(run: ImageRun, index: number): string {
  const stem =
    run.request.prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "image";
  const suffix = run.images.length > 1 ? `-${index + 1}` : "";
  return `images/${stem}-${run.id.slice(-6)}${suffix}.png`;
}

const hostOf = (url: string): string => sharedHostOf(url, "");

function newRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function newImageId(): string {
  return `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
