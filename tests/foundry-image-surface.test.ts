import { describe, expect, it } from "vitest";
import type { FoundryModelEntry, ImageRequest } from "@iq/shared";
import { FoundryClient } from "../packages/core/src/models/foundry-client.js";
import { createLogger } from "../packages/core/src/util/logger.js";

/**
 * Which URL a Foundry call is actually dialled at.
 *
 * The gpt-image deployments are served on the OpenAI-compatible `/openai/v1`
 * surface, with the deployment named in the body; the versioned
 * `/openai/deployments/{name}` route the chat calls use answers 404 for them.
 * Getting that wrong produced "the deployment returned no inline image data"
 * for a deployment that was perfectly healthy, so both routes are pinned here.
 *
 * The endpoint normalisation is pinned for the same reason: the Foundry portal
 * hands out `https://‹resource›.services.ai.azure.com/openai/v1` as "the
 * endpoint", so that is what gets pasted into the Add-a-model form.
 */

const entry = (endpoint: string): FoundryModelEntry =>
  ({
    id: "img1",
    displayName: "Foundry Image",
    endpoint,
    deploymentName: "gpt-image-2",
    apiVersion: "2024-10-21",
    capabilities: ["image"],
    projectIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastTest: null,
  }) as FoundryModelEntry;

const generate: ImageRequest = {
  modelId: "foundry:img1",
  operation: "generate",
  prompt: "a cute baby polar bear",
  size: "1024x1024",
  quality: "auto",
  count: 1,
  sourcePath: "",
  maskPath: "",
  projectId: "ws-1",
} as ImageRequest;

function client(): { client: FoundryClient; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const instance = new FoundryClient({
    logger: createLogger("error"),
    token: async () => "fake-token",
    fetchImpl: (async (url: string, init?: RequestInit) => {
      const raw = init?.body;
      calls.push({
        url: String(url),
        body: typeof raw === "string" ? JSON.parse(raw) : raw,
      });
      return new Response(JSON.stringify({ data: [{ b64_json: "AAAA" }] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { client: instance, calls };
}

describe("FoundryClient image surface", () => {
  it("probes an image deployment through v1 model metadata", async () => {
    const { client: instance, calls } = client();
    await instance.probe(entry("https://demo.services.ai.azure.com/openai/v1"));

    expect(calls[0]?.url).toBe("https://demo.services.ai.azure.com/openai/v1/models/gpt-image-2");
  });

  it("generates on /openai/v1 with the deployment in the body", async () => {
    const { client: instance, calls } = client();
    await instance.images(entry("https://demo.services.ai.azure.com"), generate, {
      correlationId: "cid",
    });

    expect(calls[0]?.url).toBe("https://demo.services.ai.azure.com/openai/v1/images/generations");
    // No api-version: the v1 surface is unversioned, and the deployment is a
    // field rather than a path segment.
    expect(calls[0]?.url).not.toContain("api-version");
    expect(calls[0]?.body).toMatchObject({ model: "gpt-image-2", prompt: generate.prompt, n: 1 });
  });

  it("accepts an endpoint pasted with the API path already on it", async () => {
    for (const pasted of [
      "https://demo.services.ai.azure.com/openai/v1",
      "https://demo.services.ai.azure.com/openai/v1/",
      "https://demo.services.ai.azure.com/openai",
      "https://demo.services.ai.azure.com/",
    ]) {
      const { client: instance, calls } = client();
      await instance.images(entry(pasted), generate, { correlationId: "cid" });
      expect(calls[0]?.url, pasted).toBe(
        "https://demo.services.ai.azure.com/openai/v1/images/generations",
      );
    }
  });

  it("leaves chat on the versioned deployment route", async () => {
    const { client: instance, calls } = client();
    await instance.chat(
      entry("https://demo.services.ai.azure.com/openai/v1"),
      [{ role: "user", content: "hello" }],
      { correlationId: "cid" },
    );

    expect(calls[0]?.url).toBe(
      "https://demo.services.ai.azure.com/openai/deployments/gpt-image-2/chat/completions?api-version=2024-10-21",
    );
  });
});
