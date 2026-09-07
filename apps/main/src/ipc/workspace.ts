import { dialog } from "electron";
import { modeOf } from "@iq/shared";
import { ok, type IpcContext, type IpcHandlersFor } from "./context.js";

/**
 * The worked examples.
 *
 * One hub, so the flag and the modules it governs can never disagree. Every
 * mutation pushes the whole status: the flag is read by the sign-in gate, by
 * Control Center and by four surfaces at once.
 */
export function samplesHandlers({ app, push }: IpcContext): IpcHandlersFor<"samples"> {
  return {
    "samples:status": async () => app.samples.status(),
    "samples:setEnabled": async (input) => {
      const status = await app.samples.setEnabled(input.enabled);
      push("samples:changed", status);
      return status;
    },
    "samples:load": async (input) => {
      const result = await app.samples.load(input.module);
      push("samples:changed", result.status);
      return result;
    },
    "samples:clear": async (input) => {
      const result = await app.samples.clear(input.module);
      push("samples:changed", result.status);
      return result;
    },
  };
}

/** Identity. */
export function authHandlers({ app }: IpcContext): IpcHandlersFor<"auth"> {
  return {
    "auth:status": async () => app.entra.getStatus(),
    "auth:signIn": async (input?) =>
      app.entra.signIn(app.correlationId(), input ? input.tenantId : undefined),
    "auth:signOut": async () => ok(app.entra.signOut(app.correlationId())),
    "auth:tenant": async () => ({ tenantId: app.entra.preferredTenantId() }),
    "auth:setTenant": async (input) => {
      app.entra.setPreferredTenantId(input.tenantId);
      return { tenantId: app.entra.preferredTenantId() };
    },
    "auth:copilotStatus": async () => app.runtime.authStatus(),
    /**
     * Tenants the account can reach, offered as a picker so switching never
     * costs the user a second paste of a GUID.
     */
    "auth:tenants": async () => app.entra.listTenants(),
    /**
     * A live tenant switch, distinct from `auth:setTenant`, which only records a
     * preference for the next sign-in. This re-runs the flow and invalidates
     * every Foundry entry bound to the previous tenant.
     */
    "auth:switchTenant": async (input) =>
      app.entra.switchTenant(input.tenantId, app.correlationId()),
    "auth:consent": async (input) => {
      // Acquiring a token for a capability is what triggers incremental
      // consent; we never ask for a scope before the feature needs it.
      await app.entra.acquireForCapability(
        input.capability as Parameters<typeof app.entra.acquireForCapability>[0],
        app.correlationId(),
      );
      return app.entra.getStatus();
    },
  };
}

/** Conversations. */
export function sessionsHandlers({ app, browser }: IpcContext): IpcHandlersFor<"sessions"> {
  return {
    "sessions:list": async () => app.sessions.list(),
    "sessions:create": async (input) => ({
      sessionId: await app.sessions.create({
        ...(input.title === undefined ? {} : { title: input.title }),
        // Stamped `chosen` by the service, never by the payload: the renderer
        // says *where*, and the privileged side says what kind of statement
        // that is. A place it cannot show is refused there.
        ...(input.place === undefined ? {} : { place: input.place }),
      }),
    }),
    "sessions:rename": async (input) => ok(app.sessions.rename(input.sessionId, input.title)),
    "sessions:delete": async (input) => ok(app.sessions.delete(input.sessionId)),
    "sessions:clear": async (input) => ok(app.sessions.clearHistory(input.sessionId)),
    /**
     * Sweep unreachable conversation data.
     *
     * Composed here because the debris spans two owners: the service knows
     * which conversations and turn logs nothing can reach, and the pane knows
     * which pages it remembers for conversations that are gone. The sweep runs
     * first, so the pages are measured against what actually survived.
     */
    "sessions:sweep": async (input) => {
      const swept = await app.sessions.sweep({
        apply: input.apply,
        keepSessionId: input.keepSessionId,
      });
      const strandedPages = await browser().forget(swept.survivors, input.apply);
      return {
        applied: input.apply,
        emptySessions: swept.emptySessions,
        abandonedRuns: swept.abandonedRuns,
        orphanTurns: swept.orphanTurns,
        strandedPages,
      };
    },
    "sessions:sendMessage": async (input) => ({
      turnId: await app.sessions.sendMessage({
        sessionId: input.sessionId,
        content: input.content,
        skills: input.skills,
        origin: "interactive",
        // Where the user was standing is stamped onto the turn itself, so
        // replaying a conversation shows which mode produced each answer.
        mode: modeOf(input.subMode),
        subMode: input.subMode,
        projectId: input.projectId,
        modelId: input.modelId,
      }),
    }),
    "sessions:getTurn": async (input) => app.sessions.getTurn(input.turnId),
    "sessions:turns": async (input) => app.sessions.getTurns(input.sessionId),
    "sessions:stopTurn": async (input) =>
      ok(app.sessions.stopTurn(input.turnId, input.reason)),
    "sessions:resume": async (input) => ({
      turnId: await app.sessions.resume(input.sessionId),
    }),
    "sessions:respondToPermission": async (input) =>
      ok(app.sessions.respondToPermission(input.turnId, input.toolCallId, input.decision)),
  };
}

/** Skills, including the evolution runs that propose new ones. */
export function skillsHandlers({ app, requireAccount }: IpcContext): IpcHandlersFor<"skills"> {
  return {
    "skills:list": async () => app.skills.list(),
    "skills:setEnabled": async (input) =>
      ok(app.skills.setEnabled(input.name, input.enabled, app.correlationId())),
    "skills:listProposals": async () => app.skills.listProposals(),
    "skills:propose": async (proposal: Parameters<typeof app.skills.propose>[0]) =>
      ok(app.skills.propose(proposal, app.correlationId())),
    // Approval is an accountable act; it must be attributable to a person.
    "skills:approve": async (input) =>
      app.skills.approve(
        input.name,
        requireAccount("sign in before approving a skill"),
        app.correlationId(),
      ),
    "skills:archive": async (input) => ok(app.skills.archive(input.name, app.correlationId())),

    /**
     * Directory choosers live in the main process because only it may touch the
     * filesystem namespace. The renderer never sees a path it did not receive
     * from a dialog the user drove.
     */
    "skills:chooseImport": async () => {
      const chosen = await dialog.showOpenDialog({
        title: "Choose a skill folder",
        properties: ["openDirectory"],
      });
      return { source: chosen.canceled ? "" : (chosen.filePaths[0] ?? "") };
    },
    "skills:inspectImport": async (input) => app.skills.inspectImport(input.source),
    "skills:import": async (input) =>
      app.skills.importFrom(
        input.source,
        requireAccount("sign in before importing a skill"),
        app.correlationId(),
      ),
    "skills:approveInstalled": async (input) =>
      app.skills.approveInstalled(
        input.name,
        requireAccount("sign in before approving a skill"),
        app.correlationId(),
      ),
    "skills:export": async (input) => {
      const account = requireAccount("sign in before exporting a skill");
      const chosen = await dialog.showOpenDialog({
        title: `Export "${input.name}" to…`,
        properties: ["openDirectory", "createDirectory"],
      });
      const destination = chosen.canceled ? "" : (chosen.filePaths[0] ?? "");
      if (destination === "") return { name: input.name, destination: "", files: [] };
      return app.skills.exportTo(input.name, destination, account, app.correlationId());
    },
    "skills:remove": async (input) => ok(app.skills.remove(input.name, app.correlationId())),

    // --- skill evolution ---------------------------------------------------
    "skills:evolutionStatus": async () => app.skillEvolution.status(),
    /**
     * Requires an account: a run spends model calls and writes a proposal, so
     * it is attributable work rather than a read. It is deliberately not
     * awaited to completion here — a run takes minutes, and holding the IPC
     * call open for it would time out the renderer's bridge. Progress arrives
     * on `skills:evolutionChanged`.
     */
    "skills:evolve": async (input) => {
      requireAccount("sign in to evolve a skill");
      const correlationId = app.correlationId();
      void app.skillEvolution.evolve(input, correlationId).catch(() => undefined);
      return { started: true };
    },
    "skills:cancelEvolve": async () => {
      app.skillEvolution.cancel();
      return { ok: true };
    },
  };
}
