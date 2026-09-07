import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSpawnTarget, whichCommand } from "@iq/core";

/**
 * Resolving a command name to something that can actually be spawned.
 *
 * This exists because of a real, reproduced defect: the app reported
 * `"npx" is not on PATH. This server needs Node.js installed and on PATH.` on a
 * machine with Node 24 installed and `npx.cmd` sitting on `PATH`. Two Windows
 * facts caused it, and both are pinned below —
 *
 *  - `spawn(..., { shell: false })` uses `CreateProcess`, which does not apply
 *    `PATHEXT`, so a bare `npx` is never found;
 *  - a `.cmd` cannot be spawned without a shell at all since the fix for
 *    CVE-2024-27980, so merely resolving the path is not enough.
 *
 * The fix must not be `shell: true`: a server command is configuration, and a
 * shell would turn a settings field into a command line.
 *
 * The Windows-only cases are skipped elsewhere rather than faked, because the
 * behaviour under test *is* the platform's.
 */

const WINDOWS = process.platform === "win32";
const onWindows = WINDOWS ? it : it.skip;

let root: string;
let previousPath: string | undefined;
let previousPathExt: string | undefined;

beforeEach(() => {
  root = join(tmpdir(), `iq-exe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  previousPath = process.env["PATH"];
  previousPathExt = process.env["PATHEXT"];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (previousPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = previousPath;
  if (previousPathExt === undefined) delete process.env["PATHEXT"];
  else process.env["PATHEXT"] = previousPathExt;
});

/** A minimal npm-style install: the shim plus the script it delegates to. */
function installNpmShim(directory: string, name: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.cmd`), '@ECHO OFF\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\npm\\bin\\npx-cli.js" %*\r\n');
  // The extensionless sibling a real Node install also ships, for Git Bash.
  // Windows cannot execute it, and preferring it is how the first version of
  // this resolver still produced ENOENT.
  writeFileSync(join(directory, name), "#!/bin/sh\nexec node \"$0-cli.js\" \"$@\"\n");
  writeFileSync(join(directory, "node.exe"), "");
  const binDir = join(directory, "node_modules", "npm", "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, `${name}-cli.js`), "// entry point\n");
}

describe("whichCommand", () => {
  onWindows("prefers a PATHEXT match over an extensionless file of the same name", async () => {
    installNpmShim(root, "npx");
    process.env["PATH"] = root;
    process.env["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";

    expect(await whichCommand("npx")).toBe(join(root, "npx.cmd"));
  });

  it("returns null for something that is not there", async () => {
    process.env["PATH"] = root;
    expect(await whichCommand("definitely-not-a-real-program-xyz")).toBeNull();
  });
});

describe("resolveSpawnTarget", () => {
  /**
   * The whole point. `npx` in, `node <npx-cli.js>` out — no shell, an explicit
   * argv array, and the user's arguments carried through untouched.
   */
  onWindows("rewrites an npm batch shim to the Node script behind it", async () => {
    installNpmShim(root, "npx");
    process.env["PATH"] = root;
    process.env["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";

    const resolved = await resolveSpawnTarget({
      command: "npx",
      args: ["-y", "@microsoft/powerbi-modeling-mcp"],
    });

    expect(resolved.via).toBe("node_shim");
    // The sibling node, exactly as the shim itself does: a machine with several
    // Node versions must use the one whose npx was found.
    expect(resolved.command).toBe(join(root, "node.exe"));
    expect(resolved.args).toEqual([
      join(root, "node_modules", "npm", "bin", "npx-cli.js"),
      "-y",
      "@microsoft/powerbi-modeling-mcp",
    ]);
    expect(resolved.resolvedPath).toBe(join(root, "npx.cmd"));
  });

  onWindows("reports a shim it cannot see behind, rather than calling it missing", async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "weird.cmd"), "@ECHO OFF\r\n");
    process.env["PATH"] = root;
    process.env["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";

    const resolved = await resolveSpawnTarget({ command: "weird", args: [] });

    // Found and unstartable is a different problem from not installed, and
    // telling someone to install what they already have wastes an hour.
    expect(resolved.via).toBe("shim_unsupported");
    expect(resolved.resolvedPath).toBe(join(root, "weird.cmd"));
  });

  onWindows("passes a real executable through as an absolute path", async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "tool.exe"), "");
    process.env["PATH"] = root;
    process.env["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";

    const resolved = await resolveSpawnTarget({ command: "tool", args: ["--flag"] });

    expect(resolved.via).toBe("path");
    expect(resolved.command).toBe(join(root, "tool.exe"));
    expect(resolved.args).toEqual(["--flag"]);
  });

  /**
   * Resolution must never become a second place a server can be refused: an
   * unresolvable command is handed back untouched so the caller still spawns
   * and still gets the platform's own error.
   */
  it("hands back an unresolvable command unchanged", async () => {
    process.env["PATH"] = root;
    const resolved = await resolveSpawnTarget({ command: "no-such-program-xyz", args: ["a"] });

    if (WINDOWS) expect(resolved.via).toBe("not_found");
    expect(resolved.command).toBe("no-such-program-xyz");
    expect(resolved.args).toEqual(["a"]);
  });

  it("leaves non-Windows hosts alone, where spawn already resolves PATH", async () => {
    if (WINDOWS) return;
    const resolved = await resolveSpawnTarget({ command: "sh", args: ["-c", "true"] });
    expect(resolved.via).toBe("verbatim");
    expect(resolved.command).toBe("sh");
  });

  it("treats a blank command as unresolvable rather than throwing", async () => {
    const resolved = await resolveSpawnTarget({ command: "   ", args: [] });
    expect(resolved.via).toBe("not_found");
  });
});
