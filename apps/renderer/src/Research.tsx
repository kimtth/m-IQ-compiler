import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileCheck,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type {
  ResearchConflict,
  ResearchGate,
  ResearchQuestion,
  ResearchRun,
  ResearchStartInput,
} from "@iq/shared";
import {
  RESEARCH_QUESTION_CEILING,
  canApprovePlan,
  canCancelRun,
  canEditPlan,
  canRefineRun,
  canRerunQuestion,
  canWriteReport,
  isRunActive,
  unsettledQuestions,
} from "@iq/shared";
import { call, subscribe } from "./bridge.js";
import { ResearchGraphView } from "./ResearchGraph.js";
import { MarkdownDocument } from "./industry/render.js";

/**
 * Chat → Research.
 *
 * A research run is a visible plan, never a black box: the topic is decomposed
 * into questions the user can edit, each gathered by a delegated sub-agent, and
 * one writer synthesises the report. The two rules that make the output worth
 * trusting are surfaced rather than smoothed over — an unanswerable claim is
 * shown as unverified, and disagreeing sources are shown as a conflict.
 */

/**
 * The prefix on a question that exists only in this component.
 *
 * A row needs a stable React key from the moment it is added, but an id is the
 * privileged side's to issue. Naming the local ones means the two can never be
 * confused: `savePlan` sends no id for them, and a control that needs a real
 * run is withheld rather than offered and failed.
 */
const DRAFT_ID_PREFIX = "draft-";

const isDraftId = (id: string): boolean => id.startsWith(DRAFT_ID_PREFIX);

interface ResearchProps {
  projectId: string | null;
  onError: (problem: unknown) => void;
}

export function Research({ projectId, onError }: ResearchProps): JSX.Element {
  const [runs, setRuns] = useState<ResearchRun[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const history = await call("research:list");
      setRuns(history);
      setSelectedId((current) =>
        current !== "" && history.some((run) => run.id === current) ? current : (history[0]?.id ?? ""),
      );
    } catch (problem) {
      onError(problem);
    }
  }, [onError]);

  useEffect(() => {
    void load();
    return subscribe<ResearchRun>("research:changed", (run) => {
      setRuns((current) => [run, ...current.filter((existing) => existing.id !== run.id)]);
    });
  }, [load]);

  const start = async (): Promise<void> => {
    if (topic.trim() === "") return;
    setBusy(true);
    try {
      const input: ResearchStartInput = {
        topic: topic.trim(),
        projectId,
        questions: [],
        maxParallel: 3,
        // One follow-up round on whatever the first leaves thin. The manager
        // decides whether to spend it; this is the ceiling it cannot argue with.
        maxRounds: 2,
      };
      const run = await call("research:start", input);
      setTopic("");
      setSelectedId(run.id);
      await load();
    } catch (problem) {
      onError(problem);
    } finally {
      setBusy(false);
    }
  };

  const selected = runs.find((run) => run.id === selectedId) ?? null;

  /**
   * Delete is armed, not immediate.
   *
   * It sits beside the dropdown because that is where the run is chosen, and
   * the thing you are about to remove is the thing named in the box next to it.
   * The arming disarms itself whenever the selection moves.
   */
  const [deleteArmed, setDeleteArmed] = useState(false);
  useEffect(() => setDeleteArmed(false), [selectedId]);

  const deleteRun = async (runId: string): Promise<void> => {
    try {
      await call("research:delete", { runId });
      await load();
    } catch (problem) {
      onError(problem);
    }
  };

  return (
    /* `.pane-body` because Research moved out of the canvas and into the chat
       pane. A pane is `overflow: hidden` and only gives a bare `.stack` a
       gutter and a scrollbar when the pane is the canvas, so here the surface
       was cut off at the bottom edge with nothing to scroll: the reasoning
       graph, the review notes and the report were all rendered and none of
       them could be reached. The body is what owns the gutter and the scroll. */
    <div className="pane-body stack">
      <div className="card">
        <h3>New research</h3>
        <textarea
          rows={2}
          value={topic}
          placeholder="What should the report answer?"
          onChange={(event) => setTopic(event.target.value)}
        />
        <div className="row">
          <button className="primary" disabled={busy || topic.trim() === ""} onClick={() => void start()}>
            {busy ? "Planning…" : "Plan the report"}
          </button>
          <span className="muted">The agent decomposes the topic into questions you can edit before gathering.</span>
        </div>
      </div>

      {runs.length > 0 && (
        <div className="card research-history">
          <div>
            <h3>Research history</h3>
            <p className="muted">Research stays here instead of creating a Chat conversation.</p>
          </div>
          <label className="stacked-field">
            <span>Saved runs</span>
            <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.topic} — {run.status}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <div className="row">
              <button
                className={deleteArmed ? "danger" : "ghost"}
                title={
                  deleteArmed
                    ? "Press again to delete this saved research run and its findings. The project report stays."
                    : "Delete the selected research run. The project report stays."
                }
                onClick={() => {
                  if (!deleteArmed) {
                    setDeleteArmed(true);
                    return;
                  }
                  setDeleteArmed(false);
                  void deleteRun(selected.id);
                }}
              >
                <Trash2 size={16} aria-hidden />{" "}
                {deleteArmed ? "Press again to delete" : "Delete run"}
              </button>
              {deleteArmed && (
                <button className="link" onClick={() => setDeleteArmed(false)}>
                  Keep it
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {selected && <RunDetail run={selected} onError={onError} onRefresh={load} />}
    </div>
  );
}

function RunDetail({
  run,
  onError,
  onRefresh,
}: {
  run: ResearchRun;
  onError: (problem: unknown) => void;
  onRefresh: () => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState<ResearchQuestion[]>(run.questions);
  const [dirty, setDirty] = useState(false);

  /**
   * Every control on this card asks the run the same question the service will.
   *
   * The predicates live in `@iq/shared` for exactly that reason: a rule that is
   * re-derived here is a rule that can drift, and every time it drifted the
   * result was a control the user could press that could only report a refusal.
   */
  const editable = canEditPlan(run).allowed;
  const approve = canApprovePlan(run);
  const write = canWriteReport(run);
  const unsettled = unsettledQuestions(run).length;

  /**
   * Keep the editable copy in step with the run.
   *
   * Two conditions, and the second one matters as much as the first. Mid-edit
   * the draft is left alone, because a run that re-publishes while someone is
   * typing must not wipe what they have written. But **once the plan can no
   * longer be edited there is nothing left to protect**, and holding the draft
   * then is actively wrong: `dirty` never clears by itself, so a run that began
   * gathering with an unsaved edit showed that stale local list for the rest of
   * its life while the counter beneath it reported the real plan. That is how a
   * 7-question run came to be displayed as three questions and "7 of 7 still
   * gathering" — the list and the count were describing different things.
   */
  useEffect(() => {
    if (!dirty || !editable) {
      setDraft(run.questions);
      setDirty(false);
    }
  }, [run.questions, dirty, editable]);

  const act = async (channel: "research:approvePlan" | "research:write" | "research:cancel"): Promise<void> => {
    try {
      await call(channel, { runId: run.id });
      await onRefresh();
    } catch (problem) {
      onError(problem);
    }
  };

  const rerun = async (questionId: string): Promise<void> => {
    try {
      await call("research:rerunQuestion", { runId: run.id, questionId });
      await onRefresh();
    } catch (problem) {
      onError(problem);
    }
  };

  /**
   * Send a note about the finished report.
   *
   * Returns false on refusal so the box can keep what was typed. A note the
   * reader has to write twice because the send failed is a note they do not
   * write again.
   */
  const refine = async (note: string): Promise<boolean> => {
    try {
      await call("research:refine", { runId: run.id, note });
      await onRefresh();
      return true;
    } catch (problem) {
      onError(problem);
      return false;
    }
  };

  const savePlan = async (): Promise<void> => {
    await sendPlan();
  };

  /**
   * Push the edited plan to the privileged side.
   *
   * Separated from `savePlan` so approving can reuse it. Returns false when the
   * write failed, which is what stops an approval going ahead against a plan
   * the user did not see.
   */
  const sendPlan = async (): Promise<boolean> => {
    try {
      await call("research:updatePlan", {
        runId: run.id,
        // A row that only exists here sends no id. The channel's `id` is
        // optional precisely so a new question can say "I have none"; sending
        // the renderer's own key instead made a local placeholder look like a
        // server id, and the privileged side has no way to tell them apart.
        questions: draft.map((question) =>
          isDraftId(question.id)
            ? { question: question.question }
            : { id: question.id, question: question.question },
        ),
      });
      setDirty(false);
      await onRefresh();
      return true;
    } catch (problem) {
      onError(problem);
      return false;
    }
  };

  /**
   * Approve the plan **that is on screen**.
   *
   * Any pending edit is written first. Without this, approving sent nothing but
   * a run id, so the privileged side gathered whatever it still held — and a
   * plan someone had edited down was silently ignored. Measured: a run whose
   * four deleted questions were all gathered anyway, reported underneath the
   * three the user could see as "7 of 7 still gathering".
   *
   * Deleting a question is the case that makes this urgent rather than
   * cosmetic. A missed *edit* wastes a question; a missed *deletion* runs work
   * the user explicitly removed, against sources they chose not to consult,
   * and bills them for it.
   */
  const approveAndGather = async (): Promise<void> => {
    if (dirty && !(await sendPlan())) return;
    await act("research:approvePlan");
  };

  const editQuestion = (index: number, value: string): void => {
    setDirty(true);
    setDraft((current) => current.map((question, position) => (position === index ? { ...question, question: value } : question)));
  };

  const addQuestion = (): void => {
    setDirty(true);
    // A freshly-added question exists only here until the plan is saved. It
    // still needs a stable React key, so it gets a draft id — which `savePlan`
    // strips and which the row uses to withhold controls that need a run.
    setDraft((current) => [
      ...current,
      { ...BLANK_QUESTION, id: `${DRAFT_ID_PREFIX}${current.length}-${Date.now()}` },
    ]);
  };

  const removeQuestion = (index: number): void => {
    setDirty(true);
    setDraft((current) => current.filter((_, position) => position !== index));
  };

  /**
   * Writing needs a *settled* round, not merely a gathering run.
   *
   * That rule is `canWriteReport`'s, not this file's — see `@iq/shared`. What
   * belongs here is only the presentation of it: disabled with the reason
   * rather than hidden, because writing is the run's next step and the user is
   * waiting for it, so a control that disappears reads as a run with nothing
   * left to do.
   */

  return (
    <div className="card">
      <div className="row between">
        <div>
          <strong>{run.topic}</strong>
          <div className="muted">
            Status: {run.status}
            {run.maxRounds > 1 && ` · round ${run.round} of at most ${run.maxRounds}`}
          </div>
        </div>
        <div className="row">
          <button className="icon" title="Refresh" aria-label="Refresh run" onClick={() => void onRefresh()}>
            <RefreshCw size={16} aria-hidden />
          </button>
          {canCancelRun(run).allowed ? (
            <button className="danger" onClick={() => void act("research:cancel")}>
              Cancel
            </button>
          ) : null}
        </div>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <h3 style={{ margin: 0 }}>Plan</h3>
        {editable && (
          <button className="icon" title="Add question" aria-label="Add question" onClick={addQuestion}>
            <Plus size={16} aria-hidden />
          </button>
        )}
      </div>

      {draft.map((question, index) => (
        <PlanQuestion
          key={question.id}
          question={question}
          editable={editable}
          rerunnable={canRerunQuestion(run, question.id)}
          onEdit={(value) => editQuestion(index, value)}
          onRemove={() => removeQuestion(index)}
          onRerun={() => void rerun(question.id)}
        />
      ))}

      <div className="row" style={{ marginTop: 8 }}>
        {editable && dirty && (
          <button onClick={() => void savePlan()}>Save plan</button>
        )}
        {run.status === "awaiting_review" && (
          <button
            className="primary"
            disabled={!approve.allowed}
            title={approve.reason}
            onClick={() => void approveAndGather()}
          >
            Approve plan &amp; gather
          </button>
        )}
        {run.status === "gathering" && (
          <button
            className="primary"
            disabled={!write.allowed}
            title={write.reason}
            onClick={() => void act("research:write")}
          >
            <FileCheck size={16} aria-hidden /> Write the report
          </button>
        )}
        {run.status === "gathering" && unsettled > 0 && (
          <span className="muted">
            {unsettled} of {run.questions.length} still gathering…
          </span>
        )}
        {run.status === "reflecting" && (
          <span className="muted">Reviewing the round before the report…</span>
        )}
        {run.status === "refining" && (
          <span className="muted">Working out what your note needs looked up…</span>
        )}
      </div>

      {run.graph.nodes.length > 0 && (
        <ResearchGraphView runId={run.id} graph={run.graph} active={isRunActive(run)} />
      )}
      {run.ledger.length > 0 && <Ledger run={run} />}

      {run.report.markdown !== "" && (
        <Report run={run} write={write} onRewrite={() => void act("research:write")} onRefine={refine} />
      )}
    </div>
  );
}

/**
 * What the manager concluded at the end of each round.
 *
 * Shown because a plan that grew questions the user never approved has to be
 * answerable: this is where "why did it ask that?" is written down.
 */
function Ledger({ run }: { run: ResearchRun }): JSX.Element {
  return (
    <details className="plan-question" style={{ marginTop: 8 }}>
      <summary>
        Review notes<span className="muted"> · {run.ledger.length} round{run.ledger.length === 1 ? "" : "s"}</span>
      </summary>
      {run.ledger.map((note) => (
        <div key={note.round} style={{ marginTop: 8 }}>
          <strong>Round {note.round}</strong>
          {note.assessment !== "" && <p style={{ margin: "4px 0" }}>{note.assessment}</p>}
          {note.followUps.length > 0 && (
            <ul style={{ margin: "4px 0" }}>
              {note.followUps.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          )}
          {note.stopped !== "" && <div className="muted">Stopped: {note.stopped}</div>}
        </div>
      ))}
    </details>
  );
}

function PlanQuestion({
  question,
  editable,
  rerunnable,
  onEdit,
  onRemove,
  onRerun,
}: {
  question: ResearchQuestion;
  editable: boolean;
  rerunnable: ResearchGate;
  onEdit: (value: string) => void;
  onRemove: () => void;
  onRerun: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  /**
   * The re-run rule is `canRerunQuestion`'s, and it is asked against the *run*,
   * not against this row.
   *
   * That matters because a row the user has just added exists only here until
   * the plan is saved, so the run has never heard of it — and the gate answers
   * "unknown question" without the id ever leaving the surface. Offered
   * unconditionally, the control could only fail: on a draft row it reported
   * `unknown question draft-0-…`, leaking a React key into the user's error,
   * and on a saved but ungathered one it answered "approve the plan first" — a
   * rule the button could have known.
   */
  return (
    <div className="plan-question">
      <div className="row between">
        <div className="row" style={{ flex: 1, gap: 6 }}>
          <button
            className="icon"
            title={open ? "Hide detail" : "Show detail"}
            aria-label={open ? "Hide detail" : "Show detail"}
            onClick={() => setOpen(!open)}
          >
            {open ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
          </button>
          {editable ? (
            <input style={{ flex: 1 }} value={question.question} onChange={(event) => onEdit(event.target.value)} />
          ) : (
            <span style={{ flex: 1 }}>{question.question}</span>
          )}
        </div>
        <div className="row">
          <span className={`pill ${statusTone(question.status)}`}>
            {question.status === "running" && <span className="spinner" aria-hidden />} {question.status}
          </span>
          {rerunnable.allowed && (
            <button className="icon" title="Re-run this question" aria-label="Re-run this question" onClick={onRerun}>
              <RotateCcw size={16} aria-hidden />
            </button>
          )}
          {editable && (
            <button className="icon danger" title="Remove question" aria-label="Remove question" onClick={onRemove}>
              <Trash2 size={16} aria-hidden />
            </button>
          )}
        </div>
      </div>

      <div className="status-line">{question.statusLine || " "}</div>

      {open && (
        <div className="trace">
          {question.findings !== "" && <div className="trace-line">{question.findings}</div>}
          {question.status === "unverified" && (
            <div className="trace-line warn">
              <TriangleAlert size={14} aria-hidden /> Unverified — no source could confirm this.
            </div>
          )}
          {question.error !== "" && <div className="trace-line bad">{question.error}</div>}
          {question.sources.length > 0 && (
            <div className="trace-line">Sources: {question.sources.join(", ")}</div>
          )}
          {question.citations.map((citation, index) => (
            <div className="trace-line" key={index}>
              [{citation.kind}] {citation.title || citation.ref}
            </div>
          ))}
          {question.conflicts.map((conflict, index) => (
            <Conflict conflict={conflict} key={index} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A conflict is never resolved silently; both positions are shown attributed. */
function Conflict({ conflict }: { conflict: ResearchConflict }): JSX.Element {
  return (
    <div className="notice">
      <div className="row" style={{ gap: 6 }}>
        <TriangleAlert size={14} aria-hidden />
        <strong>Conflict: {conflict.claim}</strong>
      </div>
      {conflict.positions.map((position, index) => (
        <div className="trace-line" key={index}>
          {position.statement} — [{position.citation.kind}] {position.citation.title || position.citation.ref}
        </div>
      ))}
    </div>
  );
}

function Report({
  run,
  write,
  onRewrite,
  onRefine,
}: {
  run: ResearchRun;
  write: ResearchGate;
  onRewrite: () => void;
  onRefine: (note: string) => Promise<boolean>;
}): JSX.Element {
  return (
    <div className="card nested" style={{ marginTop: 12 }}>
      <div className="row between">
        <strong>Report</strong>
        {/* Gated like every other control on this card. Offered ungated it
            called a channel that refused on a finished run, so the one action
            a reader was given on the thing they had just read could only
            fail. */}
        <button
          className="icon"
          title={write.allowed ? "Write it again from the same evidence" : write.reason}
          aria-label="Re-run report"
          disabled={!write.allowed}
          onClick={onRewrite}
        >
          <RefreshCw size={16} aria-hidden />
        </button>
      </div>
      {run.report.path !== "" && <div className="muted mono" style={{ fontSize: 11 }}>{run.report.path}</div>}

      {/* The report is a Markdown document, not a preformatted transcript.
          Rendering its headings, lists and source table makes the on-screen
          view match the saved .md file without adding an HTML injection path. */}
      <MarkdownDocument markdown={run.report.markdown} />

      <ReportFeedback run={run} onRefine={onRefine} />
    </div>
  );
}

/**
 * What the reader gets to say back.
 *
 * Research used to end here: a report, and no way to answer it. The reader
 * could see that a section rested on one blog post and had nowhere to put that
 * observation — the run's only remaining transitions were re-run one question,
 * or delete the whole thing.
 *
 * The box takes prose rather than questions on purpose. Working out what has
 * to be looked up is the manager's turn, and it happens on the privileged side
 * where the plan's ceiling is enforced. The reader states the problem; the run
 * decides what evidence answers it.
 *
 * Past notes stay on screen with what each one produced, because a report that
 * changed has to be able to say why.
 */
function ReportFeedback({
  run,
  onRefine,
}: {
  run: ResearchRun;
  onRefine: (note: string) => Promise<boolean>;
}): JSX.Element {
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const gate = canRefineRun(run, RESEARCH_QUESTION_CEILING);

  const send = async (): Promise<void> => {
    const text = note.trim();
    if (text === "" || sending) return;
    setSending(true);
    // Cleared only on success, so a refusal does not eat what was written.
    if (await onRefine(text)) setNote("");
    setSending(false);
  };

  return (
    <div className="report-feedback">
      {run.feedback.length > 0 && (
        <div className="feedback-history">
          {run.feedback.map((entry) => (
            <div className="feedback-note" key={entry.id}>
              <div className="feedback-said">{entry.note}</div>
              {entry.questions.length > 0 ? (
                <ul className="feedback-raised">
                  {entry.questions.map((question, index) => (
                    <li key={index}>{question}</li>
                  ))}
                </ul>
              ) : (
                <div className="muted">
                  {entry.declined || "the report was written again from the same evidence"}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <label className="feedback-label" htmlFor={`refine-${run.id}`}>
        What is wrong with this report?
      </label>
      <textarea
        id={`refine-${run.id}`}
        rows={2}
        value={note}
        placeholder="e.g. the cost figures rest on one blog post — find a primary source"
        disabled={!gate.allowed || sending}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="row between">
        <span className="muted">
          {gate.allowed
            ? `${run.questions.length} of ${RESEARCH_QUESTION_CEILING} questions used`
            : gate.reason}
        </span>
        <button
          className="primary"
          disabled={!gate.allowed || sending || note.trim() === ""}
          title={gate.reason}
          onClick={() => void send()}
        >
          <MessageSquarePlus size={16} aria-hidden /> Revise the report
        </button>
      </div>
    </div>
  );
}

const BLANK_QUESTION: ResearchQuestion = {
  id: "",
  question: "",
  status: "pending",
  statusLine: "",
  findings: "",
  citations: [],
  conflicts: [],
  sources: [],
  error: "",
  startedAt: null,
  finishedAt: null,
  taskId: "",
  round: 1,
  parentId: "",
};

function statusTone(status: ResearchQuestion["status"]): string {
  switch (status) {
    case "answered":
      return "ok";
    case "failed":
      return "bad";
    case "unverified":
      return "warn";
    default:
      return "";
  }
}
