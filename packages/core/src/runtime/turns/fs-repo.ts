import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { TurnEvent, reduceTurn, type TurnState } from "@iq/shared";
import { appendJsonl, readJsonl, removeIfExists } from "../../util/jsonl.js";
import { KeyedMutex } from "../../util/lock.js";
import type { AppPaths } from "../../config/paths.js";

/**
 * Append-only turn log.
 *
 * One JSONL file per turn. Events are validated before they are written, so a
 * malformed event fails at the append rather than at the next replay.
 */
export class TurnRepo {
  private readonly mutex = new KeyedMutex();

  constructor(private readonly paths: AppPaths) {}

  private file(turnId: string): string {
    return join(this.paths.turns, `${turnId}.jsonl`);
  }

  async append(turnId: string, events: readonly TurnEvent[]): Promise<void> {
    if (events.length === 0) return;
    const validated = events.map((event) => TurnEvent.parse(event));
    await appendJsonl(this.file(turnId), validated);
  }

  async read(turnId: string): Promise<TurnEvent[]> {
    const raw = await readJsonl(this.file(turnId));
    const events: TurnEvent[] = [];
    for (const record of raw) {
      const parsed = TurnEvent.safeParse(record);
      if (parsed.success) events.push(parsed.data);
    }
    return events;
  }

  async state(turnId: string): Promise<TurnState> {
    return reduceTurn(await this.read(turnId));
  }

  async withLock<T>(turnId: string, fn: () => Promise<T>): Promise<T> {
    return this.mutex.withLock(turnId, fn);
  }

  /**
   * Every turn log on disk, with the time it was last written.
   *
   * Only a sweep needs this. The age matters because a turn log is written
   * before the session references it, so a turn that started a moment ago
   * looks exactly like one a crash orphaned.
   */
  async allIds(): Promise<{ turnId: string; writtenAt: number }[]> {
    const files = await readdir(this.paths.turns).catch(() => [] as string[]);
    const found: { turnId: string; writtenAt: number }[] = [];
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const info = await stat(join(this.paths.turns, file)).catch(() => null);
      if (info === null) continue;
      found.push({ turnId: file.slice(0, -".jsonl".length), writtenAt: info.mtimeMs });
    }
    return found;
  }

  async delete(turnId: string): Promise<void> {
    await removeIfExists(this.file(turnId));
  }
}
