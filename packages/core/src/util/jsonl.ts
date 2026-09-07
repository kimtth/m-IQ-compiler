import { appendFile, mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Append-only JSONL helpers.
 *
 * Durable history is append-only so a turn can be replayed after a crash.
 * Appends are the only write path for logs; a corrupt trailing line is skipped
 * rather than failing the whole read, because a partial write is the expected
 * outcome of a hard kill mid-append.
 */

export async function appendJsonl(path: string, records: readonly unknown[]): Promise<void> {
  if (records.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  const payload = records.map((record) => `${JSON.stringify(record)}\n`).join("");
  await appendFile(path, payload, "utf8");
}

export async function readJsonl(path: string): Promise<unknown[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const out: unknown[] = [];
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Only a truncated final line is tolerable; anything earlier is corruption.
      const isLastLine = index === lines.length - 1;
      if (!isLastLine) throw new Error(`corrupt JSONL record at ${path}:${index + 1}`);
    }
  }
  return out;
}

/**
 * Atomic whole-file JSON write via write-then-rename.
 *
 * Write-then-rename is only atomic on POSIX. On Windows a `rename` onto a target
 * that another handle currently has open — a routine occurrence for these
 * read-heavy durable stores, where every `get`, `list`, change listener and UI
 * poll opens the same file a mutation is replacing — raises a transient
 * EPERM/EACCES/EBUSY rather than succeeding. Because concurrent *writers* to one
 * file are already serialised upstream by the per-entity `KeyedMutex`, the only
 * contention here is against readers, so retrying the rename a handful of times
 * with a short backoff turns a spurious failure into a durable write. The temp
 * name carries a random suffix as well as the pid so two writes can never share
 * a scratch file. (`util/retry.ts` intentionally classes EPERM/EACCES as
 * non-retryable for its deterministic-permission callers, which is why this
 * transient case is spelled out locally.)
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!transient || attempt >= 10) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}
