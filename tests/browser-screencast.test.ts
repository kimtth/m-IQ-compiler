import { describe, expect, it } from "vitest";
import {
  BrowserFrame,
  BrowserInput,
  BrowserState,
  isIpcEventChannel,
  validateIpcRequest,
} from "@iq/shared";

/**
 * The browser pane streams a page in and forwards input back out. These tests
 * pin the two halves of that contract, and then prove the one mechanism the
 * whole design rests on: that committed IME text survives the round trip.
 */

describe("BrowserInput", () => {
  it("accepts a mouse press with defaults filled in", () => {
    const parsed = BrowserInput.parse({ kind: "mouse", type: "mousePressed", x: 10, y: 20 });
    expect(parsed).toMatchObject({ kind: "mouse", button: "none", clickCount: 0 });
  });

  it("carries composed CJK text as text, not as keys", () => {
    const parsed = BrowserInput.parse({ kind: "text", text: "안녕하세요 こんにちは" });
    expect(parsed).toEqual({ kind: "text", text: "안녕하세요 こんにちは" });
  });

  it("caps forwarded text so one paste cannot flood the page", () => {
    expect(() => BrowserInput.parse({ kind: "text", text: "x".repeat(4_001) })).toThrow();
    expect(() => BrowserInput.parse({ kind: "text", text: "" })).toThrow();
  });

  it("bounds coordinates", () => {
    expect(() =>
      BrowserInput.parse({ kind: "mouse", type: "mouseMoved", x: 10_000_000, y: 0 }),
    ).toThrow();
  });

  it("refuses an unknown kind", () => {
    expect(() => BrowserInput.parse({ kind: "script", source: "alert(1)" })).toThrow();
  });

  it("keeps modifiers off unless asked for", () => {
    const parsed = BrowserInput.parse({ kind: "key", key: "Enter" });
    expect(parsed).toMatchObject({ ctrl: false, alt: false, shift: false, meta: false, keyCode: 0 });
  });
});

describe("browser IPC contract", () => {
  it("validates forwarded input at the boundary", () => {
    expect(() =>
      validateIpcRequest("browser:input", [{ kind: "text", text: "안녕하세요" }]),
    ).not.toThrow();
    // The renderer is untrusted, so a malformed payload never reaches main.
    expect(() => validateIpcRequest("browser:input", [{ kind: "text" }])).toThrow();
    expect(() => validateIpcRequest("browser:input", [{ kind: "eval", code: "1" }])).toThrow();
  });

  it("publishes frames on a push channel the renderer may subscribe to", () => {
    expect(isIpcEventChannel("browser:frame")).toBe(true);
    // A frame is a picture, so it can only travel main to renderer.
    expect(() => validateIpcRequest("browser:frame", [])).toThrow();
  });
});

describe("BrowserFrame and BrowserState", () => {
  it("carries the geometry a click needs to be mapped back to the page", () => {
    const frame = BrowserFrame.parse({ data: "abc", width: 1280, height: 800 });
    expect(frame).toMatchObject({ offsetTop: 0, scale: 1 });
  });

  it("reports an engine so a missing browser is visible before it is needed", () => {
    const state = BrowserState.parse({ enabled: true, open: false, visible: false });
    expect(state.engine).toBe("idle");
    expect(BrowserState.parse({ ...state, engine: "unavailable" }).engine).toBe("unavailable");
    expect(() => BrowserState.parse({ ...state, engine: "exploded" })).toThrow();
  });
});
