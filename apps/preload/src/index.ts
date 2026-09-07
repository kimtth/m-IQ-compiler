import { contextBridge, ipcRenderer } from "electron";
import {
  isIpcEventChannel,
  validateIpcRequest,
  IPC_EVENT_CHANNELS,
  type IpcEventChannel,
} from "@iq/shared";

/**
 * The only bridge between the untrusted renderer and privileged code.
 *
 * Node integration is off and the renderer is sandboxed, so this file decides
 * exactly what the UI can reach. Two rules make that meaningful:
 *
 *  1. Requests are validated here against the shared contract before they are
 *     forwarded, so a compromised renderer cannot reach an undeclared channel
 *     or send a malformed payload into privileged code.
 *  2. Subscriptions are restricted to the declared push channels, so the
 *     renderer cannot listen in on internal IPC traffic.
 *
 * Both follow the same boundary: the renderer is untrusted, and the typed IPC
 * contract is its only runtime route into privileged code.
 */
const api = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    // Throws on unknown channels and invalid payloads, before anything is sent.
    const validated = validateIpcRequest(channel, args);
    return ipcRenderer.invoke(channel, ...validated);
  },

  on(channel: IpcEventChannel, listener: (payload: unknown) => void): () => void {
    if (!isIpcEventChannel(channel)) {
      throw new Error(`cannot subscribe to non-event channel: ${channel}`);
    }
    // The IpcRendererEvent is deliberately not forwarded: it carries a
    // `sender` the renderer has no business holding.
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },

  eventChannels: [...IPC_EVENT_CHANNELS] as readonly string[],
};

contextBridge.exposeInMainWorld("iq", api);

export type IqBridge = typeof api;
