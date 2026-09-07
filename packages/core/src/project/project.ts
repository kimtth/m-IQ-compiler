import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProjectEntry, ProjectFile, ProjectListing } from "@iq/shared";

/**
 * The project navigator's data source.
 *
 * This service is the visible boundary of the project on the filesystem:
 * what it can list is what the agent can read or write without a further
 * grant. It therefore refuses to leave the root, and never follows a symlink —
 * the project is agent-writable, so following one would let a written file
 * decide what the user is shown.
 */

/** A guard against a pathological tree; the navigator is a browser, not a scan. */
const MAX_ENTRIES = 4_000;
const MAX_DEPTH = 12;
/** Text preview cap. Larger files must be opened in a real application. */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
/** Images are inlined as data URLs, which costs ~4/3 of this over the bridge. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * How long to wait after a filesystem event before telling the navigator.
 *
 * Writing one .pptx is many events — a temp file, a rename, a directory touch —
 * and OfficeCLI writes several files per slide. Announcing each one would make
 * the tree re-list dozens of times while a deck is built. A quarter of a second
 * is below the threshold at which a person notices a delay and far above the
 * burst length of a single save.
 */
const WATCH_DEBOUNCE_MS = 250;

/**
 * How long to wait before rebuilding a watcher that errored.
 *
 * Long enough that a directory mid-replacement has settled, short enough that
 * the navigator is live again before anyone reaches for Refresh.
 */
const WATCH_RETRY_MS = 2_000;

/**
 * The only binary content the canvas will render. Kept as a fixed map rather
 * than a sniffed type: the extension decides whether we even attempt an image,
 * and the media type we emit is one of these, never one derived from the file.
 */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

export interface ProjectDeps {
  /**
   * The active project root: a fixed path, or a resolver evaluated on each
   * call.
   *
   * Binding a different project must change what the navigator lists without
   * reconstructing the service, so the resolver form lets the registry own which
   * directory is active while this service always reads the current one. A plain
   * string is still accepted for the single-root case and for callers wired
   * before the registry exists.
   */
  readonly root: string | (() => string);
}

export class ProjectService {
  constructor(private readonly deps: ProjectDeps) {}

  /** Resolve the configured root, whether it was given as a value or a thunk. */
  private currentRoot(): string {
    return typeof this.deps.root === "function" ? this.deps.root() : this.deps.root;
  }

  /**
   * Prove a path is inside the project and hand back its absolute form.
   *
   * For "Reveal in File Explorer", which must open a real OS location. The
   * renderer sends a project-relative path and this is where that claim is
   * checked — the same anchored `relative` proof `list` and `read` use, so a
   * path the navigator would refuse to show cannot be opened either.
   */
  async locate(requested: string): Promise<string> {
    const configured = this.currentRoot();
    const root = await realpath(configured).catch(() => configured);
    const full = this.resolveInside(root, requested);
    // Refuse a path that is not there rather than opening the parent folder of
    // nothing, which reads as the feature silently misbehaving.
    const info = await stat(full).catch(() => null);
    if (!info) throw new Error(`"${requested}" is not in the project`);
    return full;
  }

  /**
   * Watch the project for changes, coalesced.
   *
   * The navigator used to list once on mount and then only on an explicit
   * refresh, so a document the agent had just written was absent from the tree
   * until the user thought to press a button — the pane's own empty state
   * promises that "files the agent creates appear here".
   *
   * Recursive watching is native on Windows and macOS. On platforms without it
   * `watch` throws, and the navigator simply keeps its manual refresh rather
   * than the app failing to start.
   */
  watch(onChange: () => void): () => void {
    let watcher: FSWatcher | null = null;
    let watched: string | null = null;
    let timer: NodeJS.Timeout | null = null;
    let retry: NodeJS.Timeout | null = null;
    let closed = false;

    const announce = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!closed) onChange();
      }, WATCH_DEBOUNCE_MS);
    };

    const arm = (): void => {
      if (closed) return;
      if (retry) {
        clearTimeout(retry);
        retry = null;
      }
      const root = this.currentRoot();
      if (watcher && watched === root) return;
      watcher?.close();
      watcher = null;
      watched = root;
      try {
        watcher = watch(root, { recursive: true, persistent: false }, announce);
        // A watcher whose directory is deleted or replaced errors rather than
        // going quiet. Drop it *and* schedule a rebuild: `arm` is otherwise
        // only reachable from `rewatch`, which runs on a project rebind, so
        // one transient error would end live updates for the rest of the
        // session and silently restore the manual-refresh behaviour this
        // watcher exists to replace.
        watcher.on("error", () => {
          watcher?.close();
          watcher = null;
          watched = null;
          schedule();
        });
      } catch {
        watcher = null;
        watched = null;
        schedule();
      }
    };

    /**
     * Try again shortly, once.
     *
     * A directory that is being replaced is unwatchable for a moment and then
     * fine; a platform with no recursive watch never will be. One delayed
     * retry covers the first without spinning on the second — a failed retry
     * simply leaves the manual refresh in place.
     */
    const schedule = (): void => {
      if (closed || retry) return;
      retry = setTimeout(() => {
        retry = null;
        arm();
      }, WATCH_RETRY_MS);
    };

    arm();
    this.rearm = arm;
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (retry) clearTimeout(retry);
      watcher?.close();
      watcher = null;
      this.rearm = undefined;
    };
  }

  /**
   * Point the watcher at the currently active root.
   *
   * Binding a different project changes what `currentRoot()` answers, but an
   * armed watcher is still holding the old directory and would report changes
   * for a project the user has left.
   */
  rewatch(): void {
    this.rearm?.();
  }

  /** Set by {@link watch}; absent until something is watching. */
  private rearm: (() => void) | undefined;

  /** List one directory. The navigator expands lazily rather than walking. */
  async list(requested = ""): Promise<ProjectListing> {
    const configured = this.currentRoot();
    const root = await realpath(configured).catch(() => configured);
    const dir = this.resolveInside(root, requested);

    const found = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const entries: ProjectEntry[] = [];
    let truncated = false;

    for (const entry of found) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      if (entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink()) continue;
      if (!entry.isFile() && !entry.isDirectory()) continue;

      const full = join(dir, entry.name);
      const info = await stat(full).catch(() => null);
      if (!info) continue;

      entries.push({
        path: relative(root, full).split(sep).join("/"),
        name: entry.name,
        kind: entry.isDirectory() ? "directory" : "file",
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
      });
    }

    // Directories first, then case-insensitive by name: the order a file tree
    // is expected to have, rather than the order the filesystem returns.
    entries.sort((a, b) =>
      a.kind === b.kind
        ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
        : a.kind === "directory"
          ? -1
          : 1,
    );

    return {
      root,
      path: relative(root, dir).split(sep).join("/"),
      entries,
      truncated,
    };
  }

  /**
   * Read a file for preview.
   *
   * Images are returned as data URLs so the canvas can show them; every other
   * binary is refused rather than mangled into a text pane.
   */
  async read(requested: string): Promise<ProjectFile> {
    const configured = this.currentRoot();
    const root = await realpath(configured).catch(() => configured);
    const file = this.resolveInside(root, requested);

    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");

    const path = relative(root, file).split(sep).join("/");
    const mediaType = IMAGE_TYPES[extname(file).slice(1).toLowerCase()];

    if (mediaType !== undefined) {
      if (info.size > MAX_IMAGE_BYTES) {
        throw new Error("image is too large to preview: open it in its own application");
      }
      const bytes = await readFile(file);
      return {
        path,
        kind: "image",
        text: "",
        dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`,
        truncated: false,
      };
    }

    const buffer = await readFile(file);
    const slice = buffer.subarray(0, MAX_PREVIEW_BYTES);
    // A NUL byte in the first block is the cheap, reliable binary signal.
    if (slice.subarray(0, 8_000).includes(0)) {
      throw new Error("binary file: open it in its own application");
    }

    return {
      path,
      kind: "text",
      text: slice.toString("utf8"),
      dataUrl: "",
      truncated: buffer.byteLength > MAX_PREVIEW_BYTES,
    };
  }

  /**
   * Resolve a caller-supplied path against the root and prove it stays inside.
   * The renderer is not trusted to have produced this path.
   */
  private resolveInside(root: string, requested: string): string {
    if (isAbsolute(requested)) throw new Error("path must be project-relative");
    const normalised = requested.replace(/\\/g, "/");
    if (normalised.split("/").filter(Boolean).length > MAX_DEPTH) {
      throw new Error("path is too deep");
    }

    const full = resolve(root, normalised);
    const rel = relative(root, full);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("path leaves the project");
    return full;
  }
}
