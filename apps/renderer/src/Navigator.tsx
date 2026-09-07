import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, File, FolderOpen, MessageSquarePlus, RefreshCw } from "lucide-react";
import type { ProjectEntry } from "@iq/shared";
import { call, subscribe } from "./bridge.js";

/**
 * The project navigator.
 *
 * This pane is the visible boundary of the project on the filesystem: what
 * is in the tree is what the agent can read or write without a further grant.
 * It says nothing about non-file reach — Microsoft 365, Work IQ, the browser
 * and MCP servers are stated in the Connections & access tab instead.
 *
 * Directories expand lazily so a large project never blocks the pane.
 */
export interface NavigatorProps {
  onOpenFile: (path: string) => void;
  /** Put a reference to the file into the chat composer. */
  onAddFileToChat: (path: string) => void;
  /**
   * The file the agent is writing right now, project-relative.
   *
   * `.tree-row.touched` has existed in the stylesheet all along — "a file the
   * agent is writing right now must be visible without hunting" — with nothing
   * ever setting the class.
   */
  touchedPath?: string | null;
  onError: (problem: unknown) => void;
}

/** Where a context menu is open, and on what. */
interface MenuState {
  entry: ProjectEntry;
  x: number;
  y: number;
}

export function Navigator({
  onOpenFile,
  onAddFileToChat,
  touchedPath = null,
  onError,
}: NavigatorProps): JSX.Element {
  const [root, setRoot] = useState<string | null>(null);
  const [children, setChildren] = useState<Record<string, ProjectEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const listDir = useCallback(
    async (path: string): Promise<void> => {
      try {
        const listing = await call("project:list", { path });
        setRoot(listing.root);
        setChildren((current) => ({ ...current, [path]: listing.entries }));
      } catch (problem) {
        onError(problem);
      }
    },
    [onError],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    // Re-list every directory currently open, so a refresh does not silently
    // collapse the user's place in the tree.
    const open = ["", ...expanded];
    await Promise.all(open.map((path) => listDir(path)));
    setLoading(false);
  }, [expanded, listDir]);

  useEffect(() => {
    void listDir("");
  }, [listDir]);

  /**
   * Follow the project as the agent writes into it.
   *
   * The pane's empty state promises that "files the agent creates appear here",
   * and until this existed that was only true if the user pressed Refresh: the
   * tree listed on mount and never again. Main coalesces the filesystem events,
   * so this fires once per burst rather than once per byte written.
   *
   * `refreshRef` keeps the subscription from being torn down and rebuilt every
   * time the user expands a folder — `refresh` closes over `expanded`, so it is
   * a new function on each such change.
   */
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => subscribe("project:filesChanged", () => void refreshRef.current()), []);

  // A menu anchored to a row must not survive the things that move it.
  useEffect(() => {
    if (!menu) return;
    const dismiss = (): void => setMenu(null);
    window.addEventListener("click", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [menu]);

  const reveal = async (path: string): Promise<void> => {
    try {
      await call("project:reveal", { path });
    } catch (problem) {
      onError(problem);
    }
  };

  /*
   * The navigator does not bind an *id*, but it does open a *folder*.
   *
   * It used to bind an id, wrongly: an effect called `onBindProject(root)`
   * whenever nothing was bound yet, passing a *directory path* where an *id*
   * is expected. The result was a red banner on launch — `no project with
   * id "<IQ_HOME>/project"` — whenever the tree listed before the project
   * state arrived. A file tree does not get to guess which record is bound.
   *
   * Choosing a folder is the opposite case, and belongs here. The user is
   * looking at the tree and wants a different one; the path is not guessed,
   * it comes from the OS dialog, and main resolves it to a record. `open`
   * adopts the folder if it is new and binds it either way, so the renderer
   * never compares paths itself.
   */
  const chooseProject = async (): Promise<void> => {
    setOpening(true);
    try {
      const { directory } = await call("projects:choose");
      if (!directory) return;
      await call("projects:open", { directory });
      // The tree is now pointed somewhere else, so every cached listing and
      // every expanded path describes the old root.
      setChildren({});
      setExpanded(new Set());
      setSelected(null);
      await listDir("");
    } catch (problem) {
      onError(problem);
    } finally {
      setOpening(false);
    }
  };

  const toggle = (entry: ProjectEntry): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) {
        next.delete(entry.path);
      } else {
        next.add(entry.path);
        if (!children[entry.path]) void listDir(entry.path);
      }
      return next;
    });
  };

  const rows = (path: string, depth: number): JSX.Element[] =>
    (children[path] ?? []).flatMap((entry) => {
      const isOpen = expanded.has(entry.path);
      const row = (
        <button
          key={entry.path}
          className={`tree-row${selected === entry.path ? " selected" : ""}${
            touchedPath === entry.path ? " touched" : ""
          }`}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={entry.path}
          onContextMenu={(event) => {
            event.preventDefault();
            setSelected(entry.path);
            setMenu({ entry, x: event.clientX, y: event.clientY });
          }}
          onClick={() => {
            setSelected(entry.path);
            if (entry.kind === "directory") toggle(entry);
            else onOpenFile(entry.path);
          }}
        >
          <span className="glyph" aria-hidden="true">
            {entry.kind === "directory" ? (
              isOpen ? (
                <ChevronDown className="lucide" size={16} />
              ) : (
                <ChevronRight className="lucide" size={16} />
              )
            ) : (
              <File className="lucide" size={16} />
            )}
          </span>
          <span className="name">{entry.name}</span>
        </button>
      );
      return entry.kind === "directory" && isOpen
        ? [row, ...rows(entry.path, depth + 1)]
        : [row];
    });

  return (
    <>
      <div className="pane-header">
        <span className="pane-title">Project</span>
        <div className="spacer" />
        <button
          className="icon subtle"
          disabled={opening}
          onClick={() => void chooseProject()}
          title="Open a project folder"
          aria-label="Open a project folder"
        >
          {opening ? (
            <span className="spinner" aria-hidden="true" />
          ) : (
            <FolderOpen className="lucide" size={16} aria-hidden="true" />
          )}
        </button>
        <button
          className="icon subtle"
          disabled={loading}
          onClick={() => void refresh()}
          title="Refresh"
          aria-label="Refresh project"
        >
          {loading ? (
            <span className="spinner" aria-hidden="true" />
          ) : (
            <RefreshCw className="lucide" size={16} aria-hidden="true" />
          )}
        </button>
      </div>
      <div className="pane-body flush">
        {root && (
          <div className="muted" style={{ padding: "8px 8px 0" }} title={root}>
            {root}
          </div>
        )}
        <div className="tree">{rows("", 0)}</div>
        {(children[""] ?? []).length === 0 && (
          <p className="muted" style={{ padding: "0 12px" }}>
            The project is empty. Files the agent creates appear here.
          </p>
        )}
      </div>

      {menu && (
        // Rendered at the cursor rather than through Electron's native menu:
        // building a native menu would mean handing the main process a path
        // chosen by the renderer for every right-click, and the two commands
        // here already have their own guarded channels.
        <div
          className="context-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="context-menu-title" title={menu.entry.path}>
            {menu.entry.name}
          </div>
          {menu.entry.kind === "file" && (
            <button
              role="menuitem"
              onClick={() => {
                onAddFileToChat(menu.entry.path);
                setMenu(null);
              }}
            >
              <MessageSquarePlus className="lucide" size={14} aria-hidden="true" />
              <span>Add File to Chat</span>
            </button>
          )}
          <button
            role="menuitem"
            onClick={() => {
              void reveal(menu.entry.path);
              setMenu(null);
            }}
          >
            <FolderOpen className="lucide" size={14} aria-hidden="true" />
            <span>Reveal in File Explorer</span>
          </button>
        </div>
      )}
    </>
  );
}
