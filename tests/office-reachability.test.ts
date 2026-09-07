import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkills } from "@iq/core";
import { OFFICE_SKILLS } from "@iq/shared";
import { createOfficeTools } from "../packages/core/src/office/tools.js";
import { ToolRegistry } from "../packages/core/src/runtime/tools/registry.js";
import type { ToolContext } from "../packages/core/src/runtime/tools/registry.js";

/**
 * Can "create a pptx about Microsoft" reach the Office tools at all?
 *
 * Whether a model *chooses* to call a tool is the model's behaviour, not ours,
 * and a test that asserted it would be asserting the weather. What is ours, and
 * what this pins, is everything that has to be true before the choice is even
 * available:
 *
 *   1. The tools are registered and offered to an ordinary chat turn, which
 *      takes every family unless a caller narrows it.
 *   2. They survive schema conversion, so the SDK is handed a usable list.
 *   3. Their descriptions say what they are for in the words a user would use.
 *   4. The skill that teaches the model how to drive OfficeCLI is present, and
 *      every tool it names actually exists.
 *
 * Point 4 is the one that rots silently: a skill naming a tool that was renamed
 * teaches the model to call something that is not there, and the failure looks
 * like the model being stupid rather than like a stale document.
 */

const BUNDLED = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

function officeRegistry(): ToolRegistry {
  const registry = new ToolRegistry(
    { decide: async () => ({ decision: "allow", source: "user_rule", reason: "test" }) },
    { record: async () => {} } as never,
  );
  for (const tool of createOfficeTools({ office: {} as never })) registry.register(tool);
  return registry;
}

const context = (): ToolContext => ({}) as unknown as ToolContext;

describe("Office tools are reachable from an ordinary request", () => {
  it("offers the office family to a turn that names no families", () => {
    // `SessionsService.sendMessage` falls back to `toolRegistry.families()`,
    // so an interactive turn is offered everything registered. If `office`
    // were missing here, no wording could ever reach the tools.
    const registry = officeRegistry();
    expect(registry.families()).toContain("office");

    const offered = registry.toSdkTools(registry.families(), context);
    expect(offered.map((tool) => tool.name)).toContain("office_create_document");
    expect(offered.map((tool) => tool.name)).toContain("office_add_content");
  });

  it("still offers them when a caller narrows the families to office", () => {
    const registry = officeRegistry();
    expect(registry.toSdkTools(["office"], context)).not.toHaveLength(0);
    // And a turn narrowed to something else must not see them.
    expect(registry.toSdkTools(["m365.mail"], context)).toHaveLength(0);
  });

  it("describes each tool in terms a request would use", () => {
    const described = new Map(
      officeRegistry()
        .toSdkTools(["office"], context)
        .map((tool) => [tool.name, (tool.description ?? "").toLowerCase()]),
    );

    // The description is the only thing the model matches a request against.
    expect(described.get("office_create_document")).toMatch(/\.pptx/);
    expect(described.get("office_create_document")).toMatch(/create/);
    expect(described.get("office_add_content")).toMatch(/slide/);
  });
});

describe("the OfficeCLI skills that teach the model to use them", () => {
  it("ships one skill per Office format, each loading through the real loader", async () => {
    const discovered = await discoverSkills(
      BUNDLED,
      "bundled",
      () => "approved",
      () => true,
    );
    const names = discovered.filter((entry) => !entry.error).map((entry) => entry.record.name);

    for (const skill of Object.values(OFFICE_SKILLS)) {
      expect(names).toContain(skill);
    }
  });

  it("names only tools that exist, so the skill cannot teach a call that fails", async () => {
    const registered = new Set(officeRegistry().list().map((tool) => tool.name));
    const discovered = await discoverSkills(
      BUNDLED,
      "bundled",
      () => "approved",
      () => true,
    );

    for (const skill of Object.values(OFFICE_SKILLS)) {
      const record = discovered.find((entry) => entry.record.name === skill)?.record;
      expect(record, `${skill} is missing`).toBeDefined();
      // Every `allowed-tools` entry must be a real tool name.
      const unknown = record!.allowedTools.filter((tool) => !registered.has(tool));
      expect(unknown, `${skill} names tools that do not exist`).toEqual([]);
      expect(record!.allowedTools.length).toBeGreaterThan(0);
    }
  });

  it("describes the pptx skill in the words someone asking for a deck would use", async () => {
    // The SDK surfaces a skill by matching its description, so these words are
    // load-bearing: "create pptx about Microsoft" has to look like this skill.
    const discovered = await discoverSkills(
      BUNDLED,
      "bundled",
      () => "approved",
      () => true,
    );
    const pptx = discovered.find((entry) => entry.record.name === OFFICE_SKILLS.pptx)?.record;
    expect(pptx).toBeDefined();

    const description = pptx!.description.toLowerCase();
    for (const word of ["deck", "presentation", "slides", ".pptx"]) {
      expect(description, `pptx skill description omits "${word}"`).toContain(word);
    }
  });
});
