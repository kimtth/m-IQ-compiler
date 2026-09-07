import { lstat, mkdir, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { ProjectRecord } from "@iq/shared";
import { readJson, writeJsonAtomic } from "../util/jsonl.js";
import { KeyedMutex } from "../util/lock.js";
import type { AppPaths } from "../config/paths.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { Logger } from "../util/logger.js";

/**
 * The named-project registry.
 *
 * Project is the unit of scoping in IQ Compiler: a directory plus the
 * sessions, artifacts, skills, MCP connections, knowledge index and memories
 * bound to it. This registry owns the list of projects and which one is
 * currently bound; the navigator, the tool sandbox and the audit record all
 * read the active directory from here rather than a fixed root, so binding a
 * different project re-points the whole app without reconstructing anything.
 *
 * Three properties give it its shape:
 *
 *  1. **The directory is the visible boundary of what the agent may touch.** So
 *     `create` refuses any directory that is the app's own state root or an
 *     ancestor of it — that would fold the audit log and credential-adjacent
 *     state into the agent-writable tree — and it stores the *realpath*, never
 *     following a symlink, since a link could later redirect the boundary.
 *  2. **Removal never touches the user's files.** `remove` drops the registry
 *     entry and any binding and stops there; the directory and its contents are
 *     the user's, and the app that created a pointer does not get to delete what
 *     the pointer names.
 *  3. **No installation loses its history.** An existing install has one
 *     implicit project at `paths.project`; on first load it is adopted as a
 *     record named "Project" and bound, so files and history survive the move
 *     from an unnamed root to named projects.
 *
 * Reads (`list`, `active`, `directoryOf`) are synchronous so the navigator's
 * root resolver can be a plain function; they require `init()` to have loaded
 * and migrated the state once at boot. Mutations serialise through the file
 * lock and persist atomically, so two concurrent binds cannot interleave.
 */

interface StoredState {
  projects: ProjectRecord[];
  /** The bound project, or null — Chat may run without one. */
  activeId: string | null;
}

const EMPTY: StoredState = { projects: [], activeId: null };

export interface ProjectRegistryDeps {
  paths: AppPaths;
  logger: Logger;
  audit: AuditLog;
  /** Correlates each project mutation this registry audits. */
  correlationId: () => string;
}

export class ProjectRegistry {
  private state: StoredState = EMPTY;
  private loaded = false;
  private stateRootReal: string | null = null;
  private readonly lock = new KeyedMutex();
  private readonly listeners = new Set<(active: ProjectRecord | null) => void>();

  constructor(private readonly deps: ProjectRegistryDeps) {}

  private get file(): string {
    return join(this.deps.paths.config, "projects.json");
  }

  /**
   * Load persisted state, migrating a legacy install on first run.
   *
   * Must be awaited once before the synchronous reads are used. Migration is a
   * real mutation — it creates the adopted record and binds it — so it persists
   * and is audited, but only the first time, because subsequent loads read the
   * file that migration wrote.
   */
  async init(): Promise<void> {
    await this.lock.withLock("projects", () => this.ensureLoaded());
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const raw = await readJson<StoredState | null>(this.file, null);
    if (raw && Array.isArray(raw.projects)) {
      this.state = { projects: raw.projects, activeId: raw.activeId ?? null };
      this.loaded = true;
      return;
    }

    // Migration: adopt the implicit project at `paths.project`.
    const now = new Date().toISOString();
    const record = ProjectRecord.parse({
      id: newProjectId(),
      name: "Project",
      directory: this.deps.paths.project,
      createdAt: now,
      lastOpenedAt: now,
    });
    this.state = { projects: [record], activeId: record.id };
    this.loaded = true;
    await this.persist();
    await this.audit("project.migrate", record.id, "adopted the legacy project directory");
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.file, this.state);
  }

  /** All projects, newest binding aside, sorted by name for a stable list. */
  list(): ProjectRecord[] {
    this.assertLoaded();
    return [...this.state.projects].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
  }

  /** The bound project, or null when none is bound (Chat without a project). */
  active(): ProjectRecord | null {
    if (!this.loaded) return null;
    return this.state.projects.find((entry) => entry.id === this.state.activeId) ?? null;
  }

  /** The stored absolute directory of a project. Throws for an unknown id. */
  directoryOf(projectId: string): string {
    this.assertLoaded();
    const record = this.state.projects.find((entry) => entry.id === projectId);
    if (!record) throw new Error(`no project with id "${projectId}"`);
    return record.directory;
  }

  /**
   * Create a project.
   *
   * A blank directory means "make one for me" under `paths.project/<slug>`;
   * an absolute directory supplied by the user is adopted only after it is
   * proven to exist, to be a real directory rather than a symlink, and to sit
   * outside the app's state root. Either way the stored path is the realpath, so
   * the boundary the navigator enforces cannot later be redirected by a link.
   */
  async create(input: { name: string; directory?: string }): Promise<ProjectRecord> {
    return this.lock.withLock("projects", async () => {
      await this.ensureLoaded();

      const name = input.name.trim();
      if (!name) throw new Error("a project needs a name");

      const supplied = input.directory?.trim() ?? "";
      const directory = supplied
        ? await this.adoptSuppliedDirectory(supplied)
        : await this.createManagedDirectory(name);

      const now = new Date().toISOString();
      const record = ProjectRecord.parse({
        id: newProjectId(),
        name,
        directory,
        createdAt: now,
        lastOpenedAt: now,
      });

      this.state.projects = [...this.state.projects, record];
      await this.persist();
      await this.audit("project.create", record.id, `created "${name}"`);
      this.emit();
      return record;
    });
  }

  /**
   * Open a folder as the bound project: adopt it if it is new, bind it if not.
   *
   * This is what a folder picker needs and neither `create` nor `bind` can
   * give it. `create` refuses a directory that is already registered, and
   * `bind` only takes an id the caller cannot know from a path — so a surface
   * built out of the two has to compare paths itself, and the only place that
   * comparison is honest is here, where the realpath is resolved.
   *
   * The name is the folder's own. Someone who picked a folder called
   * "Quarterly review" has already named it; asking again would ask twice.
   *
   * Written out rather than delegating to `create`/`bind`: `KeyedMutex` is not
   * reentrant, so calling either from inside this lock would deadlock.
   */
  async open(directory: string): Promise<ProjectRecord> {
    return this.lock.withLock("projects", async () => {
      await this.ensureLoaded();

      const real = await this.resolveDirectory(directory);
      const now = new Date().toISOString();
      const existing = this.state.projects.find((entry) => samePath(entry.directory, real));

      const record: ProjectRecord = existing
        ? { ...existing, lastOpenedAt: now }
        : ProjectRecord.parse({
            id: newProjectId(),
            name: basename(real) || real,
            directory: real,
            createdAt: now,
            lastOpenedAt: now,
          });

      this.state.projects = existing
        ? this.state.projects.map((entry) => (entry.id === record.id ? record : entry))
        : [...this.state.projects, record];
      this.state.activeId = record.id;
      await this.persist();
      if (!existing) await this.audit("project.create", record.id, `adopted "${record.name}"`);
      await this.audit("project.bind", record.id, `bound "${record.name}"`);
      this.emit();
      return record;
    });
  }

  /**
   * Bind a project, or null to unbind.
   *
   * Binding refreshes `lastOpenedAt` so a most-recent ordering is available, and
   * announces the change so the navigator re-reads the active directory.
   */
  async bind(projectId: string | null): Promise<ProjectRecord | null> {
    return this.lock.withLock("projects", async () => {
      await this.ensureLoaded();

      if (projectId === null) {
        this.state.activeId = null;
        await this.persist();
        await this.audit("project.bind", "", "unbound");
        this.emit();
        return null;
      }

      const record = this.state.projects.find((entry) => entry.id === projectId);
      if (!record) throw new Error(`no project with id "${projectId}"`);

      const opened: ProjectRecord = { ...record, lastOpenedAt: new Date().toISOString() };
      this.state.projects = this.state.projects.map((entry) =>
        entry.id === projectId ? opened : entry,
      );
      this.state.activeId = projectId;
      await this.persist();
      await this.audit("project.bind", projectId, `bound "${record.name}"`);
      this.emit();
      return opened;
    });
  }

  /**
   * Remove a project from the registry.
   *
   * This removes the entry and clears the binding if it pointed here. It never
   * deletes the directory or any file inside it: the files are the user's, and
   * a registry that only ever held a pointer has no business deleting what the
   * pointer named.
   */
  async remove(projectId: string): Promise<void> {
    return this.lock.withLock("projects", async () => {
      await this.ensureLoaded();
      const record = this.state.projects.find((entry) => entry.id === projectId);
      if (!record) throw new Error(`no project with id "${projectId}"`);

      this.state.projects = this.state.projects.filter((entry) => entry.id !== projectId);
      if (this.state.activeId === projectId) this.state.activeId = null;
      await this.persist();
      // Deliberately no rm of `record.directory`: removal is a forget, not a delete.
      await this.audit("project.remove", projectId, `removed "${record.name}"`);
      this.emit();
    });
  }

  /** Observe binding and membership changes. Returns an unsubscribe. */
  onChange(listener: (active: ProjectRecord | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const active = this.active();
    for (const listener of this.listeners) listener(active);
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("ProjectRegistry.init() must be awaited before reads");
  }

  private async createManagedDirectory(name: string): Promise<string> {
    const base = join(this.deps.paths.project, slugify(name));
    let candidate = base;
    for (let n = 2; await this.directoryTaken(candidate); n += 1) {
      candidate = `${base}-${n}`;
    }
    await mkdir(candidate, { recursive: true });
    const real = await realpath(candidate);
    await this.refuseIfOverStateRoot(real);
    return real;
  }

  private async adoptSuppliedDirectory(directory: string): Promise<string> {
    const real = await this.resolveDirectory(directory);
    if (this.state.projects.some((entry) => samePath(entry.directory, real))) {
      throw new Error("that directory is already a project");
    }
    return real;
  }

  /**
   * Prove a user-supplied directory may be a project, and return its realpath.
   *
   * Shared by `create` (which then refuses a duplicate) and `open` (which binds
   * the duplicate instead). The checks themselves are the same either way.
   */
  private async resolveDirectory(directory: string): Promise<string> {
    if (!isAbsolute(directory)) throw new Error("a project directory must be an absolute path");

    const info = await lstat(directory).catch(() => null);
    if (!info) throw new Error(`directory does not exist: ${directory}`);
    // lstat, not stat: a symlink must be refused rather than silently followed,
    // because the project is the agent-writable boundary and a link could
    // point it anywhere after the fact.
    if (info.isSymbolicLink()) throw new Error("a project directory must not be a symlink");
    if (!info.isDirectory()) throw new Error("a project directory must be a directory");

    const real = await realpath(directory);
    await this.refuseIfOverStateRoot(real);
    return real;
  }

  /**
   * Refuse a directory that is the app state root or an ancestor of it.
   *
   * The project tree is what the agent may read and write without a further
   * grant; it must never contain the audit log or the credential-adjacent state
   * under `paths.root`. A directory *inside* the state root (the managed
   * `paths.project`) is fine — only same-or-ancestor is refused.
   */
  private async refuseIfOverStateRoot(candidateReal: string): Promise<void> {
    if (this.stateRootReal === null) {
      this.stateRootReal = await realpath(this.deps.paths.root).catch(() => this.deps.paths.root);
    }
    const rel = relative(candidateReal, this.stateRootReal);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw new Error(
        "that directory contains IQ Compiler's own state; choose a directory outside it so the audit log " +
          "and credentials stay out of the agent-writable project",
      );
    }
  }

  private async directoryTaken(candidate: string): Promise<boolean> {
    if (this.state.projects.some((entry) => samePath(entry.directory, candidate))) return true;
    return Boolean(await lstat(candidate).catch(() => null));
  }

  private async audit(action: string, resource: string, reason: string): Promise<void> {
    await this.deps.audit.record({
      actor: { kind: "system" },
      action,
      family: "project",
      outcome: "succeeded",
      correlationId: this.deps.correlationId(),
      resources: resource ? [resource] : [],
      reason,
    });
  }
}

const newProjectId = (): string => `ws_${randomUUID()}`;

/** A filesystem-safe folder name derived from the project name. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "project";
}

/** Path equality, case-insensitive on Windows where the filesystem is. */
function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
