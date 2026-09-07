import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FlaskConical,
  Gavel,
  Plus,
  Save,
  Send,
  Pencil,
  Trash2,
  UserRound,
  Users,
} from "lucide-react";
import {
  councilRunTitle,
  estimateCouncilTokens,
  type CouncilContribution,
  type CouncilPreset,
  type CouncilRun,
  type CouncilStartInput,
  type CouncilVerdict,
  type ModelCatalog,
  type ModelCatalogEntry,
} from "@iq/shared";
import { call, subscribe } from "./bridge.js";
import { MessageBody } from "./markdown.js";
import { useSampleData, SAMPLE_COUNCIL, BLANK_MEMBER, type DraftMember } from "./samples/index.js";

/**
 * Chat → Team (Council).
 *
 * A council answers questions a single agent answers badly — trade-offs, design
 * choices, risk — by having members argue in rounds to a structured verdict.
 * Two costs are made explicit up front rather than discovered later: the round
 * budget is required, and the token estimate is shown before the user commits,
 * because a council multiplies spend.
 *
 * A run is reachable from the rail as well as from the picker here. It is the
 * result of a conversation the user started, and it belongs beside their other
 * conversations rather than only behind a dropdown on a surface they have to
 * find first.
 */

interface CouncilProps {
  sessionId: string | null;
  projectId: string | null;
  onError: (problem: unknown) => void;
  /**
   * The run the rail asked for. Keyed on by an effect rather than read once:
   * this pane is not remounted when the rail selects a second run.
   */
  focusRunId?: string | null;
  /** Reports the picker's own selection back, so the rail can follow it. */
  onSelectRun?: (runId: string) => void;
  /** Reports a deletion, so the rail drops the row too. */
  onDeleted?: (runId: string) => void;
}

/** Six seats, because a council is capped at six members. */
const SEAT_COUNT = 6;

/**
 * A council seat, drawn as a person.
 *
 * A council is the one surface where the *who* carries the meaning: the same
 * question answered by "advocate" and by "skeptic" is the entire point, and a
 * transcript of identical rows reads as one voice with headings rather than as
 * a debate. So each member gets a face and a colour.
 *
 * The colour is taken from the name rather than from the row position, so a
 * member keeps the same seat in the roster, in every round of the transcript
 * and in the verdict — reordering the roster must not repaint the argument. An
 * unnamed row falls back to its position, which is the normal state of a seat
 * that has just been added.
 */
function MemberAvatar({ name, seat = 0 }: { name: string; seat?: number }): JSX.Element {
  const trimmed = name.trim();
  const index = trimmed === "" ? seat : seatOf(trimmed);
  return (
    <span className={`member-avatar seat-${index % SEAT_COUNT}`} aria-hidden="true">
      <UserRound size={15} />
    </span>
  );
}

/** A small stable hash. Only the bucket matters, so collisions are harmless. */
function seatOf(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) % 100_003;
  }
  return hash;
}

export function Council({
  sessionId,
  projectId,
  onError,
  focusRunId = null,
  onSelectRun,
  onDeleted,
}: CouncilProps): JSX.Element {
  const [entries, setEntries] = useState<ModelCatalogEntry[]>([]);
  const [presets, setPresets] = useState<CouncilPreset[]>([]);
  const [runs, setRuns] = useState<CouncilRun[]>([]);
  const [selectedId, setSelectedId] = useState("");

  const [question, setQuestion] = useState("");
  const [roundBudget, setRoundBudget] = useState(3);
  const [members, setMembers] = useState<DraftMember[]>([{ ...BLANK_MEMBER }, { ...BLANK_MEMBER }]);
  const [presetName, setPresetName] = useState("");
  const [busy, setBusy] = useState(false);
  const samples = useSampleData();

  const load = useCallback(async () => {
    try {
      const catalog = await call("models:catalog");
      setEntries(catalog.entries.filter((entry) => entry.capabilities.includes("chat")));
      setPresets(await call("council:presets"));
      setRuns(await call("council:list"));
    } catch (problem) {
      onError(problem);
    }
  }, [onError]);

  useEffect(() => {
    void load();
    const offModels = subscribe<ModelCatalog>("models:changed", (catalog) =>
      setEntries(catalog.entries.filter((entry) => entry.capabilities.includes("chat"))),
    );
    const offRun = subscribe<CouncilRun>("council:changed", (run) => {
      setRuns((current) => [run, ...current.filter((existing) => existing.id !== run.id)]);
    });
    return () => {
      offModels();
      offRun();
    };
  }, [load]);

  const estimate = useMemo(
    () => estimateCouncilTokens(members.length, roundBudget),
    [members.length, roundBudget],
  );

  // Keyed on the value, never run once: the rail can ask for a second run while
  // this pane is already mounted.
  useEffect(() => {
    if (focusRunId !== null) setSelectedId(focusRunId);
  }, [focusRunId]);

  const chooseRun = (runId: string): void => {
    setSelectedId(runId);
    onSelectRun?.(runId);
  };

  const applyPreset = (preset: CouncilPreset): void => {
    setMembers(
      preset.members.map((member) => ({
        name: member.name,
        stance: member.stance,
        modelId: member.modelId,
        skills: member.skills.join(", "),
        toolFamilies: member.toolFamilies.join(", "),
      })),
    );
  };

  /** Fill the form from {@link SAMPLE_COUNCIL}. Runs nothing. */
  const loadSample = (): void => {
    setQuestion(SAMPLE_COUNCIL.question);
    setRoundBudget(SAMPLE_COUNCIL.roundBudget);
    setMembers(SAMPLE_COUNCIL.members.map((member) => ({ ...member })));
  };

  /** Empty the form back to the state the pane opens in. */
  const clearSample = (): void => {
    setQuestion("");
    setRoundBudget(3);
    setMembers([{ ...BLANK_MEMBER }, { ...BLANK_MEMBER }]);
  };

  const sampleLoaded = question.trim() === SAMPLE_COUNCIL.question;

  const toMembers = (): CouncilStartInput["members"] =>
    members.map((member) => ({
      name: member.name.trim(),
      stance: member.stance.trim(),
      modelId: member.modelId,
      skills: splitList(member.skills),
      toolFamilies: splitList(member.toolFamilies),
    }));

  const rosterValid =
    members.length >= 2 &&
    members.length <= 6 &&
    members.every((member) => member.name.trim() !== "" && member.stance.trim() !== "");

  const start = async (): Promise<void> => {
    if (question.trim() === "" || !rosterValid) return;
    setBusy(true);
    try {
      const input: CouncilStartInput = {
        question: question.trim(),
        members: toMembers(),
        roundBudget,
        sessionId,
        projectId,
      };
      const run = await call("council:start", input);
      chooseRun(run.id);
      await load();
    } catch (problem) {
      onError(problem);
    } finally {
      setBusy(false);
    }
  };

  const savePreset = async (): Promise<void> => {
    if (presetName.trim() === "" || !rosterValid) return;
    try {
      await call("council:savePreset", {
        name: presetName.trim(),
        description: "",
        members: toMembers(),
      });
      setPresetName("");
      await load();
    } catch (problem) {
      onError(problem);
    }
  };

  const deletePreset = async (id: string): Promise<void> => {
    try {
      await call("council:deletePreset", { id });
      await load();
    } catch (problem) {
      onError(problem);
    }
  };

  const setMember = (index: number, patch: Partial<DraftMember>): void =>
    setMembers((current) => current.map((member, position) => (position === index ? { ...member, ...patch } : member)));

  const addMember = (): void => {
    if (members.length >= 6) return;
    setMembers((current) => [...current, { ...BLANK_MEMBER }]);
  };

  const removeMember = (index: number): void => {
    if (members.length <= 2) return;
    setMembers((current) => current.filter((_, position) => position !== index));
  };

  const selected = runs.find((run) => run.id === selectedId) ?? null;

  /**
   * Name the selected run.
   *
   * The label only — `question` is what the members were given and stays as it
   * was asked. The reply is folded into local state by id; the service also
   * publishes the run on `council:changed`, so the rail updates itself.
   */
  const renameRun = async (runId: string, title: string): Promise<void> => {
    try {
      const run = await call("council:rename", { runId, title });
      setRuns((current) => current.map((row) => (row.id === runId ? run : row)));
    } catch (problem) {
      onError(problem);
    }
  };

  /**
   * Delete the selected run.
   *
   * Dropped from local state rather than waited for on the stream:
   * `council:changed` carries a run, so there is no shape in which the service
   * can say one is gone without putting the row back.
   */
  const deleteRun = async (runId: string): Promise<void> => {
    try {
      await call("council:delete", { runId });
      setRuns((current) => current.filter((run) => run.id !== runId));
      if (selectedId === runId) chooseRun("");
      onDeleted?.(runId);
    } catch (problem) {
      onError(problem);
    }
  };

  return (
    // `.pane-body` and not a bare `.stack`: Council is mounted straight into
    // `.pane.chat`, which carries no padding of its own — Chat supplies its own
    // `.messages` and composer. Without it the run picker sat flush against the
    // pane's left edge and a long transcript could not scroll.
    <div className="pane-body">
      <div className="stack">
        {runs.length > 0 && (
          <div className="field-row">
            <label>Runs</label>
            <select value={selectedId} onChange={(event) => chooseRun(event.target.value)}>
              <option value="">New council…</option>
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {councilRunTitle(run)} — {run.status}
                </option>
              ))}
            </select>
          </div>
        )}

      {selected ? (
        <RunView
          run={selected}
          onError={onError}
          onRefresh={load}
          onRename={(title) => renameRun(selected.id, title)}
          onDelete={() => deleteRun(selected.id)}
        />
      ) : (
        <>
          <div className="card">
            <div className="row between">
              <div className="row" style={{ gap: 8 }}>
                <Users size={16} aria-hidden />
                <h3 style={{ margin: 0 }}>Council</h3>
              </div>
              {/* Fills the form and stops. A demo that ran itself would spend
                  tokens nobody agreed to. Hidden when sample data is off,
                  except while the sample is loaded — clearing a form has to
                  stay possible however the flag now stands. */}
              {(samples || sampleLoaded) && (
                <button
                  title={
                    sampleLoaded
                      ? "Empty the question and the roster"
                      : "Fill in a worked example — a real trade-off and three stances that disagree"
                  }
                  onClick={sampleLoaded ? clearSample : loadSample}
                >
                  <FlaskConical size={14} aria-hidden />{" "}
                  {sampleLoaded ? "Clear sample" : "Load sample"}
                </button>
              )}
            </div>
            <textarea
              rows={2}
              value={question}
              placeholder="A debatable question — a trade-off, a design choice, a risk call…"
              onChange={(event) => setQuestion(event.target.value)}
            />

            {presets.length > 0 && (
              <div className="row" style={{ flexWrap: "wrap" }}>
                {presets.map((preset) => (
                  <span className="pill" key={preset.id}>
                    <button className="link" onClick={() => applyPreset(preset)}>
                      {preset.name}
                    </button>
                    {!preset.builtIn && (
                      <button
                        className="icon"
                        title="Delete preset"
                        aria-label="Delete preset"
                        onClick={() => void deletePreset(preset.id)}
                      >
                        <Trash2 size={14} aria-hidden />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="row between">
              <h3 style={{ margin: 0 }}>Members ({members.length})</h3>
              <button className="icon" title="Add member" aria-label="Add member" disabled={members.length >= 6} onClick={addMember}>
                <Plus size={16} aria-hidden />
              </button>
            </div>

            {members.map((member, index) => (
              <div className="card nested" key={index}>
                <div className="row between">
                  <div className="row" style={{ gap: 8, flex: 1 }}>
                    <MemberAvatar name={member.name} seat={index} />
                    <input
                      style={{ flex: 1 }}
                      placeholder="Name"
                      value={member.name}
                      onChange={(event) => setMember(index, { name: event.target.value })}
                    />
                  </div>
                  <button
                    className="icon danger"
                    title="Remove member"
                    aria-label="Remove member"
                    disabled={members.length <= 2}
                    onClick={() => removeMember(index)}
                  >
                    <Trash2 size={16} aria-hidden />
                  </button>
                </div>
                <input
                  placeholder="Stance / role brief — advocate, skeptic, cost, security, end user…"
                  value={member.stance}
                  onChange={(event) => setMember(index, { stance: event.target.value })}
                />
                <div className="field-row">
                  <label>Model</label>
                  <select value={member.modelId} onChange={(event) => setMember(index, { modelId: event.target.value })}>
                    <option value="">Council default</option>
                    {entries.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.displayName}
                      </option>
                    ))}
                  </select>
                </div>
                <input
                  placeholder="Skills (comma separated, optional)"
                  value={member.skills}
                  onChange={(event) => setMember(index, { skills: event.target.value })}
                />
                <input
                  placeholder="Tool families (comma separated, optional)"
                  value={member.toolFamilies}
                  onChange={(event) => setMember(index, { toolFamilies: event.target.value })}
                />
              </div>
            ))}
          </div>

          <div className="card">
            <div className="field-row">
              <label>Round budget</label>
              <select value={roundBudget} onChange={(event) => setRoundBudget(Number(event.target.value))}>
                {[1, 2, 3, 4, 5, 6].map((value) => (
                  <option key={value} value={value}>
                    {value} round{value === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
            </div>
            <p className="muted">
              Estimated spend — ~{estimate.toLocaleString()} tokens across {members.length} members ·{" "}
              {roundBudget} rounds. A council multiplies token cost; this is a rough figure shown before you commit.
            </p>

            <div className="row">
              <button className="primary" disabled={busy || question.trim() === "" || !rosterValid} onClick={() => void start()}>
                <Gavel size={16} aria-hidden /> {busy ? "Starting…" : "Convene council"}
              </button>
            </div>
            {!rosterValid && (
              <div className="muted">Each of 2–6 members needs a name and a stance.</div>
            )}

            <div className="row" style={{ marginTop: 8 }}>
              <input
                placeholder="Save this roster as a preset…"
                value={presetName}
                onChange={(event) => setPresetName(event.target.value)}
              />
              <button disabled={presetName.trim() === "" || !rosterValid} onClick={() => void savePreset()}>
                <Save size={16} aria-hidden /> Save preset
              </button>
            </div>
          </div>
        </>
      )}
      </div>
    </div>
  );
}

function RunView({
  run,
  onError,
  onRefresh,
  onRename,
  onDelete,
}: {
  run: CouncilRun;
  onError: (problem: unknown) => void;
  onRefresh: () => Promise<void>;
  onRename: (title: string) => Promise<void>;
  onDelete: () => Promise<void>;
}): JSX.Element {
  const [injection, setInjection] = useState("");
  /**
   * The title being typed, or null when it is not being edited.
   *
   * Empty string is a meaningful value here — it clears the name and puts the
   * run back to being called by its question — so "not editing" has to be a
   * different value from "editing, blank".
   */
  const [draftTitle, setDraftTitle] = useState<string | null>(null);
  /**
   * Two presses to delete, like the rail's own delete.
   *
   * A run is minutes of several models arguing and it cannot be recreated, so
   * a single mis-aimed click is not an acceptable way to lose one.
   */
  const [armed, setArmed] = useState(false);

  const inject = async (): Promise<void> => {
    if (injection.trim() === "") return;
    try {
      await call("council:inject", { runId: run.id, text: injection.trim() });
      setInjection("");
      await onRefresh();
    } catch (problem) {
      onError(problem);
    }
  };

  const act = async (channel: "council:forceVerdict" | "council:cancel"): Promise<void> => {
    try {
      await call(channel, { runId: run.id });
      await onRefresh();
    } catch (problem) {
      onError(problem);
    }
  };

  // Group contributions by round so the transcript reads as debate, not a wall.
  const rounds = groupByRound(run.contributions);
  const active = run.status === "running" || run.status === "awaiting_input";

  return (
    <div className="card">
      <div className="row between">
        <div>
          {draftTitle === null ? (
            <div className="row" style={{ gap: 6 }}>
              {/* Double-click as well as the pencil, matching the rail rows —
                  the two lists show the same runs and a control that works in
                  one and not the other reads as a bug in whichever was tried
                  second. */}
              <strong onDoubleClick={() => setDraftTitle(run.title)} title={run.question}>
                {councilRunTitle(run)}
              </strong>
              <button
                className="icon"
                title="Rename this run"
                aria-label={`Rename ${councilRunTitle(run)}`}
                onClick={() => setDraftTitle(run.title)}
              >
                <Pencil size={13} aria-hidden />
              </button>
            </div>
          ) : (
            <input
              autoFocus
              value={draftTitle}
              maxLength={120}
              aria-label="Council run name"
              placeholder={run.question}
              onChange={(event) => setDraftTitle(event.target.value)}
              onBlur={() => setDraftTitle(null)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  const next = draftTitle;
                  setDraftTitle(null);
                  void onRename(next);
                }
                // Escape abandons the edit. Blank is committable on purpose
                // (it clears the name), so it cannot double as "cancel".
                if (event.key === "Escape") setDraftTitle(null);
              }}
            />
          )}
          <div className="muted">
            {run.phase} · {run.members.length} members ·{" "}
            <span className="mono">~{run.estimatedTokens.toLocaleString()} tokens</span>
          </div>
          {/* Once a run is named, what it was actually asked would otherwise
              disappear from every surface — and the question is the thing the
              members answered. Shown underneath rather than replaced. */}
          {run.title.trim() !== "" && (
            <div className="muted" style={{ marginTop: 2 }}>
              Asked: {run.question}
            </div>
          )}
        </div>
        <span className={`pill${run.status === "complete" ? " ok" : run.status === "failed" ? " bad" : " warn"}`}>
          {active && <span className="spinner" aria-hidden />} {run.status}
        </span>
      </div>

      <div className="row" style={{ marginTop: 6 }}>
        <button
          className={armed ? "danger" : "ghost"}
          title={
            armed
              ? "Press again to delete this run, its transcript and its verdict"
              : "Delete this council run"
          }
          onClick={() => {
            if (!armed) {
              setArmed(true);
              return;
            }
            setArmed(false);
            void onDelete();
          }}
        >
          <Trash2 size={16} aria-hidden /> {armed ? "Press again to delete" : "Delete run"}
        </button>
        {armed && (
          <button className="link" onClick={() => setArmed(false)}>
            Keep it
          </button>
        )}
      </div>

      <div className="round-budget">
        Round {run.roundsRun} of {run.roundBudget}
        <div className="progress">
          <div className="progress-fill" style={{ width: `${budgetPercent(run.roundsRun, run.roundBudget)}%` }} />
        </div>
      </div>

      {run.error !== "" && <div className="notice">{run.error}</div>}

      {rounds.map(({ round, contributions }) => (
        <RoundGroup key={round} round={round} contributions={contributions} />
      ))}

      {run.verdict && <Verdict verdict={run.verdict} onError={onError} />}

      {active && (
        <div className="card nested" style={{ marginTop: 12 }}>
          <p className="muted">Injections and the force-verdict call take effect at the next round boundary.</p>
          <div className="row">
            <input
              style={{ flex: 1 }}
              placeholder="Inject a constraint or challenge a member…"
              value={injection}
              onChange={(event) => setInjection(event.target.value)}
            />
            <button title="Inject" aria-label="Inject message" disabled={injection.trim() === ""} onClick={() => void inject()}>
              <Send size={16} aria-hidden />
            </button>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={() => void act("council:forceVerdict")}>
              <Gavel size={16} aria-hidden /> Force verdict
            </button>
            <button className="danger" onClick={() => void act("council:cancel")}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RoundGroup({ round, contributions }: { round: number; contributions: CouncilContribution[] }): JSX.Element {
  const [open, setOpen] = useState(true);
  const phase = contributions[0]?.phase ?? "";
  return (
    <div className="round-group">
      <button className="round-header" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
        <strong>Round {round + 1}</strong>
        {phase !== "" && <span className="muted"> · {phase}</span>}
      </button>
      {open && contributions.map((contribution) => <MemberCard key={contribution.id} contribution={contribution} />)}
    </div>
  );
}

function MemberCard({ contribution }: { contribution: CouncilContribution }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="member-card">
      <button className="row between" style={{ width: "100%" }} onClick={() => setOpen(!open)}>
        <div className="row" style={{ gap: 6 }}>
          {open ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
          <MemberAvatar name={contribution.memberName} />
          <strong>{contribution.memberName}</strong>
          <span className="muted">· {contribution.stance}</span>
        </div>
        <span className="pill mono">{shortModel(contribution.modelId)}</span>
      </button>
      <div className="status-line">{contribution.summary}</div>
      {open && (
        <div className="member-argument">
          {/* Members are asked for prose and sometimes answer with a JSON
              object anyway. Rendered as a message body, that lands in a code
              container inside the member's card instead of as a wall of raw
              text with the fence markers still in it. */}
          <MessageBody text={contribution.argument} />
          {contribution.toolCalls.map((toolCall, index) => (
            <div className={`tool-card${toolCall.ok ? "" : " bad"}`} key={index}>
              <strong>{toolCall.name}</strong>
              <span className="muted"> — {toolCall.summary}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Verdict({ verdict, onError }: { verdict: CouncilVerdict; onError: (problem: unknown) => void }): JSX.Element {
  const copy = (): void => {
    // No dedicated export channel exists; the server writes the verdict into the
    // bound project at `verdict.path`. Copying the Markdown lets the user take
    // it anywhere else without inventing a channel.
    navigator.clipboard.writeText(verdictMarkdown(verdict)).catch(onError);
  };
  return (
    <div className="card verdict">
      <div className="row between">
        <h3 style={{ margin: 0 }}>Verdict</h3>
        <div className="row">
          <span className={`pill ${verdict.confidence === "high" ? "ok" : verdict.confidence === "low" ? "warn" : ""}`}>
            {verdict.confidence} confidence
          </span>
          <button className="icon" title="Copy verdict Markdown" aria-label="Copy verdict Markdown" onClick={copy}>
            <Copy size={16} aria-hidden />
          </button>
        </div>
      </div>

      <p>
        <strong>Recommendation.</strong> {verdict.recommendation}
      </p>

      {verdict.criteria.length > 0 && (
        <div>
          <strong>Decision criteria</strong>
          <ul>
            {verdict.criteria.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {verdict.strongestFor !== "" && (
        <p>
          <strong>Strongest for.</strong> {verdict.strongestFor}
        </p>
      )}
      {verdict.strongestAgainst !== "" && (
        <p>
          <strong>Strongest against.</strong> {verdict.strongestAgainst}
        </p>
      )}

      {verdict.dissent.length > 0 && (
        <div className="notice">
          <strong>Dissent</strong>
          {verdict.dissent.map((entry, index) => (
            <div className="trace-line" key={index}>
              {entry.memberName}: {entry.position}
            </div>
          ))}
        </div>
      )}

      {verdict.openQuestions.length > 0 && (
        <div>
          <strong>Open questions</strong>
          <ul>
            {verdict.openQuestions.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {verdict.path !== "" && (
        <div className="muted mono" style={{ fontSize: 11 }}>
          Exported to project: {verdict.path}
        </div>
      )}
    </div>
  );
}

function groupByRound(
  contributions: CouncilContribution[],
): Array<{ round: number; contributions: CouncilContribution[] }> {
  const byRound = new Map<number, CouncilContribution[]>();
  for (const contribution of contributions) {
    const bucket = byRound.get(contribution.round);
    if (bucket) bucket.push(contribution);
    else byRound.set(contribution.round, [contribution]);
  }
  return [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, list]) => ({ round, contributions: list }));
}

function verdictMarkdown(verdict: CouncilVerdict): string {
  const lines = [
    `# Council verdict`,
    ``,
    `**Recommendation:** ${verdict.recommendation}`,
    `**Confidence:** ${verdict.confidence}`,
  ];
  if (verdict.criteria.length > 0) lines.push(``, `## Criteria`, ...verdict.criteria.map((item) => `- ${item}`));
  if (verdict.strongestFor !== "") lines.push(``, `## Strongest for`, verdict.strongestFor);
  if (verdict.strongestAgainst !== "") lines.push(``, `## Strongest against`, verdict.strongestAgainst);
  if (verdict.dissent.length > 0)
    lines.push(``, `## Dissent`, ...verdict.dissent.map((entry) => `- ${entry.memberName}: ${entry.position}`));
  if (verdict.openQuestions.length > 0)
    lines.push(``, `## Open questions`, ...verdict.openQuestions.map((item) => `- ${item}`));
  return lines.join("\n");
}

const splitList = (raw: string): string[] =>
  raw.split(",").map((value) => value.trim()).filter((value) => value !== "");

const budgetPercent = (run: number, budget: number): number =>
  budget <= 0 ? 0 : Math.min(100, Math.round((run / budget) * 100));

const shortModel = (modelId: string): string => (modelId === "" ? "default" : modelId.replace(/^(copilot|foundry):/, ""));
