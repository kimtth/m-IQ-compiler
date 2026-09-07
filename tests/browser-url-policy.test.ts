import { describe, expect, it } from "vitest";
import { BrowserUrlPolicy, hostMatches } from "@iq/core";
import type { TenantPolicy } from "@iq/core";

const policy = (over: Partial<TenantPolicy> = {}): BrowserUrlPolicy =>
  new BrowserUrlPolicy({
    browserEnabled: true,
    browserDeniedHosts: [],
    ...over,
  } as unknown as TenantPolicy);

describe("hostMatches", () => {
  it("matches an exact host", () => {
    expect(hostMatches("microsoft.com", "microsoft.com")).toBe(true);
    expect(hostMatches("evil.com", "microsoft.com")).toBe(false);
  });

  it("matches a wildcard against sub-domains and the apex", () => {
    expect(hostMatches("teams.microsoft.com", "*.microsoft.com")).toBe(true);
    expect(hostMatches("microsoft.com", "*.microsoft.com")).toBe(true);
  });

  it("does not match a look-alike suffix", () => {
    // The whole point of anchoring on a label boundary.
    expect(hostMatches("notmicrosoft.com", "*.microsoft.com")).toBe(false);
    expect(hostMatches("microsoft.com.attacker.net", "*.microsoft.com")).toBe(false);
  });
});

describe("BrowserUrlPolicy", () => {
  it("allows an ordinary https page", () => {
    const verdict = policy().check("https://teams.microsoft.com/path?x=1");
    expect(verdict.allowed).toBe(true);
    expect(verdict.host).toBe("teams.microsoft.com");
  });

  it("assumes https for a bare host", () => {
    const verdict = policy().check("outlook.office.com");
    expect(verdict.allowed).toBe(true);
    expect(verdict.url).toBe("https://outlook.office.com/");
  });

  it("allows a non-Microsoft page, because a browser that cannot browse is useless", () => {
    // The former Microsoft-host allow-list blocked legitimate research; a page
    // reachable in an ordinary browser must be reachable here.
    for (const url of [
      "https://example.com",
      "https://en.wikipedia.org/wiki/Electron",
      "https://news.ycombinator.com",
    ]) {
      expect(policy().check(url).allowed).toBe(true);
    }
  });

  it("refuses non-https schemes", () => {
    for (const url of [
      "http://microsoft.com",
      "file:///c:/windows/win.ini",
      "javascript:alert(1)",
    ]) {
      expect(policy().check(url).allowed).toBe(false);
    }
  });

  it("refuses embedded credentials", () => {
    const url = new URL("https://www.microsoft.com");
    url.username = "victim";
    url.password = "hunter2";
    const verdict = policy().check(url.toString());
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("credentials");
  });

  it("still honours a deny-list for known-bad hosts", () => {
    const restricted = policy({ browserDeniedHosts: ["*.malware.test"] });
    expect(restricted.check("https://drop.malware.test").allowed).toBe(false);
    expect(restricted.check("https://malware.test").allowed).toBe(false);
    expect(restricted.check("https://www.microsoft.com").allowed).toBe(true);
  });

  it("refuses everything when the pane is disabled", () => {
    const off = policy({ browserEnabled: false });
    expect(off.enabled).toBe(false);
    expect(off.check("https://www.microsoft.com").allowed).toBe(false);
  });

  it("allows about:blank so the pane can be cleared", () => {
    expect(policy().check("about:blank").allowed).toBe(true);
  });
});
