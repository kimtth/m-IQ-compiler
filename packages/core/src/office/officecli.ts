import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  OFFICE_EXTENSIONS,
  OfficeChange,
  OfficeDocument,
  OfficePreview,
  OfficeRender,
  OfficeStatus,
  OfficeSubcommand,
  type OfficeKind,
  type OfficePreviewFormat,
  type OfficePreviewSlide,
} from "@iq/shared";
import type { AppPaths } from "../config/paths.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { Logger } from "../util/logger.js";
import { KeyedMutex } from "../util/lock.js";
import { TimeoutError } from "../util/retry.js";

/**
 * OfficeCLI as a first-party, governed subprocess.
 *
 * OfficeCLI (iOfficeAI/OfficeCLI, Apache-2.0) is a self-contained binary with
 * the .NET runtime embedded — it exposes no Node API, so the only way to drive
 * it is to spawn it. That is exactly why this class exists rather than a thin
 * `spawn` call at each call site: a document tool is an *arbitrary file writer*
 * pointed at a user-supplied path by a model that may be acting on text it just
 * read, so the dangerous decisions — which verb may run, which path it may
 * touch, what the environment is, how long it may run — have to be made in one
 * place that the agent cannot talk its way around.
 *
 * The guarantees enforced here, none of which are trusted to the caller:
 *
 *  1. The subcommand must be a member of the closed {@link OfficeSubcommand}
 *     set. A new verb cannot be smuggled in through an argument.
 *  2. Every file operand resolves inside the bound project directory, using
 *     the same containment proof the project navigator uses, and any argv
 *     token that is itself an absolute path is refused. The project tree is
 *     the visible boundary of what the agent may write; OfficeCLI does not get
 *     to widen it.
 *  3. The child is spawned with an explicit argv and `shell: false`, a wall
 *     clock timeout, a captured-output cap, and a minimal environment allow
 *     list plus `OFFICECLI_RESIDENT_FLUSH=each` so a resident session never
 *     leaves a preview reading a stale file, and `OFFICECLI_SKIP_UPDATE=1` so
 *     the binary never reaches out to the network on its own.
 *  4. Every invocation is audited under family "office" with the subcommand,
 *     the project-relative target, and the resolved OfficeCLI version, so
 *     "which binary wrote this file" is always answerable.
 *
 * Core stays Electron-free: `spawn`, `fetch` and the correlation-id source are
 * injectable, and the platform binds `projectDir` to the active project.
 */

/** The version installed by {@link OfficeCli.install}. Pinned so a run is reproducible. */
const PINNED_VERSION = "1.0.137";

/** A probe or a single mutation is interactive; it must fail fast and visibly. */
const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * A native render starts PowerPoint or Word. Measured at 8–12s for one slide
 * and about the same for a whole-deck contact sheet, so the interactive budget
 * would kill a large document mid-render and report it as a fault.
 */
const NATIVE_RENDER_TIMEOUT_MS = 180_000;
/** Rendered HTML can be large; anything past this is a runaway, not a document. */
const MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
/**
 * A rendered page travels to the renderer as a base64 data URL, so its cost is
 * paid twice — once on the wire and once in the DOM. A 7-slide contact sheet is
 * ~250KB; this is generous, and it is a ceiling rather than a target.
 */
const MAX_RENDER_BYTES = 12 * 1024 * 1024;

/**
 * Subcommands that change a file on disk. Only these emit an {@link OfficeChange}
 * so the canvas refreshes; `view`, `query` and `validate` are pure reads, and
 * `open`/`close` are resident-session lifecycle rather than mutations.
 */
const MUTATING: ReadonlySet<string> = new Set(["create", "add", "set", "remove", "batch", "merge"]);

export interface OfficeSpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface OfficeSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBytes: number;
  /** Written to stdin then closed; used by `batch` which reads JSON from stdin. */
  input?: string;
}

/**
 * The subprocess boundary, injectable so tests never execute a real binary.
 * The default implementation is the only place that touches `child_process`,
 * which keeps the containment properties (no shell, timeout, output cap) in one
 * auditable spot.
 */
export type OfficeSpawn = (
  command: string,
  args: readonly string[],
  options: OfficeSpawnOptions,
) => Promise<OfficeSpawnResult>;

export interface OfficeCliDeps {
  logger: Logger;
  audit: AuditLog;
  paths: AppPaths;
  /** The active project root, or null when no project is bound. */
  projectDir: () => string | null;
  /**
   * The active project's id, stamped onto every emitted change.
   *
   * Separate from {@link projectDir} because a directory is not an identity:
   * a change carries a project-*relative* path, which two projects can
   * spell the same way. Optional so a caller that has no registry — tests, and
   * anything project-less — need not invent one.
   */
  projectId?: () => string | null;
  correlationId: () => string;
  spawnImpl?: OfficeSpawn;
  fetchImpl?: typeof fetch;
}

/** Options for a single governed invocation. */
export interface OfficeInvokeOptions {
  /** Project-relative path of the file the command targets. Containment-checked. */
  targetPath: string;
  /**
   * Additional project-relative file operands (e.g. the `merge` output),
   * inserted after the target and each containment-checked.
   */
  extraPaths?: readonly string[];
  /** stdin payload, for `batch`. */
  input?: string;
  /**
   * Absolute destination for a subcommand that writes a file (`view … -o`).
   *
   * **The app chooses this, never a caller and never the model** — it is a
   * scratch name under `paths.renders`. That is why it is appended after the
   * argv guard rather than passing through it: the guard exists to catch a path
   * a model composed, and refusing our own scratch file would only mean
   * inventing a way around the guard. It is still proved to be inside the app
   * root, so a future caller cannot quietly widen it.
   */
  outputPath?: string;
  timeoutMs?: number;
  /**
   * The turn making this call, when there is one.
   *
   * It is what bounds "this document is being generated": a document is under
   * generation from the first mutation a turn makes to it until that turn ends.
   * That boundary is a fact the turn owns — the alternatives are guesses (a
   * quiet timer would flicker every time the model paused to think between
   * slides). Absent for a preview or a UI-initiated call, neither of which
   * starts a generation.
   */
  turnId?: string;
}

/** One element to add, as {@link OfficeCli.addMany} takes it. */
export interface OfficeAddItem {
  /** OfficeCLI element path to add under, e.g. `/` or `/slide[1]`. */
  target: string;
  /** Element type, e.g. `slide`, `shape`, `paragraph`, `sheet`. */
  type?: string;
  /** `key=value` properties, as the single-element tool takes them. */
  properties?: readonly string[];
}

/** A resolved, runnable OfficeCLI. */
interface Resolved {
  executable: string;
  version: string;
  origin: "path" | "managed";
}

export class OfficeCli {
  private readonly spawnImpl: OfficeSpawn;
  private readonly fetchImpl: typeof fetch;
  private readonly listeners = new Set<(change: OfficeChange) => void>();
  /** Absolute paths currently held open in resident mode, closed on dispose. */
  private readonly open = new Set<string>();
  /** Absolute paths of documents mid-generation, so previews render read-only. */
  private readonly generating = new Set<string>();
  /** Documents each turn is generating, so a turn ending can release them. */
  private readonly generatingByTurn = new Map<string, Set<string>>();
  /**
   * One OfficeCLI process at a time per document.
   *
   * This is what makes a live preview possible at all. An Office file is a zip
   * that a writer rewrites wholesale, so a `view` that lands mid-write reads a
   * torn file — and on Windows it is worse than a bad render: the reader's
   * share-lock can fail the write, so the preview would break the generation it
   * is supposed to be showing. Serialised, a `view` can only run *between*
   * mutations, which is exactly when the file is consistent. The preview is then
   * never "the file as it is being written", it is "the last settled state",
   * which is the only thing a preview can honestly be.
   */
  private readonly locks = new KeyedMutex();
  private resolved: Resolved | null = null;

  constructor(private readonly deps: OfficeCliDeps) {
    this.spawnImpl = deps.spawnImpl ?? nodeOfficeSpawn;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /** The managed install root. Nothing is ever written outside `<root>/tools`. */
  private get toolsRoot(): string {
    return join(this.deps.paths.root, "tools", "officecli");
  }

  private get managedBinaryName(): string {
    return process.platform === "win32" ? "officecli.exe" : "officecli";
  }

  /**
   * Discover a runnable OfficeCLI.
   *
   * A copy already on PATH wins: the user (or OfficeCLI's own installer) put it
   * there deliberately, and honouring it avoids a redundant managed download.
   * Otherwise the newest managed version under `<root>/tools/officecli/<ver>/`
   * is used. The result is cached because every subsequent invocation needs the
   * version string, and probing the binary on every call would be wasteful.
   */
  async status(): Promise<OfficeStatus> {
    if (this.resolved) {
      return OfficeStatus.parse({
        state: "ready",
        version: this.resolved.version,
        origin: this.resolved.origin,
        message: `OfficeCLI ${this.resolved.version} ready (${this.resolved.origin}).`,
      });
    }

    const onPath = await this.probeVersion(this.pathBinaryName);
    if (onPath) {
      this.resolved = { executable: this.pathBinaryName, version: onPath, origin: "path" };
      return OfficeStatus.parse({
        state: "ready",
        version: onPath,
        origin: "path",
        message: `OfficeCLI ${onPath} found on PATH.`,
      });
    }

    const managed = await this.probeManaged();
    if (managed) {
      this.resolved = managed;
      return OfficeStatus.parse({
        state: "ready",
        version: managed.version,
        origin: "managed",
        message: `OfficeCLI ${managed.version} installed in the app tools directory.`,
      });
    }

    return OfficeStatus.parse({
      state: "missing",
      origin: "none",
      message:
        "OfficeCLI is not installed. Install the pinned version into the app tools directory to author Office documents.",
    });
  }

  /**
   * Install the pinned version into the app's own tools directory.
   *
   * Idempotent and safe to retry: a download lands in a temp file, is verified
   * to actually run `--version`, and only then is atomically renamed into
   * place, so an interrupted download never leaves a half-installed binary that
   * `status()` would mistake for ready. If the download cannot be performed the
   * method fails loudly rather than reporting success for a binary that does
   * not run — the state machine must never lie about readiness.
   */
  async install(): Promise<OfficeStatus> {
    const versionDir = join(this.toolsRoot, PINNED_VERSION);
    const binary = join(versionDir, this.managedBinaryName);

    // Defence in depth: the destination must be inside the tools directory.
    if (!isInside(join(this.deps.paths.root, "tools"), binary)) {
      throw new Error("refusing to install OfficeCLI outside the app tools directory");
    }

    // Already installed and runnable: return without touching the network.
    if (existsSync(binary)) {
      const version = await this.probeVersion(binary);
      if (version) {
        this.resolved = { executable: binary, version, origin: "managed" };
        return OfficeStatus.parse({
          state: "ready",
          version,
          origin: "managed",
          message: `OfficeCLI ${version} already installed.`,
        });
      }
    }

    const url = downloadUrl(PINNED_VERSION);
    let bytes: Buffer;
    try {
      const response = await this.fetchImpl(url);
      if (!response.ok) throw new Error(`download responded ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn("officecli download failed", { url, error: message });
      throw new Error(
        `could not download OfficeCLI ${PINNED_VERSION} from ${url}: ${message}. ` +
          "Install it manually onto PATH, or retry when the network is available.",
      );
    }

    await mkdir(versionDir, { recursive: true });
    const temp = join(versionDir, `.download-${process.pid}.tmp`);
    await writeFile(temp, bytes);
    if (process.platform !== "win32") await chmod(temp, 0o755).catch(() => undefined);

    const version = await this.probeVersion(temp);
    if (!version) {
      await rm(temp, { force: true });
      throw new Error(
        "the downloaded OfficeCLI binary did not run; leaving nothing installed rather than a broken tool",
      );
    }

    await rename(temp, binary);
    this.resolved = { executable: binary, version, origin: "managed" };
    this.deps.logger.info("officecli installed", { version, origin: "managed" });
    return OfficeStatus.parse({
      state: "ready",
      version,
      origin: "managed",
      message: `OfficeCLI ${version} installed.`,
    });
  }

  /**
   * Run one governed subcommand. Every guard here is enforced rather than
   * trusted to the caller, because the caller is a model.
   */
  async invoke(
    subcommand: string,
    args: readonly string[],
    options: OfficeInvokeOptions,
  ): Promise<OfficeSpawnResult> {
    const parsedCommand = OfficeSubcommand.safeParse(subcommand);
    if (!parsedCommand.success) {
      await this.deny(subcommand, options.targetPath, `unknown subcommand "${subcommand}"`);
      throw new Error(`refused: "${subcommand}" is not an allowed OfficeCLI subcommand`);
    }
    const command = parsedCommand.data;

    const project = this.deps.projectDir();
    if (!project) {
      await this.deny(command, options.targetPath, "no project is bound");
      throw new Error("refused: Office authoring requires a bound project");
    }
    const root = resolve(project);

    let target: string;
    let extras: string[];
    try {
      target = this.resolveInside(root, options.targetPath, command);
      extras = (options.extraPaths ?? []).map((path) => this.resolveInside(root, path, command));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.deny(command, options.targetPath, reason);
      throw error;
    }

    // A file path smuggled through the argument list would bypass the operand
    // containment above, so it is refused rather than passed through.
    const smuggled = args.find((arg) => namesFilesystemPath(arg));
    if (smuggled !== undefined) {
      const reason = `argument "${smuggled}" names a file path`;
      await this.deny(command, options.targetPath, reason);
      throw new Error(`refused: ${reason}`);
    }

    const { executable, version } = await this.ensureReady();
    const argv = [command, target, ...extras, ...args];

    // Appended after the guard on purpose — see OfficeInvokeOptions.outputPath.
    // The containment proof stays, because "the app chose it" must remain true
    // of every future caller and not just of today's one.
    if (options.outputPath !== undefined) {
      if (!isInside(this.deps.paths.root, options.outputPath)) {
        await this.deny(command, options.targetPath, "render output escapes the app directory");
        throw new Error("refused: render output must stay inside the app directory");
      }
      argv.push("-o", options.outputPath);
    }

    // Everything below runs alone for this document. The guards above do not:
    // they are cheap, they touch no file, and a refusal must be recorded
    // immediately rather than queued behind whatever is currently writing.
    return this.locks.withLock(target, async () => {
      // OfficeCLI does not create a missing parent directory — it fails with
      // "could not find a part of the path" — and every document now lives in
      // a folder of its own, so the folder has to exist before the first write.
      if (MUTATING.has(command)) await mkdir(dirname(target), { recursive: true });

      // Marked before the spawn, so the change this emits already says the
      // document is under generation rather than announcing it one slide late.
      if (MUTATING.has(command) && options.turnId !== undefined) {
        this.markGenerating(target, options.turnId);
      }

      try {
        const result = await this.spawnImpl(executable, argv, {
          cwd: root,
          env: this.childEnv(),
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBytes: MAX_OUTPUT_BYTES,
          input: options.input,
        });

        const relativeTarget = relative(root, target);
        await this.deps.audit.record({
          actor: { kind: "system" },
          action: `office.${command}`,
          family: "office",
          outcome: result.code === 0 ? "succeeded" : "failed",
          correlationId: this.deps.correlationId(),
          resources: [relativeTarget, `officecli@${version}`],
          reason: result.code === 0 ? "" : trim(result.stderr),
        });

        if (result.code === 0) {
          // OfficeCLI keeps the document resident after *any* command — `create`
          // says so in its own output ("kept open in background for faster
          // subsequent commands"), and a bare `view` leaves the file locked
          // just as a mutation does. So residency is recorded here rather than
          // only in `openDocument`, which nothing calls. Without it the
          // resident is never closed: the file stays locked for the life of the
          // app, and the deck the user just asked for cannot be opened in
          // PowerPoint — the exact failure the canvas warns *them* about.
          if (command === "close") this.open.delete(target);
          else this.open.add(target);

          if (MUTATING.has(command)) this.emit(target, relativeTarget, command);
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.deps.audit.record({
          actor: { kind: "system" },
          action: `office.${command}`,
          family: "office",
          outcome: "failed",
          correlationId: this.deps.correlationId(),
          resources: [relative(root, target), `officecli@${version}`],
          reason: message,
        });
        throw error;
      }
    });
  }

  /**
   * Add many elements to one document in a single OfficeCLI pass.
   *
   * This exists because of what the approval queue looked like without it.
   * "Create a deck about Microsoft" is one intent, but with only
   * `office_add_content` the model can express it solely as one call per slide,
   * per title and per bullet — seventeen calls, and therefore seventeen
   * approval cards, for one decision. The `batch` verb, the closed subcommand
   * set and the stdin plumbing were all already here; nothing had ever exposed
   * them as a tool.
   *
   * **The command is fixed to `add`, never taken from the caller.** OfficeCLI's
   * batch format accepts `set`, `remove`, `move` and `swap` in the same array,
   * and those are the verbs this app deliberately keeps individually approved
   * because they rewrite or destroy content the approver cannot see. Restricted
   * to additions, this carries exactly the risk `office_add_content` carries,
   * so it is remembered by a session rule on the same terms rather than needing
   * a weaker promise.
   *
   * Values are checked here rather than in the tool: batch arguments travel as
   * JSON on stdin, so the argv containment guard never sees them, and a
   * `props: {src: "C:\\…"}` would otherwise be a way around it.
   */
  async addMany(
    targetPath: string,
    items: readonly OfficeAddItem[],
    options: { turnId?: string } = {},
  ): Promise<OfficeSpawnResult> {
    if (items.length === 0) throw new Error("refused: nothing to add");

    const commands = items.map((item) => {
      if (!ELEMENT_SELECTOR.test(item.target)) {
        throw new Error(
          `refused: "${item.target}" is not an OfficeCLI element path (e.g. "/" or "/slide[1]")`,
        );
      }

      const props: Record<string, string> = {};
      for (const property of item.properties ?? []) {
        const separator = property.indexOf("=");
        if (separator <= 0) throw new Error(`refused: "${property}" is not key=value`);
        if (namesFilesystemPath(property)) {
          throw new Error(`refused: property "${property}" names a file path`);
        }
        props[property.slice(0, separator)] = property.slice(separator + 1);
      }

      return {
        command: "add",
        parent: item.target,
        ...(item.type === undefined ? {} : { type: item.type }),
        ...(Object.keys(props).length === 0 ? {} : { props }),
      };
    });

    return this.invoke("batch", ["--json"], {
      targetPath,
      input: JSON.stringify(commands),
      ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
    });
  }

  /** Begin resident mode for a document, so multi-step edits stay in memory. */
  async openDocument(path: string): Promise<void> {
    await this.invoke("open", [], { targetPath: path });
    const root = resolve(this.requireProject());
    this.open.add(this.resolveInside(root, path, "open"));
  }

  /**
   * Where a document path actually lands, project-relative.
   *
   * A bare name is given a folder of its own (see {@link placeDocument}), so
   * the caller that asked for `Deck.pptx` needs to be told it got
   * `Deck/Deck.pptx` — otherwise it writes the deck's images next to a file
   * that is no longer there, which is the mess this was meant to end.
   */
  documentPath(path: string): string {
    const root = resolve(this.requireProject());
    return relative(root, this.resolveInside(root, path, "view")).replace(/\\/g, "/");
  }

  /** End resident mode, flushing to disk. */
  async closeDocument(path: string): Promise<void> {
    const root = resolve(this.requireProject());
    const absolute = this.resolveInside(root, path, "close");
    await this.invoke("close", [], { targetPath: path });
    this.open.delete(absolute);
  }

  /**
   * Best-effort close of every resident document. The host wires this to app
   * quit so a crash or exit does not leave documents held open and their last
   * edits unflushed.
   */
  async disposeAll(): Promise<void> {
    const paths = [...this.open];
    this.open.clear();
    const root = this.deps.projectDir();
    if (!root) return;
    for (const absolute of paths) {
      const relativePath = relative(resolve(root), absolute);
      await this.invoke("close", [], { targetPath: relativePath }).catch((error) => {
        this.deps.logger.warn("officecli close on dispose failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  /**
   * The Office artifacts already in the project, newest first.
   *
   * A read of the directory tree, not of the documents: it starts no
   * subprocess, so the surface can ask for it on every open. It exists because
   * the mutation stream is session-scoped — after a restart the app knows
   * nothing about the deck it wrote yesterday, and the preview would sit empty
   * beside a project that holds it.
   *
   * Bounded rather than exhaustive: four levels deep and capped. The project is
   * a folder the user chose, so it can be anything — a documents folder, a
   * shared drive — and this must not turn into a scan of it.
   */
  async documents(limit = 100): Promise<OfficeDocument[]> {
    const root = this.deps.projectDir();
    if (root === null) return [];
    const base = resolve(root);

    const found: OfficeDocument[] = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 4 || found.length >= limit) return;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (found.length >= limit) return;
        const name = String(entry.name);
        // `~$deck.pptx` is Word's and PowerPoint's lock file, not a document.
        if (name.startsWith(".") || name.startsWith("~$")) continue;
        const absolute = join(dir, name);
        if (entry.isDirectory()) {
          await walk(absolute, depth + 1);
          continue;
        }
        const kind = OFFICE_EXTENSIONS[extname(name).toLowerCase()];
        if (!kind) continue;
        try {
          const info = await stat(absolute);
          found.push(
            OfficeDocument.parse({
              path: relative(base, absolute),
              kind,
              bytes: info.size,
              modifiedAt: new Date(info.mtimeMs).toISOString(),
            }),
          );
        } catch {
          // A file that vanished between listing and stat is not worth a row.
        }
      }
    };

    await walk(base, 0);
    return found.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  /**
   * Render a document for the canvas through OfficeCLI's own view engine.
   *
   * We deliberately do not start the `watch` HTTP server: it binds a port and
   * serves live content, which is a needless surface. `view <file> html|svg`
   * writes the rendered markup to stdout, which we capture and hand to the
   * canvas to display sandboxed. It is generated markup, not trusted content.
   *
   * Safe to call while the agent is building the file: the per-document lock
   * puts this render between two mutations rather than inside one. It can still
   * come back unrenderable — an empty deck is not a picture of anything — and
   * that is reported as {@link OfficePreview.problem} rather than thrown, so a
   * document that is merely not ready yet does not look like a failure.
   */
  async preview(path: string, format: OfficePreviewFormat): Promise<OfficePreview> {
    const root = resolve(this.requireProject());
    const absolute = this.resolveInside(root, path, "view");
    const kind = kindOf(absolute);

    const frame = {
      path: relative(root, absolute),
      kind,
      format,
      generatedAt: new Date().toISOString(),
      generating: this.generating.has(absolute),
    };

    let result: OfficeSpawnResult;
    try {
      result = await this.invoke("view", [format], { targetPath: path });
    } catch (error) {
      // The binary could not be run, or the render timed out. Neither is a
      // reason to lose the frame already on screen.
      return OfficePreview.parse({
        ...frame,
        content: "",
        problem: error instanceof Error ? error.message : String(error),
      });
    }

    if (result.code !== 0) {
      return OfficePreview.parse({
        ...frame,
        content: "",
        problem: trim(result.stderr) || `OfficeCLI could not render ${frame.path} yet`,
      });
    }

    await this.releaseIfSettled(absolute, path);
    if (format !== "html") {
      return OfficePreview.parse({ ...frame, content: result.stdout, problem: "" });
    }
    const prepared = preparePreviewHtml(result.stdout);
    return OfficePreview.parse({
      ...frame,
      content: prepared.html,
      slides: prepared.slides,
      slideWidthPt: prepared.slideWidthPt,
      slideHeightPt: prepared.slideHeightPt,
      problem: "",
    });
  }

  /**
   * Render through the application that owns the format — the truth check.
   *
   * `view <file> screenshot --render native` drives PowerPoint or Word and
   * returns what they draw. It exists because {@link preview} does not: on the
   * same deck, OfficeCLI's `query` reports a body placeholder at 24pt, its own
   * HTML render writes 18pt, and PowerPoint draws 24pt — a quarter under, on
   * every layout-driven slide. And where PowerPoint spills text past a box
   * border, the HTML view clips it, so the slide that is broken is the one that
   * looks fine. A preview that errs optimistic about fit is worse than none,
   * because it is trusted.
   *
   * Deliberately **not** a fallback to the HTML path when native is
   * unavailable: substituting the renderer being checked for the one doing the
   * checking would answer the question with the thing in doubt. Absence is
   * reported instead, and the surface says which renderer is on screen.
   *
   * `page` renders one slide; omitting it renders a contact sheet of the whole
   * document, which is the right artifact for "show me what I built".
   */
  async renderNative(
    path: string,
    options: { page?: number | null } = {},
  ): Promise<OfficeRender> {
    const root = resolve(this.requireProject());
    const absolute = this.resolveInside(root, path, "view");
    const page = options.page ?? null;

    const frame = {
      path: relative(root, absolute),
      kind: kindOf(absolute),
      page,
      generatedAt: new Date().toISOString(),
    };

    await mkdir(this.deps.paths.renders, { recursive: true });
    const scratch = join(
      this.deps.paths.renders,
      `render-${process.pid}-${Date.now().toString(36)}.png`,
    );

    try {
      const args = ["screenshot", "--render", "native"];
      // One page, or every page tiled — `--grid` with no count keeps the sheet
      // roughly square, which is what a deck overview wants.
      if (page === null) args.push("--grid");
      else args.push("--page", String(page));

      const result = await this.invoke("view", args, {
        targetPath: path,
        outputPath: scratch,
        timeoutMs: NATIVE_RENDER_TIMEOUT_MS,
      });
      if (result.code !== 0) {
        return OfficeRender.parse({
          ...frame,
          image: "",
          problem: nativeRenderProblem(result.stderr || result.stdout),
        });
      }

      const bytes = await readFile(scratch);
      if (bytes.byteLength > MAX_RENDER_BYTES) {
        return OfficeRender.parse({
          ...frame,
          image: "",
          problem:
            "the rendered image is too large to display; render a single slide instead of the whole document",
        });
      }
      await this.releaseIfSettled(absolute, path);
      return OfficeRender.parse({
        ...frame,
        image: `data:image/png;base64,${bytes.toString("base64")}`,
        problem: "",
      });
    } catch (error) {
      return OfficeRender.parse({
        ...frame,
        image: "",
        problem: nativeRenderProblem(error instanceof Error ? error.message : String(error)),
      });
    } finally {
      // Scratch: the image lives in the reply, not on disk. A file left behind
      // is a crashed render, not state anything reads.
      await rm(scratch, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Let go of a document that nothing is writing.
   *
   * Rendering leaves a resident holding the file, so a preview of a finished
   * document would silently lock it — and the user's next act is usually to
   * open that very file. While a turn *is* writing, the resident is kept: it is
   * what makes the per-slide re-render fast, and the file is not the user's to
   * open yet anyway.
   */
  private async releaseIfSettled(absolute: string, relativePath: string): Promise<void> {
    if (this.generating.has(absolute) || !this.open.has(absolute)) return;
    await this.invoke("close", [], { targetPath: relativePath }).catch((error: unknown) => {
      this.deps.logger.warn("officecli close after preview failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Subscribe to mutation and generation events; returns an unsubscribe. */
  onChange(listener: (change: OfficeChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Mark a document as under multi-step generation. While set, the canvas
   * labels its preview read-only and warns that opening the file in the system
   * app would lock it. Emits immediately so the UI flips without waiting for
   * the first mutation.
   */
  beginGeneration(path: string): void {
    const root = resolve(this.requireProject());
    const absolute = this.resolveInside(root, path, "open");
    this.generating.add(absolute);
    this.emit(absolute, relative(root, absolute), "open", true);
  }

  endGeneration(path: string): void {
    const root = resolve(this.requireProject());
    const absolute = this.resolveInside(root, path, "close");
    this.generating.delete(absolute);
    this.emit(absolute, relative(root, absolute), "close", false);
  }

  /**
   * Release every document a turn was generating.
   *
   * Called when a turn reaches a terminal state, whichever one: a turn that
   * failed or was cancelled leaves its document half-built, and leaving the
   * preview labelled "generating" forever would tell the user to keep waiting
   * for a run that has already stopped.
   */
  finishTurn(turnId: string): void {
    const documents = this.generatingByTurn.get(turnId);
    if (!documents) return;
    this.generatingByTurn.delete(turnId);

    const released: string[] = [];
    for (const absolute of documents) {
      // A document another turn is still writing stays marked.
      if (this.ownedByAnotherTurn(absolute)) continue;
      this.generating.delete(absolute);
      released.push(absolute);
    }
    // The flag is cleared now so a preview taken immediately reports the truth;
    // the flush and the announcement follow, because closing is I/O.
    void this.settle(released);
  }

  /**
   * Flush and release each document, then announce the settled state.
   *
   * Closing is what makes the artifact usable: it ends the resident process,
   * writes the final bytes and unlocks the file, so the user can open the deck
   * they just asked for. The change is emitted *after* the close so the canvas
   * renders the finished file rather than the last mid-build flush.
   */
  private async settle(documents: readonly string[]): Promise<void> {
    const project = this.deps.projectDir();
    for (const absolute of documents) {
      // Re-asserted here, not only in `finishTurn`: everything between the two
      // is asynchronous, and a later turn can claim this document while the
      // close is still queued. Closing then ends the resident out from under a
      // turn that is still building, and announces a document as settled while
      // it is being written.
      //
      // Deliberately not wrapped in `locks.withLock`: `invoke` takes the same
      // per-document lock and KeyedMutex is not reentrant, so acquiring it here
      // would deadlock on the close below. The window is therefore narrowed
      // rather than eliminated, which is why the announcement below reads the
      // live flag instead of asserting `false`.
      if (this.ownedByAnotherTurn(absolute)) continue;
      const root = project === null ? null : resolve(project);
      const relativePath = root === null ? null : relative(root, absolute);
      if (this.open.has(absolute) && relativePath !== null) {
        this.open.delete(absolute);
        await this.invoke("close", [], { targetPath: relativePath }).catch((error: unknown) => {
          this.deps.logger.warn("officecli close after turn failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      // Without a project there is no relative path to name, so the flag is
      // cleared silently rather than guessed at.
      //
      // `generating` is *read*, not asserted false: by the time the close
      // returns another turn may have claimed the document, and announcing it
      // settled would tell the canvas a build had finished while it was still
      // running. The default reports what is true at the moment of the emit.
      if (relativePath !== null) this.emit(absolute, relativePath, "close");
    }
  }

  /** Mark a document as being generated by a turn. */
  private markGenerating(absolute: string, turnId: string): void {
    this.generating.add(absolute);
    const documents = this.generatingByTurn.get(turnId) ?? new Set<string>();
    documents.add(absolute);
    this.generatingByTurn.set(turnId, documents);
  }

  private ownedByAnotherTurn(absolute: string): boolean {
    for (const documents of this.generatingByTurn.values()) {
      if (documents.has(absolute)) return true;
    }
    return false;
  }

  // --- internals -----------------------------------------------------------

  private get pathBinaryName(): string {
    // On PATH the binary is invoked by bare name; the OS resolves the extension.
    return "officecli";
  }

  private requireProject(): string {
    const project = this.deps.projectDir();
    if (!project) throw new Error("Office authoring requires a bound project");
    return project;
  }

  private async ensureReady(): Promise<Resolved> {
    if (this.resolved) return this.resolved;
    const status = await this.status();
    if (status.state !== "ready" || !this.resolved) {
      throw new Error(status.message || "OfficeCLI is not installed");
    }
    return this.resolved;
  }

  /**
   * Resolve a caller-supplied path against the project root and prove it does
   * not escape — the same anchored `relative` check the project navigator
   * uses, so the two agree on the boundary. Also insists on an Office extension
   * so a stray path cannot turn a document verb into a general file write.
   */
  private resolveInside(root: string, requested: string, command: OfficeSubcommand): string {
    if (isAbsolute(requested)) throw new Error("path must be project-relative");
    const normalised = requested.replace(/\\/g, "/");
    const placed = placeDocument(root, normalised);
    const full = resolve(root, placed);
    const rel = relative(root, full);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("path leaves the project");

    if (!OFFICE_EXTENSIONS[extname(full).toLowerCase()]) {
      throw new Error(`"${requested}" is not a .docx, .xlsx or .pptx file (${command})`);
    }
    return full;
  }

  /**
   * The minimal environment the binary needs, plus the two flags that make it
   * safe: flush every mutation to disk so a preview never reads a stale file,
   * and never self-update over the network.
   */
  private childEnv(): NodeJS.ProcessEnv {
    const allow = [
      "PATH",
      "Path",
      "PATHEXT",
      "SystemRoot",
      "windir",
      "TEMP",
      "TMP",
      "HOME",
      "USERPROFILE",
      "LANG",
      "LC_ALL",
    ];
    const env: NodeJS.ProcessEnv = {};
    for (const key of allow) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    env["OFFICECLI_RESIDENT_FLUSH"] = "each";
    env["OFFICECLI_SKIP_UPDATE"] = "1";
    return env;
  }

  private async probeVersion(executable: string): Promise<string | null> {
    try {
      const result = await this.spawnImpl(executable, ["--version"], {
        cwd: this.deps.paths.root,
        env: this.childEnv(),
        timeoutMs: 15_000,
        maxBytes: 64 * 1024,
      });
      if (result.code !== 0) return null;
      const match = /(\d+\.\d+\.\d+(?:[-.\w]*)?)/.exec(`${result.stdout} ${result.stderr}`);
      return match ? match[1]! : null;
    } catch {
      return null;
    }
  }

  private async probeManaged(): Promise<Resolved | null> {
    let names: string[];
    try {
      names = readdirSync(this.toolsRoot);
    } catch {
      return null;
    }
    // Prefer the highest version directory that actually contains a runnable
    // binary, so a stale or half-written version never shadows a good one.
    const sorted = names.sort(compareVersionsDesc);
    for (const name of sorted) {
      const binary = join(this.toolsRoot, name, this.managedBinaryName);
      if (!existsSync(binary)) continue;
      const version = await this.probeVersion(binary);
      if (version) return { executable: binary, version, origin: "managed" };
    }
    return null;
  }

  private emit(
    absolute: string,
    relativePath: string,
    subcommand: OfficeSubcommand,
    generating = this.generating.has(absolute),
  ): void {
    const change = OfficeChange.parse({
      // Separators are normalised because everything else that names a
      // project file uses `/` — `ProjectService.list` and `documentPath`
      // both do — and a consumer comparing this against either of them would
      // never match on Windows. That is what left `.tree-row.touched` styled
      // and never applied.
      path: relativePath.replace(/\\/g, "/"),
      kind: kindOf(absolute),
      subcommand,
      // Which project this happened in. A relative path is not unique across
      // projects, so a consumer that keys on the path alone cannot tell a
      // late event from the project just left from a fresh one here.
      projectId: this.deps.projectId?.() ?? null,
      at: new Date().toISOString(),
      generating,
    });
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        this.deps.logger.warn("office change listener threw", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async deny(subcommand: string, targetPath: string, reason: string): Promise<void> {
    await this.deps.audit.record({
      actor: { kind: "system" },
      action: `office.${subcommand}`,
      family: "office",
      outcome: "denied",
      correlationId: this.deps.correlationId(),
      resources: [targetPath],
      reason,
    });
  }
}

/** Map an on-disk path to its Office kind, throwing if it is not an Office file. */
function kindOf(path: string): OfficeKind {
  const kind = OFFICE_EXTENSIONS[extname(path).toLowerCase()];
  if (!kind) throw new Error(`${path} is not an Office document`);
  return kind;
}

/**
 * Give a document a folder of its own.
 *
 * `Deck.pptx` becomes `Deck/Deck.pptx`. A deck is not one file: it is the file
 * plus the images it references, plus the versions that came before it, and
 * every one of those used to land in the project root. Four attempts at one
 * deck and eight SVGs left a root nobody could read, and the artifact the user
 * actually wanted was somewhere in the middle of it.
 *
 * Two things are left exactly as asked, and both matter more than tidiness:
 *
 *  - **A path that already names a folder.** The caller has placed it, and
 *    second-guessing that would make `reports/q4.docx` unreachable by its own
 *    name.
 *  - **A file that already exists where it was asked for.** Otherwise this
 *    change would orphan every document written before it, and a user who put
 *    a file in the root deliberately would find it ignored.
 *
 * Deliberately not a lookup table or a per-session map: the rule is a pure
 * function of the path, so the same name resolves to the same file on the next
 * call, in the next turn, and after a restart. That is what lets the model keep
 * using the bare name it chose while the bytes land somewhere tidy.
 */
export function placeDocument(root: string, requested: string): string {
  if (requested.includes("/")) return requested;

  const name = requested;
  // `extname(".pptx")` is "" — a leading dot names a hidden file, not an
  // extension. Such a path is refused downstream anyway for not being a
  // document, so there is no folder here worth inventing.
  const ext = extname(name);
  if (ext === "") return requested;

  const stem = name.slice(0, name.length - ext.length);
  if (stem === "" || stem === "." || stem === "..") return requested;

  if (existsSync(join(root, name))) return requested;
  return `${stem}/${name}`;
}

/**
 * Say what a failed native render means, in the user's terms.
 *
 * `--render native` needs PowerPoint or Word installed, and on a machine
 * without them OfficeCLI refuses rather than degrading. That is the expected
 * answer on most installs, not a defect, and it has one remedy the user can
 * act on — so it is named instead of relaying a CLI error about a render path.
 */
function nativeRenderProblem(detail: string): string {
  const text = trim(detail);
  if (/native|unavailable|not installed|powerpoint|word|interop|com\b/i.test(text)) {
    return (
      "a true-to-file render needs PowerPoint or Word installed on this machine; " +
      "the content preview beside it is OfficeCLI's own renderer, which is not a layout proof"
    );
  }
  return text || "the document could not be rendered by its own application";
}

/**
 * Take OfficeCLI's slide navigator out of a rendered preview, and publish the
 * slide list it was trying to be.
 *
 * The HTML view ships a navigator: a left-hand strip of slide thumbnails, a
 * hover-revealed `☰` toggle, and keyboard paging. Every part of it is
 * script-driven — the thumbnails are empty boxes that a script fills at load,
 * the toggle calls `toggleSidebar()`, the paging is a `keydown` listener. The
 * canvas renders this markup in an iframe with `sandbox=""` and deliberately no
 * `allow-scripts`, because it is output an agent produced rather than a page we
 * trust, so none of it ever runs: what the user actually sees is a column of
 * blank rectangles that do nothing when clicked.
 *
 * A control that cannot work is worse than no control, and granting scripts to
 * generated markup so a thumbnail strip can animate is not a trade worth
 * making. So the navigator is removed — and the same slides are returned as
 * plain data for the *host* page to draw, where a click is an ordinary React
 * event and the sandbox is not asked to keep a promise it cannot.
 *
 * Exported for test. If a future OfficeCLI renames these hooks the function
 * simply finds nothing: the markup comes back unchanged and the list comes back
 * empty. It never rewrites anything it did not positively identify.
 */
export function preparePreviewHtml(html: string): {
  html: string;
  slides: OfficePreviewSlide[];
  slideWidthPt: number;
  slideHeightPt: number;
} {
  const withoutToggle = html
    .replace(/<div\s+class="toggle-zone"[^>]*>\s*<\/div>/gi, "")
    .replace(/<button[^>]*class="sidebar-toggle"[^>]*>[\s\S]*?<\/button>/gi, "");
  // Read the list from the *stripped* markup: the navigator carries one
  // `data-slide` box per slide too, and counting both would double the index.
  const stripped = removeElement(withoutToggle, /<div[^>]*\bclass="sidebar"[^>]*>/i);
  return {
    html: stripped,
    slides: readSlides(stripped),
    slideWidthPt: readDesignLength(html, "w"),
    slideHeightPt: readDesignLength(html, "h"),
  };
}

/**
 * The slide design size OfficeCLI declares as `--slide-design-w: 960pt`.
 *
 * Only `pt` is accepted, because that is what it emits and a silently
 * misinterpreted unit would scale the whole preview wrong rather than fail.
 */
function readDesignLength(html: string, axis: "w" | "h"): number {
  const match = new RegExp(`--slide-design-${axis}\\s*:\\s*([\\d.]+)pt`, "i").exec(html);
  const value = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The slides in a rendered deck, in document order.
 *
 * OfficeCLI wraps each one in `<div class="slide-container" data-slide="N">`,
 * so the number is read rather than counted — a render that skipped a hidden
 * slide would otherwise be mislabelled. The title is the slide's own first line
 * of text, taken from the markup rather than from the file, because the point
 * of the index is to name what is *on screen*.
 */
function readSlides(html: string): OfficePreviewSlide[] {
  const containers = /<div[^>]*\bclass="slide-container"[^>]*\bdata-slide="(\d+)"[^>]*>/gi;
  const found: { number: number; at: number }[] = [];
  for (let match = containers.exec(html); match !== null; match = containers.exec(html)) {
    const number = Number(match[1]);
    if (Number.isSafeInteger(number) && number >= 1) found.push({ number, at: match.index });
  }

  return found.map((slide, index) => ({
    number: slide.number,
    // Each container runs to the start of the next one, or to the end.
    title: slideTitle(html.slice(slide.at, found[index + 1]?.at ?? html.length)),
  }));
}

/**
 * A slide's name for the index: the text of its **first shape**, and no more.
 *
 * The first shape is the title — it is the one a layout emits first and the one
 * `--prop title=` creates. Taking the whole container instead ran the title and
 * every bullet together, so a six-slide index read as six paragraphs and the
 * rows were impossible to tell apart. A title-only row is also a fixed height,
 * which is what makes the list scannable.
 */
function slideTitle(container: string): string {
  const shape = /<div[^>]*\bclass="shape[^"]*"[^>]*>/i.exec(container);
  const scope = shape === null ? container : firstElement(container, shape.index);
  return firstLine(scope);
}

/** The first element and its descendants, by counting nested `div` tags. */
function firstElement(html: string, start: number): string {
  const tags = /<div\b[^>]*>|<\/div\s*>/gi;
  tags.lastIndex = start;
  let depth = 0;
  for (let tag = tags.exec(html); tag !== null; tag = tags.exec(html)) {
    depth += tag[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, tags.lastIndex);
  }
  return html.slice(start);
}

/**
 * The first readable line of a slide, capped for a narrow index.
 *
 * `slide-label` ("Slide 3") is dropped: it repeats the number the index already
 * shows, and would leave every row reading the same. Entities are decoded —
 * a slide titled "AI & Innovation" renders as `AI &amp; Innovation`, and an
 * index that showed the escape would look like a bug.
 */
function firstLine(container: string): string {
  const text = container
    .replace(/<div[^>]*\bclass="slide-label"[^>]*>[\s\S]*?<\/div>/i, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (match, entity: string) => {
      const table: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        "#39": "'",
        apos: "'",
        nbsp: " ",
      };
      return table[entity] ?? match;
    })
    // The bullet glyph OfficeCLI renders is decoration, not the slide's words.
    .replace(/[•‣▪]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= SLIDE_TITLE_MAX ? text : `${text.slice(0, SLIDE_TITLE_MAX - 1).trimEnd()}…`;
}

/** Long enough to recognise a slide by, short enough for a 200px column. */
const SLIDE_TITLE_MAX = 60;

/**
 * Remove the first `<div>` matching `opening` together with everything it
 * contains, by counting nested `div` tags. A regex cannot do this: the sidebar
 * holds one nested div per slide, so a non-greedy match to the first `</div>`
 * would leave the rest of the thumbnails orphaned in the body.
 */
function removeElement(html: string, opening: RegExp): string {
  const start = opening.exec(html);
  if (!start) return html;

  const tags = /<div\b[^>]*>|<\/div\s*>/gi;
  tags.lastIndex = start.index;
  let depth = 0;
  for (let tag = tags.exec(html); tag !== null; tag = tags.exec(html)) {
    depth += tag[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(0, start.index) + html.slice(tags.lastIndex);
  }
  // Unbalanced markup: leave it alone rather than truncate the document.
  return html;
}

/** Windows-only pinned download; the app targets Windows x64/arm64. */
function downloadUrl(version: string): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `https://github.com/iOfficeAI/OfficeCLI/releases/download/v${version}/officecli-win-${arch}.exe`;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * An OfficeCLI *element* selector: `/`, `/slide[1]`, `/body/p[1]/r[2]`.
 *
 * These address a node inside the document, not a location on disk, and they
 * always begin with `/`.
 */
const ELEMENT_SELECTOR = /^\/(?:[A-Za-z_][A-Za-z0-9_-]*(?:\[[^\]\\/]*\])*(?:\/|$))*$/;

/**
 * Whether an argv token names a place on the filesystem.
 *
 * This replaced a bare `isAbsolute(arg)` check, which was wrong in both
 * directions and had made Office authoring impossible:
 *
 *  - **It refused every legitimate call.** An element selector starts with `/`,
 *    and `isAbsolute("/")` is true on Windows as well as POSIX — so every
 *    `add`, `set` and `remove` the agent issued was denied by our own guard
 *    before OfficeCLI ever saw it. A deck could be created and then never
 *    filled in.
 *  - **It caught none of what it was written for.** The dangerous shape is a
 *    path inside a property value, and `isAbsolute("src=C:\\Windows\\win.ini")`
 *    is false — the `src=` prefix hides it. The test that claimed to pin this
 *    was passing on the `/` token in the same argument list, not on the
 *    property at all.
 *
 * So the value half of a `key=value` token is what gets examined, an element
 * selector is recognised and allowed, and drive-absolute, UNC, absolute and
 * climbing (`..`) paths are all refused.
 *
 * Known limit, stated rather than hidden: a POSIX absolute path whose shape is
 * also a valid selector (`/etc/passwd`) is allowed through. Closing it would
 * mean refusing selectors, which is the failure this replaced. The app's
 * OfficeCLI is a Windows binary, where such a token is not a path.
 */
function namesFilesystemPath(token: string): boolean {
  const separator = token.indexOf("=");
  const value = separator === -1 ? token : token.slice(separator + 1);
  if (value === "") return false;
  if (ELEMENT_SELECTOR.test(value)) return false;
  // `C:\…` or `C:/…`, and `\\server\share`.
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) return true;
  if (isAbsolute(value)) return true;
  // A relative path that climbs out of the project once resolved.
  return value.split(/[\\/]/).includes("..");
}

/** Descending semantic-ish comparison; non-numeric parts fall back to string order. */
function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10));
  const pb = b.split(".").map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (Number.isNaN(na) || Number.isNaN(nb)) return b.localeCompare(a);
    if (na !== nb) return nb - na;
  }
  return 0;
}

function trim(text: string, limit = 500): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

/**
 * The default subprocess runner and the single place `child_process` is used.
 * `shell: false` with an explicit argv means an argument can never become a
 * command line; the timeout kills a hung run; the byte cap kills a runaway that
 * would otherwise exhaust memory.
 */
const nodeOfficeSpawn: OfficeSpawn = (command, args, options) =>
  new Promise<OfficeSpawnResult>((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new TimeoutError(`OfficeCLI ${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    const capture = (append: (chunk: string) => void) => (chunk: string) => {
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill();
          reject(new Error("OfficeCLI produced more output than allowed"));
        }
        return;
      }
      append(chunk);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", capture((chunk) => (stdout += chunk)));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", capture((chunk) => (stderr += chunk)));

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`could not start OfficeCLI: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });

    if (options.input !== undefined) child.stdin?.write(options.input);
    child.stdin?.end();
  });

/** Re-exported so a caller can assert an install path lands under the tools dir. */
export { PINNED_VERSION };
