import {
  MAX_SYNTHESIS_CHARS,
  RetryPolicy,
  TranscriptSegment,
  type SpeechStatus,
  type SpeechTestResult,
  type SynthesisResult,
  type TranscriptionResult,
} from "@iq/shared";
import type { EntraAuth } from "../entra/entra-auth.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { TenantPolicy } from "../policy/tenant-policy.js";
import type { Logger } from "../util/logger.js";
import { withRetry, NonRetryableError } from "../util/retry.js";
import { hostOf as sharedHostOf, messageOf, UNNAMED_ENDPOINT } from "../util/text.js";

/**
 * Azure AI Speech.
 *
 * Transcription supports meeting capture and push-to-talk, and neural synthesis
 * supports spoken replies. Audio goes to the tenant's own Azure resource and
 * nowhere else; there is no third-party speech path, and no fallback that would
 * send audio somewhere the tenant did not choose.
 *
 * **One authentication mode: the Azure identity.** A token is acquired for the
 * `azure.speech` capability at first use, exactly like every Graph capability,
 * and presented as a bearer token. Resource keys are not supported and are
 * never stored — a registered resource is an ARM id plus a region, which is a
 * network destination and a capability claim, not a secret, so it is safe to
 * persist and safe to show. This is the same rule the Foundry model registry
 * follows, and it is what lets the app work in tenants where key authentication
 * is disabled outright.
 *
 * The resource itself is registered by the user in *Connections & access*
 * (see `SpeechRegistry`); environment variables remain a host-level fallback
 * for headless runs.
 *
 * The service is inert without configuration: `status()` reports
 * `not_configured` and every call throws the same message, so the UI can hide
 * voice features rather than offer ones that will fail.
 */

export interface SpeechConfig {
  /** Label shown in Connections & access. */
  displayName: string;
  /**
   * The resource's custom domain endpoint,
   * `https://{your custom name}.cognitiveservices.azure.com`.
   *
  * This is the whole address. A custom-domain Speech resource routes REST
  * calls differently from a regional endpoint: the custom host replaces the
  * regional host and the service path is preserved (or gains `/tts` for
  * text-to-speech). The app therefore supports this one resource-base form;
  * a regional endpoint cannot stand in for it.
  *
  * This app uses an Entra bearer token and stores no resource key. Per the
  * Speech private-endpoint guidance, that is supported when the resource's
  * Networking mode is **All networks**. A resource restricted to selected or
  * private networks needs a key for the special STT/TTS endpoints and is
  * deliberately outside this no-key application's contract.
   */
  endpoint: string;
  locale: string;
  voice: string;
  /** Where the registration came from. Environment entries are not editable in the UI. */
  source: "user" | "environment";
}

export const SPEECH_SETUP_HINT =
  "No Azure AI Speech resource is registered. Add its custom domain endpoint (https://‹name›.cognitiveservices.azure.com) in Connections & access. IQ Compiler uses your Azure identity and stores no key, so the Speech resource must allow bearer access through Networking → All networks.";

export const SPEECH_SCOPE = "https://cognitiveservices.azure.com/.default";

/** Short, bounded retries: a user is waiting on every one of these calls. */
const SPEECH_RETRY: RetryPolicy = RetryPolicy.parse({
  maxAttempts: 3,
  backoffMs: 500,
  backoffFactor: 2,
  maxBackoffMs: 4_000,
});

/**
 * Host-level fallback for headless runs.
 *
 * `IQ_SPEECH_KEY` is deliberately not read: key authentication is disabled in
 * the environments this app targets, and honouring it would reintroduce a
 * stored secret the design forbids.
 */
export function speechConfigFromEnv(): SpeechConfig | null {
  const endpoint = process.env["IQ_SPEECH_ENDPOINT"];
  // One address, and it is not optional: without a custom domain there is
  // nothing an Entra token can be presented to.
  if (!endpoint) return null;

  return {
    displayName: process.env["IQ_SPEECH_NAME"] ?? "Azure AI Speech (environment)",
    endpoint: trimSlash(endpoint),
    locale: process.env["IQ_SPEECH_LOCALE"] ?? "en-US",
    voice: process.env["IQ_SPEECH_VOICE"] ?? "en-US-AvaMultilingualNeural",
    source: "environment",
  };
}

export interface SpeechDeps {
  /**
   * The registered resource, or a getter for it. A getter lets the registry
   * re-point the service the moment the user adds or removes an entry, without
   * rebuilding anything that already holds a reference.
   */
  config: SpeechConfig | null | (() => SpeechConfig | null);
  entra: EntraAuth;
  audit: AuditLog;
  tenantPolicy: TenantPolicy;
  logger: Logger;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface TranscribeInput {
  audio: Uint8Array;
  mimeType: string;
  locale?: string;
  /** Ask the service to label speakers. Used for meetings, not push-to-talk. */
  diarize?: boolean;
  maxSpeakers?: number;
  correlationId: string;
}

export class SpeechNotConfiguredError extends Error {
  override readonly name = "SpeechNotConfiguredError";
  constructor(message = SPEECH_SETUP_HINT) {
    super(message);
  }
}

export class SpeechService {
  constructor(private readonly deps: SpeechDeps) {}

  /** The registered resource right now; re-read on every call so edits take effect. */
  private get config(): SpeechConfig | null {
    const source = this.deps.config;
    return typeof source === "function" ? source() : source;
  }

  isConfigured(): boolean {
    return this.status().state === "ready";
  }

  status(): SpeechStatus {
    const config = this.config;
    if (!config) return { state: "not_configured", message: SPEECH_SETUP_HINT };

    // A tenant that denies the Speech scope has switched voice off. Saying so
    // here keeps the UI honest instead of failing at the first click.
    if (this.deps.tenantPolicy.deniedScopes.includes(SPEECH_SCOPE)) {
      return {
        state: "not_configured",
        message:
          "Azure AI Speech is disabled by tenant policy: the Cognitive Services scope is denied.",
      };
    }

    return {
      state: "ready",
      auth: "entra",
      displayName: config.displayName,
      endpoint: config.endpoint,
      locale: config.locale,
      voice: config.voice,
      source: config.source,
      editable: config.source === "user",
      synthesis: true,
    };
  }

  /** The locale transcription defaults to. Used to label a stored transcript. */
  get defaultLocale(): string {
    return this.config?.locale ?? "en-US";
  }

  private requireConfig(): SpeechConfig {
    const status = this.status();
    if (status.state !== "ready") throw new SpeechNotConfiguredError(status.message);
    // `status` is only "ready" when a config exists, so this cannot be null.
    return this.config as SpeechConfig;
  }

  private get fetch(): typeof fetch {
    return this.deps.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Authorisation header for a Speech call.
   *
   * One path only. It goes through the same `acquireForCapability` every Graph
   * call uses, so consent, the tenant deny floor and the audit record are the
   * mechanisms already in place rather than a second, parallel set. There is no
  * key branch. That is a deliberate security boundary, and it has one stated
  * networking consequence: Speech's special STT/TTS endpoints accept this
  * bearer form only while the resource allows **All networks**. A private or
  * selected-network resource requires `Ocp-Apim-Subscription-Key`, which this
  * app neither asks for nor stores.
   */
  private async authHeaders(
    _config: SpeechConfig,
    correlationId: string,
  ): Promise<Record<string, string>> {
    const token = await this.deps.entra.acquireForCapability("azure.speech", correlationId);
    return { Authorization: "Bearer " + token };
  }

  /**
   * Fast transcription, on the resource's own custom domain.
   *
   * Not `{region}.api.cognitive.microsoft.com`: that host is key-authenticated
   * and rejects an Entra token, which is the only credential this app has.
   */
  private transcriptionUrl(config: SpeechConfig): string {
    return `${config.endpoint}/speechtotext/transcriptions:transcribe?api-version=2024-11-15`;
  }

  /**
   * Text-to-speech, which lives under `/tts` on a custom domain.
   *
  * On a regional host the synthesis path is `/cognitiveservices/v1`; on a custom domain
   * that path **does not exist** and the gateway answers a bare
   * `404 Resource not found` — no hint, no mention of a prefix. The same call
   * under `/tts/cognitiveservices/v1` reaches the service and answers 401 or
   * 200 depending on the caller's role.
   *
   * That distinction matters here more than anywhere else, because a custom
  * domain is the *only resource-base form this app accepts*. The reason is
  * the custom-domain routing model, not a claim that every regional Speech
  * API rejects Entra. So the unprefixed form was not a fallback that happened
  * to be wrong for some users — it could never work for a registered custom
  * domain.
   *
   * Speech-to-text is not under the prefix. `/speechtotext/...` is served on
   * the custom domain as written, which is why only these two moved.
   */
  private synthesisUrl(config: SpeechConfig): string {
    return `${config.endpoint}/tts/cognitiveservices/v1`;
  }

  /**
   * Transcribe audio with Azure's fast transcription API.
   *
   * One code path serves both a two-second push-to-talk clip and an hour of
   * meeting audio, which keeps the number of ways audio can leave this machine
   * at exactly one.
   */
  async transcribe(input: TranscribeInput): Promise<TranscriptionResult> {
    const config = this.requireConfig();
    const locale = input.locale ?? config.locale;

    const definition = {
      locales: [locale],
      profanityFilterMode: "None",
      ...(input.diarize
        ? { diarization: { enabled: true, maxSpeakers: input.maxSpeakers ?? 8 } }
        : {}),
    };

    const headers = await this.authHeaders(config, input.correlationId);

    const payload = await withRetry(SPEECH_RETRY, async () => {
      // Rebuilt per attempt: a FormData body is consumed by the first send.
      const form = new FormData();
      form.append("audio", new Blob([toArrayBuffer(input.audio)], { type: input.mimeType }), "audio");
      form.append("definition", JSON.stringify(definition));

      const response = await this.fetch(this.transcriptionUrl(config), {
        method: "POST",
        headers,
        body: form,
      });
      if (!response.ok) throw await speechError(response, "transcription");
      return (await response.json()) as FastTranscriptionResponse;
    });

    const result = parseFastTranscription(payload, locale);

    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "speech.transcribe",
      family: "speech",
      outcome: "succeeded",
      correlationId: input.correlationId,
      // Recorded so an auditor can see that audio left the device, and roughly
      // how much, without the transcript itself entering the audit log.
      reason: `${input.audio.byteLength} bytes, ${result.segments.length} segments, locale ${locale}`,
    });

    return result;
  }

  /** Synthesize an assistant reply. Over-long text is truncated, not refused. */
  async synthesize(input: {
    text: string;
    voice?: string;
    correlationId: string;
  }): Promise<SynthesisResult> {
    const config = this.requireConfig();
    const voice = input.voice ?? config.voice;
    const text = input.text.slice(0, MAX_SYNTHESIS_CHARS);
    const headers = await this.authHeaders(config, input.correlationId);

    const audio = await withRetry(SPEECH_RETRY, async () => {
      const response = await this.fetch(this.synthesisUrl(config), {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
          "User-Agent": "iq-compiler",
        },
        body: buildSsml(text, voice, config.locale),
      });
      if (!response.ok) throw await speechError(response, "synthesis");
      return new Uint8Array(await response.arrayBuffer());
    });

    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "speech.synthesize",
      family: "speech",
      outcome: "succeeded",
      correlationId: input.correlationId,
      reason: `${text.length} characters, voice ${voice}`,
    });

    return {
      audioBase64: Buffer.from(audio).toString("base64"),
      mimeType: "audio/mpeg",
      voice,
      characters: text.length,
    };
  }

  /**
   * Connection check for *Connections & access*.
   *
   * A GET of the voice list: the cheapest call that still exercises the
   * endpoint, the credential and the network, and the only one that cannot cost
   * anything or produce a side effect. It distinguishes "not configured" from
   * "wrong permission" from "wrong endpoint", because that distinction is what
   * makes the control worth having — a user who sees `failed` for all three
   * learns nothing.
   */
  async test(correlationId: string): Promise<SpeechTestResult> {
    const testedAt = new Date().toISOString();
    const status = this.status();
    if (status.state !== "ready") {
      return {
        state: "not_configured",
        message: status.message,
        nextStep: SPEECH_SETUP_HINT,
        testedAt,
        auth: "none",
        endpoint: "",
      };
    }

    const config = this.config as SpeechConfig;
    const base = { testedAt, auth: status.auth, endpoint: config.endpoint } as const;

    let headers: Record<string, string>;
    try {
      headers = await this.authHeaders(config, correlationId);
    } catch (error) {
      return {
        ...base,
        state: "unauthorized",
        message: messageOf(error),
        nextStep:
          "Sign in to Microsoft in Connections & access, then retry — the Speech token could not be acquired.",
      };
    }

    let response: Response;
    try {
      response = await this.fetch(this.voiceListUrl(config), { method: "GET", headers });
    } catch (error) {
      return {
        ...base,
        state: "failed",
        message: messageOf(error),
        nextStep: `Could not reach ${hostOf(config.endpoint)}. Check the endpoint and your network, then retry.`,
      };
    }

    const result = classifySpeechProbe(response.status, base);
    await this.deps.audit.record({
      actor: { kind: "system" },
      action: "speech.test",
      family: "speech",
      outcome: result.state === "reachable" ? "succeeded" : "failed",
      correlationId,
      resources: [hostOf(config.endpoint)],
      reason: result.message,
    });
    return result;
  }

  private voiceListUrl(config: SpeechConfig): string {
    return `${config.endpoint}/tts/cognitiveservices/voices/list`;
  }
}

function classifySpeechProbe(
  status: number,
  base: { testedAt: string; auth: "entra"; endpoint: string },
): SpeechTestResult {
  if (status >= 200 && status < 300) {
    return {
      ...base,
      state: "reachable",
      message: "The Speech resource responded and the credential is accepted.",
      nextStep: "Voice input, spoken replies and meeting transcription are ready.",
    };
  }
  if (status === 401 || status === 403) {
    return {
      ...base,
      state: "unauthorized",
      message: `The credential was rejected (HTTP ${status}).`,
      nextStep:
        "Grant your identity Cognitive Services Speech User on this resource (or switch tenant), then retry. If the role is already assigned, set Speech Networking to All networks: this app uses a bearer token and does not store the resource key required by selected/private-network Speech endpoints.",
    };
  }
  if (status === 404) {
    return {
      ...base,
      state: "not_found",
      message: "The Speech endpoint returned 404.",
      nextStep: `Check that ${hostOf(base.endpoint)} is the resource's custom domain endpoint — the one shown under Keys and Endpoint in the Azure portal.`,
    };
  }
  return {
    ...base,
    state: "failed",
    message: `The Speech endpoint returned HTTP ${status}.`,
    nextStep: "Retry; if it persists, check the resource's health and quota in the Azure portal.",
  };
}

/** Trailing slashes are a paste artefact; every URL here appends its own path. */
function trimSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * Only the host is ever logged or audited — never a full Speech URL.
 *
 * The fallback is a constant, not the endpoint. `IQ_SPEECH_ENDPOINT` is not
 * validated as a URL, so a value that does not parse would otherwise be
 * written out whole — query string, and any key hidden in it, included. The
 * messages that use this all say "check the endpoint" in the next breath, so
 * naming it buys nothing that would justify the risk.
 */
const hostOf = (endpoint: string): string => sharedHostOf(endpoint, UNNAMED_ENDPOINT);

interface FastTranscriptionResponse {
  durationMilliseconds?: number;
  combinedPhrases?: Array<{ text?: string }>;
  phrases?: Array<{
    offsetMilliseconds?: number;
    durationMilliseconds?: number;
    text?: string;
    speaker?: number;
    locale?: string;
  }>;
}

/**
 * Normalize Azure's fast-transcription payload into our segment shape.
 *
 * Exported for tests: this is the one place where an external contract we do
 * not control becomes one we do, so it is worth pinning.
 */
export function parseFastTranscription(
  payload: FastTranscriptionResponse,
  locale: string,
): TranscriptionResult {
  const segments = (payload.phrases ?? [])
    .map((phrase) => {
      const startMs = Math.max(0, Math.round(phrase.offsetMilliseconds ?? 0));
      const durationMs = Math.max(0, Math.round(phrase.durationMilliseconds ?? 0));
      return {
        speaker: phrase.speaker === undefined ? null : `Speaker ${phrase.speaker}`,
        startMs,
        endMs: startMs + durationMs,
        text: (phrase.text ?? "").trim(),
      };
    })
    .filter((segment) => segment.text.length > 0)
    // Indexed after dropping empties so `index` stays a dense ordinal.
    .map((segment, index) => TranscriptSegment.parse({ ...segment, index }));

  const combined = (payload.combinedPhrases ?? [])
    .map((entry) => (entry.text ?? "").trim())
    .filter(Boolean)
    .join(" ");

  return {
    text: combined || segments.map((segment) => segment.text).join(" "),
    durationMs: Math.max(0, Math.round(payload.durationMilliseconds ?? 0)),
    segments,
    locale,
  };
}

/**
 * A 4xx other than 429 is a bad request, a bad credential or an unsupported
 * audio format. Retrying re-sends the same audio for the same answer, so it is
 * marked non-retryable and surfaces immediately.
 */
async function speechError(response: Response, what: string): Promise<Error> {
  const body = (await response.text().catch(() => "")).slice(0, 400);
  const message = `Azure AI Speech ${what} failed: ${response.status} ${response.statusText}${
    body ? ` - ${body}` : ""
  }`;
  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
    return new NonRetryableError(message);
  }
  return new Error(message);
}

/** SSML with the text escaped, so a reply containing markup cannot alter it. */
function buildSsml(text: string, voice: string, locale: string): string {
  const escaped = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${voice}">${escaped}</voice></speak>`;
}

/** Copy into a standalone ArrayBuffer; a Uint8Array view may be a slice of a pool. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
