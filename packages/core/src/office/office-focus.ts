import { OfficeFocusEntry as OfficeFocusEntrySchema, type OfficeFocusEntry } from "@iq/shared";
import { readJson, writeJsonAtomic } from "../util/jsonl.js";
import type { Logger } from "../util/logger.js";

/**
 * The document each conversation is working on.
 *
 * The Office surface had one preview and no idea whose it was. It followed the
 * newest OfficeCLI mutation from anywhere, and failing that the newest file in
 * the project — so a conversation that spent an hour on a deck showed a
 * spreadsheet another conversation had just written, and going back to the deck
 * meant hunting for it in the document list.
 *
 * A conversation is the unit of work here, so the document belongs to the
 * conversation. This is where that is written down.
 *
 * The project id is kept beside the path because a project-relative path is not
 * unique across projects: `report.docx` exists in several, and opening the
 * wrong one is worse than opening none. A recall from a different project
 * returns nothing rather than guessing.
 *
 * Only the path is stored. Not the preview, not the render — those are derived
 * from the file on disk, which is the only copy that is true.
 */

/** Conversations remembered. Past this the least recently active is dropped. */
const MAX_ENTRIES = 200;

export interface OfficeFocusDeps {
  logger: Logger;
  /** Where the entries are kept, outside any project. */
  file: string;
}

export class OfficeFocus {
  private entries: OfficeFocusEntry[] = [];
  private hydrated: Promise<void> | null = null;

  constructor(private readonly deps: OfficeFocusDeps) {}

  /**
   * Note that this conversation is working on this document.
   *
   * One entry per conversation, moved to the front. The list is read in full on
   * every recall, so conversations nobody has opened in months fall off the end
   * rather than accumulating.
   */
  async remember(sessionId: string, projectId: string | null, path: string): Promise<void> {
    if (sessionId === "" || path === "") return;
    await this.load();
    const existing = this.entries.find((entry) => entry.sessionId === sessionId);
    if (existing?.path === path && existing.projectId === projectId) return;
    const entry: OfficeFocusEntry = {
      sessionId,
      projectId,
      path,
      at: new Date().toISOString(),
    };
    this.entries = [entry, ...this.entries.filter((row) => row.sessionId !== sessionId)].slice(
      0,
      MAX_ENTRIES,
    );
    await this.persist();
  }

  /**
   * What this conversation was working on, or `""`.
   *
   * The path is returned as it was filed. Whether the file still exists is the
   * caller's question — a document deleted since is not a reason to hand back
   * some other conversation's work.
   */
  async recall(sessionId: string, projectId: string | null): Promise<string> {
    if (sessionId === "") return "";
    await this.load();
    const found = this.entries.find((entry) => entry.sessionId === sessionId);
    if (found === undefined) return "";
    return found.projectId === projectId ? found.path : "";
  }

  /**
   * Drop what this conversation was working on.
   *
   * For the caller that deletes the document itself. A binding left behind
   * points the surface at a file that is no longer there, which renders as a
   * failed read rather than as the empty surface the deletion intended.
   */
  async forget(sessionId: string): Promise<void> {
    if (sessionId === "") return;
    await this.load();
    const remaining = this.entries.filter((entry) => entry.sessionId !== sessionId);
    if (remaining.length === this.entries.length) return;
    this.entries = remaining;
    await this.persist();
  }

  private async load(): Promise<void> {
    this.hydrated ??= (async () => {
      const raw = await readJson<unknown[]>(this.deps.file, []);
      if (!Array.isArray(raw)) return;
      const restored: OfficeFocusEntry[] = [];
      for (const record of raw) {
        const parsed = OfficeFocusEntrySchema.safeParse(record);
        if (parsed.success) restored.push(parsed.data);
        else
          this.deps.logger.warn("an Office focus entry could not be read; it is dropped", {
            file: this.deps.file,
          });
      }
      this.entries = restored.slice(0, MAX_ENTRIES);
    })().catch((error: unknown) => {
      this.deps.logger.warn("Office focus could not be read; starting empty", {
        file: this.deps.file,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await this.hydrated;
  }

  /**
   * Write the store.
   *
   * A failed write is logged and swallowed. Losing which document a
   * conversation was on costs one click; failing the build the user just asked
   * for because that note could not be filed costs the work.
   */
  private async persist(): Promise<void> {
    try {
      await writeJsonAtomic(this.deps.file, this.entries);
    } catch (error) {
      this.deps.logger.warn("Office focus could not be written", {
        file: this.deps.file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
