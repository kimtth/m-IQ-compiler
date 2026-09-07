import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ElectronApplication, Page } from "playwright-core";
import { launchApp, goTo } from "./launch.js";

/**
 * Where the drawn cortex actually sits in its pane.
 *
 * `lookAt` centres the *centroid of the node cloud*, and that is not where the
 * ink is. The camera is tilted 19° off vertical, so the near half of the
 * envelope projects larger than the far half and the visible mass settles
 * below the geometric centre — the picture read as bottom-heavy with a band of
 * empty pane above it. `FRAME_LIFT` in `scene.ts` corrects for it.
 *
 * The sign and the size of that correction are measured, not reasoned about.
 * Every previous "obviously it should be this way" on this surface has been
 * wrong at least once: `zoom` on an iframe, the shell radius, the fibre
 * budget. A number in a test is the only version of this claim that stays true.
 *
 * MEASURED, 1280×860 window, both side columns as they open:
 *   FRAME_LIFT 0     → canvas centroid 0.57  (visibly low)
 *   FRAME_LIFT 0.13  → canvas centroid 0.414
 *   FRAME_LIFT 0.05  → canvas centroid 0.486
 *
 * 0.13 was sized against the old layout, which collapsed the node cloud into
 * the back of the envelope. Once the layout spread the cloud over the whole
 * anterior–posterior spine, that much lift ran the top of the cortex off the
 * top edge — 24% of the topmost row was lit — while the bottom fifth of the
 * pane sat at 4.7%. Hence 0.05, plus a slightly wider fit radius.
 *
 * The canvas is screenshotted as an *element*, not read back through
 * `drawImage` + `getImageData`: the WebGL context carries no
 * `preserveDrawingBuffer`, so a readback comes out blank.
 */
let app: ElectronApplication;
let page: Page;

beforeAll(async () => {
  ({ app, page } = await launchApp());
  await goTo(page, "IQ Cell", "My IQ");
  await page.locator(".connectome-map canvas").waitFor({ state: "visible" });
  await page
    .locator(".flow-head")
    .getByRole("button", { name: "Analyse", exact: true })
    .click();
  // The analysis is 40 cells and ~800 pairs. The graph hash appears in the
  // header when it has one, which is the surface's own signal that it is done.
  await page.locator(".flow-head .flow-hash").waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(1200);
}, 120_000);

afterAll(async () => {
  await app?.close();
}, 60_000);

describe("My IQ — the map fills its pane", () => {
  it("centres the drawn mass rather than the geometric centre", async () => {
    const shot = await page.locator(".connectome-map canvas").screenshot();

    // Row-wise luminance, via the page's own decoder — there is no image
    // library in this repo and one measurement does not justify adding one.
    const rows = await page.evaluate(async (bytes: number[]) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
      const bitmap = await createImageBitmap(blob);
      const surface = document.createElement("canvas");
      surface.width = bitmap.width;
      surface.height = bitmap.height;
      const context = surface.getContext("2d");
      if (context === null) return [];
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const out: number[] = [];
      for (let y = 0; y < bitmap.height; y += 1) {
        let sum = 0;
        for (let x = 0; x < bitmap.width; x += 1) {
          const at = (y * bitmap.width + x) * 4;
          sum += (data[at] ?? 0) + (data[at + 1] ?? 0) + (data[at + 2] ?? 0);
        }
        out.push(sum);
      }
      return out;
    }, [...shot]);

    expect(rows.length).toBeGreaterThan(0);

    // The pane is near-black, so the fibre field is essentially all the light
    // in it and its weighted centre is where a reader sees the picture.
    const total = rows.reduce((sum, value) => sum + value, 0);
    expect(total).toBeGreaterThan(0);
    let weighted = 0;
    rows.forEach((value, y) => {
      weighted += value * y;
    });
    const centroid = weighted / total / rows.length;

    // Logged so a regression says which way it drifted, not merely that it did.
    // eslint-disable-next-line no-console
    console.log(`MAP_CENTROID ${centroid.toFixed(3)} of ${rows.length} rows`);
    // A generous band around the measured 0.486: the layout is seeded and so
    // is stable, but the pane width depends on the window and this must not
    // become a test that fails on a different screen. It still catches the two
    // failures that matter — a picture stuck to the top or to the bottom.
    expect(centroid).toBeGreaterThan(0.38);
    expect(centroid).toBeLessThan(0.58);
  }, 60_000);

  it("draws the field without flooding it", async () => {
    // The other half of the same complaint: the fibre count went to 12,000 and
    // the additive material turned the graph into a lit fog. Mean luminance is
    // the direct measure of that, and it is the number to look at first if the
    // picture is ever reported as "too bright" again.
    const shot = await page.locator(".connectome-map canvas").screenshot();
    const mean = await page.evaluate(async (bytes: number[]) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
      const bitmap = await createImageBitmap(blob);
      const surface = document.createElement("canvas");
      surface.width = bitmap.width;
      surface.height = bitmap.height;
      const context = surface.getContext("2d");
      if (context === null) return 0;
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      let sum = 0;
      for (let at = 0; at < data.length; at += 4) {
        sum += ((data[at] ?? 0) + (data[at + 1] ?? 0) + (data[at + 2] ?? 0)) / 3;
      }
      return sum / (data.length / 4);
    }, [...shot]);

    // eslint-disable-next-line no-console
    console.log(`MAP_MEAN_LUMA ${mean.toFixed(2)}`);
    // Above zero, so the map is not blank; well under mid-grey, so it is a
    // field of tracts on a dark ground rather than a glowing mass.
    expect(mean).toBeGreaterThan(1);
    expect(mean).toBeLessThan(60);
  }, 60_000);
});
