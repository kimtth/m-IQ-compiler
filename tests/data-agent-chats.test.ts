import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DataAgentExchange } from "@iq/shared";
import { DataAgentChats } from "../packages/core/src/fabric/data-agent-chats.js";
import { createLogger } from "../packages/core/src/util/logger.js";

/**
 * The Data Agent surface used to hold its questions and answers in component
 * state, so leaving the pane or restarting the app emptied the transcript while
 * the remote thread carried on remembering it. These tests pin the properties
 * that fix: a conversation survives a restart, a new one is a separate thread,
 * and deleting one is permanent.
 */

let root: string;
let file: string;

const exchange = (over: Partial<DataAgentExchange> = {}): DataAgentExchange => ({
  id: `dae_${Math.random().toString(36).slice(2)}`,
  question: "How many rows landed in the silver customer table?",
  answer: "412,908 rows as of 03:10 UTC.",
  trace: ["thread_1", "run completed"],
  failed: false,
  askedAt: new Date().toISOString(),
  ...over,
});

const store = (): DataAgentChats => new DataAgentChats({ logger: createLogger("error"), file });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iq-dac-"));
  file = join(root, "dataagent-chats.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("DataAgentChats", () => {
  it("keeps a conversation across a restart", async () => {
    const first = store();
    const chat = await first.start();
    await first.append(chat.id, exchange());

    const restarted = store();
    const chats = await restarted.list();
    expect(chats).toHaveLength(1);
    expect(chats[0]!.id).toBe(chat.id);
    expect(chats[0]!.exchanges).toHaveLength(1);
    expect(chats[0]!.exchanges[0]!.answer).toBe("412,908 rows as of 03:10 UTC.");
  });

  // The id is the session id sent to the Data Agent, so two conversations must
  // never share one — that is what makes New conversation a new thread.
  it("gives each conversation its own id", async () => {
    const chats = store();
    const one = await chats.start();
    const two = await chats.start();
    expect(one.id).not.toBe(two.id);
    expect(await chats.list()).toHaveLength(2);
  });

  it("titles a conversation with its first question and leaves it there", async () => {
    const chats = store();
    const chat = await chats.start();
    expect(chat.title).toBe("");

    await chats.append(chat.id, exchange({ question: "Which stores missed target?" }));
    await chats.append(chat.id, exchange({ question: "And by how much?" }));

    const stored = await chats.get(chat.id);
    expect(stored?.title).toBe("Which stores missed target?");
  });

  it("shortens a long first question rather than storing a paragraph as a title", async () => {
    const chats = store();
    const chat = await chats.start();
    await chats.append(chat.id, exchange({ question: "a".repeat(400) }));

    const stored = await chats.get(chat.id);
    expect(stored?.title.length).toBe(80);
    expect(stored?.title.endsWith("…")).toBe(true);
  });

  // "It could not answer that" is part of the transcript. Dropping it makes the
  // record disagree with what the user saw.
  it("keeps a failed exchange", async () => {
    const chats = store();
    const chat = await chats.start();
    await chats.append(chat.id, exchange({ answer: "the run failed", failed: true, trace: [] }));

    const stored = await chats.get(chat.id);
    expect(stored?.exchanges[0]!.failed).toBe(true);
    expect(stored?.exchanges[0]!.answer).toBe("the run failed");
  });

  it("orders conversations by most recent activity", async () => {
    const chats = store();
    const older = await chats.start();
    const newer = await chats.start();
    await chats.append(older.id, exchange());

    expect((await chats.list())[0]!.id).toBe(older.id);
    await chats.append(newer.id, exchange());
    expect((await chats.list())[0]!.id).toBe(newer.id);
  });

  it("deletes a conversation permanently", async () => {
    const first = store();
    const chat = await first.start();
    await first.append(chat.id, exchange());
    await first.delete(chat.id);

    expect(await store().list()).toHaveLength(0);
  });

  // The answer was still polling when the user deleted the conversation.
  // Filing it now would put a deleted transcript back on screen.
  it("drops an exchange for a conversation that is gone", async () => {
    const chats = store();
    const chat = await chats.start();
    await chats.delete(chat.id);
    await chats.append(chat.id, exchange());

    expect(await chats.list()).toHaveLength(0);
  });

  it("ignores a damaged record instead of losing the rest", async () => {
    const chats = store();
    const good = await chats.start();
    await chats.append(good.id, exchange());

    const { readFileSync, writeFileSync } = await import("node:fs");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown[];
    writeFileSync(file, JSON.stringify([{ id: "broken" }, ...parsed]), "utf8");

    const restored = await store().list();
    expect(restored).toHaveLength(1);
    expect(restored[0]!.id).toBe(good.id);
  });
});
