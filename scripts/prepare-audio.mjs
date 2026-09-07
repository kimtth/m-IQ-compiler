#!/usr/bin/env node
/**
 * Build the `iq-audio` capture sidecar into `<IQ_HOME>/tools/bin`.
 *
 * The same shape as `prepare-media.mjs`, and for the same reason: the binary is
 * a developer-machine convenience that the app resolves at run time, never a
 * build requirement. A machine that skips this script loses system-audio
 * capture and nothing else, and every surface that needs the sidecar says so.
 *
 * Unlike FFmpeg and whisper.cpp this one is *ours* — `native/iq-audio` is in
 * this repo — so it is compiled rather than downloaded. That is the only
 * difference, and it is why cargo is required here and nowhere else.
 *
 * Usage:
 *   node scripts/prepare-audio.mjs
 *
 * On Windows, linking needs the MSVC developer environment or it fails with
 * `LNK1104: cannot open file 'msvcrt.lib'`, so the build is run inside
 * `vcvars64.bat` located through `vswhere`.
 */

import { copyFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CRATE = join(REPO, "native", "iq-audio");
const EXE = process.platform === "win32" ? ".exe" : "";

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

/** The MSVC developer environment, or null on a host that does not need one. */
async function vcvars() {
  if (process.platform !== "win32") return null;

  const vswhere = join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (!(await exists(vswhere))) {
    throw new Error(
      "Visual Studio Build Tools were not found (no vswhere.exe). Install the " +
        '"Desktop development with C++" workload; the Rust MSVC toolchain links against it.',
    );
  }

  const { stdout } = await run(vswhere, [
    "-latest",
    "-products",
    "*",
    "-requires",
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property",
    "installationPath",
  ]);
  const install = stdout.trim().split(/\r?\n/)[0];
  if (!install) {
    throw new Error(
      'No Visual Studio installation with the C++ tools was found. Install the "Desktop ' +
        'development with C++" workload.',
    );
  }

  const script = join(install, "VC", "Auxiliary", "Build", "vcvars64.bat");
  if (!(await exists(script))) throw new Error(`${script} is missing from ${install}`);
  return script;
}

async function build() {
  const env = await vcvars();
  console.log("iq-audio: building native/iq-audio (release)");

  if (env === null) {
    await run("cargo", ["build", "--release"], { cwd: CRATE, maxBuffer: 32 * 1024 * 1024 });
    return;
  }

  // `cargo build`, not `cargo test`: the crate's tests need a real audio host
  // and this script runs on machines that have none.
  //
  // `windowsVerbatimArguments` matters. Without it Node quotes each argument,
  // and cmd.exe receives an escaped `\"...vcvars64.bat\"` that it reports as
  // "not recognized as an internal or external command".
  await run("cmd.exe", ["/c", `call "${env}" && cargo build --release`], {
    cwd: CRATE,
    windowsVerbatimArguments: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function main() {
  try {
    await run("cargo", ["--version"]);
  } catch {
    console.log("iq-audio: cargo was not found. Install Rust from https://rustup.rs and re-run.");
    console.log("iq-audio: skipping — the app reports the sidecar as missing and stays usable.");
    return;
  }

  await build();

  const built = join(CRATE, "target", "release", `iq-audio${EXE}`);
  if (!(await exists(built))) throw new Error(`cargo reported success but ${built} is not there`);

  const target = toolsDir();
  await mkdir(target, { recursive: true });
  const installed = join(target, `iq-audio${EXE}`);
  await copyFile(built, installed);

  const { stdout } = await run(installed, ["--version"]);
  console.log(`iq-audio: installed ${stdout.trim()} at ${installed}`);
}

main().catch((error) => {
  console.error(`iq-audio: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
