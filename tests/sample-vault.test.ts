import { describe, expect, it } from "vitest";
import { buildGraph, parseArtifact, type Artifact } from "../packages/core/src/knowledge/indexer.js";
import { SAMPLE_VAULT_NOTES } from "../packages/core/src/samples/vault.js";
import { SAMPLE_MEMORIES } from "../packages/core/src/samples/memories.js";

/**
 * The demo vault is the answer to "where does the graph come from?", so the
 * thing worth testing is not that it has notes in it but that the notes are
 * genuinely Obsidian-shaped: frontmatter that parses, aliases that resolve, and
 * links that land somewhere. A vault whose links all dangle draws a picture of
 * unresolved targets, which is the opposite of the point.
 */

const artifacts = (): Artifact[] =>
  SAMPLE_VAULT_NOTES.map((note) => ({
    kind: "document" as const,
    path: note.path,
    text: note.text,
    sizeBytes: Buffer.byteLength(note.text, "utf8"),
    updatedAt: "2026-07-30T00:00:00.000Z",
  }));

/** Read a note exactly as the indexer reads it, frontmatter included. */
const parse = (note: (typeof SAMPLE_VAULT_NOTES)[number]) =>
  parseArtifact({
    kind: "document",
    path: note.path,
    text: note.text,
    sizeBytes: Buffer.byteLength(note.text, "utf8"),
    updatedAt: "2026-07-30T00:00:00.000Z",
  });

describe("sample knowledge vault", () => {
  it("writes one Markdown file per note, at unique paths", () => {
    const paths = SAMPLE_VAULT_NOTES.map((note) => note.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.every((path) => path.endsWith(".md"))).toBe(true);
    // Relative and POSIX: the installer splits on "/" to build the directory.
    expect(paths.some((path) => path.startsWith("/") || path.includes("\\"))).toBe(false);
  });

  it("is dense enough to have a shape, and small enough to draw", () => {
    // A graph is only worth looking at when there is a shape to see, and a
    // shape needs a few hundred links. A band rather than exact counts, so
    // editing the vault does not fail this for a reason nobody cares about.
    //
    // The ceiling matters as much as the floor: at 220 notes the force layout
    // ran long enough to be felt on every visit, and a demo that stutters
    // teaches the reader that the surface is slow.
    expect(SAMPLE_VAULT_NOTES.length).toBeGreaterThan(90);
    expect(SAMPLE_VAULT_NOTES.length).toBeLessThan(130);
    const graph = buildGraph({ artifacts: artifacts() });
    expect(graph.edges.length).toBeGreaterThan(300);
  });

  it("carries the frontmatter an Obsidian vault carries", () => {
    for (const note of SAMPLE_VAULT_NOTES) {
      expect(note.text.startsWith("---\n")).toBe(true);
      expect(note.text).toContain("category: ");
      // Tags declared in frontmatter are as real as an inline #tag, and these
      // notes declare them there rather than as a line of hashtags.
      expect(parse(note).tags.length).toBeGreaterThan(0);
    }

    // Aliases are not decoration: some notes are linked to through them, and a
    // vault without one never exercises that path.
    const aliased = SAMPLE_VAULT_NOTES.filter((note) => parse(note).aliases.length > 0);
    expect(aliased.length).toBeGreaterThan(5);
  });

  it("reads as prose, not as a list of links", () => {
    for (const note of SAMPLE_VAULT_NOTES) {
      expect(note.text).toContain("> [!abstract]");
      expect(note.text).toContain("## Connected concepts");
      // At least one wikilink written inside a sentence rather than a bullet.
      expect(/[a-z] \[\[[^\]]+\]\]/.test(note.text)).toBe(true);
    }
  });

  it("resolves every link it writes", () => {
    const graph = buildGraph({ artifacts: artifacts() });
    const missing = graph.nodes.filter((node) => node.kind === "missing");

    // A dangling link is a legitimate thing for the graph to show — it is what
    // Obsidian shows — but a demo vault full of them teaches the reader that
    // the index cannot find things, which is not what is being demonstrated.
    expect(missing.map((node) => node.title)).toEqual([]);
  });

  it("backs the citations the sample memories make", () => {
    const paths = new Set(SAMPLE_VAULT_NOTES.map((note) => note.path));
    const cited = SAMPLE_MEMORIES.flatMap((memory) => memory.citations).filter((citation) =>
      citation.startsWith("knowledge/"),
    );

    expect(cited.length).toBeGreaterThan(0);
    for (const citation of cited) {
      // The memory pane shows the citation as the memory's source. If the note
      // is not in the vault the samples install, the source is a dead end.
      expect(paths.has(citation.replace(/^knowledge\//, ""))).toBe(true);
    }
  });
});
