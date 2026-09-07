import { describe, expect, it } from "vitest";
import { BrowserUrlPolicy, createBrowserTools } from "@iq/core";
import type { TenantPolicy } from "@iq/core";

/**
 * The browser tools against a bot wall.
 *
 * `tests/browser-challenge.test.ts` covers the detector in isolation. This
 * covers the thing the user actually hit: what the *tool* does when a page
 * turns out to be a CAPTCHA, and whether asking again is possible.
 *
 * The detector alone would not have fixed it. Told "this is a CAPTCHA", a model
 * will reasonably try the same host once more with a different path — and a bot
 * wall does not care which path was asked for. So the assertion that matters
 * below is not that the first attempt is reported correctly; it is that the
 * second one never reaches the network at all.
 */

/** A pane that answers with whatever page the test says the host served. */
function paneServing(pages: Record<string, { title: string; text?: string }>) {
  const opened: string[] = [];
  let current = "";
  return {
    opened,
    host: {
      open: async (url: string) => {
        opened.push(url);
        current = url;
        return { url, title: pages[url]?.title ?? "" };
      },
      read: async () => ({
        url: current,
        title: pages[current]?.title ?? "",
        text: pages[current]?.text ?? "",
        truncated: false,
        canGoBack: false,
        canGoForward: false,
        loading: false,
      }),
    },
  };
}

const policy = new BrowserUrlPolicy({
  browserEnabled: true,
  browserDeniedHosts: [],
} as unknown as TenantPolicy);

function toolsFor(pane: Parameters<typeof createBrowserTools>[0]["pane"]) {
  const tools = createBrowserTools({ policy, pane });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    open: (url: string) =>
      byName.get("open_browser_pane")?.handler({ url, reason: "test" }, {} as never) as Promise<
        Record<string, unknown>
      >,
    read: () =>
      byName.get("read_browser_page")?.handler({ reason: "test" }, {} as never) as Promise<
        Record<string, unknown>
      >,
  };
}

const SORRY = "https://www.google.com/sorry/index?continue=https://www.google.com/search";

describe("open_browser_pane against a challenge", () => {
  it("reports the CAPTCHA rather than claiming the page opened", async () => {
    const pane = paneServing({ [SORRY]: { title: "Sorry..." } });
    const result = await toolsFor(pane.host).open(SORRY);

    expect(result["ok"]).toBe(false);
    expect(result["challenge"]).toBe("captcha");
    expect(String(result["error"])).toMatch(/do not open it again/i);
  });

  it("refuses the same host again without touching the network", async () => {
    // This is the fix. Six or seven challenges for one question came from the
    // recovery, not the first request: every retry earned a fresh CAPTCHA.
    const pane = paneServing({
      [SORRY]: { title: "Sorry..." },
      "https://www.google.com/maps": { title: "Maps" },
    });
    const tools = toolsFor(pane.host);

    await tools.open(SORRY);
    expect(pane.opened).toHaveLength(1);

    const second = await tools.open("https://www.google.com/maps");
    expect(second["ok"]).toBe(false);
    expect(second["challenge"]).toBe("captcha");
    // The host was never asked a second time.
    expect(pane.opened).toHaveLength(1);
  });

  it("keeps the block to the host that challenged, not the whole web", async () => {
    const pane = paneServing({
      [SORRY]: { title: "Sorry..." },
      "https://www.microsoft.com/en-us/about": { title: "About Microsoft" },
    });
    const tools = toolsFor(pane.host);

    await tools.open(SORRY);
    const other = await tools.open("https://www.microsoft.com/en-us/about");

    expect(other["ok"]).toBe(true);
    expect(pane.opened).toHaveLength(2);
  });

  it("opens an ordinary page exactly as before", async () => {
    const pane = paneServing({ "https://example.com/docs": { title: "Docs" } });
    const result = await toolsFor(pane.host).open("https://example.com/docs");

    expect(result["ok"]).toBe(true);
    expect(result["title"]).toBe("Docs");
    expect(result["challenge"]).toBeUndefined();
  });
});

describe("read_browser_page against a challenge", () => {
  it("does not hand the CAPTCHA's own text back as page content", async () => {
    // Returned as content, a CAPTCHA reads as a puzzle to solve. The body is
    // also the only place some walls show themselves, so it is checked here as
    // well as on the navigation.
    const url = "https://shop.example.com/product/1";
    const pane = paneServing({
      [url]: {
        title: "Verify",
        text: "Select all images with crosswalks. Click verify once there are none left.",
      },
    });
    const tools = toolsFor(pane.host);
    await tools.open(url);

    const read = await tools.read();
    expect(read["ok"]).toBe(false);
    expect(read["challenge"]).toBe("captcha");
    expect(read["content"]).toBeUndefined();
  });

  it("blocks the host for later navigations too, once a read exposes the wall", async () => {
    const url = "https://shop.example.com/product/1";
    const pane = paneServing({
      [url]: { title: "Verify", text: "Please verify you are human to continue." },
      "https://shop.example.com/product/2": { title: "Product 2" },
    });
    const tools = toolsFor(pane.host);
    await tools.open(url);
    await tools.read();

    const next = await tools.open("https://shop.example.com/product/2");
    expect(next["ok"]).toBe(false);
    expect(pane.opened).toHaveLength(1);
  });

  it("returns ordinary page text untouched, still labelled untrusted", async () => {
    const url = "https://example.com/docs";
    const pane = paneServing({ [url]: { title: "Docs", text: "The quick brown fox." } });
    const tools = toolsFor(pane.host);
    await tools.open(url);

    const read = await tools.read();
    expect(read["ok"]).toBe(true);
    expect(read["content"]).toBe("The quick brown fox.");
    expect(String(read["note"])).toMatch(/untrusted/i);
  });
});
