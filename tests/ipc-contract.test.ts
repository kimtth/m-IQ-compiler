import { describe, expect, it } from "vitest";
import { IPC_EVENT_CHANNELS, IPC_REQUEST_SCHEMAS, validateIpcRequest } from "@iq/shared";

/**
 * The IPC contract.
 *
 * The request half has always been a schema. The response half had **no
 * interface at all**: `bridge.call<T>(channel)` was an unchecked assertion at
 * 129 call sites, and the only thing connecting a handler's return to the
 * renderer's belief about it was that someone had written the same type name in
 * two files. Adding a channel touched three files; changing a *response* shape
 * touched one and was caught by nothing — which is how the whole `recording:*`
 * family came to be deleted from `shared/ipc.ts` while eighteen handlers still
 * implemented it.
 *
 * `IpcResults` closes that. Most of it is proved by the compiler — the handler
 * map is `(...args: IpcRequestArgs<C>) => Promise<IpcResult<C>>`, and
 * `bridge.call` infers both halves — so what is left to prove here is the part
 * TypeScript cannot: that the runtime guard still refuses what it should, and
 * that the two channel sets stay disjoint.
 */

describe("IPC contract", () => {
  it("refuses a channel that does not exist, rather than guessing", () => {
    expect(() => validateIpcRequest("speech:statuss", [])).toThrow(/unknown IPC channel/i);
    expect(() => validateIpcRequest("", [])).toThrow(/unknown IPC channel/i);
    // A push-only channel is not a request channel: the renderer may subscribe
    // to it and must not be able to invoke it.
    expect(() => validateIpcRequest("turns:event", [])).toThrow(/unknown IPC channel/i);
  });

  it("refuses a payload the schema does not describe", () => {
    expect(() => validateIpcRequest("samples:load", [{ module: "nonsense" }])).toThrow();
    expect(() => validateIpcRequest("samples:load", [])).toThrow();
    expect(validateIpcRequest("samples:load", [{ module: "memories" }])).toEqual([
      { module: "memories" },
    ]);
  });

  /**
   * The defaults are the reason a caller is typed on `z.input` and a handler on
   * `z.infer`. The renderer has never sent `subMode` or `projectId` on a
   * message and never needed to — the boundary supplies them — so typing the
   * caller on the output shape would demand fields this parse exists to fill.
   */
  it("fills the fields the boundary is there to supply", () => {
    const [filled] = validateIpcRequest("sessions:sendMessage", [
      { sessionId: "ses_1", content: "hello" },
    ]) as [Record<string, unknown>];

    expect(filled["sessionId"]).toBe("ses_1");
    expect(filled["subMode"]).toBeDefined();
    expect(filled["projectId"]).toBeDefined();
    expect(filled["skills"]).toEqual([]);
  });

  /**
   * Request and push are two directions, and a name may legitimately be both:
   * "tell me the state now" and "tell me when it changes" are one concept with
   * two deliveries. Two channels are deliberately both, and they are named here
   * so a third cannot arrive by accident — an overlap nobody chose would make
   * "may the renderer invoke this?" ambiguous.
   */
  it("shares a name between the two directions only where that is the point", () => {
    const requests = new Set<string>(Object.keys(IPC_REQUEST_SCHEMAS));
    const overlap = IPC_EVENT_CHANNELS.filter((channel) => requests.has(channel));
    expect([...overlap].sort()).toEqual(["auth:status", "recording:status"]);
  });

  it("names every request channel exactly once", () => {
    const names = Object.keys(IPC_REQUEST_SCHEMAS);
    expect(new Set(names).size).toBe(names.length);
    // A channel is `family:verb`. A name without the colon would sort into the
    // wrong group in every list that reads it.
    for (const name of names) expect(name, name).toMatch(/^[a-zA-Z]+:[a-zA-Z]+$/);
  });
});
