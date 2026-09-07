import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuditLog,
  KnowledgeGraphService,
  buildGraph,
  createLogger,
  ensureAppPaths,
  parseArtifact,
  resolveAppPaths,
  type Artifact,
} from "@iq/core";

const artifact = (over: Partial<Artifact> & Pick<Artifact, "path" | "text">): Artifact => ({
  kind: "document",
  sizeBytes: over.text.length,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("parseArtifact", () => {
  it("takes the title from the first heading and ignores frontmatter", () => {
    const parsed = parseArtifact(
      artifact({ path: "notes/a.md", text: "---\nname: ignored\n---\n\n# Real title\n\nBody." }),
    );
    expect(parsed.title).toBe("Real title");
    expect(parsed.excerpt).not.toContain("ignored");
  });

  it("collects wiki-links, relative Markdown links and tags", () => {
    const parsed = parseArtifact(
      artifact({
        path: "notes/a.md",
        text: "See [[Plan]] and [b](./b.md) #project #q3 — heading marks are not tags.\n\n## Not a tag",
      }),
    );
    expect(parsed.links).toContain("Plan");
    expect(parsed.links).toContain("./b.md");
    expect(parsed.tags).toEqual(["project", "q3"]);
  });

  it("ignores absolute URLs, which belong to the browser pane", () => {
    const parsed = parseArtifact(
      artifact({ path: "a.md", text: "[docs](https://learn.microsoft.com/x)" }),
    );
    expect(parsed.links).toHaveLength(0);
  });

  it("reads tags and aliases declared in frontmatter", () => {
    const parsed = parseArtifact(
      artifact({
        path: "notes/a.md",
        text: "---\ntitle: A\ntags:\n  - Project\n  - '#q3'\naliases:\n  - Alpha Plan\n  - AP\n---\n\n# A\n\nBody.",
      }),
    );
    expect(parsed.tags).toEqual(["project", "q3"]);
    expect(parsed.aliases).toEqual(["Alpha Plan", "AP"]);
  });

  it("accepts the comma-separated scalar form of tags and aliases", () => {
    const parsed = parseArtifact(
      artifact({ path: "a.md", text: "---\ntags: project, q3\naliases: Alpha\n---\n\nBody." }),
    );
    expect(parsed.tags).toEqual(["project", "q3"]);
    expect(parsed.aliases).toEqual(["Alpha"]);
  });

  it("survives malformed frontmatter rather than failing the index", () => {
    const parsed = parseArtifact(
      artifact({ path: "a.md", text: "---\ntags: [unclosed\n---\n\n# Title" }),
    );
    expect(parsed.tags).toEqual([]);
    expect(parsed.title).toBe("Title");
  });

  it("flattens a canvas into its prose and its file references", () => {
    const canvas = JSON.stringify({
      nodes: [
        { id: "1", type: "text", x: 0, y: 0, width: 1, height: 1, text: "# Board\n\n#project [[Plan]]" },
        { id: "2", type: "file", x: 0, y: 0, width: 1, height: 1, file: "notes/status.md#Decisions" },
        { id: "3", type: "link", x: 0, y: 0, width: 1, height: 1, url: "https://example.com" },
        { id: "4", type: "group", x: 0, y: 0, width: 1, height: 1, label: "Overview" },
      ],
      edges: [],
    });
    const parsed = parseArtifact(artifact({ path: "boards/a.canvas", text: canvas }));

    expect(parsed.title).toBe("Board");
    expect(parsed.tags).toEqual(["project"]);
    expect(parsed.links).toContain("notes/status.md");
    expect(parsed.links).toContain("Plan");
    // A link node points outside the vault, so it is not a graph edge.
    expect(parsed.links).not.toContain("https://example.com");
    expect(parsed.excerpt).toContain("Overview");
  });

  it("falls back to plain text when a .canvas file is not valid canvas JSON", () => {
    const parsed = parseArtifact(artifact({ path: "a.canvas", text: "not json [[Plan]]" }));
    expect(parsed.links).toEqual(["Plan"]);
  });
});

describe("buildGraph", () => {
  it("resolves a wiki-link by title, file name or path", () => {
    const graph = buildGraph({
      artifacts: [
        artifact({ path: "notes/plan.md", text: "# Plan\n\nSee [[status]] and [[notes/status.md]]." }),
        artifact({ path: "notes/status.md", text: "# Status" }),
      ],
    });

    const links = graph.edges.filter((edge) => edge.kind === "links");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      from: "document:notes/plan.md",
      to: "document:notes/status.md",
      // Two spellings of the same target collapse into one weighted edge.
      weight: 2,
    });
  });

  it("records an unresolved link as a missing node rather than dropping it", () => {
    const graph = buildGraph({
      artifacts: [artifact({ path: "a.md", text: "# A\n\n[[nowhere]]" })],
    });
    expect(graph.nodes.find((node) => node.kind === "missing")?.title).toBe("nowhere");
  });

  it("links a document to a skill it references", () => {
    const graph = buildGraph({
      artifacts: [
        artifact({ path: "a.md", text: "# A\n\nRun [[mail-triage]]." }),
        { kind: "skill", path: "mail-triage", text: "# Mail triage", sizeBytes: 10, updatedAt: "" },
      ],
    });
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ from: "document:a.md", to: "skill:mail-triage", kind: "uses_skill" }),
    );
  });

  it("counts degree on both ends and makes tags into nodes", () => {
    const graph = buildGraph({
      artifacts: [
        artifact({ path: "a.md", text: "# A\n\n#shared [[b]]" }),
        artifact({ path: "b.md", text: "# B\n\n#shared" }),
      ],
    });
    const tag = graph.nodes.find((node) => node.id === "tag:shared");
    expect(tag?.degree).toBe(2);
    expect(graph.nodes.find((node) => node.id === "document:b.md")?.degree).toBe(2);
  });

  it("resolves a wiki-link written against a frontmatter alias", () => {
    const graph = buildGraph({
      artifacts: [
        artifact({ path: "a.md", text: "# A\n\nSee [[Alpha Plan]]." }),
        artifact({
          path: "notes/plan-2026.md",
          text: "---\naliases:\n  - Alpha Plan\n---\n\n# Plan 2026",
        }),
      ],
    });
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        from: "document:a.md",
        to: "document:notes/plan-2026.md",
        kind: "links",
      }),
    );
    expect(graph.nodes.some((node) => node.kind === "missing")).toBe(false);
  });

  it("is deterministic for the same input", () => {
    const input = {
      artifacts: [artifact({ path: "a.md", text: "# A\n\n[[b]] #t" }), artifact({ path: "b.md", text: "# B" })],
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    };
    expect(JSON.stringify(buildGraph(input))).toBe(JSON.stringify(buildGraph(input)));
  });
});

describe("KnowledgeGraphService", () => {
  const roots: string[] = [];

  const service = async (): Promise<{ service: KnowledgeGraphService; project: string; skills: string }> => {
    const root = await mkdtemp(join(tmpdir(), "iq-knowledge-"));
    roots.push(root);
    const paths = resolveAppPaths(root);
    ensureAppPaths(paths);
    const bundled = join(root, "bundled-skills");
    await mkdir(bundled, { recursive: true });

    return {
      service: new KnowledgeGraphService({
        paths,
        audit: new AuditLog(paths),
        logger: createLogger("error", {}),
      }),
      project: paths.project,
      skills: bundled,
    };
  };

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it("indexes the vault and nothing else — not the app's own skills", async () => {
    const { service: knowledge, project, skills } = await service();
    await mkdir(join(project, "notes"), { recursive: true });
    await writeFile(
      join(project, "notes", "quarter.md"),
      "# Quarterly plan\n\nMigrate the tenant to [[mail-triage]] #q3\n",
      "utf8",
    );
    await mkdir(join(skills, "mail-triage"), { recursive: true });
    await writeFile(
      join(skills, "mail-triage", "SKILL.md"),
      "---\nname: mail-triage\ndescription: Triage mail\n---\n\nSort the inbox.\n",
      "utf8",
    );

    const summary = await knowledge.reindex("cor-1");
    expect(summary.documents).toBe(1);

    // A skill is a procedure the agent loads, not a document the user curated.
    // Indexing them put the app's own furniture in every picture of a vault.
    expect(summary.skills).toBe(0);
    expect(await knowledge.node("skill:mail-triage", "cor-4")).toBeNull();

    const hits = await knowledge.search("quarterly", 10, "cor-2");
    expect(hits[0]?.id).toBe("document:notes/quarter.md");

    const detail = await knowledge.node("document:notes/quarter.md", "cor-3");
    expect(detail?.content).toContain("Migrate the tenant");
    // The link is still an edge — to a `missing` node, which is exactly what
    // Obsidian shows for a link with nothing behind it.
    expect(detail?.outgoing.map((edge) => edge.node.kind)).toContain("missing");
  });

  it("indexes Obsidian vault formats and links a canvas to the note it embeds", async () => {
    const { service: knowledge, project } = await service();
    await writeFile(join(project, "status.md"), "# Status\n\nOn track.\n", "utf8");
    await writeFile(
      join(project, "board.canvas"),
      JSON.stringify({
        nodes: [
          { id: "1", type: "text", x: 0, y: 0, width: 1, height: 1, text: "# Board" },
          { id: "2", type: "file", x: 0, y: 0, width: 1, height: 1, file: "status.md" },
        ],
        edges: [],
      }),
      "utf8",
    );
    await writeFile(
      join(project, "projects.base"),
      "filters:\n  - 'file.hasTag(\"project\")'\nviews:\n  - type: table\n",
      "utf8",
    );

    const summary = await knowledge.reindex("cor-1");
    expect(summary.documents).toBe(3);

    const canvas = await knowledge.node("document:board.canvas", "cor-2");
    expect(canvas?.outgoing.map((edge) => edge.node.id)).toContain("document:status.md");
    expect(await knowledge.node("document:projects.base", "cor-3")).not.toBeNull();
  });

  it("requires every search term to match", async () => {
    const { service: knowledge, project } = await service();
    await writeFile(join(project, "a.md"), "# Alpha\n\nBudget planning.\n", "utf8");
    await knowledge.reindex("cor-1");

    expect(await knowledge.search("budget", 10, "cor-2")).toHaveLength(1);
    expect(await knowledge.search("budget nonexistentword", 10, "cor-3")).toHaveLength(0);
  });

  it("indexes once per process, even when the corpus is empty", async () => {
    const { service: knowledge } = await service();

    // The empty case is the one that broke. `ensureIndexed` asked whether any
    // text had been collected, which is false for an empty vault however many
    // times it has been scanned — so every read rebuilt, every rebuild
    // published `knowledge:changed`, the UI reloaded on the event and read
    // again. An empty vault span the app at full tilt.
    const first = await knowledge.ensureIndexed("cor-1");
    expect(first.nodes).toEqual([]);
    const builtAt = first.builtAt;
    expect(builtAt).not.toBe("");

    for (let i = 0; i < 5; i += 1) {
      const again = await knowledge.ensureIndexed(`cor-${i + 2}`);
      expect(again.builtAt).toBe(builtAt);
    }
  });

  it("skips unsupported file types and hidden directories", async () => {
    const { service: knowledge, project } = await service();
    await writeFile(join(project, "keep.md"), "# Keep\n", "utf8");
    await writeFile(join(project, "ignore.exe"), "MZ", "utf8");
    await mkdir(join(project, ".hidden"), { recursive: true });
    await writeFile(join(project, ".hidden", "secret.md"), "# Secret\n", "utf8");

    const summary = await knowledge.reindex("cor-1");
    expect(summary.documents).toBe(1);
    expect((await knowledge.current()).nodes.map((node) => node.id)).toEqual(["document:keep.md"]);
  });

  it("never follows a symlink out of the project", async () => {
    const { service: knowledge, project } = await service();
    const outside = await mkdtemp(join(tmpdir(), "iq-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "private.md"), "# Private\n\ncredentials\n", "utf8");
    await writeFile(join(project, "note.md"), "# Note\n", "utf8");

    try {
      await symlink(outside, join(project, "escape"), "dir");
    } catch {
      return; // Unprivileged Windows cannot create links; the guard is unit-tested above.
    }

    await knowledge.reindex("cor-1");
    const ids = (await knowledge.current()).nodes.map((node) => node.id);
    expect(ids).toEqual(["document:note.md"]);
    expect(await knowledge.search("credentials", 10, "cor-2")).toHaveLength(0);
  });

  it("persists the graph so a fresh service loads it without rescanning", async () => {
    const { service: knowledge, project } = await service();
    await writeFile(join(project, "a.md"), "# Alpha\n", "utf8");
    await knowledge.reindex("cor-1");

    const paths = resolveAppPaths(join(project, ".."));
    const reopened = new KnowledgeGraphService({
      paths,
      audit: new AuditLog(paths),
      logger: createLogger("error", {}),
    });
    expect((await reopened.current()).nodes.map((node) => node.id)).toEqual(["document:a.md"]);
  });
});
