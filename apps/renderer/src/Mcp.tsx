import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import {
  MCP_CATALOG,
  catalogEntryToInput,
  type McpCatalogEntry,
  type McpInspectResult,
  type McpServerInput,
  type McpServerRecord,
  type McpSetupStep,
  type MyIqStatus,
} from "@iq/shared";
import { call } from "./bridge.js";
import { useAction } from "./useAction.js";

/**
 * MCP server configuration.
 *
 * An MCP server is a third party that supplies tools the agent may call, so the
 * flow here is a consent flow, not a settings form. It is ordered so that the
 * only way to reach a live tool is through the steps that make it reviewable:
 *
 *   add (inert) → inspect (read what it offers) → approve tools individually →
 *   enable the server
 *
 * Nothing is skippable. A server cannot be enabled with no approved tools,
 * approving a tool the server has not advertised is refused, and editing where
 * a server points clears its approvals — consent was given to a particular
 * party, not to an id.
 *
 * Secrets are write-only. Values typed here go to the privileged process and
 * are never read back; the UI shows only which keys are set.
 */

const BLANK: McpServerInput = {
  id: "",
  label: "",
  transport: "stdio",
  command: "",
  args: [],
  env: {},
  url: "",
  headers: {},
};

/**
 * Above this many tools a server's list arrives hidden.
 *
 * The powerbi-modeling server advertises 21 tools, each with a paragraph of
 * description, which pushes Inspect/Enable/Edit/Remove a screen and a half
 * below the server they belong to and buries every other configured server
 * under one of them. A short list is left open: hiding three tools would only
 * add a click to the thing the page exists for.
 */
const TOOLS_SHOWN_OPEN = 6;

/** The catalog's setup steps for a configured server, or none if it is not one. */
function setupFor(id: string): McpSetupStep[] {
  return MCP_CATALOG.find((entry) => entry.id === id)?.setupSteps ?? [];
}

/**
 * What the user has to do outside this app before a server will answer.
 *
 * Rendered as an ordered list of copyable commands rather than a paragraph,
 * because order matters and the text is meant to be run verbatim. Nothing here
 * is a button: each one signs a licence, authenticates a person in a browser,
 * or grants a consent, and a tools page must not be able to do any of those on
 * someone's behalf.
 */
function SetupSteps({ steps }: { steps: readonly McpSetupStep[] }): JSX.Element | null {
  if (steps.length === 0) return null;
  return (
    <div className="mcp-setup">
      <strong>Before this server can answer</strong>
      <ol>
        {steps.map((step) => (
          <li key={step.caption}>
            <span className="muted">{step.caption}</span>
            {step.command !== "" && (
              <pre>
                <code>{step.command}</code>
              </pre>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function McpServers({ onError }: { onError: (problem: unknown) => void }): JSX.Element {
  return (
    <>
      <PublishedMyIq onError={onError} />
      <ConfiguredServers onError={onError} />
    </>
  );
}

/**
 * The server this app publishes.
 *
 * It sits above the configured list and outside it because it is the other
 * direction entirely: everything below is a third party this app has been given
 * permission to call, and this is My IQ being offered to something else. Putting
 * it in the same list would mean a row that cannot be inspected, approved or
 * enabled, and whose Remove would mean something different from every other
 * Remove on the page.
 */
function PublishedMyIq({ onError }: { onError: (problem: unknown) => void }): JSX.Element {
  const [status, setStatus] = useState<MyIqStatus | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    call("myiq:status")
      .then(setStatus)
      .catch((problem: unknown) => onError(problem));
  }, [onError]);

  if (status === null) return <></>;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>My IQ, published to other apps</h3>
        <span className={`pill${status.published ? " ok" : ""}`}>
          {status.published ? "published" : "not published"}
        </span>
      </div>
      {status.published ? (
        <>
          <p className="muted">
            {status.cellCount} IQ Cells, {status.memoryCount} memories and {status.noteCount}{" "}
            knowledge notes
            {status.hasConnectome ? ", with the My IQ analysis," : ""} are readable by any
            app that speaks MCP. Sample data, read-only. Published{" "}
            {new Date(status.publishedAt).toLocaleString()}.
          </p>
          <p className="muted">
            Nothing runs until another app launches it. Re-publish from My IQ to
            refresh what it serves.
          </p>
          <pre className="source">{status.endpoint.clientConfig}</pre>
          <div className="row">
            <button
              onClick={() => {
                void navigator.clipboard
                  .writeText(status.endpoint.clientConfig)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? "Copied" : "Copy configuration"}
            </button>
          </div>
        </>
      ) : (
        <p className="muted">
          Nothing has been published yet. Open My IQ, run the analysis and press
          Publish to make your IQ Cells, memories and knowledge notes readable from VS Code,
          Claude Desktop or anything else that speaks MCP. It serves sample data only.
        </p>
      )}
    </div>
  );
}

function ConfiguredServers({ onError }: { onError: (problem: unknown) => void }): JSX.Element {
  const [servers, setServers] = useState<McpServerRecord[]>([]);
  const [draft, setDraft] = useState<McpServerInput | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [inspecting, setInspecting] = useState("");
  const [result, setResult] = useState<McpInspectResult | null>(null);
  /** Per-server overrides of the length rule above. Absent = whatever the rule says. */
  const [toolsOpen, setToolsOpen] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setServers(await call("mcp:list"));
  }, []);

  const { run } = useAction(onError);

  useEffect(() => {
    void run(load);
  }, [run, load]);

  const save = async (): Promise<void> => {
    if (!draft) return;
    await run(async () => {
      await call("mcp:upsert", draft);
      setDraft(null);
      await load();
    });
  };

  const inspect = async (id: string): Promise<void> => {
    setInspecting(id);
    setResult(null);
    try {
      setResult(await call("mcp:inspect", { id }));
      await load();
    } catch (problem) {
      onError(problem);
    } finally {
      setInspecting("");
    }
  };

  const toggleTool = async (server: McpServerRecord, tool: string): Promise<void> => {
    const next = server.approvedTools.includes(tool)
      ? server.approvedTools.filter((name) => name !== tool)
      : [...server.approvedTools, tool];
    await run(async () => {
      await call("mcp:approveTools", { id: server.id, tools: next });
      await load();
    });
  };

  /**
   * Drop approvals for tools the server has stopped advertising.
   *
   * Separate from `toggleTool` because it is a different decision: the tool is
   * not there to be ticked, so there is no checkbox to express it with, and
   * revoking is the only thing left that can be done to it.
   */
  const dropStale = async (server: McpServerRecord): Promise<void> => {
    const advertised = new Set(server.discoveredTools.map((tool) => tool.name));
    await run(async () => {
      await call("mcp:approveTools", {
        id: server.id,
        tools: server.approvedTools.filter((name) => advertised.has(name)),
      });
      await load();
    });
  };

  const setEnabled = async (server: McpServerRecord, enabled: boolean): Promise<void> => {
    await run(async () => {
      await call("mcp:setEnabled", { id: server.id, enabled });
      await load();
    });
  };

  const remove = async (id: string): Promise<void> => {
    await run(async () => {
      await call("mcp:remove", { id });
      await load();
    });
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>MCP servers</h3>
        <div className="row">
          <button
            onClick={() => {
              setCatalogOpen(!catalogOpen);
              setDraft(null);
            }}
          >
            {catalogOpen ? "Hide catalog" : "Add from catalog"}
          </button>
          <button
            onClick={() => {
              setDraft({ ...BLANK });
              setCatalogOpen(false);
            }}
            disabled={draft !== null}
          >
            Add server
          </button>
        </div>
      </div>
      <p className="muted">
        Tools from an MCP server go through the same approval and audit trail as built-in
        ones. Nothing connects until you enable it, and only tools you approve can be called.
      </p>

      {catalogOpen && (
        <Catalog
          configured={new Set(servers.map((server) => server.id))}
          onPick={(entry) => {
            setDraft(catalogEntryToInput(entry));
            setCatalogOpen(false);
          }}
        />
      )}

      {draft && <ServerForm draft={draft} onChange={setDraft} onSave={save} onCancel={() => setDraft(null)} />}

      {servers.length === 0 && !draft && !catalogOpen && (
        <p className="muted">No MCP servers configured.</p>
      )}

      {servers.map((server) => {
        const tools = server.discoveredTools;
        const open = toolsOpen[server.id] ?? tools.length <= TOOLS_SHOWN_OPEN;
        // Approvals for tools the server no longer offers. They are kept on the
        // record deliberately, but they are counted in "N of M approved" while
        // having no checkbox to account for them — which reads as a UI that has
        // stopped responding. Naming them is what makes the count add up.
        const advertised = new Set(tools.map((tool) => tool.name));
        const stale = server.approvedTools.filter((name) => !advertised.has(name));
        return (
        <div className="card nested" key={server.id}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <strong>{server.label || server.id}</strong>
              <div className="muted">
                {server.transport === "stdio"
                  ? `${server.command} ${server.args.join(" ")}`.trim()
                  : server.url}
              </div>
            </div>
            <div className="row">
              <span className={`pill${server.enabled ? " ok" : ""}`}>
                {server.enabled ? "enabled" : "off"}
              </span>
              <span className={`pill${server.state === "failed" ? " bad" : ""}`}>
                {server.state.replace("_", " ")}
              </span>
            </div>
          </div>

          {server.envKeys.length > 0 && (
            <div className="muted">Environment set: {server.envKeys.join(", ")}</div>
          )}
          {server.headerKeys.length > 0 && (
            <div className="muted">Headers set: {server.headerKeys.join(", ")}</div>
          )}
          {server.lastError !== "" && <div className="notice">{server.lastError}</div>}

          {/* Sign-in, licence and consent live outside this app, so a server
              can be configured perfectly and still refuse every call. The
              steps are shown on the row itself rather than only in the
              catalog, because by the time someone is reading an error they
              have long since stopped looking at "Suggested servers". They stop
              being shown once the server is in use — at that point they are
              answered. */}
          {!server.enabled && <SetupSteps steps={setupFor(server.id)} />}

          {/* The gap between "it inspected fine" and "it is being used".
              A server that connected, advertised its tools and then sits at
              `state: ok` with nothing approved reads as working — and then
              never launches, because `converterTarget` and `gate` both require
              enabled *and* an approved tool. That is the consent design doing
              its job, but silence about it is indistinguishable from a broken
              server, so the two remaining steps are named here. */}
          {server.state === "ok" && (!server.enabled || server.approvedTools.length === 0) && (
            <div className="notice">
              <strong>Inspected, but not in use.</strong>{" "}
              {server.approvedTools.length === 0
                ? "No tool is approved yet, so nothing here can be called. Tick the tools you want below"
                : "Its tools are approved"}
              {server.enabled ? "." : ", then press Enable."}
            </div>
          )}

          {tools.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              {/* The count travels on the header rather than only inside the
                  list, because how many tools a party wants to run in here is
                  the first thing to know about it and hiding the list must not
                  hide that. */}
              <div className="row" style={{ justifyContent: "space-between" }}>
                <p className="muted" style={{ margin: 0 }}>
                  {server.approvedTools.length} of {tools.length} tools approved.
                  {open && " Approve each tool you want the assistant to be able to call."}
                </p>
                <button
                  className="link"
                  aria-expanded={open}
                  onClick={() =>
                    setToolsOpen((current) => ({ ...current, [server.id]: !open }))
                  }
                >
                  {open ? "Hide tools" : `Show ${tools.length} tools`}
                </button>
              </div>
              {open &&
                tools.map((tool) => (
                  <label className="tool-grant" key={tool.name}>
                    <input
                      type="checkbox"
                      checked={server.approvedTools.includes(tool.name)}
                      onChange={() => void toggleTool(server, tool.name)}
                    />
                    <span>
                      <strong>{tool.name}</strong>
                      {tool.description !== "" && (
                        <span className="muted"> — {tool.description}</span>
                      )}
                    </span>
                  </label>
                ))}
              {stale.length > 0 && (
                <div className="notice" style={{ marginTop: 8 }}>
                  <strong>
                    {stale.length === 1 ? "One approved tool is" : `${stale.length} approved tools are`}{" "}
                    no longer offered by this server.
                  </strong>{" "}
                  {stale.join(", ")} — approved earlier and absent from the last inspection, so
                  {stale.length === 1 ? " it counts" : " they count"} above but cannot be called.
                  <div className="row" style={{ marginTop: 8 }}>
                    <button onClick={() => void dropStale(server)}>
                      {stale.length === 1 ? "Drop this approval" : "Drop these approvals"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="muted" style={{ marginTop: 8 }}>
              Inspect this server to see what it offers.
            </p>
          )}

          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={() => void inspect(server.id)} disabled={inspecting === server.id}>
              {inspecting === server.id ? "Inspecting…" : "Inspect"}
            </button>
            <button
              className={server.enabled ? "" : "primary"}
              onClick={() => void setEnabled(server, !server.enabled)}
              disabled={!server.enabled && server.approvedTools.length === 0}
              title={
                server.approvedTools.length === 0
                  ? "Approve at least one tool before enabling"
                  : ""
              }
            >
              {server.enabled ? "Disable" : "Enable"}
            </button>
            <button
              onClick={() =>
                setDraft({
                  id: server.id,
                  label: server.label,
                  transport: server.transport,
                  command: server.command,
                  args: server.args,
                  env: {},
                  url: server.url,
                  headers: {},
                })
              }
            >
              Edit
            </button>
            <button className="danger" onClick={() => void remove(server.id)}>
              Remove
            </button>
          </div>

          {result?.id === server.id && result.ok && (
            <p className="muted">
              {result.serverName || "server"} {result.serverVersion} advertised{" "}
              {result.tools.length} tools.
            </p>
          )}

          {/* The inspection worked and the answer is still not to be trusted.
              A proxy that could not reach what it proxies serves only the
              tools it implements itself, so "advertised 4 tools" above is
              true, complete and misleading. The server said why; this is the
              only place that says it back. */}
          {result?.id === server.id && result.ok && result.warning !== "" && (
            <div className="notice">
              <strong>The server started with a problem.</strong> Some of what it offers may be
              missing from the list above. It reported: {result.warning}
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
}

/**
 * Suggested servers.
 *
 * This is a shortcut through the *typing*, not through the consent. Picking an
 * entry fills the add form and nothing else: the server still lands disabled,
 * still has to be inspected, and still has each tool approved by name. The
 * expected tools shown here are the entry's claim, which is exactly why they
 * are labelled as such — what the server really advertises is what inspection
 * returns.
 */
function Catalog({
  configured,
  onPick,
}: {
  configured: Set<string>;
  onPick: (entry: McpCatalogEntry) => void;
}): JSX.Element {
  return (
    <div className="card nested">
      <h4>Suggested servers</h4>
      <p className="muted">
        Choosing one fills in the form below. It is added disabled, with no tools approved.
      </p>
      {MCP_CATALOG.map((entry) => (
        <div className="card nested" key={entry.id}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <strong>{entry.label}</strong> <span className="muted">— {entry.vendor}</span>
              <div className="muted">{entry.summary}</div>
            </div>
            <button
              className="primary"
              onClick={() => onPick(entry)}
              disabled={configured.has(entry.id)}
              title={configured.has(entry.id) ? "Already configured" : ""}
            >
              {configured.has(entry.id) ? "Added" : "Use this"}
            </button>
          </div>
          <div className="muted" style={{ marginTop: 6 }}>
            <code>
              {entry.transport === "stdio" ? `${entry.command} ${entry.args.join(" ")}`.trim() : entry.url}
            </code>
          </div>
          {entry.expectedTools.length > 0 && (
            <div className="muted">
              Expected tools: {entry.expectedTools.map((tool) => tool.name).join(", ")} — approve
              them individually after inspecting.
            </div>
          )}
          {entry.prerequisite !== "" && <div className="muted">{entry.prerequisite}</div>}
          <SetupSteps steps={entry.setupSteps} />
          {entry.caution !== "" && <div className="notice">{entry.caution}</div>}
        </div>
      ))}
    </div>
  );
}

function ServerForm({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: McpServerInput;
  onChange: (next: McpServerInput) => void;
  onSave: () => void;
  onCancel: () => void;
}): JSX.Element {
  const set = <K extends keyof McpServerInput>(key: K, value: McpServerInput[K]): void =>
    onChange({ ...draft, [key]: value });

  return (
    <div className="card approval">
      <h3>{draft.id === "" ? "Add an MCP server" : `Edit ${draft.id}`}</h3>

      <label>
        Id
        <input
          value={draft.id}
          placeholder="my-server"
          onChange={(event) => set("id", event.target.value)}
        />
      </label>
      <label>
        Name
        <input value={draft.label} onChange={(event) => set("label", event.target.value)} />
      </label>
      <label>
        Transport
        <select
          value={draft.transport}
          onChange={(event) => set("transport", event.target.value as "stdio" | "http")}
        >
          <option value="stdio">Local command (stdio)</option>
          <option value="http">HTTP endpoint</option>
        </select>
      </label>

      {draft.transport === "stdio" ? (
        <>
          <label>
            Command
            <input
              value={draft.command}
              placeholder="npx"
              onChange={(event) => set("command", event.target.value)}
            />
          </label>
          <label>
            Arguments
            <input
              value={draft.args.join(" ")}
              placeholder="-y some-mcp-server"
              onChange={(event) => set("args", event.target.value.split(/\s+/).filter(Boolean))}
            />
          </label>
          <label>
            Environment
            <input
              placeholder="KEY=value, KEY2=value2"
              onChange={(event) => set("env", parsePairs(event.target.value))}
            />
          </label>
        </>
      ) : (
        <>
          <label>
            URL
            <input
              value={draft.url}
              placeholder="https://example.com/mcp"
              onChange={(event) => set("url", event.target.value)}
            />
          </label>
          <label>
            Headers
            <input
              placeholder="Authorization=Bearer …"
              onChange={(event) => set("headers", parsePairs(event.target.value))}
            />
          </label>
        </>
      )}

      <p className="muted">
        Secrets are stored by the app and never shown again. Leave the field blank when
        editing to keep what is already set.
      </p>

      <div className="row">
        <button className="primary" onClick={onSave} disabled={draft.id.trim() === ""}>
          Save
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** Parse `KEY=value, KEY2=value2` without splitting values that contain `=`. */
function parsePairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key !== "") out[key] = value;
  }
  return out;
}
