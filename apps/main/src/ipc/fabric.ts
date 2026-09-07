import { ok, type IpcContext, type IpcHandlersFor } from "./context.js";

/** A fresh id for one filed Data Agent exchange. */
const exchangeId = (): string =>
  `dae_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Microsoft Fabric: the workspace connection and the runs against it. */
export function fabricHandlers({ app }: IpcContext): IpcHandlersFor<"fabric"> {
  return {
    "fabric:status": async () => app.fabricRegistry.status(),
    "fabric:save": async (input) => app.fabricRegistry.save(input),
    "fabric:remove": async () => ok(app.fabricRegistry.remove()),
    /**
     * The workspaces this identity can see.
     *
     * Read-only and unregistered: the picker has to work *before* a workspace
     * is saved, which is the whole point of it, so this cannot go through the
     * registered connection the way `fabric:test` does.
     */
    "fabric:workspaces": async () => app.fabricClient.listWorkspaces(app.correlationId()),
    /**
     * Test the connection.
     *
     * Doubles as the only way to learn the project's display name, which is
     * why the name is recorded here rather than only shown: a card that says
     * "Microsoft Fabric — 8f3c…" is a card nobody can tell apart from another.
     */
    "fabric:test": async () => {
      const connection = app.fabricRegistry.current();
      if (connection === null) throw new Error("no Fabric workspace is registered");
      const probed = await app.fabricClient.probe(connection, app.correlationId());
      await app.fabricRegistry.noteWorkspaceName(probed.name);
      return { name: probed.name, status: app.fabricRegistry.status() };
    },
    "fabric:items": async (input) => app.fabric.items(input.refresh),
    "fabric:skillPack": async () => app.fabric.skillPack(),
    "fabric:setSkillPackPath": async (input) => {
      await app.fabricRegistry.setSkillPackPath(input.path);
      return app.fabric.skillPack();
    },
    "fabric:candidates": async () => app.fabricContext.candidates(),
    "fabric:contextStatus": async () => app.fabricContext.readiness(),
    "fabric:prepareContext": async () => app.fabricContext.prepare(),
    "fabric:runs": async () => app.fabric.list(),
    "fabric:run": async (input) => app.fabric.run(input),
    "fabric:cancel": async () => {
      app.fabric.cancel();
      return { ok: true };
    },
    /**
     * Ask the connected Data Agent, and file the exchange.
     *
     * `sessionId` doubles as the conversation id. When it names a stored
     * conversation the question and the answer are appended to it; when it does
     * not — the connection test, or the ask box inside Co-create → Fabric —
     * nothing is filed and the call behaves as before. A failure is recorded
     * too, because "it could not answer that" is part of the transcript.
     */
    "fabric:ask": async (input) => {
      const baseUrl = app.fabricDataAgentRegistry.baseUrl();
      if (baseUrl === "") throw new Error("no Fabric Data Agent is connected");
      const askedAt = new Date().toISOString();
      try {
        const answer = await app.fabricDataAgent.ask({
          baseUrl,
          question: input.question,
          sessionId: input.sessionId,
          correlationId: app.correlationId(),
        });
        await app.dataAgentChats.append(input.sessionId, {
          id: exchangeId(),
          question: input.question,
          answer: answer.answer,
          trace: answer.trace,
          failed: false,
          askedAt,
        });
        return answer;
      } catch (problem) {
        await app.dataAgentChats.append(input.sessionId, {
          id: exchangeId(),
          question: input.question,
          answer: problem instanceof Error ? problem.message : String(problem),
          trace: [],
          failed: true,
          askedAt,
        });
        throw problem;
      }
    },
  };
}

/** The Fabric Data Agent connection, and the chats held with it. */
export function dataAgentHandlers({ app }: IpcContext): IpcHandlersFor<"dataAgent"> {
  return {
    "dataAgent:status": async () => app.fabricDataAgentRegistry.status(),
    "dataAgent:chats": async () => app.dataAgentChats.list(),
    "dataAgent:newChat": async () => app.dataAgentChats.start(),
    "dataAgent:deleteChat": async (input) => ok(app.dataAgentChats.delete(input.chatId)),
    "dataAgent:clearChats": async () => ok(app.dataAgentChats.clear()),
    "dataAgent:save": async (input) => app.fabricDataAgentRegistry.save(input),
    "dataAgent:remove": async () => ok(app.fabricDataAgentRegistry.remove()),
    /**
     * Reachability, asked as the smallest real question.
     *
     * There is no health endpoint on the Assistants surface, so the test is a
     * question the agent can answer trivially. That is deliberate: a probe that
     * only checked DNS would report "reachable" for an agent whose thread route
     * rejects the token, which is the failure people actually hit.
     */
    "dataAgent:test": async () => {
      const baseUrl = app.fabricDataAgentRegistry.baseUrl();
      if (baseUrl === "") throw new Error("no Fabric Data Agent is connected");
      const answer = await app.fabricDataAgent.ask({
        baseUrl,
        question: "Reply with the single word OK.",
        sessionId: `connection-test-${Date.now().toString(36)}`,
        correlationId: app.correlationId(),
      });
      return { ok: true, answer: answer.answer };
    },
  };
}

/** Governance: the audit trail, and the policy that governs everything above. */
export function governanceHandlers({
  app,
}: IpcContext): IpcHandlersFor<"audit"> & IpcHandlersFor<"policy"> {
  return {
    "audit:query": async (input) => app.audit.query(input),
    "policy:get": async () => ({
      source: app.tenantPolicy.source,
      policy: app.tenantPolicy.policy,
      tools: app.tools.list(),
      families: app.tools.families(),
    }),
  };
}
