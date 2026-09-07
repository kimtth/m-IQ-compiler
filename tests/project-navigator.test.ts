import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectService } from "../packages/core/src/project/project.js";

/**
 * The two things the navigator gained: it follows the project as the agent
 * writes into it, and a file in it can be shown in the OS file manager.
 *
 * `locate` is the interesting one. It is the only path in the app that hands a
 * filesystem location to `shell`, and the location is named by the renderer, so
 * the containment proof is the whole security story of the feature.
 */

let root: string;
let service: ProjectService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iq-ws-"));
  service = new ProjectService({ root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ProjectService.locate", () => {
  it("resolves a file inside the project to an absolute path", async () => {
    writeFileSync(join(root, "deck.pptx"), "x");
    await expect(service.locate("deck.pptx")).resolves.toContain("deck.pptx");
  });

  it("resolves a file in a subdirectory", async () => {
    mkdirSync(join(root, "reports"));
    writeFileSync(join(root, "reports", "q4.docx"), "x");
    await expect(service.locate("reports/q4.docx")).resolves.toContain("q4.docx");
  });

  it("refuses a path that climbs out of the project", async () => {
    // Everything reachable from here is opened in the user's file manager, so
    // "show me ../../.ssh" must never be answered.
    await expect(service.locate("../outside.txt")).rejects.toThrow();
    await expect(service.locate("reports/../../outside.txt")).rejects.toThrow();
  });

  it("refuses an absolute path", async () => {
    await expect(service.locate("C:\\Windows\\win.ini")).rejects.toThrow();
    await expect(service.locate("/etc/passwd")).rejects.toThrow();
  });

  it("refuses a file that is not there, rather than revealing its parent", async () => {
    await expect(service.locate("ghost.pptx")).rejects.toThrow(/not in the project/i);
  });
});

describe("ProjectService.watch", () => {
  it("reports a file the agent creates", async () => {
    // The navigator's empty state promises that files the agent creates appear
    // there; before this it only listed on mount and on an explicit refresh.
    let changes = 0;
    const stop = service.watch(() => {
      changes += 1;
    });
    try {
      writeFileSync(join(root, "brief.pptx"), "x");
      await expect.poll(() => changes, { timeout: 10_000 }).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });

  it("coalesces a burst into one announcement", async () => {
    // Writing one Office file is many filesystem events, and a deck is many
    // files; re-listing the tree per event would make it thrash.
    let changes = 0;
    const stop = service.watch(() => {
      changes += 1;
    });
    try {
      for (let i = 0; i < 25; i += 1) writeFileSync(join(root, `slide-${i}.txt`), "x");
      await expect.poll(() => changes, { timeout: 10_000 }).toBeGreaterThan(0);
      // Give any further events time to arrive before counting.
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(changes).toBeLessThan(5);
    } finally {
      stop();
    }
  });

  it("stops reporting once released", async () => {
    let changes = 0;
    const stop = service.watch(() => {
      changes += 1;
    });
    stop();
    writeFileSync(join(root, "after.txt"), "x");
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(changes).toBe(0);
  });
});
