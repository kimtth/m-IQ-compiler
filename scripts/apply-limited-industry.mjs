#!/usr/bin/env node
/**
 * Reduce the upstream five-primer IQ Industry bundle to this distribution.
 *
 * Canonical replacement files and their metadata live in
 * scripts/limited-industry/. The script copies those files over their original
 * repository paths, removes excluded primers, and updates small references in
 * files that depend on the bundle composition.
 *
 * Usage:
 *   node scripts/apply-limited-industry.mjs
 *   node scripts/apply-limited-industry.mjs --check
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUNDLE_DIR = path.join(ROOT, "scripts", "limited-industry");
const CHECK = process.argv.slice(2).includes("--check");
const unknown = process.argv.slice(2).filter((arg) => arg !== "--check");
if (unknown.length > 0) throw new Error(`unknown option ${unknown.join(" ")}`);

const manifest = JSON.parse(await readFile(path.join(BUNDLE_DIR, "manifest.json"), "utf8"));
if (manifest.schemaVersion !== 1) throw new Error(`unsupported manifest schema ${manifest.schemaVersion}`);
if (!Array.isArray(manifest.copies) || !Array.isArray(manifest.remove)) {
  throw new Error("limited-industry manifest must define copies and remove arrays");
}

const changed = [];
const normalized = (value) => value.replace(/\r\n/g, "\n");
const targetPath = (relative) => path.join(ROOT, relative);
const sourcePath = (relative) => path.join(BUNDLE_DIR, relative);

function assertRelative(relative, label) {
  if (typeof relative !== "string" || relative === "" || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const resolved = path.resolve(ROOT, relative);
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error(`${label} escapes the repository: ${relative}`);
  }
}

async function copyCanonical(entry) {
  assertRelative(entry.source, "copy source");
  assertRelative(entry.target, "copy target");
  if (path.basename(entry.source) !== path.basename(entry.target)) {
    throw new Error(`copy must preserve the original filename: ${entry.source} -> ${entry.target}`);
  }

  const source = sourcePath(entry.source);
  const target = targetPath(entry.target);
  const desired = await readFile(source);
  const current = await readFile(target).catch(() => null);
  if (current !== null && current.equals(desired)) return;

  changed.push(entry.target);
  if (CHECK) return;
  await mkdir(path.dirname(target), { recursive: true });
  // Preserve timestamps and mode as well as the original filename/frontmatter.
  await cp(source, target, { force: true, preserveTimestamps: true });
}

async function updateFile(relative, transform) {
  assertRelative(relative, "dependent file");
  const file = targetPath(relative);
  const current = await readFile(file, "utf8");
  const desired = transform(normalized(current));
  if (desired === normalized(current)) return;
  changed.push(relative);
  if (!CHECK) await writeFile(file, desired, "utf8");
}

async function removeFile(relative) {
  assertRelative(relative, "removed file");
  const file = targetPath(relative);
  const exists = await stat(file).then(() => true, () => false);
  if (!exists) return;
  changed.push(relative);
  if (!CHECK) await rm(file, { force: true });
}

function replaceRequired(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`cannot locate ${label}; upstream layout changed`);
  pattern.lastIndex = 0;
  return source.replace(pattern, replacement);
}

for (const entry of manifest.copies) await copyCanonical(entry);
for (const relative of manifest.remove) await removeFile(relative);

await updateFile("apps/renderer/src/industry/primers.ts", (source) => {
  let next = replaceRequired(
    source,
    /^(?:import [^\n]+\.md\?raw";\n)+/,
    'import itConsulting from "./primers/it-consulting-industry.md?raw";\nimport software from "./primers/software-industry.md?raw";\n',
    "primer imports",
  );
  next = replaceRequired(
    next,
    /\/\*\*\n \* Ordered[\s\S]*?\*\/\nexport const INDUSTRY_PRIMERS: readonly IndustryPrimer\[\] = \[[\s\S]*?\n\];/,
    `/**\n * Ordered from the software product domain to the services that help\n * organizations adopt and operate it.\n */\nexport const INDUSTRY_PRIMERS: readonly IndustryPrimer[] = [\n  primer("software-industry", software),\n  primer("it-consulting-industry", itConsulting),\n];`,
    "primer catalogue",
  );
  return next;
});

const proseFiles = {
  "apps/renderer/src/industry/Industry.tsx": [
    [/Five primers, bundled/g, "Primers are bundled"],
    [/All five are already/g, "All bundled primers are already"],
    [/already holds all five/g, "already holds all bundled primers"],
  ],
  "apps/renderer/src/industry/cells.ts": [
    [/compiled into a cell is the thing an agent can be asked — "brief me on the\n \* semiconductor industry" — and the map's whole claim is that it shows how the\n \* body of work hangs together, so the domain briefs the rest of the work is\n \* grounded on cannot be missing from it\./g, "compiled into a cell is the thing an agent can be asked to summarize, and the\n * map's whole claim is that it shows how the body of work hangs together, so the\n * domain briefs cannot be missing from it."],
    [/shipped product content: five documents/g, "shipped product content: documents"],
  ],
  "apps/renderer/src/industry/mermaid.ts": [
    [/the constructs the five bundled primers actually use/g, "a small supported subset"],
    [/poor trade for five static flowcharts/g, "poor trade for simple static flowcharts"],
  ],
  "apps/renderer/src/styles/iq-industry.css": [
    [/Enough to choose between five documents/g, "Enough to choose between bundled documents"],
  ],
  "docs/00-agents.md": [[/five static flowcharts/g, "the bundled static flowcharts"]],
  "docs/02-backlog.md": [
    [/IQ Industry — five worked primers behind the demo/g, "IQ Industry — bundled primers behind the demo"],
    [/A reading surface carrying five sector primers/g, "A reading surface carrying the limited sector primers"],
  ],
  "docs/07-reference-features.md": [[/26 seeded cells plus the 5 industry primers/g, "26 seeded cells plus the bundled industry primers"]],
  "docs/08-product-ready.md": [[/26 seeded fixtures plus the 5 industry primers/g, "26 seeded fixtures plus the bundled industry primers"]],
};

for (const [file, replacements] of Object.entries(proseFiles)) {
  await updateFile(file, (source) => replacements.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    source,
  ));
}

await updateFile("tests/iq-industry.test.ts", (source) => {
  let next = replaceRequired(
    source,
    /const EXPECTED = \[[\s\S]*?\n\];/,
    'const EXPECTED = [\n  "it-consulting-industry.md",\n  "software-industry.md",\n];',
    "unit-test primer list",
  );
  return next.replace('it("ships exactly the five it claims to"', 'it("ships exactly the primers it claims to"');
});

await updateFile("tests/e2e/iq-industry.e2e.ts", (source) => {
  const listTests = `describe("IQ Industry — the primer list", () => {
  it("offers the bundled primers", async () => {
    await expect.poll(() => page.locator(".industry-item").count()).toBe(2);
  });

  it("names them, rather than their filenames", async () => {
    const list = await page.locator(".industry-list").innerText();
    expect(list).toMatch(/software/i);
    expect(list).toMatch(/consulting/i);
  });

  it("filters", async () => {
    await page.getByLabel("Filter primers").fill("software");
    await expect.poll(() => page.locator(".industry-item").count()).toBe(1);
    await page.getByLabel("Filter primers").fill("");
    await expect.poll(() => page.locator(".industry-item").count()).toBe(2);
  });
});

`;
  let next = replaceRequired(
    source,
    /describe\("IQ Industry — the primer list"[\s\S]*?(?=describe\("IQ Industry — the document")/,
    listTests,
    "industry-list e2e tests",
  );
  next = replaceRequired(
    next,
    /  it\("renders the abstract as a callout[\s\S]*?\n  \}\);/,
    `  it("renders the abstract as a callout and lists as lists", async () => {\n    await page.locator(".industry-item", { hasText: "Software" }).first().click();\n    await expect.poll(() => page.locator(".md-callout").count()).toBe(1);\n    await expect.poll(() => page.locator(".industry-page .md ul li").count()).toBeGreaterThan(0);\n    await expect.poll(() => page.locator(".industry-page .md ol li").count()).toBeGreaterThan(0);\n  });`,
    "primer rendering e2e test",
  );
  return next.replace(/All five are already/g, "All bundled primers are already");
});

await updateFile("tests/e2e/iq-connectome.e2e.ts", (source) => replaceRequired(
  source,
  /(  it\("includes the industry primers[\s\S]*?const list = await page\.locator\("\.connectome-list"\)\.innerText\(\);\n)([\s\S]*?)(  \}\);)/,
  '$1    expect(list).toMatch(/Brief me on Software Industry/i);\n    expect(list).toMatch(/Brief me on IT Consulting Industry/i);\n$3',
  "connectome primer assertions",
));

await updateFile("sample-data/demo-automation/production-capture.mjs", (source) => replaceRequired(
  source,
  /  const (?:automotive|software) = page\.locator\("\.industry-item"\)\.filter\(\{ hasText: "(?:Automotive|Software) Industry" \}\);\n  if \(\(await (?:automotive|software)\.count\(\)\) > 0\) await (?:automotive|software)\.first\(\)\.click\(\);/,
  '  const software = page.locator(".industry-item").filter({ hasText: "Software Industry" });\n  if ((await software.count()) > 0) await software.first().click();',
  "industry demo selection",
));

const primerTargets = manifest.copies
  .filter((entry) => entry.metadata?.kind === "industry-primer")
  .map((entry) => path.basename(entry.target))
  .sort();
const actualPrimers = (await readdir(targetPath("apps/renderer/src/industry/primers")))
  .filter((name) => name.endsWith(".md"))
  .sort();
if (!CHECK && JSON.stringify(actualPrimers) !== JSON.stringify(primerTargets)) {
  throw new Error(`unexpected primer set: ${actualPrimers.join(", ")}`);
}

const forbidden = /ai-trends-2026|automotive-industry|semiconductor-industry|AI Trends in 2026|Automotive Industry|Semiconductor Industry/i;
for (const relative of manifest.dependentFiles ?? []) {
  assertRelative(relative, "manifest dependent file");
  if (forbidden.test(await readFile(targetPath(relative), "utf8"))) {
    throw new Error(`${relative} still references a removed primer`);
  }
}

if (changed.length === 0) {
  process.stdout.write("limited industry bundle is already current\n");
} else if (CHECK) {
  process.stderr.write(`limited industry bundle needs updates:\n${changed.map((file) => `  ${file}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`updated limited industry bundle:\n${changed.map((file) => `  ${file}`).join("\n")}\n`);
}
