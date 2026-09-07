import { dialog } from "electron";
import { type MemoryStatus } from "@iq/shared";
import { ok, type IpcContext, type IpcHandlersFor } from "./context.js";

/** MCP servers, and publishing My IQ over MCP. */
export function mcpHandlers({
  app,
  requireAccount,
}: IpcContext): IpcHandlersFor<"mcp"> & IpcHandlersFor<"myiq"> {
  return {
    "mcp:list": async () => app.mcp.list(),
    "mcp:upsert": async (input) =>
      app.mcp.upsert(input, requireAccount("sign in to configure an MCP server"), app.correlationId()),
    "mcp:remove": async (input) =>
      ok(
        app.mcp.remove(
          input.id,
          requireAccount("sign in to remove an MCP server"),
          app.correlationId(),
        ),
      ),
    "mcp:inspect": async (input) =>
      app.mcp.inspect(
        input.id,
        requireAccount("sign in to inspect an MCP server"),
        app.correlationId(),
      ),
    "mcp:approveTools": async (input) =>
      app.mcp.setApprovedTools(
        input.id,
        input.tools,
        requireAccount("sign in to approve MCP tools"),
        app.correlationId(),
      ),
    "mcp:setEnabled": async (input) =>
      app.mcp.setEnabled(
        input.id,
        input.enabled,
        requireAccount("sign in to enable an MCP server"),
        app.correlationId(),
      ),

    "myiq:status": async () => app.myiq.status(),
    /**
     * Requires an account because it writes a durable artifact that another
     * program will read. Status does not: it reports whether a file exists and
     * how a client would reach it, which is the same question the surface asks
     * on every render.
     */
    "myiq:publish": async (input) =>
      app.myiq.publish(
        input,
        requireAccount("sign in to publish the My IQ MCP server"),
        app.correlationId(),
      ),
  };
}

/** Memory: what the app is allowed to remember about how you work. */
export function memoryHandlers({ app }: IpcContext): IpcHandlersFor<"memory"> {
  return {
    "memory:list": async (input) =>
      app.memories.list({
        ...(input.status ? { status: input.status as MemoryStatus } : {}),
        ...(input.subject ? { subject: input.subject } : {}),
      }),
    // Approval is what licenses a memory to shape future behaviour, so it must
    // be attributable to a person, exactly as skill approval is.
    "memory:approve": async (input) => {
      const account = app.entra.currentAccount();
      if (!account) throw new Error("sign in before approving a memory");
      return app.memories.approve(
        input.id,
        { oid: account.oid, tenantId: account.tenantId },
        app.correlationId(),
      );
    },
    "memory:reject": async (input) => {
      const account = app.entra.currentAccount();
      if (!account) throw new Error("sign in before rejecting a memory");
      return app.memories.reject(
        input.id,
        { oid: account.oid, tenantId: account.tenantId },
        app.correlationId(),
      );
    },
    /**
     * Edit a memory's wording.
     *
     * No sign-in requirement, unlike approve and reject: correcting a typo is
     * not a decision that licenses anything. The editor is passed when there is
     * one so the audit record names them, and an edit to an approved memory
     * returns it to review inside the store — where that rule cannot be skipped
     * by a second caller.
     */
    "memory:update": async (input) => {
      const account = app.entra.currentAccount();
      return app.memories.update(
        input,
        app.correlationId(),
        account ? { oid: account.oid, tenantId: account.tenantId } : null,
      );
    },
    "memory:delete": async (input) => ok(app.memories.delete(input.id, app.correlationId())),
    "memory:derivations": async () => app.memories.derivations(),
    "memory:derive": async () => app.curator.run(app.correlationId()),
  };
}

/** Scheduled work, and the plans the coordinator runs. */
export function jobsHandlers({
  app,
}: IpcContext): IpcHandlersFor<"jobs"> & IpcHandlersFor<"orchestration"> {
  return {
    "jobs:list": async () => app.scheduler.listJobs(),
    "jobs:create": async (input) => app.scheduler.createJob(input),
    "jobs:update": async (input) => {
      const { id, ...patch } = input;
      return app.scheduler.updateJob(id, patch);
    },
    "jobs:setEnabled": async (input) => app.scheduler.setEnabled(input.id, input.enabled),
    "jobs:runNow": async (input) => app.scheduler.runNow(input.id),
    "jobs:delete": async (input) => ok(app.scheduler.deleteJob(input.id)),
    "jobs:runs": async (input) =>
      (await app.scheduler.listRuns(input.jobId)).slice(0, input.limit),

    "orchestration:plans": async () => app.coordinator.listPlans(),
    "orchestration:plan": async (input) => app.coordinator.getPlan(input.planId),
    "orchestration:cancel": async (input) =>
      app.coordinator.cancelPlan(input.planId, "cancelled by user"),
    "orchestration:resolveGate": async (input) => {
      const account = app.entra.currentAccount();
      const plans = await app.coordinator.listPlans();
      const owner = plans.find((doc) => doc.gates.some((gate) => gate.id === input.gateId));
      if (!owner) throw new Error(`unknown gate ${input.gateId}`);
      return app.coordinator.resolveGate(
        owner.plan.id,
        input.gateId,
        input.approved ? "approved" : "rejected",
        account?.oid ?? "unknown",
      );
    },
  };
}

/** The knowledge graph and the vault it is built from. */
export function knowledgeHandlers({
  app,
  knowledgeEnabled,
}: IpcContext): IpcHandlersFor<"knowledge"> {
  return {
    "knowledge:graph": async () => {
      knowledgeEnabled();
      const graph = await app.knowledge.ensureIndexed(app.correlationId());
      return { graph, summary: app.knowledge.summary(graph) };
    },
    "knowledge:ingest": async () => {
      knowledgeEnabled();
      // Generate, then index. The order is the whole point: the graph is a
      // consequence of the notes, and the notes are a consequence of the
      // sources, so indexing before generating would describe the last run.
      const result = await app.knowledgeVault.ingest();
      const summary = await app.knowledge.reindex(app.correlationId());
      const vault = await app.knowledgeVault.current();
      return { ...result, summary, vault };
    },
    "knowledge:addSources": async () => {
      knowledgeEnabled();
      const chosen = await dialog.showOpenDialog({
        title: "Add source files to the knowledge vault",
        properties: ["openFile", "multiSelections"],
      });
      if (chosen.canceled) {
        return { added: 0, skipped: 0, vault: await app.knowledgeVault.current() };
      }
      const result = await app.knowledgeVault.addSources(chosen.filePaths);
      return { ...result, vault: await app.knowledgeVault.current() };
    },
    "knowledge:sources": async () => {
      knowledgeEnabled();
      return app.knowledgeVault.listSources();
    },
    "knowledge:removeSource": async (input) => {
      knowledgeEnabled();
      await app.knowledgeVault.removeSource(input.path);
      return { sources: await app.knowledgeVault.listSources() };
    },
    "knowledge:search": async (input) => {
      knowledgeEnabled();
      return app.knowledge.search(input.query, input.limit, app.correlationId());
    },
    "knowledge:node": async (input) => {
      knowledgeEnabled();
      const detail = await app.knowledge.node(input.id, app.correlationId());
      if (!detail) throw new Error(`unknown node ${input.id}`);
      return detail;
    },
    "knowledge:vault": async () => {
      knowledgeEnabled();
      return app.knowledgeVault.current();
    },
    "knowledge:chooseVault": async () => {
      knowledgeEnabled();
      const chosen = await dialog.showOpenDialog({
        title: "Choose a knowledge vault folder",
        properties: ["openDirectory"],
      });
      return { directory: chosen.canceled ? "" : (chosen.filePaths[0] ?? "") };
    },
    "knowledge:setVault": async (input) => {
      knowledgeEnabled();
      const vault = await app.knowledgeVault.set(input.directory);
      // The cached graph describes the previous root, so it is stale the moment
      // the vault changes; rebuild before returning rather than leaving the UI
      // showing an index of a directory it no longer points at.
      const summary = await app.knowledge.reindex(app.correlationId());
      return { vault, summary };
    },
  };
}

/** Projects, and the navigator that reads inside the bound one. */
export function projectsHandlers({
  app,
  reveal,
}: IpcContext): IpcHandlersFor<"projects"> & IpcHandlersFor<"project"> {
  return {
    "projects:list": async () => ({
      projects: app.projects.list(),
      activeId: app.projects.active()?.id ?? null,
    }),
    "projects:create": async (input) =>
      app.projects.create({
        name: input.name,
        ...(input.directory ? { directory: input.directory } : {}),
      }),
    "projects:choose": async () => {
      const chosen = await dialog.showOpenDialog({
        title: "Choose a project folder",
        properties: ["openDirectory", "createDirectory"],
      });
      return { directory: chosen.canceled ? "" : (chosen.filePaths[0] ?? "") };
    },
    "projects:open": async (input) => ({ project: await app.projects.open(input.directory) }),
    "projects:bind": async (input) => ({ project: await app.projects.bind(input.projectId) }),
    "projects:remove": async (input) => ok(app.projects.remove(input.projectId)),

    "project:list": async (input) => app.project.list(input.path),
    "project:read": async (input) => app.project.read(input.path),
    /**
     * Show a project file in the OS file manager.
     *
     * `locate` is what makes this safe: the renderer sends a project-relative
     * path and core proves it resolves inside the bound root before any of it
     * reaches `shell`.
     */
    "project:reveal": async (input) => ok(reveal(app.project.locate(input.path))),
  };
}
