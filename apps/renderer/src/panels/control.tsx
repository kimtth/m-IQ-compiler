import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import type {
  AuditRecord,
  JobRun,
  MemoryDerivation,
  MemoryEdit,
  MemoryRecord,
  ScheduledJob,
} from "@iq/shared";
import { MEMORY_TYPE_DETAIL, MEMORY_TYPE_LABELS } from "@iq/shared";
import { call, callAs, subscribe } from "../bridge.js";
import { useSamples } from "../samples/index.js";

/**
 * Control Center panels.
 *
 * What the app has remembered, scheduled, delegated and recorded. These four
 * share a shape — a list of durable records with a decision attached — and
 * nothing else in the app renders that shape.
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
  /** The project the panel's records belong to. */
  projectId?: string | null;
}
// --- memories ---------------------------------------------------------------

/**
 * Approved memories are what the curator turns into skill proposals, so this
 * panel is the gate: nothing here takes effect until it is approved, and the
 * resulting skill still needs its own approval in Skills.
 */
export function Memories({
  onError,
  focusMemoryIds,
}: PanelProps & {
  /**
   * Memories to mark on arrival, sent by the IQ Cell library when a cell
   * recorded against them is opened. Undefined is the ordinary case.
   */
  focusMemoryIds?: readonly string[];
}): JSX.Element {
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [derivations, setDerivations] = useState<MemoryDerivation[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Memories the IQ Cell library pointed at.
   *
   * This used to be a tick box per row feeding a Compile button in the header.
   * Publishing an IQ Cell from a set of memories is gone — an IQ Cell is a
   * business flow somebody drew, not a bundle of facts — so the ticks had
   * nothing left to do. Marking is what is left of it, and it is the part that
   * was always answering the reader's question: which memories is this cell
   * about.
   */
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
  /** The memory being edited in place, if any. */
  const [editing, setEditing] = useState<MemoryEdit | null>(null);

  const load = useCallback(async () => {
    try {
      setMemories(await call("memory:list", {}));
      setDerivations(await call("memory:derivations"));
    } catch (problem) {
      onError(problem);
    }
  }, [onError]);

  useEffect(() => {
    void load();
    return subscribe<MemoryRecord[]>("memory:changed", (records) => {
      setMemories(records);
      void call("memory:derivations").then(setDerivations).catch(onError);
    });
  }, [load, onError]);

  /**
   * Mark what the IQ Cell library asked for, and say why they are marked.
   *
   * Keyed on the ids rather than run once: switching back to a tab that already
   * exists does not remount it, so a mount-time read would ignore the second
   * request from the library.
   */
  const focusKey = (focusMemoryIds ?? []).join("|");
  useEffect(() => {
    if (focusKey === "") return;
    const ids = focusKey.split("|");
    setMarked(new Set(ids));
    setNotice(
      `Marked the ${ids.length} ${ids.length === 1 ? "memory" : "memories"} that IQ Cell was recorded against.`,
    );
  }, [focusKey]);

  /** Save an edit. The store decides what an edit costs an approval. */
  const saveEdit = async (): Promise<void> => {
    if (editing === null) return;
    try {
      const before = memories.find((memory) => memory.id === editing.id);
      const updated = await call("memory:update", editing);
      setEditing(null);
      await load();
      if (before?.status === "approved" && updated.status === "pending") {
        setNotice(
          `“${updated.subject}” went back to review. An approval names a person against a specific claim, so changing the claim needs a fresh one.`,
        );
      }
    } catch (problem) {
      onError(problem);
    }
  };

  const act = async (
    channel: "memory:approve" | "memory:reject" | "memory:delete",
    id: string,
  ): Promise<void> => {
    try {
      await call(channel, { id });
      await load();
    } catch (problem) {
      onError(problem);
    }
  };

  const pending = memories.filter((memory) => memory.status === "pending");
  const settled = memories.filter((memory) => memory.status !== "pending");
  const skillFor = (id: string): string | undefined =>
    derivations.find((derivation) => derivation.memoryIds.includes(id))?.skillName;

  const samples = useSamples();
  // Asked of the hub rather than sniffed from an id prefix here. A surface that
  // knows what a sample id looks like is a second definition of "sample", and
  // it drifts the moment the first one changes.
  const seeded = samples.modules.some((module) => module.id === "memories" && module.loaded);

  /**
   * Load the demo set.
   *
   * A memory is not part of a project — it lives in the app's own store — so
   * loading the sample project brings none with it and this surface opens
   * empty with nothing to show. The set is fixed in privileged code: this asks
   * for the samples, it cannot say what a memory contains.
   */
  const loadSamples = async (): Promise<void> => {
    try {
      setNotice(await samples.load("memories"));
      await load();
    } catch (problem) {
      onError(problem);
    }
  };

  /**
   * Take the demo set back out.
   *
   * Loading samples into the store that also holds real memories has to be
   * reversible, or trying the demo is a one-way change to the user's own data.
   * Only the fixed sample ids are removed.
   */
  const clearSamples = async (): Promise<void> => {
    try {
      setNotice(await samples.clear("memories"));
      await load();
      setMarked(new Set());
    } catch (problem) {
      onError(problem);
    }
  };

  return (
    <>
      <div className="pane-header">
        <strong>IQ Memories</strong>
        <span className="muted">
          Facts the assistant wants to keep. Approved memories become skill proposals.
        </span>
        <div className="spacer" />
        {!seeded && samples.enabled && (
          <button
            className="ghost"
            title="Put the demo memory set in the store. Nothing is decided on your behalf beyond loading it."
            onClick={() => void loadSamples()}
          >
            Load samples
          </button>
        )}
        {seeded && (
          <button
            className="ghost"
            title="Remove the demo memory set. Only the sample records go; anything the assistant proposed stays."
            onClick={() => void clearSamples()}
          >
            Clear samples
          </button>
        )}
      </div>
      <div className="pane-body">
        {notice !== null && (
          <div className="notice" onClick={() => setNotice(null)} role="status">
            {notice} <span className="muted">(click to dismiss)</span>
          </div>
        )}
        {pending.length > 0 && (
          <div className="card approval">
            <h3>Awaiting your review ({pending.length})</h3>
            <p className="muted">
              A memory has no effect until you approve it, and nothing derived from it becomes
              active without a second approval in Skills.
            </p>
            {pending.map((memory) => (
              <div key={memory.id} style={{ marginTop: 12 }}>
                <strong>{memory.subject}</strong>
                <div>{memory.fact}</div>
                {memory.rationale && (
                  <div className="muted" style={{ marginTop: 4 }}>
                    Why: {memory.rationale}
                  </div>
                )}
                {memory.citations.length > 0 && (
                  <div className="muted" style={{ marginTop: 4 }}>
                    Source: {memory.citations.join("; ")}
                  </div>
                )}
                <div className="row" style={{ marginTop: 8 }}>
                  <span className="pill">{memory.scope}</span>
                  <span className="pill" title={MEMORY_TYPE_DETAIL[memory.memoryType]}>
                    {MEMORY_TYPE_LABELS[memory.memoryType]}
                  </span>
                  <button className="primary" onClick={() => void act("memory:approve", memory.id)}>
                    Approve
                  </button>
                  <button className="danger" onClick={() => void act("memory:reject", memory.id)}>
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {derivations.length > 0 && (
          <div className="card">
            <h3>Turned into skill proposals</h3>
            {derivations.map((derivation) => (
              <div key={derivation.slug} style={{ marginTop: 8 }}>
                <strong>{derivation.skillName}</strong>
                <div className="muted">
                  {derivation.memoryIds.length} approved memories about “{derivation.subject}”,
                  revision {derivation.revision}. Review it in Skills.
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="grid">
          {marked.size > 0 && (
            <div className="row" style={{ gap: 8 }}>
              <span className="muted">
                {marked.size} marked by the IQ Cell library
              </span>
              <button className="link" onClick={() => setMarked(new Set())}>
                Clear the marks
              </button>
            </div>
          )}
          {settled.map((memory) => (
            <div
              className={marked.has(memory.id) ? "card approval" : "card"}
              key={memory.id}
            >
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="row" style={{ gap: 8, minWidth: 0 }}>
                  <h3 style={{ margin: 0 }}>{memory.subject}</h3>
                </div>
                <div className="row">
                  <span className={`pill${memory.status === "approved" ? " ok" : ""}`}>
                    {memory.status}
                  </span>
                  {/* Beside the status on purpose. What the memory *is* and
                      what was *decided* about it are the two things a reader
                      needs before opening it. */}
                  <span className="pill" title={MEMORY_TYPE_DETAIL[memory.memoryType]}>
                    {MEMORY_TYPE_LABELS[memory.memoryType]}
                  </span>
                  <button
                    disabled={editing !== null}
                    title={`Edit ${memory.subject}`}
                    onClick={() =>
                      setEditing({
                        id: memory.id,
                        subject: memory.subject,
                        fact: memory.fact,
                        rationale: memory.rationale,
                      })
                    }
                  >
                    Edit
                  </button>
                  <button className="danger" onClick={() => void act("memory:delete", memory.id)}>
                    Forget
                  </button>
                </div>
              </div>

              {editing?.id === memory.id ? (
                <div className="grid" style={{ marginTop: 8 }}>
                  <label>
                    Subject
                    <input
                      value={editing.subject}
                      autoFocus
                      maxLength={64}
                      onChange={(event) => setEditing({ ...editing, subject: event.target.value })}
                    />
                  </label>
                  <label>
                    Fact
                    <textarea
                      rows={3}
                      maxLength={400}
                      value={editing.fact}
                      onChange={(event) => setEditing({ ...editing, fact: event.target.value })}
                    />
                  </label>
                  <label>
                    Why it is worth keeping
                    <textarea
                      rows={2}
                      value={editing.rationale}
                      onChange={(event) =>
                        setEditing({ ...editing, rationale: event.target.value })
                      }
                    />
                  </label>
                  {/* Said before the save, not after it. Someone editing an
                      approved convention should know it is going back to review
                      while they can still change their mind. */}
                  {memory.status === "approved" && (
                    <p className="muted">
                      Saving returns this memory to review. An approval names a person against a
                      specific claim, so changing the claim needs a fresh one.
                    </p>
                  )}
                  <div className="row">
                    <button
                      className="primary"
                      disabled={editing.subject.trim() === "" || editing.fact.trim() === ""}
                      onClick={() => void saveEdit()}
                    >
                      Save
                    </button>
                    <button onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <div>{memory.fact}</div>
                  {memory.rationale !== "" && (
                    <div className="muted" style={{ marginTop: 4 }}>
                      Why: {memory.rationale}
                    </div>
                  )}
                </>
              )}

              {skillFor(memory.id) && (
                <div className="muted" style={{ marginTop: 6 }}>
                  Turned into {skillFor(memory.id)}
                </div>
              )}
            </div>
          ))}
          {memories.length === 0 && (
            <p className="muted">
              Nothing remembered yet. The assistant proposes a memory when you teach it a
              convention worth keeping — or{" "}
              <button className="link" onClick={() => void loadSamples()}>
                load the sample memories
              </button>{" "}
              to see the surface with something in it.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

// --- scheduled work ---------------------------------------------------------

export function Jobs({ onError }: PanelProps): JSX.Element {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", objective: "", expression: "0 8 * * 1-5" });

  const load = useCallback(async () => {
    try {
      setJobs(await call("jobs:list"));
    } catch (problem) {
      onError(problem);
    }
  }, [onError]);

  useEffect(() => {
    void load();
    return subscribe<JobRun>("jobs:run", (run) => {
      setRuns((current) => [run, ...current.filter((existing) => existing.runId !== run.runId)]);
    });
  }, [load]);

  useEffect(() => {
    if (!selected) return;
    void call("jobs:runs", { jobId: selected, limit: 50 })
      .then(setRuns)
      .catch(onError);
  }, [selected, onError]);

  const create = async (): Promise<void> => {
    try {
      await call("jobs:create", {
        name: form.name,
        objective: form.objective,
        trigger: { kind: "cron", expression: form.expression, timezone: "UTC" },
        toolFamilies: [],
        skills: [],
      });
      setForm({ name: "", objective: "", expression: "0 8 * * 1-5" });
      await load();
    } catch (problem) {
      onError(problem);
    }
  };

  return (
    <>
      <div className="pane-header">
        <strong>Scheduled work</strong>
        <span className="muted">Runs unattended in a fresh session with a narrow tool set</span>
      </div>
      <div className="pane-body">
        <div className="card">
          <h3>New scheduled job</h3>
          <div className="grid">
            <input
              placeholder="Name, e.g. Morning briefing"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
            <textarea
              placeholder="What should it do each time?"
              rows={3}
              value={form.objective}
              onChange={(event) => setForm({ ...form, objective: event.target.value })}
            />
            <input
              placeholder="Cron expression"
              value={form.expression}
              onChange={(event) => setForm({ ...form, expression: event.target.value })}
            />
            <div>
              <button
                className="primary"
                disabled={!form.name || !form.objective}
                onClick={() => void create()}
              >
                Create
              </button>
            </div>
          </div>
        </div>

        {jobs.map((job) => (
          <div className="card" key={job.id}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3>{job.name}</h3>
              <div className="row">
                <span className="pill">{describeTrigger(job)}</span>
                <span className={`pill${job.enabled ? " ok" : ""}`}>
                  {job.enabled ? "enabled" : "paused"}
                </span>
                <button onClick={() => setSelected(job.id)}>History</button>
                <button onClick={() => void call("jobs:runNow", { id: job.id }).catch(onError)}>
                  Run now
                </button>
                <button
                  onClick={() =>
                    void call("jobs:setEnabled", { id: job.id, enabled: !job.enabled })
                      .then(load)
                      .catch(onError)
                  }
                >
                  {job.enabled ? "Pause" : "Resume"}
                </button>
                <button
                  className="danger"
                  onClick={() => void call("jobs:delete", { id: job.id }).then(load).catch(onError)}
                >
                  Delete
                </button>
              </div>
            </div>
            <div className="muted">{job.objective}</div>

            {selected === job.id && (
              <table style={{ marginTop: 12 }}>
                <thead>
                  <tr>
                    <th>Scheduled</th>
                    <th>Attempt</th>
                    <th>Status</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {runs
                    .filter((run) => run.jobId === job.id)
                    .map((run) => (
                      <tr key={run.runId}>
                        <td>{new Date(run.scheduledFor).toLocaleString()}</td>
                        <td>{run.attempt}</td>
                        <td>
                          <span
                            className={`pill${
                              run.status === "succeeded" ? " ok" : run.status === "running" ? "" : " bad"
                            }`}
                          >
                            {run.status}
                          </span>
                        </td>
                        <td className="muted">
                          {run.error ?? ""}
                          {run.nextAttemptAt &&
                            ` · retry at ${new Date(run.nextAttemptAt).toLocaleTimeString()}`}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
        {jobs.length === 0 && <p className="muted">No scheduled jobs yet.</p>}
      </div>
    </>
  );
}

function describeTrigger(job: ScheduledJob): string {
  switch (job.trigger.kind) {
    case "cron":
      return `cron ${job.trigger.expression} (${job.trigger.timezone})`;
    case "interval":
      return `every ${Math.round(job.trigger.everyMs / 60000)} min`;
    case "once":
      return `once at ${new Date(job.trigger.at).toLocaleString()}`;
    default:
      return "manual";
  }
}

// --- delegated plans --------------------------------------------------------

interface PlanDoc {
  plan: { id: string; objective: string; status: string; maxParallel: number };
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    attempt: number;
    result: string | null;
    error: string | null;
  }>;
  gates: Array<{ id: string; question: string; resolution: string }>;
}

export function Plans({ onError }: PanelProps): JSX.Element {
  const [plans, setPlans] = useState<PlanDoc[]>([]);

  const load = useCallback(async () => {
    try {
      setPlans(await callAs<PlanDoc[]>("orchestration:plans"));
    } catch (problem) {
      onError(problem);
    }
  }, [onError]);

  useEffect(() => {
    void load();
    return subscribe<PlanDoc>("orchestration:update", (doc) => {
      setPlans((current) => [doc, ...current.filter((existing) => existing.plan.id !== doc.plan.id)]);
    });
  }, [load]);

  return (
    <>
      <div className="pane-header">
        <strong>Delegated plans</strong>
        <span className="muted">Sub-agents running in parallel where dependencies allow</span>
      </div>
      <div className="pane-body">
        {plans.map((doc) => (
          <div className="card" key={doc.plan.id}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3>{doc.plan.objective}</h3>
              <div className="row">
                <span className={`pill${doc.plan.status === "succeeded" ? " ok" : ""}`}>
                  {doc.plan.status}
                </span>
                <span className="pill">max {doc.plan.maxParallel} at once</span>
                {doc.plan.status === "running" && (
                  <button
                    className="danger"
                    onClick={() =>
                      void call("orchestration:cancel", { planId: doc.plan.id })
                        .then(load)
                        .catch(onError)
                    }
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>

            {doc.gates
              .filter((gate) => gate.resolution === "pending")
              .map((gate) => (
                <div className="card approval" key={gate.id} style={{ marginTop: 12 }}>
                  <h3>Decision needed</h3>
                  <div>{gate.question}</div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <button
                      className="primary"
                      onClick={() =>
                        void call("orchestration:resolveGate", { gateId: gate.id, approved: true })
                          .then(load)
                          .catch(onError)
                      }
                    >
                      Approve
                    </button>
                    <button
                      className="danger"
                      onClick={() =>
                        void call("orchestration:resolveGate", { gateId: gate.id, approved: false })
                          .then(load)
                          .catch(onError)
                      }
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}

            <table style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Status</th>
                  <th>Attempt</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {doc.tasks.map((task) => (
                  <tr key={task.id}>
                    <td>{task.title}</td>
                    <td>
                      <span className={`pill${task.status === "succeeded" ? " ok" : ""}`}>
                        {task.status}
                      </span>
                    </td>
                    <td>{task.attempt}</td>
                    <td className="muted">{task.error ?? task.result?.slice(0, 160) ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {plans.length === 0 && <p className="muted">Nothing has been delegated yet.</p>}
      </div>
    </>
  );
}

// --- audit ------------------------------------------------------------------

export function Audit({ onError }: PanelProps): JSX.Element {
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [family, setFamily] = useState("");

  const load = useCallback(async () => {
    try {
      setRecords(
        await call("audit:query", {
          limit: 200,
          ...(family ? { family } : {}),
        }),
      );
    } catch (problem) {
      onError(problem);
    }
  }, [family, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="pane-header">
        <strong>Audit</strong>
        <span className="muted">Every action taken on your behalf</span>
        <div style={{ marginLeft: "auto", width: 220 }}>
          <input
            placeholder="Filter by family"
            value={family}
            onChange={(event) => setFamily(event.target.value)}
          />
        </div>
        <button onClick={() => void load()}>Refresh</button>
      </div>
      <div className="pane-body">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Outcome</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.id}>
                <td>{new Date(record.at).toLocaleString()}</td>
                <td>{record.actor.kind}</td>
                <td>{record.action}</td>
                <td>
                  <span
                    className={`pill${
                      record.outcome === "denied" || record.outcome === "failed" ? " bad" : " ok"
                    }`}
                  >
                    {record.outcome}
                  </span>
                </td>
                <td className="muted">
                  {[record.reason, record.resources.join(", ")].filter(Boolean).join(" · ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {records.length === 0 && <p className="muted">No audit records yet.</p>}
      </div>
    </>
  );
}
