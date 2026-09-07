import { describe, expect, it } from "vitest";
import { EMITTER_CHANNELS, emitterOver, type AppEmitter } from "@iq/core";
import { IPC_EVENT_CHANNELS, type IpcEventChannel } from "@iq/shared";

/**
 * What main tells the renderer, and on which channel.
 *
 * This mapping used to be written down four times — `AppEmitter` (22 methods),
 * `NOOP_EMITTER` (22), `createEmitter` in `apps/main` (22) and
 * `IPC_EVENT_CHANNELS` (25) — with nothing checking any of them against the
 * others. Adding one push fact meant four edits in three files, and the host's
 * `send` took a bare `string`, so a mistyped channel name compiled and pushed
 * to nothing.
 *
 * `EMITTER_CHANNELS` is now the single mapping and `emitterOver` is the single
 * emit path. `satisfies` proves the shape at compile time, but `tests/` is
 * typechecked by nothing in this repo, so the same facts are proved here at run
 * time where they cannot go stale.
 */

/** Channels main pushes itself, outside the app's own broadcasts. */
const HOST_OWNED: IpcEventChannel[] = [
  // The Entra status callback fires before `App.start` returns.
  "auth:status",
  // The browser pane is constructed after the app and owns its own window.
  "browser:changed",
  "browser:frame",
  // Pushed from inside the samples request handlers, which already hold the
  // status they are about to return.
  "samples:changed",
];

function recorder(): { sent: Array<[IpcEventChannel, unknown]>; emit: AppEmitter } {
  const sent: Array<[IpcEventChannel, unknown]> = [];
  return { sent, emit: emitterOver((channel, payload) => sent.push([channel, payload])) };
}

describe("app emitter", () => {
  it("names only channels the renderer is allowed to subscribe to", () => {
    for (const [method, channel] of Object.entries(EMITTER_CHANNELS)) {
      if (channel === null) continue;
      expect(IPC_EVENT_CHANNELS, `${method} pushes an unknown channel`).toContain(channel);
    }
  });

  it("gives each broadcast a channel of its own", () => {
    const named = Object.values(EMITTER_CHANNELS).filter((channel) => channel !== null);
    expect(new Set(named).size).toBe(named.length);
  });

  /**
   * The push channels that exist and are *not* the app's own broadcasts.
   *
   * Pinned as a list rather than left implicit because "three emit paths" was
   * the shape of the problem: a channel that quietly grows a fourth emit site
   * is a fact about the UI with two sources again.
   */
  it("leaves exactly the host-owned channels to the host", () => {
    const broadcast = new Set(Object.values(EMITTER_CHANNELS).filter((c) => c !== null));
    const uncovered = IPC_EVENT_CHANNELS.filter((channel) => !broadcast.has(channel));
    expect([...uncovered].sort()).toEqual([...HOST_OWNED].sort());
  });

  it("sends each broadcast on its declared channel, payload intact", () => {
    const { sent, emit } = recorder();
    const run = { id: "img_1" } as never;

    emit.images(run);
    emit.council({ id: "cnc_1" } as never);
    emit.recorderStatus({ state: "idle" } as never);

    expect(sent).toEqual([
      ["images:run", run],
      ["council:changed", { id: "cnc_1" }],
      ["recording:status", { state: "idle" }],
    ]);
  });

  /** `projectFiles()` carries nothing; the renderer's subscription expects `null`. */
  it("sends null for a broadcast with no payload", () => {
    const { sent, emit } = recorder();
    emit.projectFiles();
    expect(sent).toEqual([["project:filesChanged", null]]);
  });

  /**
   * `audit` is declared and deliberately not pushed: the record is durable and
   * read back through `audit:query`, and nothing subscribes to it live. The
   * host implemented this as a silent no-op; the map states it instead.
   */
  it("pushes nothing for a broadcast mapped to no channel", () => {
    const { sent, emit } = recorder();
    emit.audit({ id: "aud_1" } as never);
    expect(sent).toEqual([]);
  });

  /** A core constructed with no host must still be callable, and send nowhere. */
  it("is safe to call with no window listening", () => {
    const emit = emitterOver(() => undefined);
    expect(() => {
      emit.projectFiles();
      emit.memories([]);
    }).not.toThrow();
  });
});
