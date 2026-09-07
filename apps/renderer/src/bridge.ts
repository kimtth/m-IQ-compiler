import type {
  IpcChannel,
  IpcEventChannel,
  IpcRequestInput,
  IpcResult,
} from "@iq/shared";

/**
 * Typed client over the preload bridge.
 *
 * Main returns `{ ok, data | error }` rather than rejecting, so failures cross
 * the boundary as plain data. This unwraps that shape into a normal promise
 * rejection so components can use try/catch.
 *
 * `call` infers arguments from the request schema and results from
 * {@link IpcResult}. `callAs` shares its transport but lets the caller assert a
 * result shape that the shared contract does not yet declare.
 */
interface Bridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: IpcEventChannel, listener: (payload: unknown) => void): () => void;
}

declare global {
  interface Window {
    iq?: Bridge;
  }
}

function bridge(): Bridge {
  const found = window.iq;
  if (!found) throw new Error("preload bridge unavailable");
  return found;
}

export async function call<C extends IpcChannel>(
  channel: C,
  ...args: IpcRequestInput<C>
): Promise<IpcResult<C>> {
  return callAs<IpcResult<C>>(channel, ...args);
}

/**
 * The same transport, for channels whose response is not a shared shape.
 *
 * Named differently on purpose. `call` is checked; this is an assertion, and an
 * assertion should have to say so at the call site rather than hide inside the
 * same function everything else uses. Any channel that grows a shared contract
 * should move off it.
 */
export async function callAs<T>(channel: IpcChannel, ...args: unknown[]): Promise<T> {
  const response = (await bridge().invoke(channel, ...args)) as
    | { ok: true; data: T }
    | { ok: false; error: string };

  if (!response.ok) throw new Error(response.error);
  return response.data;
}

export function subscribe<T>(
  channel: IpcEventChannel,
  listener: (payload: T) => void,
): () => void {
  return bridge().on(channel, (payload) => listener(payload as T));
}
