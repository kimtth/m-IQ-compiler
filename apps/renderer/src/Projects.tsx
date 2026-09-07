import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { FolderPlus, RefreshCw, Trash2, FolderOpen } from "lucide-react";
import type { ProjectRecord } from "@iq/shared";
import { call, callAs, subscribe } from "./bridge.js";
import { useAction } from "./useAction.js";

/**
 * What `projects:list` returns and `projects:changed` carries.
 *
 * Declared once and imported by every consumer. The channel returns the record
 * list *and* which one is bound, and a consumer that assumed a bare array threw
 * on `.map` during render — which, with no boundary above it, blanked the whole
 * window. One exported shape is what stops that recurring.
 */
export interface ProjectState {
  projects: ProjectRecord[];
  activeId: string | null;
}

/** Subscribe to the project list. Returns the records and the bound id. */
export function useProjects(onError: (problem: unknown) => void): ProjectState & {
  reload: () => Promise<void>;
} {
  const [state, setState] = useState<ProjectState>({ projects: [], activeId: null });
  const { run } = useAction(onError);

  const reload = useCallback(async () => {
    await run(async () => {
      setState(await callAs<ProjectState>("projects:list"));
    });
  }, [run]);

  useEffect(() => {
    void reload();
    return subscribe<ProjectState>("projects:changed", setState);
  }, [reload]);

  return { ...state, reload };
}

/**
 * Project management.
 *
 * A project is the unit of scoping — a named directory plus the sessions,
 * artifacts, skills, MCP connections, knowledge index and memories bound to it.
 * Binding is what Co-create requires; Chat may run unbound. Removing a
 * project only forgets the binding, never the files on disk, and the copy
 * says so plainly so no one deletes work by reaching for the wrong control.
 *
 * "Project" in the interface, `project` in the code: Microsoft Fabric has a
 * project of its own, reached from the same app, and two different things
 * under one word is a question the user should never have to ask. The channels,
 * records and stored ids keep the old name so no state has to be migrated.
 */

interface ProjectsProps {
  projectId: string | null;
  onError: (problem: unknown) => void;
  /** Notify the shell of a bind/unbind so the app-level project tracks it. */
  onBindProject?: (projectId: string | null) => void;
}

export function Projects({ projectId, onError, onBindProject }: ProjectsProps): JSX.Element {
  const { projects, reload: load } = useProjects(onError);
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const { run } = useAction(onError);

  const choose = async (): Promise<void> => {
    await run(async () => {
      // Main owns the OS dialog; the renderer only receives the chosen path.
      const { directory: picked } = await call("projects:choose");
      if (picked) setDirectory(picked);
    });
  };

  const create = async (): Promise<void> => {
    if (name.trim() === "") return;
    setBusy(true);
    await run(async () => {
      await call("projects:create", { name: name.trim(), directory: directory.trim() });
      setName("");
      setDirectory("");
      await load();
    });
    setBusy(false);
  };

  const bind = async (id: string | null): Promise<void> => {
    await run(async () => {
      await call("projects:bind", { projectId: id });
      onBindProject?.(id);
      await load();
    });
  };

  const remove = async (id: string): Promise<void> => {
    await run(async () => {
      await call("projects:remove", { projectId: id });
      await load();
    });
  };

  return (
    // `.pane-body` and not a bare `.stack`: this is mounted straight into the
    // canvas pane, which supplies no padding of its own, so without it every
    // card and every line of prose sat flush against the pane border.
    <div className="pane-body stack">
      <div className="card">
        <div className="row between">
          <h3>Projects</h3>
          <button className="icon" title="Refresh" aria-label="Refresh projects" onClick={() => void load()}>
            <RefreshCw size={16} aria-hidden />
          </button>
        </div>
        <p className="muted">
          A project is a named directory and everything scoped to it. Co-create needs one bound;
          Chat can run without one.
        </p>

        <div className="field-row">
          <label>Name</label>
          <input value={name} placeholder="Quarterly review" onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="field-row">
          <label>Directory</label>
          <div className="row" style={{ flex: 1 }}>
            <input
              className="mono"
              style={{ flex: 1 }}
              value={directory}
              placeholder="Choose a folder…"
              onChange={(event) => setDirectory(event.target.value)}
            />
            <button className="icon" title="Choose folder" aria-label="Choose folder" onClick={() => void choose()}>
              <FolderOpen size={16} aria-hidden />
            </button>
          </div>
        </div>
        <div className="row">
          <button className="primary" disabled={busy || name.trim() === ""} onClick={() => void create()}>
            <FolderPlus size={16} aria-hidden /> Create project
          </button>
        </div>
      </div>

      {projects.length === 0 ? (
        <p className="muted">No projects yet. Create one to start working in Co-create.</p>
      ) : (
        projects.map((project) => {
          const bound = project.id === projectId;
          return (
            <div className="card nested" key={project.id}>
              <div className="row between">
                <div>
                  <strong>{project.name}</strong>
                  <div className="muted mono" style={{ fontSize: 11 }}>
                    {project.directory}
                  </div>
                </div>
                <div className="row">
                  {bound && <span className="pill ok">bound</span>}
                  <button
                    className={bound ? "" : "primary"}
                    onClick={() => void bind(bound ? null : project.id)}
                  >
                    {bound ? "Unbind" : "Bind"}
                  </button>
                  <button
                    className="danger icon"
                    title="Remove project"
                    aria-label="Remove project"
                    onClick={() => void remove(project.id)}
                  >
                    <Trash2 size={16} aria-hidden />
                  </button>
                </div>
              </div>
            </div>
          );
        })
      )}

      <p className="muted" style={{ fontSize: 12 }}>
        Removing a project only forgets its binding and scoped state. It never deletes any files
        in the directory on disk.
      </p>
    </div>
  );
}
