import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { ELEMENT_MAP_SCRIPT } from "../apps/main/src/browser-pane.js";

/**
 * The browser pane's load-bearing assumptions, checked against a real engine.
 *
 * Skipped when neither Edge nor Chrome is installed, because the pane drives a
 * browser the machine already has and never downloads one — a machine without
 * either is a supported state, not a failing test.
 */

let browser: Browser | null = null;
let channel = "";

beforeAll(async () => {
  for (const candidate of ["msedge", "chrome"] as const) {
    try {
      browser = await chromium.launch({ channel: candidate, headless: true });
      channel = candidate;
      return;
    } catch {
      browser = null;
    }
  }
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  // Same budget as the launch. Closing a real browser is not instant, and on a
  // machine already running the rest of the suite it regularly passed the 10s
  // default — which failed the file while every test in it had passed.
}, 60_000);

describe("browser engine", () => {
  it("drives an installed Edge or Chrome rather than a downloaded one", () => {
    if (!browser) {
      expect(channel).toBe("");
      return;
    }
    expect(["msedge", "chrome"]).toContain(channel);
  });

  it(
    "streams screencast frames and accepts composed CJK text",
    async () => {
      if (!browser) return;

      const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
      const page = await context.newPage();
      await page.setContent(
        `<!doctype html><meta charset="utf-8"><input id="q" style="width:400px;height:40px;font-size:20px">`,
      );

      const cdp = await context.newCDPSession(page);
      let frames = 0;
      cdp.on("Page.screencastFrame", (frame) => {
        frames += 1;
        void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
      });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1 });

      // A screencast only emits on repaint, which is why the pane also captures
      // frames on a timer; force a repaint so the stream itself is exercised.
      for (let tick = 0; tick < 4; tick += 1) {
        await page.evaluate<void, number>(
          "(t) => { document.body.style.paddingTop = (8 + (t % 2)) + 'px'; }",
          tick,
        );
        await page.waitForTimeout(120);
      }
      expect(frames).toBeGreaterThan(0);

      // Click through raw CDP, exactly as a forwarded user click arrives.
      const box = await page.locator("#q").boundingBox();
      const x = Math.round((box?.x ?? 0) + (box?.width ?? 0) / 2);
      const y = Math.round((box?.y ?? 0) + (box?.height ?? 0) / 2);
      for (const type of ["mousePressed", "mouseReleased"] as const) {
        await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }

      // The reason text and keys are separate kinds: insertText carries what an
      // IME composed, and a synthesised keycode cannot.
      await cdp.send("Input.insertText", { text: "안녕하세요 こんにちは" });
      expect(await page.locator("#q").inputValue()).toBe("안녕하세요 こんにちは");

      await cdp.send("Page.stopScreencast").catch(() => undefined);
      await context.close();
    },
    60_000,
  );

  it(
    "labels interactive elements so the agent can act by handle, not coordinate",
    async () => {
      if (!browser) return;

      const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
      const page = await context.newPage();
      await page.setContent(`<!doctype html><meta charset="utf-8">
        <a href="#top">Skip to top</a>
        <input type="search" placeholder="Search docs">
        <select><option value="a">Alpha</option><option value="b">Beta</option></select>
        <button disabled>Save</button>
        <button style="display:none">Hidden</button>
        <div hidden>invisible</div>`);

      const outline = await page.evaluate<string>(ELEMENT_MAP_SCRIPT);
      const lines = outline.split("\n").filter(Boolean);

      // Handles are minted in document order and only for what a person could
      // actually click; a hidden control must not appear in the map.
      expect(lines[0]).toBe('e1 link "Skip to top"');
      expect(outline).toContain('search "Search docs"');
      expect(outline).toContain("select");
      expect(outline).toContain('button "Save" [disabled]');
      expect(outline).not.toContain("Hidden");

      // The handle resolves through an ordinary locator, which is what buys
      // actionability waiting instead of a raw coordinate guess.
      await page.locator('[data-iq-ref="e2"]').fill("안녕하세요");
      expect(await page.locator("input").inputValue()).toBe("안녕하세요");

      // Re-running clears the previous labels, so a stale handle resolves to
      // nothing rather than to whatever now occupies that slot.
      await page.locator("input").evaluate("(el) => el.remove()");
      await page.evaluate<string>(ELEMENT_MAP_SCRIPT);
      expect(await page.locator('[data-iq-ref="e9"]').count()).toBe(0);

      await context.close();
    },
    60_000,
  );
});
