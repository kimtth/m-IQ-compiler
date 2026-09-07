// Screen capture, running in the hidden recorder window's isolated world.
//
// This file is deliberately the only place in the app with both the Web media
// APIs and `ipcRenderer`. It captures the screen, encodes it, and — critically —
// samples the still JPEGs here rather than extracting them from the video later.
// Sampling in the compositor's own pixel pipeline is what lets the feature ship
// without an image-processing dependency or an ffmpeg pass over the whole
// recording: the frames we want are already decoded in front of us.
//
// Channel names mirror screen-recorder.ts.
const { ipcRenderer } = require("electron");

/** Frames closer than this in Hamming distance are the same screen. */
const FRAME_DEDUPE_DISTANCE = 8;
/** Keep one frame this often even when nothing changed, to prove liveness. */
const FRAME_HEARTBEAT_MS = 5000;
const FRAME_START_TIMEOUT_MS = 5000;
const FRAME_JPEG_QUALITY = 0.78;

let recorder = null;
let stream = null;
// Chunk sends are chained so the final blob — dispatched just before `stop` —
// is fully forwarded before we report that recording stopped. Otherwise the
// last cluster is lost and the webm ends mid-frame.
let sendChain = Promise.resolve();

let frameReader = null;
let framePump = null;
let frameEncoding = null;
let frameTimer = null;
let heartbeatTimer = null;
let frameCanvas = null;
let frameContext = null;
let hashCanvas = null;
let hashContext = null;
let previewVideo = null;

let capturingFrames = false;
let frameReady = false;
let recordingStarted = false;
let startEpoch = 0;
let startMonotonic = 0;
let requestedStopEpoch = 0;
let firstFrameTimestampUs = null;
let firstFrameEpoch = 0;
let lastFrameHash = "";
let lastFrameEmitAt = 0;
let frameErrorReported = false;

function reportFrameError(error) {
  if (frameErrorReported) return;
  frameErrorReported = true;
  ipcRenderer.send("recorder:frame-error", error instanceof Error ? error.message : String(error));
}

/** Wall-clock epoch, tracked through the monotonic clock once recording began. */
function currentEpoch() {
  return recordingStarted ? startEpoch + (performance.now() - startMonotonic) : Date.now();
}

function epochNow() {
  return performance.timeOrigin + performance.now();
}

function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function ensureCanvases(width, height) {
  if (!frameCanvas || frameCanvas.width !== width || frameCanvas.height !== height) {
    frameCanvas = createCanvas(width, height);
    frameContext = frameCanvas.getContext("2d", { alpha: false });
  }
  if (!hashCanvas) {
    // 9x8: the extra column is what each row's 8 comparisons are made against.
    hashCanvas = createCanvas(9, 8);
    hashContext = hashCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
  }
  if (!frameContext || !hashContext) throw new Error("could not create capture canvases");
}

/**
 * A 64-bit difference hash: for each row, is this pixel darker than the next?
 *
 * Difference rather than average hashing because it is unmoved by the thing
 * that changes most often on a screen and matters least — overall brightness,
 * as a window gains focus or a theme animates — while still registering that
 * the content moved.
 */
function dhash() {
  if (!frameCanvas || !hashContext) return "";
  hashContext.drawImage(frameCanvas, 0, 0, 9, 8);
  const pixels = hashContext.getImageData(0, 0, 9, 8).data;
  let bits = "";
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = (row * 9 + col) * 4;
      const right = left + 4;
      const leftLuma =
        pixels[left] * 0.299 + pixels[left + 1] * 0.587 + pixels[left + 2] * 0.114;
      const rightLuma =
        pixels[right] * 0.299 + pixels[right + 1] * 0.587 + pixels[right + 2] * 0.114;
      bits += leftLuma < rightLuma ? "1" : "0";
    }
  }
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let value = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (value) {
      distance += value & 1;
      value >>= 1;
    }
  }
  return distance;
}

function canvasToJpeg(canvas) {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type: "image/jpeg", quality: FRAME_JPEG_QUALITY });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("JPEG encoding returned no data"))),
      "image/jpeg",
      FRAME_JPEG_QUALITY,
    );
  });
}

async function maybeEmitFrame(epochMs, force = false) {
  if (!recordingStarted || !frameReady || !frameCanvas || frameEncoding) return;
  const hash = dhash();
  const heartbeatDue = performance.now() - lastFrameEmitAt >= FRAME_HEARTBEAT_MS;
  if (!force && !heartbeatDue && hamming(hash, lastFrameHash) <= FRAME_DEDUPE_DISTANCE) return;

  frameEncoding = (async () => {
    const blob = await canvasToJpeg(frameCanvas);
    const data = new Uint8Array(await blob.arrayBuffer());
    ipcRenderer.send("recorder:frame", {
      data,
      epochMs: Math.round(epochMs),
      width: frameCanvas.width,
      height: frameCanvas.height,
      phash: hash,
    });
    lastFrameHash = hash;
    lastFrameEmitAt = performance.now();
  })();
  try {
    await frameEncoding;
  } finally {
    frameEncoding = null;
  }
}

async function drawFrame(source, width, height, timestampUs) {
  if (!capturingFrames || width <= 0 || height <= 0) return;
  ensureCanvases(width, height);
  frameContext.drawImage(source, 0, 0, width, height);
  frameReady = true;
  if (!recordingStarted) return;

  // Prefer the track's own timestamp: it is the time the compositor grabbed the
  // framebuffer, which is what the frame actually shows, rather than the time
  // this code got round to looking at it.
  let epochMs = currentEpoch();
  if (Number.isFinite(timestampUs)) {
    if (firstFrameTimestampUs === null) {
      firstFrameTimestampUs = timestampUs;
      firstFrameEpoch = epochMs;
    }
    epochMs = firstFrameEpoch + (timestampUs - firstFrameTimestampUs) / 1000;
  }
  await maybeEmitFrame(epochMs);
}

/** Read decoded frames straight off the track, where that API exists. */
async function pumpTrack(track) {
  const Processor = globalThis.MediaStreamTrackProcessor;
  if (typeof Processor !== "function" || typeof OffscreenCanvas === "undefined") return false;

  const processor = new Processor({ track });
  frameReader = processor.readable.getReader();
  framePump = (async () => {
    while (capturingFrames && frameReader) {
      const { done, value: frame } = await frameReader.read();
      if (done || !frame) break;
      try {
        await drawFrame(
          frame,
          frame.displayWidth || frame.codedWidth,
          frame.displayHeight || frame.codedHeight,
          frame.timestamp,
        );
      } finally {
        frame.close();
      }
    }
  })();
  framePump.catch((error) => {
    if (capturingFrames) reportFrameError(error);
  });
  return true;
}

/** Where MediaStreamTrackProcessor is missing, poll a video element instead. */
async function startTimerFallback(track) {
  const video = document.createElement("video");
  previewVideo = video;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  await withTimeout(video.play(), FRAME_START_TIMEOUT_MS, "timed out starting frame capture");
  if (!capturingFrames || previewVideo !== video) {
    video.pause();
    video.srcObject = null;
    return;
  }
  frameTimer = setInterval(() => {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    void drawFrame(video, video.videoWidth, video.videoHeight, null).catch(reportFrameError);
  }, 1000);
}

async function startFrameCapture(track) {
  capturingFrames = true;
  heartbeatTimer = setInterval(() => {
    if (frameReady) void maybeEmitFrame(currentEpoch(), true).catch(reportFrameError);
  }, FRAME_HEARTBEAT_MS);
  if (!(await pumpTrack(track))) {
    await startTimerFallback(track);
  }
}

async function stopFrameCapture() {
  capturingFrames = false;
  if (frameTimer) clearInterval(frameTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  frameTimer = null;
  heartbeatTimer = null;
  const reader = frameReader;
  frameReader = null;
  if (reader) await reader.cancel().catch(() => undefined);
  if (framePump) await framePump.catch(() => undefined);
  framePump = null;
  // One last still, so the recording ends on what the user was looking at.
  if (frameReady) await maybeEmitFrame(currentEpoch(), true).catch(reportFrameError);
  if (frameEncoding) await frameEncoding.catch(reportFrameError);
  if (previewVideo) {
    previewVideo.pause();
    previewVideo.srcObject = null;
  }
  previewVideo = null;
}

function cleanup() {
  try {
    if (stream) for (const track of stream.getTracks()) track.stop();
  } catch {
    // The tracks are already gone.
  }
  stream = null;
  recorder = null;
  frameCanvas = null;
  frameContext = null;
  hashCanvas = null;
  hashContext = null;
  frameReady = false;
  capturingFrames = false;
  recordingStarted = false;
  requestedStopEpoch = 0;
  firstFrameTimestampUs = null;
  lastFrameHash = "";
  lastFrameEmitAt = 0;
  frameErrorReported = false;
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  const expired = new Promise((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timeout));
}

ipcRenderer.on("recorder:start", async (_event, options) => {
  const { sourceId, fps, bitsPerSecond, maxWidth, maxHeight } = options;
  try {
    sendChain = Promise.resolve();
    // Electron's desktop capture still uses the legacy mandatory-constraints
    // form; the modern constraint names are ignored here.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
          maxFrameRate: fps,
          maxWidth,
          maxHeight,
        },
      },
    });

    // VP8 costs noticeably less CPU than VP9 and, at one frame a second, the
    // size difference is nothing. Keeping the machine responsive matters more:
    // a recorder that makes the work slower changes the work being recorded.
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
      ? "video/webm;codecs=vp8"
      : "video/webm;codecs=vp9";
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitsPerSecond });

    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error("desktop capture returned no video track");

    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      sendChain = sendChain.then(async () => {
        const buffer = await event.data.arrayBuffer();
        ipcRenderer.send("recorder:chunk", new Uint8Array(buffer));
      });
    };
    recorder.onstart = () => {
      startEpoch = epochNow();
      startMonotonic = performance.now();
      recordingStarted = true;
      ipcRenderer.send("recorder:started", startEpoch);
    };
    recorder.onstop = () => {
      Promise.all([sendChain, stopFrameCapture()])
        .then(() => {
          const stopEpoch = requestedStopEpoch || currentEpoch();
          cleanup();
          ipcRenderer.send("recorder:stopped", stopEpoch);
        })
        .catch((error) => {
          const stopEpoch = requestedStopEpoch || currentEpoch();
          cleanup();
          ipcRenderer.send(
            "recorder:error",
            error instanceof Error ? error.message : String(error),
          );
          ipcRenderer.send("recorder:stopped", stopEpoch);
        });
    };
    recorder.onerror = (event) => {
      ipcRenderer.send("recorder:error", String((event && event.error) || event));
    };

    // A chunk a second, so a long session streams to disk instead of living in
    // memory until stop.
    recorder.start(1000);
    void startFrameCapture(track).catch((error) => {
      reportFrameError(error);
      void stopFrameCapture().catch(reportFrameError);
    });
  } catch (error) {
    await stopFrameCapture().catch(() => undefined);
    cleanup();
    ipcRenderer.send("recorder:error", error instanceof Error ? error.message : String(error));
  }
});

ipcRenderer.on("recorder:stop", async () => {
  try {
    if (recorder && recorder.state !== "inactive") {
      requestedStopEpoch = currentEpoch();
      recorder.requestData();
      recorder.stop();
    } else {
      await stopFrameCapture();
      ipcRenderer.send("recorder:stopped", requestedStopEpoch || currentEpoch());
    }
  } catch (error) {
    const stopEpoch = requestedStopEpoch || currentEpoch();
    await stopFrameCapture().catch(() => undefined);
    ipcRenderer.send("recorder:error", error instanceof Error ? error.message : String(error));
    ipcRenderer.send("recorder:stopped", stopEpoch);
  }
});
