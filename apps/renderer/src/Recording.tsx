import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Circle,
  FolderOpen,
  Flag,
  Mic,
  Square,
  Trash2,
  Video,
} from "lucide-react";
import type {
  AnalysisStep,
  BuildKind,
  PlanValue,
  RecorderStatus,
  RecordingAnalysis,
  RecordingBuild,
  RecordingPlan,
  RecordingProgress,
  RecordingRecord,
  Trigger,
} from "@iq/shared";
import { renderValues } from "@iq/shared";
import { call, callAs, subscribe } from "./bridge.js";

/**
 * Skill Recording: do the task once, get a skill that repeats it.
 *
 * The pipeline is Record → Analyse → Approve → Build, and it is laid out in
 * that order because each stage is a gate on the next: nothing is analysed
 * until it has been recorded and looked at, nothing is planned until the
 * reconstruction has been approved, and nothing is written until the plan has
 * been read.
 *
 * ## What this component is not allowed to decide
 *
 * Three things are deliberately not this file's to choose, and every one of
 * them is a place where a renderer-side decision would be a security bug:
 *
 *  - **Where the capture goes.** The start request says what to capture, never
 *    where to put it. The session directory belongs to the privileged side.
 *  - **What the notices say.** Both disclosures and their version come from
 *    core, so raising the version invalidates every acknowledgement at once
 *    instead of leaving a stale copy of the wording here.
 *  - **Who consented.** The analyse request carries the acknowledgement only.
 *    The identity on the consent record is stamped from the signed-in account
 *    by the privileged side — a renderer able to name who authorised an upload
 *    could name anyone.
 *
 * ## Why the second consent exists
 *
 * Capturing is local and reversible: discard and the media is gone. Analysing
 * is neither — it sends window titles, URLs and clipboard previews from real
 * work to a model, and that is this application's first bulk egress of screen
 * content. So it is gated separately, and the gate is placed after a control
 * that opens the session folder, because "I have reviewed what is about to be
 * sent" is only a meaningful thing to tick if looking was made easy.
 *
 * The recording indicator is driven by a pushed status rather than a poll. A
 * surface that asks every few seconds whether it is recording will, for those
 * few seconds, be wrong about the one thing it must never be wrong about.
 */

type Stage = "record" | "review" | "build";

const STAGE_LABELS: Record<Stage, string> = {
  record: "Record",
  review: "Reconstruction",
  build: "Build",
};

const RECORDER_LABELS: Record<RecorderStatus["state"], string> = {
  idle: "Ready",
  starting: "Starting",
  recording: "Recording",
  stopping: "Saving",
};

interface Notice {
  version: string;
  capture: string;
  analysis: string;
  signedIn: boolean;
}

const IDLE_STATUS: RecorderStatus = {
  state: "idle",
  recordingId: null,
  startedAt: null,
  eventCount: 0,
  frameCount: 0,
  videoActive: false,
  narrationActive: false,
  blockedReason: "",
};

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Say when an automation would run, in words.
 *
 * A cron expression is the exact answer and the wrong one to approve against:
 * the person deciding whether this should run unattended has to be able to read
 * the schedule, so the expression is shown as well as described rather than
 * instead of it.
 */
function describeTrigger(trigger: Trigger): string {
  switch (trigger.kind) {
    case "cron":
      return `on the schedule ${trigger.expression} (${trigger.timezone})`;
    case "interval":
      return `every ${Math.max(1, Math.round(trigger.everyMs / 60_000))} minutes`;
    case "once":
      return `once, at ${new Date(trigger.at).toLocaleString()}`;
    default:
      return "only when you run it";
  }
}

export function Recording({ onError }: { onError: (problem: unknown) => void }): JSX.Element {
  const [stage, setStage] = useState<Stage>("record");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [status, setStatus] = useState<RecorderStatus>(IDLE_STATUS);
  const [recordings, setRecordings] = useState<RecordingRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [analysis, setAnalysis] = useState<RecordingAnalysis | null>(null);
  const [plan, setPlan] = useState<RecordingPlan | null>(null);
  const [build, setBuild] = useState<RecordingBuild | null>(null);
  const [progress, setProgress] = useState<RecordingProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const selected = useMemo(
    () => recordings.find((entry) => entry.id === selectedId) ?? null,
    [recordings, selectedId],
  );

  const refreshList = useCallback(async () => {
    try {
      setRecordings(await call("recording:list"));
    } catch (problem) {
      onError(problem);
    }
  }, [onError]);

  useEffect(() => {
    void (async () => {
      try {
        setNotice(await callAs<Notice>("recording:notice"));
        setStatus(await call("recording:status"));
      } catch (problem) {
        onError(problem);
      }
    })();
    void refreshList();
  }, [onError, refreshList]);

  useEffect(() => {
    const stopStatus = subscribe<RecorderStatus>("recording:status", setStatus);
    const stopProgress = subscribe<RecordingProgress>("recording:progress", setProgress);
    const stopChanged = subscribe<RecordingRecord>("recording:changed", (record) => {
      setRecordings((current) => {
        const without = current.filter((entry) => entry.id !== record.id);
        return record.status === "discarded"
          ? without
          : [record, ...without].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      });
    });
    return () => {
      stopStatus();
      stopProgress();
      stopChanged();
    };
  }, []);

  /**
   * The timer is derived from the pushed `startedAt`, not counted up locally.
   * A tick counter drifts, and — worse — survives a capture that has already
   * stopped, leaving a clock running next to a recorder that is idle.
   */
  useEffect(() => {
    if (status.state !== "recording" || status.startedAt === null) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.parse(status.startedAt);
    const tick = (): void => setElapsed(Math.round((Date.now() - startedAt) / 1_000));
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [status.state, status.startedAt]);

  /** Load everything already known about one recording, in one place. */
  const open = useCallback(
    async (recordingId: string) => {
      setSelectedId(recordingId);
      setAnalysis(null);
      setPlan(null);
      setBuild(null);
      setProgress(null);
      try {
        const [foundAnalysis, foundBuild] = await Promise.all([
          call("recording:analysis", { recordingId }),
          call("recording:getBuild", { recordingId }),
        ]);
        setAnalysis(foundAnalysis);
        setBuild(foundBuild);
        setPlan(foundBuild?.plan ?? null);
        setStage(foundBuild ? "build" : "review");
      } catch (problem) {
        onError(problem);
      }
    },
    [onError],
  );

  const run = useCallback(
    async (work: () => Promise<void>) => {
      setBusy(true);
      try {
        await work();
      } catch (problem) {
        onError(problem);
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [onError],
  );

  return (
    <>
      <div className="pane-header">
        <strong>Skill Recording</strong>
        <div className="row" style={{ gap: 4, marginLeft: 12 }}>
          {(Object.keys(STAGE_LABELS) as Stage[]).map((candidate) => (
            <button
              key={candidate}
              className={stage === candidate ? "primary" : "ghost"}
              aria-pressed={stage === candidate}
              disabled={candidate !== "record" && selected === null}
              title={
                candidate !== "record" && selected === null
                  ? "Choose a recording first"
                  : undefined
              }
              onClick={() => setStage(candidate)}
            >
              {STAGE_LABELS[candidate]}
            </button>
          ))}
        </div>
      </div>

      <div className="pane-body">
        <RecorderBar
          status={status}
          notice={notice}
          elapsed={elapsed}
          busy={busy}
          onStart={(input) =>
            void run(async () => {
              const record = await call("recording:start", input);
              setSelectedId(record.id);
              await refreshList();
            })
          }
          onStop={() =>
            void run(async () => {
              const record = await call("recording:stop");
              await refreshList();
              await open(record.id);
            })
          }
          onDiscard={() =>
            void run(async () => {
              await call("recording:discard");
              await refreshList();
            })
          }
          onMarker={(note) =>
            void run(async () => {
              await call("recording:marker", { note });
            })
          }
        />

        {progress !== null && (
          <div className="notice">
            {progress.phase}: {progress.message}
          </div>
        )}

        {stage === "record" && (
          <Library
            recordings={recordings}
            selectedId={selectedId}
            busy={busy || status.state !== "idle"}
            onOpen={(recordingId) => void open(recordingId)}
            onRename={(recordingId, title) =>
              void run(async () => {
                await call("recording:rename", { recordingId, title });
              })
            }
            onReveal={(recordingId) =>
              void run(async () => {
                await call("recording:reveal", { recordingId });
              })
            }
            onDelete={(recordingId) =>
              void run(async () => {
                await call("recording:delete", { recordingId });
                if (selectedId === recordingId) {
                  setSelectedId(null);
                  setAnalysis(null);
                  setPlan(null);
                  setBuild(null);
                }
                await refreshList();
              })
            }
          />
        )}

        {stage === "review" && selected !== null && (
          <Review
            record={selected}
            notice={notice}
            analysis={analysis}
            busy={busy}
            onAnalyse={() =>
              void run(async () => {
                if (notice === null) return;
                setAnalysis(
                  await call("recording:analyse", {
                    recordingId: selected.id,
                    acknowledgedNoticeVersion: notice.version,
                    contentReviewed: true,
                  }),
                );
                await refreshList();
              })
            }
            onFeedback={(overall, steps) =>
              void run(async () => {
                setAnalysis(
                  await call("recording:reanalyse", {
                    recordingId: selected.id,
                    feedback: { overall, steps },
                  }),
                );
              })
            }
            onEdit={(patch) =>
              void run(async () => {
                setAnalysis(
                  await call("recording:editAnalysis", {
                    recordingId: selected.id,
                    ...patch,
                  }),
                );
              })
            }
            onApprove={(approved) =>
              void run(async () => {
                const next = await call("recording:approveAnalysis", {
                  recordingId: selected.id,
                  approved,
                });
                setAnalysis(next);
                await refreshList();
                if (next.approved) setStage("build");
              })
            }
            onCancel={() =>
              void call("recording:cancelAnalysis", { recordingId: selected.id }).catch(onError)
            }
            onReveal={() =>
              void run(async () => {
                await call("recording:reveal", { recordingId: selected.id });
              })
            }
          />
        )}

        {stage === "build" && selected !== null && (
          <Build
            record={selected}
            analysis={analysis}
            plan={plan}
            build={build}
            busy={busy}
            onPlan={(kind) =>
              void run(async () => {
                setPlan(
                  await call("recording:plan", {
                    recordingId: selected.id,
                    kind,
                  }),
                );
              })
            }
            onReplan={(feedback) =>
              void run(async () => {
                setPlan(
                  await call("recording:replan", {
                    recordingId: selected.id,
                    feedback,
                  }),
                );
              })
            }
            onEditPlan={(next) =>
              void run(async () => {
                setPlan(
                  await call("recording:editPlan", {
                    recordingId: selected.id,
                    plan: next,
                  }),
                );
              })
            }
            onBuild={() =>
              void run(async () => {
                setBuild(
                  await call("recording:build", { recordingId: selected.id }),
                );
                await refreshList();
              })
            }
            onCancel={() =>
              void call("recording:cancelBuild", { recordingId: selected.id }).catch(onError)
            }
          />
        )}

        {stage !== "record" && selected === null && (
          <p className="muted">Choose a recording on the Record tab.</p>
        )}
      </div>
    </>
  );
}

// --- record ------------------------------------------------------------------

/**
 * The recorder, always in the same place.
 *
 * One control starts and stops. It is disabled with the reason attached rather
 * than hidden when a capture cannot start, so a machine that is not ready says
 * so instead of appearing to have no recorder at all.
 */
function RecorderBar({
  status,
  notice,
  elapsed,
  busy,
  onStart,
  onStop,
  onDiscard,
  onMarker,
}: {
  status: RecorderStatus;
  notice: Notice | null;
  elapsed: number;
  busy: boolean;
  onStart: (input: {
    acknowledgedNoticeVersion: string;
    captureVideo: boolean;
    captureNarration: boolean;
    microphone: string;
  }) => void;
  onStop: () => void;
  onDiscard: () => void;
  onMarker: (note: string) => void;
}): JSX.Element {
  const [captureVideo, setCaptureVideo] = useState(true);
  // Narration and the notice acknowledgement both start on. The recorder is
  // reached deliberately — nothing captures until the button is pressed — so
  // the notice is read on the way to a recording rather than clicked past on
  // the way out of a dialog, and the ticks are the defaults the recording is
  // wanted with rather than a gate to clear every session.
  const [captureNarration, setCaptureNarration] = useState(true);
  const [acknowledged, setAcknowledged] = useState(true);
  const [note, setNote] = useState("");

  const recording = status.state === "recording";
  const transitioning = status.state === "starting" || status.state === "stopping";

  const missing =
    notice === null
      ? "Loading…"
      : status.blockedReason !== ""
        ? status.blockedReason
        : !acknowledged
          ? "Acknowledge the recording notice first."
          : null;

  const canStart = status.state === "idle" && !busy && missing === null;

  return (
    <>
      <div className={`recorder-bar ${status.state}`}>
        <span className="state-dot" aria-hidden="true" />
        <div className="recorder-state">
          <strong>{RECORDER_LABELS[status.state]}</strong>
          <span className="mono">{formatClock(elapsed)}</span>
        </div>
        <div className="spacer" />
        {recording && (
          <>
            <span className="pill">{status.eventCount} events</span>
            <span className="pill">{status.frameCount} frames</span>
            <span className="pill recording">
              <Circle className="lucide" size={10} fill="currentColor" aria-hidden="true" />
              On air
            </span>
          </>
        )}
        <button
          className={recording ? "recorder-toggle stop" : "recorder-toggle"}
          disabled={transitioning || (!recording && !canStart)}
          title={recording ? "Stop recording" : (missing ?? "Start recording")}
          aria-label={recording ? "Stop recording" : "Start recording"}
          onClick={() =>
            recording
              ? onStop()
              : notice !== null &&
                onStart({
                  acknowledgedNoticeVersion: notice.version,
                  captureVideo,
                  captureNarration,
                  microphone: "",
                })
          }
        >
          {recording || status.state === "stopping" ? (
            <Square size={18} aria-hidden />
          ) : (
            <Video size={18} aria-hidden />
          )}
        </button>
      </div>

      {recording && (
        <div className="card approval">
          <h3>Recording this device · {formatClock(elapsed)}</h3>
          <p className="muted">
            The foreground window, its title, copied text and{" "}
            {status.videoActive ? "the screen" : "no screen capture"} are being written to this
            machine. Nothing is sent anywhere until you ask for it to be analysed.
          </p>
          <div className="row" style={{ marginTop: 8 }}>
            {/* A marker is the cheapest way to say "this bit matters" while
                the work is happening — the alternative is remembering it
                twenty minutes later, against a timeline of window titles. */}
            <input
              placeholder="Note what just happened…"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || note.trim() === "") return;
                onMarker(note.trim());
                setNote("");
              }}
            />
            <button
              disabled={busy || note.trim() === ""}
              onClick={() => {
                onMarker(note.trim());
                setNote("");
              }}
            >
              <Flag size={14} aria-hidden /> Mark
            </button>
            <button className="danger" disabled={busy} onClick={onDiscard}>
              <Trash2 size={14} aria-hidden /> Discard
            </button>
          </div>
        </div>
      )}

      {!recording && (
        <div className="card">
          <h3>Record a task</h3>
          <p className="muted">
            Do the job once, the way you normally would. Narrate why you are doing it if you can —
            a timeline says what happened, and only narration says why.
          </p>

          {status.blockedReason !== "" && <div className="notice">{status.blockedReason}</div>}

          <label className="row" style={{ gap: 6, marginTop: 10 }}>
            <input
              type="checkbox"
              disabled={status.state !== "idle"}
              checked={captureVideo}
              onChange={(event) => setCaptureVideo(event.target.checked)}
            />
            Capture the screen (one frame a second, kept on this device)
          </label>

          <label className="row" style={{ gap: 6, marginTop: 6 }}>
            <input
              type="checkbox"
              disabled={status.state !== "idle"}
              checked={captureNarration}
              onChange={(event) => setCaptureNarration(event.target.checked)}
            />
            <Mic size={14} aria-hidden /> Record spoken narration (transcribed on this device)
          </label>

          <pre className="notice">{notice?.capture}</pre>

          <label className="row" style={{ gap: 6, marginTop: 10 }}>
            <input
              type="checkbox"
              disabled={status.state !== "idle"}
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            I have read this notice and will not record anything I am not entitled to record.
          </label>

          <div className="row" style={{ marginTop: 12 }}>
            <span className="muted">Notice version {notice?.version}</span>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Everything recorded so far, as one dropdown rather than a wall of cards.
 *
 * A recording is a screen capture with narration, so the list grows fast and
 * every card is large. Picking from a dropdown and showing the one you picked
 * keeps the stage readable, and it matches Image Creation and Research — the
 * other two Co-create surfaces that keep their own history instead of filing a
 * Chat conversation.
 *
 * Delete is armed rather than immediate. This one really does remove the
 * captured video and audio from disk, which is not something to lose to a
 * misplaced click.
 */
function Library({
  recordings,
  selectedId,
  busy,
  onOpen,
  onRename,
  onReveal,
  onDelete,
}: {
  recordings: RecordingRecord[];
  selectedId: string | null;
  busy: boolean;
  onOpen: (recordingId: string) => void;
  onRename: (recordingId: string, title: string) => void;
  onReveal: (recordingId: string) => void;
  onDelete: (recordingId: string) => void;
}): JSX.Element {
  const [pickedId, setPickedId] = useState(selectedId ?? "");
  const [deleteArmed, setDeleteArmed] = useState(false);

  // Keep the pick on something that still exists, and follow the recording the
  // rest of the stage is working on when there is one.
  useEffect(() => {
    setPickedId((current) =>
      recordings.some((record) => record.id === current)
        ? current
        : (selectedId ?? recordings[0]?.id ?? ""),
    );
  }, [recordings, selectedId]);

  useEffect(() => setDeleteArmed(false), [pickedId]);

  if (recordings.length === 0) {
    return <p className="muted">Nothing has been recorded yet.</p>;
  }

  const picked = recordings.find((record) => record.id === pickedId) ?? null;

  return (
    <>
      <div className="card research-history">
        <div>
          <h3>Recording history</h3>
          <p className="muted">Recordings stay here instead of creating a Chat conversation.</p>
        </div>
        <label className="stacked-field">
          <span>Saved recordings</span>
          <select value={pickedId} onChange={(event) => setPickedId(event.target.value)}>
            {recordings.map((record) => (
              <option key={record.id} value={record.id}>
                {recordingLabel(record)}
              </option>
            ))}
          </select>
        </label>
        {picked !== null && (
          <div className="row">
            <button
              className={deleteArmed ? "danger" : "ghost"}
              disabled={busy}
              title={
                deleteArmed
                  ? "Press again to delete this recording, including the captured video and audio."
                  : "Delete the selected recording, including the captured video and audio."
              }
              onClick={() => {
                if (!deleteArmed) {
                  setDeleteArmed(true);
                  return;
                }
                setDeleteArmed(false);
                onDelete(picked.id);
              }}
            >
              <Trash2 size={16} aria-hidden />{" "}
              {deleteArmed ? "Press again to delete" : "Delete recording"}
            </button>
            {deleteArmed && (
              <button className="link" onClick={() => setDeleteArmed(false)}>
                Keep it
              </button>
            )}
          </div>
        )}
      </div>

      {picked !== null && (
        <div className="card" key={picked.id}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3>{picked.title === "" ? picked.id : picked.title}</h3>
            <div className="row">
              <span
                className={`pill${
                  picked.status === "analysed" ? " ok" : picked.status === "failed" ? " bad" : ""
                }`}
              >
                {picked.status}
              </span>
              {picked.analysisApproved && <span className="pill ok">approved</span>}
              {picked.hasVideo && <span className="pill">screen</span>}
              {picked.hasNarration && <span className="pill">narration</span>}
              <button
                className={selectedId === picked.id ? "primary" : ""}
                onClick={() => onOpen(picked.id)}
              >
                Open
              </button>
              <button
                title="Open the session folder and see exactly what was captured"
                onClick={() => onReveal(picked.id)}
              >
                <FolderOpen size={14} aria-hidden /> Files
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  const title = globalThis.prompt("Name this recording", picked.title);
                  if (title !== null && title.trim() !== "") onRename(picked.id, title.trim());
                }}
              >
                Rename
              </button>
            </div>
          </div>
          <div className="muted">
            {new Date(picked.startedAt).toLocaleString()} ·{" "}
            {formatClock(Math.round(picked.durationMs / 1_000))} · {picked.eventCount} events ·{" "}
            {picked.frameCount} frames
            {picked.builtSkillName !== null && ` · skill proposal ${picked.builtSkillName}`}
            {picked.builtJobId !== null && ` · automation ${picked.builtJobId}`}
          </div>
          {picked.error !== null && picked.error !== "" && (
            <div className="muted">{picked.error}</div>
          )}
        </div>
      )}
    </>
  );
}

/** One line for the history dropdown: what it is called, and how it went. */
function recordingLabel(record: RecordingRecord): string {
  const name = record.title === "" ? record.id : record.title;
  return `${name} — ${record.status} · ${new Date(record.startedAt).toLocaleString()}`;
}

// --- review ------------------------------------------------------------------

/**
 * The reconstruction, and the consent that produces it.
 *
 * Approval is a separate act from analysis on purpose: the model's account of
 * what happened is a claim, and everything downstream — the plan, the skill,
 * the automation — is built on it. Approving is where a person takes
 * responsibility for that claim being right.
 */
function Review({
  record,
  notice,
  analysis,
  busy,
  onAnalyse,
  onFeedback,
  onEdit,
  onApprove,
  onCancel,
  onReveal,
}: {
  record: RecordingRecord;
  notice: Notice | null;
  analysis: RecordingAnalysis | null;
  busy: boolean;
  onAnalyse: () => void;
  onFeedback: (overall: string, steps: { stepId: string; note: string }[]) => void;
  onEdit: (patch: { title?: string; intent?: string; steps?: AnalysisStep[] }) => void;
  onApprove: (approved: boolean) => void;
  onCancel: () => void;
  onReveal: () => void;
}): JSX.Element {
  const [reviewed, setReviewed] = useState(false);
  const [overall, setOverall] = useState("");
  const [stepNotes, setStepNotes] = useState<Record<string, string>>({});
  const [intent, setIntent] = useState("");
  const lastRevision = useRef<number>(-1);

  // Editing state follows the analysis, but only when a new revision arrives:
  // resetting on every render would discard what the user is part-way through
  // typing each time a progress event lands.
  useEffect(() => {
    if (analysis === null || analysis.revision === lastRevision.current) return;
    lastRevision.current = analysis.revision;
    setIntent(analysis.intent);
    setOverall("");
    setStepNotes({});
  }, [analysis]);

  const consentMissing =
    notice === null
      ? "Loading…"
      : !notice.signedIn
        ? "Sign in with Microsoft before analysing, so the decision to send this is attributable."
        : !reviewed
          ? "Confirm you have looked at what is about to be sent."
          : null;

  return (
    <>
      {analysis === null && (
        <div className="card">
          <h3>Analyse this recording</h3>
          <p className="muted">
            {record.eventCount} events and {record.frameCount} frames were captured
            {record.hasNarration
              ? record.narrationTranscribed
                ? ", with narration transcribed on this device."
                : ", with narration waiting to be transcribed."
              : "."}
          </p>

          <pre className="notice">{notice?.analysis}</pre>

          {/* The folder control sits above the tick, not below it. "I have
              reviewed what is about to be sent" is only an honest thing to ask
              once looking has been made a single click. */}
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={onReveal}>
              <FolderOpen size={14} aria-hidden /> Show me what was captured
            </button>
          </div>

          <label className="row" style={{ gap: 6, marginTop: 10 }}>
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            I have reviewed what was captured and agree to send it for analysis.
          </label>

          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="primary"
              disabled={busy || consentMissing !== null}
              title={consentMissing ?? "Reconstruct what this recording shows"}
              onClick={onAnalyse}
            >
              Analyse
            </button>
            {busy && <button onClick={onCancel}>Cancel</button>}
            {consentMissing !== null && <span className="muted">{consentMissing}</span>}
          </div>
        </div>
      )}

      {analysis !== null && (
        <>
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3>{analysis.title === "" ? "What this recording shows" : analysis.title}</h3>
              <div className="row">
                <span className="pill">revision {analysis.revision}</span>
                <span className={`pill${analysis.intentConfidence === "low" ? " warn" : ""}`}>
                  {analysis.intentConfidence} confidence
                </span>
                {analysis.approved && <span className="pill ok">approved</span>}
              </div>
            </div>

            <label>
              Intent
              <textarea
                rows={3}
                value={intent}
                disabled={busy}
                onChange={(event) => setIntent(event.target.value)}
                onBlur={() => {
                  if (intent.trim() !== "" && intent !== analysis.intent) onEdit({ intent });
                }}
              />
            </label>
            {analysis.intentRationale !== "" && (
              <p className="muted">{analysis.intentRationale}</p>
            )}
          </div>

          {analysis.steps.map((step) => (
            <div className="card" key={step.id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h3>{step.title}</h3>
                <div className="row">
                  <span className={`pill${step.confidence === "low" ? " warn" : ""}`}>
                    {step.confidence}
                  </span>
                  {step.apps.map((app) => (
                    <span className="pill" key={app}>
                      {app}
                    </span>
                  ))}
                  {/* Dropping a step is an edit, not feedback: the model is not
                      asked to try again, the step is simply gone. Like every
                      other edit here, it withdraws approval. The last step
                      cannot go — a reconstruction of nothing builds nothing. */}
                  <button
                    className="danger"
                    disabled={busy || analysis.steps.length <= 1}
                    title={
                      analysis.steps.length <= 1
                        ? "A reconstruction needs at least one step"
                        : "Drop this step from the reconstruction"
                    }
                    onClick={() => {
                      // An edit keeps the revision number, so the effect that
                      // clears notes does not fire. Drop this step's note here
                      // or it is sent as feedback about a step that is gone.
                      setStepNotes((current) => {
                        const next = { ...current };
                        delete next[step.id];
                        return next;
                      });
                      onEdit({ steps: analysis.steps.filter((other) => other.id !== step.id) });
                    }}
                  >
                    <Trash2 size={14} aria-hidden /> Remove
                  </button>
                </div>
              </div>
              {step.detail !== "" && <p>{step.detail}</p>}
              {step.evidence.length > 0 && (
                <details className="trace">
                  <summary className="muted">Evidence</summary>
                  {step.evidence.map((line, index) => (
                    <div className="trace-line mono" key={index}>
                      {line}
                    </div>
                  ))}
                </details>
              )}
              <input
                placeholder="What is wrong with this step?"
                disabled={busy || analysis.approved}
                value={stepNotes[step.id] ?? ""}
                onChange={(event) =>
                  setStepNotes((current) => ({ ...current, [step.id]: event.target.value }))
                }
              />
            </div>
          ))}

          <div className="card">
            <h3>Correct or approve</h3>
            <label>
              Anything else wrong with this reconstruction?
              <textarea
                rows={3}
                disabled={busy || analysis.approved}
                value={overall}
                onChange={(event) => setOverall(event.target.value)}
              />
            </label>
            <div className="row" style={{ marginTop: 12 }}>
              <button
                disabled={
                  busy ||
                  analysis.approved ||
                  (overall.trim() === "" &&
                    Object.values(stepNotes).every((value) => value.trim() === ""))
                }
                onClick={() =>
                  onFeedback(
                    overall.trim(),
                    Object.entries(stepNotes)
                      .filter(([, value]) => value.trim() !== "")
                      .map(([stepId, value]) => ({ stepId, note: value.trim() })),
                  )
                }
              >
                Try again with this feedback
              </button>
              <button
                className="primary"
                disabled={busy || analysis.approved}
                title="Take responsibility for this account being right"
                onClick={() => onApprove(true)}
              >
                <Check size={14} aria-hidden /> Approve
              </button>
              {analysis.approved && (
                <button disabled={busy} onClick={() => onApprove(false)}>
                  Withdraw approval
                </button>
              )}
              {busy && <button onClick={onCancel}>Cancel</button>}
            </div>
          </div>
        </>
      )}
    </>
  );
}

// --- build -------------------------------------------------------------------

/**
 * The plan, then the artifact.
 *
 * Values are shown as editable fields rather than inlined prose because they
 * are the whole generalisation story: a recorded run is full of one account,
 * one folder, one date, and seeing every constant in one editable place is the
 * difference between a skill that repeats a procedure and a skill that repeats
 * an afternoon.
 */
function Build({
  record,
  analysis,
  plan,
  build,
  busy,
  onPlan,
  onReplan,
  onEditPlan,
  onBuild,
  onCancel,
}: {
  record: RecordingRecord;
  analysis: RecordingAnalysis | null;
  plan: RecordingPlan | null;
  build: RecordingBuild | null;
  busy: boolean;
  onPlan: (kind: BuildKind) => void;
  onReplan: (feedback: string) => void;
  onEditPlan: (plan: RecordingPlan) => void;
  onBuild: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [kind, setKind] = useState<BuildKind>("skill");
  const [feedback, setFeedback] = useState("");

  if (analysis === null || !analysis.approved) {
    return (
      <div className="card">
        <h3>Approve the reconstruction first</h3>
        <p className="muted">
          Nothing is built from an account of the recording that nobody has agreed is right.
        </p>
      </div>
    );
  }

  const setValue = (id: string, next: Partial<PlanValue>): void => {
    if (plan === null) return;
    onEditPlan({
      ...plan,
      values: plan.values.map((value) => (value.id === id ? { ...value, ...next } : value)),
    });
  };

  return (
    <>
      <div className="card">
        <h3>Build from “{analysis.title === "" ? record.id : analysis.title}”</h3>
        <label>
          Produce
          <select
            value={kind}
            disabled={busy || plan !== null}
            onChange={(event) => setKind(event.target.value as BuildKind)}
          >
            <option value="skill">A skill — a procedure the agent loads when it is relevant</option>
            <option value="automation">An automation — the same procedure, on a schedule</option>
          </select>
        </label>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" disabled={busy} onClick={() => onPlan(kind)}>
            {plan === null ? "Propose a plan" : "Start again"}
          </button>
          {busy && <button onClick={onCancel}>Cancel</button>}
        </div>
      </div>

      {plan !== null && (
        <>
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3>{plan.title}</h3>
              <div className="row">
                <span className="pill">{plan.kind}</span>
                <span className="pill mono">{plan.name}</span>
              </div>
            </div>
            <p>{plan.description}</p>
            {plan.generalization !== "" && (
              <p className="muted">
                <strong>How this generalises: </strong>
                {plan.generalization}
              </p>
            )}
            {plan.trigger !== null && (
              <div className="notice">
                Runs {describeTrigger(plan.trigger)}. It is created disabled and does not run until
                you enable it under Automations.
              </div>
            )}
          </div>

          {plan.values.length > 0 && (
            <div className="card">
              <h3>Values</h3>
              <p className="muted">
                Everything specific to the run you recorded. The procedure refers to these by name,
                so changing one here changes it everywhere.
              </p>
              {plan.values.map((value) => (
                <label key={value.id}>
                  {value.name} <span className="mono muted">{`{{${value.id}}}`}</span>
                  <input
                    value={value.value}
                    disabled={busy}
                    onChange={(event) => setValue(value.id, { value: event.target.value })}
                  />
                </label>
              ))}
            </div>
          )}

          <div className="card">
            <h3>Steps</h3>
            {plan.steps.map((step, index) => (
              <div className="row" key={index} style={{ alignItems: "baseline", gap: 8 }}>
                <span className={`pill${step.kind === "action" ? " warn" : ""}`}>{step.kind}</span>
                <span>{renderValues(step.text, plan.values)}</span>
                {step.tool !== "" && <span className="pill mono">{step.tool}</span>}
              </div>
            ))}
            {plan.allowedTools.length > 0 && (
              <p className="muted">
                Allowed tools: <span className="mono">{plan.allowedTools.join(", ")}</span>
              </p>
            )}
          </div>

          <div className="card">
            <h3>Refine or build</h3>
            <label>
              What should be different?
              <textarea
                rows={3}
                disabled={busy}
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
              />
            </label>
            <div className="row" style={{ marginTop: 12 }}>
              <button
                disabled={busy || feedback.trim() === ""}
                onClick={() => {
                  onReplan(feedback.trim());
                  setFeedback("");
                }}
              >
                Revise the plan
              </button>
              <button className="primary" disabled={busy} onClick={onBuild}>
                Build it
              </button>
              {busy && <button onClick={onCancel}>Cancel</button>}
            </div>
            <p className="muted" style={{ marginTop: 8 }}>
              {plan.kind === "skill"
                ? "The skill is written as a proposal and does nothing until you approve it under Skills."
                : "The automation is created disabled and does not run until you enable it under Automations."}
            </p>
          </div>
        </>
      )}

      {build !== null && (
        <div className="card approval">
          <h3>Built</h3>
          <p className="muted">
            {build.kind === "skill"
              ? `Skill proposal ${build.skillName ?? build.name} is waiting for review under Skills.`
              : `Automation ${build.jobId ?? build.name} was created disabled under Automations.`}
          </p>
          <pre className="notice">{renderValues(build.body, build.values)}</pre>
        </div>
      )}
    </>
  );
}
