import { join } from "node:path";
import { readdir } from "node:fs/promises";
import {
  DEFAULT_SESSION_PLACE,
  SessionEvent,
  SessionSummary,
  canHoldConversation,
  type SessionPlace,
} from "@iq/shared";
import { appendJsonl, readJsonl, removeIfExists } from "../../util/jsonl.js";
import { KeyedMutex } from "../../util/lock.js";
import type { AppPaths } from "../../config/paths.js";

/**
 * Session ordering log.
 *
 * Kept separate from turn logs: the session log records *which* turns exist and
 * in what order, while each turn log records what happened inside it. The turn
 * is written before the session references it, so a session can never point at
 * a turn that was not durably created.
 */
export class SessionRepo {
  private readonly mutex = new KeyedMutex();

  constructor(private readonly paths: AppPaths) {}

  private file(sessionId: string): string {
    return join(this.paths.sessions, `${sessionId}.jsonl`);
  }

  async append(sessionId: string, events: readonly SessionEvent[]): Promise<void> {
    if (events.length === 0) return;
    await appendJsonl(
      this.file(sessionId),
      events.map((event) => SessionEvent.parse(event)),
    );
  }

  async read(sessionId: string): Promise<SessionEvent[]> {
    const raw = await readJsonl(this.file(sessionId));
    const events: SessionEvent[] = [];
    for (const record of raw) {
      const parsed = SessionEvent.safeParse(record);
      if (parsed.success) events.push(parsed.data);
    }
    return events;
  }

  /**
   * The turns that are still part of the conversation.
   *
   * A `history_cleared` event resets the fold: turns appended before it are
   * durable history that the user has explicitly retired, so they are neither
   * shown nor sent back to the model as context.
   */
  async turnIds(sessionId: string): Promise<string[]> {
    const ids: string[] = [];
    for (const event of await this.read(sessionId)) {
      if (event.type === "history_cleared") ids.length = 0;
      if (event.type === "turn_appended") ids.push(event.turnId);
    }
    return ids;
  }

  /** Every turn ever appended, including those retired by a clear. */
  async allTurnIds(sessionId: string): Promise<string[]> {
    return (await this.read(sessionId))
      .filter((event): event is Extract<SessionEvent, { type: "turn_appended" }> =>
        event.type === "turn_appended",
      )
      .map((event) => event.turnId);
  }

  async summary(sessionId: string): Promise<SessionSummary | null> {
    const events = await this.read(sessionId);
    const created = events.find((event) => event.type === "session_created");
    if (!created || created.type !== "session_created") return null;

    let title = created.title;
    let updatedAt = created.at;
    let turnCount = 0;
    /**
     * Two sources are folded, separately, and ranked.
     *
     * `chosen` is the user naming the destination as they start the
     * conversation. It wins outright: it is the only record that is a
     * statement rather than an inference, and a conversation that says what it
     * is for must not be re-filed by the first tool the agent happens to reach
     * for.
     *
     * `work` is the inference from that tool, and it places everything nobody
     * placed by hand. Last write wins within it — a conversation that queried a
     * warehouse and then built a deck is a deck conversation.
     *
     * `navigation` is folded by neither. An earlier build had the shell report
     * where the window was pointing every time anything changed, and folded
     * those the same way as everything else. One real conversation — "create
     * pptx about Microsoft" — collected nine of them: fabric, image,
     * image/meetings, image/browser, research, image, **office**, fabric,
     * research. The right answer was seventh, and last-write-wins picked the
     * ninth. Navigation records are kept in the log because the log is
     * append-only and history is history, but they are not evidence.
     */
    let chosenPlace: SessionPlace | null = null;
    let workPlace: SessionPlace | null = null;

    for (const event of events) {
      // A place change is navigation, not activity. The rail is ordered by
      // `updatedAt`, so letting it advance would reshuffle the list every time
      // someone opened a tab beside a conversation.
      if (event.type !== "place_changed") updatedAt = event.at;
      if (event.type === "title_changed") title = event.title;
      if (event.type === "place_changed") {
        if (event.source === "chosen") chosenPlace = event.place;
        if (event.source === "work") workPlace = event.place;
      }
      if (event.type === "history_cleared") turnCount = 0;
      if (event.type === "turn_appended") turnCount += 1;
    }

    // Product surfaces can stop holding conversations. A historic choice for
    // such a surface is no longer a usable choice and must not outrank a
    // repaired work placement forever.
    const validChosenPlace = chosenPlace !== null && canHoldConversation(chosenPlace)
      ? chosenPlace
      : null;
    const validWorkPlace = workPlace !== null && canHoldConversation(workPlace)
      ? workPlace
      : null;
    const place = validChosenPlace ?? validWorkPlace;

    return SessionSummary.parse({
      id: sessionId,
      title,
      createdAt: created.at,
      updatedAt,
      turnCount,
      place: place ?? DEFAULT_SESSION_PLACE,
      /**
       * "Has anything ever established where this belongs", which is a
       * different question from "is its place the default one". Collapsing
       * them makes the repair pass impossible: it could not tell which
       * sessions it had already derived a place for, and would re-read every
       * turn log on every launch.
       */
      placeKnown: place !== null,
      /** What `setPlace` asks before letting an inference overwrite a usable choice. */
      placeChosen: validChosenPlace !== null,
      // Read from the creation event, never assumed. A council round or a
      // research question runs as its own `sub_agent` session, and reporting
      // those as interactive puts a dozen "Headless run" rows in the user's
      // conversation list for every run.
      origin: created.origin,
      parentSessionId: created.parentSessionId,
    });
  }

  async list(): Promise<SessionSummary[]> {
    const files = await readdir(this.paths.sessions).catch(() => [] as string[]);
    const summaries: SessionSummary[] = [];
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const summary = await this.summary(file.slice(0, -".jsonl".length));
      if (summary) summaries.push(summary);
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.mutex.withLock(sessionId, fn);
  }

  async delete(sessionId: string): Promise<void> {
    await removeIfExists(this.file(sessionId));
  }
}
