import { ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { App } from "@iq/core";
import {
  IPC_REQUEST_SCHEMAS,
  validateIpcRequest,
  type IpcChannel,
  type IpcEventChannel,
} from "@iq/shared";
import type { BrowserPane } from "../browser-pane.js";
import type { IpcContext, IpcHandlers } from "./context.js";
import { modelsHandlers, officeHandlers, researchHandlers } from "./authoring.js";
import {
  browserHandlers,
  meetingsHandlers,
  recordingHandlers,
  speechHandlers,
} from "./capture.js";
import { dataAgentHandlers, fabricHandlers, governanceHandlers } from "./fabric.js";
import {
  jobsHandlers,
  knowledgeHandlers,
  mcpHandlers,
  memoryHandlers,
  projectsHandlers,
} from "./knowledge.js";
import { authHandlers, samplesHandlers, sessionsHandlers, skillsHandlers } from "./workspace.js";

/**
 * Privileged IPC surface.
 *
 * Every handler re-validates its arguments even though the preload already did.
 * The preload runs in the renderer's process tree, so treating its validation
 * as sufficient would put the trust boundary in the wrong place.
 *
 * The handlers themselves live beside this file, one module per group of
 * channel families. This file owns what is true of all of them: what they are
 * allowed to reach ({@link IpcContext}), that the set is exhaustive
 * ({@link IpcHandlers}), and that a caller is who it claims to be.
 */
export function registerIpcHandlers(
  app: App,
  senderFor: () => WebContents | null,
  browser: () => BrowserPane,
): void {
  const context: IpcContext = {
    app,
    browser,
    push: (channel: IpcEventChannel, payload: unknown): void => {
      senderFor()?.send(channel, payload);
    },
    requireAccount: (refusal: string) => {
      const account = app.entra.currentAccount();
      if (!account) throw new Error(refusal);
      return { oid: account.oid, tenantId: account.tenantId };
    },
    knowledgeEnabled: (): void => {
      if (!app.tenantPolicy.policy.knowledgeGraphEnabled) {
        throw new Error("the knowledge graph is disabled by tenant policy");
      }
    },
    reveal: async (path: string | Promise<string>): Promise<void> => {
      shell.showItemInFolder(await path);
    },
  };

  // Annotated, not inferred: this is where a channel that no module implements
  // fails to compile.
  const handlers: IpcHandlers = {
    ...samplesHandlers(context),
    ...authHandlers(context),
    ...sessionsHandlers(context),
    ...skillsHandlers(context),
    ...mcpHandlers(context),
    ...memoryHandlers(context),
    ...jobsHandlers(context),
    ...knowledgeHandlers(context),
    ...projectsHandlers(context),
    ...modelsHandlers(context),
    ...officeHandlers(context),
    ...researchHandlers(context),
    ...browserHandlers(context),
    ...speechHandlers(context),
    ...meetingsHandlers(context),
    ...recordingHandlers(context),
    ...fabricHandlers(context),
    ...dataAgentHandlers(context),
    ...governanceHandlers(context),
  };

  for (const channel of Object.keys(IPC_REQUEST_SCHEMAS) as IpcChannel[]) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      // Only the window we created may call in.
      if (event.sender !== senderFor()) {
        throw new Error("ipc call from an unexpected sender");
      }

      const validated = validateIpcRequest(channel, args);
      const handler = handlers[channel] as (...input: unknown[]) => Promise<unknown>;

      try {
        return { ok: true, data: await handler(...validated) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        app.logger.warn("ipc handler failed", { channel, error: message });
        // Errors cross the boundary as data; an Error would lose its shape and
        // could leak a stack trace into the renderer.
        return { ok: false, error: message };
      }
    });
  }
}
