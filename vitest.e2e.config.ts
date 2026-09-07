import { defineConfig } from "vitest/config";

/**
 * The system-test runner.
 *
 * Kept apart from `vitest.config.ts`: these specs launch and drive the real
 * Electron window. The other suite includes unit tests and optional local-tool
 * integration tests. Both resolve workspace packages from their built output;
 * these specs also need the renderer and main-process assets from `pnpm build`.
 *
 * Files run one at a time. Each spec owns a real window with a GPU context and
 * its own profile directory, and running several at once turns a slow machine
 * into a flaky one for no gain.
 */
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: "forks",
  },
});
