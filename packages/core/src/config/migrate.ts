import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";

import type { AppPaths } from "./paths.js";

/**
 * One-time rename of the on-disk state from "workspace" to "project".
 *
 * The word "workspace" meant two different things in this app: the directory a
 * user binds and works in, and a Microsoft Fabric workspace. Sitting next to a
 * Fabric panel, the same word for both is a trap. The code now says *project*
 * for ours and keeps *workspace* for Fabric's. State written by an older build
 * still says the old thing, so it is rewritten once, in place, at boot.
 *
 * Fabric's own state is off limits. It lives in exactly three places and they
 * are skipped by path, not by guessing at record shapes: `config/fabric.json`,
 * `config/fabric-data-agent.json` and everything under `<root>/fabric`. A
 * persisted Fabric run carries a real `workspaceId` — a GUID that addresses a
 * workspace in Fabric's API — and renaming it would break the run.
 *
 * The audit log is not rewritten either. It records what happened, and an entry
 * that says `workspace.bind` is a true statement about an older build.
 *
 * Values are left alone with one exception each way. A memory scoped to
 * `"workspace"` is rescoped, because that enum carried the word. And a project
 * whose directory sat inside the state directory this migration just moved is
 * repointed at where it now is, because otherwise the registry names a folder
 * that no longer exists and every turn fails on it.
 */

/**
 * What the rewrite must not walk into, relative to the app home.
 *
 * Named as a refusal list rather than an allow list on purpose. An allow list
 * misses whatever it was not told about — the first version of this listed nine
 * directories and silently skipped `council` and `research`, both of which hold
 * a `run.json` carrying our id. Everything under the app home is ours unless it
 * is one of these:
 *
 *  - `fabric`, `config/fabric.json`, `config/fabric-data-agent.json` — Fabric's
 *    own state. A persisted run carries a real `workspaceId`, a GUID that
 *    addresses a workspace in Fabric's API, and renaming it breaks the run.
 *  - `audit` — a record of what happened. An entry saying `workspace.bind` is
 *    a true statement about an older build.
 *  - `project` — the user's own files, in a directory we do not interpret.
 *  - `tools` — downloaded binaries and a Python environment. `botocore` alone
 *    ships a `workspaces` API model, which is nothing to do with us.
 *  - `samples` — the demo vault, shipped as files rather than records.
 *  - `browser-profile`, `logs`, `renders` — scratch, and safe to delete anyway.
 */
const SKIP = [
  "fabric",
  "audit",
  "project",
  "tools",
  "samples",
  "browser-profile",
  "logs",
  "renders",
  join("config", "fabric.json"),
  join("config", "fabric-data-agent.json"),
];

export interface MigrationReport {
  /** True when the migration had already run and nothing was read. */
  skipped: boolean;
  /** True when the old state directory was moved. */
  movedStateDir: boolean;
  /** True when `config/workspaces.json` became `config/projects.json`. */
  movedRegistry: boolean;
  /** How many registry entries were repointed into the moved state directory. */
  repointed: number;
  /** How many JSON or JSONL files were rewritten. */
  rewritten: number;
}

/** Written once the home has been migrated, so later boots read nothing. */
const MARKER = ".project-rename";

/**
 * Rewrite the app home, then report what changed.
 *
 * Runs once. The rewrite walks the whole home and parses every record in it,
 * which is fine as a one-off and wasteful on every boot, so it leaves a marker
 * behind and the next boot costs a single `stat`. A fresh home has nothing to
 * find, so it gets the marker and skips the walk forever after.
 *
 * Must run before `ensureAppPaths`, which would otherwise create an empty
 * `project` directory and block the move.
 */
export async function migrateWorkspaceToProject(paths: AppPaths): Promise<MigrationReport> {
  const report: MigrationReport = {
    skipped: false,
    movedStateDir: false,
    movedRegistry: false,
    repointed: 0,
    rewritten: 0,
  };

  const marker = join(paths.root, MARKER);
  if (await exists(marker)) {
    report.skipped = true;
    return report;
  }

  report.movedStateDir = await moveIfFree(join(paths.root, "workspace"), paths.project);
  report.movedRegistry = await moveIfFree(
    join(paths.config, "workspaces.json"),
    join(paths.config, "projects.json"),
  );

  const skip = new Set(SKIP.map((entry) => join(paths.root, entry)));
  report.rewritten = await rewriteTree(paths.root, skip);
  report.repointed = await repointRegistry(paths);

  await mkdir(paths.root, { recursive: true });
  await writeFile(marker, `${new Date().toISOString()}\n`, "utf8");
  return report;
}

/**
 * Follow the moved state directory with the records that point into it.
 *
 * A project the app named itself lives *inside* the app home, under the
 * directory this migration has just moved, and its `directory` is an absolute
 * path to where it used to be. Left alone, the app binds a folder that is no
 * longer there and every turn fails with "Directory does not exist".
 *
 * Only that one prefix is rewritten. A folder the user picked is somewhere else
 * on the disk and has not moved, so `C:\work\workspace` is left exactly as it
 * is — the migration moved a directory, not every directory with a name.
 */
async function repointRegistry(paths: AppPaths): Promise<number> {
  const file = join(paths.config, "projects.json");
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) return 0;

  let parsed: { projects?: { directory?: string }[] };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return 0;
  }
  if (!Array.isArray(parsed.projects)) return 0;

  const old = join(paths.root, "workspace");
  let count = 0;
  for (const record of parsed.projects) {
    const moved = repoint(record.directory, old, paths.project);
    if (moved === null) continue;
    record.directory = moved;
    count++;
  }

  if (count > 0) await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return count;
}

/** The path under `to` matching `directory` under `from`, or null if it is elsewhere. */
function repoint(directory: string | undefined, from: string, to: string): string | null {
  if (typeof directory !== "string") return null;
  // Windows paths differ in case without differing, and a record written on one
  // is compared here against a root built on the same machine.
  const same = (a: string, b: string): boolean =>
    process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

  if (same(directory, from)) return to;
  const prefix = from + sep;
  if (!same(directory.slice(0, prefix.length), prefix)) return null;
  return to + sep + directory.slice(prefix.length);
}

/** Move `from` to `to` when `from` exists and `to` does not. */
async function moveIfFree(from: string, to: string): Promise<boolean> {
  if (!(await exists(from))) return false;
  if (await exists(to)) return false;
  await rename(from, to);
  return true;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Rewrite every JSON and JSONL file under `dir`, skipping Fabric's. */
async function rewriteTree(dir: string, skip: ReadonlySet<string>): Promise<number> {
  if (skip.has(dir)) return 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (skip.has(path)) continue;
    if (entry.isDirectory()) {
      count += await rewriteTree(path, skip);
      continue;
    }
    if (entry.name.endsWith(".json")) count += (await rewriteJson(path)) ? 1 : 0;
    else if (entry.name.endsWith(".jsonl")) count += (await rewriteJsonl(path)) ? 1 : 0;
  }
  return count;
}

async function rewriteJson(path: string): Promise<boolean> {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A file we cannot parse is a file we must not overwrite.
    return false;
  }

  const next = renameKeys(parsed);
  if (JSON.stringify(next) === JSON.stringify(parsed)) return false;
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return true;
}

async function rewriteJsonl(path: string): Promise<boolean> {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return false;

  let touched = false;
  const lines = raw.split("\n").map((line) => {
    if (line.trim() === "") return line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return line;
    }
    const next = renameKeys(parsed);
    const encoded = JSON.stringify(next);
    if (encoded !== JSON.stringify(parsed)) touched = true;
    return encoded;
  });

  if (!touched) return false;
  await writeFile(path, lines.join("\n"), "utf8");
  return true;
}

/** The keys an older build wrote, and what they are called now. */
const KEYS: Record<string, string> = {
  workspaceId: "projectId",
  workspaceIds: "projectIds",
  workspaces: "projects",
  workspaceDir: "projectDir",
  requiresWorkspace: "requiresProject",
  restrictToWorkspace: "restrictToProject",
};

/**
 * Rename our keys throughout a parsed value, and fix the one enum whose value
 * carried the word: a memory scoped to `"workspace"` is now scoped to
 * `"project"`.
 *
 * Keys only — values are left alone apart from that enum. A bound directory
 * may genuinely be called `C:\work\workspace`, and rewriting it would point the
 * app at a folder that does not exist.
 */
function renameKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renameKeys);
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const renamed = KEYS[key] ?? key;
    out[renamed] = key === "scope" && inner === "workspace" ? "project" : renameKeys(inner);
  }
  return out;
}
