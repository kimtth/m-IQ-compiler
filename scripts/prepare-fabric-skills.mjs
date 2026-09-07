#!/usr/bin/env node
/**
 * Download `microsoft/skills-for-fabric` into `<IQ_HOME>/tools/skills-for-fabric`.
 *
 * The Fabric surface owns no Fabric knowledge of its own. Fabric's REST
 * surface, item definitions and workload patterns move on a release cadence
 * this app does not control, so a vendored copy of "how to create a lakehouse"
 * would start rotting the day it was written and then fail confidently against
 * a live workspace. The upstream Microsoft bundle is the source of truth and it
 * is fetched, not committed.
 *
 * Nothing is required. If a user has already run
 * `/plugin install fabric-skills@fabric-collection` in GitHub Copilot CLI, the
 * app finds that copy without this script; if neither exists, Fabric runs are
 * refused with a message naming both routes.
 *
 * Usage:
 *   node scripts/prepare-fabric-skills.mjs           # latest release
 *   node scripts/prepare-fabric-skills.mjs v0.3.10   # a specific tag
 */

import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const REPO = "microsoft/skills-for-fabric";

function targetDir() {
  const base = process.env.IQ_HOME ?? join(homedir(), ".iq-compiler");
  return join(base, "tools", "skills-for-fabric");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The newest release tag, or null when the API cannot be reached. */
async function latestTag() {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "iq-compiler" },
    });
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body.tag_name === "string" ? body.tag_name : null;
  } catch {
    return null;
  }
}

async function download(url, destination) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "iq-compiler" },
  });
  if (!response.ok || response.body === null) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

/** Unzip with whatever the host already has, as prepare-media does. */
async function unzip(archive, into) {
  if (process.platform === "win32") {
    await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${into}' -Force`,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return;
  }
  await run("unzip", ["-o", "-q", archive, "-d", into], { maxBuffer: 64 * 1024 * 1024 });
}

async function main() {
  const requested = process.argv[2];
  const tag = requested ?? (await latestTag()) ?? "main";
  const ref = tag === "main" ? "main" : tag;
  const url = `https://github.com/${REPO}/archive/refs/${
    ref === "main" ? "heads/main" : `tags/${ref}`
  }.zip`;

  const target = targetDir();
  console.log(`skills-for-fabric ${ref}`);
  console.log(`  MIT licensed. Source: https://github.com/${REPO}`);
  console.log(`  downloading ${url}`);

  const scratch = await mkdtemp(join(tmpdir(), "iq-fabric-skills-"));
  try {
    const archive = join(scratch, "skills.zip");
    await download(url, archive);

    const extracted = join(scratch, "out");
    await mkdir(extracted, { recursive: true });
    await unzip(archive, extracted);

    // A GitHub archive wraps everything in one `<repo>-<ref>` directory.
    const inner = (await readdir(extracted, { withFileTypes: true })).find((entry) =>
      entry.isDirectory(),
    );
    if (inner === undefined) throw new Error("the archive contained no directory");
    const source = join(extracted, inner.name);

    if (!(await exists(join(source, "skills")))) {
      throw new Error(
        "the archive has no top-level `skills` directory; the upstream layout may have changed",
      );
    }

    // Replaced whole rather than merged: a half-updated bundle mixing two
    // releases is worse than either, and the directory is regenerable.
    await rm(target, { recursive: true, force: true });
    await mkdir(join(target, ".."), { recursive: true });
    await rename(source, target).catch(async () => {
      // Cross-device rename fails on some CI images; fall back to a copy.
      const { cp } = await import("node:fs/promises");
      await cp(source, target, { recursive: true });
    });

    const skills = await readdir(join(target, "skills"));
    console.log(`  installed ${skills.length} skills to ${target}`);
    console.log("Done. The app resolves this automatically; no restart needed.");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    `prepare-fabric-skills failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
