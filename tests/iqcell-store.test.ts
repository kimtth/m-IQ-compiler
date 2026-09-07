import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FlowGraph } from "@iq/shared";
import { installDevice, memoryDevice } from "../apps/renderer/src/flow/device.js";
import {
  countCells,
  forgetRemoved,
  reconcileCells,
  rememberRemoved,
  removeCells,
} from "../apps/renderer/src/flow/reconcile.js";
import {
  listFlows,
  listIqCells,
  onFlowStaged,
  saveFlow,
  stageForEditor,
  takeStagedFlow,
} from "../apps/renderer/src/flow/storage.js";
import type { DemoIqCell } from "../apps/renderer/src/connectome/fixtures.js";

/**
 * The IQ Cell library, tested without a browser.
 *
 * These records were reached through `window.localStorage` directly — twenty
 * calls across six renderer modules — so the browser API *was* the interface
 * and there was nothing to substitute. `reconcileCells` had no direct test, and
 * it is where the 2026-08-06 stale-draft defect lived: a demo draft written by
 * an older palette stayed in storage for ever, opened with its own trigger
 * reported as a retired step, and read as a dozen validator errors.
 *
 * One interface, two adapters. This runs on the in-memory one.
 */

const cell = (over: Partial<DemoIqCell> = {}): DemoIqCell => ({
  id: "iqcell_demo_1",
  name: "Draft the weekly brief",
  version: 1,
  faces: ["node"],
  origin: "editor",
  runs: 3,
  completionRate: 1,
  tokensPerRun: 900,
  reach: ["Project files"],
  embeds: [],
  producesArtifacts: ["reports/weekly.md"],
  consumesArtifacts: [],
  paths: ["reports/weekly.md"],
  hosts: [],
  configuration: [],
  approver: "",
  activeHours: [9],
  lastRunDaysAgo: 2,
  pinnedVersionsBehind: 0,
  ...over,
});

let restore: () => void;

beforeEach(() => {
  restore = installDevice(memoryDevice());
});

afterEach(() => {
  restore();
});

describe("IQ Cell store", () => {
  it("starts empty and keeps what it is given, per project", () => {
    expect(listFlows("ws1")).toEqual([]);

    const graph: FlowGraph = {
      id: "flow_1",
      name: "A draft",
      projectId: "ws1",
      nodes: [],
      edges: [],
      updatedAt: "2026-08-07T00:00:00.000Z",
    };
    saveFlow("ws1", graph);

    expect(listFlows("ws1").map((row) => row.id)).toEqual(["flow_1"]);
    // A different project is a different scope, not a filter over one list.
    expect(listFlows("ws2")).toEqual([]);
  });

  /**
   * The Connectome→canvas handoff is a contract between two surfaces, not a
   * bare `window` event. Two components used to communicate through a global
   * with nothing declaring that they did.
   */
  it("announces a staged draft, and hands it over exactly once", () => {
    let announced = 0;
    const stop = onFlowStaged(() => {
      announced += 1;
    });

    const graph: FlowGraph = {
      id: "flow_2",
      name: "Staged",
      projectId: null,
      nodes: [],
      edges: [],
      updatedAt: "2026-08-07T00:00:00.000Z",
    };
    stageForEditor(null, graph);
    expect(announced).toBe(1);

    expect(takeStagedFlow(null)?.id).toBe("flow_2");
    // Taken, not peeked: a second read must not reopen what was already opened.
    expect(takeStagedFlow(null)).toBeNull();

    stop();
    stageForEditor(null, graph);
    expect(announced).toBe(1);
  });

  it("adds a declared cell once, however many times it reconciles", () => {
    const cells = [cell(), cell({ id: "iqcell_demo_2", name: "Second" })];

    expect(reconcileCells("ws1", cells)).toBe(2);
    expect(reconcileCells("ws1", cells)).toBe(0);
    expect(countCells("ws1", cells)).toBe(2);
    expect(listIqCells("ws1")).toHaveLength(2);
  });

  /**
   * A removal is a decision, and it has to stick. Without the removal record
   * the next visit would put the cell straight back and the delete control
   * would look broken.
   */
  it("remembers a removal, and forgets it on request", () => {
    const cells = [cell()];
    reconcileCells("ws1", cells);

    expect(removeCells("ws1", cells)).toBe(1);
    expect(countCells("ws1", cells)).toBe(0);
    expect(reconcileCells("ws1", cells)).toBe(0);

    // Forgetting is what makes a later Load mean anything at all.
    forgetRemoved("ws1", cells);
    expect(reconcileCells("ws1", cells)).toBe(1);
  });

  it("never resurrects a single card deleted by hand", () => {
    const cells = [cell()];
    reconcileCells("ws1", cells);
    const saved = listFlows("ws1")[0]!;

    rememberRemoved("ws1", saved.id);
    removeCells("ws1", cells);
    expect(reconcileCells("ws1", cells)).toBe(0);
  });

  /**
   * The stale-draft defect, pinned.
   *
   * A retired node kind is the test for "machine-written by an old build",
   * because the palette does not offer these steps — their presence dates the
   * draft rather than describing anyone's work. Such a draft is replaced; a
   * draft someone has since edited within the current palette is theirs and is
   * left exactly as it is.
   */
  it("replaces a demo draft an older palette wrote, and only that one", () => {
    const cells = [cell()];
    reconcileCells("ws1", cells);
    const fresh = listFlows("ws1")[0]!;

    // Rewrite it the way an older build would have: one retired kind.
    saveFlow("ws1", {
      ...fresh,
      nodes: [
        {
          id: "n1",
          kind: "http_request",
          label: "Fetch",
          x: 0,
          y: 0,
        } as unknown as FlowGraph["nodes"][number],
      ],
    });
    expect(listFlows("ws1")[0]!.nodes[0]!.kind).toBe("http_request");

    reconcileCells("ws1", cells);
    const repaired = listFlows("ws1").find((row) => row.id === fresh.id)!;
    expect(repaired.nodes.some((node) => node.kind === "http_request")).toBe(false);
    // Node ids are minted per reconstruction, so the draft is compared by what
    // it *is* rather than by identity — which is also how `reconcileCells`
    // itself tells an untouched reconstruction from an edited one.
    expect(repaired.nodes.map((node) => node.kind)).toEqual(fresh.nodes.map((node) => node.kind));
    expect(repaired.nodes.map((node) => node.label)).toEqual(fresh.nodes.map((node) => node.label));
  });

  it("leaves a draft someone edited within the current palette alone", () => {
    const cells = [cell()];
    reconcileCells("ws1", cells);
    const fresh = listFlows("ws1")[0]!;

    const mine = { ...fresh, name: "My own version of this" };
    saveFlow("ws1", mine);

    reconcileCells("ws1", cells);
    expect(listFlows("ws1").find((row) => row.id === fresh.id)?.name).toBe(
      "My own version of this",
    );
  });

  /**
   * The drafts list is what someone drew. A knowledge or memory cell has no
   * canvas source, so it is published without being saved as a draft — and an
   * earlier build that did save them has its untouched leftovers taken back.
   */
  it("publishes a non-editor cell without leaving a draft behind", () => {
    const cells = [cell({ id: "iqcell_k", name: "Ask the standards notes", origin: "knowledge" })];

    reconcileCells("ws1", cells);
    expect(listIqCells("ws1")).toHaveLength(1);
    expect(listFlows("ws1")).toEqual([]);
  });
});
