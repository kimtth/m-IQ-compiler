import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Boxes, Database, MessageSquare, Play, RefreshCw, Square } from "lucide-react";
import {
  FABRIC_ARTIFACT_LABELS,
  type FabricArtifactKind,
  type FabricDataAgentStatus,
  type FabricItemList,
  type FabricRun,
  type FabricSkillPack,
  type FabricStatus,
} from "@iq/shared";
import { call, callAs, subscribe } from "./bridge.js";
import { useAction } from "./useAction.js";

/**
 * Co-create → Fabric.
 *
 * Three things in one surface because they are three stages of one job:
 * see what is already in the workspace, build from your own data definitions,
 * and ask the data whether the build worked.
 *
 * The panel that matters most is the smallest: **which skills-for-fabric
 * release is grounding the run**. Everything this surface can do depends on
 * current knowledge of Fabric's item APIs, that knowledge lives in the upstream
 * Microsoft bundle rather than in this app, and a run without it is refused.
 * Showing the version and where it was resolved from turns "it failed" into
 * "it failed on release 0.3.10 resolved from the Copilot CLI plugin", which is
 * a sentence someone can act on.
 *
 * Source files are ticked individually and never inferred from a folder. A
 * pipeline pointed at a directory ingests whatever happens to be in it, and
 * that is how unrelated local data ends up described in a shared workspace.
 */

const KINDS = Object.keys(FABRIC_ARTIFACT_LABELS) as FabricArtifactKind[];

interface ContextStatus {
  ready: boolean;
  python: string;
  message: string;
}

export function Fabric({
  onError,
  onOpenDataAgent,
}: {
  onError: (problem: unknown) => void;
  /** Send the user to Chat → Data agent, where data questions are asked. */
  onOpenDataAgent?: () => void;
}): JSX.Element {
  const [status, setStatus] = useState<FabricStatus | null>(null);
  const [dataAgent, setDataAgent] = useState<FabricDataAgentStatus | null>(null);
  const [pack, setPack] = useState<FabricSkillPack | null>(null);
  const [items, setItems] = useState<FabricItemList | null>(null);
  const [runs, setRuns] = useState<FabricRun[]>([]);
  const [candidates, setCandidates] = useState<Array<{ path: string; bytes: number }>>([]);
  const [context, setContext] = useState<ContextStatus | null>(null);

  const [objective, setObjective] = useState("");
  const [kinds, setKinds] = useState<FabricArtifactKind[]>(["lakehouse", "semanticModel"]);
  const [files, setFiles] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const { run } = useAction(onError);

  const load = useCallback(async () => {
    await run(async () => {
      const current = await call("fabric:status");
      setStatus(current);
      setDataAgent(await call("dataAgent:status"));
      setPack(await call("fabric:skillPack"));
      setRuns(await call("fabric:runs"));
      setCandidates(await call("fabric:candidates"));
      setContext(await callAs<ContextStatus>("fabric:contextStatus"));
      // Cached, so this is free after the first read. Without it the panel
      // stays empty until someone presses a button, every single time.
      if (current.state === "ready") setItems(await call("fabric:items", { refresh: false }));
    });
  }, [run]);

  useEffect(() => {
    void load();
    return subscribe<FabricRun>("fabric:changed", (run) => {
      setRuns((current) => [run, ...current.filter((entry) => entry.id !== run.id)]);
    });
  }, [load]);

  const active = runs.find((run) => run.status === "running" || run.status === "preparing") ?? null;

  const refreshItems = async (): Promise<void> => {
    setBusy(true);
    await run(async () => {
      setItems(await call("fabric:items", { refresh: true }));
      setStatus(await call("fabric:status"));
    });
    setBusy(false);
  };

  const start = async (): Promise<void> => {
    setBusy(true);
    await run(async () => {
      await call("fabric:run", {
        objective: objective.trim(),
        kinds,
        sourceFiles: [...files],
      });
    });
    setBusy(false);
    await load();
  };

  const prepareContext = async (): Promise<void> => {
    setBusy(true);
    await run(async () => {
      await call("fabric:prepareContext");
      setContext(await callAs<ContextStatus>("fabric:contextStatus"));
    });
    setBusy(false);
  };

  if (status === null) {
    return (
      <div className="pane-body">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (status.state !== "ready") {
    return (
      <>
        <div className="pane-header">
          <strong>Fabric</strong>
        </div>
        <div className="pane-body">
          <div className="empty-state">
            <Database size={20} aria-hidden="true" />
            <h2>No Fabric workspace registered</h2>
            <p className="muted">{status.message}</p>
            <p className="muted">
              Connections &amp; access → Microsoft Fabric. It is reached with your Azure identity,
              so there is no key to paste.
            </p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="pane-header">
        <strong>Fabric</strong>
        <span className="muted">
          {status.workspaceName || status.workspaceId}
          {dataAgent?.state === "ready"
            ? ` · Data Agent at ${dataAgent.host}`
            : " · no Data Agent"}
        </span>
        <div className="spacer" />
        <button disabled={busy} onClick={() => void refreshItems()}>
          <RefreshCw size={14} aria-hidden="true" /> Refresh items
        </button>
      </div>

      <div className="pane-body">
        {/* First, because everything below depends on it. */}
        <div className="card">
          <div className="row between">
            <h3>Fabric skills</h3>
            {pack?.available ? (
              <span className="pill ok">
                skills-for-fabric {pack.version || "unversioned"} · {pack.source}
              </span>
            ) : (
              <span className="pill bad">not found</span>
            )}
          </div>
          {pack?.available ? (
            <p className="muted">
              {pack.skills.length} skills, {pack.agents.length} agents and{" "}
              {pack.references.length} shared references across {pack.bundles.join(", ")}. Runs read
              these before they act, so Fabric API changes arrive by updating the bundle rather than
              by rebuilding this app. The full list is in Skills.
            </p>
          ) : (
            <p className="muted">{pack?.message}</p>
          )}
        </div>

        {active !== null ? (
          <div className="card approval">
            <h3>Building — {active.status}</h3>
            <p className="muted">{active.objective}</p>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="danger" onClick={() => void call("fabric:cancel").catch(onError)}>
                <Square size={14} aria-hidden="true" /> Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="card">
            <h3>Build Fabric artifacts</h3>
            <label className="stacked-field">
              <span className="caption">What should exist when this is done?</span>
              <textarea
                rows={3}
                placeholder="e.g. a bronze/silver lakehouse for the customer extract, with a semantic model over the silver tables"
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
              />
            </label>

            <div className="stacked-field">
              <span className="caption">Artifacts</span>
              <div className="row" style={{ flexWrap: "wrap" }}>
                {KINDS.map((kind) => (
                  <label className="tool-grant" key={kind}>
                    <input
                      type="checkbox"
                      checked={kinds.includes(kind)}
                      onChange={(event) =>
                        setKinds((current) =>
                          event.target.checked
                            ? [...new Set([...current, kind])]
                            : current.filter((entry) => entry !== kind),
                        )
                      }
                    />
                    <span>{FABRIC_ARTIFACT_LABELS[kind]}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* `.field-row` is one label beside one control. A caption beside a
                scrolling allow-list put the tick column halfway across the card
                and squeezed every path into an ellipsis, so this is stacked. */}
            <div className="stacked-field">
              <span className="caption">Source documents</span>
              <span className="muted">
                Ticked files are the only things the run may read. Data dictionaries, ER
                diagrams and schema documents are what this is for.
              </span>
              {context !== null && !context.ready && (
                <div className="row" style={{ gap: 8 }}>
                  <span className="muted">{context.message}</span>
                  {context.python !== "" && (
                    <button disabled={busy} onClick={() => void prepareContext()}>
                      Prepare
                    </button>
                  )}
                </div>
              )}
              <div className="fabric-files">
                {candidates.length === 0 && (
                  <span className="muted">No candidate documents under the bound project.</span>
                )}
                {candidates.map((file) => (
                  <label className="tool-grant" key={file.path} title={file.path}>
                    <input
                      type="checkbox"
                      checked={files.has(file.path)}
                      onChange={(event) =>
                        setFiles((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(file.path);
                          else next.delete(file.path);
                          return next;
                        })
                      }
                    />
                    <span className="mono">{file.path}</span>
                    <span className="muted">{formatBytes(file.bytes)}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="row" style={{ marginTop: 12 }}>
              <button
                className="primary"
                disabled={
                  busy || objective.trim() === "" || pack === null || !pack.available
                }
                title={
                  pack?.available === true
                    ? "Create the artifacts, reading the installed Fabric skills first"
                    : "The Microsoft Fabric skill bundle must be installed before a run"
                }
                onClick={() => void start()}
              >
                <Play size={14} aria-hidden="true" /> Build
              </button>
              <span className="muted">
                {files.size} source {files.size === 1 ? "file" : "files"} selected
              </span>
            </div>
          </div>
        )}

        {dataAgent?.state === "ready" && (
          <div className="card">
            <h3>
              <MessageSquare size={14} aria-hidden="true" /> Ask the data
            </h3>
            <p className="muted">
              Data questions are answered in Chat → Data agent, which is a conversation with the
              published Fabric Data Agent. Use it to check that what you built holds the data you
              expected.
            </p>
            {onOpenDataAgent && (
              <button className="primary" style={{ marginTop: 8 }} onClick={onOpenDataAgent}>
                Open Data agent
              </button>
            )}
          </div>
        )}

        {items !== null && (
          <div className="card">
            <div className="row between">
              <h3>
                <Boxes size={14} aria-hidden="true" /> In the workspace ({items.items.length})
              </h3>
              {items.fetchedAt !== "" && (
                <span className="muted">read {new Date(items.fetchedAt).toLocaleString()}</span>
              )}
            </div>
            {items.items.length === 0 && <p className="muted">This workspace is empty.</p>}
            <div className="capped-list">
              {items.items.map((item) => (
                <div className="row between" key={item.id}>
                  <span>
                    <strong>{item.displayName}</strong>{" "}
                    <span className="muted">{item.description}</span>
                  </span>
                  <span className="pill">{item.type}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {runs.map((run) => (
          <div className="card" key={run.id}>
            <div className="row between">
              <h3>{run.objective}</h3>
              <div className="row">
                <span
                  className={`pill${
                    run.status === "succeeded" ? " ok" : run.status === "failed" ? " bad" : ""
                  }`}
                >
                  {run.status}
                </span>
                {run.skillPackVersion !== "" && (
                  <span className="pill">skills {run.skillPackVersion}</span>
                )}
              </div>
            </div>
            <div className="muted">
              {new Date(run.startedAt).toLocaleString()} ·{" "}
              {run.kinds.map((kind) => FABRIC_ARTIFACT_LABELS[kind]).join(", ") || "unspecified"} ·{" "}
              {run.sourceFiles.length} source {run.sourceFiles.length === 1 ? "file" : "files"}
            </div>
            {run.created.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <strong>Created</strong>
                <div className="capped-list">
                  {run.created.map((item) => (
                    <div className="muted" key={item.id}>
                      {item.type} · {item.displayName}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {run.summary !== "" && (
              <pre className="notice" style={{ marginTop: 8 }}>
                {run.summary}
              </pre>
            )}
            {run.error !== null && <div className="muted">{run.error}</div>}
            <div className="muted mono">{run.outputDir}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(0)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}
