#!/usr/bin/env node
/**
 * Build a standalone IQ Compiler executable.
 *
 * The app is a pnpm workspace, and pnpm's `node_modules` is a forest of
 * symlinks into a content-addressed store. Electron packagers expect a plain
 * npm-shaped tree, so this script stages one first: a clean directory holding
 * only the compiled output, the bundled skills, and the runtime dependency
 * closure copied as real files. `@electron/packager` then wraps that staged
 * tree in the Electron runtime.
 *
 * The staged layout is not arbitrary. Three modules find their neighbours by
 * walking up from their own file:
 *
 *   apps/main/dist/index.js   -> ../../preload/dist, ../../renderer/dist
 *   packages/core/dist/**     -> ../../../skills
 *   packages/core/dist/myiq/  -> ../../../myiq-mcp/dist
 *
 * Putting the workspace packages under `node_modules/@iq/<name>` keeps every
 * one of those relative walks correct — `node_modules` plays the part of the
 * repo root and `@iq` the part of `packages/` — so no product code has to know
 * it has been packaged. That is also why the skills live at
 * `node_modules/skills`: it is what `packages/core` resolves to from there.
 *
 * Usage:
 *   node scripts/package-app.mjs [options]
 *
 *   --no-build          Package whatever is already compiled (skips `pnpm build`).
 *   --out <dir>         Output directory. Default: release/
 *   --platform <p>      win32 | darwin | linux. Default: the host.
 *   --arch <a>          x64 | arm64. Default: the host.
 *   --icon <file>       .ico (Windows) or .icns (macOS) to stamp on the binary.
 *   --stage-only        Build the staged tree and stop, for inspection.
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const APP_NAME = "IQ Compiler";

/** Compiled output that must keep its repo-relative position. */
const APP_TREE = [
  { from: "apps/main/dist", to: "apps/main/dist" },
  { from: "apps/preload/dist", to: "apps/preload/dist" },
  { from: "apps/renderer/dist", to: "apps/renderer/dist" },
  { from: "skills", to: "node_modules/skills" },
];

/** Workspace packages, staged where their own relative walks still resolve. */
const WORKSPACE_PACKAGES = [
  { dir: "packages/core", to: "node_modules/@iq/core" },
  { dir: "packages/shared", to: "node_modules/@iq/shared" },
  { dir: "packages/myiq-mcp", to: "node_modules/@iq/myiq-mcp" },
];

/**
 * Manifests whose `dependencies` are the app's runtime roots. The list is read
 * rather than hardcoded so adding a dependency to one of these packages does
 * not silently ship a broken build.
 */
const RUNTIME_MANIFESTS = [
  "apps/main/package.json",
  "packages/core/package.json",
  "packages/shared/package.json",
  "packages/myiq-mcp/package.json",
];

function parseArgs(argv) {
  const options = {
    build: true,
    out: "release",
    platform: process.platform,
    arch: process.arch,
    icon: "",
    stageOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-build") options.build = false;
    else if (arg === "--stage-only") options.stageOnly = true;
    else if (arg === "--out") options.out = argv[++i] ?? options.out;
    else if (arg === "--platform") options.platform = argv[++i] ?? options.platform;
    else if (arg === "--arch") options.arch = argv[++i] ?? options.arch;
    else if (arg === "--icon") options.icon = argv[++i] ?? "";
    else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

/**
 * How to start pnpm as a child process.
 *
 * On Windows `pnpm` on PATH is a `.cmd` shim, and since the fix for
 * CVE-2024-27980 Node refuses to spawn one without a shell — `spawnSync` fails
 * with `EINVAL` before pnpm is ever reached. Running it through a shell would
 * work and is what most build scripts do, but Node deprecates passing arguments
 * that way and the escaping is the caller's problem.
 *
 * So find the JavaScript the shim would have run and hand that to the node we
 * are already inside. `npm_execpath` is set when this script is itself a pnpm
 * lifecycle script; otherwise walk PATH for the shim and take the `pnpm.cjs`
 * beside it. A shell is the last resort, for a layout neither step recognises.
 */
function pnpmCommand() {
  const fromLifecycle = process.env.npm_execpath ?? "";
  if (/\.[cm]?js$/i.test(fromLifecycle) && existsSync(fromLifecycle)) {
    return { command: process.execPath, args: [fromLifecycle], shell: false };
  }

  if (process.platform === "win32") {
    for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
      if (entry === "") continue;
      const cli = path.join(entry, "node_modules", "pnpm", "bin", "pnpm.cjs");
      if (existsSync(path.join(entry, "pnpm.cmd")) && existsSync(cli)) {
        return { command: process.execPath, args: [cli], shell: false };
      }
    }
    return { command: "pnpm", args: [], shell: true };
  }

  return { command: "pnpm", args: [], shell: false };
}

/** Run `pnpm build` for real. */
function build() {
  log("building workspace (pnpm build)");
  const pnpm = pnpmCommand();
  const result = spawnSync(pnpm.command, [...pnpm.args, "run", "build"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: pnpm.shell,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm build failed with code ${result.status}`);
}

/**
 * Find a package directory the way Node does: walk up `node_modules` from the
 * requiring package. The result is the *real* path, because pnpm's entries are
 * symlinks into the store and the copy has to read the files themselves.
 */
function resolvePackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return path.dirname(realpathSync(candidate));
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Copy one package, leaving dependencies and compiler metadata behind.
 *
 * The staged tree is the release boundary. Source maps can contain complete
 * source files and build-machine paths, while incremental state belongs only
 * to the build machine.
 */
async function copyPackage(from, to) {
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, {
    recursive: true,
    dereference: true,
    filter: (source) => {
      const name = path.basename(source).toLowerCase();
      return name !== "node_modules"
        && !name.endsWith(".map")
        && !name.endsWith(".tsbuildinfo")
        && !name.endsWith(".d.ts")
        && !name.endsWith(".d.cts")
        && !name.endsWith(".d.mts");
    },
  });
}

/**
 * Copy the runtime dependency closure into the staging tree.
 *
 * Hoisted like npm: the first version of a name wins the root `node_modules`,
 * and a package that needs a different version gets its own nested copy. Each
 * package's `node_modules` is skipped by the copy and its contents re-placed
 * here instead, so pnpm's symlinks never reach the artifact.
 */
async function stageDependencies(staging, roots) {
  const hoisted = new Map();
  const copied = new Set();
  let count = 0;

  // Claim the root for the versions the app itself declares, before walking.
  // Otherwise the first transitive copy of a name wins and the app's own
  // version is dropped: @github/copilot-sdk wants zod 4 and @iq/core wants
  // zod 3, and whichever loses the root has to nest.
  for (const [name, from] of roots) {
    const packageDir = resolvePackageDir(name, from);
    if (!packageDir) continue;
    const manifest = await readJson(path.join(packageDir, "package.json"));
    if (!hoisted.has(name)) hoisted.set(name, manifest.version ?? "0.0.0");
  }

  async function install(name, fromDir, parentDir) {
    const packageDir = resolvePackageDir(name, fromDir);
    if (!packageDir) return false;
    const manifest = await readJson(path.join(packageDir, "package.json"));
    const version = manifest.version ?? "0.0.0";

    let target = path.join(staging, "node_modules", name);
    const owner = hoisted.get(name);
    if (owner === undefined) hoisted.set(name, version);
    else if (owner !== version) {
      // A root-level package has nowhere to nest — its parent *is* the root.
      // Copying it there would overwrite the owner, and skipping it would drop
      // it silently, so neither is safe to do quietly.
      if (parentDir === staging) {
        throw new Error(`${name}@${version} collides with ${name}@${owner} at the tree root`);
      }
      target = path.join(parentDir, "node_modules", name);
    }

    if (copied.has(target)) return true;
    copied.add(target);
    await copyPackage(packageDir, target);
    count += 1;

    // Optional dependencies are the platform binaries (the Copilot CLI, native
    // addons). One that does not resolve is the normal case on another OS, so a
    // miss is not an error.
    const required = Object.keys(manifest.dependencies ?? {});
    const optional = Object.keys(manifest.optionalDependencies ?? {});
    for (const dep of required) {
      if (!(await install(dep, packageDir, target))) {
        throw new Error(`${name}@${version} needs ${dep}, which is not installed`);
      }
    }
    for (const dep of optional) await install(dep, packageDir, target);
    return true;
  }

  for (const [name, from] of roots) await install(name, from, staging);
  log(`staged ${count} runtime packages`);
}

/** The union of every runtime `dependencies` block, minus the workspace links. */
async function runtimeRoots() {
  const roots = new Map();
  for (const manifest of RUNTIME_MANIFESTS) {
    const file = path.join(ROOT, manifest);
    const { dependencies = {} } = await readJson(file);
    for (const [name, range] of Object.entries(dependencies)) {
      if (range.startsWith("workspace:")) continue;
      if (!roots.has(name)) roots.set(name, path.dirname(file));
    }
  }
  return roots;
}

async function stage(staging) {
  log(`staging app tree in ${path.relative(ROOT, staging) || staging}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  for (const { from, to } of APP_TREE) {
    const source = path.join(ROOT, from);
    if (!existsSync(source)) {
      throw new Error(`${from} is missing — run without --no-build, or run pnpm build first`);
    }
    await copyPackage(source, path.join(staging, to));
  }

  for (const { dir, to } of WORKSPACE_PACKAGES) {
    const source = path.join(ROOT, dir);
    const target = path.join(staging, to);
    await mkdir(target, { recursive: true });
    await copyPackage(path.join(source, "dist"), path.join(target, "dist"));
    await cp(path.join(source, "package.json"), path.join(target, "package.json"));
  }

  // Node reads module kind from the nearest package.json. The staged root is
  // ESM for the main process; the preload is a CommonJS bundle and says so.
  await writeFile(
    path.join(staging, "apps", "preload", "package.json"),
    `${JSON.stringify({ name: "@iq/preload", private: true, type: "commonjs" }, null, 2)}\n`,
  );

  await stageDependencies(staging, await runtimeRoots());

  const root = await readJson(path.join(ROOT, "package.json"));
  const manifest = {
    name: "iq-compiler",
    productName: APP_NAME,
    version: root.version,
    description: root.description,
    private: true,
    type: "module",
    main: "apps/main/dist/index.js",
  };
  await writeFile(
    path.join(staging, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

async function directorySize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
}

const SOURCE_MAP_COMMENT_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".css"]);
const LINE_SOURCE_MAP_COMMENT = /\/\/[#@][ \t]*sourceMappingURL=[^\r\n]*/g;
const BLOCK_SOURCE_MAP_COMMENT = /\/\*[#@]\s*sourceMappingURL=.*?\*\//gs;

/** Stop runtimes and developer tools from requesting maps removed at staging. */
async function stripSourceMapReferences(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await stripSourceMapReferences(full);
      continue;
    }
    if (!entry.isFile() || !SOURCE_MAP_COMMENT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }

    const source = await readFile(full, "utf8");
    const stripped = source
      .replace(LINE_SOURCE_MAP_COMMENT, "")
      .replace(BLOCK_SOURCE_MAP_COMMENT, "");
    if (stripped !== source) await writeFile(full, stripped);
  }
}

/** Fail closed if a future staging path bypasses release filtering. */
async function assertNoSourceMapMetadata(dir) {
  const forbiddenFiles = [];
  const forbiddenReferences = [];

  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const name = entry.name.toLowerCase();
      if (name.endsWith(".map") || name.endsWith(".tsbuildinfo")) {
        forbiddenFiles.push(path.relative(dir, full));
      }
      if (SOURCE_MAP_COMMENT_EXTENSIONS.has(path.extname(name))) {
        const source = await readFile(full, "utf8");
        LINE_SOURCE_MAP_COMMENT.lastIndex = 0;
        BLOCK_SOURCE_MAP_COMMENT.lastIndex = 0;
        if (LINE_SOURCE_MAP_COMMENT.test(source) || BLOCK_SOURCE_MAP_COMMENT.test(source)) {
          forbiddenReferences.push(path.relative(dir, full));
        }
      }
    }
  }

  await walk(dir);
  const forbidden = [...forbiddenFiles, ...forbiddenReferences.map((file) => `${file} (reference)`)];
  if (forbidden.length > 0) {
    const shown = forbidden.slice(0, 10).join(", ");
    const more = forbidden.length > 10 ? ` (and ${forbidden.length - 10} more)` : "";
    throw new Error(`release staging contains source-map metadata: ${shown}${more}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const out = path.resolve(ROOT, options.out);
  const staging = path.join(out, "staging");

  if (options.build) build();
  const manifest = await stage(staging);
  await stripSourceMapReferences(staging);
  await assertNoSourceMapMetadata(staging);
  if (options.stageOnly) {
    log(`staged only: ${staging}`);
    return;
  }

  const { packager } = await import("@electron/packager");
  const electronVersion = (await readJson(require_.resolve("electron/package.json"))).version;
  log(`packaging with electron ${electronVersion} for ${options.platform}-${options.arch}`);

  const [appPath] = await packager({
    dir: staging,
    out,
    name: APP_NAME,
    appVersion: manifest.version,
    electronVersion,
    platform: options.platform,
    arch: options.arch,
    overwrite: true,
    // The Copilot CLI, koffi's addon and playwright-core's driver are all
    // spawned or dlopen'd, and none of that works from inside an asar archive.
    asar: false,
    // The tree was staged deliberately; letting the packager prune it would
    // ask npm about a workspace it cannot see.
    prune: false,
    derefSymlinks: true,
    ...(options.icon ? { icon: path.resolve(ROOT, options.icon) } : {}),
    win32metadata: {
      CompanyName: APP_NAME,
      FileDescription: manifest.description ?? APP_NAME,
      ProductName: APP_NAME,
      InternalName: APP_NAME,
    },
  });

  const suffix = options.platform === "win32" ? ".exe" : "";
  const executable = path.join(appPath, `${APP_NAME}${suffix}`);
  const size = await directorySize(appPath);
  // The staged tree is a full second copy of the app. It is reproducible, so
  // keep it only when the run was explicitly about inspecting it.
  await rm(staging, { recursive: true, force: true });
  log("");
  log(`executable  ${executable}`);
  log(`bundle      ${appPath} (${(size / 1024 / 1024).toFixed(0)} MB)`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
