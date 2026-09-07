import { afterEach, describe, expect, it, vi } from "vitest";
import { call, callAs, subscribe } from "../apps/renderer/src/bridge.js";

afterEach(() => vi.unstubAllGlobals());

describe("renderer bridge", () => {
  it("forwards typed calls and returns the response data unchanged", async () => {
    const data = { state: "signed_out" };
    const invoke = vi.fn().mockResolvedValue({ ok: true, data });
    vi.stubGlobal("window", { iq: { invoke } });

    expect(await call("auth:status")).toBe(data);
    expect(invoke).toHaveBeenCalledWith("auth:status");
    await call("sessions:rename", { sessionId: "ses_test", title: "Renamed" });
    expect(invoke).toHaveBeenLastCalledWith("sessions:rename", {
      sessionId: "ses_test", title: "Renamed",
    });
  });

  it("uses the same response envelope for asserted results", async () => {
    const data = { ready: true };
    const invoke = vi.fn().mockResolvedValue({ ok: true, data });
    vi.stubGlobal("window", { iq: { invoke } });

    expect(await callAs<{ ready: boolean }>("fabric:contextStatus")).toBe(data);
    expect(invoke).toHaveBeenCalledWith("fabric:contextStatus");
  });

  it("rejects both call paths with the main process's error", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: false, error: "permission denied" });
    vi.stubGlobal("window", { iq: { invoke } });

    await expect(call("auth:status")).rejects.toThrow("permission denied");
    await expect(callAs("auth:status")).rejects.toThrow("permission denied");
  });

  it("preserves transport failures and reports a missing preload", async () => {
    const failure = new Error("transport failed");
    vi.stubGlobal("window", { iq: { invoke: vi.fn().mockRejectedValue(failure) } });
    await expect(call("auth:status")).rejects.toBe(failure);

    vi.stubGlobal("window", {});
    await expect(call("auth:status")).rejects.toThrow("preload bridge unavailable");
    await expect(callAs("auth:status")).rejects.toThrow("preload bridge unavailable");
  });

  it("forwards events and returns the preload's unsubscribe function", () => {
    const unsubscribe = vi.fn();
    const on = vi.fn((_channel: string, listener: (payload: unknown) => void) => {
      listener({ state: "signed_out" });
      return unsubscribe;
    });
    vi.stubGlobal("window", { iq: { on } });
    const listener = vi.fn();

    expect(subscribe("auth:status", listener)).toBe(unsubscribe);
    expect(on).toHaveBeenCalledWith("auth:status", expect.any(Function));
    expect(listener).toHaveBeenCalledWith({ state: "signed_out" });
  });
});