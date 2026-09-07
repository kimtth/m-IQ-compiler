import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imageThreads } from "@iq/shared";
import type { FoundryModelInput, ImageRequest } from "@iq/shared";
import { AuditLog } from "../packages/core/src/audit/audit-log.js";
import { createLogger } from "../packages/core/src/util/logger.js";
import { ensureAppPaths, resolveAppPaths, type AppPaths } from "../packages/core/src/config/paths.js";
import { FoundryClient } from "../packages/core/src/models/foundry-client.js";
import { ModelRegistry } from "../packages/core/src/models/registry.js";
import { ImageService } from "../packages/core/src/images/image-service.js";

/**
 * The Image Creation backend earns its keep with three properties, so these
 * tests pin exactly those: a generated image carries full provenance with the
 * endpoint host only, a model that cannot generate images is refused before any
 * call, and — the one that matters most — a saved image cannot escape the bound
 * project, however the destination path is phrased.
 *
 * Editing is conversational, so a fourth group pins that too: a turn that names
 * the image it continues from joins that image's conversation and reads its
 * file, without the surface ever handling a path.
 */

let root: string;
let project: string;
let paths: AppPaths;
let imageBytes: string;

const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");

const foundryInput = (over: Partial<FoundryModelInput> = {}): FoundryModelInput =>
  ({
    id: "img1",
    displayName: "Foundry Image",
    endpoint: "https://demo.openai.azure.com/",
    deploymentName: "img-deploy",
    apiVersion: "2024-10-21",
    capabilities: ["image"],
    projectIds: [],
    ...over,
  }) as FoundryModelInput;

const request = (over: Partial<ImageRequest> = {}): ImageRequest =>
  ({
    modelId: "foundry:img1",
    operation: "generate",
    prompt: "a small red boat",
    size: "1024x1024",
    quality: "auto",
    count: 1,
    sourcePath: "",
    maskPath: "",
    maskDataUrl: "",
    parentImageId: "",
    projectId: "ws-1",
    ...over,
  }) as ImageRequest;

async function makeService(): Promise<{ service: ImageService; registry: ModelRegistry }> {
  const logger = createLogger("error");
  const audit = new AuditLog(paths);
  const client = new FoundryClient({
    logger,
    token: async () => "fake-token",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ data: [{ b64_json: imageBytes }] }), {
        status: 200,
      })) as typeof fetch,
  });
  const registry = new ModelRegistry({
    paths,
    logger,
    audit,
    client,
    copilotModels: async () => [],
    correlationId: () => "corr-img",
  });
  const service = new ImageService({
    logger,
    audit,
    registry,
    client,
    projectDir: () => project,
    correlationId: () => "corr-img",
    historyFile: join(paths.config, "image-runs.json"),
  });
  return { service, registry };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "iq-images-"));
  paths = resolveAppPaths(root);
  await ensureAppPaths(paths);
  project = join(root, "project");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(project, { recursive: true });
  imageBytes = PNG_B64;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ImageService.generate", () => {
  it("produces an image carrying full provenance, endpoint host only", async () => {
    const { service, registry } = await makeService();
    await registry.upsert(foundryInput());

    const run = await service.generate(request());
    expect(run.status).toBe("succeeded");
    expect(run.images).toHaveLength(1);

    const provenance = run.images[0]!.provenance;
    expect(provenance.deploymentName).toBe("img-deploy");
    expect(provenance.endpointHost).toBe("demo.openai.azure.com");
    expect(provenance.prompt).toBe("a small red boat");
    expect(provenance.correlationId).toBe("corr-img");
    expect(run.images[0]!.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("refuses a model that does not advertise the image capability", async () => {
    const { service, registry } = await makeService();
    await registry.upsert(foundryInput({ capabilities: ["chat"] }));

    const run = await service.generate(request());
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/image/i);
  });

  it("refuses a model restricted to a different project", async () => {
    const { service, registry } = await makeService();
    await registry.upsert(foundryInput({ projectIds: ["ws-other"] }));

    const run = await service.generate(request());
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/restricted to a different project/i);
  });

  it("keeps the most recent run first in runs()", async () => {
    const { service, registry } = await makeService();
    await registry.upsert(foundryInput());

    await service.generate(request({ prompt: "first" }));
    await service.generate(request({ prompt: "second" }));
    expect((await service.runs())[0]!.request.prompt).toBe("second");
  });

  /**
   * The defect this pins: the history lived in a field and nowhere else, so
   * generating an image and restarting the app left Image Creation with no
   * list of past prompts and no grid — while the images sat in the project the
   * whole time. A second service over the same app home is what a restart is.
   */
  it("still lists what was generated after a restart", async () => {
    const first = await makeService();
    await first.registry.upsert(foundryInput());
    await first.service.generate(request({ prompt: "a small red boat" }));

    const { service } = await makeService();
    const runs = await service.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.request.prompt).toBe("a small red boat");
    expect(runs[0]!.status).toBe("succeeded");
    // The saved path survives, because that is how the bytes are found again.
    expect(runs[0]!.images[0]!.savedPath).toMatch(/^images\/.*\.png$/);
  });

  // The payload is the one field that is both large and recoverable, so it is
  // the one field the index does not carry. A run of four 1024px images is a
  // few megabytes of base64 and a few hundred bytes of index.
  it("keeps the base64 payload out of the persisted index", async () => {
    const { service, registry } = await makeService();
    await registry.upsert(foundryInput());
    await service.generate(request());

    const index = readFileSync(join(paths.config, "image-runs.json"), "utf8");
    expect(index).not.toContain(PNG_B64);
    expect(index).toContain("a small red boat");
  });

  it("forgets a deleted run across a restart", async () => {
    const first = await makeService();
    await first.registry.upsert(foundryInput());
    const run = await first.service.generate(request());
    await first.service.delete(run.id);

    const { service } = await makeService();
    expect(await service.runs()).toHaveLength(0);
  });

  // Images made before there was an index are still on disk with their
  // provenance beside them, so the first read rebuilds the history from the
  // project rather than starting empty.
  it("rebuilds the history from the project when there is no index", async () => {
    const first = await makeService();
    await first.registry.upsert(foundryInput());
    await first.service.generate(request({ prompt: "a small red boat" }));
    rmSync(join(paths.config, "image-runs.json"));

    const { service } = await makeService();
    const runs = await service.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.request.prompt).toBe("a small red boat");
    expect(runs[0]!.images[0]!.savedPath).toMatch(/^images\/.*\.png$/);
    // Rebuilt once, then written down.
    expect(existsSync(join(paths.config, "image-runs.json"))).toBe(true);
  });

  // A generated image that only lives in a data URL is lost the moment the
  // surface closes, and the next step cannot use it. The automatic save runs
  // before the finished run reaches the history list, so this also pins that
  // the write does not depend on a lookup by run id.
  it("writes every generated image into the project as it is produced", async () => {
    const { service, registry } = await makeService();
    await registry.upsert(foundryInput());

    const run = await service.generate(request());
    const saved = run.images[0]!.savedPath;

    expect(saved).toMatch(/^images\/a-small-red-boat-[a-z0-9]+\.png$/);
    expect(existsSync(join(project, saved))).toBe(true);
    expect(existsSync(join(project, `${saved}.provenance.json`))).toBe(true);
  });
});

/**
 * An image is a draft and the work is what follows, so a turn has to be able to
 * say "change that one" and nothing more. The surface names the image; the
 * source path, the conversation it belongs to and the record of what was
 * changed are all resolved here.
 */
describe("ImageService.generate (conversation)", () => {
  it("joins the conversation of the image it continues from", async () => {
    const { service, registry } = await makeService();
    await registry.upsert(foundryInput());

    const first = await service.generate(request({ prompt: "a small red boat" }));
    const second = await service.generate(
      request({
        prompt: "make the sail yellow",
        operation: "edit",
        parentImageId: first.images[0]!.id,
      }),
    );
    const third = await service.generate(
      request({
        prompt: "and move it left",
        operation: "edit",
        parentImageId: second.images[0]!.id,
      }),
    );

    expect(second.threadId).toBe(first.id);
    expect(third.threadId).toBe(first.id);

    const threads = imageThreads(await service.runs());
    expect(threads).toHaveLength(1);
    expect(threads[0]!.runs.map((run) => run.request.prompt)).toEqual([
      "a small red boat",
      "make the sail yellow",
      "and move it left",
    ]);
  });

  it("starts a new conversation when no parent is named", async () => {
    const { service, registry } = await makeService();
    await registry.upsert(foundryInput());

    await service.generate(request({ prompt: "first" }));
    await service.generate(request({ prompt: "second" }));

    expect(imageThreads(await service.runs())).toHaveLength(2);
  });

  // The surface never handles a path. It names the image, and where that image
  // landed in the project is looked up here.
  it("reads the source from the parent image when the request gives no path", async () => {
    const { service, registry } = await makeService();
    await registry.upsert(foundryInput());

    const first = await service.generate(request());
    const edit = await service.generate(
      request({ prompt: "warmer light", operation: "edit", parentImageId: first.images[0]!.id }),
    );

    expect(edit.status).toBe("succeeded");
    expect(edit.request.sourcePath).toBe(first.images[0]!.savedPath);
    expect(edit.images[0]!.provenance.sourcePath).toBe(first.images[0]!.savedPath);
  });

  // The mask itself is a turn input and is not kept, so without this flag the
  // record would claim the whole image was regenerated when a patch of it was.
  it("records that an edit was confined to a painted area, without keeping the mask", async () => {
    const { service, registry } = await makeService();
    await registry.upsert(foundryInput());

    const first = await service.generate(request());
    const mask = `data:image/png;base64,${Buffer.from("fake-mask-bytes").toString("base64")}`;
    const edit = await service.generate(
      request({
        prompt: "remove the flag",
        operation: "edit",
        parentImageId: first.images[0]!.id,
        maskDataUrl: mask,
      }),
    );

    expect(edit.images[0]!.provenance.maskRegion).toBe(true);
    expect(edit.request.maskDataUrl).toBe("");
    expect(readFileSync(join(paths.config, "image-runs.json"), "utf8")).not.toContain("fake-mask");
  });

  it("forgets a whole conversation and leaves the images in the project", async () => {
    const { service, registry } = await makeService();
    await registry.upsert(foundryInput());

    const first = await service.generate(request());
    const edit = await service.generate(
      request({ prompt: "warmer light", operation: "edit", parentImageId: first.images[0]!.id }),
    );
    const other = await service.generate(request({ prompt: "unrelated" }));

    await service.deleteThread(first.id);

    const left = await service.runs();
    expect(left.map((run) => run.id)).toEqual([other.id]);
    expect(existsSync(join(project, first.images[0]!.savedPath))).toBe(true);
    expect(existsSync(join(project, edit.images[0]!.savedPath))).toBe(true);
  });
});

describe("ImageService.save (project containment)", () => {
  it("saves an image and its provenance beside it, returning a relative path", async () => {
    const { service, registry } = await makeService();
    await registry.upsert(foundryInput());
    const run = await service.generate(request());

    const saved = await service.save(run.id, run.images[0]!.id, "art/boat.png");
    expect(saved).toBe("art/boat.png");
    expect(existsSync(join(project, "art", "boat.png"))).toBe(true);

    const provenance = JSON.parse(
      readFileSync(join(project, "art", "boat.png.provenance.json"), "utf8"),
    ) as { deploymentName: string; endpointHost: string };
    expect(provenance.deploymentName).toBe("img-deploy");
    expect(provenance.endpointHost).toBe("demo.openai.azure.com");
  });

  it("refuses a path that climbs out of the project", async () => {
    const { service, registry } = await makeService();
    await registry.upsert(foundryInput());
    const run = await service.generate(request());

    await expect(
      service.save(run.id, run.images[0]!.id, "../escape.png"),
    ).rejects.toThrow(/leaves the project/i);
    await expect(
      service.save(run.id, run.images[0]!.id, "a/../../escape.png"),
    ).rejects.toThrow(/leaves the project/i);
    expect(existsSync(join(root, "escape.png"))).toBe(false);
  });

  it("refuses an absolute destination path", async () => {
    const { service, registry } = await makeService();
    await registry.upsert(foundryInput());
    const run = await service.generate(request());

    await expect(
      service.save(run.id, run.images[0]!.id, join(tmpdir(), "out.png")),
    ).rejects.toThrow(/project-relative/i);
  });

  // The Save button in the surface sends no path. An empty path used to resolve
  // to the project root — a directory — so the save always failed.
  it("treats an empty path as the default place in the project", async () => {
    const { service, registry } = await makeService();
    await registry.upsert(foundryInput());
    const run = await service.generate(request());

    const saved = await service.save(run.id, run.images[0]!.id, "");
    expect(saved).toMatch(/^images\/.+\.png$/);
    expect(existsSync(join(project, saved))).toBe(true);
  });
});
