import {
  CONNECTOME_PERSONAS,
  COUPLING_LABELS,
  DEFAULT_CONNECTOME_WEIGHTS,
  RECENCY_WINDOW_DAYS,
  orderFindingsFor,
  type ConnectomeBundle,
  type ConnectomeEdge,
  type ConnectomeEvidence,
  type ConnectomeFinding,
  type ConnectomeGraph,
  type ConnectomeNode,
  type ConnectomeReport,
  type ConnectomeSelection,
  type CouplingComponent,
} from "@iq/shared";
import { mulberry32, type DemoIqCell } from "./fixtures.js";

/**
 * The Connectome analysis.
 *
 * Read-only and deterministic: the same selection, window and weight set
 * always produce the same graph, the same layout and the same report. Every
 * edge carries the evidence it was derived from, and a latent edge is a
 * hypothesis with citations — it grants nothing and changes no execution.
 */

const overlap = (a: readonly string[], b: readonly string[]): string[] =>
  a.filter((value) => b.includes(value));

// ── edges ─────────────────────────────────────────────────────────────────

const couplings = (a: DemoIqCell, b: DemoIqCell): ConnectomeEvidence[] => {
  const evidence: ConnectomeEvidence[] = [];

  const lineage = [
    ...overlap(a.producesArtifacts, b.consumesArtifacts),
    ...overlap(b.producesArtifacts, a.consumesArtifacts),
  ];
  if (lineage.length > 0) {
    evidence.push({
      component: "artifact_lineage",
      detail: `Hands over ${lineage.join(", ")}`,
      score: Math.min(1, lineage.length / 2),
    });
  }

  const paths = overlap(a.paths, b.paths);
  if (paths.length > 0) {
    evidence.push({
      component: "project_reach",
      detail: `Both declare ${paths.join(", ")}`,
      score: Math.min(1, paths.length / 2),
    });
  }

  const external = [...overlap(a.hosts, b.hosts), ...overlap(a.reach, b.reach)];
  if (external.length > 0) {
    evidence.push({
      component: "external_reach",
      detail: `Shared reach: ${external.join(", ")}`,
      score: Math.min(1, external.length / 3),
    });
  }

  const configuration = overlap(a.configuration, b.configuration);
  if (configuration.length > 0) {
    evidence.push({
      component: "shared_configuration",
      detail: `Shared: ${configuration.join(", ")}`,
      score: Math.min(1, configuration.length / 2),
    });
  }

  const hours = overlap(
    a.activeHours.map(String),
    b.activeHours.map(String),
  );
  if (hours.length > 0) {
    evidence.push({
      component: "co_activation",
      detail: `Runs in the same hours (${hours.join(", ")})`,
      score: Math.min(1, hours.length / 3),
    });
  }

  if (a.approver === b.approver) {
    evidence.push({
      component: "human_coupling",
      detail: `${a.approver} resolves both`,
      score: 0.6,
    });
  }

  return evidence;
};

const strengthOf = (
  evidence: readonly ConnectomeEvidence[],
  weights: Record<CouplingComponent, number>,
): number => {
  const total = evidence.reduce((sum, row) => sum + row.score * (weights[row.component] ?? 0), 0);
  const ceiling = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  return ceiling === 0 ? 0 : Math.min(1, total / ceiling);
};

// ── bundles ───────────────────────────────────────────────────────────────

/**
 * Label-propagation clustering over the weighted edges. Cheap, stable for a
 * fixed seed, and good enough to name the groups a reader can already see.
 *
 * Propagation runs over each IQ Cell's strongest ties, not all of them. On a
 * dense graph — and a coupling graph is dense, because most pairs share
 * *something* — propagating over every neighbour makes every node see the same
 * majority label and the whole selection collapses into one bundle. That was
 * not hypothetical: a capture of the real map showed twenty-six identically
 * coloured somata under a legend claiming colour meant group. Keeping only the
 * strongest ties is what lets a community survive being adjacent to a bigger
 * one.
 */
const NEIGHBOURS_KEPT = 4;

const cluster = (
  ids: readonly string[],
  edges: readonly ConnectomeEdge[],
  seed: number,
): Map<string, string> => {
  const random = mulberry32(seed);
  const label = new Map(ids.map((id) => [id, id]));
  const neighbours = new Map<string, { id: string; weight: number }[]>(ids.map((id) => [id, []]));
  for (const edge of edges) {
    neighbours.get(edge.source)?.push({ id: edge.target, weight: edge.strength });
    neighbours.get(edge.target)?.push({ id: edge.source, weight: edge.strength });
  }
  for (const [id, list] of neighbours) {
    // Ties are broken by id so the trim is deterministic rather than dependent
    // on the order the edges happened to be generated in.
    list.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
    neighbours.set(id, list.slice(0, NEIGHBOURS_KEPT));
  }

  const order = [...ids].sort(() => random() - 0.5);
  for (let pass = 0; pass < 12; pass += 1) {
    let moved = false;
    for (const id of order) {
      const tally = new Map<string, number>();
      for (const neighbour of neighbours.get(id) ?? []) {
        const key = label.get(neighbour.id) as string;
        tally.set(key, (tally.get(key) ?? 0) + neighbour.weight);
      }
      const best = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      if (best !== undefined && best[0] !== label.get(id)) {
        label.set(id, best[0]);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return label;
};

// ── layout ────────────────────────────────────────────────────────────────

/**
 * Seeded radial layout.
 *
 * Every bundle owns a **wedge** of the field, and the wedge's angle is
 * proportional to how many IQ Cells the bundle holds. Members fill their wedge
 * from the centre of the map out to its rim. Two properties follow, and both
 * are the point:
 *
 * - A bundle is still a *place*, so the reader can find a group by looking at
 *   one region rather than tracking a colour across the whole pane.
 * - Every wedge reaches the middle, so the middle carries nodes. The previous
 *   layout projected each node onto a rounded hull, which by construction
 *   evacuates the interior: measured on the demo library the centre of the map
 *   held nothing and the nodes sat in two arcs at the poles.
 *
 * The radius uses `sqrt`, which spreads members evenly over the wedge's *area*.
 * A linear radius crowds them at the apex and leaves the rim bare.
 *
 * Positions come out roughly inside the unit disc on x–z, which is the plane
 * the opening camera looks at. The scene rescales to its own envelope, so only
 * the proportions here matter.
 */
const layout = (
  nodes: readonly Omit<ConnectomeNode, "position">[],
  bundleIds: readonly string[],
  seed: number,
): Map<string, [number, number, number]> => {
  const random = mulberry32(seed);
  const positions = new Map<string, [number, number, number]>();
  const total = nodes.length || 1;
  let placed = 0;

  bundleIds.forEach((bundleId) => {
    const members = nodes.filter((node) => node.bundleId === bundleId);
    if (members.length === 0) return;

    const from = (placed / total) * Math.PI * 2;
    const to = ((placed + members.length) / total) * Math.PI * 2;
    placed += members.length;

    members.forEach((node, memberIndex) => {
      const radial = Math.sqrt((memberIndex + 0.3 + random() * 0.4) / members.length);
      // Inset from the wedge's own edges so neighbouring bundles do not merge
      // into one continuous band at the seam between them.
      const angle = from + (0.14 + random() * 0.72) * (to - from);
      const x = Math.cos(angle) * radial;
      const z = Math.sin(angle) * radial;
      // Enough y to give the field body; not so much that nodes hide behind
      // each other in the opening view.
      const y = (random() - 0.5) * 0.5;

      positions.set(node.id, [x, y, z]);
    });
  });

  return positions;
};

// ── analysis ──────────────────────────────────────────────────────────────

const hashOf = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

/**
 * Below this, a latent hypothesis is noise rather than a connection.
 *
 * 0.22. This has now been wrong in both directions and the second was worse.
 * At 0.16 a library of forty IQ Cells drew as a handful of tracts over an empty
 * field, which reads as "these things barely relate"; dropping it to 0.10
 * admitted the weakest half and the map went the other way — every cell
 * connected to nearly every other, additive fibres piling up until the whole
 * picture was a bright haze with no structure left to see.
 *
 * A graph where everything is connected carries the same amount of information
 * as one where nothing is: the bundles stop being visible, and the strong
 * couplings — the ones worth acting on — are lost inside the weak ones drawn
 * beside them. The floor is a claim about what counts as a finding, and it is
 * better to under-claim and say so. The report still names it, and the table
 * view is where an exhaustive reading belongs.
 */
export const LATENT_FLOOR = 0.22;

/**
 * The phases a run actually goes through, in order.
 *
 * Named because the progress the user watches has to describe real work. A bar
 * that advances on a timer while the whole computation happens in one blocking
 * call is a decoration, and on a surface whose entire claim is that its numbers
 * are reproducible, a decorated number is the worst thing to show.
 */
export const ANALYSIS_STAGES = [
  { key: "compare", label: "Comparing every pair on six declared signals" },
  { key: "group", label: "Grouping by strongest ties" },
  { key: "place", label: "Placing the cortex" },
  { key: "read", label: "Reading the result" },
] as const;
export type AnalysisStage = (typeof ANALYSIS_STAGES)[number]["key"];

interface Prepared {
  chosen: DemoIqCell[];
  weights: Record<CouplingComponent, number>;
  seed: number;
  hash: string;
}

const prepare = (
  library: readonly DemoIqCell[],
  selection: ConnectomeSelection,
): Prepared => {
  const chosen = library.filter((row) => selection.iqCellIds.includes(row.id));
  const weights = { ...DEFAULT_CONNECTOME_WEIGHTS, ...selection.weights };
  const hash = hashOf(
    JSON.stringify({
      ids: [...selection.iqCellIds].sort(),
      window: selection.windowDays,
      weights,
    }),
  );
  return { chosen, weights, seed: parseInt(hash, 16) >>> 0, hash };
};

/**
 * Compare one IQ Cell against every later one, appending the edges that clear
 * the floor.
 *
 * Split out so the staged and the synchronous paths run the *same* comparison
 * in the *same* order. Two implementations would drift, and a drifted one would
 * mean the picture depended on whether a progress bar was being watched.
 */
const pairFrom = (
  chosen: readonly DemoIqCell[],
  weights: Record<CouplingComponent, number>,
  i: number,
  edges: ConnectomeEdge[],
): void => {
  for (let j = i + 1; j < chosen.length; j += 1) {
    const a = chosen[i] as DemoIqCell;
    const b = chosen[j] as DemoIqCell;
    const structural = a.embeds.includes(b.id) || b.embeds.includes(a.id);
    const evidence = couplings(a, b);
    const strength = structural
      ? Math.max(0.75, strengthOf(evidence, weights))
      : strengthOf(evidence, weights);
    if (!structural && strength < LATENT_FLOOR) continue;

    const recency = 1 - Math.min(1, Math.max(a.lastRunDaysAgo, b.lastRunDaysAgo) / RECENCY_WINDOW_DAYS);
    edges.push({
      id: `${a.id}~${b.id}`,
      source: a.id,
      target: b.id,
      origin: structural ? "structural" : "latent",
      strength: Number(strength.toFixed(4)),
      recency: Number(recency.toFixed(4)),
      evidence: structural
        ? [
            {
              component: "shared_configuration",
              detail: "Embedded as a pinned IQ Cell node",
              score: 1,
            },
            ...evidence,
          ]
        : evidence,
      bundleId: null,
    });
  }
};

export const analyze = (
  library: readonly DemoIqCell[],
  selection: ConnectomeSelection,
): { graph: ConnectomeGraph; findings: ConnectomeFinding[] } => {
  const { chosen, weights, seed, hash } = prepare(library, selection);

  const edges: ConnectomeEdge[] = [];
  for (let i = 0; i < chosen.length; i += 1) pairFrom(chosen, weights, i, edges);

  return assemble(chosen, edges, seed, hash);
};

/**
 * The same analysis, run in awaited chunks so a progress reading can be honest.
 *
 * `onStage` is called with the phase and how far through it the run is. The
 * comparison phase is the only one with a meaningful fraction — it is the
 * O(n²) part — so the others report their own completion rather than
 * pretending to be smooth.
 *
 * Determinism is unaffected: the same helpers run in the same order, so a
 * staged run and a synchronous one produce byte-identical graphs. The tests
 * assert on the synchronous path and remain the specification.
 */
export const analyzeStaged = async (
  library: readonly DemoIqCell[],
  selection: ConnectomeSelection,
  onStage: (stage: AnalysisStage, fraction: number) => void,
  breathe: () => Promise<void>,
): Promise<{ graph: ConnectomeGraph; findings: ConnectomeFinding[] }> => {
  const { chosen, weights, seed, hash } = prepare(library, selection);

  const edges: ConnectomeEdge[] = [];
  const totalPairs = (chosen.length * (chosen.length - 1)) / 2 || 1;
  let compared = 0;

  onStage("compare", 0);
  for (let i = 0; i < chosen.length; i += 1) {
    pairFrom(chosen, weights, i, edges);
    compared += chosen.length - 1 - i;
    onStage("compare", compared / totalPairs);
    // Yield every row rather than every pair: a frame per pair would make the
    // run slower than the work it is reporting on.
    await breathe();
  }

  onStage("group", 0);
  await breathe();
  const result = assemble(chosen, edges, seed, hash);
  onStage("group", 1);

  onStage("place", 1);
  await breathe();
  onStage("read", 1);
  return result;
};

/**
 * Bundle hues, in degrees.
 *
 * The map is the product's visual signature, so the hues stay inside the
 * Prismatic Intelligence family — cyan, azure, indigo, violet, orange — rather
 * than being spread evenly around a rainbow. A run with more bundles than
 * entries here repeats a hue; that is safe because a bundle is named by its
 * label and its wedge, never by hue alone.
 */
const PRISMATIC_BUNDLE_HUES = [190, 220, 245, 270, 28] as const;

/**
 * Everything after the pair comparison: grouping, layout, findings.
 *
 * Shared by both entry points so the staged run cannot diverge from the
 * synchronous one.
 */
const assemble = (
  chosen: readonly DemoIqCell[],
  edges: ConnectomeEdge[],
  seed: number,
  hash: string,
): { graph: ConnectomeGraph; findings: ConnectomeFinding[] } => {
  const labels = cluster(
    chosen.map((row) => row.id),
    edges,
    seed,
  );

  const bundleIds = [...new Set([...labels.values()])].sort();
  const bundles: ConnectomeBundle[] = bundleIds.map((bundleId, index) => {
    const members = chosen.filter((row) => labels.get(row.id) === bundleId);
    const shared = members
      .flatMap((row) => [...row.configuration, ...row.paths, ...row.reach])
      .reduce<Map<string, number>>((tally, key) => tally.set(key, (tally.get(key) ?? 0) + 1), new Map());
    const shares = [...shared.entries()]
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([key]) => key);
    const totalCost = chosen.reduce((sum, row) => sum + row.tokensPerRun * row.runs, 0) || 1;
    const totalRuns = chosen.reduce((sum, row) => sum + row.runs, 0) || 1;

    return {
      id: bundleId,
      name: shares[0] ?? (members[0]?.name.split(" ")[0] ?? `Bundle ${index + 1}`),
      members: members.map((row) => row.id),
      shares,
      hue: PRISMATIC_BUNDLE_HUES[index % PRISMATIC_BUNDLE_HUES.length] ?? 220,
      costShare:
        members.reduce((sum, row) => sum + row.tokensPerRun * row.runs, 0) / totalCost,
      runShare: members.reduce((sum, row) => sum + row.runs, 0) / totalRuns,
    };
  });

  const bare = chosen.map((row) => ({
    id: row.id,
    name: row.name,
    version: row.version,
    faces: row.faces,
    runs: row.runs,
    completionRate: row.completionRate,
    tokensPerRun: row.tokensPerRun,
    reach: row.reach,
    bundleId: labels.get(row.id) ?? null,
    // Carried onto the node rather than left in the fixtures, because the time
    // lapse plays the *graph* and had no clock of its own: the edges knew when
    // they were last active and the nodes did not, so a played-back picture
    // could grow its tracts and not its cells.
    lastRunDaysAgo: row.lastRunDaysAgo,
  }));

  const positions = layout(bare, bundleIds, seed);
  const nodes: ConnectomeNode[] = bare.map((node) => ({
    ...node,
    position: positions.get(node.id) ?? [0, 0, 0],
  }));

  for (const edge of edges) {
    const a = labels.get(edge.source);
    edge.bundleId = a !== undefined && a === labels.get(edge.target) ? a : null;
  }

  const graph: ConnectomeGraph = { nodes, edges, bundles, hash, seed };
  return { graph, findings: findingsFor(chosen, graph) };
};

// ── findings ──────────────────────────────────────────────────────────────

const findingsFor = (
  library: readonly DemoIqCell[],
  graph: ConnectomeGraph,
): ConnectomeFinding[] => {
  const findings: ConnectomeFinding[] = [];
  const degree = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  // Redundancy: two IQ Cells coupled on lineage and configuration are doing
  // close to the same job twice.
  for (const edge of graph.edges) {
    const kinds = new Set(edge.evidence.map((row) => row.component));
    if (edge.strength < 0.55 || !kinds.has("artifact_lineage") || !kinds.has("shared_configuration"))
      continue;
    const a = graph.nodes.find((node) => node.id === edge.source);
    const b = graph.nodes.find((node) => node.id === edge.target);
    if (a === undefined || b === undefined) continue;
    findings.push({
      kind: "redundancy",
      title: `${a.name} and ${b.name} overlap`,
      detail: `Coupled at ${(edge.strength * 100).toFixed(0)}% on ${edge.evidence
        .map((row) => COUPLING_LABELS[row.component])
        .join(", ")}.`,
      cites: [edge.id],
      action: "Extract the shared step into one IQ Cell and reference it from both.",
    });
  }

  // Fragility: a hub with a weak completion rate takes a lot down with it.
  for (const node of graph.nodes) {
    if ((degree.get(node.id) ?? 0) < 6 || node.completionRate > 0.8) continue;
    findings.push({
      kind: "fragility",
      title: `${node.name} is a fragile hub`,
      detail: `${degree.get(node.id)} connections at a ${(node.completionRate * 100).toFixed(0)}% completion rate.`,
      cites: [node.id],
      action: "Add a retry policy and narrow its reach before more IQ Cells depend on it.",
    });
  }

  // Cost concentration.
  const totalCost = graph.nodes.reduce((sum, node) => sum + node.tokensPerRun * node.runs, 0) || 1;
  for (const node of graph.nodes) {
    const share = (node.tokensPerRun * node.runs) / totalCost;
    if (share < 0.18) continue;
    findings.push({
      kind: "cost_concentration",
      title: `${node.name} is ${(share * 100).toFixed(0)}% of spend`,
      detail: `${node.runs} runs at ~${node.tokensPerRun.toLocaleString()} tokens each.`,
      cites: [node.id],
      action: "Add a budget guard, or move its bulk steps to a cheaper model role.",
    });
  }

  // Permission concentration.
  const byReach = new Map<string, string[]>();
  for (const node of graph.nodes) {
    for (const reach of node.reach) {
      byReach.set(reach, [...(byReach.get(reach) ?? []), node.id]);
    }
  }
  for (const [reach, holders] of byReach) {
    if (holders.length < Math.max(4, graph.nodes.length * 0.45)) continue;
    findings.push({
      kind: "permission_concentration",
      title: `${holders.length} IQ Cells reach ${reach}`,
      detail: "A grant this widely held is hard to revoke without breaking work.",
      cites: holders,
      action: "Route the access through one IQ Cell and reference it from the rest.",
    });
  }

  // Stale pins and orphans.
  for (const row of library) {
    if (row.pinnedVersionsBehind === 0) continue;
    findings.push({
      kind: "stale_pin",
      title: `${row.name} is ${row.pinnedVersionsBehind} version(s) behind`,
      detail: "The pinned version keeps running; the successor is not adopted.",
      cites: [row.id],
      action: "Redraw it against the declared successor.",
    });
  }
  for (const node of graph.nodes) {
    if ((degree.get(node.id) ?? 0) > 0) continue;
    findings.push({
      kind: "orphan",
      title: `${node.name} is isolated`,
      detail: "No structural or latent coupling to anything else in the selection.",
      cites: [node.id],
      action: "Confirm it is still needed, or fold it into a neighbouring bundle.",
    });
  }

  return findings;
};

// ── report ────────────────────────────────────────────────────────────────

const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;

export const buildReport = (
  selection: ConnectomeSelection,
  graph: ConnectomeGraph,
  findings: readonly ConnectomeFinding[],
): ConnectomeReport => {
  const lens = CONNECTOME_PERSONAS[selection.persona];
  const ordered = orderFindingsFor(selection.persona, findings);

  const nameOf = (id: string): string =>
    graph.nodes.find((node) => node.id === id)?.name ??
    graph.edges.find((edge) => edge.id === id)?.id ??
    id;

  const degree = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const strongest = [...graph.edges].sort((a, b) => b.strength - a.strength).slice(0, 8);
  const hubs = [...graph.nodes]
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, 5);
  const density =
    graph.nodes.length < 2
      ? 0
      : (2 * graph.edges.length) / (graph.nodes.length * (graph.nodes.length - 1));

  const limits = [
    "Run history is generated demo data, not telemetry from this device.",
    "Latent edges are hypotheses derived from declared reach and timing; they are not evidence of a call.",
    "Artifact contents were never read — only identities and relationships.",
    `Couplings below ${LATENT_FLOOR} strength were treated as noise and excluded.`,
    lens.blindSpot,
  ];

  const markdown = [
    `# My IQ — ${graph.nodes.length} IQ Cells`,
    "",
    `Graph \`${graph.hash}\` · window ${selection.windowDays} days · persona ${lens.label} · demo data.`,
    "",
    "## Persona",
    `- **${lens.label}** — ${lens.question}`,
    "- The findings below are ordered for that reader. None are hidden, and the graph is unchanged: the same selection gives the same hash whoever is reading it.",
    "",
    "## Legend",
    "- **Colour** — fibre direction (red left–right, green front–back, blue up–down), tinted by bundle.",
    "- **Thickness** — connection strength. **Solid** structural, **dashed** latent.",
    "- **Saturation** — recency. **Node size** — run volume. **Node ring** — completion rate.",
    "",
    "## Selection and weights",
    `- ${graph.nodes.length} IQ Cells, ${graph.edges.length} connections, ${graph.bundles.length} bundles.`,
    ...Object.entries(selection.weights).map(
      ([component, weight]) =>
        `- ${COUPLING_LABELS[component as CouplingComponent]}: ${Number(weight).toFixed(2)}`,
    ),
    "",
    "## Shape",
    `- Density ${density.toFixed(3)}.`,
    `- Structural edges ${graph.edges.filter((edge) => edge.origin === "structural").length}, latent ${graph.edges.filter((edge) => edge.origin === "latent").length}.`,
    `- Isolates ${graph.nodes.filter((node) => (degree.get(node.id) ?? 0) === 0).length}.`,
    "",
    "## Bundles",
    ...graph.bundles.map(
      (bundle) =>
        `- **${bundle.name}** — ${bundle.members.length} members, ${percent(bundle.costShare)} of cost, ${percent(bundle.runShare)} of runs. Shares: ${bundle.shares.join(", ") || "—"}.`,
    ),
    "",
    "## Strongest connections",
    ...strongest.map(
      (edge) =>
        `- ${nameOf(edge.source)} ↔ ${nameOf(edge.target)} — ${percent(edge.strength)} (${edge.origin}): ${edge.evidence.map((row) => row.detail).join("; ")}`,
    ),
    "",
    "## Hubs",
    ...hubs.map(
      (node) =>
        `- ${node.name} — ${degree.get(node.id)} connections, ${percent(node.completionRate)} completion.`,
    ),
    "",
    "## Findings",
    ...(ordered.length === 0
      ? ["- Nothing to report for this selection."]
      : ordered.map(
          (finding) =>
            `- **${finding.title}** (${finding.kind.replace(/_/g, " ")}) — ${finding.detail}\n  - Next step: ${finding.action}`,
        )),
    "",
    "## Coverage and limits",
    ...limits.map((limit) => `- ${limit}`),
    "",
  ].join("\n");

  return {
    selection,
    graph,
    findings: ordered,
    limits,
    markdown,
    generatedAt: new Date().toISOString(),
  };
};

