import { copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { KnowledgeSource, KnowledgeVaultState } from "@iq/shared";
import { readJson, writeJsonAtomic } from "../util/jsonl.js";
import { KeyedMutex } from "../util/lock.js";
import { SAMPLE_SOURCE_FILES, SAMPLE_VAULT_NOTES } from "../samples/vault.js";
import {
  SOURCE_DIR,
  generateNotes,
  isGeneratedNote,
  type SourceFile,
} from "./ingest.js";
import type { AppPaths } from "../config/paths.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { Logger } from "../util/logger.js";

/**
 * The knowledge vault: the corpus root the graph is built from.
 *
 * The graph used to index the project directory, which conflated two
 * different things. The project is where the agent *writes* — generated
 * decks, scratch output, run artifacts — while the knowledge corpus is a
 * curated body of notes and media the user maintains, in Obsidian's sense of a
 * vault: one isolated directory that owns its own links and tags. Indexing the
 * project meant every intermediate file the agent produced became a node.
 *
 * So the vault is a separate, explicitly chosen directory. It is:
 *
 *  - **Optional.** With none chosen the graph falls back to the project, so
 *    an install that never touches this setting behaves exactly as before.
 *  - **Read-only to the indexer.** Choosing a vault grants no write access; the
 *    agent's file boundary is still the project navigator's tree.
 *  - **Stored as a realpath, never a symlink**, and refused when it is the app's
 *    own state root or an ancestor of it, so the audit log and credential-
 *    adjacent state can never be swept into an index.
 *
 * ## Two halves
 *
 * ```
 * <vault>/source/   raw files, exactly as they arrived. Never indexed.
 * <vault>/          generated notes, and only what the graph is made of.
 * ```
 *
 * The split exists because the two are different kinds of thing. A folder of
 * spreadsheets and reports produces a graph of isolated dots, since none of
 * them link to each other; the notes that *do* link are written from them. So
 * `source/` is created with the vault, the sources go in it, and Ingest turns
 * them into the vault proper. Keeping the raw files out of the index is what
 * stops every report appearing twice — once as itself, once as its note.
 */

interface StoredVault {
  /** Absolute realpath of the chosen vault, or null for "use the project". */
  directory: string | null;
  /**
   * True when `directory` is the demo vault this app wrote for itself.
   *
   * Recorded rather than derived by comparing paths: a realpath comparison has
   * to get symlinks and Windows case-folding right to answer a question the
   * writer already knew the answer to, and getting it wrong would offer to
   * delete a directory the user chose.
   */
  samples?: boolean;
}

const EMPTY: StoredVault = { directory: null, samples: false };

/**
 * What to tell someone whose PDF produced no note.
 *
 * Three states, three different next steps. The middle one is the one this
 * app got wrong: MarkItDown had been added and had inspected cleanly, so the
 * MCP surface showed it as `ok` — but it was never enabled and its tool was
 * never approved, and both `converterTarget` and `gate` require those, so it
 * never launched. "A converter is needed" would have been a lie; the converter
 * was there.
 */
function converterHintFor(unreadable: number, converterAvailable: boolean): string {
  if (unreadable === 0) return "";
  if (converterAvailable) {
    return "A converter is in use but could not read these files. They may be encrypted, scanned without text, or corrupt.";
  }
  return (
    "No document converter is in use, so these were skipped. Open MCP servers, add MarkItDown, " +
    "then approve its convert_to_markdown tool and press Enable — a server that has been inspected " +
    "but not enabled and approved will never launch."
  );
}


/** Bounds on the source half, so an untidy folder cannot stall an ingest. */
const MAX_SOURCE_FILES = 2_000;
const MAX_SOURCE_BYTES = 1_000_000;
const MAX_SOURCE_DEPTH = 8;

const exists = async (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

export interface KnowledgeVaultDeps {
  paths: AppPaths;
  audit: AuditLog;
  logger: Logger;
  correlationId: () => string;
  /**
   * Turn a file this process cannot read as text into Markdown.
   *
   * Optional, and expected to be absent most of the time: the converter is
   * Microsoft's MarkItDown, which is an MCP server the user adds and approves
   * rather than something bundled here. Ingest works without it — it just
   * cannot make a note out of a PDF, and says so instead of pretending.
   */
  convert?: (absolutePath: string) => Promise<string | null>;
  /**
   * Whether an approved, enabled converter exists right now.
   *
   * Separate from `convert` because the two answer different questions, and
   * conflating them is what made a disabled MarkItDown server look like a
   * corrupt file. Resolved per call, so approving the tool takes effect on the
   * next ingest rather than the next launch.
   */
  converterAvailable?: () => Promise<boolean>;
}

/** A file found in `source/`, before anything has been made of it. */
interface ReadSource {
  path: string;
  absolute: string;
  /** Null when this process could not read it as text. */
  text: string | null;
  bytes: number;
  updatedAt: string;
}

export interface IngestResult {
  sources: number;
  generated: number;
  removed: number;
  /** How many needed MarkItDown to become readable. */
  converted: number;
  /** Sources that produced no note, and why the count matters: nobody guessed. */
  unreadable: string[];
  /**
   * What to do about the unreadable ones. Empty when there are none.
   *
   * Names the *specific* next step rather than "a converter is needed": whether
   * one is absent entirely, or present but not yet enabled and approved, is the
   * difference between installing something and ticking a box.
   */
  converterHint: string;
}

export class KnowledgeVault {
  private state: StoredVault = EMPTY;
  private loaded = false;
  private stateRootReal: string | null = null;
  private readonly lock = new KeyedMutex();
  private readonly listeners = new Set<(directory: string) => void>();

  constructor(private readonly deps: KnowledgeVaultDeps) {}

  private get file(): string {
    return join(this.deps.paths.config, "knowledge-vault.json");
  }

  /** Load the persisted choice. Awaited once before the synchronous reads. */
  async init(): Promise<void> {
    await this.lock.withLock("vault", async () => {
      if (this.loaded) return;
      const raw = await readJson<StoredVault | null>(this.file, null);
      this.state = { directory: raw?.directory ?? null, samples: raw?.samples ?? false };
      this.loaded = true;
    });
  }

  /**
   * The directory to index.
   *
   * Synchronous, because the indexer takes it as a plain resolver: falls back
   * to the project so there is always a root, chosen or not.
   */
  root(): string {
    return this.state.directory ?? this.deps.paths.project;
  }

  /** What the UI shows: the chosen path, or the project fallback. */
  async current(): Promise<KnowledgeVaultState> {
    const directory = this.root();
    const info = await lstat(directory).catch(() => null);
    return {
      directory,
      isDefault: this.state.directory === null,
      isSamples: this.state.samples === true,
      exists: Boolean(info?.isDirectory()),
      fallback: this.deps.paths.project,
      sourceDirectory: this.sourceDirectory,
      sources: await this.countSources(),
    };
  }

  /** Where raw files live. Created with the vault, and never indexed. */
  get sourceDirectory(): string {
    return join(this.root(), SOURCE_DIR);
  }

  private async countSources(): Promise<number> {
    const found = await this.readSources().catch(() => []);
    return found.length;
  }

  /** What is waiting in `source/`, for the panel that shows it. */
  async listSources(): Promise<KnowledgeSource[]> {
    const found = await this.readSources().catch(() => []);
    return found
      .map((source) => ({
        path: source.path,
        bytes: source.bytes,
        updatedAt: source.updatedAt,
        readable: source.text !== null,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Delete one file from `source/`.
   *
   * The path arrives from the renderer, so it is treated as hostile: relative
   * only, resolved, and checked to be genuinely inside the source directory
   * before anything is unlinked. Deleting the source does not delete the note
   * it produced — the next ingest does that, which is when the user is looking.
   */
  async removeSource(path: string): Promise<void> {
    const root = this.sourceDirectory;
    const candidate = resolve(root, path);
    const rel = relative(root, candidate);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("that path is not inside the vault's source folder");
    }
    const info = await lstat(candidate).catch(() => null);
    if (!info?.isFile()) throw new Error(`no source file at ${path}`);

    await rm(candidate, { force: true });
    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "knowledge.removeSource",
      family: "knowledge",
      outcome: "succeeded",
      correlationId: this.deps.correlationId(),
      resources: [candidate],
    });
    this.deps.logger.info("source removed", { file: candidate });
  }

  /**
   * Copy files into `source/`.
   *
   * Copied rather than referenced: a vault that points at files elsewhere on
   * the disk is a vault that breaks when someone tidies their downloads, and
   * the graph would then describe notes whose sources cannot be re-read. The
   * originals are untouched.
   */
  async addSources(files: readonly string[]): Promise<{ added: number; skipped: number }> {
    const target = this.sourceDirectory;
    await mkdir(target, { recursive: true });

    let added = 0;
    let skipped = 0;
    for (const file of files) {
      const info = await lstat(file).catch(() => null);
      // Not followed, and not walked: a symlink or a directory here would let a
      // file picker pull in far more than the person chose.
      if (!info?.isFile()) {
        skipped += 1;
        continue;
      }
      const name = basename(file);
      let destination = join(target, name);
      for (let n = 2; await exists(destination); n += 1) {
        const stem = name.slice(0, name.length - extname(name).length);
        destination = join(target, `${stem}-${n}${extname(name)}`);
      }
      await copyFile(file, destination);
      added += 1;
    }

    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "knowledge.addSources",
      family: "knowledge",
      outcome: "succeeded",
      correlationId: this.deps.correlationId(),
      resources: [target],
      reason: `${added} source files copied in, ${skipped} skipped`,
    });

    this.deps.logger.info("sources added", { target, added, skipped });
    return { added, skipped };
  }

  /**
   * Turn everything under `source/` into Obsidian notes in the vault root.
   *
   * Anything this process cannot read as text is handed to the converter first
   * — MarkItDown, when the user has added and approved it — so a PDF or a
   * spreadsheet becomes Markdown rather than being skipped. Without a converter
   * those files are reported back rather than quietly dropped: a source that
   * produced no note is a fact the person who added it needs to know.
   *
   * Notes this ingest wrote before are removed first, so deleting a source
   * removes its note rather than leaving an orphan the graph still believes in.
   * Nothing without the generated marker is touched: a note somebody wrote by
   * hand, or the demo vault, survives an ingest untouched.
   */
  async ingest(): Promise<IngestResult> {
    const root = this.root();
    const read = await this.readSources();

    /**
     * Whether an approved, enabled converter exists — asked once, before the
     * loop, and separately from converting anything.
     *
     * "No converter is in use" and "the converter failed on this file" are
     * different problems with different fixes, and reporting both as
     * `unreadable` is exactly how a MarkItDown server that was added,
     * inspected, and then left disabled with no approved tool becomes
     * indistinguishable from a corrupt PDF. That is a real failure this app
     * shipped: the server sits at `state: ok` and never launches, because both
     * `converterTarget` and `gate` require enabled *and* an approved tool.
     */
    const converterAvailable = (await this.deps.converterAvailable?.()) ?? false;

    const usable: SourceFile[] = [];
    let converted = 0;
    const unreadable: string[] = [];
    for (const source of read) {
      if (source.text !== null) {
        usable.push({
          path: source.path,
          text: source.text,
          bytes: source.bytes,
          updatedAt: source.updatedAt,
        });
        continue;
      }
      const markdown = await this.deps.convert?.(source.absolute).catch(() => null);
      if (markdown === null || markdown === undefined || markdown.trim() === "") {
        unreadable.push(source.path);
        continue;
      }
      converted += 1;
      usable.push({
        path: source.path,
        text: markdown,
        bytes: source.bytes,
        updatedAt: source.updatedAt,
      });
    }

    const notes = generateNotes(usable);

    // Where each note may actually go, decided before anything is written: the
    // stale-note sweep below compares against the paths that will exist, and a
    // note that had to step aside from a hand-written file must not then be
    // deleted for sitting somewhere unexpected.
    const claimed = new Set<string>();
    const planned: Array<{ file: string; rel: string; text: string }> = [];
    for (const note of notes) {
      const file = await this.freePath(root, note.path, claimed);
      claimed.add(file);
      planned.push({ file, rel: relative(root, file).split(sep).join("/"), text: note.text });
    }

    const keep = new Set(planned.map((note) => note.rel));
    let removed = 0;
    for (const stale of await this.generatedNotes()) {
      if (keep.has(stale)) continue;
      await rm(join(root, ...stale.split("/")), { force: true });
      removed += 1;
    }

    for (const note of planned) {
      await mkdir(dirname(note.file), { recursive: true });
      await writeFile(note.file, note.text, "utf8");
    }

    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "knowledge.ingest",
      family: "knowledge",
      outcome: "succeeded",
      correlationId: this.deps.correlationId(),
      resources: [root],
      reason:
        `${read.length} sources ingested into ${notes.length} notes, ${removed} removed, ` +
        `${converted} converted, ${unreadable.length} unreadable`,
    });

    this.deps.logger.info("vault ingested", {
      root,
      sources: read.length,
      generated: notes.length,
      removed,
      converted,
      unreadable: unreadable.length,
    });
    return {
      sources: read.length,
      generated: notes.length,
      removed,
      converted,
      unreadable,
      converterHint: converterHintFor(unreadable.length, converterAvailable),
    };
  }

  /**
   * Read `source/`, bounded on every axis an untidy folder could blow up.
   *
   * A file this process cannot read as text is *kept*, with `text: null`, not
   * dropped. A PDF is exactly the kind of thing someone puts in a knowledge
   * folder, and silently ignoring it would mean the panel says nothing is
   * wrong while the note never appears. The converter decides what to do next.
   */
  private async readSources(): Promise<ReadSource[]> {
    const root = this.sourceDirectory;
    const out: ReadSource[] = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_SOURCE_DEPTH || out.length >= MAX_SOURCE_FILES) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (out.length >= MAX_SOURCE_FILES) return;
        if (entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;

        const info = await stat(full).catch(() => null);
        if (!info || info.size > MAX_SOURCE_BYTES) continue;
        const raw = await readFile(full, "utf8").catch(() => null);
        const text = raw !== null && !raw.includes("\u0000") ? raw : null;

        out.push({
          path: relative(root, full).split(sep).join("/"),
          absolute: full,
          text,
          bytes: info.size,
          updatedAt: info.mtime.toISOString(),
        });
      }
    };

    await walk(root, 0);
    return out;
  }

  /**
   * Where a generated note may actually be written.
   *
   * Ingest owns the notes it wrote and overwrites them freely — that is how a
   * changed source updates its note. It owns nothing else. A note somebody
   * wrote by hand that happens to sit at the same path is not a stale copy to
   * replace, and clobbering it would destroy work to tidy a filename: the
   * demo vault has a `reports/weekly-update.md`, and an ingested source of
   * the same name quietly replaced it before this existed.
   */
  private async freePath(
    root: string,
    relativePath: string,
    claimed: ReadonlySet<string>,
  ): Promise<string> {
    const segments = relativePath.split("/");
    const name = segments.pop() ?? relativePath;
    const stem = name.slice(0, name.length - extname(name).length);
    const dir = segments;

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const leaf =
        attempt === 0 ? name : attempt === 1 ? `${stem}-ingested.md` : `${stem}-ingested-${attempt}.md`;
      const candidate = join(root, ...dir, leaf);
      if (claimed.has(candidate)) continue;
      const existing = await readFile(candidate, "utf8").catch(() => null);
      if (existing === null || isGeneratedNote(existing)) return candidate;
    }
    // Fifty collisions is not a naming problem any more; refuse rather than
    // guess, so nothing is written over.
    throw new Error(`cannot place a note for ${relativePath} without overwriting existing notes`);
  }

  /** Vault-relative paths of the notes a previous ingest wrote. */
  private async generatedNotes(): Promise<string[]> {
    const root = this.root();
    const out: string[] = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_SOURCE_DEPTH) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        // Never the source half: those are inputs, whatever they contain.
        if (depth === 0 && entry.name === SOURCE_DIR) continue;
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") continue;
        const text = await readFile(full, "utf8").catch(() => "");
        if (isGeneratedNote(text)) out.push(relative(root, full).split(sep).join("/"));
      }
    };

    await walk(root, 0);
    return out;
  }

  /** Where the demo vault is written. App-owned, and safe to delete. */
  get samplesDirectory(): string {
    return join(this.deps.paths.samples, "knowledge-vault");
  }

  /**
   * Write the demo vault and index it.
   *
   * A knowledge graph is a consequence of Markdown files, so a demo of one has
   * to start from files a reader can open. There is no vault to point at on a
   * fresh install, and the project fallback holds whatever the agent last
   * wrote, which draws as nothing. The notes come from a fixed constant in
   * privileged code, so this asks for *that* vault and can say nothing else
   * about what a note contains.
   *
   * Written under the app's own `samples/` directory rather than into the
   * user's project: a demo must not put 220 files somewhere the user keeps
   * their own, and it must be removable in one step.
   */
  async installSamples(): Promise<KnowledgeVaultState> {
    const directory = this.samplesDirectory;
    // Rewritten rather than merged, so a half-deleted or edited copy from an
    // earlier run cannot leave the vault describing something that is not this.
    await rm(directory, { recursive: true, force: true });
    for (const note of SAMPLE_VAULT_NOTES) {
      const file = join(directory, ...note.path.split("/"));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, note.text, "utf8");
    }
    this.deps.logger.info("sample vault written", {
      directory,
      notes: SAMPLE_VAULT_NOTES.length,
    });
    // Raw files in the source half as well, so Ingest has something to do. The
    // notes above show what a finished vault looks like; these show where one
    // comes from, which is the step nobody believes until they watch it.
    for (const source of SAMPLE_SOURCE_FILES) {
      const file = join(directory, SOURCE_DIR, ...source.path.split("/"));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, source.text, "utf8");
    }
    return this.assign(directory, true);
  }

  /**
   * Delete the demo vault.
   *
   * Only ever the app's own samples directory, and the vault only falls back to
   * the project when it was pointing there — a user who installed the samples
   * and then chose a vault of their own keeps their choice.
   */
  async removeSamples(): Promise<KnowledgeVaultState> {
    await rm(this.samplesDirectory, { recursive: true, force: true });
    this.deps.logger.info("sample vault removed", { directory: this.samplesDirectory });
    if (this.state.samples === true) return this.assign(null, false);
    return this.current();
  }

  /**
   * Choose a vault, or pass null to fall back to the project.
   *
   * Listeners are notified after the change is persisted so a reindex reads the
   * new root; the cached graph on disk is stale the moment this returns and is
   * overwritten by the reindex the caller is expected to trigger.
   */
  async set(directory: string | null): Promise<KnowledgeVaultState> {
    return this.assign(directory, false);
  }

  private async assign(directory: string | null, samples: boolean): Promise<KnowledgeVaultState> {
    return this.lock.withLock("vault", async () => {
      await this.ensureLoaded();

      const next = directory === null ? null : await this.adopt(directory.trim());
      this.state = { directory: next, samples: next === null ? false : samples };
      await writeJsonAtomic(this.file, this.state);

      // The half of the layout that has to exist before anyone can use it. A
      // vault whose `source/` appears only after the first ingest is a vault
      // nobody knows where to put their files in.
      await mkdir(join(this.root(), SOURCE_DIR), { recursive: true }).catch(() => undefined);

      await this.deps.audit.record({
        actor: { kind: "system" },
        action: samples ? "knowledge.vaultSamples" : "knowledge.vault",
        family: "knowledge",
        outcome: "allowed",
        correlationId: this.deps.correlationId(),
        resources: [next ?? "project (default)"],
        reason: samples
          ? "demo knowledge vault installed and indexed"
          : next
            ? "knowledge vault directory chosen"
            : "knowledge vault reset to the project",
      });

      const root = this.root();
      this.deps.logger.info("knowledge vault set", { root, isDefault: next === null });
      for (const listener of this.listeners) listener(root);
      return this.current();
    });
  }

  /** Observe vault changes, so the indexer can rebuild against the new root. */
  onChange(listener: (directory: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const raw = await readJson<StoredVault | null>(this.file, null);
    this.state = { directory: raw?.directory ?? null, samples: raw?.samples ?? false };
    this.loaded = true;
  }

  private async adopt(directory: string): Promise<string> {
    if (!directory) throw new Error("a vault directory must not be empty");
    if (!isAbsolute(directory)) throw new Error("a vault directory must be an absolute path");

    const info = await lstat(directory).catch(() => null);
    if (!info) throw new Error(`directory does not exist: ${directory}`);
    if (info.isSymbolicLink()) throw new Error("a vault directory must not be a symlink");
    if (!info.isDirectory()) throw new Error("a vault directory must be a directory");

    const real = await realpath(directory);
    if (this.stateRootReal === null) {
      this.stateRootReal = await realpath(this.deps.paths.root).catch(() => this.deps.paths.root);
    }
    const rel = relative(real, this.stateRootReal);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw new Error(
        "that directory contains IQ Compiler's own state; choose a vault outside it so the audit log " +
          "and credentials are never indexed",
      );
    }
    return real;
  }
}
