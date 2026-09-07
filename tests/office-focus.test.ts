import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OfficeFocus } from "../packages/core/src/office/office-focus.js";
import { createLogger } from "../packages/core/src/util/logger.js";

/**
 * The Office preview used to be one global thing. It followed the newest
 * OfficeCLI mutation from anywhere, so a user who kept two conversations going
 * — a deck in one, a spreadsheet in the other — saw whichever had moved last,
 * whichever conversation they were in.
 *
 * These tests pin the properties that fix it: a conversation's document is its
 * own, it survives a restart, and it does not leak into a different project.
 */

let root: string;
let file: string;

const store = (): OfficeFocus => new OfficeFocus({ logger: createLogger("error"), file });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iq-office-focus-"));
  file = join(root, "office-focus.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("OfficeFocus", () => {
  it("gives each conversation its own document", async () => {
    const focus = store();
    await focus.remember("ses_a", "prj_1", "decks/quarterly-review.pptx");
    await focus.remember("ses_b", "prj_1", "sheets/pipeline.xlsx");

    expect(await focus.recall("ses_a", "prj_1")).toBe("decks/quarterly-review.pptx");
    expect(await focus.recall("ses_b", "prj_1")).toBe("sheets/pipeline.xlsx");
  });

  it("remembers the document across a restart", async () => {
    await store().remember("ses_a", "prj_1", "decks/quarterly-review.pptx");

    expect(await store().recall("ses_a", "prj_1")).toBe("decks/quarterly-review.pptx");
  });

  it("moves the conversation on when it starts a different document", async () => {
    const focus = store();
    await focus.remember("ses_a", "prj_1", "decks/draft.pptx");
    await focus.remember("ses_a", "prj_1", "decks/final.pptx");

    expect(await focus.recall("ses_a", "prj_1")).toBe("decks/final.pptx");
  });

  // A project-relative path is not unique across projects, so a conversation's
  // `report.docx` says nothing about the `report.docx` in the project now open.
  it("says nothing when the project is not the one the document was filed in", async () => {
    const focus = store();
    await focus.remember("ses_a", "prj_1", "report.docx");

    expect(await focus.recall("ses_a", "prj_2")).toBe("");
  });

  it("has nothing for a conversation that has not built anything", async () => {
    expect(await store().recall("ses_new", "prj_1")).toBe("");
  });

  // Nothing is filed against a conversation that does not exist yet: the app
  // opens Office before the first conversation on a fresh install.
  it("ignores a note with no conversation to file it under", async () => {
    const focus = store();
    await focus.remember("", "prj_1", "a.pptx");

    expect(await focus.recall("", "prj_1")).toBe("");
  });

  it("ignores a damaged record and keeps the rest", async () => {
    const focus = store();
    await focus.remember("ses_a", "prj_1", "a.pptx");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      file,
      JSON.stringify([
        { sessionId: "ses_broken" },
        { sessionId: "ses_a", projectId: "prj_1", path: "a.pptx", at: new Date().toISOString() },
      ]),
      "utf8",
    );

    expect(await store().recall("ses_a", "prj_1")).toBe("a.pptx");
  });
});
