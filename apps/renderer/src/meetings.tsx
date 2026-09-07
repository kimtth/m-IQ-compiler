import { useCallback, useEffect, useState } from "react";
import { Circle, FileAudio, History, Mic, Settings2, Square } from "lucide-react";
import type {
  AudioSource,
  MediaSettings,
  MediaStatus,
  MeetingRecord,
  MeetingTranscript,
  SpeechStatus,
  TranscriptionEngine,
} from "@iq/shared";
import { TRANSCRIPTION_ENGINE_LABELS } from "@iq/shared";
import { call, callAs, subscribe } from "./bridge.js";

/**
 * Meeting Recordings: recording, transcription and notes.
 *
 * Three tabs over one idea — produce a transcript of something that was said.
 * *Record* asks for consent and a microphone. *History* is every transcript
 * this machine has made. *Settings* is where the external tools are pointed at,
 * and it is a tab rather than a dialog because on a fresh machine it is the
 * first thing anyone needs.
 *
 * History is its own tab rather than a list under the record form. The two do
 * different jobs: recording is a short, careful sequence with a consent notice
 * to read, and reading an old transcript is browsing. Stacking them meant every
 * past meeting sat below the notice, so the more the app was used the further
 * the record button drifted from the transcripts, and neither was easy to find.
 *
 * Screen recording used to be a third tab and was removed. It was a second
 * capture pipeline with its own consent question, its own settings and its own
 * failure mode, producing a file whose only use here was to be transcribed —
 * which "Transcribe a file…" already does for a recording made by whatever
 * screen recorder the user already has.
 *
 * **The record control is always on screen.** It sits at the top of the tab in
 * a fixed place, idle or not, and states why it is unavailable rather than
 * disappearing. This is the correction of a real defect: the whole setup card,
 * record button included, used to be replaced by a one-line explanation
 * whenever the chosen engine was not ready or nobody was signed in — which is
 * the state of every fresh install, so the app shipped with no way to start a
 * recording and no way to tell that one was possible. The reference
 * (meetly-lite) keeps a single record button permanently visible for the same
 * reason, and stops on the same button it starts with.
 *
 * Two rules from the privileged side are load-bearing here and neither is
 * enforced in this file — they are *reflected* in it, which is the point:
 *
 *  - The consent notice text, its version, and whether the chosen engine can
 *    run at all come from main. Switching engine re-fetches the notice, because
 *    "audio is uploaded to Azure" and "audio stays on this device" are
 *    different disclosures and showing the wrong one would make the
 *    acknowledgement meaningless.
 *  - Nothing here decides where audio goes. The engine is sent with the start
 *    request and stored on the meeting, so the record answers the question
 *    rather than this component's state at the time.
 *  - **No audio passes through this component.** Capture is the `iq-audio`
 *    sidecar's, started and stopped by main; this file only asks. It used to
 *    hold a `MediaRecorder` and post chunks over IPC, which could not record
 *    the other participants on Windows at all.
 *
 * While a capture is running the indicator is unconditional and cannot be
 * dismissed. Someone walking past the screen should be able to tell that the
 * room is being recorded.
 */

interface Notice {
  version: string;
  engine: TranscriptionEngine;
  text: string;
  speech: SpeechStatus;
  whisper: { ready: boolean; message: string };
  /** Whether the other participants can be captured at all on this machine. */
  systemAudio: { ready: boolean; message: string };
  signedIn: boolean;
  blocked: string;
}

type Tab = "record" | "history" | "settings";

/**
 * Where the recorder is.
 *
 * `starting` and `saving` exist as states rather than as a boolean `busy`
 * because they are the two moments when the button must not be pressed and the
 * user is owed a different word: "Starting" is waiting for a microphone,
 * "Saving" is waiting for a transcript.
 */
type RecorderState = "idle" | "starting" | "recording" | "saving";

const RECORDER_LABELS: Record<RecorderState, string> = {
  idle: "Ready",
  starting: "Starting",
  recording: "Recording",
  saving: "Saving",
};

export function Meetings({ onError }: { onError: (problem: unknown) => void }): JSX.Element {
  const [tab, setTab] = useState<Tab>("record");
  const [meetings, setMeetings] = useState<MeetingRecord[]>([]);
  /**
   * A meeting to open in History, set when one finishes transcribing.
   *
   * A transcript that lands in a tab the user is not looking at reads as
   * nothing having happened, so finishing a recording moves them to it. The
   * value carries the meeting id rather than a bare flag so History knows which
   * row to expand.
   */
  const [openId, setOpenId] = useState<string | null>(null);

  const loadMeetings = useCallback(async () => {
    try {
      setMeetings(await call("meetings:list"));
    } catch (problem) {
      onError(problem);
    }
  }, [onError]);

  useEffect(() => {
    void loadMeetings();
    return subscribe<MeetingRecord>("meetings:changed", (meeting) => {
      setMeetings((current) => {
        const without = current.filter((entry) => entry.id !== meeting.id);
        return meeting.status === "discarded"
          ? without
          : [meeting, ...without].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      });
    });
  }, [loadMeetings]);

  const showTranscript = (meetingId: string): void => {
    setOpenId(meetingId);
    setTab("history");
  };

  return (
    <>
      <div className="pane-header">
        <strong>Meeting Recordings</strong>
        <div className="row" style={{ gap: 4, marginLeft: 12 }}>
          <TabButton current={tab} value="record" onChange={setTab} icon={<FileAudio size={14} aria-hidden />}>
            Record
          </TabButton>
          <TabButton current={tab} value="history" onChange={setTab} icon={<History size={14} aria-hidden />}>
            History{meetings.length > 0 ? ` (${meetings.length})` : ""}
          </TabButton>
          <TabButton current={tab} value="settings" onChange={setTab} icon={<Settings2 size={14} aria-hidden />}>
            Settings
          </TabButton>
        </div>
      </div>

      {tab === "record" && (
        <RecordTab onReload={loadMeetings} onError={onError} onTranscribed={showTranscript} />
      )}
      {tab === "history" && (
        <HistoryTab
          meetings={meetings}
          openId={openId}
          onReload={loadMeetings}
          onError={onError}
        />
      )}
      {tab === "settings" && <SettingsTab onError={onError} />}
    </>
  );
}

function TabButton({
  current,
  value,
  onChange,
  icon,
  children,
}: {
  current: Tab;
  value: Tab;
  onChange: (tab: Tab) => void;
  icon: JSX.Element;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      className={current === value ? "primary" : "ghost"}
      aria-pressed={current === value}
      onClick={() => onChange(value)}
    >
      {icon} {children}
    </button>
  );
}

// --- record ------------------------------------------------------------------

function RecordTab({
  onReload,
  onError,
  onTranscribed,
}: {
  onReload: () => Promise<void>;
  onError: (problem: unknown) => void;
  /** A transcript exists. Show it, wherever transcripts are shown. */
  onTranscribed: (meetingId: string) => void;
}): JSX.Element {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [engine, setEngine] = useState<TranscriptionEngine | null>(null);
  const [busy, setBusy] = useState(false);

  const [title, setTitle] = useState("");
  const [sources, setSources] = useState<AudioSource[]>(["microphone", "system"]);
  // The notice acknowledgement and audio retention both start on, and the
  // acknowledgement is not reset between meetings: it is a standing statement
  // about how this machine is used, not a per-meeting question. The title is
  // still cleared after each start, because that names one meeting.
  const [acknowledged, setAcknowledged] = useState(true);
  const [retainAudio, setRetainAudio] = useState(true);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [recorder, setRecorder] = useState<RecorderState>("idle");
  const [elapsed, setElapsed] = useState(0);

  /**
   * Why the other participants cannot be recorded on this machine, or null.
   *
   * The `iq-audio` sidecar does the recording, so without it nothing can be
   * captured at all and `notice.blocked` says so too. This narrower reason
   * still exists because the source tick needs one of its own, and because —
   * the notice arriving after the first render — `system` is also filtered out
   * of what is sent, so a tick made while it was loading cannot start a
   * capture that would record silence.
   */
  const systemBlocked =
    notice !== null && !notice.systemAudio.ready ? notice.systemAudio.message : null;
  const effectiveSources =
    systemBlocked === null ? sources : sources.filter((source) => source !== "system");

  /**
   * Re-fetch the notice whenever the engine changes.
   *
   * The text, and therefore what the checkbox below it means, differs per
   * engine. Caching both and swapping client-side would work right up to the
   * day one of them changes.
   */
  useEffect(() => {
    void (async () => {
      try {
        const fetched = await callAs<Notice>("meetings:notice", engine ? { engine } : {});
        setNotice(fetched);
        // The first load also settles which engine the picker starts on.
        if (engine === null) setEngine(fetched.engine);
      } catch (problem) {
        onError(problem);
      }
    })();
  }, [engine, onError]);

  useEffect(() => {
    if (!activeId) return;
    const timer = setInterval(() => setElapsed((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [activeId]);

  const begin = async (): Promise<void> => {
    if (!notice || !acknowledged || title.trim().length === 0) return;
    setBusy(true);
    setRecorder("starting");
    try {
      // `meetings:start` does not resolve until the sidecar has confirmed it is
      // recording, so reaching the next line means audio is being written.
      const meeting = await call("meetings:start", {
        title: title.trim(),
        sources: effectiveSources,
        noticeVersion: notice.version,
        participantsInformed: true,
        engine: notice.engine,
        retainAudio,
      });

      setActiveId(meeting.id);
      setRecorder("recording");
      setElapsed(0);
      setTitle("");
    } catch (problem) {
      setActiveId(null);
      setRecorder("idle");
      onError(problem);
    } finally {
      setBusy(false);
      await onReload();
    }
  };

  const end = async (): Promise<void> => {
    const meetingId = activeId;
    if (!meetingId) return;
    setBusy(true);
    setRecorder("saving");
    try {
      setActiveId(null);
      const meeting = await call("meetings:stop", { meetingId });
      if (meeting.status === "transcribed") onTranscribed(meetingId);
    } catch (problem) {
      onError(problem);
    } finally {
      setRecorder("idle");
      setBusy(false);
      await onReload();
    }
  };

  /** Transcribe a file the user already has. The picker is opened by main. */
  const importFile = async (): Promise<void> => {
    if (!notice || !acknowledged) return;
    setBusy(true);
    try {
      const chosen = await call("media:pickFile", { kind: "media" });
      if (chosen.path === null) return;
      const meeting = await call("meetings:importFile", {
        path: chosen.path,
        noticeVersion: notice.version,
        participantsInformed: true,
        engine: notice.engine,
      });
      if (meeting.status === "transcribed") onTranscribed(meeting.id);
    } catch (problem) {
      onError(problem);
    } finally {
      setBusy(false);
      await onReload();
    }
  };

  /**
   * Why a recording cannot start, or null.
   *
   * This is shown *beside* the controls, never instead of them. It used to
   * replace the whole card, which is how the record button came to be missing
   * on every machine that had not yet registered a Speech resource.
   */
  const blocked = !notice
    ? "Loading…"
    : !notice.signedIn
      ? "Sign in with Microsoft before recording, so the consent is attributable to you."
      : notice.blocked !== ""
        ? notice.blocked
        : null;

  const missing =
    blocked !== null
      ? blocked
      : effectiveSources.length === 0
        ? "Choose at least one audio source."
        : title.trim().length === 0
          ? "Name the meeting before recording."
          : !acknowledged
            ? "Acknowledge the recording notice first."
            : null;

  const canStart = recorder === "idle" && !busy && missing === null;

  const toggle = (): void => {
    if (recorder === "recording") void end();
    else if (canStart) void begin();
  };

  return (
    <div className="pane-body">
      {/*
        The recorder, always in the same place.

        One button starts and stops, as in the reference: two controls that each
        do half the job means the stop control has to appear from somewhere, and
        the place it appears is the place the eye is not looking. It is disabled
        rather than hidden when a recording cannot start, and the reason is
        attached to it.
      */}
      <div className={`recorder-bar ${recorder}`}>
        <span className="state-dot" aria-hidden="true" />
        <div className="recorder-state">
          <strong>{RECORDER_LABELS[recorder]}</strong>
          <span className="mono">{formatClock(elapsed)}</span>
        </div>
        <div className="spacer" />
        {recorder === "recording" && (
          <span className="pill recording">
            <Circle className="lucide" size={10} fill="currentColor" aria-hidden="true" />
            On air
          </span>
        )}
        <button
          className={recorder === "recording" ? "recorder-toggle stop" : "recorder-toggle"}
          disabled={recorder === "starting" || recorder === "saving" || (recorder === "idle" && !canStart)}
          title={
            recorder === "recording"
              ? "Stop recording and transcribe"
              : (missing ?? "Start recording")
          }
          aria-label={recorder === "recording" ? "Stop recording" : "Start recording"}
          onClick={toggle}
        >
          {recorder === "recording" || recorder === "saving" ? (
            <Square size={18} aria-hidden />
          ) : (
            <Mic size={18} aria-hidden />
          )}
        </button>
      </div>

      {recorder !== "idle" && (
        <div className="card approval">
          <h3>Recording in progress · {formatClock(elapsed)}</h3>
          <p className="muted">
            Audio is being captured from this device and will be transcribed by{" "}
            {TRANSCRIPTION_ENGINE_LABELS[notice?.engine ?? "azure"]}. Everyone present should
            already know.
          </p>
        </div>
      )}

      <div className="card">
        <h3>Record or transcribe a meeting</h3>

        {/* The engine sits above the notice because it decides what the notice
            says. Both options are always listed: one that is merely
            unavailable is explained, never hidden, or the user cannot tell
            "not offered" from "not set up". */}
        <label className="stacked-field">
          <span className="caption">Transcribed by</span>
          <select
            disabled={recorder !== "idle"}
            value={notice?.engine ?? "azure"}
            onChange={(event) => setEngine(event.target.value as TranscriptionEngine)}
          >
            <option value="azure">
              {TRANSCRIPTION_ENGINE_LABELS.azure} — audio is uploaded to your tenant
            </option>
            <option value="whisper">
              {TRANSCRIPTION_ENGINE_LABELS.whisper} — audio stays on this device
            </option>
          </select>
        </label>

        {blocked !== null && <div className="notice">{blocked}</div>}

        <div className="grid">
          <input
            placeholder="What is this meeting?"
            disabled={recorder !== "idle"}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>

        <div className="row" style={{ marginTop: 10, gap: 16 }}>
          {((["microphone", "system"] as AudioSource[]).map((source) => {
            // Both sources come from the native sidecar; Chromium's
            // `getDisplayMedia` audio is tab-scoped and could never have
            // supplied the second one. Disabled with the reason attached,
            // never hidden — the remedy is one command and the user cannot run
            // it unprompted.
            const unavailable = source === "system" ? systemBlocked : null;
            return (
              <label key={source} className="row" style={{ gap: 6 }} title={unavailable ?? undefined}>
                <input
                  type="checkbox"
                  disabled={recorder !== "idle" || unavailable !== null}
                  checked={effectiveSources.includes(source)}
                  onChange={(event) =>
                    setSources((current) =>
                      event.target.checked
                        ? [...new Set([...current, source])]
                        : current.filter((entry) => entry !== source),
                    )
                  }
                />
                {source === "microphone" ? "This microphone" : "System audio (other participants)"}
              </label>
            );
          }))}
        </div>

        {systemBlocked !== null && <div className="notice">{systemBlocked}</div>}

        {/* Said plainly rather than left to be discovered in a transcript.
            Native capture takes the raw device streams and sums them: there is
            no echo canceller in the path any more, because Chromium's lived in
            the renderer's `getUserMedia` and the renderer no longer records.
            So with speakers, the remote voices arrive twice — once clean from
            the system, once delayed and coloured through the microphone — and
            doubled, phase-smeared speech transcribes worse than a plain
            microphone recording. Headphones remove the second path entirely,
            which is why the remedy is named rather than the defect. */}
        {effectiveSources.includes("microphone") && effectiveSources.includes("system") && (
          <div className="notice">
            Recording both sources at once has no echo cancellation. On speakers the other
            participants are picked up twice — from the system and again through the microphone —
            which sounds like an echo and reads worse in the transcript. Use headphones, or record
            one source.
          </div>
        )}

        <pre className="notice">{notice?.text}</pre>

        <label className="row" style={{ gap: 6, marginTop: 10 }}>
          <input
            type="checkbox"
            disabled={recorder !== "idle"}
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          I have read this notice and every participant has been told the meeting is being
          recorded.
        </label>

        <label className="row" style={{ gap: 6, marginTop: 6 }}>
          <input
            type="checkbox"
            disabled={recorder !== "idle"}
            checked={retainAudio}
            onChange={(event) => setRetainAudio(event.target.checked)}
          />
          Keep the audio file after transcription
        </label>

        <div className="row" style={{ marginTop: 12 }}>
          <button
            disabled={recorder !== "idle" || busy || !acknowledged || blocked !== null}
            title="Transcribe a WAV, MP3, M4A or MP4 file you already have"
            onClick={() => void importFile()}
          >
            Transcribe a file…
          </button>
          <span className="muted">Notice version {notice?.version}</span>
        </div>
      </div>
    </div>
  );
}

// --- history -----------------------------------------------------------------

/**
 * Every transcript this machine has made.
 *
 * The records are read from disk, not held from the session that made them: the
 * index is `meetings/meetings.json` and each transcript is `transcript.jsonl`
 * in its own directory, so closing the app and coming back a week later shows
 * the same list. A meeting that is still transcribing appears here too, with
 * its status, because "where did my recording go" is asked most often in the
 * minute after it stops.
 *
 * One meeting is expanded at a time. The transcript and the notes are fetched
 * on open rather than with the list — a list of thirty meetings is a few
 * kilobytes and thirty transcripts is not, and only one is ever on screen.
 */
function HistoryTab({
  meetings,
  openId,
  onReload,
  onError,
}: {
  meetings: MeetingRecord[];
  /** A meeting to expand on arrival, set by the tab that just produced it. */
  openId: string | null;
  onReload: () => Promise<void>;
  onError: (problem: unknown) => void;
}): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<MeetingTranscript | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const openMeeting = useCallback(
    async (meetingId: string) => {
      setSelected(meetingId);
      setTranscript(null);
      setNotes(null);
      try {
        setTranscript(await call("meetings:transcript", { meetingId }));
        const result = await call("meetings:notes", { meetingId });
        setNotes(result.body);
      } catch (problem) {
        onError(problem);
      }
    },
    [onError],
  );

  useEffect(() => {
    if (openId !== null) void openMeeting(openId);
  }, [openId, openMeeting]);

  const act = async (channel: string, meetingId: string): Promise<void> => {
    setBusy(true);
    try {
      await call(channel as "meetings:generateNotes", { meetingId });
      if (selected === meetingId) await openMeeting(meetingId);
      await onReload();
    } catch (problem) {
      onError(problem);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Delete a recording.
   *
   * Not routed through `act`, which reopens the meeting it just acted on. That
   * is right for notes and for discarding audio and wrong here: the meeting is
   * gone, so reopening it asks for a transcript that no longer exists and the
   * delete is reported as a failure it was not. The selection is cleared
   * instead, because it points at a row that is about to leave the list.
   */
  const remove = async (meetingId: string): Promise<void> => {
    setBusy(true);
    try {
      await call("meetings:delete", { meetingId });
      if (selected === meetingId) {
        setSelected(null);
        setTranscript(null);
        setNotes(null);
      }
    } catch (problem) {
      onError(problem);
    } finally {
      setBusy(false);
      await onReload();
    }
  };

  if (meetings.length === 0) {
    return (
      <div className="pane-body">
        <div className="empty-state">
          <History size={20} aria-hidden="true" />
          <h2>No transcripts yet</h2>
          <p className="muted">
            Record a meeting, or transcribe a file you already have, and it will be kept here with
            its transcript and its notes.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="pane-body">
      {meetings.map((meeting) => (
        <div className="card" key={meeting.id}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3>{meeting.title}</h3>
            <div className="row">
              <span
                className={`pill${meeting.status === "ready" ? " ok" : meeting.status === "failed" ? " bad" : ""}`}
              >
                {meeting.status}
              </span>
              <span className="pill">{TRANSCRIPTION_ENGINE_LABELS[meeting.engine]}</span>
              {meeting.origin === "import" && <span className="pill">imported</span>}
              {meeting.audioRetained && <span className="pill warn">audio kept</span>}
              <button
                onClick={() => (selected === meeting.id ? setSelected(null) : void openMeeting(meeting.id))}
              >
                {selected === meeting.id ? "Close" : "Open"}
              </button>
              {(meeting.status === "transcribed" || meeting.status === "ready") && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void act("meetings:generateNotes", meeting.id)}
                >
                  {meeting.status === "ready" ? "Rewrite notes" : "Write notes"}
                </button>
              )}
              {meeting.audioRetained && (
                <button disabled={busy} onClick={() => void act("meetings:discardAudio", meeting.id)}>
                  Delete audio
                </button>
              )}
              <button
                className="danger"
                disabled={busy}
                onClick={() => void remove(meeting.id)}
              >
                Delete
              </button>
            </div>
          </div>

          <div className="muted">
            {new Date(meeting.startedAt).toLocaleString()} ·{" "}
            {Math.max(1, Math.round(meeting.durationMs / 60_000))} min · {meeting.segmentCount}{" "}
            transcript segments · consented by {meeting.consent.acknowledgedByUsername} (notice{" "}
            {meeting.consent.noticeVersion})
          </div>
          {meeting.origin === "import" && meeting.sourceFile !== "" && (
            <div className="muted mono">{meeting.sourceFile}</div>
          )}
          {meeting.error && <div className="muted">{meeting.error}</div>}

          {selected === meeting.id && (
            <div style={{ marginTop: 12 }}>
              {notes && (
                <>
                  <h3>Notes</h3>
                  <pre className="notice">{notes}</pre>
                </>
              )}
              <h3>Transcript</h3>
              {transcript && transcript.segments.length > 0 ? (
                <div className="transcript">
                  {transcript.segments.map((segment) => (
                    <div key={segment.index}>
                      <span className="muted">
                        {formatClock(Math.floor(segment.startMs / 1000))}{" "}
                        {segment.speaker ?? "Unknown"}
                      </span>{" "}
                      {segment.text}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">No transcript yet.</p>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// --- settings ----------------------------------------------------------------

type ToolKey = "ffmpeg" | "ffprobe" | "whisper" | "whisperModel" | "iqAudio";
type PathKey = "ffmpegPath" | "ffprobePath" | "whisperPath" | "whisperModelPath" | "iqAudioPath";

function SettingsTab({ onError }: { onError: (problem: unknown) => void }): JSX.Element {
  const [settings, setSettings] = useState<MediaSettings | null>(null);
  const [status, setStatus] = useState<MediaStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSettings(await call("media:settings"));
      setStatus(await call("media:status"));
    } catch (problem) {
      onError(problem);
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (next: MediaSettings): Promise<void> => {
    setBusy(true);
    try {
      setSettings(await call("media:saveSettings", next));
      setStatus(await call("media:status"));
    } catch (problem) {
      onError(problem);
    } finally {
      setBusy(false);
    }
  };

  const browse = async (key: PathKey): Promise<void> => {
    if (!settings) return;
    const kind = key === "whisperModelPath" ? "whisperModel" : "executable";
    const chosen = await call("media:pickFile", { kind }).catch(() => null);
    if (chosen?.path) await save({ ...settings, [key]: chosen.path });
  };

  if (settings === null) {
    return (
      <div className="pane-body">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const pathField = (label: string, key: PathKey, tool: ToolKey): JSX.Element => {
    const resolved = status?.[tool] ?? null;
    return (
      <div className="field-row" key={key}>
        <span>{label}</span>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input
            className="mono"
            style={{ minWidth: 320 }}
            placeholder="Resolved automatically"
            value={settings[key]}
            onChange={(event) => setSettings({ ...settings, [key]: event.target.value })}
            onBlur={() => void save(settings)}
          />
          <button disabled={busy} onClick={() => void browse(key)}>
            Browse…
          </button>
          {resolved && (
            <span className={`pill${resolved.available ? " ok" : " bad"}`}>
              {resolved.available ? resolved.version || "found" : "not found"}
            </span>
          )}
        </div>
        {resolved && resolved.message !== "" && <div className="muted">{resolved.message}</div>}
      </div>
    );
  };

  return (
    <div className="pane-body">
      <div className="card">
        <h3>External tools</h3>
        <p className="muted">
          FFmpeg and whisper.cpp are separate programs with their own licences, so the app drives a
          copy on this machine rather than shipping one. Run{" "}
          <span className="mono">pnpm prepare:ffmpeg</span> to download FFmpeg, or point these
          fields at builds you already have. The capture sidecar is ours but is compiled rather
          than shipped, so a Rust toolchain is never needed to run the app — build it with{" "}
          <span className="mono">pnpm prepare:audio</span>. Leave a field empty to let the app
          resolve it.
        </p>
        {pathField("FFmpeg", "ffmpegPath", "ffmpeg")}
        {pathField("ffprobe", "ffprobePath", "ffprobe")}
        {pathField("whisper.cpp (whisper-cli)", "whisperPath", "whisper")}
        {pathField("Whisper model (ggml-*.bin)", "whisperModelPath", "whisperModel")}
        {pathField("Audio capture (iq-audio)", "iqAudioPath", "iqAudio")}
      </div>

      <div className="card">
        <h3>Transcription</h3>
        <label>
          Default engine
          <select
            value={settings.defaultEngine}
            onChange={(event) =>
              void save({ ...settings, defaultEngine: event.target.value as TranscriptionEngine })
            }
          >
            <option value="azure">{TRANSCRIPTION_ENGINE_LABELS.azure} — audio is uploaded</option>
            <option value="whisper">
              {TRANSCRIPTION_ENGINE_LABELS.whisper} — audio stays on this device
            </option>
          </select>
        </label>
        <p className="muted">
          This is only the starting choice. Every recording stores the engine that produced it, so a
          later change here never rewrites what happened to audio already captured.
        </p>
      </div>
    </div>
  );
}

// --- formatting --------------------------------------------------------------

function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  return `${String(minutes).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}
