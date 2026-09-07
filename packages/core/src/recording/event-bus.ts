import { MAX_CLIPBOARD_PREVIEW_CHARS, type RecEvent, type RecEventInput } from "@iq/shared";

/**
 * Stamps and buffers the timeline of one recording.
 *
 * Collectors produce events without knowing anything about ordering or storage;
 * this is the one place that assigns `seq`, `t` and `epoch` and the one place
 * that writes them. Two consequences are the point of it existing:
 *
 *  - **`seq` is assigned synchronously.** Everything downstream — correlation,
 *    step segmentation, the analyst's evidence references — identifies an event
 *    by its `seq`, so it has to be allocated before any `await` can interleave
 *    another collector's event between the allocation and the append.
 *
 *  - **`t` comes from a monotonic clock, `epoch` from the wall clock.** They
 *    disagree whenever the machine sleeps or the clock is corrected mid-session,
 *    which is common in a recording that spans a lunch break. Timeline
 *    arithmetic uses `t` because it never goes backwards; `epoch` is kept only
 *    so a human can be told when something happened.
 *
 * Writes are batched. A recording produces a steady trickle of small events and
 * one `appendFile` per event would turn a background capture into a source of
 * disk churn the user can hear.
 */

/** How long events may sit in memory before they are written. */
const FLUSH_INTERVAL_MS = 1_000;

/** Flush early once this many are waiting, so a burst is not held back. */
const FLUSH_BATCH_SIZE = 50;

export interface EventBusDeps {
  /** Persist a batch. Called serially; never concurrently with itself. */
  write: (events: readonly RecEvent[]) => Promise<void>;
  /** Milliseconds since some fixed point. Injected for tests. */
  monotonic?: () => number;
  now?: () => Date;
  /** Called after every append, with the running total. Drives the live UI. */
  onEvent?: (event: RecEvent, total: number) => void;
  onError?: (error: unknown) => void;
}

export class RecordingEventBus {
  private seq = 0;
  private readonly startedAtMonotonic: number;
  private pending: RecEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Serialises writes so batches cannot be persisted out of order. */
  private draining: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly deps: EventBusDeps) {
    this.startedAtMonotonic = this.monotonic();
  }

  private monotonic(): number {
    return this.deps.monotonic?.() ?? Number(process.hrtime.bigint() / 1_000_000n);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  get count(): number {
    return this.seq;
  }

  /**
   * Record one event.
   *
   * Synchronous and infallible by design. A collector polling the foreground
   * window must not have to handle a failed disk write, and an event dropped
   * because the log could not be written is better than a collector that stops
   * collecting — so failures are reported through `onError` and the timeline
   * carries on.
   */
  emit(input: RecEventInput): RecEvent {
    if (this.closed) throw new Error("event bus is closed");
    const event: RecEvent = {
      seq: this.seq++,
      t: Math.max(0, this.monotonic() - this.startedAtMonotonic),
      epoch: this.now().getTime(),
      type: input.type,
      source: input.source,
      payload: redact(input),
    };
    this.pending.push(event);
    this.deps.onEvent?.(event, this.seq);
    if (this.pending.length >= FLUSH_BATCH_SIZE) void this.flush();
    else this.arm();
    return event;
  }

  private arm(): void {
    if (this.timer !== null || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    // A pending flush must never be the reason the process stays alive.
    this.timer.unref?.();
  }

  /** Write everything buffered. Safe to call at any time, including twice. */
  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.pending;
    if (batch.length === 0) return this.draining;
    this.pending = [];
    this.draining = this.draining
      .then(() => this.deps.write(batch))
      .catch((error) => {
        this.deps.onError?.(error);
      });
    return this.draining;
  }

  /** Flush and refuse further events. Idempotent. */
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    await this.draining;
  }
}

/**
 * Trim what a payload carries before it is ever written.
 *
 * Done at the boundary rather than at read time because the file itself is the
 * thing that outlives the process. A clipboard preview truncated only on
 * display is still a password sitting in a log on disk.
 */
function redact(input: RecEventInput): Record<string, unknown> {
  if (input.type !== "clipboard.change") {
    return { ...input.payload } as Record<string, unknown>;
  }
  const payload = { ...input.payload };
  if (typeof payload.textPreview === "string") {
    payload.textPreview = payload.textPreview.slice(0, MAX_CLIPBOARD_PREVIEW_CHARS);
  }
  return payload as unknown as Record<string, unknown>;
}
