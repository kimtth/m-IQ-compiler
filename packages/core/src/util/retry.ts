import type { RetryPolicy } from "@iq/shared";

/** Errors that should never be retried, because a retry cannot change the outcome. */
export class NonRetryableError extends Error {
  override readonly name = "NonRetryableError";
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof NonRetryableError) return false;
  const code = (error as { code?: string } | null)?.code;
  // Permission and validation failures are deterministic; transport ones are not.
  if (code === "EACCES" || code === "EPERM") return false;
  return true;
}

/** Exponential backoff with full jitter, capped by the policy. */
export function backoffDelayMs(policy: RetryPolicy, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = policy.backoffMs * Math.pow(policy.backoffFactor, exponent);
  const capped = Math.min(raw, policy.maxBackoffMs);
  return Math.round(capped * (0.5 + Math.random() * 0.5));
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` with bounded retries. Callers must make `fn` idempotent; the
 * scheduler and orchestrator do this by passing a stable idempotency key into
 * the work itself rather than relying on at-most-once delivery.
 */
export async function withRetry<T>(
  policy: RetryPolicy,
  fn: (attempt: number) => Promise<T>,
  onAttemptFailed?: (attempt: number, error: unknown, willRetry: boolean) => void,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const willRetry = attempt < policy.maxAttempts && isRetryable(error);
      onAttemptFailed?.(attempt, error, willRetry);
      if (!willRetry) break;
      await sleep(backoffDelayMs(policy, attempt));
    }
  }
  throw lastError;
}

/** Thrown when a bounded operation exceeds its wall-clock budget. */
export class TimeoutError extends Error {
  override readonly name = "TimeoutError";
}

/** Reject once `ms` elapses, so a hung run cannot hold a job slot forever. */
export async function withTimeout<T>(ms: number, fn: () => Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
