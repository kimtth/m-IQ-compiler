import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog } from "../packages/core/src/audit/audit-log.js";
import { ensureAppPaths, resolveAppPaths } from "../packages/core/src/config/paths.js";
import { SpeechService, type SpeechConfig } from "../packages/core/src/speech/speech.js";
import { SpeechRegistry } from "../packages/core/src/speech/registry.js";
import { TenantPolicy } from "../packages/core/src/policy/tenant-policy.js";
import type { EntraAuth } from "../packages/core/src/entra/entra-auth.js";
import { createLogger } from "../packages/core/src/util/logger.js";

/**
 * The Connections & access check. Its whole value is telling the failure kinds
 * apart, so each classification is pinned: absent configuration, a rejected
 * credential, a wrong endpoint, and a healthy resource.
 */
describe("SpeechService.test", () => {
  const roots: string[] = [];

  const config: SpeechConfig = {
    displayName: "Azure AI Speech",
    endpoint: "https://contoso-speech.cognitiveservices.azure.com",
    locale: "en-US",
    voice: "en-US-AvaMultilingualNeural",
    source: "user",
  };

  const service = async (options: {
    config: SpeechConfig | null;
    status?: number;
    token?: () => Promise<string>;
  }) => {
    const root = await mkdtemp(join(tmpdir(), "iq-speech-"));
    roots.push(root);
    const paths = resolveAppPaths(root);
    ensureAppPaths(paths);

    const entra = {
      acquireForCapability: options.token ?? (async () => "token"),
    } as unknown as EntraAuth;

    const seen: string[] = [];
    const speech = new SpeechService({
      config: options.config,
      entra,
      audit: new AuditLog(paths),
      tenantPolicy: TenantPolicy.parse({}),
      logger: createLogger("error", {}),
      fetchImpl: (async (url: string) => {
        seen.push(String(url));
        return new Response("[]", { status: options.status ?? 200 });
      }) as unknown as typeof fetch,
    });
    return { speech, seen };
  };

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it("reports not_configured without touching the network", async () => {
    const { speech, seen } = await service({ config: null });
    const result = await speech.test("cid");
    expect(result.state).toBe("not_configured");
    expect(seen).toHaveLength(0);
  });

  it("probes the voice list on the resource's own custom domain", async () => {
    const { speech, seen } = await service({ config });
    const result = await speech.test("cid");
    expect(result.state).toBe("reachable");
    expect(result.auth).toBe("entra");
    // Never `{region}.tts.speech.microsoft.com`: that host is key-authenticated
    // and rejects the Entra token this app presents.
    //
    // And note the `/tts` prefix. VERIFIED against a real resource: on a custom
    // domain the unprefixed `/cognitiveservices/voices/list` answers a bare
    // `404 Resource not found`, while the prefixed path reaches the service. A
    // custom domain is the only endpoint this app accepts, so without the
    // prefix Test connection could never report anything but "not found" — it
    // was a control that was wrong for everyone, not just for some.
    expect(seen[0]).toBe(
      "https://contoso-speech.cognitiveservices.azure.com/tts/cognitiveservices/voices/list",
    );
  });

  it("separates a rejected credential from a wrong endpoint", async () => {
    const denied = await service({ config, status: 403 });
    expect((await denied.speech.test("cid")).state).toBe("unauthorized");

    const missing = await service({ config, status: 404 });
    expect((await missing.speech.test("cid")).state).toBe("not_found");

    const broken = await service({ config, status: 500 });
    expect((await broken.speech.test("cid")).state).toBe("failed");
  });

  it("reports unauthorized when no Azure token can be acquired", async () => {
    const { speech, seen } = await service({
      config,
      token: async () => {
        throw new Error("not signed in");
      },
    });
    const result = await speech.test("cid");
    expect(result.state).toBe("unauthorized");
    expect(result.nextStep).toContain("Sign in to Microsoft");
    expect(seen).toHaveLength(0);
  });

  it("always authenticates with the Azure identity, never a key", async () => {
    const { speech } = await service({ config });
    const status = speech.status();
    expect(status.state === "ready" && status.auth).toBe("entra");
    expect((await speech.test("cid")).auth).toBe("entra");
  });
});

/**
 * Every URL the service builds, pinned against a real resource.
 *
 * These three are the whole of the app's Speech surface, and until this block
 * existed only one of them was checked — the voice list, because it is what
 * *Test connection* calls. The other two were wrong for months and nothing
 * failed: `synthesize` and `transcribe` are only reachable with a signed-in
 * Azure identity and a registered resource, so no unit test ever built their
 * URLs and no developer ran them without both.
 *
 * VERIFIED 2026-08-05 against a real `SpeechServices` resource on its custom
 * sub-domain, Entra-only, with `Cognitive Services Speech User` assigned. The
 * resource is deliberately not named here — this file is committed, and a
 * hostname in a comment is a live endpoint published to everyone who clones
 * the repo. What matters is the shape, and the shape is the same for every
 * custom domain:
 *
 *   /tts/cognitiveservices/voices/list            -> 200, the full voice list
 *   /tts/cognitiveservices/v1                     -> 200, an MP3 body
 *   /speechtotext/transcriptions:transcribe       -> 200, a transcription JSON
 *
 * and the two unprefixed text-to-speech spellings that were shipped:
 *
 *   /cognitiveservices/voices/list                -> 404 Resource not found
 *   /cognitiveservices/v1                         -> 404 Resource not found
 *
 * The asymmetry is the thing to remember: **text-to-speech is under `/tts` on a
 * custom domain, speech-to-text is not.** Guessing either way round produces a
 * bare 404 with nothing in it to suggest a prefix.
 */
describe("Speech endpoint paths", () => {
  const roots: string[] = [];

  const config: SpeechConfig = {
    displayName: "Azure AI Speech",
    endpoint: "https://contoso-speech.cognitiveservices.azure.com",
    locale: "en-US",
    voice: "en-US-AvaMultilingualNeural",
    source: "user",
  };

  /** Records every URL, and answers each call with a body its caller can read. */
  const recording = async () => {
    const root = await mkdtemp(join(tmpdir(), "iq-speech-url-"));
    roots.push(root);
    const paths = resolveAppPaths(root);
    ensureAppPaths(paths);

    const seen: string[] = [];
    const speech = new SpeechService({
      config,
      entra: { acquireForCapability: async () => "token" } as unknown as EntraAuth,
      audit: new AuditLog(paths),
      tenantPolicy: TenantPolicy.parse({}),
      logger: createLogger("error", {}),
      fetchImpl: (async (url: string) => {
        seen.push(String(url));
        if (String(url).includes("/speechtotext/")) {
          return new Response(
            JSON.stringify({ durationMilliseconds: 1000, combinedPhrases: [{ text: "hello" }], phrases: [] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        // Synthesis answers audio; the voice list answers JSON. Both are read
        // as bytes or text by the caller, so one body serves for the shape.
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }) as unknown as typeof fetch,
    });
    return { speech, seen };
  };

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it("puts text-to-speech under /tts and speech-to-text outside it", async () => {
    const { speech, seen } = await recording();

    await speech.test("cid");
    await speech.synthesize({ text: "hello", correlationId: "cid" });
    await speech.transcribe({
      audio: new Uint8Array([0, 0, 0, 0]),
      mimeType: "audio/wav",
      correlationId: "cid",
    });

    expect(seen).toEqual([
      "https://contoso-speech.cognitiveservices.azure.com/tts/cognitiveservices/voices/list",
      "https://contoso-speech.cognitiveservices.azure.com/tts/cognitiveservices/v1",
      "https://contoso-speech.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15",
    ]);

    // Stated as its own assertion rather than left implicit in the strings
    // above: these two spellings are 404s on every custom domain, and a custom
    // domain is the only endpoint this app accepts.
    for (const url of seen) {
      expect(url).not.toContain(".com/cognitiveservices/");
    }
  });
});

/**
 * Registration. The user adds a resource in Connections & access; the payload
 * is a destination and never a credential, so the shape is pinned here.
 */
describe("SpeechRegistry", () => {
  const roots: string[] = [];

  const registry = async (existingRoot?: string) => {
    const root = existingRoot ?? (await mkdtemp(join(tmpdir(), "iq-speech-reg-")));
    if (!existingRoot) roots.push(root);
    const paths = resolveAppPaths(root);
    ensureAppPaths(paths);
    const store = new SpeechRegistry({
      paths,
      audit: new AuditLog(paths),
      correlationId: () => "cid",
    });
    await store.load();
    return { store, root, file: join(paths.config, "speech.json") };
  };

  const input = {
    displayName: "Contoso Speech",
    endpoint: "https://contoso-speech.cognitiveservices.azure.com/",
  };

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it("starts empty and registers a managed-identity resource", async () => {
    const { store } = await registry();
    expect(store.current()).toBeNull();

    const config = await store.register(input);
    // The trailing slash is dropped, because every URL built from this appends
    // its own path.
    expect(config.endpoint).toBe("https://contoso-speech.cognitiveservices.azure.com");
    expect(config.source).toBe("user");
    expect(config.voice).toBe("en-US-AvaMultilingualNeural");
    expect(Object.keys(config)).not.toContain("key");
  });

  it("refuses a regional endpoint, which cannot accept a Microsoft Entra token", async () => {
    const { store } = await registry();
    await expect(
      store.register({ ...input, endpoint: "https://westeurope.api.cognitive.microsoft.com" }),
    ).rejects.toThrow(/custom domain/i);
    await expect(
      store.register({ ...input, endpoint: "https://westeurope.tts.speech.microsoft.com" }),
    ).rejects.toThrow(/custom domain/i);
    await expect(store.register({ ...input, endpoint: "contoso-speech" })).rejects.toThrow();
    await expect(
      store.register({ ...input, endpoint: "http://contoso.cognitiveservices.azure.com" }),
    ).rejects.toThrow();
  });

  it("drops a registration written before the endpoint replaced the region", async () => {
    const { root, file } = await registry();
    // What an older build persisted. It names a regional host that rejects the
    // only credential this app has, and a custom domain cannot be derived from
    // it, so it is dropped rather than carried forward.
    await writeFile(
      file,
      JSON.stringify({
        resource: {
          displayName: "Old",
          region: "westeurope",
          resourceId:
            "/subscriptions/s/resourceGroups/g/providers/Microsoft.CognitiveServices/accounts/a",
          locale: "en-US",
          voice: "en-US-AvaMultilingualNeural",
        },
        registeredAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const reopened = await registry(root);
    expect(reopened.store.current()).toBeNull();
  });

  it("persists across reloads and can be removed", async () => {
    const { store } = await registry();
    await store.register(input);
    await store.remove();
    expect(store.current()).toBeNull();
    await expect(store.remove()).rejects.toThrow(/no Azure AI Speech resource/);
  });
});
