import type { App } from "@iq/core";
import type { IpcChannel, IpcEventChannel, IpcRequestArgs, IpcResult } from "@iq/shared";
import type { BrowserPane } from "../browser-pane.js";

/**
 * Every channel, and nothing but.
 *
 * The mapped type over `IpcChannel` is an exhaustiveness device: a channel
 * added to `IPC_REQUEST_SCHEMAS` with no handler fails to compile, and a
 * handler for a channel that does not exist fails too.
 *
 * Arguments come from the schema (`IpcRequestArgs`) and the return from the
 * contract (`IpcResult`). Both used to be hand-written: 123 handlers restated
 * their payload type next to the zod object that already said it, and the
 * return was unconstrained — so a response shape could change with nothing
 * anywhere noticing.
 */
export type IpcHandlers = {
  [C in IpcChannel]: (...args: IpcRequestArgs<C>) => Promise<IpcResult<C>>;
};

/**
 * The handlers belonging to one channel family.
 *
 * Each family module declares this as its return type, so the exhaustiveness
 * check survives the split: a channel whose prefix matches but which the module
 * forgot to implement fails to compile there, rather than at the one place that
 * assembles them.
 */
export type IpcHandlersFor<Prefix extends string> = Pick<
  IpcHandlers,
  Extract<IpcChannel, `${Prefix}:${string}`>
>;

/**
 * What a family module is allowed to reach.
 *
 * Passing this explicitly rather than closing over the module scope keeps the
 * privileged surface honest: a handler can only use capabilities named here,
 * and the list of them is short enough to read.
 */
export interface IpcContext {
  readonly app: App;
  /** The built-in browser pane, resolved late because it outlives no window. */
  readonly browser: () => BrowserPane;
  /**
   * The one push the handlers make themselves.
   *
   * Typed on {@link IpcEventChannel} rather than `string`: `WebContents.send`
   * takes any string, so an unchecked channel name pushes to nothing and
   * compiles. Everything else main broadcasts goes through `emitterOver`, which
   * owns the method-to-channel mapping.
   */
  readonly push: (channel: IpcEventChannel, payload: unknown) => void;
  /**
   * Acts that grant or revoke access must be attributable to a person, so they
   * are refused rather than recorded against "system" when nobody is signed in.
   *
   * Takes the whole refusal, not a fragment to interpolate: the wording differs
   * between channels and it is shown to the user, so building it here would
   * quietly rephrase a dozen messages.
   */
  readonly requireAccount: (refusal: string) => { oid: string; tenantId: string };
  /** Refuse a whole feature in one place when tenant policy switches it off. */
  readonly knowledgeEnabled: () => void;
  /**
   * Select a file in the OS file manager.
   *
   * `showItemInFolder` opens a folder and selects a file — it does not execute
   * anything, unlike `shell.openPath`. Routing every caller through one place
   * is what makes that claim checkable; it used to be restated per channel.
   */
  readonly reveal: (path: string | Promise<string>) => Promise<void>;
}

/**
 * Await work that reports nothing but its own success.
 *
 * Thirty handlers used to spell this out over four lines each. Collapsing them
 * is not only shorter: it makes the handlers that *do* return something stand
 * out, which is most of the reason to read this file at all.
 */
export async function ok(work: Promise<unknown>): Promise<{ ok: true }> {
  await work;
  return { ok: true };
}
