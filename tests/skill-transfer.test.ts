import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportBundle, inspectBundle, installBundle } from "@iq/core";

/**
 * Importing a skill is closer to editing the system prompt than to copying a
 * file: the text becomes instruction the agent follows. These tests are about
 * that, not about file plumbing — what a bundle declares must be visible before
 * anything is installed, and a malformed or hostile bundle must be refused
 * rather than partially applied.
 */

let scratch: string;
let skillsDir: string;

const SKILL = `---
name: expense-report
description: File an expense report from receipts. Use when the user mentions expenses.
allowed-tools:
  - m365.mail.read
  - files.write
---

# Expense report

1. Read the receipts.
2. Draft the report.
`;

async function bundle(name: string, body = SKILL): Promise<string> {
  const dir = join(scratch, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), body, "utf8");
  return dir;
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "iq-skill-transfer-"));
  skillsDir = join(scratch, "installed");
  await mkdir(skillsDir, { recursive: true });
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("inspectBundle", () => {
  it("surfaces what the skill declares, above all the tools it asks for", async () => {
    const dir = await bundle("expense-report");
    await writeFile(join(dir, "template.md"), "x", "utf8");

    const { preview } = await inspectBundle(dir, () => false);

    expect(preview.problems).toEqual([]);
    expect(preview.name).toBe("expense-report");
    expect(preview.allowedTools).toEqual(["m365.mail.read", "files.write"]);
    expect(preview.resources).toEqual(["template.md"]);
    expect(preview.bodyExcerpt).toContain("Read the receipts");
  });

  it("reports rather than throws, so the user learns what is wrong", async () => {
    const dir = join(scratch, "not-a-skill");
    await mkdir(dir);

    const { preview } = await inspectBundle(dir, () => false);
    expect(preview.problems.join(" ")).toMatch(/SKILL\.md/);
  });

  it("refuses a bundle whose declared name is not its directory name", async () => {
    const dir = await bundle("innocent", SKILL);
    const { preview } = await inspectBundle(dir, () => false);
    expect(preview.problems.join(" ")).toMatch(/but the directory is named/i);
  });

  it("warns when the import would replace an installed skill", async () => {
    const dir = await bundle("expense-report");
    const { preview } = await inspectBundle(dir, (name) => name === "expense-report");
    expect(preview.conflicts).toBe(true);
  });

  it("refuses a bundle containing a symbolic link", async () => {
    const dir = await bundle("expense-report");
    const outside = join(scratch, "outside.txt");
    await writeFile(outside, "secret", "utf8");
    try {
      await symlink(outside, join(dir, "linked.txt"), "file");
    } catch {
      return; // Link creation can require privilege; nothing to assert here.
    }

    const { preview } = await inspectBundle(dir, () => false);
    expect(preview.problems.join(" ")).toMatch(/symbolic link/i);
  });
});

describe("installBundle", () => {
  it("copies exactly the inspected files", async () => {
    const dir = await bundle("expense-report");
    await writeFile(join(dir, "template.md"), "template", "utf8");

    const inspected = await inspectBundle(dir, () => false);
    const target = await installBundle(inspected, inspected.files, skillsDir);

    expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain("expense-report");
    expect(await readFile(join(target, "template.md"), "utf8")).toBe("template");
  });

  it("refuses to install a bundle that failed inspection", async () => {
    const dir = join(scratch, "empty");
    await mkdir(dir);
    const inspected = await inspectBundle(dir, () => false);

    await expect(installBundle(inspected, inspected.files, skillsDir)).rejects.toThrow(
      /not a valid skill/i,
    );
  });

  it("replaces an existing install wholesale rather than overlaying it", async () => {
    const dir = await bundle("expense-report");
    await writeFile(join(dir, "old.md"), "old", "utf8");
    const first = await inspectBundle(dir, () => false);
    await installBundle(first, first.files, skillsDir);

    await rm(join(dir, "old.md"));
    const second = await inspectBundle(dir, () => false);
    const target = await installBundle(second, second.files, skillsDir);

    await expect(readFile(join(target, "old.md"), "utf8")).rejects.toThrow();
  });
});

describe("exportBundle", () => {
  it("writes a directory that can be inspected straight back in", async () => {
    const dir = await bundle("expense-report");
    const destination = join(scratch, "exports");
    await mkdir(destination);

    const result = await exportBundle(dir, "expense-report", destination);
    expect(result.files).toContain("SKILL.md");

    const { preview } = await inspectBundle(result.destination, () => false);
    expect(preview.problems).toEqual([]);
    expect(preview.name).toBe("expense-report");
  });

  it("refuses a relative destination", async () => {
    const dir = await bundle("expense-report");
    await expect(exportBundle(dir, "expense-report", "exports")).rejects.toThrow(/absolute/i);
  });
});
