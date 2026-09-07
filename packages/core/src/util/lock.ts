/**
 * Keyed mutex.
 *
 * Mutations are serialised per entity id. Every mutation of a turn, session,
 * job or plan goes through this so two advances of the same turn can never
 * interleave.
 */
export class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    // Stored tails always resolve, so a failed task cannot poison its successor.
    const run = previous.then(fn);
    // Keep the rejecting result for this caller and a resolved tail for the queue.
    const tail = run.catch(() => undefined);
    this.chains.set(key, tail);
    try {
      return await run;
    } finally {
      // Drop the entry once this is the tail, to avoid unbounded growth.
      if (this.chains.get(key) === tail) this.chains.delete(key);
    }
  }
}

/**
 * Single-flight guard: rejects re-entry instead of queueing.
 *
 * Used by the scheduler so that a slow run never stacks up duplicate executions
 * of the same job.
 */
export class SingleFlight {
  private readonly inflight = new Set<string>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (this.inflight.has(key)) return undefined;
    this.inflight.add(key);
    try {
      return await fn();
    } finally {
      this.inflight.delete(key);
    }
  }
}
