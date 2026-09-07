import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SkillExportResult, SkillImportPreview } from "@iq/shared";
import { parseSkillMarkdown } from "./loader.js";

/**
 * Moving skills in and out of the project.
 *
 * The interchange format is the one the Agent Skills specification already
 * defines — a directory containing `SKILL.md` — so nothing here invents a
 * container, and a bundle exported from this app is loadable by any other
 * conforming runtime.
 *
 * The security posture is the interesting part. An imported skill is text that
 * will be given to the agent as instruction, and it may ship arbitrary
 * resource files, so a bundle is treated exactly like untrusted input from
 * disk: bounded in size and count, symlink-free, contained within its own
 * directory, and inspected before anything is copied. Installation never
 * enables the skill; that requires a separate human approval.
 */

/** Bounds chosen to admit any realistic skill and reject an archive bomb. */
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 8;
const EXCERPT_CHARS = 2_000;

export interface BundleFile {
  /** Path relative to the skill directory, forward-slashed. */
  path: string;
  size: number;
}

export interface InspectedBundle {
  preview: SkillImportPreview;
  files: BundleFile[];
}

/**
 * Read a candidate skill directory without installing anything.
 *
 * Problems are collected rather than thrown: the user asked to look at a
 * bundle, and "here is what is wrong with it" is a more useful answer than an
 * error. A non-empty `problems` list is what makes the import refuse later.
 */
export async function inspectBundle(
  source: string,
  isInstalled: (name: string) => boolean,
): Promise<InspectedBundle> {
  const problems: string[] = [];
  const dir = resolve(source);
  const directoryName = basename(dir);

  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) {
    return {
      preview: blankPreview(dir, directoryName, ["not a directory"]),
      files: [],
    };
  }

  let raw: string;
  try {
    raw = await readFile(join(dir, "SKILL.md"), "utf8");
  } catch {
    return {
      preview: blankPreview(dir, directoryName, [
        "no SKILL.md: an Agent Skills bundle is a directory containing SKILL.md",
      ]),
      files: [],
    };
  }

  let name = directoryName;
  let description = "";
  let allowedTools: string[] = [];
  let bodyExcerpt = "";

  try {
    const parsed = parseSkillMarkdown(raw);
    name = parsed.frontmatter.name;
    description = parsed.frontmatter.description;
    allowedTools = parsed.frontmatter["allowed-tools"] ?? [];
    bodyExcerpt = parsed.body.slice(0, EXCERPT_CHARS);
    if (parsed.body.length > EXCERPT_CHARS) bodyExcerpt += "\n…";

    // The spec ties the slug to the directory. Accepting a mismatch would let a
    // bundle install itself under a name the user did not see in the chooser.
    if (name !== directoryName) {
      problems.push(
        `SKILL.md declares "${name}" but the directory is named "${directoryName}"`,
      );
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  const { files, problems: fileProblems } = await collect(dir);
  problems.push(...fileProblems);

  return {
    files,
    preview: {
      source: dir,
      name,
      description,
      allowedTools,
      resources: files.map((file) => file.path).filter((path) => path !== "SKILL.md"),
      bodyExcerpt,
      conflicts: problems.length === 0 && isInstalled(name),
      problems,
    },
  };
}

/**
 * Copy an inspected bundle into the skills directory.
 *
 * Files are copied one by one from the inspected list rather than by a
 * recursive directory copy: what was shown to the user is exactly what lands
 * on disk, with no chance of a link or a file appearing between inspection and
 * installation.
 */
export async function installBundle(
  bundle: InspectedBundle,
  files: BundleFile[],
  skillsDir: string,
): Promise<string> {
  if (bundle.preview.problems.length > 0) {
    throw new Error(`bundle is not a valid skill: ${bundle.preview.problems.join("; ")}`);
  }

  const target = join(skillsDir, bundle.preview.name);
  // Replace wholesale: a partial overlay of an old version and a new one is
  // not a state any reviewer approved.
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  for (const file of files) {
    const to = join(target, ...file.path.split("/"));
    await mkdir(dirname(to), { recursive: true });
    await copyFile(join(bundle.preview.source, ...file.path.split("/")), to);
  }

  return target;
}

/**
 * Write a skill out as a specification-compliant directory.
 *
 * The destination is `<chosen directory>/<skill name>`, so exporting several
 * skills into one folder produces a library rather than a collision.
 */
export async function exportBundle(
  skillDir: string,
  name: string,
  destination: string,
): Promise<SkillExportResult> {
  if (!isAbsolute(destination)) throw new Error("export destination must be an absolute path");

  const { files, problems } = await collect(skillDir);
  if (problems.length > 0) throw new Error(`cannot export "${name}": ${problems.join("; ")}`);

  const target = join(destination, name);
  await mkdir(target, { recursive: true });

  for (const file of files) {
    const to = join(target, ...file.path.split("/"));
    await mkdir(dirname(to), { recursive: true });
    await copyFile(join(skillDir, ...file.path.split("/")), to);
  }

  return { name, destination: target, files: files.map((file) => file.path) };
}

/**
 * Enumerate a bundle's files under fixed bounds.
 *
 * Symlinks are skipped rather than followed. A bundle is chosen by the user
 * from anywhere on the machine, so a link inside it is a request to copy
 * something the user never saw.
 */
async function collect(dir: string): Promise<{ files: BundleFile[]; problems: string[] }> {
  const files: BundleFile[] = [];
  const problems: string[] = [];
  let total = 0;

  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) {
      problems.push(`bundle nests deeper than ${MAX_DEPTH} directories`);
      return;
    }

    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        problems.push(`bundle contains more than ${MAX_FILES} files`);
        return;
      }
      if (entry.name.startsWith(".")) continue;

      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        problems.push(`bundle contains a symbolic link: ${relative(dir, full)}`);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const info = await stat(full).catch(() => null);
      if (!info) continue;
      if (info.size > MAX_FILE_BYTES) {
        problems.push(`${relative(dir, full)} is larger than the ${MAX_FILE_BYTES} byte limit`);
        continue;
      }

      total += info.size;
      if (total > MAX_TOTAL_BYTES) {
        problems.push(`bundle is larger than the ${MAX_TOTAL_BYTES} byte limit`);
        return;
      }

      files.push({ path: relative(dir, full).split(sep).join("/"), size: info.size });
    }
  };

  await walk(dir, 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, problems };
}

function blankPreview(source: string, name: string, problems: string[]): SkillImportPreview {
  return {
    source,
    name,
    description: "",
    allowedTools: [],
    resources: [],
    bodyExcerpt: "",
    conflicts: false,
    problems,
  };
}
