import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAppPaths, resolveAppPaths } from "../packages/core/src/config/paths.js";
import { SessionRepo } from "../packages/core/src/runtime/sessions/fs-repo.js";
import { SessionsService, type SessionsDeps } from "../packages/core/src/runtime/sessions/sessions.js";
import { TurnRepo } from "../packages/core/src/runtime/turns/fs-repo.js";

/**
 * The composer's model picker offers catalogue ids (`copilot:gpt-5.6-terra`).
 * The Copilot SDK only knows the bare ref, and answers an id it does not
 * recognise with `Request session.create failed with message: Model "…" is not
 * available.` — which is what every turn sent with an override used to do.
 */
describe("SessionsService model resolution", () => {
  let root: string | null = null;

  const serviceWith = async (
    models: string[],
    resolveChatModel?: () => Promise<string | null>,
  ): Promise<SessionsService> => {
    root = mkdtempSync(join(tmpdir(), "iq-session-model-"));
    const paths = resolveAppPaths(root);
    await ensureAppPaths(paths);

    return new SessionsService({
      paths,
      sessionRepo: new SessionRepo(paths),
      turnRepo: new TurnRepo(paths),
      runtime: {
        primeSequence: () => undefined,
        ensureSession: async (spec: { model: string }) => {
          models.push(spec.model);
          return {};
        },
        runTurn: async () => undefined,
      },
      toolRegistry: { families: () => [] },
      skills: { resolveSessionSkillConfig: async () => ({ directories: [], disabled: [] }) },
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      publish: () => undefined,
      publishIndex: () => undefined,
      defaultModel: "role-default",
      ...(resolveChatModel ? { resolveChatModel } : {}),
    } as unknown as SessionsDeps);
  };

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("sends the SDK the bare ref, never the catalogue id", async () => {
    const models: string[] = [];
    const service = await serviceWith(models);

    const sessionId = await service.create();
    const turnId = await service.sendMessage({
      sessionId,
      content: "hello",
      modelId: "copilot:gpt-5.6-terra",
    });
    await service.awaitTurn(turnId);

    expect(models).toEqual(["gpt-5.6-terra"]);
  });

  it("falls back to the role default rather than handing the SDK a Foundry id", async () => {
    const models: string[] = [];
    const service = await serviceWith(models, async () => "copilot-default");

    const sessionId = await service.create();
    const turnId = await service.sendMessage({
      sessionId,
      content: "hello",
      modelId: "foundry:my-deployment",
    });
    await service.awaitTurn(turnId);

    expect(models).toEqual(["copilot-default"]);
  });

  it("passes a bare ref through unchanged", async () => {
    const models: string[] = [];
    const service = await serviceWith(models);

    const sessionId = await service.create();
    const turnId = await service.sendMessage({
      sessionId,
      content: "hello",
      modelId: "claude-sonnet-4.5",
    });
    await service.awaitTurn(turnId);

    expect(models).toEqual(["claude-sonnet-4.5"]);
  });
});
