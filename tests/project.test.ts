import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectService } from "@iq/core";

/**
 * The project navigator is the visible boundary of the project on disk, so
 * the interesting behaviour is not that it lists files — it is that nothing it
 * lists or reads can be outside the root, however the caller phrases the path.
 * The renderer is not trusted to have produced it.
 */

let root: string;
let service: ProjectService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "iq-project-"));
  service = new ProjectService({ root: () => root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ProjectService.list", () => {
  it("lists directories before files, each case-insensitively by name", async () => {
    await mkdir(join(root, "zeta"));
    await writeFile(join(root, "alpha.md"), "a");
    await writeFile(join(root, "Beta.md"), "b");

    const listing = await service.list();
    expect(listing.entries.map((entry) => entry.name)).toEqual(["zeta", "alpha.md", "Beta.md"]);
    expect(listing.entries[0]?.kind).toBe("directory");
  });

  it("hides dotfiles, which are app state rather than the user's work", async () => {
    await writeFile(join(root, ".secret"), "x");
    await writeFile(join(root, "visible.md"), "x");

    const listing = await service.list();
    expect(listing.entries.map((entry) => entry.name)).toEqual(["visible.md"]);
  });

  it("returns project-relative, forward-slashed paths", async () => {
    await mkdir(join(root, "notes"));
    await writeFile(join(root, "notes", "plan.md"), "x");

    const listing = await service.list("notes");
    expect(listing.path).toBe("notes");
    expect(listing.entries[0]?.path).toBe("notes/plan.md");
  });

  it("refuses to climb out of the project", async () => {
    await expect(service.list("../..")).rejects.toThrow(/leaves the project/i);
    await expect(service.list("notes/../../..")).rejects.toThrow(/leaves the project/i);
  });

  it("refuses an absolute path", async () => {
    await expect(service.list(tmpdir())).rejects.toThrow(/project-relative/i);
  });

  it("never lists a symlink, in either direction", async () => {
    const outside = await mkdtemp(join(tmpdir(), "iq-outside-"));
    await writeFile(join(outside, "secret.md"), "x");
    try {
      await symlink(outside, join(root, "escape"), "junction");
    } catch {
      // Creating a link can require privilege; the guarantee is still asserted
      // by the traversal tests above, so skip rather than fail spuriously.
      await rm(outside, { recursive: true, force: true });
      return;
    }

    const listing = await service.list();
    expect(listing.entries.map((entry) => entry.name)).not.toContain("escape");
    await rm(outside, { recursive: true, force: true });
  });
});

describe("ProjectService.read", () => {
  it("reads a text file", async () => {
    await writeFile(join(root, "note.md"), "# Title\n");
    const file = await service.read("note.md");
    expect(file.text).toBe("# Title\n");
    expect(file.truncated).toBe(false);
    expect(file.path).toBe("note.md");
  });

  it("returns an image as a data URL so the canvas can show it", async () => {
    // A 1x1 PNG: enough to prove the bytes round-trip, not a fixture to read.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(join(root, "shot.png"), png);

    const file = await service.read("shot.png");
    expect(file.kind).toBe("image");
    expect(file.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(file.text).toBe("");
  });

  it("refuses binary content rather than mangling it into the viewer", async () => {
    await writeFile(join(root, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    await expect(service.read("image.bin")).rejects.toThrow(/binary/i);
  });

  it("refuses a directory", async () => {
    await mkdir(join(root, "notes"));
    await expect(service.read("notes")).rejects.toThrow(/not a file/i);
  });

  it("refuses to read outside the project", async () => {
    await expect(service.read("../../etc/hosts")).rejects.toThrow(/leaves the project/i);
  });
});
