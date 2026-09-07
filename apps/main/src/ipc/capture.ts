import { dialog, shell } from "electron";
import { resolveMediaTools } from "@iq/core";
import { ok, type IpcContext, type IpcHandlersFor } from "./context.js";

/** The built-in browser pane. */
export function browserHandlers({ browser }: IpcContext): IpcHandlersFor<"browser"> {
  return {
    "browser:state": async () => browser().state(),
    "browser:restore": async (input) => browser().restore(input.sessionId),
    // Attributed to the user: this channel is only reachable from the window.
    "browser:navigate": async (input) => browser().navigate(input.url, "user"),
    "browser:back": async () => browser().goBack(),
    "browser:forward": async () => browser().goForward(),
    "browser:reload": async () => browser().reload(),
    "browser:stop": async () => browser().stopLoading(),
    "browser:close": async () => browser().close(),
    "browser:input": async (input) => ok(browser().sendInput(input)),
    "browser:setBounds": async (input) => browser().setBounds(input),
  };
}

/** Speech in and out. */
export function speechHandlers({ app }: IpcContext): IpcHandlersFor<"speech"> {
  return {
    "speech:status": async () => app.speech.status(),
    "speech:test": async () => app.speech.test(app.correlationId()),
    "speech:register": async (input) => {
      await app.speechRegistry.register(input);
      return app.speech.status();
    },
    "speech:remove": async () => {
      await app.speechRegistry.remove();
      return app.speech.status();
    },
    "speech:transcribe": async (input) => {
      const result = await app.speech.transcribe({
        audio: decodeAudio(input.audioBase64),
        mimeType: input.mimeType,
        // Push-to-talk is one speaker by definition, so diarization is off:
        // it costs latency and would label a single voice.
        diarize: false,
        correlationId: app.correlationId(),
        ...(input.locale ? { locale: input.locale } : {}),
      });
      return { text: result.text, locale: result.locale, durationMs: result.durationMs };
    },
    "speech:synthesize": async (input) =>
      app.speech.synthesize({
        text: input.text,
        correlationId: app.correlationId(),
        ...(input.voice ? { voice: input.voice } : {}),
      }),
  };
}

/** Meetings, and the local media tooling they depend on. */
export function meetingsHandlers({
  app,
}: IpcContext): IpcHandlersFor<"meetings"> & IpcHandlersFor<"media"> {
  return {
    "meetings:notice": async (input) => app.meetings.notice(input.engine),
    "meetings:list": async () => app.meetings.list(),
    "meetings:get": async (input) => app.meetings.get(input.meetingId),
    "meetings:start": async (input) =>
      app.meetings.start({
        title: input.title,
        sources: input.sources,
        noticeVersion: input.noticeVersion,
        participantsInformed: input.participantsInformed,
        retainAudio: input.retainAudio,
        ...(input.engine ? { engine: input.engine } : {}),
        ...(input.calendarEventId ? { calendarEventId: input.calendarEventId } : {}),
      }),
    "meetings:importFile": async (input) =>
      app.meetings.importFile({
        path: input.path,
        noticeVersion: input.noticeVersion,
        participantsInformed: input.participantsInformed,
        ...(input.title ? { title: input.title } : {}),
        ...(input.engine ? { engine: input.engine } : {}),
        ...(input.locale ? { locale: input.locale } : {}),
        ...(input.recordingId ? { recordingId: input.recordingId } : {}),
      }),
    "meetings:stop": async (input) => app.meetings.stop(input.meetingId),
    "meetings:transcript": async (input) => app.meetings.transcript(input.meetingId),
    "meetings:notes": async (input) => ({ body: await app.meetings.notes(input.meetingId) }),
    "meetings:generateNotes": async (input) => app.meetings.generateNotes(input.meetingId),
    "meetings:discardAudio": async (input) => app.meetings.discardAudio(input.meetingId),
    "meetings:delete": async (input) => ok(app.meetings.delete(input.meetingId)),

    "media:status": async () => {
      const tools = await resolveMediaTools(app.mediaSettings.current(), app.paths);
      return {
        ffmpeg: tools.ffmpeg.status,
        ffprobe: tools.ffprobe.status,
        whisper: tools.whisper.status,
        whisperModel: tools.whisperModel,
        iqAudio: tools.iqAudio.status,
      };
    },
    "media:settings": async () => app.mediaSettings.current(),
    "media:saveSettings": async (input) => app.mediaSettings.save(input),
    /**
     * File pickers.
     *
     * The dialog is opened by the privileged side and only the chosen path
     * comes back. The renderer never gets a handle, never gets to name a
     * starting directory, and cannot open a picker the user did not click.
     */
    "media:pickFile": async (input) => {
      const filters =
        input.kind === "whisperModel"
          ? [{ name: "Whisper model", extensions: ["bin"] }]
          : input.kind === "media"
            ? [{ name: "Audio or video", extensions: ["wav", "mp3", "m4a", "mp4"] }]
            : process.platform === "win32"
              ? [{ name: "Executable", extensions: ["exe"] }]
              : [{ name: "All files", extensions: ["*"] }];
      const chosen = await dialog.showOpenDialog({ properties: ["openFile"], filters });
      return { path: chosen.canceled ? null : (chosen.filePaths[0] ?? null) };
    },
    "media:pickDirectory": async () => {
      const chosen = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
      });
      return { path: chosen.canceled ? null : (chosen.filePaths[0] ?? null) };
    },
  };
}

/** Skill recording: capture, analysis, then build. */
export function recordingHandlers({ app }: IpcContext): IpcHandlersFor<"recording"> {
  return {
    // Reads first. `notice` is served from core so that bumping the notice
    // version invalidates every acknowledgement at once, rather than leaving a
    // copy of the wording in the renderer to drift out of date.
    "recording:status": async () => app.recordings.status(),
    "recording:list": async () => app.recordings.list(),
    "recording:get": async (input) => app.recordings.get(input.recordingId),
    "recording:notice": async () => app.recordings.notice(),

    // Capture. The payload never names a path: the session directory is chosen
    // on this side, so a renderer cannot aim a screen recording at a location
    // of its choosing.
    "recording:start": async (input) => app.recordings.start(input),
    "recording:stop": async () => app.recordings.stop(),
    "recording:discard": async () => ok(app.recordings.discard()),
    "recording:marker": async (input) => ({ ok: app.recordings.marker(input.note) }),
    "recording:rename": async (input) => app.recordings.rename(input.recordingId, input.title),
    "recording:delete": async (input) => ok(app.recordings.delete(input.recordingId)),
    "recording:reveal": async (input) =>
      // The directory, not a file: the point is to let someone inspect
      // everything that was captured before deciding to send any of it.
      ok(shell.openPath(app.recordings.directory(input.recordingId))),

    // Analysis — the egress. The consent payload carries the acknowledgement
    // only; core stamps the identity from the signed-in account, because a
    // renderer able to name who authorised an upload could name anyone.
    "recording:analyse": async (input) => app.recordings.analyse(input),
    "recording:analysis": async (input) => app.recordings.analysis(input.recordingId),
    "recording:reanalyse": async (input) =>
      app.recordings.reanalyse(input.recordingId, input.feedback),
    "recording:editAnalysis": async (input) => app.recordings.editAnalysis(input),
    "recording:approveAnalysis": async (input) =>
      app.recordings.approveAnalysis(input.recordingId, input.approved),
    "recording:cancelAnalysis": async (input) => ({ ok: app.recordings.cancel(input.recordingId) }),

    // Build. Nothing here goes live: a skill lands as a proposal and an
    // automation lands disabled, each approved on its own surface.
    "recording:plan": async (input) => app.recordings.plan(input),
    "recording:replan": async (input) => app.recordings.replan(input.recordingId, input.feedback),
    "recording:editPlan": async (input) => app.recordings.editPlan(input.recordingId, input.plan),
    "recording:build": async (input) =>
      app.recordings.buildFrom({ recordingId: input.recordingId }),
    "recording:getBuild": async (input) => app.recordings.build(input.recordingId),
    "recording:cancelBuild": async (input) => ({ ok: app.recordings.cancel(input.recordingId) }),
  };
}

/**
 * Decode a base64 audio payload from the renderer.
 *
 * `Buffer.from(..., "base64")` silently ignores characters outside the
 * alphabet, so a malformed payload would otherwise become a short buffer that
 * gets uploaded to Azure as if it were audio. The round-trip check rejects it
 * here instead.
 */
function decodeAudio(base64: string): Uint8Array {
  const decoded = Buffer.from(base64, "base64");
  if (decoded.length === 0) throw new Error("audio payload was empty");
  if (decoded.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")) {
    throw new Error("audio payload was not valid base64");
  }
  return new Uint8Array(decoded);
}
