//! Native audio capture for IQ Compiler.
//!
//! # Why this is not TypeScript
//!
//! The renderer can capture a microphone through `getUserMedia`, and that is
//! what this app used to do. It cannot capture *system audio* on Windows:
//! `getDisplayMedia` audio is tab-scoped in Chromium and unavailable for the
//! desktop, so "record the other participants" quietly recorded nothing. The
//! FFmpeg path had the same hole from the other side — it reached for a
//! DirectShow `virtual-audio-capturer` device that only exists if the user has
//! separately installed screen-capture-recorder, which almost nobody has.
//!
//! WASAPI loopback is the real answer on Windows, and it is reachable from
//! `cpal` but not from a browser engine. Meetly Lite reached the same
//! conclusion and for the same reason: its capture is `cpal` in Rust
//! (meetly-lite `src-tauri/src/audio/mod.rs`). This crate is the equivalent,
//! shaped as a spawned sidecar rather than linked in, so the Electron build
//! does not need a Rust toolchain to produce a working app — only a better one.
//!
//! # Protocol
//!
//! One process per recording. Commands arrive as JSON lines on stdin, events
//! leave as JSON lines on stdout, and nothing else is written to stdout — the
//! parent parses it. Diagnostics go to stderr.
//!
//! ```text
//! iq-audio devices                 -> {"kind":"devices",...}
//! iq-audio capture --out FILE ...  -> {"kind":"started"} {"kind":"level",...}* {"kind":"stopped",...}
//! iq-audio --version               -> iq-audio <semver>
//! ```
//!
//! During a capture, `{"kind":"level"}` events carry per-source RMS so the UI
//! can show the three meters the reference shows (system, microphone, mix). A
//! meter is not decoration here: it is the only way a user finds out that the
//! microphone they picked is muted *before* they record an hour against it.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;

/// The sample rate every downstream consumer wants.
///
/// whisper.cpp accepts nothing else, and Azure's fast transcription is happy
/// with it. Resampling once here is cheaper and less lossy than letting each
/// consumer do it, and it means the WAV on disk is already the thing they need.
const TARGET_RATE: u32 = 16_000;

/// How often a level event is emitted. Fast enough to look live, slow enough
/// that a two-hour recording does not emit a million JSON lines.
const LEVEL_INTERVAL_MS: u64 = 100;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Event {
    Devices {
        inputs: Vec<DeviceInfo>,
        /// Output devices, which is what loopback captures *from*.
        outputs: Vec<DeviceInfo>,
        loopback_supported: bool,
    },
    Started {
        path: String,
        sample_rate: u32,
        channels: u16,
        microphone: Option<String>,
        system: Option<String>,
    },
    Level {
        microphone: f32,
        system: f32,
        mix: f32,
    },
    Stopped {
        path: String,
        duration_ms: u64,
        bytes: u64,
    },
    Error {
        message: String,
    },
}

#[derive(Serialize)]
struct DeviceInfo {
    name: String,
    default: bool,
}

fn emit(event: &Event) {
    // A serialisation failure here would be a bug in this crate, not a runtime
    // condition, so it is reported rather than silently dropped.
    match serde_json::to_string(event) {
        Ok(line) => {
            println!("{line}");
            let _ = std::io::stdout().flush();
        }
        Err(error) => eprintln!("iq-audio: could not serialise event: {error}"),
    }
}

fn fail(message: impl Into<String>) -> ! {
    emit(&Event::Error {
        message: message.into(),
    });
    std::process::exit(1);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("devices") => list_devices(),
        Some("capture") => capture(&args[1..]),
        // A liveness check the parent can run cheaply. `devices` would answer
        // too, but enumerating the machine's hardware to find out whether a
        // binary is usable is the wrong price for a status line.
        Some("--version") | Some("version") => {
            println!("iq-audio {}", env!("CARGO_PKG_VERSION"));
        }
        _ => {
            eprintln!("usage: iq-audio devices | iq-audio capture --out <file> [--mic <name>] [--system] | iq-audio --version");
            std::process::exit(2);
        }
    }
}

fn list_devices() {
    let host = cpal::default_host();

    let default_in = host.default_input_device().and_then(|d| d.name().ok());
    let inputs = host
        .input_devices()
        .map(|devices| {
            devices
                .filter_map(|device| device.name().ok())
                .map(|name| DeviceInfo {
                    default: Some(&name) == default_in.as_ref(),
                    name,
                })
                .collect()
        })
        .unwrap_or_default();

    let default_out = host.default_output_device().and_then(|d| d.name().ok());
    let outputs = host
        .output_devices()
        .map(|devices| {
            devices
                .filter_map(|device| device.name().ok())
                .map(|name| DeviceInfo {
                    default: Some(&name) == default_out.as_ref(),
                    name,
                })
                .collect()
        })
        .unwrap_or_default();

    emit(&Event::Devices {
        inputs,
        outputs,
        // Loopback is WASAPI-only in cpal today. Saying so lets the UI hide
        // "system audio" on platforms where it would silently record nothing,
        // which is the failure this crate exists to remove.
        loopback_supported: cfg!(target_os = "windows"),
    });
}

struct Options {
    out: String,
    microphone: Option<String>,
    system: bool,
}

fn parse(args: &[String]) -> Options {
    let mut out = None;
    let mut microphone = None;
    let mut system = false;

    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--out" => {
                out = args.get(index + 1).cloned();
                index += 2;
            }
            "--mic" => {
                microphone = args.get(index + 1).cloned();
                index += 2;
            }
            "--system" => {
                system = true;
                index += 1;
            }
            other => fail(format!("unknown argument {other}")),
        }
    }

    Options {
        out: out.unwrap_or_else(|| fail("--out is required")),
        microphone,
        system,
    }
}

/// Shared mixing buffer: mono f32 at the device rate, drained by the writer.
#[derive(Default)]
struct Track {
    samples: Vec<f32>,
    rate: u32,
    /// Running RMS over the last window, for the meter.
    level: f32,
}

fn capture(args: &[String]) {
    let options = parse(args);
    let host = cpal::default_host();

    let mic_track = Arc::new(Mutex::new(Track::default()));
    let sys_track = Arc::new(Mutex::new(Track::default()));
    let running = Arc::new(AtomicBool::new(true));

    let mut mic_name = None;
    let mut sys_name = None;
    // Streams must outlive the loop: dropping a cpal stream stops it, and a
    // recording that stops the instant it starts is a confusing way to fail.
    let mut streams: Vec<cpal::Stream> = Vec::new();

    if let Some(requested) = options.microphone.as_deref() {
        let device = find_input(&host, requested)
            .unwrap_or_else(|| fail(format!("no input device named {requested}")));
        mic_name = device.name().ok();
        streams.push(open(&device, Arc::clone(&mic_track), false));
    }

    if options.system {
        if !cfg!(target_os = "windows") {
            fail("system audio capture is only implemented on Windows (WASAPI loopback)");
        }
        let device = host
            .default_output_device()
            .unwrap_or_else(|| fail("no default output device to capture system audio from"));
        sys_name = device.name().ok();
        streams.push(open(&device, Arc::clone(&sys_track), true));
    }

    if streams.is_empty() {
        fail("nothing to capture: pass --mic, --system, or both");
    }

    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: TARGET_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let file = File::create(&options.out)
        .unwrap_or_else(|error| fail(format!("could not create {}: {error}", options.out)));
    let mut writer = hound::WavWriter::new(BufWriter::new(file), spec)
        .unwrap_or_else(|error| fail(format!("could not write a WAV header: {error}")));

    emit(&Event::Started {
        path: options.out.clone(),
        sample_rate: TARGET_RATE,
        channels: 1,
        microphone: mic_name,
        system: sys_name,
    });

    // Stdin closing is the stop signal. It is the one signal that cannot be
    // missed: it arrives whether the parent exited cleanly or was killed, so a
    // crashed parent can never leave this process recording forever.
    {
        let running = Arc::clone(&running);
        std::thread::spawn(move || {
            let mut line = String::new();
            loop {
                line.clear();
                match std::io::stdin().read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) if line.trim() == "stop" => break,
                    Ok(_) => continue,
                    Err(_) => break,
                }
            }
            running.store(false, Ordering::SeqCst);
        });
    }

    let started = std::time::Instant::now();
    let mut samples_written: u64 = 0;
    let mut last_level = std::time::Instant::now();

    while running.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(20));

        let mic = drain(&mic_track);
        let sys = drain(&sys_track);
        let frames = mix(&mic.0, &sys.0);

        // Before the pass, not after: the frames just drained belong at the
        // position the clock says they do, so any gap goes in front of them.
        let behind = silence_needed(elapsed_ms(&started), samples_written, frames.len());
        samples_written += write_silence(&mut writer, behind);

        for sample in &frames {
            // Clamped, not scaled: two sources summing past full scale should
            // clip the peak rather than duck the whole recording.
            let clamped = sample.clamp(-1.0, 1.0);
            if writer.write_sample((clamped * i16::MAX as f32) as i16).is_ok() {
                samples_written += 1;
            }
        }

        if last_level.elapsed() >= std::time::Duration::from_millis(LEVEL_INTERVAL_MS) {
            emit(&Event::Level {
                microphone: mic.1,
                system: sys.1,
                mix: rms(&frames),
            });
            last_level = std::time::Instant::now();
        }
    }

    drop(streams);
    let duration_ms = elapsed_ms(&started);
    // One last top-up, so the reported duration and the file's length agree by
    // construction rather than by luck of where the loop happened to exit.
    let behind = silence_needed(duration_ms, samples_written, 0);
    samples_written += write_silence(&mut writer, behind);
    if let Err(error) = writer.finalize() {
        fail(format!("could not finalise the WAV: {error}"));
    }

    emit(&Event::Stopped {
        path: options.out,
        duration_ms,
        bytes: samples_written * 2,
    });
}

fn elapsed_ms(started: &std::time::Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

/// How many samples of silence must precede a pass for the file to match the
/// clock.
///
/// The writer used to be packet-driven while `duration_ms` was clock-driven,
/// and the two disagreed by exactly the idle time. WASAPI loopback delivers no
/// callbacks at all while the output endpoint is silent — silence is not data,
/// so nothing arrives — which made a two-second system-only capture report
/// `duration_ms: 2063` over a 44-byte file: a WAV containing nothing, described
/// as two seconds long.
///
/// {@link mix} pads one source against the other and so hides this whenever the
/// microphone is running, but it cannot pad a pass in which *both* sources are
/// empty. That is why the bug was total for system-only capture, invisible with
/// a live microphone, and partial — every later timestamp early — whenever the
/// microphone itself under-delivered.
///
/// Making the writer clock-driven too means a silent source produces silence
/// rather than nothing, which is also the honest artefact: an hour of quiet is
/// an hour that was recorded, not a failure to capture.
fn silence_needed(elapsed_ms: u64, samples_written: u64, pending: usize) -> u64 {
    let expected = elapsed_ms.saturating_mul(TARGET_RATE as u64) / 1_000;
    expected.saturating_sub(samples_written.saturating_add(pending as u64))
}

fn write_silence(writer: &mut hound::WavWriter<BufWriter<File>>, samples: u64) -> u64 {
    let mut written = 0;
    for _ in 0..samples {
        if writer.write_sample(0i16).is_ok() {
            written += 1;
        }
    }
    written
}

fn find_input(host: &cpal::Host, name: &str) -> Option<cpal::Device> {
    if name == "default" {
        return host.default_input_device();
    }
    host.input_devices()
        .ok()?
        .find(|device| device.name().map(|found| found == name).unwrap_or(false))
}

/// Open a stream, downmixing to mono and resampling to {@link TARGET_RATE}.
fn open(device: &cpal::Device, track: Arc<Mutex<Track>>, loopback: bool) -> cpal::Stream {
    let config = if loopback {
        device
            .default_output_config()
            .unwrap_or_else(|error| fail(format!("no output config for loopback: {error}")))
    } else {
        device
            .default_input_config()
            .unwrap_or_else(|error| fail(format!("no input config: {error}")))
    };

    let channels = config.channels() as usize;
    let rate = config.sample_rate().0;
    if let Ok(mut guard) = track.lock() {
        guard.rate = rate;
    }

    let stream = device
        .build_input_stream(
            &config.into(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                // Downmix in the callback: it is a few adds per frame, and it
                // keeps the shared buffer one channel regardless of the device.
                let mut mono = Vec::with_capacity(data.len() / channels.max(1));
                for frame in data.chunks(channels.max(1)) {
                    mono.push(frame.iter().sum::<f32>() / frame.len() as f32);
                }
                let level = rms(&mono);
                if let Ok(mut guard) = track.lock() {
                    guard.samples.extend_from_slice(&mono);
                    guard.level = level;
                }
            },
            |error| eprintln!("iq-audio: stream error: {error}"),
            None,
        )
        .unwrap_or_else(|error| fail(format!("could not open the audio stream: {error}")));

    stream
        .play()
        .unwrap_or_else(|error| fail(format!("could not start the audio stream: {error}")));
    stream
}

/// Take everything buffered so far, resampled to the target rate.
fn drain(track: &Arc<Mutex<Track>>) -> (Vec<f32>, f32) {
    let Ok(mut guard) = track.lock() else {
        return (Vec::new(), 0.0);
    };
    let taken = std::mem::take(&mut guard.samples);
    let level = guard.level;
    let rate = guard.rate;
    drop(guard);

    if taken.is_empty() || rate == 0 || rate == TARGET_RATE {
        return (taken, level);
    }
    (resample(&taken, rate, TARGET_RATE), level)
}

/// Linear resampling.
///
/// Deliberately not a windowed-sinc filter: the consumer is a speech model, the
/// direction is almost always downward from 44.1/48 kHz, and the aliasing this
/// admits is inaudible to a transcriber. A better filter is a later change with
/// a measurable win, not a prerequisite.
fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if input.is_empty() || from == 0 {
        return Vec::new();
    }
    let ratio = to as f64 / from as f64;
    let out_len = ((input.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for index in 0..out_len {
        let source = index as f64 / ratio;
        let low = source.floor() as usize;
        let high = (low + 1).min(input.len() - 1);
        let fraction = (source - low as f64) as f32;
        let a = input.get(low).copied().unwrap_or(0.0);
        let b = input.get(high).copied().unwrap_or(a);
        out.push(a + (b - a) * fraction);
    }
    out
}

/// Sum two tracks, padding the shorter with silence.
///
/// Padding rather than truncating: the microphone and the loopback stream do
/// not deliver the same number of frames per callback, and truncating to the
/// shorter would drop a few milliseconds on every pass — which over an hour is
/// a recording that drifts out of sync with itself.
///
/// This covers one source against the other and nothing more. A pass in which
/// both are empty still yields nothing, which is why the caller pads against
/// the clock as well — see {@link silence_needed}.
fn mix(a: &[f32], b: &[f32]) -> Vec<f32> {
    let len = a.len().max(b.len());
    let mut out = Vec::with_capacity(len);
    for index in 0..len {
        out.push(a.get(index).copied().unwrap_or(0.0) + b.get(index).copied().unwrap_or(0.0));
    }
    out
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|sample| sample * sample).sum();
    (sum / samples.len() as f32).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mix_pads_the_shorter_track_rather_than_truncating() {
        // The two streams never deliver equal frame counts, so truncating here
        // would drop milliseconds on every pass and drift over an hour.
        let mixed = mix(&[1.0, 1.0, 1.0], &[0.5]);
        assert_eq!(mixed, vec![1.5, 1.0, 1.0]);
    }

    #[test]
    fn silence_is_written_for_a_pass_that_delivered_nothing() {
        // The measured defect: two seconds of an idle output endpoint used to
        // produce a 44-byte file reported as 2063 ms long.
        assert_eq!(silence_needed(2_000, 0, 0), 32_000);
    }

    #[test]
    fn a_pass_that_delivered_its_share_needs_no_padding() {
        // 100 ms elapsed, 1000 samples already on disk and 600 in hand is
        // exactly 1600 — the writer is level with the clock.
        assert_eq!(silence_needed(100, 1_000, 600), 0);
    }

    #[test]
    fn a_writer_ahead_of_the_clock_is_never_asked_to_unwrite() {
        // A pass can overshoot: the drained buffer may hold more than the
        // elapsed time accounts for. Padding must floor at zero rather than
        // wrap, or the next pass writes eighteen exabytes of silence.
        assert_eq!(silence_needed(10, 1_000, 0), 0);
    }

    #[test]
    fn resample_halves_the_length_when_halving_the_rate() {
        let input: Vec<f32> = (0..100).map(|value| value as f32).collect();
        let out = resample(&input, 32_000, 16_000);
        assert_eq!(out.len(), 50);
    }

    #[test]
    fn resample_is_a_no_op_on_an_empty_buffer() {
        assert!(resample(&[], 48_000, 16_000).is_empty());
    }

    #[test]
    fn rms_of_silence_is_zero() {
        assert_eq!(rms(&[0.0, 0.0, 0.0]), 0.0);
    }

    #[test]
    fn rms_of_full_scale_is_one() {
        assert!((rms(&[1.0, -1.0, 1.0]) - 1.0).abs() < f32::EPSILON);
    }
}
