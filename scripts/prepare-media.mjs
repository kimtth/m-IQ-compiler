#!/usr/bin/env node
/**
 * Download the external media binaries into `<IQ_HOME>/tools/bin`.
 *
 * Meetly Lite runs `npm run prepare:ffmpeg` before a build and "downloads
 * FFmpeg 8.1.2 when needed" (meetly-lite/README.md). Same idea, with two
 * deliberate differences that follow from this being an Electron app rather
 * than a Tauri one:
 *
 *  - **Nothing is bundled into the package.** The download lands in the app's
 *    own tools directory next to its other regenerable state, so it is a
 *    developer-machine convenience and an opt-in for users, not a redistribution
 *    of GPLv3 software inside a signed installer.
 *  - **It is never required.** Every surface that uses these tools reports their
 *    absence and says what to do about it, so a machine that skips this script
 *    loses screen recording and local transcription and nothing else.
 *
 * Usage:
 *   node scripts/prepare-media.mjs ffmpeg     # FFmpeg + ffprobe
 *   node scripts/prepare-media.mjs whisper    # whisper.cpp CLI
 *   node scripts/prepare-media.mjs all
 *
 * Windows x64 only for now; that is the platform this product targets. On any
 * other host the script says so and exits 0 rather than failing a build.
 */

import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const SOURCES = {
  ffmpeg: {
    label: "FFmpeg 8.1.2 (essentials, GPLv3)",
    url: "https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-essentials_build.zip",
    // Names to lift out of the archive, wherever they sit inside it.
    wanted: ["ffmpeg.exe", "ffprobe.exe"],
    notice:
      "FFmpeg is GPLv3. You are downloading it from Gyan Doshi's Windows builds; see https://github.com/FFmpeg for the source.",
  },
  whisper: {
    label: "whisper.cpp (CPU build)",
    url: "https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip",
    wanted: ["whisper-cli.exe", "main.exe", "whisper.dll", "ggml.dll", "ggml-base.dll", "ggml-cpu.dll", "SDL2.dll"],
    notice:
      "whisper.cpp is MIT licensed. Models are downloaded separately from https://huggingface.co/ggerganov/whisper.cpp.",
  },
};

function toolsDir() {
  const base = process.env.IQ_HOME ?? join(homedir(), ".iq-compiler");
  return join(base, "tools", "bin");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body === null) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

/**
 * Unzip with whatever the host already has.
 *
 * Adding a zip dependency to the workspace so that an optional download script
 * can run is a poor trade; PowerShell ships with Windows and `unzip` is present
 * wherever this would ever run on a Unix host.
 */
async function unzip(archive, into) {
  if (process.platform === "win32") {
    await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${into}' -Force`,
    ], { maxBuffer: 32 * 1024 * 1024 });
    return;
  }
  await run("unzip", ["-o", "-q", archive, "-d", into], { maxBuffer: 32 * 1024 * 1024 });
}

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

async function install(name) {
  const source = SOURCES[name];
  if (source === undefined) throw new Error(`unknown tool "${name}"`);

  const target = toolsDir();
  await mkdir(target, { recursive: true });

  const primary = join(target, source.wanted[0]);
  if (await exists(primary)) {
    console.log(`${source.label}: already present at ${primary}`);
    return;
  }

  console.log(`${source.label}`);
  console.log(`  ${source.notice}`);
  console.log(`  downloading ${source.url}`);

  const scratch = await mkdtemp(join(tmpdir(), "iq-media-"));
  try {
    const archive = join(scratch, `${name}.zip`);
    await download(source.url, archive);
    const extracted = join(scratch, "out");
    await mkdir(extracted, { recursive: true });
    await unzip(archive, extracted);

    let installed = 0;
    for await (const path of walk(extracted)) {
      if (!source.wanted.includes(basename(path))) continue;
      const destination = join(target, basename(path));
      await rm(destination, { force: true });
      await rename(path, destination).catch(async () => {
        // Cross-device rename fails on some CI images; fall back to a copy.
        const { copyFile } = await import("node:fs/promises");
        await copyFile(path, destination);
      });
      if (process.platform !== "win32") await chmod(destination, 0o755);
      installed += 1;
      console.log(`  installed ${destination}`);
    }

    if (installed === 0) {
      throw new Error(
        `the archive contained none of ${source.wanted.join(", ")}; the upstream release layout may have changed`,
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== "win32") {
    console.log(
      `prepare-media: only Windows x64 downloads are wired up. Install ffmpeg and whisper.cpp with your package manager, or set IQ_FFMPEG and IQ_WHISPER.`,
    );
    return;
  }

  const requested = process.argv[2] ?? "all";
  const names = requested === "all" ? Object.keys(SOURCES) : [requested];
  for (const name of names) await install(name);
  console.log(`Done. Tools live in ${toolsDir()} and are resolved automatically.`);
}

main().catch((error) => {
  console.error(`prepare-media failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
