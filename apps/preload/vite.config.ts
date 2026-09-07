import { defineConfig } from "vite";

/**
 * The preload is bundled into a single self-contained CommonJS file.
 *
 * A sandboxed preload runs in a restricted module system that can only require
 * Electron and a short list of built-ins - bare package specifiers such as
 * "@iq/shared" are not resolvable there, and the failure is silent apart from a
 * renderer console message. Bundling the shared contract into the preload keeps
 * the sandbox on while still validating IPC against the same schemas.
 */
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome130",
    sourcemap: false,
    minify: false,
    lib: {
      entry: "src/index.ts",
      formats: ["cjs"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      // Provided by the Electron runtime, never bundled.
      external: ["electron"],
    },
  },
});
