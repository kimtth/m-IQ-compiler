import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { SkillFrontmatter, type SkillOrigin, type SkillRecord, type SkillReviewState } from "@iq/shared";

/**
 * Agent Skills loader.
 *
 * Implements the on-disk format from the Agent Skills specification
 * (https://agentskills.io): a skill is a directory whose name matches the
 * `name` field, containing a `SKILL.md` with YAML frontmatter followed by a
 * Markdown body.
 *
 * Progressive disclosure is the whole point of the format, so this loader reads
 * only the frontmatter during discovery. The body is fetched on demand by
 * `readSkillBody`, and bundled resources are merely listed, never inlined.
 */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
}

export function parseSkillMarkdown(raw: string): ParsedSkill {
  const match = FRONTMATTER.exec(raw.replace(/^\uFEFF/, ""));
  if (!match) {
    throw new Error("SKILL.md must begin with a YAML frontmatter block delimited by ---");
  }
  const [, yamlSource = "", body = ""] = match;
  const frontmatter = SkillFrontmatter.parse(parseYaml(yamlSource));
  return { frontmatter, body: body.trim() };
}

export function serializeSkillMarkdown(frontmatter: SkillFrontmatter, body: string): string {
  const lines = [`name: ${frontmatter.name}`, `description: ${yamlScalar(frontmatter.description)}`];
  if (frontmatter.license) lines.push(`license: ${yamlScalar(frontmatter.license)}`);
  const allowed = frontmatter["allowed-tools"];
  if (allowed && allowed.length > 0) {
    lines.push("allowed-tools:");
    for (const tool of allowed) lines.push(`  - ${tool}`);
  }
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

/** Quote any scalar that YAML could misread, and escape embedded quotes. */
function yamlScalar(value: string): string {
  if (/^[\w][\w .,'()\/-]*$/.test(value) && !value.includes(": ")) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface DiscoveredSkill {
  record: SkillRecord;
  /** Set when the directory exists but is not a valid skill. */
  error?: string;
}

/**
 * Discover skills in one root directory.
 *
 * An invalid skill is reported rather than thrown, so one malformed
 * agent-authored skill cannot prevent the rest of the library from loading.
 */
export async function discoverSkills(
  root: string,
  origin: SkillOrigin,
  reviewOf: (name: string) => SkillReviewState,
  enabledOf: (name: string) => boolean,
): Promise<DiscoveredSkill[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const found: DiscoveredSkill[] = [];

  for (const entry of entries) {
    // Dot-directories hold internal state such as `.proposals`.
    if (entry.startsWith(".")) continue;
    const dir = join(root, entry);
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory()) continue;

    const skillFile = join(dir, "SKILL.md");
    let raw: string;
    try {
      raw = await readFile(skillFile, "utf8");
    } catch {
      continue;
    }

    try {
      const { frontmatter } = parseSkillMarkdown(raw);
      if (frontmatter.name !== entry) {
        throw new Error(
          `skill name "${frontmatter.name}" does not match its directory name "${entry}"`,
        );
      }
      const stats = await stat(skillFile);
      found.push({
        record: {
          name: frontmatter.name,
          description: frontmatter.description,
          origin,
          review: reviewOf(frontmatter.name),
          enabled: enabledOf(frontmatter.name),
          path: dir,
          allowedTools: frontmatter["allowed-tools"] ?? [],
          resources: await listResources(dir),
          version: 1,
          updatedAt: stats.mtime.toISOString(),
        },
      });
    } catch (error) {
      found.push({
        record: {
          name: entry,
          description: "",
          origin,
          review: "draft",
          enabled: false,
          path: dir,
          allowedTools: [],
          resources: [],
          version: 1,
          updatedAt: new Date().toISOString(),
        },
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return found;
}

/** List files bundled with a skill, excluding SKILL.md itself. */
async function listResources(dir: string, limit = 200): Promise<string[]> {
  const out: string[] = [];

  const walk = async (current: string): Promise<void> => {
    if (out.length >= limit) return;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name !== "SKILL.md") {
        out.push(relative(dir, full).split(sep).join("/"));
      }
    }
  };

  await walk(dir);
  return out.sort();
}

/** Read a skill body on demand. This is the progressive-disclosure step. */
export async function readSkillBody(skillDir: string): Promise<string> {
  const raw = await readFile(join(skillDir, "SKILL.md"), "utf8");
  return parseSkillMarkdown(raw).body;
}
