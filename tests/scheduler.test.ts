import { describe, expect, it } from "vitest";
import { backoffMs, validateCron } from "@iq/core";

/**
 * Unattended retries are the part of the system a person is least likely to be
 * watching, so the backoff has to be bounded and jittered rather than merely
 * "eventually correct".
 */

const policy = { maxAttempts: 5, backoffMs: 1000, backoffFactor: 2, maxBackoffMs: 30_000 };

describe("backoffMs", () => {
  it("never exceeds the ceiling, however many attempts have failed", () => {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      for (let sample = 0; sample < 50; sample += 1) {
        expect(backoffMs(policy, attempt)).toBeLessThanOrEqual(policy.maxBackoffMs);
      }
    }
  });

  it("never returns a negative delay", () => {
    for (let attempt = 0; attempt <= 10; attempt += 1) {
      expect(backoffMs(policy, attempt)).toBeGreaterThanOrEqual(0);
    }
  });

  it("spreads retries out instead of firing them together", () => {
    // Full jitter: many jobs failing at once must not retry in lockstep.
    const samples = new Set(Array.from({ length: 200 }, () => backoffMs(policy, 4)));
    expect(samples.size).toBeGreaterThan(50);
  });

  it("widens the window as attempts accumulate", () => {
    const widest = (attempt: number): number =>
      Math.max(...Array.from({ length: 400 }, () => backoffMs(policy, attempt)));
    expect(widest(3)).toBeGreaterThan(widest(1));
  });
});

describe("validateCron", () => {
  it("accepts a weekday morning schedule", () => {
    expect(validateCron("0 7 * * 1-5")).toBeNull();
  });

  it("accepts a schedule in a named time zone", () => {
    expect(validateCron("0 9 * * *", "Europe/London")).toBeNull();
  });

  it("reports why an expression is invalid rather than throwing", () => {
    const error = validateCron("not a cron expression");
    expect(error).toBeTypeOf("string");
    expect(error).not.toBe("");
  });

  it("rejects an out-of-range field", () => {
    expect(validateCron("0 99 * * *")).toBeTypeOf("string");
  });
});
