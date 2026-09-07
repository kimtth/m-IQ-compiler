import { describe, expect, it, vi } from "vitest";
import { KeyedMutex, SingleFlight } from "../packages/core/src/util/lock.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("KeyedMutex", () => {
  it("runs queued work in order, including when the predecessor fails", async () => {
    const mutex = new KeyedMutex();
    const release = deferred();
    const entered = deferred();
    const events: string[] = [];
    const failure = new Error("first failed");
    const first = mutex.withLock("same", async () => {
      events.push("first");
      entered.resolve();
      await release.promise;
      throw failure;
    });
    const failed = expect(first).rejects.toBe(failure);
    const second = mutex.withLock("same", async () => {
      events.push("second");
      return 2;
    });
    const third = mutex.withLock("same", async () => {
      events.push("third");
      return 3;
    });

    await entered.promise;
    expect(events).toEqual(["first"]);
    release.resolve();
    await failed;
    expect(await Promise.all([second, third])).toEqual([2, 3]);
    expect(events).toEqual(["first", "second", "third"]);
  });

  it("does not block a different key", async () => {
    const mutex = new KeyedMutex();
    const release = deferred();
    const first = mutex.withLock("one", () => release.promise);
    try {
      expect(await mutex.withLock("two", async () => "independent")).toBe("independent");
    } finally {
      release.resolve();
      await first;
    }
  });

  it("releases a key after a synchronous throw", async () => {
    const mutex = new KeyedMutex();
    const failure = new Error("sync failure");
    await expect(mutex.withLock("same", () => { throw failure; })).rejects.toBe(failure);
    expect(await mutex.withLock("same", async () => "recovered")).toBe("recovered");
  });

  it("keeps the queued tail until it settles, then frees the map entry", async () => {
    const mutex = new KeyedMutex();
    // Check retention directly: ordered results alone cannot detect a map leak.
    const chains = (mutex as unknown as { chains: Map<string, Promise<unknown>> }).chains;
    const release = deferred();
    const first = mutex.withLock("same", async () => 1);
    const second = mutex.withLock("same", () => release.promise);
    try {
      await first;
      expect(chains.size).toBe(1);
    } finally {
      release.resolve();
      await second;
    }
    expect(chains.size).toBe(0);
    await expect(mutex.withLock("failed", async () => { throw new Error("failed"); }))
      .rejects.toThrow("failed");
    expect(chains.size).toBe(0);
  });
});

describe("SingleFlight", () => {
  it("skips an overlapping call without executing or joining it", async () => {
    const flight = new SingleFlight();
    const release = deferred();
    const duplicate = vi.fn(async () => "duplicate");
    const first = flight.run("same", async () => {
      await release.promise;
      return "first";
    });
    try {
      expect(await flight.run("same", duplicate)).toBeUndefined();
      expect(duplicate).not.toHaveBeenCalled();
      expect(await flight.run("other", async () => "independent")).toBe("independent");
    } finally {
      release.resolve();
    }
    expect(await first).toBe("first");
    expect(await flight.run("same", async () => "next")).toBe("next");
  });

  it("releases a key after failure", async () => {
    const flight = new SingleFlight();
    const failure = new Error("failed");
    await expect(flight.run("same", () => { throw failure; })).rejects.toBe(failure);
    expect(await flight.run("same", async () => "recovered")).toBe("recovered");
  });
});