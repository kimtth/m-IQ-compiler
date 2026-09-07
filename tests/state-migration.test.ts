import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAppPaths, type AppPaths } from "@iq/core";
import { migrateWorkspaceToProject } from "@iq/core/dist/config/migrate.js";

/**
 * The rename touched state a user already has on disk, so the migration is
 * where an upgrade either keeps their work or loses it. The cases worth pinning
 * are the ones that would be silent failures: state that moves, keys that are
 * rewritten, and — most of all — Fabric's own `workspaceId`, which addresses a
 * real workspace in Fabric's API and must survive untouched.
 */

let root: string;
let paths: AppPaths;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "iq-migrate-"));
  paths = resolveAppPaths(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
};

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

const exists = async (path: string): Promise<boolean> =>
  stat(path)
    .then(() => true)
    .catch(() => false);

describe("migrateWorkspaceToProject", () => {
  it("moves the state directory and the files inside it", async () => {
    await mkdir(join(root, "workspace", "acme"), { recursive: true });
    await writeFile(join(root, "workspace", "acme", "notes.md"), "kept", "utf8");

    const report = await migrateWorkspaceToProject(paths);

    expect(report.movedStateDir).toBe(true);
    expect(await exists(join(root, "workspace"))).toBe(false);
    expect(await readFile(join(root, "project", "acme", "notes.md"), "utf8")).toBe("kept");
  });

  it("renames the registry file and the key inside it", async () => {
    await writeJson(join(paths.config, "workspaces.json"), {
      workspaces: [{ id: "ws-1", name: "Acme", directory: "C:\\work\\acme" }],
      activeId: "ws-1",
    });

    const report = await migrateWorkspaceToProject(paths);

    expect(report.movedRegistry).toBe(true);
    expect(await exists(join(paths.config, "workspaces.json"))).toBe(false);
    expect(await readJson(join(paths.config, "projects.json"))).toEqual({
      projects: [{ id: "ws-1", name: "Acme", directory: "C:\\work\\acme" }],
      activeId: "ws-1",
    });
  });

  it("leaves a bound directory called workspace pointing where it did", async () => {
    await writeJson(join(paths.config, "workspaces.json"), {
      workspaces: [{ id: "ws-1", name: "w", directory: "C:\\work\\workspace" }],
      activeId: "ws-1",
    });

    await migrateWorkspaceToProject(paths);

    const stored = (await readJson(join(paths.config, "projects.json"))) as {
      projects: { directory: string }[];
    };
    expect(stored.projects[0]?.directory).toBe("C:\\work\\workspace");
  });

  it("repoints a project that lived inside the moved state directory", async () => {
    await mkdir(join(root, "workspace", "acme"), { recursive: true });
    await writeJson(join(paths.config, "workspaces.json"), {
      workspaces: [
        { id: "ws-1", name: "Acme", directory: join(root, "workspace", "acme") },
        { id: "ws-2", name: "Root", directory: join(root, "workspace") },
      ],
      activeId: "ws-1",
    });

    const report = await migrateWorkspaceToProject(paths);

    expect(report.repointed).toBe(2);
    const stored = (await readJson(join(paths.config, "projects.json"))) as {
      projects: { directory: string }[];
    };
    expect(stored.projects[0]?.directory).toBe(join(root, "project", "acme"));
    expect(stored.projects[1]?.directory).toBe(join(root, "project"));
    expect(await exists(join(root, "project", "acme"))).toBe(true);
  });

  it("renames our id in nested records and in JSONL", async () => {
    await writeJson(join(paths.jobs, "jobs.json"), [
      { id: "job-1", request: { workspaceId: "ws-1" } },
    ]);
    await mkdir(paths.sessions, { recursive: true });
    await writeFile(
      join(paths.sessions, "runs.jsonl"),
      `${JSON.stringify({ id: "r1", workspaceId: "ws-1" })}\n${JSON.stringify({ id: "r2", workspaceId: null })}\n`,
      "utf8",
    );

    const report = await migrateWorkspaceToProject(paths);

    expect(report.rewritten).toBe(2);
    expect(await readJson(join(paths.jobs, "jobs.json"))).toEqual([
      { id: "job-1", request: { projectId: "ws-1" } },
    ]);
    const lines = (await readFile(join(paths.sessions, "runs.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({ id: "r1", projectId: "ws-1" });
    expect(JSON.parse(lines[1] ?? "{}")).toEqual({ id: "r2", projectId: null });
  });

  it("rescopes a memory that was scoped to the workspace", async () => {
    await writeJson(join(paths.memories, "memories.json"), [
      { id: "m-1", scope: "workspace", text: "an ECR is written ECR-####" },
      { id: "m-2", scope: "user", text: "prefers short answers" },
    ]);

    await migrateWorkspaceToProject(paths);

    expect(await readJson(join(paths.memories, "memories.json"))).toEqual([
      { id: "m-1", scope: "project", text: "an ECR is written ECR-####" },
      { id: "m-2", scope: "user", text: "prefers short answers" },
    ]);
  });

  it("leaves Fabric's workspaceId alone, in config and in a persisted run", async () => {
    const guid = "11111111-2222-3333-4444-555555555555";
    await writeJson(join(paths.config, "fabric.json"), {
      connection: { workspaceId: guid, workspaceName: "Analytics" },
    });
    await writeJson(join(paths.config, "fabric-data-agent.json"), { workspaceId: guid });
    await writeJson(join(root, "fabric", "runs.json"), [{ id: "run-1", workspaceId: guid }]);

    await migrateWorkspaceToProject(paths);

    expect(await readJson(join(paths.config, "fabric.json"))).toEqual({
      connection: { workspaceId: guid, workspaceName: "Analytics" },
    });
    expect(await readJson(join(paths.config, "fabric-data-agent.json"))).toEqual({
      workspaceId: guid,
    });
    expect(await readJson(join(root, "fabric", "runs.json"))).toEqual([
      { id: "run-1", workspaceId: guid },
    ]);
  });

  it("does nothing to a home that has already been migrated", async () => {
    await mkdir(join(root, "project"), { recursive: true });
    await writeJson(join(paths.config, "projects.json"), { projects: [], activeId: null });

    const report = await migrateWorkspaceToProject(paths);

    expect(report).toEqual({
      skipped: false,
      movedStateDir: false,
      movedRegistry: false,
      repointed: 0,
      rewritten: 0,
    });
  });

  it("reads nothing on the second boot", async () => {
    await migrateWorkspaceToProject(paths);
    // State an older build could not have written: if the second pass looked at
    // it, it would rename the key and the assertion below would fail.
    await writeJson(join(paths.config, "later.json"), { workspaceId: "ws-1" });

    const report = await migrateWorkspaceToProject(paths);

    expect(report.skipped).toBe(true);
    expect(await readJson(join(paths.config, "later.json"))).toEqual({ workspaceId: "ws-1" });
  });

  it("rewrites state the first allow list missed", async () => {
    await writeJson(join(root, "research", "tsk-1", "run.json"), { workspaceId: "ws-1" });
    await writeJson(join(root, "council", "tsk-2", "run.json"), { workspaceId: "ws-1" });

    await migrateWorkspaceToProject(paths);

    expect(await readJson(join(root, "research", "tsk-1", "run.json"))).toEqual({
      projectId: "ws-1",
    });
    expect(await readJson(join(root, "council", "tsk-2", "run.json"))).toEqual({
      projectId: "ws-1",
    });
  });

  it("refuses to overwrite state the new build has already written", async () => {
    await mkdir(join(root, "workspace"), { recursive: true });
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "keep.md"), "newer", "utf8");

    const report = await migrateWorkspaceToProject(paths);

    expect(report.movedStateDir).toBe(false);
    expect(await readFile(join(root, "project", "keep.md"), "utf8")).toBe("newer");
    expect(await exists(join(root, "workspace"))).toBe(true);
  });
});
