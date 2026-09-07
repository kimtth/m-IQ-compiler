import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog } from "../packages/core/src/audit/audit-log.js";
import { ensureAppPaths, resolveAppPaths } from "../packages/core/src/config/paths.js";
import { KnowledgeGraphService } from "../packages/core/src/knowledge/knowledge-graph.js";
import { KnowledgeVault } from "../packages/core/src/knowledge/vault.js";
import { createLogger } from "../packages/core/src/util/logger.js";

/**
 * The vault is the graph's corpus root, kept separate from the project the
 * agent writes into. These cover the three properties that matter: the default
 * is the project, a chosen vault is what gets indexed, and the app's own
 * state root can never become the corpus.
 */
describe("KnowledgeVault", () => {
  const roots: string[] = [];

  const harness = async () => {
    const root = await mkdtemp(join(tmpdir(), "iq-vault-"));
    roots.push(root);
    const paths = resolveAppPaths(root);
    ensureAppPaths(paths);
    const audit = new AuditLog(paths);
    const logger = createLogger("error", {});
    const vault = new KnowledgeVault({ paths, audit, logger, correlationId: () => "cid" });
    await vault.init();

    const bundled = join(root, "bundled-skills");
    await mkdir(bundled, { recursive: true });
    const knowledge = new KnowledgeGraphService({
      paths,
      audit,
      logger,
      vaultDir: () => vault.root(),
    });
    return { paths, vault, knowledge, root };
  };

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it("falls back to the project until a vault is chosen", async () => {
    const { paths, vault } = await harness();
    const state = await vault.current();
    expect(state.isDefault).toBe(true);
    expect(state.directory).toBe(paths.project);
    expect(vault.root()).toBe(paths.project);
  });

  it("indexes the chosen vault rather than the project", async () => {
    const { paths, vault, knowledge, root } = await harness();
    await writeFile(join(paths.project, "scratch.md"), "# Agent scratch output\n", "utf8");

    const notes = join(root, "notes-vault");
    await mkdir(notes, { recursive: true });
    await writeFile(join(notes, "plan.md"), "# Plan\n\nLinks to [[scratch]] #q3\n", "utf8");

    await vault.set(notes);
    await knowledge.reindex("cid");
    const graph = await knowledge.current();

    const paths_ = graph.nodes.filter((node) => node.kind === "document").map((node) => node.path);
    expect(paths_).toContain("plan.md");
    expect(paths_).not.toContain("scratch.md");
  });

  it("ingests source files into notes, and never over a note it did not write", async () => {
    const { vault, knowledge, root } = await harness();
    const notes = join(root, "notes-vault");
    await mkdir(notes, { recursive: true });
    await vault.set(notes);

    // A note somebody wrote, at exactly the path an ingested source wants.
    await writeFile(join(notes, "quarter.md"), "# Quarter\n\nWritten by hand.\n", "utf8");
    await mkdir(join(vault.sourceDirectory), { recursive: true });
    await writeFile(
      join(vault.sourceDirectory, "quarter.md"),
      "# Quarter\n\nRelease 26.1 shipped. Halbert Auth owe a tagged SDK.\n",
      "utf8",
    );
    await writeFile(
      join(vault.sourceDirectory, "halbert-auth.md"),
      "# Halbert Auth\n\nSole maintainer of the token refresh library.\n",
      "utf8",
    );

    const result = await vault.ingest();
    expect(result.sources).toBe(2);
    expect(result.generated).toBe(2);

    // The hand-written note is untouched; the ingested one stepped aside.
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(notes, "quarter.md"), "utf8")).toContain("Written by hand.");
    const moved = await readFile(join(notes, "quarter-ingested.md"), "utf8");
    expect(moved).toContain("generated_by: iq-compiler-ingest");

    // Ingest wrote Obsidian, not a copy: frontmatter, a callout, and a link it
    // found because one source names the other.
    expect(moved).toContain("> [!abstract]");
    expect(moved).toContain("[[Halbert Auth]]");

    // And the raw sources are not in the graph — only the notes made from them.
    await knowledge.reindex("cid");
    const graph = await knowledge.current();
    const indexed = graph.nodes.filter((node) => node.kind === "document").map((node) => node.path);
    expect(indexed).toContain("quarter-ingested.md");
    expect(indexed.some((path) => path.startsWith("source/"))).toBe(false);
  });

  it("returns to the project when the vault is cleared", async () => {
    const { paths, vault, root } = await harness();
    const notes = join(root, "notes-vault");
    await mkdir(notes, { recursive: true });

    await vault.set(notes);
    expect((await vault.current()).isDefault).toBe(false);

    const cleared = await vault.set(null);
    expect(cleared.isDefault).toBe(true);
    expect(cleared.directory).toBe(paths.project);
  });

  it("refuses a directory that contains the app's own state", async () => {
    const { vault, root } = await harness();
    await expect(vault.set(root)).rejects.toThrow(/own state/);
  });

  it("refuses a path that is not an existing directory", async () => {
    const { vault, root } = await harness();
    await expect(vault.set(join(root, "nope"))).rejects.toThrow(/does not exist/);
    await expect(vault.set("relative/path")).rejects.toThrow(/absolute/);
  });
});
