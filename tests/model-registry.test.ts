import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FoundryModelInput } from "@iq/shared";
import { AuditLog } from "../packages/core/src/audit/audit-log.js";
import { createLogger } from "../packages/core/src/util/logger.js";
import { ensureAppPaths, resolveAppPaths, type AppPaths } from "../packages/core/src/config/paths.js";
import { FoundryClient } from "../packages/core/src/models/foundry-client.js";
import { ModelRegistry, type CopilotModel } from "../packages/core/src/models/registry.js";

/**
 * The model registry is the one store three surfaces read, so these tests pin
 * the properties those surfaces depend on: layered defaults resolve in the right
 * order, a role only ever resolves to a model that can do the job, the Test
 * control's states are classified from the HTTP status honestly, a broken
 * Copilot catalogue never hides the Foundry entries, and a tenant change wipes
 * every prior verification.
 */

let root: string;
let paths: AppPaths;
let fetchStatus = 200;
let copilot: () => Promise<CopilotModel[]>;

const foundryInput = (over: Partial<FoundryModelInput> = {}): FoundryModelInput =>
  ({
    id: "img1",
    displayName: "Foundry Image",
    endpoint: "https://demo.openai.azure.com",
    deploymentName: "img-deploy",
    apiVersion: "2024-10-21",
    capabilities: ["image"],
    projectIds: [],
    ...over,
  }) as FoundryModelInput;

function makeRegistry(): ModelRegistry {
  const logger = createLogger("error");
  const audit = new AuditLog(paths);
  const client = new FoundryClient({
    logger,
    token: async () => "fake-token",
    fetchImpl: (async () => new Response(JSON.stringify({}), { status: fetchStatus })) as typeof fetch,
  });
  return new ModelRegistry({
    paths,
    logger,
    audit,
    client,
    copilotModels: () => copilot(),
    correlationId: () => "corr-test",
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "iq-models-"));
  paths = resolveAppPaths(root);
  await ensureAppPaths(paths);
  fetchStatus = 200;
  copilot = async () => [
    { id: "gpt-chat", name: "GPT Chat", available: true, capabilities: ["chat", "reasoning"] },
  ];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ModelRegistry catalogue", () => {
  it("merges advertised Copilot models with configured Foundry entries", async () => {
    const registry = makeRegistry();
    await registry.upsert(foundryInput());

    const catalog = await registry.catalog();
    const ids = catalog.entries.map((entry) => entry.id);
    expect(ids).toContain("copilot:gpt-chat");
    expect(ids).toContain("foundry:img1");
    // Copilot entries are advertised, not editable; Foundry entries are.
    expect(catalog.entries.find((e) => e.id === "copilot:gpt-chat")?.editable).toBe(false);
    expect(catalog.entries.find((e) => e.id === "foundry:img1")?.editable).toBe(true);
    // The endpoint is exposed host-only, never the full URL.
    expect(catalog.entries.find((e) => e.id === "foundry:img1")?.endpointHost).toBe(
      "demo.openai.azure.com",
    );
    expect(catalog.copilotError).toBeNull();
  });

  it("still returns Foundry entries when the Copilot catalogue is broken", async () => {
    copilot = async () => {
      throw new Error("no Copilot entitlement");
    };
    const registry = makeRegistry();
    await registry.upsert(foundryInput());

    const catalog = await registry.catalog();
    expect(catalog.entries.map((entry) => entry.id)).toEqual(["foundry:img1"]);
    expect(catalog.copilotError).toMatch(/entitlement/);
  });

  it("rejects a deployment entry with no deployment name, naming the fix", async () => {
    const registry = makeRegistry();
    await expect(
      registry.upsert(foundryInput({ deploymentName: "" })),
    ).rejects.toThrow(/deployment name/i);
  });
});

describe("ModelRegistry.resolve (layered defaults)", () => {
  it("filters candidates by the capability a role requires", async () => {
    const registry = makeRegistry();
    await registry.upsert(foundryInput()); // image-only

    // Only the Foundry entry advertises `image`; Copilot advertises chat only.
    const image = await registry.resolve("image");
    expect(image?.id).toBe("foundry:img1");

    // Chat falls back to the first eligible entry — the advertised Copilot one.
    const chat = await registry.resolve("chat");
    expect(chat?.id).toBe("copilot:gpt-chat");
  });

  it("returns null for a role no model can satisfy", async () => {
    copilot = async () => [];
    const registry = makeRegistry();
    await registry.upsert(foundryInput()); // image-only, so no chat model exists
    expect(await registry.resolve("chat")).toBeNull();
  });

  it("prefers a role default over the first-eligible fallback", async () => {
    const registry = makeRegistry();
    await registry.upsert(
      foundryInput({ id: "chatA", displayName: "Chat A", capabilities: ["chat"] }),
    );
    await registry.setDefault("chat", "foundry:chatA");

    expect((await registry.resolve("chat"))?.id).toBe("foundry:chatA");
  });

  it("prefers a per-project override over the role default", async () => {
    const registry = makeRegistry();
    await registry.upsert(
      foundryInput({ id: "chatA", displayName: "Chat A", capabilities: ["chat"] }),
    );
    await registry.upsert(
      foundryInput({ id: "chatB", displayName: "Chat B", capabilities: ["chat"] }),
    );
    await registry.setDefault("chat", "foundry:chatA");
    await registry.setDefault("chat", "foundry:chatB", "ws-1");

    expect((await registry.resolve("chat"))?.id).toBe("foundry:chatA");
    expect((await registry.resolve("chat", "ws-1"))?.id).toBe("foundry:chatB");
  });

  it("skips a stale default that no longer advertises the capability", async () => {
    const registry = makeRegistry();
    // The default points at an image-only entry, which cannot serve `chat`.
    await registry.upsert(foundryInput());
    await registry.setDefault("chat", "foundry:img1");

    // Falls through to the eligible Copilot chat model rather than returning it.
    expect((await registry.resolve("chat"))?.id).toBe("copilot:gpt-chat");
  });
});

describe("ModelRegistry.test (state classification)", () => {
  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not_found"],
    [500, "failed"],
    [200, "reachable"],
  ])("maps HTTP %i to %s", async (status, expected) => {
    fetchStatus = status;
    const registry = makeRegistry();
    await registry.upsert(foundryInput());

    const result = await registry.test("foundry:img1");
    expect(result.state).toBe(expected);
    expect(result.nextStep.length).toBeGreaterThan(0);
    expect(result.testedAt).toMatch(/T/);
  });

  it("records the test result on the entry, then wipes it on a tenant change", async () => {
    const registry = makeRegistry();
    await registry.upsert(foundryInput());

    await registry.test("foundry:img1");
    expect((await registry.entry("foundry:img1"))?.lastTest?.state).toBe("reachable");

    await registry.invalidateTests("tenant changed");
    expect((await registry.entry("foundry:img1"))?.lastTest).toBeNull();
    const catalog = await registry.catalog();
    expect(catalog.entries.find((e) => e.id === "foundry:img1")?.lastTest).toBeNull();
  });
});
