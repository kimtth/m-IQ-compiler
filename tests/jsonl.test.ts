import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appendJsonl, readJson, readJsonl, writeJsonAtomic } from "../packages/core/src/util/jsonl.js";

const roots: string[] = [];
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "iq-jsonl-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable JSON helpers", () => {
  it("creates parent folders and replaces a JSON record without leaving scratch files", async () => {
    const root = await directory();
    const file = join(root, "nested", "state.json");
    await writeJsonAtomic(file, { version: 1 });
    expect(await readJson(file, null)).toEqual({ version: 1 });
    await writeJsonAtomic(file, { version: 2, entries: [] });
    expect(await readJson(file, null)).toEqual({ version: 2, entries: [] });
    expect(await readdir(join(root, "nested"))).toEqual(["state.json"]);
  });

  it("cleans up scratch files if the destination cannot be replaced", async () => {
    const root = await directory();
    const file = join(root, "keep.txt");
    await writeFile(file, "keep", "utf8");
    // A nonempty directory cannot be replaced by a file on any supported platform.
    await expect(writeJsonAtomic(root, {})).rejects.toThrow();
    const siblings = await readdir(tmpdir());
    const prefix = basename(root) + ".";
    expect(siblings.filter((name) => name.startsWith(prefix))).toEqual([]);
    expect(await readdir(root)).toEqual(["keep.txt"]);
  });

  it("returns the fallback only for a missing file, not malformed JSON", async () => {
    const file = join(await directory(), "state.json");
    const fallback = { entries: [] };
    expect(await readJson(file, fallback)).toBe(fallback);
    await writeFile(file, "{", "utf8");
    await expect(readJson(file, fallback)).rejects.toBeInstanceOf(SyntaxError);
  });

  it("preserves complete log records when the final record is truncated", async () => {
    const file = join(await directory(), "events.jsonl");
    expect(await readJsonl(file)).toEqual([]);
    await appendJsonl(file, [{ seq: 1 }, { seq: 2 }]);
    expect(await readJsonl(file)).toEqual([{ seq: 1 }, { seq: 2 }]);
    await writeFile(file, '{"seq":1}\n{"seq":', "utf8");
    expect(await readJsonl(file)).toEqual([{ seq: 1 }]);
  });

  it("rejects corruption before the end of the log", async () => {
    const file = join(await directory(), "events.jsonl");
    await writeFile(file, '{"seq":1}\nbroken\n{"seq":3}\n', "utf8");
    await expect(readJsonl(file)).rejects.toThrow(`corrupt JSONL record at ${file}:2`);
  });
});