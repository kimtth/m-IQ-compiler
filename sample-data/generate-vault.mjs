// Regenerates the demo knowledge vault under `demo-project/knowledge`.
//
//   pnpm run deps           # builds @iq/core, which owns the note set
//   node sample-data/generate-vault.mjs
//
// The notes are *not* defined here. They come from
// `packages/core/src/samples/vault.ts`, because the app writes the same
// vault itself when you press **Load samples** in IQ Knowledge, and two copies
// of a generated corpus drift the first time either is edited. This script only
// puts that set on disk in the repo, so the vault can be opened in Obsidian and
// read as ordinary Markdown without launching the app.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SAMPLE_VAULT_NOTES } from "../packages/core/dist/samples/vault.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "demo-project", "knowledge");

rmSync(OUT, { recursive: true, force: true });

for (const note of SAMPLE_VAULT_NOTES) {
  const file = path.join(OUT, ...note.path.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, note.text);
}

const sections = new Set(SAMPLE_VAULT_NOTES.map((note) => note.path.split("/")[0]));
console.log(
  `wrote ${SAMPLE_VAULT_NOTES.length} notes across ${sections.size} sections -> ${path.relative(HERE, OUT)}`,
);
