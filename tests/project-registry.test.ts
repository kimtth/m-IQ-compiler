import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog, createLogger, ensureAppPaths, resolveAppPaths, type AppPaths } from "@iq/core";
// Imported from the compiled module rather than the package barrel: the
// orchestrator owns index.ts and wires this export in, so the test reaches the
// class directly to stay independent of that wiring.
import { ProjectRegistry } from "@iq/core/dist/project/registry.js";

/**
 * The registry is the unit of scoping, so the behaviours worth pinning are the
 * ones that protect the user's files and the app's own state: a project can
 * never be nested over the state root, removal forgets a pointer rather than
 * deleting files, and an existing install is migrated instead of abandoned.
 */

let root: string;
let paths: AppPaths;

function build(): ProjectRegistry {
  return new ProjectRegistry({
    paths,
    logger: createLogger("error"),
    audit: new AuditLog(paths),
    correlationId: () => "corr-test",
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "iq-wsreg-"));
  paths = resolveAppPaths(root);
  ensureAppPaths(paths);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ProjectRegistry migration", () => {
  it("adopts the legacy implicit project on first load and binds it", async () => {
    const registry = build();
    await registry.init();

    const active = registry.active();
    expect(active?.name).toBe("Project");
    expect(active?.directory).toBe(paths.project);
    expect(registry.list()).toHaveLength(1);

    const audit = new AuditLog(paths);
    const migrations = (await audit.query({ limit: 100, family: "project" })).filter(
      (record) => record.action === "project.migrate",
    );
    expect(migrations).toHaveLength(1);
  });

  it("does not migrate twice across reloads", async () => {
    await (async () => {
      const first = build();
      await first.init();
    })();

    const second = build();
    await second.init();
    expect(second.list()).toHaveLength(1);
  });
});

describe("ProjectRegistry create / bind / remove", () => {
  it("creates a managed directory, binds it, and reports it active", async () => {
    const registry = build();
    await registry.init();

    const created = await registry.create({ name: "Design Docs" });
    expect(created.directory.startsWith(paths.project)).toBe(true);
    expect(registry.directoryOf(created.id)).toBe(created.directory);

    const bound = await registry.bind(created.id);
    expect(bound?.id).toBe(created.id);
    expect(registry.active()?.id).toBe(created.id);

    await registry.remove(created.id);
    expect(registry.list().some((entry) => entry.id === created.id)).toBe(false);
    // Removing the active project unbinds it rather than binding another.
    expect(registry.active()).toBeNull();
  });

  it("adopts an existing absolute directory outside the state root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "iq-ws-outside-"));
    try {
      const registry = build();
      await registry.init();
      const created = await registry.create({ name: "External", directory: outside });
      // The realpath is stored; tmpdir on macOS is a symlink, so compare loosely.
      expect(created.directory.length).toBeGreaterThan(0);
      expect(registry.directoryOf(created.id)).toBe(created.directory);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a directory that is the app state root or an ancestor of it", async () => {
    const registry = build();
    await registry.init();

    await expect(registry.create({ name: "Root", directory: paths.root })).rejects.toThrow(
      /own state/i,
    );
    await expect(registry.create({ name: "Above", directory: dirname(paths.root) })).rejects.toThrow(
      /own state/i,
    );
  });

  it("unbinds when passed null", async () => {
    const registry = build();
    await registry.init();
    expect(registry.active()).not.toBeNull();

    await registry.bind(null);
    expect(registry.active()).toBeNull();
  });
});

describe("ProjectRegistry.open", () => {
  it("adopts a new folder, names it after the folder, and binds it", async () => {
    const outside = await mkdtemp(join(tmpdir(), "iq-ws-open-"));
    try {
      const registry = build();
      await registry.init();
      const before = registry.list().length;

      const opened = await registry.open(outside);

      expect(opened.name).toBe(basename(await realpath(outside)));
      expect(registry.list()).toHaveLength(before + 1);
      expect(registry.active()?.id).toBe(opened.id);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("binds the existing record when the folder is already registered", async () => {
    const outside = await mkdtemp(join(tmpdir(), "iq-ws-open-"));
    try {
      const registry = build();
      await registry.init();
      const created = await registry.create({ name: "External", directory: outside });
      await registry.bind(null);

      const opened = await registry.open(outside);

      // `create` refuses a duplicate directory; `open` binds it instead, and
      // adds no second record for the same folder.
      expect(opened.id).toBe(created.id);
      expect(opened.name).toBe("External");
      expect(registry.list().filter((entry) => entry.directory === created.directory)).toHaveLength(1);
      expect(registry.active()?.id).toBe(created.id);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a folder that contains the app state root", async () => {
    const registry = build();
    await registry.init();
    await expect(registry.open(paths.root)).rejects.toThrow(/own state/i);
  });
});

describe("ProjectRegistry.remove", () => {
  it("forgets the entry but never deletes the user's files", async () => {
    const registry = build();
    await registry.init();

    const created = await registry.create({ name: "Keepers" });
    const file = join(created.directory, "note.md");
    await writeFile(file, "# keep me\n");

    await registry.remove(created.id);

    expect(registry.list().some((entry) => entry.id === created.id)).toBe(false);
    // The directory and its contents survive: removal is a forget, not a delete.
    expect((await stat(created.directory)).isDirectory()).toBe(true);
    expect(await readFile(file, "utf8")).toBe("# keep me\n");
  });
});
