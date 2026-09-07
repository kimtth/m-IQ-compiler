import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseSkillDescription,
  resolveFabricSkillPack,
  skillCatalogue,
  ensureAppPaths,
  resolveAppPaths,
  type AppPaths,
} from "@iq/core";

/**
 * The Fabric surface owns no Fabric knowledge, by design: it is grounded on
 * `microsoft/skills-for-fabric`, resolved from the machine at run time. That
 * makes resolution load-bearing in a way a lookup usually is not — get it wrong
 * and either runs are refused when the bundle is present, or an agent is turned
 * loose on a live project with nothing but what the model remembers about
 * Fabric's APIs.
 *
 * So the properties pinned here are: both real-world layouts are read, an
 * explicit choice always wins, absence is reported rather than papered over,
 * and the folded multi-line descriptions the upstream bundle actually uses
 * survive intact.
 */

let root: string;
let paths: AppPaths;
/**
 * Points at nothing, on purpose.
 *
 * The resolver falls back to a machine-wide GitHub Copilot CLI plugin
 * directory, so a test that did not override it would pass or fail depending on
 * whether the developer running it happens to have installed the bundle.
 */
let isolated: { copilotPluginDir: string };

const skill = (dir: string, name: string, description: string): void => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
};

beforeEach(() => {
  root = join(tmpdir(), `iq-fabric-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  paths = resolveAppPaths(root);
  ensureAppPaths(paths);
  isolated = { copilotPluginDir: join(root, "no-copilot-plugins") };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parseSkillDescription", () => {
  it("reads a single-line description", () => {
    expect(
      parseSkillDescription("---\nname: a\ndescription: Query a warehouse.\n---\n# a"),
    ).toBe("Query a warehouse.");
  });

  /**
   * The upstream bundle folds long descriptions across several indented lines.
   * A naive `split(":")` truncates them at the first line, which throws away
   * exactly the routing detail the catalogue exists to convey.
   */
  it("joins a folded multi-line description", () => {
    const text = [
      "---",
      "name: sqldw-consumption-cli",
      "description: Execute read-only T-SQL against Fabric Data Warehouse.",
      "  Use when the user wants to query warehouse data.",
      "  Triggers: \"warehouse\", \"SQL query\".",
      "license: MIT",
      "---",
    ].join("\n");

    const parsed = parseSkillDescription(text);
    expect(parsed).toContain("Execute read-only T-SQL");
    expect(parsed).toContain("Triggers");
    // The next top-level key ends the value; it must not be swallowed.
    expect(parsed).not.toContain("license");
  });

  it("returns empty rather than throwing on a file with no frontmatter", () => {
    expect(parseSkillDescription("# just a heading")).toBe("");
  });
});

describe("resolveFabricSkillPack", () => {
  it("reads a repository clone's top-level skills directory", async () => {
    const clone = join(root, "clone");
    const skills = join(clone, "skills");
    skill(skills, "sqldw-authoring-cli", "Create tables in a warehouse.");
    skill(skills, "spark-authoring-cli", "Author notebook cells.");
    writeFileSync(join(clone, "package.json"), JSON.stringify({ version: "0.3.10" }), "utf8");

    const pack = await resolveFabricSkillPack({ paths, setting: clone, ...isolated });

    expect(pack.available).toBe(true);
    expect(pack.source).toBe("setting");
    expect(pack.version).toBe("0.3.10");
    // Sorted, so the prompt built from this is reproducible across runs.
    expect(pack.skills.map((entry) => entry.name)).toEqual([
      "spark-authoring-cli",
      "sqldw-authoring-cli",
    ]);
  });

  it("reads a plugin install's per-bundle layout, and names each bundle", async () => {
    const plugins = join(root, "fabric-collection");
    skill(join(plugins, "fabric-authoring", "skills"), "sqldw-authoring-cli", "Create tables.");
    skill(join(plugins, "fabric-consumption", "skills"), "sqldw-consumption-cli", "Query tables.");

    const pack = await resolveFabricSkillPack({ paths, setting: plugins, ...isolated });

    expect(pack.available).toBe(true);
    expect(pack.bundles).toEqual(["fabric-authoring", "fabric-consumption"]);
    expect(pack.skills.map((entry) => entry.bundle).sort()).toEqual([
      "fabric-authoring",
      "fabric-consumption",
    ]);
  });

  /**
   * An explicit setting must never be overridden by something found later. A
   * user who pointed at a clone they are editing would otherwise be silently
   * served a stale download.
   */
  it("prefers an explicit setting over the prepared download", async () => {
    const prepared = join(paths.tools, "skills-for-fabric", "skills");
    skill(prepared, "downloaded", "From the prepare script.");
    const chosen = join(root, "mine");
    skill(join(chosen, "skills"), "hand-picked", "From my own clone.");

    const pack = await resolveFabricSkillPack({ paths, setting: chosen, ...isolated });

    expect(pack.source).toBe("setting");
    expect(pack.skills.map((entry) => entry.name)).toEqual(["hand-picked"]);
  });

  it("falls back to the prepared download when no setting is given", async () => {
    const prepared = join(paths.tools, "skills-for-fabric", "skills");
    skill(prepared, "downloaded", "From the prepare script.");

    const pack = await resolveFabricSkillPack({ paths, ...isolated });

    expect(pack.source).toBe("prepared");
    expect(pack.skills).toHaveLength(1);
  });

  it("reports absence with both installation routes, rather than pretending", async () => {
    const pack = await resolveFabricSkillPack({
      paths,
      setting: join(root, "nowhere"),
      ...isolated,
    });

    expect(pack.available).toBe(false);
    expect(pack.skills).toEqual([]);
    // The message has to be actionable: a bare "not found" leaves the user
    // guessing which of two installation routes they were meant to take.
    expect(pack.message).toContain("prepare:fabric-skills");
    expect(pack.message).toContain("fabric-collection");
  });

  it("ignores a directory that has no SKILL.md in it", async () => {
    const clone = join(root, "clone");
    mkdirSync(join(clone, "skills", "not-a-skill"), { recursive: true });

    const pack = await resolveFabricSkillPack({ paths, setting: clone, ...isolated });
    expect(pack.available).toBe(false);
  });

  /**
   * A bundle ships more than skills, and the app was reporting only the skills.
   * The agents are what route a request to a skill and the `common/` documents
   * are what the skills defer to, so a reader shown only the skills was seeing
   * a third of what grounds a run — and had no way to tell that the rest of the
   * installed bundle existed at all.
   */
  it("reads the agents and shared references beside the skills", async () => {
    const plugins = join(root, "fabric-collection");
    const authoring = join(plugins, "fabric-authoring");
    skill(join(authoring, "skills"), "sqldw-authoring-cli", "Create tables.");

    mkdirSync(join(authoring, "agents"), { recursive: true });
    writeFileSync(
      join(authoring, "agents", "FabricAdmin.agent.md"),
      "---\nname: FabricAdmin\ndescription: >\n  Manage Fabric operational excellence.\n  Use for capacity and governance.\n---\n\n# FabricAdmin\n",
      "utf8",
    );
    // Not an agent file; it must not be listed as one.
    writeFileSync(join(authoring, "agents", "README.md"), "# agents\n", "utf8");

    mkdirSync(join(authoring, "common"), { recursive: true });
    writeFileSync(join(authoring, "common", "COMMON-CLI.md"), "# cli\n", "utf8");
    writeFileSync(join(authoring, "common", "COMMON-CORE.md"), "# core\n", "utf8");

    const pack = await resolveFabricSkillPack({ paths, setting: plugins, ...isolated });

    expect(pack.agents).toHaveLength(1);
    expect(pack.agents[0]).toMatchObject({ name: "FabricAdmin", bundle: "fabric-authoring" });
    // The folded description survives, as it does for skills.
    expect(pack.agents[0]?.description).toContain("capacity and governance");
    expect(pack.references.map((entry) => entry.name)).toEqual(["COMMON-CLI", "COMMON-CORE"]);
  });

  /**
   * A plugin install has no `package.json` at its root — each bundle carries
   * its own version in `.github/plugin/plugin.json`. Before this the pack
   * reported "unversioned" for the most common installation route, which is
   * the one case where the version matters most.
   */
  it("takes the version and the declared MCP servers from each bundle's plugin.json", async () => {
    const plugins = join(root, "fabric-collection");
    const bundle = join(plugins, "fabric-authoring");
    skill(join(bundle, "skills"), "sqldw-authoring-cli", "Create tables.");
    mkdirSync(join(bundle, ".github", "plugin"), { recursive: true });
    writeFileSync(
      join(bundle, ".github", "plugin", "plugin.json"),
      JSON.stringify({ name: "fabric-authoring", description: "Authoring skills.", version: "0.3.9" }),
      "utf8",
    );
    writeFileSync(
      join(bundle, ".mcp.json"),
      JSON.stringify({ mcpServers: { fabric: { command: "npx" } } }),
      "utf8",
    );

    const pack = await resolveFabricSkillPack({ paths, setting: plugins, ...isolated });

    expect(pack.version).toBe("0.3.9");
    expect(pack.bundleDetails).toEqual([
      {
        name: "fabric-authoring",
        description: "Authoring skills.",
        version: "0.3.9",
        mcpServers: ["fabric"],
      },
    ]);
  });

  /**
   * Two bundles that ship separately do not have one version between them.
   * Reducing them to a single number would be citing a release that does not
   * exist, which is worse than citing none.
   */
  it("names both bundles when their versions differ", async () => {
    const plugins = join(root, "fabric-collection");
    for (const [name, version] of [
      ["fabric-authoring", "0.3.9"],
      ["fabric-consumption", "0.4.1"],
    ]) {
      const bundle = join(plugins, name!);
      skill(join(bundle, "skills"), `${name}-skill`, "A skill.");
      mkdirSync(join(bundle, ".github", "plugin"), { recursive: true });
      writeFileSync(
        join(bundle, ".github", "plugin", "plugin.json"),
        JSON.stringify({ version }),
        "utf8",
      );
    }

    const pack = await resolveFabricSkillPack({ paths, setting: plugins, ...isolated });

    expect(pack.version).toContain("fabric-authoring 0.3.9");
    expect(pack.version).toContain("fabric-consumption 0.4.1");
  });
});

describe("skillCatalogue", () => {
  it("lists every skill with its bundle and the path to read", async () => {
    const clone = join(root, "clone");
    skill(join(clone, "skills"), "sqldw-authoring-cli", "Create tables in a warehouse.");

    const catalogue = skillCatalogue(
      await resolveFabricSkillPack({ paths, setting: clone, ...isolated }),
    );

    expect(catalogue).toContain("sqldw-authoring-cli");
    expect(catalogue).toContain("Create tables in a warehouse.");
    // The agent reads the file, so the catalogue must say where it is.
    expect(catalogue).toContain("SKILL.md");
  });

  it("clips a description that is really a trigger-phrase list", async () => {
    const clone = join(root, "clone");
    skill(join(clone, "skills"), "verbose", "x".repeat(900));

    const catalogue = skillCatalogue(
      await resolveFabricSkillPack({ paths, setting: clone, ...isolated }),
      100,
    );

    // Otherwise the context window is spent on routing hints for skills this
    // run will never touch.
    expect(catalogue).toContain("\u2026");
    expect(catalogue.length).toBeLessThan(500);
  });

  it("says so plainly when nothing resolved", async () => {
    const pack = await resolveFabricSkillPack({
      paths,
      setting: join(root, "nowhere"),
      ...isolated,
    });
    expect(skillCatalogue(pack)).toBe("(none resolved)");
  });
});
