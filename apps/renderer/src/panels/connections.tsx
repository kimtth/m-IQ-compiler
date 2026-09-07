import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import type {
  AuthStatus,
  CopilotAuthStatus,
  FabricDataAgentMode,
  FabricDataAgentStatus,
  FabricSkillPack,
  FabricStatus,
  FabricWorkspace,
  SpeechStatus,
  SpeechTestResult,
} from "@iq/shared";
import { call, subscribe } from "../bridge.js";
import { Modal } from "../Modal.js";
import { FormField, useRegistration } from "./registration.js";

/**
 * Connections & access.
 *
 * The destinations this app reaches and the identity it reaches them with,
 * registered before they are needed. Every one of these fails in the middle of
 * a user action when it is wrong, so the point of the surface is to move that
 * failure earlier — which is why each card offers a Test that makes the same
 * round trip the real thing will.
 */

/**
 * Panel props.
 *
 * Re-declared per module rather than imported from a common file: `{ onError }`
 * is not a shared concept, it is the same two words. The old `panels.tsx` held
 * nine components and two disjoint importers with `PanelProps` as the only
 * thing they had in common, which is not enough to be a module.
 */
export interface PanelProps {
  onError: (problem: unknown) => void;
  /** The scope anything compiled from a panel is published into. */
  projectId?: string | null;
}
// --- identity ---------------------------------------------------------------

/**
 * The two connections the app depends on, shown side by side.
 *
 * GitHub Copilot backs the agent runtime and is required; Microsoft is optional
 * and only needed once a capability reaches into M365 or Azure. Showing both
 * here — with their state visible before anything is invoked — is what stops a
 * missing connection from surfacing as a failed turn.
 */
export function Identity({ auth, onError }: { auth: AuthStatus } & PanelProps): JSX.Element {
  return (
    <div className="stack">
      <CopilotConnection onError={onError} />
      <MicrosoftConnection auth={auth} onError={onError} />
    </div>
  );
}

function CopilotConnection({ onError }: PanelProps): JSX.Element {
  const [status, setStatus] = useState<CopilotAuthStatus>({ state: "unknown" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setStatus(await call("auth:copilotStatus"));
    } catch (problem) {
      onError(problem);
    } finally {
      setBusy(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="card">
      <div className="row between">
        <strong>GitHub Copilot</strong>
        <button disabled={busy} onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        {status.state === "signed_in" ? (
          <>
            <span className="pill ok">Connected</span>
            <span className="muted">
              {status.login ?? "signed in"}
              {status.authType && status.authType !== "user" ? ` · via ${status.authType}` : ""}
            </span>
          </>
        ) : status.state === "unknown" ? (
          <span className="pill">Starting…</span>
        ) : (
          <span className="pill warn">Not connected</span>
        )}
      </div>
      {status.state === "signed_out" || status.state === "error" ? (
        <p className="hint">{status.message}</p>
      ) : null}
      <p className="hint">
        The agent runtime owns this credential. Sign in once with the Copilot CLI device flow; IQ
        Compiler never stores a GitHub token.
      </p>
    </div>
  );
}

function MicrosoftConnection({ auth, onError }: { auth: AuthStatus } & PanelProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [tenant, setTenant] = useState("");
  const [editingTenant, setEditingTenant] = useState(false);

  useEffect(() => {
    call("auth:tenant")
      .then((value) => setTenant(value.tenantId ?? ""))
      .catch(() => undefined);
  }, [auth.state]);

  const signIn = async (): Promise<void> => {
    setBusy(true);
    try {
      await call("auth:signIn", { tenantId: tenant.trim() ? tenant.trim() : null });
      setEditingTenant(false);
    } catch (problem) {
      onError(problem);
    } finally {
      setBusy(false);
    }
  };

  const signOut = async (): Promise<void> => {
    setBusy(true);
    try {
      await call("auth:signOut");
    } catch (problem) {
      onError(problem);
    } finally {
      setBusy(false);
    }
  };

  if (auth.state === "cli_missing") {
    return (
      <div className="card">
        <div className="row between">
          <strong>Microsoft</strong>
          <span className="pill warn">Unavailable</span>
        </div>
        <p className="hint">{auth.message}</p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="row between">
        <strong>Microsoft</strong>
        {auth.state === "signed_in" ? (
          <span className="pill ok">Connected</span>
        ) : auth.state === "signing_in" ? (
          <span className="pill">Signing in…</span>
        ) : (
          <span className="pill warn">Not connected</span>
        )}
      </div>

      {auth.state === "signed_in" ? (
        <>
          <div className="muted" style={{ marginTop: 8 }}>
            {auth.account.username}
          </div>
          <div className="muted mono" style={{ fontSize: 11 }}>
            tenant {auth.account.tenantId}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button disabled={busy} onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
          {auth.grantedScopes.length > 0 ? (
            <p className="hint">Consented capabilities: {auth.grantedScopes.join(", ")}</p>
          ) : (
            <p className="hint">No capability has requested access yet.</p>
          )}
        </>
      ) : (
        <>
          {auth.state === "error" ? <p className="hint">{auth.message}</p> : null}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" disabled={busy} onClick={() => void signIn()}>
              Connect Microsoft account
            </button>
            {editingTenant ? (
              <input
                className="mono"
                value={tenant}
                placeholder="tenant id (optional)"
                onChange={(event) => setTenant(event.target.value)}
              />
            ) : (
              <button onClick={() => setEditingTenant(true)}>
                {tenant ? `Tenant: ${tenant}` : "Use a specific tenant"}
              </button>
            )}
          </div>
          <p className="hint">
            No app registration is required. Sign-in runs the Azure CLI; leave the tenant blank to
            use your home tenant.
          </p>
        </>
      )}
    </div>
  );
}

// --- speech -----------------------------------------------------------------

const EMPTY_SPEECH_FORM = {
  displayName: "Azure AI Speech",
  endpoint: "",
  locale: "en-US",
  /**
   * Carried, never offered.
   *
   * There is no Voice field on this form. A voice name is a Speech catalogue
   * identifier — `en-US-AvaMultilingualNeural` — and a free-text box asking for
   * one is a box almost everyone gets wrong: a typo registers cleanly and then
   * fails at the first spoken reply, in the middle of a user action, which is
   * exactly the failure this whole panel exists to move earlier.
   *
   * The value still travels with the registration so that editing an entry
   * cannot silently reset a voice that is already in use — one set by
   * `IQ_SPEECH_VOICE`, or by a registration made before this field was
   * removed. New registrations take the default, and a caller that needs a
   * different one passes it per request on `speech:synthesize`.
   */
  voice: "en-US-AvaMultilingualNeural",
};

type SpeechForm = typeof EMPTY_SPEECH_FORM;

/**
 * Azure AI Speech, registered before it is needed.
 *
 * Voice input, spoken replies and meeting transcription all fail in the middle
 * of a user action when the resource is wrong, so the resource is added here
 * explicitly and checked with the same round-trip a Foundry model entry has.
 *
 * There is no key field. The resource is reached with the signed-in Azure
 * identity, which is the only mode many tenants permit and the only one this
 * app implements — so registering is naming a destination, not handing over a
 * secret, and nothing here would be dangerous to read back.
 *
 * The destination is the resource's **custom domain** endpoint. Microsoft Entra
 * authentication is only accepted on one, so a regional endpoint is not a
 * lesser option here, it is a 401 with nothing in it to explain itself.
 */
export function SpeechConnection({ onError }: PanelProps): JSX.Element {
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  const [result, setResult] = useState<SpeechTestResult | null>(null);
  const [form, setForm] = useState<SpeechForm | null>(null);
  const { busy, run } = useRegistration(onError);

  useEffect(() => {
    // The window opens before core startup completes. The first status read
    // can therefore be the deliberate "not configured yet" placeholder while
    // SpeechRegistry is still loading speech.json; `speech:changed` is the
    // definitive state after that load and after every register/remove.
    // Subscribe *before* the read: otherwise the startup event can land in the
    // tiny gap after `speech:status` returned the placeholder and before the
    // renderer began listening, leaving this card disabled until a restart.
    const stop = subscribe<SpeechStatus>("speech:changed", setStatus);
    void call("speech:status").then(setStatus).catch(onError);
    return stop;
  }, [onError]);

  const test = async (): Promise<void> => {
    await run(async () => {
      setResult(await call("speech:test"));
      setStatus(await call("speech:status"));
    });
  };

  const save = async (): Promise<void> => {
    if (!form) return;
    await run(async () => {
      const next = await call("speech:register", {
        displayName: form.displayName.trim() || "Azure AI Speech",
        endpoint: form.endpoint.trim(),
        locale: form.locale.trim() || "en-US",
        voice: form.voice.trim() || "en-US-AvaMultilingualNeural",
      });
      setStatus(next);
      // A new destination invalidates any earlier verification.
      setResult(null);
      setForm(null);
    });
  };

  const remove = async (): Promise<void> => {
    await run(async () => {
      setStatus(await call("speech:remove"));
      setResult(null);
    });
  };

  const ready = status?.state === "ready";
  const editable = status?.state === "ready" ? status.editable : true;

  const startEdit = (): void => {
    setForm(
      status?.state === "ready"
        ? {
            displayName: status.displayName,
            endpoint: status.endpoint,
            locale: status.locale,
            voice: status.voice,
          }
        : { ...EMPTY_SPEECH_FORM },
    );
  };

  const field = (
    label: string,
    key: keyof SpeechForm,
    placeholder: string,
    hint?: string,
  ): JSX.Element => (
    <FormField
      key={key}
      label={label}
      value={form?.[key] ?? ""}
      placeholder={placeholder}
      {...(hint === undefined ? {} : { hint })}
      onChange={(next) =>
        setForm((current) => (current ? { ...current, [key]: next } : current))
      }
    />
  );

  return (
    <div className="card">
      <div className="row between">
        <strong>Azure AI Speech</strong>
        {ready ? (
          <span className="pill ok">Connected</span>
        ) : status ? (
          <span className="pill warn">Not registered</span>
        ) : (
          <span className="pill">Checking…</span>
        )}
      </div>

      {status?.state === "ready" ? (
        <div className="muted" style={{ marginTop: 8 }}>
          {status.displayName} · managed identity · {status.locale}
          {status.source === "environment" && " · from host environment"}
        </div>
      ) : status ? (
        <p className="hint">{status.message}</p>
      ) : null}

      {status?.state === "ready" && (
        <div className="muted" style={{ marginTop: 4, wordBreak: "break-all" }}>
          {status.endpoint}
        </div>
      )}

      {form ? (
        <div className="stack" style={{ marginTop: 12 }}>
          {field("Display name", "displayName", "Azure AI Speech")}
          {field(
            "Speech custom domain endpoint",
            "endpoint",
            "https://‹name›.cognitiveservices.azure.com",
            "From Keys and Endpoint on the resource. A custom-domain Speech resource routes REST calls differently from a regional endpoint, so paste this exact base URL. IQ Compiler uses your Azure identity and stores no key: assign Cognitive Services Speech User and set Networking to All networks; selected/private networks require a resource key for Speech STT/TTS endpoints.",
          )}
          {field("Locale", "locale", "en-US")}
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save resource"}
            </button>
            <button disabled={busy} onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="row" style={{ marginTop: 8 }}>
          {editable && (
            <button className={ready ? undefined : "primary"} disabled={busy} onClick={startEdit}>
              {ready ? "Edit resource" : "Add Speech resource"}
            </button>
          )}
          <button disabled={busy || !ready} onClick={() => void test()}>
            {busy ? "Testing…" : "Test connection"}
          </button>
          {ready && editable && (
            <button className="danger" disabled={busy} onClick={() => void remove()}>
              Remove
            </button>
          )}
          {result && (
            <span className={`pill ${result.state === "reachable" ? "ok" : "warn"}`}>
              {result.state.replace("_", " ")}
            </span>
          )}
          {result && (
            <span className="muted">last tested {new Date(result.testedAt).toLocaleString()}</span>
          )}
        </div>
      )}

      {result && result.state !== "reachable" && (
        <p className="hint">
          {result.message} {result.nextStep}
        </p>
      )}

      <p className="hint">
        Audio reaches the tenant's own Speech resource and nothing else. Access uses your signed-in
        Azure identity — resource keys are not supported and none is stored, so the identity needs
        the Cognitive Services User role on the resource.
      </p>
    </div>
  );
}

// --- fabric -----------------------------------------------------------------

const EMPTY_FABRIC_FORM = {
  displayName: "Microsoft Fabric",
  workspaceId: "",
  workspaceName: "",
};

type FabricForm = typeof EMPTY_FABRIC_FORM;

/**
 * Pick a workspace from the ones the identity can actually see.
 *
 * A tenant hands most people several workspaces, and the only thing that
 * identifies one on the wire is a GUID. Typing it from memory is not a real
 * option, and pasting the wrong one is silent: it registers, it tests green,
 * and the first sign of trouble is a lakehouse in someone else's workspace.
 * So the field stays — an id pasted from a portal URL is still the fastest
 * route when you have it — and this is the other way in.
 *
 * The list is fetched when the dialog opens rather than with the card. It is a
 * network call per tenant with a token behind it, and the overwhelming majority
 * of visits to this surface are to read the state of a connection that already
 * exists.
 *
 * A workspace on no capacity is shown and is pickable, with a warning. Hiding
 * it would be worse: it is a real workspace the user knows they have, and
 * "it is not in the list" sends them looking for a permissions problem that is
 * not there. Fabric refuses writes on it with a 403 that reads like access.
 */
function WorkspacePicker({
  current,
  onPick,
  onClose,
}: {
  /** Marked in the list, so re-opening shows what is registered now. */
  current: string;
  onPick: (workspace: FabricWorkspace) => void;
  onClose: () => void;
}): JSX.Element {
  const [workspaces, setWorkspaces] = useState<FabricWorkspace[] | null>(null);
  // Held on the dialog, not raised to the shell: "you cannot list workspaces"
  // is this dialog's answer, and it is the same class of thing as an empty list.
  const [failure, setFailure] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let live = true;
    call("fabric:workspaces")
      .then((rows) => {
        if (live) setWorkspaces(rows);
      })
      .catch((problem: unknown) => {
        if (live) setFailure(problem instanceof Error ? problem.message : String(problem));
      });
    return () => {
      live = false;
    };
  }, []);

  const needle = filter.trim().toLowerCase();
  const shown = (workspaces ?? []).filter(
    (workspace) =>
      needle === "" ||
      workspace.displayName.toLowerCase().includes(needle) ||
      workspace.id.toLowerCase().includes(needle),
  );

  return (
    <Modal title="Choose a Fabric workspace" onClose={onClose}>
      {failure !== null ? (
        <p className="muted">{failure}</p>
      ) : workspaces === null ? (
        <p className="muted">Listing the workspaces you can see…</p>
      ) : workspaces.length === 0 ? (
        <p className="muted">
          Your Azure identity can see no Fabric workspaces. Ask for access in the Fabric portal, or
          paste the workspace id if you have it.
        </p>
      ) : (
        <>
          <input
            type="search"
            placeholder="Filter by name or id"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            style={{ width: "100%", marginBottom: 12 }}
          />
          <div className="picker-list">
            {shown.map((workspace) => (
              <button
                key={workspace.id}
                className="picker-row"
                aria-current={workspace.id === current}
                onClick={() => onPick(workspace)}
              >
                <span className="row" style={{ gap: 8 }}>
                  <strong>{workspace.displayName || "(unnamed workspace)"}</strong>
                  {workspace.capacityId === "" && (
                    <span className="pill warn" title="Fabric refuses writes on a workspace with no capacity">
                      no capacity
                    </span>
                  )}
                </span>
                <span className="mono muted">{workspace.id}</span>
              </button>
            ))}
            {shown.length === 0 && <p className="muted">No workspace matches “{filter}”.</p>}
          </div>
        </>
      )}
    </Modal>
  );
}

/**
 * The Microsoft Fabric workspace, registered before anything is built in it.
 *
 * One workspace, not a list. The Foundry registry is a list because a user
 * genuinely runs several deployments at once; a Fabric co-creation *creates
 * things*, and offering five workspaces in a picker is how a lakehouse lands in
 * the wrong one.
 *
 * No key field, for the third time in this file and for the same reason: Fabric
 * is reached with the signed-in Azure identity. Registering names a destination
 * rather than handing over a secret, so the whole record is safe to read back.
 *
 * **The workspace and nothing else.** A Data Agent URL used to be a field here;
 * it is now its own card below, because the two are separately obtainable —
 * someone who was handed a published agent needs no workspace, and someone
 * building artifacts may have no agent published.
 *
 * The skill-bundle path sits here rather than in the Fabric surface because it
 * is a connection to a source of knowledge in exactly the sense the rest of
 * this card means: without it, runs are refused.
 */
export function FabricConnection({ onError }: PanelProps): JSX.Element {
  const [status, setStatus] = useState<FabricStatus | null>(null);
  const [pack, setPack] = useState<FabricSkillPack | null>(null);
  const [form, setForm] = useState<FabricForm | null>(null);
  const [picking, setPicking] = useState(false);
  const { busy, run } = useRegistration(onError);
  const [tested, setTested] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await call("fabric:status"));
      setPack(await call("fabric:skillPack"));
    } catch (problem) {
      onError(problem);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<void> => {
    if (form === null) return;
    await run(async () => {
      await call("fabric:save", form);
      setForm(null);
      setTested(null);
      await load();
    });
  };

  const test = async (): Promise<void> => {
    // Reported on the card rather than to the shell: an unreachable workspace
    // is this card's answer, not an application error.
    await run(async () => {
      try {
        const result = await call("fabric:test");
        setTested(
          result.name === ""
            ? "Reachable, but the workspace reported no name."
            : `Reachable — ${result.name}.`,
        );
      } catch (problem) {
        setTested(problem instanceof Error ? problem.message : String(problem));
      }
      await load();
    });
  };

  const remove = async (): Promise<void> => {
    if (!window.confirm("Remove the Fabric workspace registration?")) return;
    await run(async () => {
      await call("fabric:remove");
      setTested(null);
      await load();
    });
  };

  const field = (label: string, key: keyof FabricForm, placeholder: string): JSX.Element => (
    <FormField
      key={key}
      label={label}
      mono
      placeholder={placeholder}
      value={form?.[key] ?? ""}
      onChange={(next) => form !== null && setForm({ ...form, [key]: next })}
    />
  );

  return (
    <div className="card">
      <div className="row between">
        <h3>Microsoft Fabric</h3>
        {status?.state === "ready" ? (
          <span className="pill ok">{status.source === "environment" ? "environment" : "ready"}</span>
        ) : (
          <span className="pill">not configured</span>
        )}
      </div>

      {form !== null ? (
        <>
          {field("Display name", "displayName", "Microsoft Fabric")}
          {field(
            "Workspace id",
            "workspaceId",
            "the GUID from the Fabric workspace URL",
          )}
          {/* Beside the field, not instead of it. Pasting an id from a portal
              URL is faster when you have one; the picker is for when you do
              not, which is most of the time. */}
          <div className="row">
            <button onClick={() => setPicking(true)}>Choose from my workspaces…</button>
            {form.workspaceName !== "" && <span className="muted">{form.workspaceName}</span>}
          </div>
          <p className="muted">
            Reached with your Azure identity. There is no key field by design. A Data Agent is
            connected separately, below.
          </p>
          <div className="row">
            <button
              className="primary"
              disabled={busy || form.workspaceId.trim() === ""}
              onClick={() => void save()}
            >
              Save
            </button>
            <button onClick={() => setForm(null)}>Cancel</button>
          </div>
        </>
      ) : status?.state === "ready" ? (
        <>
          <div className="muted">
            {status.workspaceName || "(unnamed workspace)"} · <span className="mono">{status.workspaceId}</span>
          </div>
          {tested !== null && <div className="status-line">{tested}</div>}
          <div className="row" style={{ marginTop: 8 }}>
            <button disabled={busy} onClick={() => void test()}>
              Test
            </button>
            {status.editable && (
              <>
                <button
                  onClick={() =>
                    setForm({
                      displayName: status.displayName,
                      workspaceId: status.workspaceId,
                      workspaceName: status.workspaceName,
                    })
                  }
                >
                  Edit
                </button>
                <button className="danger" disabled={busy} onClick={() => void remove()}>
                  Remove
                </button>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="muted">{status?.message}</p>
          <button className="primary" onClick={() => setForm({ ...EMPTY_FABRIC_FORM })}>
            Add Fabric workspace
          </button>
        </>
      )}

      {/* The knowledge the runs stand on. Shown beside the connection because
          without it a run is refused, which makes it a dependency in exactly
          the sense this card is about. */}
      <div className="row between" style={{ marginTop: 12 }}>
        <strong>Fabric skills</strong>
        {pack?.available ? (
          <span className="pill ok">
            skills-for-fabric {pack.version || "unversioned"} · {pack.source}
          </span>
        ) : (
          <span className="pill bad">not found</span>
        )}
      </div>
      <p className="muted">
        {pack?.available
          ? `${pack.skills.length} skills, ${pack.agents.length} agents and ${pack.references.length} shared references across ${pack.bundles.join(", ")}, resolved from ${pack.root}. Runs read these before acting, so Fabric API changes arrive by updating the bundle. Listed in full under Skills.`
          : pack?.message}
      </p>

      {picking && (
        <WorkspacePicker
          current={form?.workspaceId ?? ""}
          onClose={() => setPicking(false)}
          onPick={(workspace) => {
            // The name is carried across so the card reads properly straight
            // away. Otherwise it says "(unnamed workspace)" until someone
            // presses Test, which looks like the pick did not take.
            setForm((previous) => ({
              ...(previous ?? EMPTY_FABRIC_FORM),
              workspaceId: workspace.id,
              workspaceName: workspace.displayName,
            }));
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

// --- fabric data agent ------------------------------------------------------

const EMPTY_DATA_AGENT_FORM = {
  displayName: "Fabric Data Agent",
  mode: "workspace" as FabricDataAgentMode,
  workspaceId: "",
  dataAgentId: "",
  url: "",
};

type DataAgentForm = typeof EMPTY_DATA_AGENT_FORM;

/**
 * The Fabric Data Agent, connected by either route.
 *
 * Its own card rather than a field on the Fabric workspace, because the two are
 * separately obtainable and separately useful. Someone who was sent a published
 * Data Agent URL has no workspace to register; someone building a lakehouse may
 * have no agent published yet. Coupling them meant the Q&A surface was hidden
 * behind a workspace registration that had nothing to do with it.
 *
 * Two modes, mirroring the reference app, which offers a workspace-mediated
 * route and a direct one for the same reason:
 *
 *  - **In a Fabric workspace** — the Data Agent's item GUID, which is what
 *    someone looking at it in the portal already has. The endpoint is composed
 *    from it, so nobody has to know that the path ends `aiassistant/openai`.
 *  - **Published URL** — the URL verbatim, for an agent someone was given
 *    access to without access to the workspace around it.
 *
 * Both dial the same API with the same Azure identity. Neither takes a key.
 */
export function DataAgentConnection({ onError }: PanelProps): JSX.Element {
  const [status, setStatus] = useState<FabricDataAgentStatus | null>(null);
  const [form, setForm] = useState<DataAgentForm | null>(null);
  const { busy, run } = useRegistration(onError);
  const [tested, setTested] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await call("dataAgent:status"));
    } catch (problem) {
      onError(problem);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<void> => {
    if (form === null) return;
    await run(async () => {
      await call("dataAgent:save", form);
      setForm(null);
      setTested(null);
      await load();
    });
  };

  const test = async (): Promise<void> => {
    // Reported on the card, like Fabric's: an unreachable agent is this card's
    // answer, not an application error.
    await run(async () => {
      try {
        const result = await call("dataAgent:test");
        setTested(`Reachable — the agent answered "${result.answer.slice(0, 80)}".`);
      } catch (problem) {
        setTested(problem instanceof Error ? problem.message : String(problem));
      }
      await load();
    });
  };

  const remove = async (): Promise<void> => {
    if (!window.confirm("Remove the Fabric Data Agent connection?")) return;
    await run(async () => {
      await call("dataAgent:remove");
      setTested(null);
      await load();
    });
  };

  const valid =
    form !== null &&
    (form.mode === "workspace" ? form.dataAgentId.trim() !== "" : form.url.trim().startsWith("https://"));

  return (
    <div className="card">
      <div className="row between">
        <h3>Fabric Data Agent</h3>
        {status?.state === "ready" ? (
          <span className="pill ok">{status.source === "environment" ? "environment" : "ready"}</span>
        ) : status?.state === "needs_workspace" ? (
          <span className="pill warn">needs a workspace</span>
        ) : (
          <span className="pill">not connected</span>
        )}
      </div>

      {form !== null ? (
        <>
          <label>
            Display name
            <input
              value={form.displayName}
              onChange={(event) => setForm({ ...form, displayName: event.target.value })}
            />
          </label>

          <label>
            Connect by
            <select
              value={form.mode}
              onChange={(event) =>
                setForm({ ...form, mode: event.target.value as FabricDataAgentMode })
              }
            >
              <option value="workspace">Its id in a Fabric workspace</option>
              <option value="direct">A published Data Agent URL</option>
            </select>
          </label>

          {form.mode === "workspace" ? (
            <>
              <label>
                Data Agent id
                <input
                  className="mono"
                  placeholder="the GUID from the Data Agent's Fabric URL"
                  value={form.dataAgentId}
                  onChange={(event) => setForm({ ...form, dataAgentId: event.target.value })}
                />
              </label>
              <label>
                Project id (optional)
                <input
                  className="mono"
                  placeholder="leave blank to use the registered Fabric workspace"
                  value={form.workspaceId}
                  onChange={(event) => setForm({ ...form, workspaceId: event.target.value })}
                />
              </label>
              <p className="muted">
                The endpoint is composed from these two, so the
                <span className="mono"> aiassistant/openai </span>
                path is not something you have to know.
              </p>
            </>
          ) : (
            <>
              <label>
                Published Data Agent URL
                <input
                  className="mono"
                  placeholder="https://…/dataagents/…/aiassistant/openai"
                  value={form.url}
                  onChange={(event) => setForm({ ...form, url: event.target.value })}
                />
              </label>
              <p className="muted">
                Paste it exactly as the portal gives it. Older URLs saying
                <span className="mono"> aiskills </span>
                still work — they are rewritten when dialled.
              </p>
            </>
          )}

          <p className="muted">
            Reached with your Azure identity, so it sees exactly what you are allowed to see. There
            is no key field by design.
          </p>
          <div className="row">
            <button className="primary" disabled={busy || !valid} onClick={() => void save()}>
              Save
            </button>
            <button onClick={() => setForm(null)}>Cancel</button>
          </div>
        </>
      ) : status?.state === "ready" ? (
        <>
          <div className="muted">
            {status.displayName} ·{" "}
            {status.mode === "workspace" ? "connected by workspace" : "connected by published URL"}
          </div>
          <div className="muted">
            <span className="mono">{status.host}</span>
            {status.workspaceId !== "" && (
              <>
                {" · workspace "}
                <span className="mono">{status.workspaceId}</span>
              </>
            )}
          </div>
          {tested !== null && <div className="status-line">{tested}</div>}
          <div className="row" style={{ marginTop: 8 }}>
            {/* The test is a real question, because a probe that only resolved
                DNS would call an agent "reachable" whose thread route rejects
                the token — which is the failure people actually hit. */}
            <button disabled={busy} onClick={() => void test()}>
              {busy ? "Asking…" : "Test with a question"}
            </button>
            {status.editable && (
              <>
                <button
                  onClick={() =>
                    setForm({
                      ...EMPTY_DATA_AGENT_FORM,
                      displayName: status.displayName,
                      mode: status.mode,
                      workspaceId: status.mode === "workspace" ? status.workspaceId : "",
                    })
                  }
                >
                  Edit
                </button>
                <button className="danger" disabled={busy} onClick={() => void remove()}>
                  Remove
                </button>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="muted">{status?.message}</p>
          <button className="primary" onClick={() => setForm({ ...EMPTY_DATA_AGENT_FORM })}>
            Connect a Data Agent
          </button>
        </>
      )}
    </div>
  );
}
