/**
 * Small text helpers that were each written out several times.
 *
 * These were not copied for convenience. Nine files had their own `hostOf`,
 * and between them they had five different answers to the same question — what
 * to return when the string does not parse as a URL. That difference is not a
 * detail: one of those answers puts the unparsed string into a message the
 * model reads, and two put it into an audit log that is documented as holding
 * hosts only. Written out nine times, nobody can see that. Written once with
 * the fallback passed in, every caller has to state which answer it wants.
 */

/**
 * The host of a URL, or `fallback` when it does not parse.
 *
 * The fallback is required and has no default on purpose. Picking one here
 * would quietly change what eight call sites log, show or audit.
 *
 * A string fallback is a fixed answer. A function fallback receives the
 * original value, for callers that want to derive something from it — but
 * anything derived from an unparsed URL may still contain a query string, so
 * a caller that audits should return a constant.
 */
export function hostOf(value: string, fallback: string | ((value: string) => string)): string {
  try {
    return new URL(value).host;
  } catch {
    return typeof fallback === "function" ? fallback(value) : fallback;
  }
}

/**
 * The fallback for a caller that audits or shows the result.
 *
 * A constant, because the alternative is the unparsed string, and an unparsed
 * string can carry a query string with a key in it. Losing the name of the
 * endpoint costs a little diagnostic detail; keeping it can write a credential
 * into a log that is kept.
 */
export const UNNAMED_ENDPOINT = "the configured endpoint";

/** The message of a thrown value, whatever it turned out to be. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
