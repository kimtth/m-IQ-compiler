import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioMimeType } from "@iq/shared";
import { call } from "./bridge.js";

/**
 * Microphone capture in the renderer, for push-to-talk and spoken replies.
 *
 * Meeting recording is **not** here. It used to be — the renderer is the only
 * process that can hold a MediaStream — but Chromium cannot capture system
 * output on Windows, so the other participants were never in the file. That
 * capture is now the `iq-audio` sidecar's, driven from the privileged side,
 * and no meeting audio passes through this process at all.
 *
 * What remains is a dictation clip: held in memory for as long as the user
 * holds the key, sent once, and never written to disk here. No key or token is
 * reachable from this file.
 */

/** The container Chromium actually produced, narrowed to what we accept. */
function normalizeMimeType(raw: string): AudioMimeType {
  const base = raw.split(";")[0]?.trim().toLowerCase();
  if (raw.toLowerCase().includes("opus")) {
    return base === "audio/ogg" ? "audio/ogg;codecs=opus" : "audio/webm;codecs=opus";
  }
  if (base === "audio/ogg") return "audio/ogg";
  if (base === "audio/wav") return "audio/wav";
  if (base === "audio/mpeg") return "audio/mpeg";
  return "audio/webm";
}

const PREFERRED_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return PREFERRED_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // Chunked so a long recording cannot blow the argument limit of `apply`.
  const step = 0x8000;
  for (let offset = 0; offset < buffer.length; offset += step) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + step));
  }
  return btoa(binary);
}

/**
 * Push-to-talk.
 *
 * The clip is held in memory until the user releases, then sent once. Nothing
 * is streamed while they are still speaking, so a press that is cancelled
 * leaves no trace anywhere.
 */
export function usePushToTalk(deps: {
  onTranscript: (text: string) => void;
  onError: (error: unknown) => void;
}): {
  recording: boolean;
  transcribing: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => void;
} {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const cancelled = useRef(false);

  const release = useCallback(() => {
    recorder.current = null;
    chunks.current = [];
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
    setRecording(false);
  }, []);

  useEffect(() => release, [release]);

  const start = useCallback(async () => {
    if (recorder.current) return;
    cancelled.current = false;
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      stream.current = media;
      const preferred = pickMimeType();
      const created = new MediaRecorder(media, preferred ? { mimeType: preferred } : {});
      chunks.current = [];
      created.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data);
      };
      recorder.current = created;
      created.start();
      setRecording(true);
    } catch (error) {
      release();
      deps.onError(error);
    }
  }, [deps, release]);

  const stop = useCallback(async () => {
    const active = recorder.current;
    if (!active) return;

    const mimeType = normalizeMimeType(active.mimeType || "audio/webm");
    const blob = await new Promise<Blob>((resolve) => {
      active.onstop = () => resolve(new Blob(chunks.current, { type: mimeType }));
      if (active.state !== "inactive") active.stop();
      else resolve(new Blob(chunks.current, { type: mimeType }));
    });
    release();

    if (cancelled.current || blob.size < 1_024) return;

    setTranscribing(true);
    try {
      const result = await call("speech:transcribe", {
        audioBase64: await blobToBase64(blob),
        mimeType,
      });
      if (result.text.trim().length > 0) deps.onTranscript(result.text.trim());
    } catch (error) {
      deps.onError(error);
    } finally {
      setTranscribing(false);
    }
  }, [deps, release]);

  const cancel = useCallback(() => {
    cancelled.current = true;
    if (recorder.current?.state !== "inactive") recorder.current?.stop();
    release();
  }, [release]);

  return { recording, transcribing, start, stop, cancel };
}

/**
 * Spoken replies.
 *
 * One player at a time: a second request stops the first rather than talking
 * over it. The object URL is revoked when playback ends so audio does not
 * accumulate in the page for the lifetime of the window.
 */
export function useSpeaker(onError: (error: unknown) => void): {
  speakingId: string | null;
  speak: (id: string, text: string) => Promise<void>;
  stop: () => void;
} {
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);

  const stop = useCallback(() => {
    player.current?.pause();
    player.current = null;
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
    setSpeakingId(null);
  }, []);

  useEffect(() => stop, [stop]);

  const speak = useCallback(
    async (id: string, text: string) => {
      stop();
      if (text.trim().length === 0) return;
      try {
        const result = await call("speech:synthesize", {
          text: text.slice(0, 4_000),
        });
        const bytes = Uint8Array.from(atob(result.audioBase64), (char) => char.charCodeAt(0));
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
        const audio = new Audio(objectUrl);
        audio.onended = stop;
        audio.onerror = stop;
        player.current = audio;
        url.current = objectUrl;
        setSpeakingId(id);
        await audio.play();
      } catch (error) {
        stop();
        onError(error);
      }
    },
    [onError, stop],
  );

  return { speakingId, speak, stop };
}
