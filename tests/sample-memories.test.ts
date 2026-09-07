import { describe, expect, it } from "vitest";
import { MemoryRecord } from "@iq/shared";
import { SAMPLE_MEMORIES, isSampleMemory } from "../packages/core/src/samples/memories.js";

/**
 * The demo memory set goes straight into the store rather than through
 * `record`, so nothing else validates it. A record that fails to parse would be
 * skipped on load and the demo step it belongs to would silently do nothing.
 */
describe("sample memories", () => {
  it("every record parses as a MemoryRecord", () => {
    for (const sample of SAMPLE_MEMORIES) {
      expect(MemoryRecord.safeParse(sample).success).toBe(true);
    }
  });

  it("keeps the review queue short enough to work through", () => {
    const count = (status: string): number =>
      SAMPLE_MEMORIES.filter((row) => row.status === status).length;

    // Pinned, because the pane's notice and the system test plan quote these
    // numbers and a reader who finds a different queue stops trusting the rest.
    //
    // The queue is deliberately short. A demo has to show the review step, but
    // a wall of proposals is not a demonstration of review — it is a chore, and
    // the first thing anyone does with one is stop reading it.
    expect(count("pending")).toBe(2);
    expect(count("pending")).toBeLessThan(3);
    expect(count("approved")).toBe(6);
    expect(count("rejected")).toBe(1);
  });

  it("puts both scopes in the review queue", () => {
    // One project-scoped and one user-scoped, so the scope pill is not a
    // control the demo never exercises.
    const scopes = SAMPLE_MEMORIES.filter((row) => row.status === "pending").map(
      (row) => row.scope,
    );
    expect(new Set(scopes)).toEqual(new Set(["project", "user"]));
  });

  it("exercises every durable memory type", () => {
    // A pill that only ever shows one value tells a reader nothing, and the
    // distinction the type draws is the one that decides whether a memory may
    // become a standing rule. All three must be reachable from the demo set.
    const types = new Set(SAMPLE_MEMORIES.map((row) => row.memoryType));
    expect(types).toEqual(new Set(["factual", "procedural", "episodic"]));
  });

  it("never compiles an episode into a convention", () => {
    // An episodic memory is true of one occasion. Approving one would put it in
    // front of the curator, which compiles approved memories into skills — so
    // the set must not ship an approved episode, or the demo would teach the
    // exact mistake the type exists to prevent.
    const episodes = SAMPLE_MEMORIES.filter((row) => row.memoryType === "episodic");
    expect(episodes.length).toBeGreaterThan(0);
    for (const episode of episodes) expect(episode.status).not.toBe("approved");
  });

  it("never claims a person decided one", () => {
    for (const sample of SAMPLE_MEMORIES) {
      if (sample.status === "pending") {
        expect(sample.decidedBy).toBeNull();
        expect(sample.decidedAt).toBeNull();
        continue;
      }
      // Approved and rejected samples are settled so Compile is reachable
      // without an Entra sign-in. They must say plainly that no person decided
      // them: a plausible object id here would be a forged approval.
      expect(sample.decidedBy?.oid).toBe("sample-data");
      expect(sample.decidedAt).not.toBeNull();
    }
  });

  it("uses fixed ids so loading twice adds nothing", () => {
    const ids = SAMPLE_MEMORIES.map((sample) => sample.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => isSampleMemory(id))).toBe(true);
    expect(isSampleMemory("mem_01H8XYZ")).toBe(false);
  });

  it("matches the IQ Memories cells the demo library names", () => {
    const approved = SAMPLE_MEMORIES.filter((row) => row.status === "approved").map(
      (row) => `Apply: ${row.subject}`,
    );

    // Compiling one memory names the cell `Apply: <subject>`, so a demo library
    // cell that names a convention absent from the store would describe a
    // project this one has never heard of.
    expect(approved).toContain("Apply: how we name project changes");
    expect(approved).toContain("Apply: what never goes in a customer update");
    expect(approved).toContain("Apply: which contract terms need legal review");
  });
});
