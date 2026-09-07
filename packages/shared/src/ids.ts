/** Identifier helpers. IDs are strings with a stable prefix. */
export type SessionId = string;
export type TurnId = string;
export type ToolCallId = string;
export type TaskId = string;
export type JobId = string;
export type MemoryId = string;
export type AuditId = string;
export type MeetingId = string;

/**
 * This module is loaded by the main process, the preload bridge and the
 * renderer bundle, so it must not depend on `node:crypto`. Both Node 20+ and
 * Electron's renderer expose the Web Crypto API on `globalThis`.
 */
interface WebCryptoLike {
  randomUUID?: () => string;
  getRandomValues: <T extends Uint8Array>(array: T) => T;
}

const webCrypto = (globalThis as unknown as { crypto: WebCryptoLike }).crypto;

const randomUUID = (): string => {
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();

  // `randomUUID` is only exposed in secure contexts; fall back to building a
  // v4 UUID by hand from cryptographically strong bytes.
  const bytes = new Uint8Array(16);
  webCrypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const prefixed = (prefix: string): string => `${prefix}_${randomUUID()}`;

export const newSessionId = (): SessionId => prefixed("ses");
export const newTurnId = (): TurnId => prefixed("trn");
export const newToolCallId = (): ToolCallId => prefixed("tc");
export const newTaskId = (): TaskId => prefixed("tsk");
export const newScheduledJobId = (): JobId => prefixed("job");
export const newJobRunId = (): JobId => prefixed("run");
export const newMemoryId = (): MemoryId => prefixed("mem");
export const newAuditId = (): AuditId => prefixed("aud");
export const newCorrelationId = (): string => prefixed("cor");
export const newMeetingId = (): MeetingId => prefixed("mtg");
