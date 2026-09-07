/**
 * Recognising a page that is challenging the browser rather than answering it.
 *
 * # Why this exists
 *
 * The built-in pane is a real browser under automation, and a large part of the
 * web treats that as a bot. What the agent gets back is not the page it asked
 * for: it is a CAPTCHA, an interstitial, or a rate-limit notice. To a model
 * that only sees "navigation succeeded, here is some text", the sensible next
 * move is to try again — and every retry earns a fresh challenge. That is the
 * loop this exists to break: a user reported six or seven CAPTCHAs for one
 * question, each one produced by the recovery from the last.
 *
 * A challenge is therefore reported as a *distinct outcome*, not as a failure
 * to be retried and not as page content to be read. The remedy is named too,
 * because there is one and it is not the agent's: the page is open in the
 * user's own window, and a human can solve it in a way an agent must not try
 * to.
 *
 * # Why the signals are what they are
 *
 * URL first, because it is the one signal that cannot be styled away and does
 * not depend on the page having finished rendering. Google's `/sorry/` path and
 * Cloudflare's `cdn-cgi/challenge-platform` are the two that matter most in
 * practice. Titles come second: interstitials are one of a small set of stock
 * phrases across every vendor. Body text is last and optional, because it is
 * only available once the page has been read.
 *
 * Deliberately not a general "is this page useful" check. Everything here names
 * a specific vendor mechanism or a stock interstitial phrase, so a page that
 * merely *mentions* a captcha is not mistaken for one.
 */

import { hostOf as sharedHostOf } from "../util/text.js";

export type ChallengeKind = "captcha" | "rate_limited" | "blocked";

export interface Challenge {
  kind: ChallengeKind;
  host: string;
  /** What to tell the model, phrased so that retrying is obviously not it. */
  message: string;
}

/** Paths and hosts that only ever appear on a challenge or block page. */
const URL_SIGNALS: ReadonlyArray<{ pattern: RegExp; kind: ChallengeKind }> = [
  // Google's interstitial for automated traffic. The path is stable and the
  // page is nothing but a CAPTCHA.
  { pattern: /\/sorry\/index/i, kind: "captcha" },
  { pattern: /\/recaptcha\//i, kind: "captcha" },
  { pattern: /hcaptcha\.com/i, kind: "captcha" },
  { pattern: /\/cdn-cgi\/challenge-platform/i, kind: "captcha" },
  { pattern: /captcha-delivery\.com/i, kind: "captcha" },
  { pattern: /\/_(?:sec|px)\/captcha/i, kind: "captcha" },
  { pattern: /\/challenge(?:\.|\/|$)/i, kind: "captcha" },
  { pattern: /\/blocked(?:\.|\/|$)/i, kind: "blocked" },
];

/** Stock interstitial titles. Vendors reuse a very small set of these. */
const TITLE_SIGNALS: ReadonlyArray<{ pattern: RegExp; kind: ChallengeKind }> = [
  { pattern: /just a moment/i, kind: "captcha" },
  { pattern: /attention required/i, kind: "captcha" },
  { pattern: /are you a (?:robot|human)/i, kind: "captcha" },
  { pattern: /verify (?:you are|your) human/i, kind: "captcha" },
  { pattern: /unusual traffic/i, kind: "rate_limited" },
  { pattern: /too many requests/i, kind: "rate_limited" },
  { pattern: /rate limit/i, kind: "rate_limited" },
  { pattern: /access denied/i, kind: "blocked" },
  { pattern: /forbidden/i, kind: "blocked" },
];

/** Body phrases, checked only when the page has actually been read. */
const TEXT_SIGNALS: ReadonlyArray<{ pattern: RegExp; kind: ChallengeKind }> = [
  { pattern: /unusual traffic from your computer network/i, kind: "rate_limited" },
  { pattern: /select all (?:images|squares) with/i, kind: "captcha" },
  { pattern: /click verify once there are none left/i, kind: "captcha" },
  { pattern: /verify you are human/i, kind: "captcha" },
  { pattern: /enable javascript and cookies to continue/i, kind: "captcha" },
];

/** Reaches a message the model reads, so an unparsed URL is truncated, not dropped. */
const hostOf = (url: string): string => sharedHostOf(url, (value) => value.slice(0, 80));

const MESSAGES: Record<ChallengeKind, (host: string) => string> = {
  captcha: (host) =>
    `${host} answered with a CAPTCHA instead of the page. Do not open it again — every attempt ` +
    "produces a new challenge. The page is showing in the user's browser pane: either ask them to " +
    "solve it and then read the page, or get the same information from a source that does not " +
    "challenge automated browsing.",
  rate_limited: (host) =>
    `${host} is refusing this browser as automated traffic. Do not retry — repeating the request ` +
    "is what extends the block. Ask the user, or use a different source.",
  blocked: (host) =>
    `${host} refused to serve this page to the browser pane. Do not retry the same URL. Ask the ` +
    "user whether to continue, or use a different source.",
};

/**
 * Report a challenge page, or null for an ordinary one.
 *
 * `text` is optional so the same check runs on a bare navigation, where only
 * the URL and title are known.
 */
export function detectChallenge(page: {
  url: string;
  title?: string;
  text?: string;
}): Challenge | null {
  const host = hostOf(page.url);

  for (const signal of URL_SIGNALS) {
    if (signal.pattern.test(page.url)) {
      return { kind: signal.kind, host, message: MESSAGES[signal.kind](host) };
    }
  }
  for (const signal of TITLE_SIGNALS) {
    if (page.title !== undefined && signal.pattern.test(page.title)) {
      return { kind: signal.kind, host, message: MESSAGES[signal.kind](host) };
    }
  }
  // Only the opening stretch: a long article quoting one of these phrases is
  // not an interstitial, and an interstitial has almost nothing else on it.
  const opening = (page.text ?? "").slice(0, 1_200);
  for (const signal of TEXT_SIGNALS) {
    if (signal.pattern.test(opening)) {
      return { kind: signal.kind, host, message: MESSAGES[signal.kind](host) };
    }
  }
  return null;
}
