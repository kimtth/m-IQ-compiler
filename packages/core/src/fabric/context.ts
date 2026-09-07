import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { promisify } from "node:util";
import { MAX_INLINE_FILE_BYTES, MAX_INLINE_TOTAL_BYTES } from "@iq/shared";
import type { Logger } from "../util/logger.js";
import type { AppPaths } from "../config/paths.js";

const run = promisify(execFile);

/**
 * Turning a pile of source documents into context an agent can design from.
 *
 * Document extraction runs **only when the readable context does not fit in a
 * single turn.** A data dictionary that fits inline is reasoned over directly;
 * running a knowledge-graph pipeline over it first would spend minutes to
 * produce a worse version of something already in the prompt.
 *
 * Two choices follow from this being a governed Electron app rather than a
 * shell loop.
 *
 * **The tools run in a Python virtual environment this module owns.**
 * MarkItDown is Python; letting an agent `pip install` whatever it needs
 * through an approved shell would be a command with an unbounded blast radius
 * wearing an "extract a PDF" label. Here the venv lives under
 * `<IQ_HOME>/tools/py`, is created once, and holds a fixed package set — so
 * extraction is a subprocess with a known argv rather than an agent-authored
 * command line.
 *
 * **Absence is a downgrade, not a failure.** No Python, or no venv, means files
 * that need extraction are reported as unreadable and the run continues on the
 * ones that did not. A Fabric run that refuses to start because a PDF could not
 * be parsed would be worse than one that says which file it could not read.
 */

/** Extensions readable as text without any extraction step. */
const PLAIN_TEXT = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".yaml",
  ".yml",
  ".sql",
  ".xml",
  ".ini",
  ".toml",
  ".py",
  ".ts",
  ".js",
]);

/** Extensions MarkItDown can reduce to Markdown. */
const EXTRACTABLE = new Set([
  ".pdf",
  ".docx",
  ".doc",
  ".pptx",
  ".ppt",
  ".xlsx",
  ".xls",
  ".html",
  ".htm",
  ".png",
  ".jpg",
  ".jpeg",
]);

/** The fixed package set. Pinned loosely: these are read-only converters. */
const VENV_PACKAGES = ["markitdown[all]"] as const;

const VENV_CREATE_TIMEOUT_MS = 10 * 60_000;
const CONVERT_TIMEOUT_MS = 5 * 60_000;

export interface FileContext {
  /** Files whose text is inlined in the prompt, in the order chosen. */
  inlined: Array<{ path: string; bytes: number; text: string }>;
  /** Files that were extracted to Markdown under the run's context directory. */
  extracted: Array<{ path: string; markdownPath: string; bytes: number }>;
  /** Files that could not be read, and why. Reported, never silently dropped. */
  unreadable: Array<{ path: string; reason: string }>;
  /** Total inlined bytes, so the caller can see how close to the cap it ran. */
  inlinedBytes: number;
  /**
   * Whether the readable context fits in one turn.
   *
   * False means the heavier context pipeline is needed; true means the agent
   * reasons over the inline text directly.
   */
  fitsInOneTurn: boolean;
}

export interface ContextBuilderDeps {
  paths: AppPaths;
  logger: Logger;
  /** Resolves the project root a relative path is measured from. */
  projectDir: () => string | null;
}

export class FabricContextBuilder {
  constructor(private readonly deps: ContextBuilderDeps) {}

  private get venvDir(): string {
    return join(this.deps.paths.tools, "py");
  }

  /** The venv's interpreter, wherever this platform puts it. */
  private get venvPython(): string {
    return process.platform === "win32"
      ? join(this.venvDir, "Scripts", "python.exe")
      : join(this.venvDir, "bin", "python");
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether extraction is available, and why not if it is not.
   *
   * Reported to the UI so "this PDF was skipped" comes with a fix rather than a
   * shrug.
   */
  async readiness(): Promise<{ ready: boolean; python: string; message: string }> {
    if (await this.exists(this.venvPython)) {
      return { ready: true, python: this.venvPython, message: "" };
    }
    const host = await this.hostPython();
    if (host === null) {
      return {
        ready: false,
        python: "",
        message:
          "Python 3 was not found, so PDFs, Office documents and images cannot be read. Install Python 3 and press Prepare, or add those sources as Markdown.",
      };
    }
    return {
      ready: false,
      python: host,
      message:
        "Document extraction is not prepared yet. Press Prepare to create a local Python environment with MarkItDown in it — nothing is installed system-wide.",
    };
  }

  /** A usable `python3`/`python` on PATH, or null. */
  private async hostPython(): Promise<string | null> {
    for (const candidate of process.platform === "win32"
      ? ["python", "py"]
      : ["python3", "python"]) {
      try {
        const { stdout } = await run(candidate, ["--version"], {
          timeout: 15_000,
          windowsHide: true,
        });
        // Refuse Python 2: MarkItDown needs 3.10+, and the error it produces
        // otherwise is a syntax error nobody can act on.
        if (/Python 3\./.test(stdout)) return candidate;
      } catch {
        // Try the next name.
      }
    }
    return null;
  }

  /**
   * Create the virtual environment and install the converter set.
   *
   * Explicit rather than lazy. Creating a venv and downloading a few hundred
   * megabytes on the first Fabric run would look like a hang at exactly the
   * moment the user is waiting for artifacts, so it is a control they press.
   */
  async prepare(): Promise<{ python: string }> {
    const host = await this.hostPython();
    if (host === null) {
      throw new Error(
        "Python 3 was not found on PATH. Install Python 3.10 or newer, then press Prepare again.",
      );
    }

    await mkdir(this.deps.paths.tools, { recursive: true });
    if (!(await this.exists(this.venvPython))) {
      this.deps.logger.info("creating the Fabric context virtual environment", {
        dir: this.venvDir,
      });
      await run(host, ["-m", "venv", this.venvDir], {
        timeout: VENV_CREATE_TIMEOUT_MS,
        windowsHide: true,
      });
    }

    await run(
      this.venvPython,
      ["-m", "pip", "install", "--upgrade", "--disable-pip-version-check", ...VENV_PACKAGES],
      { timeout: VENV_CREATE_TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
    );

    return { python: this.venvPython };
  }

  /**
   * Build bounded context from an explicit list of project-relative files.
   *
   * The list is an allow-list, never a folder. Reading only explicitly listed
   * project files prevents a pipeline pointed at a directory from ingesting
   * whatever happens to be in it — which is how unrelated local data ends up
   * described in a shared Fabric workspace.
   *
   * Ordering is by size, smallest first. A schema definition and a 40 MB export
   * are both "context", and when only one fits, the small structured one is
   * almost always the useful half.
   */
  async build(input: {
    files: readonly string[];
    contextDir: string;
  }): Promise<FileContext> {
    const root = this.deps.projectDir();
    const context: FileContext = {
      inlined: [],
      extracted: [],
      unreadable: [],
      inlinedBytes: 0,
      fitsInOneTurn: true,
    };

    if (root === null) {
      for (const path of input.files) {
        context.unreadable.push({ path, reason: "no project is bound" });
      }
      return context;
    }

    const sized: Array<{ path: string; absolute: string; bytes: number }> = [];
    for (const path of input.files) {
      const absolute = await this.resolveInside(root, path);
      if (absolute === null) {
        context.unreadable.push({ path, reason: "outside the bound project" });
        continue;
      }
      try {
        sized.push({ path, absolute, bytes: (await stat(absolute)).size });
      } catch {
        context.unreadable.push({ path, reason: "the file could not be read" });
      }
    }
    sized.sort((a, b) => a.bytes - b.bytes);

    const extraction = await this.readiness();

    for (const file of sized) {
      const extension = extname(file.path).toLowerCase();

      if (PLAIN_TEXT.has(extension)) {
        if (
          file.bytes > MAX_INLINE_FILE_BYTES ||
          context.inlinedBytes + file.bytes > MAX_INLINE_TOTAL_BYTES
        ) {
          // Too big to inline is not the same as unreadable: it is written to
          // the run's context directory, where the agent can open the part it
          // needs instead of being handed all of it.
          const markdownPath = await this.copyAsMarkdown(file.absolute, file.path, input.contextDir);
          context.extracted.push({ path: file.path, markdownPath, bytes: file.bytes });
          context.fitsInOneTurn = false;
          continue;
        }
        const text = await readFile(file.absolute, "utf8");
        context.inlined.push({ path: file.path, bytes: file.bytes, text });
        context.inlinedBytes += file.bytes;
        continue;
      }

      if (EXTRACTABLE.has(extension)) {
        if (!extraction.ready) {
          context.unreadable.push({ path: file.path, reason: extraction.message });
          continue;
        }
        try {
          const markdownPath = await this.toMarkdown(file.absolute, file.path, input.contextDir);
          context.extracted.push({ path: file.path, markdownPath, bytes: file.bytes });
          context.fitsInOneTurn = false;
        } catch (error) {
          context.unreadable.push({
            path: file.path,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }

      context.unreadable.push({
        path: file.path,
        reason: `${extension || "this file type"} is not a document this pipeline can read`,
      });
    }

    return context;
  }

  /** MarkItDown, in the venv, writing beside the run rather than the source. */
  private async toMarkdown(
    absolute: string,
    relativePath: string,
    contextDir: string,
  ): Promise<string> {
    await mkdir(contextDir, { recursive: true });
    const output = join(contextDir, `${flatten(relativePath)}.md`);
    await run(this.venvPython, ["-m", "markitdown", absolute, "-o", output], {
      timeout: CONVERT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    return output;
  }

  /** A too-large text file, staged whole so the agent can read parts of it. */
  private async copyAsMarkdown(
    absolute: string,
    relativePath: string,
    contextDir: string,
  ): Promise<string> {
    await mkdir(contextDir, { recursive: true });
    const output = join(contextDir, `${flatten(relativePath)}.md`);
    await writeFile(output, await readFile(absolute, "utf8"), "utf8");
    return output;
  }

  /**
   * Prove a path stays inside the project before anything opens it.
   *
   * The renderer supplies these paths, so containment is checked here rather
   * than trusted — the same rule every other project read in this app follows.
   */
  private async resolveInside(root: string, path: string): Promise<string | null> {
    const absolute = join(root, path);
    const inside = relative(root, absolute);
    if (inside.startsWith("..") || inside === "") return null;
    return absolute;
  }

  /**
   * A shallow listing of candidate source files, for the intake picker.
   *
   * Deliberately not recursive past a couple of levels and capped: the picker
   * is a way to choose a handful of documents, and a project with a
   * `node_modules` in it should not produce ten thousand rows.
   */
  async candidates(limit = 500): Promise<Array<{ path: string; bytes: number }>> {
    const root = this.deps.projectDir();
    if (root === null) return [];

    const found: Array<{ path: string; bytes: number }> = [];
    const skip = new Set(["node_modules", ".git", "dist", "out", "build", ".venv", "__pycache__"]);

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 3 || found.length >= limit) return;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (found.length >= limit) return;
        const name = String(entry.name);
        if (name.startsWith(".") || skip.has(name)) continue;
        const absolute = join(dir, name);
        if (entry.isDirectory()) {
          await walk(absolute, depth + 1);
          continue;
        }
        const extension = extname(name).toLowerCase();
        if (!PLAIN_TEXT.has(extension) && !EXTRACTABLE.has(extension)) continue;
        try {
          found.push({ path: relative(root, absolute), bytes: (await stat(absolute)).size });
        } catch {
          // A file that vanished between listing and stat is not worth a row.
        }
      }
    };

    await walk(root, 0);
    return found.sort((a, b) => a.path.localeCompare(b.path));
  }
}

/** A project-relative path flattened into one safe filename. */
function flatten(path: string): string {
  return path.replace(/[\\/]/g, "__").replace(/[^A-Za-z0-9._-]/g, "-");
}
