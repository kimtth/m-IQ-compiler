import { describe, expect, it } from "vitest";
import type { ResearchGraph } from "@iq/shared";
import { place, extent } from "../apps/renderer/src/ResearchGraph.js";

/**
 * The reasoning graph has to read as a flow, and it has to stop moving.
 *
 * Both were one defect. The graph was drawn with a force layout, so a shape the
 * data already states — plan, then a researcher per question, then reflect,
 * then synthesize — was left to a simulation to rediscover, and it settled on a
 * star with the labels piled in the middle. And because the series is replaced
 * on every delta (a node from a finished round must not linger), each status
 * change restarted the simulation and the whole picture jumped.
 *
 * Placing by rank answers both: position becomes a function of the graph, so a
 * status change is a change of colour and nothing else. These tests are about
 * that property — that the same graph always lands in the same place, and that
 * a node is never drawn left of something it depends on.
 */

const node = (id: string, kind: ResearchGraph["nodes"][number]["kind"]) => ({
  id,
  kind,
  label: id,
  status: "pending" as const,
  detail: "",
  round: 1,
});

/** The shape the sidecar really produces: plan → N questions → reflect → write. */
const workflow = (questions: number): ResearchGraph => ({
  nodes: [
    node("plan", "plan"),
    ...Array.from({ length: questions }, (_, index) => node(`q${index}`, "question")),
    node("reflect", "reflect"),
    node("write", "synthesize"),
  ],
  edges: [
    ...Array.from({ length: questions }, (_, index) => ({ from: "plan", to: `q${index}` })),
    ...Array.from({ length: questions }, (_, index) => ({ from: `q${index}`, to: "reflect" })),
    { from: "reflect", to: "write" },
  ],
});

describe("research graph layout", () => {
  it("puts every step to the right of what it depends on", () => {
    const at = place(workflow(4));
    const x = (id: string): number => at.get(id)?.x ?? Number.NaN;

    for (let index = 0; index < 4; index += 1) {
      expect(x("plan")).toBeLessThan(x(`q${index}`));
      expect(x(`q${index}`)).toBeLessThan(x("reflect"));
    }
    expect(x("reflect")).toBeLessThan(x("write"));
  });

  it("draws a fan-out as one column, spread down the pane", () => {
    const at = place(workflow(4));
    const questions = ["q0", "q1", "q2", "q3"].map((id) => at.get(id));

    // One rank, so one x — this is what makes it read as a fan rather than a
    // chain of four steps that happen to run at the same time.
    expect(new Set(questions.map((point) => point?.x)).size).toBe(1);
    expect(new Set(questions.map((point) => point?.y)).size).toBe(4);
  });

  it("gives every question room of its own, however many the planner raised", () => {
    // The box used to be fixed at 560 units, so sixteen questions sat 29 units
    // apart for a 26-unit symbol: one bar of touching discs with the labels
    // written over each other. The box grows down instead, and the component
    // grows the canvas element with it — see `extent`.
    for (const width of [1, 3, 16]) {
      const box = extent(workflow(width));
      const ys = [...place(workflow(width)).values()].map((point) => point.y).sort((a, b) => a - b);

      expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...ys)).toBeLessThanOrEqual(box.height);

      const questions = ["plan", "reflect", "write"];
      const fan = [...place(workflow(width)).entries()]
        .filter(([id]) => !questions.includes(id))
        .map(([, point]) => point.y)
        .sort((a, b) => a - b);
      for (let index = 1; index < fan.length; index += 1) {
        expect(fan[index]! - fan[index - 1]!).toBeGreaterThanOrEqual(56);
      }
    }
  });

  it("keeps the box at its base size until a fan-out needs more", () => {
    // Growing the box costs screen height, so it only grows when it must. Four
    // questions fit the base box; sixteen do not.
    expect(extent(workflow(4)).height).toBe(560);
    expect(extent(workflow(16)).height).toBeGreaterThan(560);
  });

  it("gives every rank room for a label, however many rounds the manager spent", () => {
    // The same defect as the fan-out, sideways. The box was a fixed 1000 units
    // wide while the number of ranks grows with every round, so a long run
    // packed its columns to a few tens of units apart and every label was
    // written over the next column's node. The box grows across instead.
    const rounds = (count: number): ResearchGraph => ({
      nodes: [
        node("plan", "plan"),
        ...Array.from({ length: count }, (_, index) => node(`r${index}`, "question")),
        node("write", "synthesize"),
      ],
      edges: [
        { from: "plan", to: "r0" },
        ...Array.from({ length: count - 1 }, (_, index) => ({
          from: `r${index}`,
          to: `r${index + 1}`,
        })),
        { from: `r${count - 1}`, to: "write" },
      ],
    });

    for (const depth of [2, 8, 20]) {
      const xs = [...new Set([...place(rounds(depth)).values()].map((point) => point.x))].sort(
        (a, b) => a - b,
      );
      for (let index = 1; index < xs.length; index += 1) {
        expect(xs[index]! - xs[index - 1]!).toBeGreaterThanOrEqual(250);
      }
      expect(Math.max(...xs)).toBeLessThanOrEqual(extent(rounds(depth)).width);
    }
  });

  it("is a pure function of the graph, so a status change moves nothing", () => {
    const before = place(workflow(5));
    const running: ResearchGraph = {
      ...workflow(5),
      nodes: workflow(5).nodes.map((n) =>
        n.id === "q2" ? { ...n, status: "running" as const, detail: "3 citations" } : n,
      ),
    };

    expect([...place(running).entries()]).toEqual([...before.entries()]);
  });

  it("places a graph that has arrived only in part", () => {
    // Deltas stream, so an edge can name a node that has not been announced.
    // Dropping the edge is right; throwing, or ranking against a node that does
    // not exist, would take the whole picture down mid-run.
    const partial: ResearchGraph = {
      nodes: [node("plan", "plan"), node("q0", "question")],
      edges: [
        { from: "plan", to: "q0" },
        { from: "q0", to: "reflect" },
      ],
    };

    const at = place(partial);
    expect([...at.keys()].sort()).toEqual(["plan", "q0"]);
    expect(at.get("plan")!.x).toBeLessThan(at.get("q0")!.x);
  });

  it("centres a graph with no edges yet rather than stacking it at the origin", () => {
    const at = place({ nodes: [node("plan", "plan")], edges: [] });

    expect(at.get("plan")).toEqual({ x: 500, y: 280 });
  });
});
