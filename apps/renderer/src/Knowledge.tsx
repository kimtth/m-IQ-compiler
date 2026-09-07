import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText, Library, Package, Plus, Trash2 } from "lucide-react";
import type {
  GraphNode,
  KnowledgeGraph,
  KnowledgeHit,
  KnowledgeNodeDetail,
  KnowledgeSource,
  KnowledgeSummary,
  KnowledgeVaultState,
} from "@iq/shared";
import { call, callAs, subscribe } from "./bridge.js";
import { Modal } from "./Modal.js";
import { useSamples } from "./samples/index.js";
import { stepLabel, useStepProgress } from "./flow/useStepProgress.js";
import { GraphView } from "./knowledge/GraphView.js";
import { useAction } from "./useAction.js";

/**
 * Knowledge panel.
 *
 * An Obsidian-style view of the local project: notes and skills as nodes,
 * links and tags as edges. The picture itself is `knowledge/GraphView`; this
 * file owns the vault controls, the search, the table and the detail panel.
 */

/** Where each kind of node came from, stated plainly rather than implied. */
const KIND_PROVENANCE: Record<string, string> = {
  document: "Read from a note in the indexed vault directory.",
  tag: "Derived from #tags found in indexed notes.",
  missing: "A link target that does not resolve to anything indexed.",
};

/** What one ingest did, as the privileged side reports it. */
interface IngestResult {
  sources: number;
  generated: number;
  removed: number;
  unreadable: string[];
  converterHint: string;
  summary: KnowledgeSummary;
  vault: KnowledgeVaultState;
}

export interface KnowledgeProps {
  onError: (problem: unknown) => void;
  /**
   * Reveal a node's source in the project navigator and open it in the
   * canvas. The graph deliberately does not become a third file browser.
   */
  onRevealSource?: (path: string) => void;
  /**
   * A node to select on arrival, sent by the IQ Cell library when a knowledge
   * cell is opened. Null is the ordinary case: the index itself.
   */
  focusNodeId?: string | null;
}

export function Knowledge({
  onError,
  onRevealSource,
  focusNodeId = null,
}: KnowledgeProps): JSX.Element {
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [summary, setSummary] = useState<KnowledgeSummary | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [selected, setSelected] = useState<KnowledgeNodeDetail | null>(null);
  const [view, setView] = useState<"graph" | "table">("graph");
  const { busy, run, attempt } = useAction(onError);
  const samples = useSamples();
  const [vault, setVault] = useState<KnowledgeVaultState | null>(null);
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Whether a graph has been asked for.
   *
   * The surface used to draw one on arrival, from whatever index happened to
   * be on disk. That is a picture nobody requested, built from notes that may
   * be a week out of date, and it made the control that would have refreshed
   * it look like a maintenance chore rather than the thing that makes the
   * picture. Build the index is what makes a graph now, so the graph is
   * current by construction and appears because someone asked.
   */
  const [built, setBuilt] = useState(false);
  const building = useStepProgress();

  /** The vault card and the file lists, which are about the corpus, not the graph. */
  const loadVault = useCallback(async () => {
    await attempt(async () => {
      setVault(await call("knowledge:vault"));
      setSources(await call("knowledge:sources"));
    });
  }, [attempt]);

  const load = useCallback(async () => {
    await attempt(async () => {
      const result = await call("knowledge:graph",
      );
      setGraph(result.graph);
      setSummary(result.summary);
      await loadVault();
    });
  }, [attempt, loadVault]);

  useEffect(() => {
    void loadVault();
    // Only refresh a graph that exists. Subscribing to rebuild one that was
    // never asked for is how the surface came to draw itself on arrival.
    return subscribe<KnowledgeSummary>("knowledge:changed", () => {
      if (built) void load();
      else void loadVault();
    });
  }, [built, load, loadVault]);

  /**
   * Ingest: sources in `source/` become notes, then the graph is rebuilt.
   *
   * No longer a control of its own. Rebuilding an index over a folder of
   * reports and spreadsheets draws a scattering of dots, because raw files do
   * not link to each other; the notes that link are written *from* them. So
   * ingesting is not an optional tidy-up before drawing a graph, it is the
   * first half of drawing one — and it is now the first step of building the
   * index rather than a chore the reader had to know to do first.
   */

  /** Copy files into the vault's `source/`, ready to be ingested. */
  const addSources = async (): Promise<void> => {
    await run(async () => {
      const result = await call("knowledge:addSources",
      );
      setVault(result.vault);
      setSources(await call("knowledge:sources"));
      if (result.added === 0 && result.skipped === 0) return;
      setNotice(
        `Copied ${result.added} ${result.added === 1 ? "file" : "files"} into ${result.vault.sourceDirectory}` +
          `${result.skipped > 0 ? `, and skipped ${result.skipped} that were not plain files` : ""}. ` +
          "Select Build the index to turn them into notes. The originals were not moved.",
      );
    });
  };

  /**
   * Delete one source file.
   *
   * The note it produced stays until the next ingest, which is deliberate: the
   * graph should change when someone asks it to, not underneath them.
   */
  const removeSource = async (path: string): Promise<void> => {
    if (!window.confirm(`Delete ${path} from the vault's source folder?`)) return;
    await attempt(async () => {
      const result = await call("knowledge:removeSource", { path });
      setSources(result.sources);
      setNotice(
        `Deleted ${path}. Its note is still in the vault until the next Ingest, which is when it goes.`,
      );
    });
  };

  /**
   * Choose the vault directory.
   *
   * The dialog lives in main, so the renderer never sees a path it did not get
   * back from a user action. Setting it reindexes, because the cached graph
   * describes the previous root.
   */
  const chooseVault = async (): Promise<void> => {
    await run(async () => {
      const chosen = await call("knowledge:chooseVault");
      if (!chosen.directory) return;
      const result = await call("knowledge:setVault",
        { directory: chosen.directory },
      );
      setVault(result.vault);
      setSummary(result.summary);
      await load();
    });
  };

  const resetVault = async (): Promise<void> => {
    await run(async () => {
      const result = await call("knowledge:setVault",
        { directory: null },
      );
      setVault(result.vault);
      setSummary(result.summary);
      await load();
    });
  };

  /**
   * Write the demo vault and index it.
   *
   * A knowledge graph is a consequence of Markdown files, so there is nothing
   * to show until some exist. On a fresh install no vault has been chosen and
   * the project fallback holds whatever the agent last wrote, which draws as
   * nothing — leaving the one surface whose whole point is a picture with no
   * picture in it. The notes are written into the app's own samples directory,
   * not into anybody's project, and can be opened and read like any vault.
   */
  const loadSamples = async (): Promise<void> => {
    await run(async () => {
      // The hub writes the vault and reindexes; this surface reloads what it
      // shows rather than being handed a vault state it would then have to keep
      // in step with the one the hub already published.
      setNotice(await samples.load("knowledge"));
      await load();
    });
  };

  /** Delete the demo vault. Only ever the app's own samples directory. */
  const clearSamples = async (): Promise<void> => {
    await run(async () => {
      setNotice(await samples.clear("knowledge"));
      setSelected(null);
      await load();
    });
  };

  const search = async (): Promise<void> => {
    if (query.trim().length < 2) {
      setHits(null);
      return;
    }
    await attempt(async () => {
      setHits(await call("knowledge:search", { query: query.trim(), limit: 20 }));
    });
  };

  const open = useCallback(
    async (id: string): Promise<void> => {
      await attempt(async () => {
        setSelected(await call("knowledge:node", { id }));
      });
    },
    [attempt],
  );

  /**
   * Select the node the IQ Cell library asked for.
   *
   * Keyed on the id rather than run once: switching back to a tab that already
   * exists does not remount it, so a mount-time read would silently ignore the
   * second request. A node that no longer exists resolves to nothing and leaves
   * the index selected, which is the honest fallback.
   */
  useEffect(() => {
    if (focusNodeId === null || focusNodeId === "") return;
    void open(focusNodeId);
  }, [focusNodeId, open]);

  /**
   * Build the index: ingest the sources, then draw the graph from them.
   *
   * One control, because it is one intent. Ingest used to be its own button
   * beside it, and the graph was drawn on arrival from whatever index happened
   * to be on disk — so the surface opened on a picture nobody had asked for,
   * built from notes that might be a week out of date, and the button that
   * would have refreshed it looked like a maintenance chore. The graph now
   * appears because someone asked for it, and it is current by construction.
   *
   * The steps are named because they are not instant and they are not
   * equivalent: the first reads the user's own files.
   *
   * It no longer publishes an IQ Cell. IQ Cells are drawn in IQ Workflow and
   * published there; a surface that quietly produced one as a side effect of
   * indexing was filing a record nobody had asked for, describing work nobody
   * had described.
   */
  const build = (): void => {
    void attempt(async () => {
      let ingested: IngestResult | null = null;

      await building.run([
        {
          label: "Reading the sources",
          run: async () => {
            ingested = await callAs<IngestResult>("knowledge:ingest");
            setSummary(ingested.summary);
            setVault(ingested.vault);
          },
        },
        { label: "Building the graph", run: async () => load() },
      ]);

      setBuilt(true);
      const done = ingested as IngestResult | null;
      if (done !== null) {
        setNotice(
          done.sources === 0
            ? "Nothing in the vault's source folder, so the graph was built from the notes already there. Add files to put something in it."
            : `Ingested ${done.sources} source ${done.sources === 1 ? "file" : "files"} into ` +
              `${done.generated} Obsidian ${done.generated === 1 ? "note" : "notes"}` +
              `${done.removed > 0 ? `, and removed ${done.removed} whose source is gone` : ""}. ` +
              "The notes are in the vault root and the raw files stay in source/, which is never indexed." +
              // The specific next step, not a generic "a converter is needed":
              // whether one is absent or merely unapproved are different fixes.
              (done.converterHint === ""
                ? ""
                : ` ${done.unreadable.length} could not be read — ${done.converterHint}`),
        );
      }
    });
  };

  return (
    <>
      <div className="pane-header">
        <span className="pane-title">IQ Knowledge</span>
        <span className="muted">
          {summary
            ? `${summary.documents} notes · ${summary.tags} tags · ${summary.edges} links`
            : "Local vault artifacts"}
        </span>
        <div className="spacer" />
        {/* Two views over one index. There is no third file browser here — the
            project navigator is the file view. */}
        <button
          className={view === "graph" ? "primary" : "subtle"}
          onClick={() => setView("graph")}
        >
          Graph
        </button>
        <button
          className={view === "table" ? "primary" : "subtle"}
          onClick={() => setView("table")}
        >
          Table
        </button>
        <div style={{ width: 220 }}>
          <input
            placeholder="Search the vault"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void search();
            }}
          />
        </div>
        <button onClick={() => void search()}>Search</button>
        {/* One control, because it is one intent: read the sources, write the
            notes, build the graph. Ingest used to sit beside this as a second
            button, which made the thing that *makes* a graph read as a
            maintenance chore next to the thing that drew one. */}
        <button
          className="primary"
          disabled={building.busy}
          title="Turn the vault's source files into Obsidian notes and build the knowledge graph from them."
          onClick={build}
        >
          <Package size={14} aria-hidden="true" /> {stepLabel(building, "Build the index")}
        </button>
      </div>

      <div className="pane-body">
        {notice !== null && (
          <div className="notice" onClick={() => setNotice(null)} role="status">
            {notice} <span className="muted">(click to dismiss)</span>
          </div>
        )}
        {/* The corpus root, stated rather than implied: the graph indexes a
            curated vault, not the directory the agent writes into. */}
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 8 }}>
                <Library size={16} aria-hidden />
                <strong>
                  {vault?.isSamples
                    ? "Sample vault"
                    : vault?.isDefault
                      ? "Project (no vault chosen)"
                      : "Vault"}
                </strong>
                {vault && !vault.exists && <span className="pill warn">Missing</span>}
              </div>
              <div className="muted" style={{ marginTop: 4, wordBreak: "break-all" }}>
                {vault?.directory ?? "…"}
              </div>
              {/* The two halves, stated. Someone who has just chosen a folder
                  needs to know where to put their files, and that the raw ones
                  are not what the graph is built from. */}
              <div className="muted" style={{ marginTop: 4 }}>
                <code>source/</code> holds the raw files — {vault?.sources ?? 0} waiting, never
                indexed. Building the index turns them into notes in the vault root, and the
                graph is built from those.
              </div>
              <div className="muted" style={{ marginTop: 2 }}>
                {vault?.isSamples
                  ? "Generated demo notes, written by this app and safe to delete. Open one to see where the graph comes from: frontmatter tags and aliases, an abstract, connected concepts, and wikilinks through the prose."
                  : vault?.isDefault
                    ? "Indexing the project directory. Choose a vault to index a curated set of notes and media instead — or load the samples to see what one looks like."
                    : "Indexed read-only. Choosing a vault grants no write access; the agent's file boundary is still the project."}
              </div>
            </div>
            <div className="row" style={{ gap: 8, flexShrink: 0 }}>
              <button disabled={busy} onClick={() => void chooseVault()}>
                {vault?.isDefault ? "Choose vault…" : "Change vault…"}
              </button>
              <button
                disabled={busy}
                title="Copy files into the vault's source folder. The originals are not moved."
                onClick={() => void addSources()}
              >
                Add files…
              </button>
              {/* The demo vault is Markdown on disk, because that is what an
                  Obsidian-style graph is made of. Offering to delete it is not
                  a courtesy: 220 files nobody can remove is a mess. */}
              {vault?.isSamples ? (
                <button
                  className="subtle"
                  disabled={busy}
                  title="Delete the generated demo notes and go back to indexing the project."
                  onClick={() => void clearSamples()}
                >
                  Clear samples
                </button>
              ) : (
                // Offered only while sample data is on. Clear is always
                // offered: a vault already written has to be removable however
                // the flag now stands.
                samples.enabled && (
                  <button
                    className="subtle"
                    disabled={busy}
                    title="Write a generated Obsidian-style vault into the app's own samples directory and index it."
                    onClick={() => void loadSamples()}
                  >
                    Load samples
                  </button>
                )
              )}
              {vault && !vault.isDefault && !vault.isSamples && (
                <button className="subtle" disabled={busy} onClick={() => void resetVault()}>
                  Use project
                </button>
              )}
            </div>
          </div>
        </div>

        {summary?.truncated && (
          <div className="card">
            <span className="pill warn">Partial index</span>
            <span className="muted" style={{ marginLeft: 8 }}>
              The vault has more artifacts than the indexer will scan; the graph shows the
              first ones it found.
            </span>
          </div>
        )}

        {hits && (
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3>{hits.length} result(s)</h3>
              <button onClick={() => setHits(null)}>Clear</button>
            </div>
            {hits.map((hit) => (
              <div key={hit.id} style={{ marginTop: 10 }}>
                <button
                  style={{ background: "none", border: "none", padding: 0, color: "var(--accent)" }}
                  onClick={() => void open(hit.id)}
                >
                  {hit.title}
                </button>
                <div className="muted">
                  {hit.kind}
                  {hit.path ? ` · ${hit.path}` : ""} · score {hit.score}
                </div>
                <div className="muted" style={{ marginTop: 2 }}>
                  {hit.snippet}
                </div>
              </div>
            ))}
            {hits.length === 0 && <p className="muted">Nothing matched every term.</p>}
          </div>
        )}

        {/* The graph on the left, the files it was built from on the right.
            The picture answers "what is connected to what", and the list
            answers "what is actually in here" — a question the graph is bad at,
            because a node is a dot and a vault is a directory of Markdown. */}
        <div className="knowledge-split">
          <div className="knowledge-main">
            {!built ? (
              /* Nothing is drawn until it is asked for. The graph is the
                 *result* of building the index, not the state of the surface:
                 drawing one on arrival showed a picture built from whatever
                 notes happened to be on disk, which is a claim about the vault
                 that nobody made and that may be a week stale. */
              <div className="knowledge-empty">
                <strong>No graph yet</strong>
                <span className="muted">
                  Building the index reads the {sources.length} file
                  {sources.length === 1 ? "" : "s"} below, writes them out as Obsidian notes, and
                  builds the graph from the links between those notes.
                </span>

                {/* The sources themselves, before anything is read.
                    This is the one destructive-feeling action on this
                    surface: it writes notes into the vault and rebuilds the
                    index. Naming a count and leaving the reader to find the
                    files in a side panel asks them to authorise a read of
                    something they have not been shown — and the count is
                    exactly the part that looks right when the folder is
                    wrong. The list is what makes "these files, this vault"
                    checkable before the button is pressed. */}
                <SourcePreview sources={sources} directory={vault?.sourceDirectory ?? ""} />

                <button
                  className="primary"
                  disabled={building.busy || sources.length === 0}
                  title={
                    sources.length === 0
                      ? "There are no files in source/ to read"
                      : `Read ${sources.length} file${sources.length === 1 ? "" : "s"} and build the graph`
                  }
                  onClick={build}
                >
                  <Package size={14} aria-hidden="true" /> {stepLabel(building, "Build the index")}
                </button>
                {sources.length === 0 && (
                  <button className="link" disabled={busy} onClick={() => void addSources()}>
                    Add files to <code>source/</code> first
                  </button>
                )}
                {samples.enabled && (
                  <button className="link" disabled={busy} onClick={() => void loadSamples()}>
                    or load the sample vault first
                  </button>
                )}
              </div>
            ) : graph && graph.nodes.length > 0 ? (
              view === "graph" ? (
                <GraphView
                  graph={graph}
                  selectedId={selected?.node.id ?? null}
                  onSelect={(id) => void open(id)}
                />
              ) : (
                <NodeTable graph={graph} onSelect={(id) => void open(id)} />
              )
            ) : (
              <p className="muted">
                Nothing was indexed. Choose a vault and add files to its <code>source/</code>{" "}
                folder, then build the index again — or{" "}
                <button className="link" disabled={busy} onClick={() => void loadSamples()}>
                  load the sample vault
                </button>{" "}
                to see what a graph is made of.
              </p>
            )}
          </div>

          <div className="knowledge-side">
            <SourceFiles
              sources={sources}
              busy={busy}
              onAdd={() => void addSources()}
              onRemove={(path) => void removeSource(path)}
            />
            <VaultFiles
              graph={graph}
              selectedId={selected?.node.id ?? null}
              onSelect={(id) => void open(id)}
              {...(onRevealSource ? { onRevealSource } : {})}
            />
          </div>
        </div>

        {selected && (
          <NodeDetail
            detail={selected}
            builtAt={graph?.builtAt ?? ""}
            onOpen={(id) => void open(id)}
            onClose={() => setSelected(null)}
            {...(onRevealSource ? { onRevealSource } : {})}
          />
        )}
      </div>
    </>
  );
}

/**
 * What the index build is about to read, shown before it reads it.
 *
 * Distinct from the `Sources` side panel, which is a manager: it adds and
 * deletes files and is available at every point in the surface's life. This is
 * a manifest, and it exists only in the one state where nothing has been read
 * yet. The two answer different questions — "what is in the folder" against
 * "what is this button going to do" — and the second is the one a reader needs
 * in front of them when the button is the only thing on screen.
 *
 * Grouped by folder because that is the shape on disk, and because a source
 * tree with `reports/`, `data/` and `meetings/` in it is recognisably the
 * user's own; a flat list of forty names is not. Unreadable files are called
 * out here rather than after the fact: a PDF among plain text produces no note
 * unless MarkItDown is approved, and a graph that is quietly missing a third of
 * its corpus looks exactly like a graph that is complete.
 */
function SourcePreview({
  sources,
  directory,
}: {
  sources: readonly KnowledgeSource[];
  directory: string;
}): JSX.Element {
  const folders = new Map<string, KnowledgeSource[]>();
  for (const source of sources) {
    // Project-relative paths are always spelt with `/`, so this is safe on
    // Windows; splitting on the platform separator would put every file in the
    // root folder there.
    const cut = source.path.lastIndexOf("/");
    const folder = cut === -1 ? "" : source.path.slice(0, cut);
    const bucket = folders.get(folder);
    if (bucket) bucket.push(source);
    else folders.set(folder, [source]);
  }
  const unreadable = sources.filter((source) => !source.readable).length;

  if (sources.length === 0) {
    return (
      <p className="muted knowledge-manifest empty">
        There is nothing in <code>source/</code> yet, so there is nothing to read.
        {directory ? ` The folder is ${directory}.` : ""}
      </p>
    );
  }

  return (
    <div className="knowledge-manifest" aria-label="Files the index will read">
      <div className="knowledge-manifest-head">
        <strong>
          {sources.length} file{sources.length === 1 ? "" : "s"} in <code>source/</code>
        </strong>
        {directory && (
          <span className="muted mono" title={directory}>
            {directory}
          </span>
        )}
      </div>
      <div className="knowledge-manifest-list">
        {[...folders.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([folder, rows]) => (
            <div key={folder || "/"} className="knowledge-manifest-group">
              <div className="knowledge-manifest-folder">
                {folder === "" ? "source/" : `source/${folder}/`}
                <span className="muted"> {rows.length}</span>
              </div>
              {rows.map((source) => (
                <div key={source.path} className="knowledge-file">
                  <FileText size={12} aria-hidden="true" />
                  <span className="knowledge-file-open" title={source.path}>
                    {folder === "" ? source.path : source.path.slice(folder.length + 1)}
                  </span>
                  {!source.readable && (
                    <span className="pill warn" title="Needs MarkItDown to be converted">
                      binary
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
      </div>
      {unreadable > 0 && (
        <p className="muted">
          {unreadable} of these {unreadable === 1 ? "needs" : "need"} a converter and will be
          reported as unreadable. Add Microsoft&apos;s MarkItDown in Control Center → MCP servers
          and approve <code>convert_to_markdown</code> first if they matter.
        </p>
      )}
    </div>
  );
}

/**
 * The raw files waiting in `source/`.
 *
 * Separate from the notes on purpose. They are different things at different
 * stages: a source is what a note will be made *from*, and between adding one
 * and ingesting it, it is in the vault without being in the graph. One list
 * showing both would make that gap invisible, and adding a file would look like
 * it had done nothing.
 */
function SourceFiles({
  sources,
  busy,
  onAdd,
  onRemove,
}: {
  sources: readonly KnowledgeSource[];
  busy: boolean;
  onAdd: () => void;
  onRemove: (path: string) => void;
}): JSX.Element {
  const unreadable = sources.filter((source) => !source.readable).length;

  return (
    <aside
      className="knowledge-files sources"
      aria-label="Source files waiting to be ingested"
    >
      <div className="knowledge-files-head">
        <strong>Sources</strong>
        <span className="muted">{sources.length}</span>
        <button className="ghost" disabled={busy} onClick={onAdd} title="Copy files into source/">
          <Plus size={13} aria-hidden="true" /> Add
        </button>
      </div>
      <div className="muted knowledge-files-note">
        Raw files, never indexed. Ingest turns them into notes.
      </div>
      <div className="knowledge-files-list">
        {sources.map((source) => (
          <div key={source.path} className="knowledge-file">
            <span className="knowledge-file-open" title={source.path}>
              {source.path}
            </span>
            {/* Said, not hidden: a PDF among plain text produces no note unless
                MarkItDown is approved, and finding that out after an ingest that
                silently skipped it is worse than seeing it here. */}
            {!source.readable && (
              <span className="pill warn" title="Needs MarkItDown to be converted">
                binary
              </span>
            )}
            <button
              className="icon"
              title={`Delete ${source.path}`}
              aria-label={`Delete ${source.path}`}
              onClick={() => onRemove(source.path)}
            >
              <Trash2 size={12} aria-hidden="true" />
            </button>
          </div>
        ))}
        {sources.length === 0 && (
          <p className="muted">
            Nothing here yet. Add files and select Build the index to turn them into notes.
          </p>
        )}
        {unreadable > 0 && (
          <p className="muted" style={{ marginTop: 8 }}>
            {unreadable} {unreadable === 1 ? "file needs" : "files need"} a converter. Add
            Microsoft&apos;s MarkItDown in Control Center → MCP servers and approve
            <code> convert_to_markdown</code>; Ingest will use it.
          </p>
        )}
      </div>
    </aside>
  );
}

/**
 * The notes the graph was built from, as a directory listing.
 *
 * The graph answers "what is connected to what", and it is the only thing that
 * can. It is poor at "what is actually in here": a note is a dot, a folder is
 * nothing at all, and a vault of a hundred Markdown files reads as a cloud with
 * no inventory.
 *
 * Grouped by folder rather than flat, because that is the shape on disk and an
 * Obsidian vault carries meaning in it. `details` is used rather than a
 * hand-rolled disclosure so keyboard and screen-reader behaviour is the
 * platform's rather than a reimplementation of it.
 */
function VaultFiles({
  graph,
  selectedId,
  onSelect,
  onRevealSource,
}: {
  graph: KnowledgeGraph | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRevealSource?: (path: string) => void;
}): JSX.Element {
  const [filter, setFilter] = useState("");

  const folders = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const byFolder = new Map<string, GraphNode[]>();

    for (const node of graph?.nodes ?? []) {
      if (node.kind !== "document" || node.path === "") continue;
      if (needle !== "" && !node.path.toLowerCase().includes(needle)) continue;
      const cut = node.path.lastIndexOf("/");
      const folder = cut === -1 ? "" : node.path.slice(0, cut);
      const rows = byFolder.get(folder);
      if (rows) rows.push(node);
      else byFolder.set(folder, [node]);
    }

    return [...byFolder.entries()]
      .map(([folder, rows]) => ({
        folder,
        rows: rows.slice().sort((a, b) => a.path.localeCompare(b.path)),
      }))
      .sort((a, b) => a.folder.localeCompare(b.folder));
  }, [filter, graph]);

  const total = folders.reduce((sum, group) => sum + group.rows.length, 0);
  const leaf = (path: string): string => path.split("/").pop() ?? path;

  return (
    <aside className="knowledge-files notes" aria-label="Notes the graph is built from">
      <div className="knowledge-files-head">
        <strong>Notes</strong>
        <span className="muted">{total}</span>
      </div>
      <div className="muted knowledge-files-note">
        Obsidian Markdown in the vault root. This is what the graph is made of.
      </div>
      <input
        className="knowledge-files-filter"
        placeholder="Filter by path"
        aria-label="Filter files by path"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="knowledge-files-list">
        {folders.map((group) => (
          <details key={group.folder} open={folders.length <= 12}>
            <summary>
              {group.folder === "" ? "(vault root)" : group.folder}{" "}
              <span className="muted">{group.rows.length}</span>
            </summary>
            {group.rows.map((node) => (
              <div
                key={node.id}
                className={`knowledge-file${node.id === selectedId ? " selected" : ""}`}
              >
                <button
                  className="knowledge-file-open"
                  title={node.path}
                  onClick={() => onSelect(node.id)}
                >
                  {leaf(node.path)}
                </button>
                {/* Opening the file itself is the project navigator's job,
                    not this panel's. The graph is not a third file browser. */}
                {onRevealSource && (
                  <button
                    className="icon"
                    title={`Open ${node.path}`}
                    aria-label={`Open ${node.path}`}
                    onClick={() => onRevealSource(node.path)}
                  >
                    <FileText size={12} aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
          </details>
        ))}
        {total === 0 && (
          <p className="muted">
            {filter.trim() === ""
              ? "No notes yet. The graph is built from Markdown in the vault root — add sources above and select Build the index."
              : `No path contains “${filter.trim()}”.`}
          </p>
        )}
      </div>
    </aside>
  );
}

/**
 * One note, opened as a dialog.
 *
 * It used to be a card appended under the graph. That put a note body — which
 * can be four thousand characters — inside a pane already filled by the graph
 * and the two side lists, and the card drew over them. A note is read, acted
 * on and dismissed; it is not part of the layout, so it does not compete for
 * the layout's space.
 */
function NodeDetail({
  detail,
  builtAt,
  onOpen,
  onClose,
  onRevealSource,
}: {
  detail: KnowledgeNodeDetail;
  builtAt: string;
  onOpen: (id: string) => void;
  onClose: () => void;
  onRevealSource?: (path: string) => void;
}): JSX.Element {
  return (
    <Modal
      title={detail.node.title}
      onClose={onClose}
      className="knowledge-note"
      footer={
        onRevealSource && detail.node.path ? (
          <button onClick={() => onRevealSource(detail.node.path)}>Reveal in project</button>
        ) : undefined
      }
    >
      <div className="row">
        <span className="pill">{detail.node.kind}</span>
        {detail.node.tags.map((tag) => (
          <span className="pill" key={tag}>
            #{tag}
          </span>
        ))}
      </div>

      {/* Provenance: where this knowledge came from, stated for every node,
          so nothing in the graph is unattributable. */}
      <div className="notice" style={{ marginTop: 8 }}>
        {KIND_PROVENANCE[detail.node.kind] ?? "Source unknown."}
        {detail.node.path ? `\nSource: ${detail.node.path}` : ""}
        {detail.node.updatedAt ? `\nSource modified: ${formatWhen(detail.node.updatedAt)}` : ""}
        {builtAt ? `\nIndexed: ${formatWhen(builtAt)}` : ""}
        {detail.node.sizeBytes > 0 ? `\nSize: ${detail.node.sizeBytes} bytes` : ""}
      </div>

      {/* Keyed on the note, so following a link into another one starts its
          lists collapsed rather than inheriting the last note's state. */}
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 12 }}>
        <Links
          key={`out:${detail.node.id}`}
          title="Links to"
          items={detail.outgoing}
          onOpen={onOpen}
        />
        <Links
          key={`in:${detail.node.id}`}
          title="Linked from"
          items={detail.incoming}
          onOpen={onOpen}
        />
      </div>

      {detail.content && (
        <pre className="knowledge-note-body">{detail.content.slice(0, 4000)}</pre>
      )}
    </Modal>
  );
}

/**
 * How many links are shown before the list collapses.
 *
 * A well-connected note has forty, and forty names push the note body — the
 * thing the dialog was opened to read — off the bottom of the screen. Three is
 * enough to see what kind of thing links here; the count on the button says
 * how much is being held back, so nothing is hidden silently.
 */
const LINKS_SHOWN = 3;

function Links({
  title,
  items,
  onOpen,
}: {
  title: string;
  items: KnowledgeNodeDetail["outgoing"];
  onOpen: (id: string) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const collapsible = items.length > LINKS_SHOWN;
  const shown = collapsible && !expanded ? items.slice(0, LINKS_SHOWN) : items;

  return (
    <div>
      <div className="muted">{title}</div>
      {items.length === 0 && <div className="muted">—</div>}
      {shown.map((item) => (
        <div key={`${item.kind}:${item.node.id}`}>
          <button
            style={{ background: "none", border: "none", padding: "2px 0", color: "var(--accent)" }}
            onClick={() => onOpen(item.node.id)}
          >
            {item.node.title}
          </button>
          <span className="muted"> · {item.kind}</span>
        </div>
      ))}
      {collapsible && (
        <button className="link" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

/** The same index as a sortable list, for anyone the picture does not serve. */
function NodeTable({
  graph,
  onSelect,
}: {
  graph: KnowledgeGraph;
  onSelect: (id: string) => void;
}): JSX.Element {
  const rows = useMemo(
    () => [...graph.nodes].sort((a, b) => b.degree - a.degree).slice(0, 500),
    [graph],
  );

  return (
    <div className="card">
      <h3>Index</h3>
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Kind</th>
            <th>Source</th>
            <th>Links</th>
            <th>Modified</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((node) => (
            <tr key={node.id}>
              <td>
                <button className="link" style={{ padding: 0 }} onClick={() => onSelect(node.id)}>
                  {node.title}
                </button>
              </td>
              <td>
                <span className="pill">{node.kind}</span>
              </td>
              <td className="muted">{node.path || "—"}</td>
              <td>{node.degree}</td>
              <td className="muted">{node.updatedAt ? formatWhen(node.updatedAt) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {graph.nodes.length > rows.length && (
        <p className="muted">Showing the {rows.length} most-linked of {graph.nodes.length}.</p>
      )}
    </div>
  );
}

function formatWhen(value: string): string {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString();
}
