import type { DemoIqCell } from "../connectome/fixtures.js";
import { reconcileCells } from "../flow/reconcile.js";
import { INDUSTRY_PRIMERS } from "./primers.js";

/**
 * The industry primers, as IQ Cells.
 *
 * They belong in the library and on My IQ for the same reason the
 * knowledge and memory cells do: a library that lists only what was drawn on a
 * canvas is asserting that the other surfaces do not produce anything. A primer
 * compiled into a cell is the thing an agent can be asked to summarize, and the
 * map's whole claim is that it shows how the body of work hangs together, so the
 * domain briefs cannot be missing from it.
 *
 * Deliberately **not** part of `generateLibrary()`. That is the seeded demo
 * library, and it is switched off with Control Center → Sample data. These are
 * shipped product content: documents that are in the app whether or not
 * anyone wants the worked examples, so they are added alongside it rather than
 * inside it.
 *
 * Everything declared here is a fact about the primer or about the cell
 * compiled from it — the file it reads, the model role it answers with, the web
 * check it runs. Nothing is invented telemetry, which is why `runs` is 0 and
 * the demo counters stay empty: these have never been run.
 */
export const industryCells = (): DemoIqCell[] =>
  INDUSTRY_PRIMERS.map((primer, index) => ({
    id: `iqcell_i${index.toString().padStart(2, "0")}`,
    name: `Brief me on ${primer.title}`,
    version: 1,
    faces: ["node"],
    origin: "industry",
    originRef: [primer.id],
    runs: 0,
    completionRate: 1,
    tokensPerRun: 0,
    /**
     * The web check is real — the draft carries a `web_iq` step — and it is
     * what couples a domain brief to every other cell that reads the open web.
     * A primer is a snapshot, so a brief drawn from one without asking what has
     * moved since would be confidently out of date.
     */
    reach: ["Web (governed browser)"],
    embeds: [],
    producesArtifacts: [],
    consumesArtifacts: [],
    paths: [`industry/${primer.id}.md`],
    hosts: [],
    configuration: ["o3 (Foundry)"],
    approver: "system",
    activeHours: [],
    lastRunDaysAgo: 0,
    pinnedVersionsBehind: 0,
  }));

/**
 * Put the primers in the IQ Cell library, and keep them there.
 *
 * Ungated, unlike the demo library: the sample flag answers "is any of what I
 * am looking at made up?", and these are not. Deleting one still sticks — the
 * removal is remembered exactly as it is for any other declared cell — because
 * a library the user cannot prune is a feed.
 */
export const reconcileIndustryIqCells = (projectId: string | null): number =>
  reconcileCells(projectId, industryCells());
