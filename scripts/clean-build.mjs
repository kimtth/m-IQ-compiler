#!/usr/bin/env node
/**
 * Remove generated workspace output before a full build.
 *
 * Clear emitted files and incremental state together. TypeScript can otherwise
 * skip compilation after its output is deleted, and stale emitted files can
 * survive source removal or changes to the compiler configuration.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GENERATED_OUTPUTS = [
  "apps/main/dist",
  "apps/preload/dist",
  "apps/preload/types",
  "apps/renderer/dist",
  "packages/core/dist",
  "packages/myiq-mcp/dist",
  "packages/shared/dist",
  // Default locations also need cleaning on an existing checkout.
  "apps/main/tsconfig.tsbuildinfo",
  "apps/preload/tsconfig.tsbuildinfo",
];

await Promise.all(
  GENERATED_OUTPUTS.map((output) => rm(path.join(ROOT, output), { recursive: true, force: true })),
);

process.stdout.write("cleaned generated build output\n");
