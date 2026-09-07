import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, delimiter, dirname, extname, isAbsolute, join, sep } from "node:path";

/**
 * Finding the program behind a command name, on Windows.
 *
 * `spawn(command, args, { shell: false })` is the right call for a command that
 * came out of configuration — a shell would turn a settings field into an
 * arbitrary command line — but on Windows it is also, for a large class of
 * perfectly installed tools, a call that cannot work. Two facts combine:
 *
 *  1. **`CreateProcess` does not consult `PATHEXT`.** `spawn("npx", …)` looks
 *     for a file literally named `npx` and fails, even though `npx.cmd` is
 *     sitting in a directory on `PATH`. The error is `ENOENT`, which reads as
 *     "Node is not installed" and sends the user off to reinstall something
 *     that was never missing.
 *  2. **A resolved `.cmd` still cannot be spawned directly.** Since the fix for
 *     CVE-2024-27980, Node refuses to spawn `.bat`/`.cmd` without `shell: true`
 *     and raises `EINVAL`. So resolving the path is necessary but not
 *     sufficient.
 *
 * The way out is not to reach for `shell: true`. `npx.cmd` is a shim whose
 * entire body is `"%NODE_EXE%" "%NPX_CLI_JS%" %*` — so this module resolves the
 * shim, finds the JavaScript behind it, and returns `node <script>` instead.
 * The child is still spawned from an explicit argv array with no shell, and a
 * `&&` typed into the command field still cannot be executed, because a file by
 * that name will simply not be found.
 *
 * On anything other than Windows, `spawn` already resolves `PATH` correctly and
 * there are no shims, so resolution is a no-op and the command is passed
 * through untouched.
 */

export interface SpawnTarget {
  command: string;
  args: string[];
}

export interface ResolvedSpawnTarget extends SpawnTarget {
  /**
   * How the command was resolved. Carried so a failure can say something
   * truer than "not found" — `shim_unsupported` in particular means the file
   * was located and cannot be started, which is a different problem with a
   * different remedy.
   */
  via: "verbatim" | "path" | "node_shim" | "not_found" | "shim_unsupported";
  /** What was located on disk, when anything was. For diagnostics only. */
  resolvedPath: string;
}

const WINDOWS = process.platform === "win32";

/** Batch shims: located by `PATHEXT`, unstartable without a shell. */
const SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isRunnableFile(path: string): Promise<boolean> {
  if (!(await isFile(path))) return false;
  if (WINDOWS) return true;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathExtensions(): string[] {
  if (!WINDOWS) return [""];
  const raw = process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD";
  const listed = raw
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  // `PATHEXT` first and the bare name last, which is the order a Windows shell
  // uses. The reverse looks tidier and is wrong: a Node install ships both
  // `npx` (a bash script, for Git Bash) and `npx.cmd`, and preferring the
  // extensionless file resolves to something Windows cannot execute at all —
  // producing the same `ENOENT` this module exists to remove.
  return [...listed, ""];
}

/** Every directory on `PATH`, plus the current one on Windows, as a shell would. */
function searchDirectories(): string[] {
  const raw = process.env["PATH"] ?? process.env["Path"] ?? "";
  const entries = raw
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter((entry) => entry !== "");
  return WINDOWS ? [process.cwd(), ...entries] : entries;
}

/** The first file on `PATH` matching `command`, honouring `PATHEXT`. */
export async function whichCommand(command: string): Promise<string | null> {
  const extensions = pathExtensions();

  if (command.includes("/") || command.includes(sep)) {
    const base = isAbsolute(command) ? command : join(process.cwd(), command);
    for (const extension of extensions) {
      const candidate = `${base}${extension}`;
      if (await isRunnableFile(candidate)) return candidate;
    }
    return null;
  }

  for (const directory of searchDirectories()) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (await isRunnableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The Node script a `.cmd` shim would have run.
 *
 * npm writes its shims to a fixed layout, and the shim itself names the file:
 * `"%NODE_EXE%" "%~dp0\node_modules\npm\bin\npx-cli.js" %*`. The candidates
 * below are that layout plus the one npm uses for a package's own `bin`
 * entry, which is how most other stdio MCP runners are installed.
 *
 * Returns null when nothing matches, because guessing is worse than a clear
 * refusal: launching the wrong script would fail somewhere much less legible.
 */
async function scriptBehindShim(shimPath: string): Promise<string | null> {
  const directory = dirname(shimPath);
  const name = basename(shimPath, extname(shimPath));

  const candidates = [
    join(directory, "node_modules", "npm", "bin", `${name}-cli.js`),
    join(directory, "node_modules", name, "bin", `${name}.js`),
    join(directory, "node_modules", name, "bin", `${name}-cli.js`),
    // Global installs under a prefix put the shims in the prefix root and the
    // packages one level down in `lib`.
    join(directory, "..", "lib", "node_modules", "npm", "bin", `${name}-cli.js`),
    join(directory, "..", "lib", "node_modules", name, "bin", `${name}.js`),
  ];

  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * The Node to run a shim's script with.
 *
 * The sibling first, exactly as the shim does — a machine with several Node
 * versions installed must use the one whose `npx` was found, not whichever
 * happens to be first on `PATH`. `process.execPath` is deliberately not a
 * fallback here: in the packaged app that is Electron, and running
 * `electron.exe npx-cli.js` starts a second copy of the app.
 */
async function nodeFor(shimPath: string): Promise<string | null> {
  const sibling = join(dirname(shimPath), WINDOWS ? "node.exe" : "node");
  if (await isRunnableFile(sibling)) return sibling;
  return whichCommand("node");
}

/**
 * Turn a configured command into something `spawn(..., { shell: false })` can
 * actually start.
 *
 * Never throws: an unresolvable command comes back with `via: "not_found"` and
 * the original values, so the caller still spawns and still gets the platform's
 * own error. The point of this function is to make the common Windows case
 * work and to make the uncommon one *explainable*, not to add a second place
 * where a server can be refused.
 */
export async function resolveSpawnTarget(target: SpawnTarget): Promise<ResolvedSpawnTarget> {
  const command = target.command.trim();
  if (command === "") {
    return { command, args: target.args, via: "not_found", resolvedPath: "" };
  }

  // POSIX `spawn` resolves PATH itself and there are no batch shims, so there
  // is nothing here worth second-guessing.
  if (!WINDOWS) {
    return { command, args: target.args, via: "verbatim", resolvedPath: "" };
  }

  const resolved = await whichCommand(command);
  if (resolved === null) {
    return { command, args: target.args, via: "not_found", resolvedPath: "" };
  }

  if (!SHIM_EXTENSIONS.has(extname(resolved).toLowerCase())) {
    return { command: resolved, args: target.args, via: "path", resolvedPath: resolved };
  }

  const script = await scriptBehindShim(resolved);
  const node = script === null ? null : await nodeFor(resolved);
  if (script === null || node === null) {
    return {
      command: resolved,
      args: target.args,
      via: "shim_unsupported",
      resolvedPath: resolved,
    };
  }

  return {
    command: node,
    args: [script, ...target.args],
    via: "node_shim",
    resolvedPath: resolved,
  };
}
