import type { BrowserVerdict } from "@iq/shared";
import type { TenantPolicy } from "../policy/tenant-policy.js";

/**
 * Navigation policy for the built-in browser pane.
 *
 * The pane loads remote content into the app's own window, so navigation is
 * decided here rather than in the view: one decision governs a user click, an
 * in-page redirect and an agent tool call alike.
 *
 * There is deliberately **no general-purpose allow-list**. A page a person can
 * reach in an ordinary browser must be reachable here; a host allow-list was
 * too narrow to do research in and pushed users out of the app. What remains
 * are the rules that constrain *how* a page loads rather than *which* pages
 * exist:
 *
 *  1. Only `https:` (plus `about:blank`). No `file:`, no `javascript:`, no
 *     custom scheme that a handler elsewhere on the machine might claim.
 *  2. A deny-list still wins, so a tenant can block known-malicious hosts.
 *  3. Credentials embedded in the URL are refused.
 *
 * Containment lives in the view: an isolated session with no preload and no
 * Node integration, denied device permissions, cancelled downloads, and
 * navigation that cannot escape the pane. Audit records stay host-only.
 */

export class BrowserUrlPolicy {
  private readonly denied: readonly string[];

  constructor(private readonly policy: TenantPolicy) {
    this.denied = policy.browserDeniedHosts;
  }

  get enabled(): boolean {
    return this.policy.browserEnabled;
  }

  get deniedHosts(): readonly string[] {
    return this.denied;
  }

  check(candidate: string): BrowserVerdict {
    if (!this.policy.browserEnabled) {
      return { allowed: false, url: "", host: "", reason: "the browser pane is disabled by tenant policy" };
    }

    const trimmed = candidate.trim();
    if (trimmed === "" || trimmed === "about:blank") {
      return { allowed: true, url: "about:blank", host: "", reason: "" };
    }

    // A bare host is the common case when a user types; assume https rather
    // than letting the URL parser fail or, worse, resolve a relative scheme.
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;

    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      return { allowed: false, url: "", host: "", reason: "not a valid URL" };
    }

    if (url.protocol !== "https:") {
      return {
        allowed: false,
        url: "",
        host: url.hostname.toLowerCase(),
        reason: `only https is allowed in the browser pane, not ${url.protocol}`,
      };
    }

    const host = url.hostname.toLowerCase();
    if (host === "") {
      return { allowed: false, url: "", host: "", reason: "the URL has no host" };
    }

    if (this.denied.some((pattern) => hostMatches(host, pattern))) {
      return { allowed: false, url: "", host, reason: `${host} is denied by tenant policy` };
    }

    // Credentials in a URL are a phishing staple and would be sent by the view.
    if (url.username !== "" || url.password !== "") {
      return { allowed: false, url: "", host, reason: "URLs with embedded credentials are refused" };
    }

    return { allowed: true, url: url.toString(), host, reason: "" };
  }
}

/**
 * Match a host against one pattern.
 *
 * `*.example.com` matches any sub-domain and the apex, but never
 * `notexample.com` or `example.com.attacker.net` — the suffix check is anchored
 * on a label boundary for exactly that reason.
 */
export function hostMatches(host: string, pattern: string): boolean {
  const normalized = pattern.trim().toLowerCase().replace(/\.$/, "");
  if (normalized === "") return false;
  if (normalized === "*") return true;

  if (normalized.startsWith("*.")) {
    const suffix = normalized.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === normalized;
}
