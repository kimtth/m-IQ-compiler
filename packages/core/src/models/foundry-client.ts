import type { RetryPolicy } from "@iq/shared";
import {
  type FoundryModelEntry,
  type ImageRequest,
  type ModelTestResult,
  type ModelTestState,
} from "@iq/shared";
import { NonRetryableError, withRetry, withTimeout } from "../util/retry.js";
import type { Logger } from "../util/logger.js";
import { hostOf as sharedHostOf, messageOf } from "../util/text.js";

/**
 * The wire to Microsoft Foundry.
 *
 * There is exactly one authentication story here and it is the reason this
 * class takes a `token` callback rather than any configuration of its own: every
 * call is bearer-authenticated with the Azure identity, minted per correlation
 * id through {@link EntraAuth.acquireForCapability} for `azure.foundry`. No
 * endpoint key is ever held, passed or logged, because none exists — the only
 * secret in the system stays in the Azure CLI's token cache.
 *
 * Two logging rules are load-bearing and mirror the browser audit rule
 * (browser/url-policy): the token never reaches a log, and neither does a full
 * URL. A Foundry inference URL carries the deployment name in its path; only
 * the host is ever recorded, so an accidental `debug` line can never leak a
 * routable, credential-adjacent address.
 *
 * A Foundry entry is one shape: a raw Azure OpenAI deployment. Chat reaches it
 * on the versioned `/openai/deployments/{name}` route; images reach it on the
 * OpenAI-compatible `/openai/v1` surface, which is where the gpt-image class of
 * deployments is actually served. The Test control drives {@link probe},
 * which is deliberately the cheapest reachability check that can still tell
 * "wrong permission" from "wrong name" apart, because that distinction is the
 * whole value of the control.
 */

export interface FoundryClientDeps {
  logger: Logger;
  /**
   * Acquire an Azure access token for `azure.foundry`. Injected so the client
   * stays free of the identity machinery and testable with a fake token.
   */
  token: (correlationId: string) => Promise<string>;
  /** Overridable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ChatOptions {
  correlationId: string;
  temperature?: number;
  maxTokens?: number;
  /** Only meaningful for reasoning deployments; passed through untouched. */
  reasoningEffort?: string;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  raw: unknown;
}

/** Decoded image bytes handed in by the image service; never read from disk here. */
export interface ImageSources {
  correlationId: string;
  image?: Uint8Array;
  imageName?: string;
  mask?: Uint8Array;
  maskName?: string;
}

export interface ImageResult {
  /** Base64 payloads, one per generated image, without a data-URL prefix. */
  images: string[];
}

/** Wall-clock caps. A hung Foundry call must never hold a job slot open. */
const CHAT_TIMEOUT_MS = 120_000;
const IMAGE_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 20_000;

/**
 * Retries cover transport flakiness only. 429 and 5xx are the transient class;
 * every 4xx is deterministic and is surfaced immediately, never retried, so a
 * permission problem is reported in one round-trip rather than four.
 */
const RETRY: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: 500,
  backoffFactor: 2,
  maxBackoffMs: 8_000,
};

/**
 * Carries a transient HTTP response out through the retry loop.
 *
 * `withRetry` retries this (it is not a {@link NonRetryableError}) and then
 * rethrows the last one; catching it lets the caller classify the final 5xx
 * as `failed` rather than losing the status behind a generic transport error.
 */
class TransientHttpError extends Error {
  override readonly name = "TransientHttpError";
  constructor(readonly response: Response) {
    super(`transient HTTP ${response.status}`);
  }
}

export class FoundryClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: FoundryClientDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /**
   * A chat or reasoning completion on the Azure OpenAI `chat/completions`
   * surface.
   */
  async chat(
    entry: FoundryModelEntry,
    messages: ChatMessage[],
    options: ChatOptions,
  ): Promise<ChatResult> {
    const token = await this.deps.token(options.correlationId);

    const url = this.deploymentUrl(entry, "chat/completions");
    const body: Record<string, unknown> = { messages };
    if (options.temperature !== undefined) body["temperature"] = options.temperature;
    if (options.maxTokens !== undefined) body["max_tokens"] = options.maxTokens;
    if (options.reasoningEffort) body["reasoning_effort"] = options.reasoningEffort;

    const response = await this.sendJson(url, token, body, CHAT_TIMEOUT_MS, options.signal);
    const raw = await this.readJson(response, url);
    this.assertOk(response, url, "call this deployment");

    const content =
      (raw as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message
        ?.content ?? "";
    return { content, raw };
  }

  /**
   * Generate or edit images on a Foundry image deployment.
   *
   * Images use the **v1 surface** (`/openai/v1/images/...`), not the versioned
   * `/openai/deployments/{name}/...` route the chat calls use. The gpt-image
   * class of deployments is only served there: on the deployment route they
   * answer 404 for every `api-version` this app could sensibly default to, and
   * the v1 surface takes the deployment as a `model` field in the body rather
   * than in the path, with no `api-version` at all.
   *
   * `generate` posts JSON to `images/generations`; `edit` and `variation` post
   * multipart to `images/edits`, because those operations carry the source image
   * — and, for `edit`, an optional mask — as file parts. A variation is modelled
   * as an edit with no mask, which is the closest the gpt-image surface offers.
   */
  async images(
    entry: FoundryModelEntry,
    request: ImageRequest,
    sources: ImageSources,
  ): Promise<ImageResult> {
    const token = await this.deps.token(sources.correlationId);
    const model = entry.deploymentName;

    let response: Response;
    let url: string;
    if (request.operation === "generate") {
      url = this.v1Url(entry, "images/generations");
      const body: Record<string, unknown> = {
        model,
        prompt: request.prompt,
        n: request.count,
        size: request.size,
        quality: request.quality,
      };
      response = await this.sendJson(url, token, body, IMAGE_TIMEOUT_MS);
    } else {
      url = this.v1Url(entry, "images/edits");
      if (!sources.image) {
        throw new NonRetryableError(
          "an edit needs a source image — select one in the project before generating.",
        );
      }
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", request.prompt);
      form.set("n", String(request.count));
      form.set("size", request.size);
      form.set("quality", request.quality);
      form.set("image", new Blob([sources.image]), sources.imageName ?? "source.png");
      if (sources.mask) {
        form.set("mask", new Blob([sources.mask]), sources.maskName ?? "mask.png");
      }
      response = await this.sendForm(url, token, form, IMAGE_TIMEOUT_MS);
    }

    const raw = await this.readJson(response, url);
    this.assertOk(response, url, "generate images on this deployment");

    const data = (raw as { data?: Array<{ b64_json?: string; url?: string }> }).data ?? [];
    const images: string[] = [];
    for (const item of data) {
      if (item.b64_json) images.push(item.b64_json);
    }
    if (images.length === 0) {
      throw new Error(
        "the deployment returned no inline image data; check it is a gpt-image class deployment.",
      );
    }
    return { images };
  }

  /**
   * Cheapest reachability check that still distinguishes the failure kinds the
   * Test control cares about. Image deployments are served only through the
   * OpenAI-compatible v1 API, so their metadata comes from its model route;
   * chat deployments retain Azure OpenAI's versioned deployment metadata route.
   * Both are GETs, so a probe never spends tokens or produces a side effect.
   */
  async probe(entry: FoundryModelEntry): Promise<ModelTestResult> {
    const correlationId = `probe:${entry.id}`;
    const testedAt = new Date().toISOString();

    let token: string;
    try {
      token = await this.deps.token(correlationId);
    } catch (error) {
      return {
        state: "unauthorized",
        message: messageOf(error),
        nextStep:
          "Sign in to Microsoft in Connections & access, then retry — the Azure token could not be acquired.",
        testedAt,
      };
    }

    const url = entry.capabilities.includes("image")
      ? this.modelUrl(entry)
      : this.deploymentUrl(entry, "");
    let response: Response;
    try {
      response = await this.send(url, { method: "GET", headers: this.authHeaders(token) }, PROBE_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof TransientHttpError) {
        return this.classify(error.response.status, testedAt);
      }
      this.deps.logger.debug("foundry.probe transport failure", {
        host: hostOf(url),
        message: messageOf(error),
      });
      return {
        state: "failed",
        message: messageOf(error),
        nextStep: `Could not reach ${hostOf(url)}. Check the endpoint URL and your network, then retry.`,
        testedAt,
      };
    }

    return this.classify(response.status, testedAt);
  }

  // --- URL construction -----------------------------------------------------

  /**
   * The resource root, with any API path a user pasted removed.
   *
   * The Foundry portal's own samples hand out `https://‹resource›.services.ai
   * .azure.com/openai/v1` as "the endpoint", so that is what gets pasted into
   * the Add-a-model form. Left alone it produced
   * `…/openai/v1/openai/deployments/…`, which is nothing at all. Both forms are
   * accepted here and reduced to the root each route then builds from.
   */
  private baseUrl(entry: FoundryModelEntry): string {
    return trimSlash(entry.endpoint).replace(/\/openai(\/v1)?$/i, "");
  }

  private deploymentUrl(entry: FoundryModelEntry, path: string): string {
    const base = this.baseUrl(entry);
    const deployment = encodeURIComponent(entry.deploymentName);
    // The metadata probe (empty path) targets the deployment itself rather than
    // an inference route, so a bad name yields a clean 404.
    const suffix = path ? `/${path}` : "";
    return `${base}/openai/deployments/${deployment}${suffix}?api-version=${encodeURIComponent(entry.apiVersion)}`;
  }

  /**
   * The OpenAI-compatible v1 surface. No `api-version`, and the deployment is
   * named in the body rather than the path.
   */
  private v1Url(entry: FoundryModelEntry, path: string): string {
    return `${this.baseUrl(entry)}/openai/v1/${path}`;
  }

  /** Read one v1 model's metadata without generating an image. */
  private modelUrl(entry: FoundryModelEntry): string {
    return this.v1Url(entry, `models/${encodeURIComponent(entry.deploymentName)}`);
  }

  // --- transport ------------------------------------------------------------

  private authHeaders(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
  }

  private async sendJson(
    url: string,
    token: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.send(
      url,
      {
        method: "POST",
        headers: { ...this.authHeaders(token), "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      },
      timeoutMs,
    );
  }

  private async sendForm(
    url: string,
    token: string,
    form: FormData,
    timeoutMs: number,
  ): Promise<Response> {
    // The content-type boundary is set by fetch from the FormData; setting it by
    // hand would corrupt the multipart body.
    return this.send(url, { method: "POST", headers: this.authHeaders(token), body: form }, timeoutMs);
  }

  /**
   * One request with timeout and transient-only retry. 429 and 5xx are thrown as
   * {@link TransientHttpError} so `withRetry` retries them; 4xx and 2xx are
   * returned to the caller to interpret. Nothing here logs the token or the URL.
   */
  private async send(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    return withRetry(RETRY, async () => {
      const response = await withTimeout(
        timeoutMs,
        () => this.fetchImpl(url, init),
        `foundry ${hostOf(url)}`,
      );
      if (response.status === 429 || response.status >= 500) {
        throw new TransientHttpError(response);
      }
      return response;
    });
  }

  private async readJson(response: Response, url: string): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      this.deps.logger.debug("foundry.readJson non-JSON body", {
        host: hostOf(url),
        status: response.status,
      });
      void error;
      return {};
    }
  }

  /**
   * Turn a non-2xx response on a real (non-probe) call into an actionable error.
   *
   * A 4xx is deterministic, so it is raised as a {@link NonRetryableError}: a
   * higher layer that wraps this in its own retry must not spend three more
   * round-trips on a permission or naming problem that cannot change.
   */
  private assertOk(response: Response, url: string, action: string): void {
    if (response.ok) return;
    const classified = this.classify(response.status, new Date().toISOString());
    this.deps.logger.warn("foundry call failed", { host: hostOf(url), status: response.status });
    const detail = `Failed to ${action}: ${classified.message} ${classified.nextStep}`;
    throw response.status < 500 ? new NonRetryableError(detail) : new Error(detail);
  }

  /** Map an HTTP status onto the Test control's state vocabulary and its next step. */
  private classify(status: number, testedAt: string): ModelTestResult {
    let state: ModelTestState;
    let message: string;
    let nextStep: string;

    if (status >= 200 && status < 300) {
      state = "reachable";
      message = "The endpoint responded and the identity is authorized.";
      nextStep = "Ready to use.";
    } else if (status === 401 || status === 403) {
      state = "unauthorized";
      message = `Authorized identity was rejected (HTTP ${status}).`;
      nextStep =
        "Ask for the Cognitive Services User role on this resource, or switch tenant in Connections & access.";
    } else if (status === 404) {
      state = "not_found";
      message = "The endpoint answered but the deployment or agent was not found (HTTP 404).";
      nextStep =
        "Check the deployment name or agent id and the endpoint URL in Control Center → Models.";
    } else {
      state = "failed";
      message = `The endpoint returned an unexpected status (HTTP ${status}).`;
      nextStep = "Retry; if it persists, check the endpoint and API version in Control Center → Models.";
    }

    return { state, message, nextStep, testedAt };
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

const hostOf = (url: string): string => sharedHostOf(url, "unknown-host");
