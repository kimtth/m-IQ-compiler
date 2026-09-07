import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import {
  Cpu,
  ExternalLink,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import {
  DEPLOYMENT_API_VERSION,
  MODEL_ROLE_CAPABILITY,
  MODEL_ROLE_LABELS,
  ModelRole,
  parseModelId,
  type FoundryModelInput,
  type ModelCapability,
  type ModelCatalog,
  type ModelCatalogEntry,
  type SampleModuleStatus,
  type SessionSweep,
} from "@iq/shared";
import { call, subscribe } from "./bridge.js";
import { useProjects } from "./Projects.js";
import { Audit, Jobs, Memories, Plans } from "./panels/control.js";
import { useSamples } from "./samples/index.js";

/**
 * Control Center: the governance and configuration surface.
 *
 * It is read-and-configure, never a place where artifacts are authored, so it
 * has no project navigator — its right pane is a detail inspector for the
 * selected record. Each destination below renders into a canvas tab. Memories,
 * Automations, Delegated plans and Audit are the existing panels wrapped with a
 * project filter and inspector so Control Center is their home; Models is the
 * one place every usable model is seen and configured.
 */

interface CenterProps {
  projectId: string | null;
  onError: (problem: unknown) => void;
}

// --- reusable project filter ---------------------------------------------

/**
 * A project scope control with an explicit "All projects" option, shared by
 * the Control Center destinations. Null is "all".
 */
export function ProjectFilter({
  value,
  onChange,
  onError,
}: {
  value: string | null;
  onChange: (projectId: string | null) => void;
  onError: (problem: unknown) => void;
}): JSX.Element {
  const { projects } = useProjects(onError);

  return (
    <label className="field-row">
      <span>Project</span>
      <select value={value ?? ""} onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}>
        <option value="">All projects</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Shell shared by the wrapped destinations: a filter row over the panel. */
function Destination({
  filter,
  onFilter,
  onError,
  children,
}: {
  filter: string | null;
  onFilter: (id: string | null) => void;
  onError: (problem: unknown) => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div className="control-destination">
      <div className="pane-header">
        <ProjectFilter value={filter} onChange={onFilter} onError={onError} />
      </div>
      {children}
    </div>
  );
}

// --- wrapped destinations ---------------------------------------------------

export function MemoriesCenter({
  projectId,
  onError,
  focusMemoryIds,
}: CenterProps & { focusMemoryIds?: readonly string[] }): JSX.Element {
  const [filter, setFilter] = useState<string | null>(null);
  return (
    <Destination filter={filter} onFilter={setFilter} onError={onError}>
      <Memories projectId={projectId} onError={onError} focusMemoryIds={focusMemoryIds} />
    </Destination>
  );
}

export function AutomationsCenter({ onError }: CenterProps): JSX.Element {
  const [filter, setFilter] = useState<string | null>(null);
  return (
    <Destination filter={filter} onFilter={setFilter} onError={onError}>
      <Jobs onError={onError} />
    </Destination>
  );
}

export function PlansCenter({ onError }: CenterProps): JSX.Element {
  const [filter, setFilter] = useState<string | null>(null);
  return (
    <Destination filter={filter} onFilter={setFilter} onError={onError}>
      <Plans onError={onError} />
    </Destination>
  );
}

export function AuditCenter({ onError }: CenterProps): JSX.Element {
  const [filter, setFilter] = useState<string | null>(null);
  return (
    <Destination filter={filter} onFilter={setFilter} onError={onError}>
      <Audit onError={onError} />
    </Destination>
  );
}

// --- clean ------------------------------------------------------------------

/**
 * Take out the conversation data nothing can reach.
 *
 * The store is append-only, which is right for an audit trail and means
 * nothing is ever tidied: threads created and never spoken to, the private
 * sessions a council or research run leaves behind, turn logs a crash
 * orphaned, and remembered browser pages for conversations that are gone.
 *
 * Nothing is removed until the user has seen the count. The surface opens on a
 * preview, the button says what it will delete, and a sweep that would remove
 * nothing offers no button at all — an enabled control that does nothing is
 * how a person learns to distrust the ones that do.
 */
export function CleanCenter({
  sessionId,
  onError,
}: {
  /** The conversation on screen. It is never swept, however empty it is. */
  sessionId: string | null;
  onError: (problem: unknown) => void;
}): JSX.Element {
  const [found, setFound] = useState<SessionSweep | null>(null);
  const [busy, setBusy] = useState<"scanning" | "cleaning" | null>("scanning");

  const scan = useCallback(async (): Promise<void> => {
    setBusy("scanning");
    try {
      // The conversation on screen is spared. It is often empty — it was just
      // created — and deleting it under the person looking at it would be a
      // bug they could not tell from data loss.
      setFound(await call("sessions:sweep", { apply: false, keepSessionId: sessionId ?? "" }));
    } catch (problem) {
      onError(problem);
    } finally {
      setBusy(null);
    }
  }, [sessionId, onError]);

  useEffect(() => {
    void scan();
  }, [scan]);

  const clean = async (): Promise<void> => {
    setBusy("cleaning");
    try {
      setFound(await call("sessions:sweep", { apply: true, keepSessionId: sessionId ?? "" }));
    } catch (problem) {
      onError(problem);
    } finally {
      setBusy(null);
    }
  };

  // The four kinds are always listed, so the panel reads the same before and
  // after a scan. A count of null is "not answered yet", which is not zero.
  const rows: { label: string; detail: string; count: number | null }[] = [
    {
      label: "Empty conversations",
      detail: "Started and never spoken to. A conversation you emptied yourself is kept.",
      count: found?.emptySessions ?? null,
    },
    {
      label: "Abandoned runs",
      detail: "Council and research sub-agent sessions no conversation can open.",
      count: found?.abandonedRuns ?? null,
    },
    {
      label: "Orphan turn logs",
      detail: "Turn records no conversation refers to — what a crash leaves behind.",
      count: found?.orphanTurns ?? null,
    },
    {
      label: "Stranded browser pages",
      detail: "Remembered pages filed under conversations that no longer exist.",
      count: found?.strandedPages ?? null,
    },
  ];

  const total = rows.reduce((sum, row) => sum + (row.count ?? 0), 0);

  // The button says what is happening. Before the first scan answers there is
  // no count, and "Nothing to clean" would be a claim nobody has checked yet.
  const label =
    busy === "scanning"
      ? "Scanning…"
      : busy === "cleaning"
        ? "Cleaning…"
        : found === null
          ? "Not scanned"
          : total === 0
            ? "Nothing to clean"
            : `Clean ${total} record${total === 1 ? "" : "s"}`;

  return (
    <>
      <div className="pane-header">
        <strong>Clean</strong>
        <span className="muted">Conversation data nothing can reach any more</span>
      </div>

      <div className="pane-body">
        <div className="card">
          <div className="muted">
            History is append-only, so nothing here is ever removed on its own. This looks for the
            records that have become unreachable — not old ones, and not large ones. Anything in
            use is left alone: the conversation you are in, and any run still working. Your
            conversations, their transcripts and the audit log are untouched.
          </div>
        </div>

        {found?.applied === true && total === 0 && (
          <div className="notice">Cleaned. Nothing unreachable is left.</div>
        )}

        {rows.map((row) => (
          <div className="card" key={row.label}>
            <div className="row between">
              <div>
                <strong>{row.label}</strong>
                <div className="muted">{row.detail}</div>
              </div>
              <span className={`pill${row.count === null || row.count > 0 ? "" : " ok"}`}>
                {row.count ?? "—"}
              </span>
            </div>
          </div>
        ))}

        <div className="row">
          <button
            className="primary"
            disabled={busy !== null || found === null || total === 0}
            title={
              total === 0 ? "Nothing to remove" : "Delete the records listed above. Cannot be undone"
            }
            onClick={() => void clean()}
          >
            {label}
          </button>
          <button disabled={busy !== null} title="Look again" onClick={() => void scan()}>
            Rescan
          </button>
        </div>
      </div>
    </>
  );
}

// --- sample data ------------------------------------------------------------
/**
 * The worked examples, gathered into one place.
 *
 * This surface owns none of them. The hub — `core/samples` on the privileged
 * side, `renderer/samples` for the one module held on this device — answers
 * what exists, what is loaded and what a Load or Clear did. Adding a sixth
 * module changes nothing here.
 *
 * The per-surface Load/Clear controls stay where they are, because someone
 * looking at an empty knowledge graph should be able to fill it without
 * leaving. What was missing was a single answer to "is any of what I am looking
 * at made up, and where?" — which needs one list, somewhere other than inside
 * the surfaces being asked about.
 *
 * The global switch does not delete anything. Off hides the offers and stops
 * the demo IQ Cells being reconciled back; Clear is what removes records.
 * Deleting a user's data as a side effect of a preference would be
 * indefensible.
 */
export function SamplesCenter({ projectId, onError }: CenterProps): JSX.Element {
  const samples = useSamples(projectId);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const setEnabled = async (enabled: boolean): Promise<void> => {
    try {
      await samples.setEnabled(enabled);
      setNotice(
        enabled
          ? "Sample data is on. Each module below can be loaded or cleared independently."
          : "Sample data is off. Nothing was deleted — use Clear on a module to remove its records.",
      );
    } catch (problem) {
      onError(problem);
    }
  };

  const act = async (module: SampleModuleStatus, which: "load" | "clear"): Promise<void> => {
    setBusy(`${module.id}:${which}`);
    try {
      setNotice(await (which === "load" ? samples.load(module.id) : samples.clear(module.id)));
    } catch (problem) {
      onError(problem);
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <div className="pane-header">
        <strong>Sample data</strong>
        <span className="muted">
          The worked examples this app ships, and whether each one is loaded
        </span>
      </div>

      <div className="pane-body">
        <div className="card">
          <label className="tool-grant">
            <input
              type="checkbox"
              checked={samples.enabled}
              onChange={(event) => void setEnabled(event.target.checked)}
            />
            <span>Show sample data</span>
            <span className="muted">
              The same switch the sign-in screen carries. Off hides every offer of an example and
              stops the demo IQ Cells coming back — it deletes nothing on its own.
            </span>
          </label>
        </div>

        {notice !== "" && <div className="notice">{notice}</div>}

        {samples.modules.map((module) => (
          <div className="card" key={module.id}>
            <div className="row between">
              <div>
                <strong>{module.label}</strong>
                <div className="muted">{module.detail}</div>
              </div>
              <span className={`pill${module.loaded ? " ok" : ""}`}>
                {module.loaded ? "loaded" : "not loaded"}
              </span>
            </div>
            <div className="muted" style={{ margin: "6px 0 10px" }}>
              {module.summary}
              {module.owner === "device" && " · held on this device"}
            </div>
            {/* The one state worth interrupting for: a sample automation that
                has been switched on is a scheduled turn that will run
                unattended, and the reader should not have to work that out
                from a list of job names. */}
            {module.warning !== "" && <div className="notice">{module.warning}</div>}
            <div className="row">
              <button
                className="primary"
                disabled={!samples.enabled || module.loaded || busy !== ""}
                title={
                  samples.enabled
                    ? "Load this module's worked examples"
                    : "Turn Show sample data on first"
                }
                onClick={() => void act(module, "load")}
              >
                Load
              </button>
              <button
                disabled={!module.loaded || busy !== ""}
                title="Remove only this module's sample records"
                onClick={() => void act(module, "clear")}
              >
                Clear
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// --- models -----------------------------------------------------------------

const CAPABILITIES: ModelCapability[] = ["chat", "reasoning", "vision", "image", "embeddings"];

/**
 * What ticking a capability actually does.
 *
 * A capability is not a description of the deployment — it is the switch that
 * decides which surfaces offer it, so the consequence belongs next to the box.
 * `image` is the one that was most often wrong: a deployment left untick-ed
 * simply never appears in Image Creation, and nothing anywhere said why.
 */
const CAPABILITY_DETAIL: Record<ModelCapability, string> = {
  chat: "Offered in Chat, Office, Research and Council.",
  reasoning: "Eligible for the Reasoning role.",
  vision: "May be sent images as input.",
  image: "Required for Co-create \u2192 Image Creation. Tick this for a gpt-image-2 deployment.",
  embeddings: "Used for indexing, not for turns.",
};

interface FoundryDraft {
  id: string;
  displayName: string;
  endpoint: string;
  deploymentName: string;
  apiVersion: string;
  capabilities: ModelCapability[];
  restrictToProject: boolean;
}

const blankDraft = (): FoundryDraft => ({
  id: "",
  displayName: "",
  endpoint: "https://",
  deploymentName: "",
  apiVersion: DEPLOYMENT_API_VERSION,
  capabilities: ["chat"],
  restrictToProject: false,
});

export function Models({ projectId, onError }: CenterProps): JSX.Element {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [draft, setDraft] = useState<FoundryDraft | null>(null);
  const [selected, setSelected] = useState<ModelCatalogEntry | null>(null);
  const [testing, setTesting] = useState("");
  const [copilotQuery, setCopilotQuery] = useState("");
  const [copilotExpanded, setCopilotExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      setCatalog(await call("models:catalog"));
    } catch (problem) {
      onError(problem);
    }
  }, [onError]);

  useEffect(() => {
    void load();
    return subscribe<ModelCatalog>("models:changed", setCatalog);
  }, [load]);

  const save = async (): Promise<void> => {
    if (!draft) return;
    try {
      const input: FoundryModelInput = {
        ...(draft.id === "" ? {} : { id: draft.id }),
        displayName: draft.displayName.trim(),
        endpoint: draft.endpoint.trim(),
        deploymentName: draft.deploymentName.trim(),
        apiVersion: draft.apiVersion.trim(),
        capabilities: draft.capabilities,
        projectIds: draft.restrictToProject && projectId ? [projectId] : [],
      };
      await call("models:upsert", input);
      setDraft(null);
      await load();
    } catch (problem) {
      onError(problem);
    }
  };

  const remove = async (entry: ModelCatalogEntry): Promise<void> => {
    const parsed = parseModelId(entry.id);
    if (!parsed || parsed.provider !== "foundry") return;
    try {
      await call("models:remove", { id: parsed.ref });
      await load();
    } catch (problem) {
      onError(problem);
    }
  };

  const test = async (entry: ModelCatalogEntry): Promise<void> => {
    const parsed = parseModelId(entry.id);
    if (!parsed || parsed.provider !== "foundry") return;
    setTesting(entry.id);
    try {
      await call("models:test", { id: parsed.ref });
      await load();
    } catch (problem) {
      onError(problem);
    } finally {
      setTesting("");
    }
  };

  const edit = (entry: ModelCatalogEntry): void => {
    const parsed = parseModelId(entry.id);
    if (!parsed) return;
    // The catalogue does not carry the full endpoint or api version, so editing
    // pre-fills what it has and asks for the rest rather than pretending to know it.
    setDraft({
      id: parsed.ref,
      displayName: entry.displayName,
      endpoint: entry.endpointHost ? `https://${entry.endpointHost}` : "https://",
      deploymentName: "",
      apiVersion: DEPLOYMENT_API_VERSION,
      capabilities: entry.capabilities.length > 0 ? entry.capabilities : ["chat"],
      restrictToProject: entry.projectIds.length > 0,
    });
  };

  const entries = catalog?.entries ?? [];
  const foundry = entries.filter((entry) => parseModelId(entry.id)?.provider === "foundry");
  const copilot = entries.filter((entry) => parseModelId(entry.id)?.provider === "copilot");

  // The advertised Copilot catalogue is long, so it is filtered and capped
  // rather than rendered whole: a search box plus a small visible window keeps
  // the Foundry registry and the role defaults on screen.
  const copilotNeedle = copilotQuery.trim().toLowerCase();
  const copilotMatches = copilotNeedle
    ? copilot.filter(
        (entry) =>
          entry.displayName.toLowerCase().includes(copilotNeedle) ||
          entry.capabilities.some((capability) => capability.toLowerCase().includes(copilotNeedle)),
      )
    : copilot;
  const COPILOT_WINDOW = 5;
  const copilotVisible = copilotExpanded ? copilotMatches : copilotMatches.slice(0, COPILOT_WINDOW);
  const copilotHidden = copilotMatches.length - copilotVisible.length;

  return (
    <div className="control-destination">
      <div className="split">
        <div className="stack">
          {catalog?.copilotError && (
            <div className="notice">GitHub Copilot models could not be read: {catalog.copilotError}</div>
          )}

          <div className="card">
            <div className="row between">
              <div className="row" style={{ gap: 8 }}>
                <Cpu size={16} aria-hidden />
                <h3 style={{ margin: 0 }}>GitHub Copilot</h3>
                <span className="pill">{copilot.length}</span>
              </div>
              <button className="icon" title="Refresh" aria-label="Refresh catalogue" onClick={() => void load()}>
                <RefreshCw size={16} aria-hidden />
              </button>
            </div>
            <p className="muted">Advertised by the runtime for your account. Not configured by hand.</p>
            {copilot.length === 0 && <p className="muted">No Copilot models advertised.</p>}
            {copilot.length > COPILOT_WINDOW && (
              <input
                type="search"
                aria-label="Search Copilot models"
                placeholder="Search models…"
                value={copilotQuery}
                onChange={(event) => setCopilotQuery(event.target.value)}
              />
            )}
            {copilot.length > 0 && copilotMatches.length === 0 && (
              <p className="muted">No model matches “{copilotQuery.trim()}”.</p>
            )}
            <ul className="dense-list">
              {copilotVisible.map((entry) => (
                <li key={entry.id}>
                  <button className="dense-row" onClick={() => setSelected(entry)}>
                    <span className="dense-name">{entry.displayName}</span>
                    <span className="muted dense-meta">{entry.capabilities.join(", ")}</span>
                    <span className={`pill${entry.available ? " ok" : " warn"}`}>
                      {entry.available ? "available" : "unavailable"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {(copilotHidden > 0 || copilotExpanded) && copilotMatches.length > COPILOT_WINDOW && (
              <button className="link" onClick={() => setCopilotExpanded(!copilotExpanded)}>
                {copilotExpanded ? "Show fewer" : `Show all ${copilotMatches.length}`}
              </button>
            )}
          </div>

          <div className="card">
            <div className="row between">
              <div className="row" style={{ gap: 8 }}>
                <Server size={16} aria-hidden />
                <h3 style={{ margin: 0 }}>Microsoft Foundry</h3>
              </div>
              <button title="Add Foundry model" aria-label="Add Foundry model" disabled={draft !== null} onClick={() => setDraft(blankDraft())}>
                <Plus size={16} aria-hidden /> Add
              </button>
            </div>
            <p className="muted">
              Reached with your Azure identity — no endpoint key is ever stored by this app.
            </p>

            {draft && (
              <FoundryForm
                draft={draft}
                projectBound={projectId !== null}
                onChange={setDraft}
                onSave={save}
                onCancel={() => setDraft(null)}
              />
            )}

            {foundry.length === 0 && !draft && <p className="muted">No Foundry entries yet.</p>}

            {foundry.map((entry) => (
              <div className="card nested" key={entry.id}>
                <div className="row between" onClick={() => setSelected(entry)}>
                  <div>
                    <strong>{entry.displayName}</strong>
                    <div className="muted">
                      {entry.endpointHost} · {entry.capabilities.join(", ")}
                    </div>
                  </div>
                  {entry.lastTest && <span className={`pill ${testTone(entry.lastTest.state)}`}>{entry.lastTest.state}</span>}
                </div>
                <div className="row" style={{ marginTop: 6 }}>
                  <button disabled={testing === entry.id} onClick={() => void test(entry)}>
                    {testing === entry.id ? "Testing…" : "Test"}
                  </button>
                  <button onClick={() => edit(entry)}>Edit</button>
                  <button className="icon danger" title="Remove" aria-label="Remove entry" onClick={() => void remove(entry)}>
                    <Trash2 size={16} aria-hidden />
                  </button>
                </div>
              </div>
            ))}
          </div>

        </div>

        <div className="detail-panel">
          {selected ? <EntryDetail entry={selected} /> : <p className="muted">Select a model to inspect it.</p>}
        </div>
      </div>
    </div>
  );
}

function EntryDetail({ entry }: { entry: ModelCatalogEntry }): JSX.Element {
  const parsed = parseModelId(entry.id);
  return (
    <div className="trace">
      <h3>{entry.displayName}</h3>
      <div className="trace-line">Provider: {parsed?.provider ?? "?"}</div>
      <div className="trace-line">Capabilities: {entry.capabilities.join(", ")}</div>
      {entry.endpointHost !== "" && <div className="trace-line">Endpoint host: {entry.endpointHost}</div>}
      <div className="trace-line">
        Scope: {entry.projectIds.length === 0 ? "all projects" : entry.projectIds.join(", ")}
      </div>
      {entry.lastTest ? (
        <>
          <div className="trace-line">Last test: {entry.lastTest.state}</div>
          <div className="trace-line">{entry.lastTest.message}</div>
          {entry.lastTest.nextStep !== "" && <div className="trace-line">Next: {entry.lastTest.nextStep}</div>}
          <div className="trace-line">Tested: {new Date(entry.lastTest.testedAt).toLocaleString()}</div>
        </>
      ) : (
        <div className="trace-line muted">Not tested yet.</div>
      )}
    </div>
  );
}

function FoundryForm({
  draft,
  projectBound,
  onChange,
  onSave,
  onCancel,
}: {
  draft: FoundryDraft;
  projectBound: boolean;
  onChange: (next: FoundryDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}): JSX.Element {
  const set = <K extends keyof FoundryDraft>(key: K, value: FoundryDraft[K]): void => onChange({ ...draft, [key]: value });
  const toggleCapability = (capability: ModelCapability): void => {
    const next = draft.capabilities.includes(capability)
      ? draft.capabilities.filter((value) => value !== capability)
      : [...draft.capabilities, capability];
    set("capabilities", next);
  };

  const endpointUsable = draft.endpoint.startsWith("https://") && draft.endpoint.length > "https://".length;
  /**
   * Image deployments use Foundry's OpenAI-compatible `/openai/v1` surface.
   *
   * The portal's current gpt-image-2 sample makes this easy to miss: it gives
   * a URL ending in `/openai/v1`, passes the deployment as `model` in the body,
   * and has no `api-version` parameter anywhere. Showing an API-version field
   * while someone is adding that model is not harmless extra configuration —
   * it asks for a value that is never sent, so it teaches the wrong API.
   *
   * Chat and reasoning still use Azure OpenAI's versioned deployment route and
   * genuinely need the value. Vision is input to that same chat route, but it
   * is not independently invokable, so it follows `chat` rather than making a
   * version field appear on an otherwise image-only entry.
   */
  const usesVersionedDeploymentApi =
    draft.capabilities.includes("chat") || draft.capabilities.includes("reasoning");

  const valid =
    draft.displayName.trim() !== "" &&
    endpointUsable &&
    draft.capabilities.length > 0 &&
    draft.deploymentName.trim() !== "";

  return (
    <div className="card approval model-form">
      <h3>{draft.id === "" ? "Add a Foundry model" : `Edit ${draft.displayName}`}</h3>

      <label>
        Endpoint URL
        <input
          className="mono"
          value={draft.endpoint}
          placeholder="https://‹endpoint-id›.services.ai.azure.com/openai/v1"
          onChange={(event) => set("endpoint", event.target.value)}
        />
        <span className="muted">
          Copy it from the Foundry sample verbatim. The resource root on its own works too — a
          trailing <span className="mono">/openai/v1</span> is recognised and stripped.
        </span>
      </label>

      <label>
        Deployment name
        <input
          value={draft.deploymentName}
          placeholder="gpt-image-2"
          onChange={(event) => set("deploymentName", event.target.value)}
        />
        <span className="muted">
          The name of the deployment in Foundry, not the model family. For Image Creation that is a
          gpt-image deployment — <span className="mono">gpt-image-2</span> in the current samples.
        </span>
      </label>

      <label>
        Display name
        <input
          value={draft.displayName}
          placeholder="How it appears in the picker"
          onChange={(event) => set("displayName", event.target.value)}
        />
      </label>

      {usesVersionedDeploymentApi ? (
        <label>
          API version
          <input
            className="mono"
            value={draft.apiVersion}
            onChange={(event) => set("apiVersion", event.target.value)}
          />
          <span className="muted">
            Required by chat and reasoning deployments, which use the versioned{" "}
            <span className="mono">/openai/deployments/…</span> route.
          </span>
        </label>
      ) : (
        <div className="model-field model-api-surface-note">
          <span>API surface</span>
          <span className="muted">
            This deployment uses the unversioned <span className="mono">/openai/v1</span> surface.
            Its deployment name is sent as <span className="mono">model</span>; no API version is
            requested or sent.
          </span>
        </div>
      )}

      {/* Not a `.field-row`: that pattern is a label beside a single control,
          and here the label sits over five of them. Stacked, the checkbox
          column lines up with the inputs above it instead of floating in the
          middle of the card. */}
      <div className="model-field">
        <span>Capabilities</span>
        <div className="capability-list">
          {CAPABILITIES.map((capability) => (
            <label className="tool-grant" key={capability}>
              <input type="checkbox" checked={draft.capabilities.includes(capability)} onChange={() => toggleCapability(capability)} />
              <span className="capability-name">{capability}</span>
              <span className="muted">{CAPABILITY_DETAIL[capability]}</span>
            </label>
          ))}
        </div>
      </div>

      {projectBound && (
        <label className="tool-grant">
          <input type="checkbox" checked={draft.restrictToProject} onChange={(event) => set("restrictToProject", event.target.checked)} />
          <span>Restrict to the current project</span>
        </label>
      )}

      <p className="muted">Authentication is your Azure identity. This form has no key field by design.</p>

      <div className="row">
        <button className="primary" disabled={!valid} onClick={onSave}>
          Save
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Role selection belongs at the end of Connections & access.
 *
 * Models are endpoints and identities; defaults decide which already-available
 * endpoint a feature uses. Keeping that decision after the connection cards
 * makes the setup order read top-to-bottom and keeps it from being mistaken
 * for a property of one particular Foundry registration.
 */
export function RoleDefaults({ projectId, onError }: CenterProps): JSX.Element | null {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);

  const load = useCallback(async () => {
    try {
      setCatalog(await call("models:catalog"));
    } catch (problem) {
      onError(problem);
    }
  }, [onError]);

  useEffect(() => {
    void load();
    return subscribe<ModelCatalog>("models:changed", setCatalog);
  }, [load]);

  if (catalog === null) return null;
  return <Defaults catalog={catalog} projectId={projectId} onError={onError} onChanged={load} />;
}

function Defaults({
  catalog,
  projectId,
  onError,
  onChanged,
}: {
  catalog: ModelCatalog;
  projectId: string | null;
  onError: (problem: unknown) => void;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const roles = ModelRole.options;

  const setDefault = async (role: ModelRole, modelId: string, scoped: boolean): Promise<void> => {
    try {
      await call("models:setDefault", {
        role,
        modelId: modelId === "" ? null : modelId,
        projectId: scoped ? projectId : null,
      });
      await onChanged();
    } catch (problem) {
      onError(problem);
    }
  };

  const eligibleFor = (role: ModelRole): ModelCatalogEntry[] =>
    catalog.entries.filter((entry) => entry.capabilities.includes(MODEL_ROLE_CAPABILITY[role]));

  const globalFor = (role: ModelRole): string => catalog.defaults.roles[role] ?? "";
  const projectFor = (role: ModelRole): string => {
    if (!projectId) return "";
    const scoped = catalog.defaults.projects[projectId];
    return (scoped && scoped[role]) ?? "";
  };

  return (
    <div className="card">
      <h3>Role defaults</h3>
      <p className="muted">
        Layered: a role default, an optional per-project override, and a per-turn override from
        the composer. The composer reads this catalogue; it is never a separate list.
      </p>
      <table>
        <thead>
          <tr>
            <th>Role</th>
            <th>Default</th>
            {projectId && <th>This project</th>}
          </tr>
        </thead>
        <tbody>
          {roles.map((role) => {
            const options = eligibleFor(role);
            return (
              <tr key={role}>
                <td>{MODEL_ROLE_LABELS[role]}</td>
                <td>
                  <select value={globalFor(role)} onChange={(event) => void setDefault(role, event.target.value, false)}>
                    <option value="">Runtime default</option>
                    {options.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.displayName}
                      </option>
                    ))}
                  </select>
                </td>
                {projectId && (
                  <td>
                    <select value={projectFor(role)} onChange={(event) => void setDefault(role, event.target.value, true)}>
                      <option value="">Use role default</option>
                      {options.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.displayName}
                        </option>
                      ))}
                    </select>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted">
        <ExternalLink size={12} aria-hidden /> These entries are what appear in Connections &amp; access.
      </p>
    </div>
  );
}

function testTone(state: string): string {
  switch (state) {
    case "reachable":
      return "ok";
    case "unauthorized":
    case "not_found":
    case "failed":
      return "bad";
    default:
      return "";
  }
}
