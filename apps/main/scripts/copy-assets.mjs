// tsc compiles TypeScript and nothing else, but the recorder's capture window
// needs two non-TypeScript files beside the compiled output: the page it loads
// and the CommonJS preload that does the capturing. Copying them here keeps
// `dist` self-contained, so nothing at runtime has to reach back into `src`.
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, "src", "recording");
const to = join(root, "dist", "recording");

await mkdir(to, { recursive: true });
for (const file of ["capture.html", "capture-preload.cjs"]) {
  await cp(join(from, file), join(to, file));
}
