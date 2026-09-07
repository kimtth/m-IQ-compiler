import { z } from "zod";

/**
 * Speech contracts.
 *
 * Voice input, push-to-talk and text-to-speech are implemented against Azure AI
 * Speech, which keeps audio inside the tenant's own Azure resource.
 *
 * Audio never crosses the IPC boundary as a stream. It crosses as a single
 * base64 payload with a declared MIME type, so the privileged side can bound
 * its size and refuse a type it will not send onwards.
 */

/** Container types the renderer can produce and Azure AI Speech accepts. */
export const AudioMimeType = z.enum([
  "audio/webm",
  "audio/webm;codecs=opus",
  "audio/ogg",
  "audio/ogg;codecs=opus",
  "audio/wav",
  "audio/mpeg",
]);
export type AudioMimeType = z.infer<typeof AudioMimeType>;

/**
 * Upper bound on one base64 audio payload, ~12 MiB of encoded audio.
 *
 * Long recordings are appended in chunks rather than sent whole, so this is a
 * ceiling on a single chunk and on one push-to-talk clip, not on a meeting.
 */
export const MAX_AUDIO_BASE64_CHARS = 16_000_000;

/**
 * Regional hosts that this application does not support as a resource base.
 *
 * This is a routing rule, not an authentication claim. The Speech documentation
 * distinguishes the regional API hosts from a custom-domain Speech resource:
 * after a custom domain is enabled, REST calls address
 * `{custom}.cognitiveservices.azure.com` and preserve (or, for TTS, transform)
 * their service path. The regional endpoints are still used in some Speech
 * authorization and SDK scenarios; they are not globally "key-only".
 *
 * IQ Compiler registers one endpoint and constructs all three REST URLs from
 * it. That contract needs the custom domain, which is also what private-endpoint
 * DNS resolves. Accepting a regional host here would make the registration look
 * valid while sending one or more calls to the wrong routing plane.
 */
export const SPEECH_REGIONAL_HOST_PATTERN =
  /(^|\.)((api\.cognitive\.microsoft\.com)|(speech\.microsoft\.com))$/i;

/**
 * A Speech resource registered by the user in *Connections & access*.
 *
 * There is no key field: the resource is reached with the signed-in Azure
 * identity (a managed identity or the developer's own), which is the same rule
 * the Foundry model registry follows. Registering a resource therefore stores
 * nothing that would be dangerous to read. That makes this app intentionally
 * incompatible with a Speech resource restricted to private/selected networks:
 * the Speech documentation requires `Ocp-Apim-Subscription-Key` for its
 * special STT/TTS endpoints in those network modes. Bearer authentication to
 * the custom-domain endpoints works when Networking is **All networks**.
 *
 * The registration is **one address**: the resource's custom domain endpoint,
 * `https://{your custom name}.cognitiveservices.azure.com/`. It replaced a
 * region and an ARM resource id, neither of which could address a host that
 * accepts an Entra token — a regional endpoint rejects one, and the resource id
 * is only needed by the Speech *SDK*'s `aad#{id}#{token}` format, which this
 * app does not use because it calls the REST surface directly.
 */
export const SpeechResourceInput = z.object({
  displayName: z.string().min(1).max(120).default("Azure AI Speech"),
  endpoint: z
    .string()
    .trim()
    .url()
    .refine((value) => value.startsWith("https://"), "the endpoint must be https")
    .refine(
      (value) => !SPEECH_REGIONAL_HOST_PATTERN.test(new URL(value).hostname),
      "that is a regional endpoint, which cannot accept a Microsoft Entra token. Use the resource's custom domain, e.g. https://my-speech.cognitiveservices.azure.com",
    ),
  locale: z.string().trim().min(2).max(20).default("en-US"),
  voice: z.string().trim().min(1).max(120).default("en-US-AvaMultilingualNeural"),
});
export type SpeechResourceInput = z.input<typeof SpeechResourceInput>;
export type SpeechResource = z.infer<typeof SpeechResourceInput>;

export const SpeechStatus = z.discriminatedUnion("state", [
  /** No Azure AI Speech resource is registered; voice features stay inert. */
  z.object({ state: z.literal("not_configured"), message: z.string() }),
  z.object({
    state: z.literal("ready"),
    /** Always the Azure identity. Kept as a field so the UI can state it plainly. */
    auth: z.literal("entra"),
    displayName: z.string(),
    /** The custom domain endpoint. A destination, not a secret. */
    endpoint: z.string(),
    locale: z.string(),
    voice: z.string(),
    /** Where the registration came from: the user, or host environment variables. */
    source: z.enum(["user", "environment"]),
    /** True when the entry can be edited or removed from the UI. */
    editable: z.boolean(),
    /** False when the deployment allows transcription but not synthesis. */
    synthesis: z.boolean(),
  }),
]);
export type SpeechStatus = z.infer<typeof SpeechStatus>;

/** One diarized span of recognised speech. */
export const TranscriptSegment = z.object({
  index: z.number().int().min(0),
  /** Diarization label, or null when the provider returned no speaker. */
  speaker: z.string().nullable(),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  text: z.string(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;

export const TranscriptionResult = z.object({
  text: z.string(),
  durationMs: z.number().int().min(0),
  segments: z.array(TranscriptSegment),
  locale: z.string(),
});
export type TranscriptionResult = z.infer<typeof TranscriptionResult>;

export const SynthesisResult = z.object({
  audioBase64: z.string(),
  mimeType: z.string(),
  voice: z.string(),
  characters: z.number().int().min(0),
});
export type SynthesisResult = z.infer<typeof SynthesisResult>;

/**
 * Cap on one synthesis request.
 *
 * A long assistant answer is truncated rather than rejected, because the point
 * of speaking a reply is to hear the opening of it; the full text stays on
 * screen.
 */
export const MAX_SYNTHESIS_CHARS = 4_000;

/**
 * Outcome of the Speech connection check in *Connections & access*.
 *
 * Same vocabulary as a Foundry model test, with one extra state: a Speech
 * resource can simply be absent, which is a configuration answer rather than a
 * failure and needs its own next step.
 */
export const SpeechTestState = z.enum([
  "reachable",
  "unauthorized",
  "not_found",
  "failed",
  "not_configured",
]);
export type SpeechTestState = z.infer<typeof SpeechTestState>;

export const SpeechTestResult = z.object({
  state: SpeechTestState,
  message: z.string(),
  /** What the user should do next when the state is not `reachable`. */
  nextStep: z.string(),
  testedAt: z.string().datetime(),
  /** How the probe authenticated. `none` means it never got as far as a credential. */
  auth: z.enum(["entra", "none"]).default("none"),
  /** The endpoint that was dialled, so a wrong address is legible in the result. */
  endpoint: z.string().default(""),
});
export type SpeechTestResult = z.infer<typeof SpeechTestResult>;
