import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Loaded from disk with file://, so asset URLs must be relative.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome120",
    sourcemap: false,
  },
  server: {
    port: 5273,
    strictPort: true,
  },
});
