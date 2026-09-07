import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkills, readSkillBody } from "@iq/core";

/**
 * The bundled skill library is prompt surface that ships with the product, so
 * a malformed one is a shipped defect rather than a user's problem. This walks
 * the real directory through the real loader: every skill must parse, its
 * `name` must match its directory, and none may be silently skipped.
 */

const BUNDLED = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

describe("bundled skills", () => {
  it("every bundled skill loads through the real loader", async () => {
    const discovered = await discoverSkills(
      BUNDLED,
      "bundled",
      () => "approved",
      () => true,
    );

    expect(discovered.filter((entry) => entry.error).map((entry) => entry.record.name)).toEqual([]);

    const onDisk = (await readdir(BUNDLED, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
    expect(discovered.map((entry) => entry.record.name).sort()).toEqual(onDisk);
  });

  it("ships the Obsidian vault format skills, with their references bundled", async () => {
    const discovered = await discoverSkills(
      BUNDLED,
      "bundled",
      () => "approved",
      () => true,
    );
    const byName = new Map(discovered.map((entry) => [entry.record.name, entry.record]));

    for (const name of ["obsidian-markdown", "obsidian-bases", "json-canvas"]) {
      const record = byName.get(name);
      expect(record, `${name} should be bundled`).toBeDefined();
      // Progressive disclosure only pays off if the detail really is in
      // separate reference files rather than inlined into SKILL.md.
      expect(record?.resources.some((file) => file.startsWith("references/"))).toBe(true);
      // MIT-licensed upstream content must keep its attribution.
      const body = await readSkillBody(record!.path);
      expect(body).toContain("kepano/obsidian-skills");
    }
  });

  it("does not adopt the upstream skills that need an ungoverned shell", async () => {
    const names = (await readdir(BUNDLED)).map((entry) => entry.toLowerCase());
    expect(names).not.toContain("obsidian-cli");
    expect(names).not.toContain("defuddle");
  });

  it("ships the flow-modeling skill with no tools at all", async () => {
    const discovered = await discoverSkills(
      BUNDLED,
      "bundled",
      () => "approved",
      () => true,
    );
    const record = discovered.find((entry) => entry.record.name === "flow-modeling")?.record;

    expect(record, "flow-modeling should be bundled").toBeDefined();
    // The skill is asked for one fenced Mermaid block and nothing else. A tool
    // would only be a way to reach past the surface that parses the answer.
    expect(record?.allowedTools).toEqual([]);

    // The five shapes the canvas exports have to be named, or the answer comes
    // back in a notation the parser drops on the floor.
    const body = await readSkillBody(record!.path);
    for (const shape of ["flowchart TD", "([", "[[", "id{Text}", "id(Text)"]) {
      expect(body).toContain(shape);
    }
  });
});
