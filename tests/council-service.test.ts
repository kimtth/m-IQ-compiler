import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { councilRunTitle } from "@iq/shared";
import {
  resolveAppPaths,
  ensureAppPaths,
  type AppPaths,
} from "../packages/core/src/config/paths.js";
import { AuditLog } from "../packages/core/src/audit/audit-log.js";
import { createLogger } from "../packages/core/src/util/logger.js";
import {
  CouncilService,
  type CouncilDeps,
} from "../packages/core/src/council/council-service.js";
import type { AgentRunResult } from "../packages/core/src/research/research-service.js";
import { titleForLabel } from "../packages/core/src/runtime/agent-run.js";

const TMP_BASE = join(dirname(fileURLToPath(import.meta.url)), ".tmp");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error("condition not met before timeout");
}

/** A chair reply that always returns a valid verdict; members return a line. */
const verdictJson = JSON.stringify({
  recommendation: "Do X",
  criteria: ["value", "risk"],
  strongestFor: "X ships fastest",
  strongestAgainst: "X carries the most risk",
  dissent: [{ memberId: "skeptic", memberName: "", position: "X is too risky" }],
  confidence: "high",
  openQuestions: ["how is X monitored"],
});

describe("CouncilService", () => {
  let dir: string;
  let paths: AppPaths;
  const logger = createLogger("error");

  beforeEach(() => {
    if (!existsSync(TMP_BASE)) mkdirSync(TMP_BASE, { recursive: true });
    dir = mkdtempSync(join(TMP_BASE, "council-"));
    paths = resolveAppPaths(dir);
    ensureAppPaths(paths);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeService(
    overrides: Partial<CouncilDeps> = {},
    runAgent?: (prompt: string) => AgentRunResult,
  ): CouncilService {
    return new CouncilService({
      logger,
      audit: new AuditLog(paths),
      paths,
      runAgent: async ({ prompt }) => {
        if (runAgent) return runAgent(prompt);
        if (prompt.includes('"recommendation"')) return { text: verdictJson, toolCalls: [] };
        if (prompt.includes('"converged"')) return { text: '{"converged": false}', toolCalls: [] };
        return { text: "An argument.", toolCalls: [] };
      },
      resolveModel: async () => ({ id: "copilot:test", displayName: "Test" }),
      projectDir: () => null,
      correlationId: () => "cor_test",
      sessionGrant: () => ["browser"],
      ...overrides,
    });
  }

  const roster = [
    { id: "advocate", name: "Advocate", stance: "for", modelId: "", skills: [], toolFamilies: ["browser", "m365.mail"] },
    { id: "skeptic", name: "Skeptic", stance: "against", modelId: "", skills: [], toolFamilies: ["m365.mail"] },
  ];

  it("narrows a member's tool grant to the session grant at run start", async () => {
    const service = makeService({ sessionGrant: () => ["browser"] });
    const run = await service.start({
      question: "X or Y?",
      members: roster,
      roundBudget: 1,
    } as never);

    const advocate = run.members.find((m) => m.name === "Advocate");
    const skeptic = run.members.find((m) => m.name === "Skeptic");
    // Advocate asked for browser + m365.mail; only browser is in the session grant.
    expect(advocate?.toolFamilies).toEqual(["browser"]);
    // Skeptic asked only for m365.mail, which the session does not hold: emptied.
    expect(skeptic?.toolFamilies).toEqual([]);

    // Drain the background debate so it does not outlive the test.
    await waitUntil(async () => {
      const r = await service.get(run.id);
      return r?.status === "complete" || r?.status === "cancelled" || r?.status === "failed";
    });
  });

  it("names a run without touching what it was asked", async () => {
    const service = makeService();
    const run = await service.start({
      question: "Do we ship X or Y first, and what do we give up either way?",
      members: roster,
      roundBudget: 1,
    } as never);

    // A fresh run has no name of its own and is called by its question.
    expect(run.title).toBe("");
    expect(councilRunTitle(run)).toBe(run.question);

    const named = await service.rename(run.id, "  Ship order   decision.  ");
    // Normalised like a conversation title: collapsed, trailing punctuation
    // dropped, so the rail and the picker read the same way.
    expect(named.title).toBe("Ship order decision");
    expect(councilRunTitle(named)).toBe("Ship order decision");
    // The question is provenance. It is quoted in the transcript, the verdict
    // and the audit record, so renaming must never rewrite it.
    expect(named.question).toBe(run.question);

    // Blank clears the name rather than setting an empty one, which is what
    // puts the run back to being called by its question.
    const cleared = await service.rename(run.id, "   ");
    expect(cleared.title).toBe("");
    expect(councilRunTitle(cleared)).toBe(run.question);

    // Survives a reload: the name is on the persisted record, not in a map.
    await service.rename(run.id, "Ship order");
    expect((await service.get(run.id))?.title).toBe("Ship order");

    await waitUntil(async () => {
      const r = await service.get(run.id);
      return r?.status === "complete" || r?.status === "cancelled" || r?.status === "failed";
    });
  });

  it("names every headless turn it starts", async () => {
    const titles: string[] = [];
    const service = makeService({
      runAgent: async ({ prompt, label }) => {
        titles.push(titleForLabel(label));
        if (prompt.includes('"recommendation"')) return { text: verdictJson, toolCalls: [] };
        if (prompt.includes('"converged"')) return { text: '{"converged": false}', toolCalls: [] };
        return { text: "An argument.", toolCalls: [] };
      },
    });

    const run = await service.start({
      question: "X or Y?",
      members: roster,
      roundBudget: 1,
    } as never);

    await waitUntil(async () => (await service.get(run.id))?.status === "complete");

    // Every sub-agent session used to be called "Headless run", so one council
    // run left a dozen indistinguishable rows in the session store.
    expect(titles).not.toContain("Headless run");
    expect(titles.every((title) => title.startsWith("Council · "))).toBe(true);
    expect(titles).toContain("Council · Chair · opening round 0");
    expect(titles).toContain("Council · Advocate · opening round 0");
    expect(titles).toContain("Council · Skeptic · rebuttal round 1");
    expect(titles).toContain("Council · Chair · verdict");
  });

  it("applies forceVerdict at a round boundary without cutting a member off", async () => {
    const service = makeService();
    const run = await service.start({
      question: "big decision?",
      members: roster,
      roundBudget: 3,
    } as never);

    // Force the verdict immediately; the opening round must still run in full,
    // then the boundary picks it up and skips every rebuttal round.
    await service.forceVerdict(run.id);

    await waitUntil(async () => (await service.get(run.id))?.status === "complete");
    const done = await service.get(run.id);

    expect(done?.status).toBe("complete");
    expect(done?.verdict?.recommendation).toBe("Do X");
    // Opening statements from both members were recorded before the boundary.
    const openings = done?.contributions.filter(
      (c) => c.phase === "opening" && c.memberId !== "chair",
    );
    expect(openings).toHaveLength(2);
    // No rebuttal happened: the verdict was forced at the first boundary.
    expect(done?.contributions.some((c) => c.phase === "rebuttal")).toBe(false);
    expect(done?.roundsRun).toBe(0);
  });

  it("attributes dissent in the structured verdict", async () => {
    const service = makeService();
    const run = await service.start({ question: "attr?", members: roster, roundBudget: 1 } as never);
    await waitUntil(async () => (await service.get(run.id))?.status === "complete");

    const done = await service.get(run.id);
    expect(done?.verdict?.dissent).toHaveLength(1);
    // memberName was blank in the payload; it is filled from the roster by id.
    expect(done?.verdict?.dissent[0]?.memberName).toBe("Skeptic");
  });

  it("reloads a completed run from disk", async () => {
    const service = makeService();
    const run = await service.start({ question: "persist?", members: roster, roundBudget: 1 } as never);
    await waitUntil(async () => (await service.get(run.id))?.status === "complete");

    const reloaded = makeService();
    const fromDisk = await reloaded.get(run.id);
    expect(fromDisk?.question).toBe("persist?");
    expect(fromDisk?.status).toBe("complete");
    expect(fromDisk?.verdict?.recommendation).toBe("Do X");
  });

  it("exposes built-in presets and persists user presets", async () => {
    const service = makeService();
    const builtIns = await service.presets();
    expect(builtIns.some((p) => p.builtIn)).toBe(true);

    const saved = await service.savePreset({
      name: "My council",
      members: [
        { id: "member_a", name: "A", stance: "a", modelId: "", skills: [], toolFamilies: [] },
        { id: "member_b", name: "B", stance: "b", modelId: "", skills: [], toolFamilies: [] },
      ],
    });
    const after = await service.presets();
    expect(after.some((p) => p.id === saved.id && !p.builtIn)).toBe(true);

    await service.deletePreset(saved.id);
    expect((await service.presets()).some((p) => p.id === saved.id)).toBe(false);
    await expect(service.deletePreset("preset-design-tradeoff")).rejects.toThrow();
  });
});
