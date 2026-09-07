import { ok, type IpcContext, type IpcHandlersFor } from "./context.js";

/** The model registry, edited only from Connections & access. */
export function modelsHandlers({ app }: IpcContext): IpcHandlersFor<"models"> {
  return {
    "models:catalog": async () => app.models.catalog(),
    "models:upsert": async (input) => app.models.upsert(input),
    "models:remove": async (input) => ok(app.models.remove(input.id)),
    "models:test": async (input) => app.models.test(input.id),
    "models:setDefault": async (input) =>
      ok(app.models.setDefault(input.role, input.modelId, input.projectId)),
  };
}

/**
 * Office authoring and image creation.
 *
 * The renderer never composes a command line: it asks for status, for an
 * install, or for a preview of a path the project already contains.
 */
export function officeHandlers({
  app,
}: IpcContext): IpcHandlersFor<"office"> & IpcHandlersFor<"images"> {
  return {
    "office:status": async () => app.office.status(),
    "office:install": async () => app.office.install(),
    "office:documents": async () => app.office.documents(),
    "office:preview": async (input) => app.office.preview(input.path, input.format),
    "office:render": async (input) => app.office.renderNative(input.path, { page: input.page }),
    // The project comes from the bound one here, never from the renderer: a
    // conversation's document is only its own inside the project it was made in.
    "office:remember": async (input) =>
      ok(
        app.officeFocus.remember(
          input.sessionId,
          app.projects.active()?.id ?? null,
          input.path,
        ),
      ),
    "office:recall": async (input) =>
      app.officeFocus.recall(input.sessionId, app.projects.active()?.id ?? null),

    "images:generate": async (input) => app.images.generate(input),
    "images:runs": async () => app.images.runs(),
    "images:save": async (input) => ({
      path: await app.images.save(input.runId, input.imageId, input.path),
    }),
    "images:delete": async (input) => ok(app.images.delete(input.runId)),
    "images:deleteThread": async (input) => ok(app.images.deleteThread(input.threadId)),
  };
}

/** Deep research, and the council that argues a question out (Chat → Team). */
export function researchHandlers({
  app,
}: IpcContext): IpcHandlersFor<"research"> & IpcHandlersFor<"council"> {
  return {
    "research:list": async () => app.research.list(),
    "research:start": async (input) => app.research.start(input),
    "research:get": async (input) => app.research.get(input.runId),
    "research:updatePlan": async (input) =>
      app.research.updatePlan(input.runId, input.questions),
    "research:approvePlan": async (input) => app.research.approvePlan(input.runId),
    "research:rerunQuestion": async (input) =>
      app.research.rerunQuestion(input.runId, input.questionId),
    "research:write": async (input) => app.research.write(input.runId),
    "research:refine": async (input) => app.research.refine(input),
    "research:cancel": async (input) => app.research.cancel(input.runId),
    "research:delete": async (input) => ok(app.research.delete(input.runId)),

    "council:presets": async () => app.council.presets(),
    "council:savePreset": async (input) => app.council.savePreset(input),
    "council:deletePreset": async (input) => ok(app.council.deletePreset(input.id)),
    "council:list": async () => app.council.list(),
    "council:start": async (input) => app.council.start(input),
    "council:get": async (input) => app.council.get(input.runId),
    "council:inject": async (input) => app.council.inject(input.runId, input.text),
    "council:forceVerdict": async (input) => app.council.forceVerdict(input.runId),
    "council:cancel": async (input) => app.council.cancel(input.runId),
    "council:rename": async (input) => app.council.rename(input.runId, input.title),
    "council:delete": async (input) => ok(app.council.delete(input.runId)),
  };
}
