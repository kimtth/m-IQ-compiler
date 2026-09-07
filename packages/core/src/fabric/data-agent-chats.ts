import { DataAgentChat as DataAgentChatSchema, type DataAgentChat, type DataAgentExchange } from "@iq/shared";
import { readJson, writeJsonAtomic } from "../util/jsonl.js";
import type { Logger } from "../util/logger.js";

/**
 * Data Agent conversations, kept on disk.
 *
 * Before this, the surface held its questions and answers in component state
 * and nothing else. Switching to another mode and back, or restarting the app,
 * emptied the transcript — while the Data Agent's own thread carried on holding
 * context the user could no longer see. That is the worst of both: the history
 * is gone from the screen but still shaping the answers.
 *
 * So a conversation is a record here. Its id is also the session id sent to the
 * Data Agent, which makes the two halves agree: starting a new conversation
 * starts a new thread there, and reopening an old one resumes the thread that
 * produced it.
 *
 * The store is small on purpose. Text only, no query results, no rows — the
 * trace lines the agent reports and the answer it wrote. It is capped, oldest
 * dropped first, because this is a transcript and not an archive.
 */

/** Conversations kept. Past this the oldest is dropped. */
const MAX_CHATS = 50;

/** Exchanges kept per conversation. */
const MAX_EXCHANGES = 200;

/** Characters of the first question used as the conversation's title. */
const TITLE_LIMIT = 80;

export interface DataAgentChatsDeps {
  logger: Logger;
  /** Where the conversations are kept, outside any project. */
  file: string;
}

export class DataAgentChats {
  private chats: DataAgentChat[] = [];
  private hydrated: Promise<void> | null = null;

  constructor(private readonly deps: DataAgentChatsDeps) {}

  /** Every conversation, newest activity first. */
  async list(): Promise<DataAgentChat[]> {
    await this.load();
    return this.chats.map((chat) => ({ ...chat }));
  }

  /** One conversation, or null if it has been deleted. */
  async get(chatId: string): Promise<DataAgentChat | null> {
    await this.load();
    const found = this.chats.find((chat) => chat.id === chatId);
    return found === undefined ? null : { ...found };
  }

  /**
   * Start a conversation.
   *
   * It is written down empty rather than on the first question, so the surface
   * has an id to send with that question and the Data Agent thread and the
   * record share it from the start.
   */
  async start(): Promise<DataAgentChat> {
    await this.load();
    const now = new Date().toISOString();
    const chat: DataAgentChat = {
      id: `dac_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      title: "",
      exchanges: [],
      startedAt: now,
      updatedAt: now,
    };
    this.chats.unshift(chat);
    this.chats = this.chats.slice(0, MAX_CHATS);
    await this.persist();
    return { ...chat };
  }

  /**
   * Record what was asked and what came back.
   *
   * An exchange for a conversation that is no longer there is dropped rather
   * than resurrecting it: the user deleted it while the answer was still
   * polling, and bringing it back would undo a deliberate act.
   */
  async append(chatId: string, exchange: DataAgentExchange): Promise<void> {
    await this.load();
    const chat = this.chats.find((entry) => entry.id === chatId);
    if (chat === undefined) return;
    chat.exchanges = [...chat.exchanges, exchange].slice(-MAX_EXCHANGES);
    chat.updatedAt = exchange.askedAt;
    if (chat.title === "") chat.title = titleOf(exchange.question);
    // Newest activity first, the order the list reads.
    this.chats = [chat, ...this.chats.filter((entry) => entry.id !== chatId)];
    await this.persist();
  }

  /** Forget one conversation. The Data Agent's own thread is not ours to delete. */
  async delete(chatId: string): Promise<void> {
    await this.load();
    const before = this.chats.length;
    this.chats = this.chats.filter((chat) => chat.id !== chatId);
    if (this.chats.length !== before) await this.persist();
  }

  /**
   * Write a whole conversation at once, for the sample data to show.
   *
   * {@link start} then {@link append} is the live path and cannot be used
   * here: it stamps `updatedAt` from the exchange and mints a random id, and a
   * sample needs a fixed id so loading it twice replaces the conversation
   * rather than stacking up copies of it.
   *
   * The Data Agent surface is the strongest case for seeding anything. It
   * needs a Fabric capacity that is switched on and a published Data Agent
   * behind it; without them the pane answers every question with a raw HTTP
   * 404, which is what a first-time reader saw. A seeded conversation shows
   * the question, the answer and the generated query with none of that.
   */
  async seed(chat: DataAgentChat): Promise<void> {
    await this.load();
    const parsed = DataAgentChatSchema.parse(chat);
    this.chats = [parsed, ...this.chats.filter((entry) => entry.id !== parsed.id)].slice(
      0,
      MAX_CHATS,
    );
    await this.persist();
  }

  /** Forget all of them. */
  async clear(): Promise<void> {
    await this.load();
    this.chats = [];
    await this.persist();
  }

  private async load(): Promise<void> {
    this.hydrated ??= (async () => {
      const raw = await readJson<unknown[]>(this.deps.file, []);
      if (!Array.isArray(raw)) return;
      const restored: DataAgentChat[] = [];
      for (const record of raw) {
        const parsed = DataAgentChatSchema.safeParse(record);
        if (parsed.success) restored.push(parsed.data);
        else
          this.deps.logger.warn("a Data Agent conversation could not be read; it is dropped", {
            file: this.deps.file,
          });
      }
      this.chats = restored.slice(0, MAX_CHATS);
    })().catch((error: unknown) => {
      this.deps.logger.warn("Data Agent conversations could not be read; starting empty", {
        file: this.deps.file,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await this.hydrated;
  }

  /**
   * Write the store.
   *
   * A failed write is logged and swallowed. Losing the transcript is bad;
   * failing the question the user just asked because the transcript could not
   * be filed is worse.
   */
  private async persist(): Promise<void> {
    try {
      await writeJsonAtomic(this.deps.file, this.chats);
    } catch (error) {
      this.deps.logger.warn("Data Agent conversations could not be written", {
        file: this.deps.file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** The first question, on one line, short enough to sit in a list. */
function titleOf(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  if (flat.length <= TITLE_LIMIT) return flat;
  return `${flat.slice(0, TITLE_LIMIT - 1).trimEnd()}…`;
}
