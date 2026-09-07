import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = promisify(execFile);
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("clean build", () => {
  it("removes configured incremental state along with every compiler's output", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "iq-clean-build-"));
    temporary.push(fixture);
    await mkdir(join(fixture, "scripts"));
    await copyFile(join(root, "scripts/clean-build.mjs"), join(fixture, "scripts/clean-build.mjs"));

    const generated = [
      "apps/main/tsconfig.tsbuildinfo",
      "apps/preload/tsconfig.tsbuildinfo",
      "apps/preload/dist/index.js",
      "apps/renderer/dist/index.html",
    ];
    for (const project of ["packages/shared", "packages/core", "packages/myiq-mcp", "apps/main", "apps/preload"]) {
      const file = join(root, project, "tsconfig.json");
      const { config, error } = ts.parseConfigFileTextToJson(file, await readFile(file, "utf8"));
      expect(error).toBeUndefined();
      const options = config.compilerOptions;
      // An explicit path prevents TypeScript from keeping state outside the
      // directory the clean command owns and then skipping the next emit.
      expect(options.tsBuildInfoFile).toBeTypeOf("string");
      generated.push(join(project, options.tsBuildInfoFile), join(project, options.outDir, "index.js"));
    }
    for (const file of generated) {
      await mkdir(dirname(join(fixture, file)), { recursive: true });
      await writeFile(join(fixture, file), "generated", "utf8");
    }
    await writeFile(join(fixture, "keep.txt"), "source", "utf8");

    await run(process.execPath, [join(fixture, "scripts/clean-build.mjs")]);
    for (const file of generated) {
      await expect(access(join(fixture, file))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readFile(join(fixture, "keep.txt"), "utf8")).toBe("source");
    // Cleaning an already-clean workspace is safe too.
    await run(process.execPath, [join(fixture, "scripts/clean-build.mjs")]);
  });
});