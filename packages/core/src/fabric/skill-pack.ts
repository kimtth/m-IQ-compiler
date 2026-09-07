import { readFile, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  FABRIC_SKILLS_HINT,
  FabricSkillPack,
  type FabricAgentEntry,
  type FabricBundleEntry,
  type FabricReferenceEntry,
  type FabricSkillEntry,
} from "@iq/shared";
import type { AppPaths } from "../config/paths.js";

/**
 * Resolving `microsoft/skills-for-fabric` on this machine.
 *
 * The Fabric surface deliberately owns no Fabric knowledge of its own. Fabric's
 * REST surface, item definitions and workload patterns change on a release
 * cadence this app does not control, so a vendored copy of "how to create a
 * lakehouse" starts rotting the day it is written and fails in the least
 * useful way possible: confidently, against a live workspace.
 *
 * Instead the agent is grounded on the upstream Microsoft bundle, resolved from
 * wherever the machine already has it. The search order mirrors the media tool
 * resolver, and for the same reason — an explicit choice is never silently
 * overridden by something found later:
 *
 *   1. an explicit path in the Fabric connection settings;
 *   2. `IQ_FABRIC_SKILLS`, for headless and CI hosts;
 *   3. the copy `pnpm prepare:fabric-skills` downloaded under `<IQ_HOME>/tools`;
 *   4. an existing GitHub Copilot CLI install
 *      (`~/.copilot/installed-plugins/fabric-collection`), because a user who
 *      already ran `/plugin install fabric-skills@fabric-collection` should not
 *      have to download it twice.
 *
 * Two layouts are accepted because both exist in the wild: the repository's own
 * `skills/<name>/SKILL.md`, and the plugin bundles' `<bundle>/skills/<name>/SKILL.md`.
 *
 * Absence is reported, never worked around. A Fabric run without this bundle
 * would be an agent inventing API shapes, which is exactly the failure this
 * module exists to prevent.
 */

/** Where `pnpm prepare:fabric-skills` puts what it downloads. */
export function preparedFabricSkillsDir(paths: AppPaths): string {
  return join(paths.tools, "skills-for-fabric");
}

/** The GitHub Copilot CLI plugin location, when the user installed it there. */
function copilotPluginDir(): string {
  return join(homedir(), ".copilot", "installed-plugins", "fabric-collection");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The `description` from a SKILL.md YAML frontmatter block.
 *
 * Deliberately a small hand-rolled reader rather than a YAML dependency: the
 * only field wanted is one scalar, the block is the first thing in the file,
 * and folded multi-line descriptions are common in this bundle — which a naive
 * `split(":")` would truncate mid-sentence.
 */
export function parseSkillDescription(text: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return "";
  const lines = (match[1] ?? "").split(/\r?\n/);

  const start = lines.findIndex((line) => /^description\s*:/.test(line));
  if (start < 0) return "";

  const parts: string[] = [];
  const first = lines[start]?.replace(/^description\s*:\s*/, "").trim() ?? "";
  if (first !== "" && first !== "|" && first !== ">") parts.push(first);

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    // A new top-level key ends the value; continuation lines are indented.
    if (/^\S/.test(line)) break;
    const trimmed = line.trim();
    if (trimmed !== "") parts.push(trimmed);
  }

  return parts.join(" ").replace(/^["']|["']$/g, "").trim();
}

async function readSkillEntry(
  directory: string,
  name: string,
  bundle: string,
): Promise<FabricSkillEntry | null> {
  try {
    const text = await readFile(join(directory, "SKILL.md"), "utf8");
    return { name, description: parseSkillDescription(text), directory, bundle };
  } catch {
    return null;
  }
}

/** Every `<skillsDir>/<name>/SKILL.md` under one skills directory. */
async function readSkillsDir(skillsDir: string, bundle: string): Promise<FabricSkillEntry[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: FabricSkillEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skill = await readSkillEntry(join(skillsDir, entry.name), entry.name, bundle);
    if (skill !== null) found.push(skill);
  }
  return found;
}

/**
 * Every `<bundle>/agents/<Name>.agent.md`.
 *
 * The same frontmatter reader as the skills: an agent file carries a `name`
 * and a folded `description` in exactly the same block, so a second parser
 * would be a second thing to keep in step for no gain.
 */
async function readAgentsDir(agentsDir: string, bundle: string): Promise<FabricAgentEntry[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: FabricAgentEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".agent.md")) continue;
    const path = join(agentsDir, entry.name);
    try {
      const text = await readFile(path, "utf8");
      found.push({
        name: entry.name.replace(/\.agent\.md$/, ""),
        description: parseSkillDescription(text),
        path,
        bundle,
      });
    } catch {
      // An unreadable agent file is reported by its absence from the list; it
      // must not take the rest of the bundle down with it.
    }
  }
  return found;
}

/** Every `<bundle>/common/<NAME>.md`, listed rather than read. */
async function readReferencesDir(
  commonDir: string,
  bundle: string,
): Promise<FabricReferenceEntry[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(commonDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => ({
      name: entry.name.replace(/\.md$/i, ""),
      path: join(commonDir, entry.name),
      bundle,
    }));
}

/**
 * What a bundle says about itself.
 *
 * `.github/plugin/plugin.json` is where a bundle carries its description and
 * its own version, and `.mcp.json` is where it declares the MCP servers its
 * skills expect. Both are optional: a repository clone has neither, and a
 * bundle that declares nothing is still perfectly usable.
 */
async function readBundleDetail(dir: string, name: string): Promise<FabricBundleEntry> {
  const detail: FabricBundleEntry = { name, description: "", version: "", mcpServers: [] };

  try {
    const raw = JSON.parse(
      await readFile(join(dir, ".github", "plugin", "plugin.json"), "utf8"),
    ) as { description?: unknown; version?: unknown };
    if (typeof raw.description === "string") detail.description = raw.description;
    if (typeof raw.version === "string") detail.version = raw.version;
  } catch {
    // Not a plugin bundle, or an unreadable manifest. Neither is fatal.
  }

  try {
    const raw = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8")) as {
      mcpServers?: unknown;
    };
    if (raw.mcpServers !== null && typeof raw.mcpServers === "object") {
      detail.mcpServers = Object.keys(raw.mcpServers as Record<string, unknown>).sort();
    }
  } catch {
    // Same.
  }

  return detail;
}

interface ResolvedRoot {
  bundles: string[];
  bundleDetails: FabricBundleEntry[];
  skills: FabricSkillEntry[];
  agents: FabricAgentEntry[];
  references: FabricReferenceEntry[];
}

const EMPTY_ROOT: ResolvedRoot = {
  bundles: [],
  bundleDetails: [],
  skills: [],
  agents: [],
  references: [],
};

/**
 * Read one resolved root, whichever of the two layouts it is in.
 *
 * A repository clone has `skills/` at the top. A plugin install has one
 * directory per bundle, each with its own `skills/`. Both are answered here
 * rather than by asking the caller which they have, because the caller cannot
 * know — the same setting can point at either.
 *
 * Skills decide whether a directory counts as a bundle, but they are not all
 * that is read: the agents that route between them and the `common/`
 * references they share are part of the same shipped unit, and a reader shown
 * only the skills is being shown a third of what is grounding the run.
 */
async function readRoot(root: string): Promise<ResolvedRoot> {
  const direct = await readSkillsDir(join(root, "skills"), "skills-for-fabric");
  if (direct.length > 0) {
    return {
      bundles: ["skills-for-fabric"],
      bundleDetails: [await readBundleDetail(root, "skills-for-fabric")],
      skills: direct,
      agents: await readAgentsDir(join(root, "agents"), "skills-for-fabric"),
      references: await readReferencesDir(join(root, "common"), "skills-for-fabric"),
    };
  }

  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return EMPTY_ROOT;
  }

  const bundles: string[] = [];
  const bundleDetails: FabricBundleEntry[] = [];
  const skills: FabricSkillEntry[] = [];
  const agents: FabricAgentEntry[] = [];
  const references: FabricReferenceEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(root, entry.name);
    const found = await readSkillsDir(join(dir, "skills"), entry.name);
    if (found.length === 0) continue;
    bundles.push(entry.name);
    bundleDetails.push(await readBundleDetail(dir, entry.name));
    skills.push(...found);
    agents.push(...(await readAgentsDir(join(dir, "agents"), entry.name)));
    references.push(...(await readReferencesDir(join(dir, "common"), entry.name)));
  }
  return { bundles, bundleDetails, skills, agents, references };
}

/**
 * The release the resolved copy declares.
 *
 * `package.json` is the repository's own answer; the first `##` heading of
 * CHANGELOG.md is a second. A plugin install has neither at the root — each
 * bundle carries its own `plugin.json` version instead — so the bundle
 * versions are the fallback, and they are joined rather than reduced to one:
 * `fabric-authoring` and `fabric-consumption` ship separately and claiming a
 * single number for both would be inventing a release that does not exist.
 */
async function readVersion(root: string, bundles: readonly FabricBundleEntry[]): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (typeof raw.version === "string" && raw.version !== "") return raw.version;
  } catch {
    // No package.json is the normal shape of a plugin bundle.
  }

  try {
    const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
    const heading = /^##\s+\[?v?(\d+\.\d+\.\d+)\]?/m.exec(changelog);
    if (heading?.[1]) return heading[1];
  } catch {
    // Equally fine.
  }

  const declared = bundles.filter((bundle) => bundle.version !== "");
  const distinct = [...new Set(declared.map((bundle) => bundle.version))];
  if (distinct.length === 1) return distinct[0] ?? "";
  return declared.map((bundle) => `${bundle.name} ${bundle.version}`).join(", ");
}

export interface FabricSkillPackOptions {
  paths: AppPaths;
  /** An explicit path from the Fabric connection, or "" for none. */
  setting?: string;
  /**
   * Where a GitHub Copilot CLI install would be.
   *
   * Overridable only so a test can point it somewhere empty: the real default
   * is a machine-wide directory, and a test that did not isolate it would pass
   * or fail depending on whether the developer happened to have run
   * `/plugin install fabric-skills@fabric-collection`.
   */
  copilotPluginDir?: string;
}

export async function resolveFabricSkillPack(
  options: FabricSkillPackOptions,
): Promise<FabricSkillPack> {
  const candidates: Array<{ root: string; source: FabricSkillPack["source"] }> = [];

  const setting = (options.setting ?? "").trim();
  if (setting !== "") candidates.push({ root: setting, source: "setting" });

  const fromEnv = process.env["IQ_FABRIC_SKILLS"];
  if (fromEnv && fromEnv.trim() !== "") {
    candidates.push({ root: fromEnv.trim(), source: "environment" });
  }

  candidates.push({ root: preparedFabricSkillsDir(options.paths), source: "prepared" });
  candidates.push({
    root: options.copilotPluginDir ?? copilotPluginDir(),
    source: "copilot",
  });

  for (const candidate of candidates) {
    if (!(await isDirectory(candidate.root))) continue;
    const { bundles, bundleDetails, skills, agents, references } = await readRoot(candidate.root);
    if (skills.length === 0) continue;

    return FabricSkillPack.parse({
      available: true,
      source: candidate.source,
      root: candidate.root,
      version: await readVersion(candidate.root, bundleDetails),
      bundles: bundles.sort(),
      bundleDetails: [...bundleDetails].sort((a, b) => a.name.localeCompare(b.name)),
      // Stable order so the prompt built from this is reproducible; two runs
      // that read the same bundle must produce the same catalogue.
      skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
      agents: agents.sort((a, b) => a.name.localeCompare(b.name)),
      references: references.sort((a, b) => a.name.localeCompare(b.name)),
      message: "",
    });
  }

  return FabricSkillPack.parse({ available: false, message: FABRIC_SKILLS_HINT });
}

/**
 * The skill catalogue as the agent is shown it.
 *
 * Name, one-line purpose and the path to the file itself, because the agent
 * reads SKILL.md before acting rather than relying on the summary. Purposes are
 * clipped: several upstream descriptions are trigger-phrase lists hundreds of
 * characters long, and pasting all of them would spend the context window on
 * routing hints for skills this run will never touch.
 */
export function skillCatalogue(pack: FabricSkillPack, limit = 220): string {
  if (!pack.available) return "(none resolved)";
  return pack.skills
    .map((skill) => {
      const purpose = skill.description.length > limit
        ? `${skill.description.slice(0, limit - 1)}\u2026`
        : skill.description;
      return `  - ${skill.bundle}/${skill.name}: ${purpose || "(see SKILL.md)"}\n    ${join(
        skill.directory,
        "SKILL.md",
      )}`;
    })
    .join("\n");
}
