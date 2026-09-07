#!/usr/bin/env node
/**
 * Prepare the GEPA skill-evolution sidecar into `<IQ_HOME>/tools/evolve-py`.
 *
 * The same shape as `prepare-research.mjs`, and for the same reason: the
 * sidecar is a developer-machine convenience the app resolves at run time,
 * never a build requirement. A machine that skips this script loses the
 * Improve… control on the Skills surface and nothing else — the surface says
 * so, and names this command.
 *
 * It gets a virtual environment of its own rather than sharing the research one
 * under `tools/research-py` or the MarkItDown one under `tools/py`: different
 * owner, different lifecycle, and DSPy is a heavy dependency set that has no
 * business being able to break a Fabric extraction on an upgrade.
 *
 * Usage:
 *   node scripts/prepare-evolve.mjs
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE = join(REPO, "native", "iq-evolve");
const PYTHON_VERSION = "3.13";

function venvDir() {
  const base = process.env.IQ_HOME ?? join(homedir(), ".iq-compiler");
  return join(base, "tools", "evolve-py");
}

function venvPython(dir) {
  return process.platform === "win32"
    ? join(dir, "Scripts", "python.exe")
    : join(dir, "bin", "python");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function haveUv() {
  try {
    await run("uv", ["--version"], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(join(PACKAGE, "pyproject.toml")))) {
    throw new Error(`the iq-evolve package was not found at ${PACKAGE}`);
  }
  if (!(await haveUv())) {
    throw new Error(
      "uv was not found on PATH. Install it from https://docs.astral.sh/uv/ — it is used " +
        `because it can fetch Python ${PYTHON_VERSION} itself rather than making that a prerequisite.`,
    );
  }

  const dir = venvDir();
  console.log(`creating the evolution environment in ${dir}`);
  // `--allow-existing` so the script is idempotent: re-running it after an
  // upgrade must refresh the packages, not refuse because the venv is there.
  await run("uv", ["venv", "--python", PYTHON_VERSION, "--allow-existing", dir], {
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });

  console.log("installing dspy and the iq-evolve sidecar…");
  // `-e <path>` before the `--` separator: after it, uv reads every argument as
  // a package name and rejects the flag itself.
  await run("uv", ["pip", "install", "--python", venvPython(dir), "-e", PACKAGE], {
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });

  // Verified by running it, not by trusting the installer: a venv that installs
  // but does not import is the failure this check exists to catch, and finding
  // it here is much cheaper than finding it in the middle of a run someone is
  // paying for.
  const { stdout } = await run(venvPython(dir), ["-m", "iq_evolve", "--version"], {
    windowsHide: true,
  });
  console.log(`ready: ${stdout.trim()}`);
}

main().catch((error) => {
  console.error(`prepare:evolve failed — ${error.message}`);
  process.exitCode = 1;
});
