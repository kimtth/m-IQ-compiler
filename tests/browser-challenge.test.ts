import { describe, expect, it } from "vitest";
import { detectChallenge } from "@iq/core";

/**
 * Bot walls, and why they must be their own outcome.
 *
 * A challenge page is not a failure and it is not content. Reported as a
 * failure, the model retries and earns a fresh CAPTCHA; reported as content,
 * the model reads the CAPTCHA's own text and tries to answer it. A user hit six
 * or seven challenges for one question that way, each produced by the recovery
 * from the last.
 *
 * The other half of the job is not firing on an ordinary page. A detector that
 * treats any mention of a captcha as a captcha would make the browser refuse to
 * read articles about bot detection, which is a worse failure than the one it
 * fixes because it is silent.
 */

describe("detectChallenge — recognises a wall", () => {
  it("catches Google's interstitial by path, before anything has rendered", () => {
    const challenge = detectChallenge({
      url: "https://www.google.com/sorry/index?continue=https://www.google.com/search",
    });
    expect(challenge?.kind).toBe("captcha");
    expect(challenge?.host).toBe("www.google.com");
  });

  it("catches Cloudflare's challenge platform", () => {
    expect(
      detectChallenge({ url: "https://example.com/cdn-cgi/challenge-platform/h/b/orchestrate" })
        ?.kind,
    ).toBe("captcha");
  });

  it("catches the stock interstitial titles every vendor reuses", () => {
    expect(detectChallenge({ url: "https://example.com", title: "Just a moment..." })?.kind).toBe(
      "captcha",
    );
    expect(
      detectChallenge({ url: "https://example.com", title: "Attention Required! | Cloudflare" })
        ?.kind,
    ).toBe("captcha");
  });

  it("separates a rate limit from a CAPTCHA, because the remedy differs", () => {
    const challenge = detectChallenge({
      url: "https://example.com",
      title: "Unusual traffic from your computer network",
    });
    expect(challenge?.kind).toBe("rate_limited");
  });

  it("catches a CAPTCHA that only shows itself in the body", () => {
    const challenge = detectChallenge({
      url: "https://example.com/search",
      title: "Search",
      text: "Select all images with crosswalks. Click verify once there are none left.",
    });
    expect(challenge?.kind).toBe("captcha");
  });

  it("tells the model not to retry, which is the whole point", () => {
    const challenge = detectChallenge({ url: "https://www.google.com/sorry/index" });
    expect(challenge?.message).toMatch(/do not open it again/i);
    // And names the remedy, which is the user's rather than the agent's.
    expect(challenge?.message).toMatch(/browser pane/i);
  });
});

describe("detectChallenge — leaves an ordinary page alone", () => {
  it("passes a normal page with a normal title", () => {
    expect(
      detectChallenge({
        url: "https://www.microsoft.com/en-us/about",
        title: "About Microsoft | Microsoft",
        text: "Microsoft's mission is to empower every person and every organization.",
      }),
    ).toBeNull();
  });

  it("does not fire on an article that merely discusses CAPTCHAs", () => {
    // The phrase appears far into the body, where an interstitial has nothing.
    const body = `${"An essay on bot detection. ".repeat(80)} verify you are human`;
    expect(
      detectChallenge({ url: "https://example.com/essay", title: "On bot detection", text: body }),
    ).toBeNull();
  });

  it("does not fire on a URL that merely contains the word", () => {
    expect(
      detectChallenge({ url: "https://example.com/blog/how-captcha-works", title: "How it works" }),
    ).toBeNull();
  });
});
