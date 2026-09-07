import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IQ_CELL_ORIGIN_LABELS, IqCellOrigin, SUB_MODES, SUB_MODES_BY_MODE } from "@iq/shared";

/**
 * IQ Industry: the bundled domain primers.
 *
 * The surface itself is renderer code and is driven end to end in
 * `tests/e2e/iq-industry.e2e.ts`. What is pinned here is everything a unit test
 * can honestly reach: that the set is placed in the mode registry, that the
 * files it claims to bundle are actually on disk in the shape it parses, and
 * that the origin it publishes under exists.
 *
 * The `?raw` imports mean the catalogue module cannot be loaded outside Vite,
 * so the files are read from disk here rather than through it. That is the
 * honest boundary: this asserts the *material* is right, and the e2e asserts
 * the surface reads it.
 */

const PRIMER_DIR = join(
  import.meta.dirname,
  "..",
  "apps",
  "renderer",
  "src",
  "industry",
  "primers",
);

const EXPECTED = [
  "it-consulting-industry.md",
  "software-industry.md",
];

describe("IQ Industry is placed", () => {
  it("leads the inputs to My IQ, ahead of IQ Workflow", () => {
    // My IQ is what the mode produces and takes the first slot, which is also
    // the mode's default landing. Everything after it is material My IQ is
    // compiled from, and "read the domain, then compose for it" is the order
    // those are in.
    expect(SUB_MODES_BY_MODE.flow[0]).toBe("connectome");
    expect(SUB_MODES_BY_MODE.flow[1]).toBe("industry");
    expect(SUB_MODES_BY_MODE.flow).toContain("flow");
    expect(SUB_MODES_BY_MODE.flow.indexOf("industry")).toBeLessThan(
      SUB_MODES_BY_MODE.flow.indexOf("flow"),
    );
  });

  it("belongs to IQ Cell and needs no project", () => {
    expect(SUB_MODES.industry.mode).toBe("flow");
    expect(SUB_MODES.industry.label).toBe("IQ Industry");
    // Nothing on it reads the filesystem or calls a model, so it must not be
    // gated on a project the reader has no reason to have bound yet.
    expect(SUB_MODES.industry.requiresProject).toBe(false);
  });

  it("can compile IQ Cells, and the library can name where they came from", () => {
    expect(IqCellOrigin.options).toContain("industry");
    expect(IQ_CELL_ORIGIN_LABELS.industry).toBe("IQ Industry");
  });
});

describe("the bundled primers", () => {
  it("ships exactly the primers it claims to", () => {
    expect(readdirSync(PRIMER_DIR).sort()).toEqual(EXPECTED);
  });

  it.each(EXPECTED)("%s carries the frontmatter the catalogue parses", (name) => {
    const markdown = readFileSync(join(PRIMER_DIR, name), "utf8");
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? "";

    // `title` and `category` are what the list shows and groups by. A primer
    // missing either would render as its own filename under "Uncategorised",
    // which reads as a broken list rather than as a missing field.
    expect(front).toMatch(/^title:\s*\S/m);
    expect(front).toMatch(/^category:\s*\S/m);
  });

  it.each(EXPECTED)("%s opens with the abstract the list summarises", (name) => {
    const markdown = readFileSync(join(PRIMER_DIR, name), "utf8");
    // The summary is taken from the callout, never from the first paragraph:
    // these documents open with a heading, so "first paragraph" is the title in
    // some files and the abstract in others, and a list where half the rows
    // repeat their own title reads as broken.
    expect(markdown).toMatch(/^>\s*\[!\w+\]/m);
  });

  it("uses only the markdown the viewer renders", () => {
    // The renderer is deliberately narrow — headings, paragraphs, lists,
    // tables, callouts, fences, rules and inline spans. Raw HTML and images
    // would be dropped silently, so a primer that starts using them has to
    // fail here rather than render as a hole in the page.
    for (const name of EXPECTED) {
      const markdown = readFileSync(join(PRIMER_DIR, name), "utf8");
      expect(markdown, `${name} contains an image`).not.toMatch(/!\[[^\]]*\]\(/);
      expect(markdown, `${name} contains raw HTML`).not.toMatch(/^<[a-zA-Z]/m);
    }
  });
});
