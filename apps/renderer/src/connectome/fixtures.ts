/**
 * Demo fixtures for My IQ.
 *
 * The beta has no run history to read, so the analysis runs over a generated
 * project of IQ Cells. Generation is seeded: the same seed always produces
 * the same library, which is what lets the map be deterministic and what makes
 * a scripted walkthrough repeatable.
 *
 * The scenario is a small organisation coordinating projects, customer work,
 * operations, quality checks and communications. The terms are deliberately
 * plain, so a reader can understand the hand-offs without knowing an industry.
 *
 * Every field here is something the real product already records — faces, run
 * counts, declared reach, artifact lineage, approvers. Nothing is invented
 * telemetry that would have to be newly instrumented later.
 */

export interface DemoIqCell {
  id: string;
  name: string;
  version: number;
  faces: string[];
  /**
   * Which surface recorded it. Two do — IQ Workflow, where a diagram is drawn
   * and published, and IQ Industry, whose primers ship with the app. The other
   * two values are kept because records written by earlier builds still carry
   * them and the library has to route them somewhere.
   */
  origin: "editor" | "knowledge" | "memory" | "industry";
  /**
   * What the origin surface needs to reopen the source. Only the surfaces
   * whose source cannot be recovered from the cell itself set it — today that
   * is IQ Industry, whose cells name the primer they belong to.
   */
  originRef?: string[];
  runs: number;
  completionRate: number;
  tokensPerRun: number;
  reach: string[];
  /** Structural: IQ Cells embedded as a pinned node. */
  embeds: string[];
  producesArtifacts: string[];
  consumesArtifacts: string[];
  paths: string[];
  hosts: string[];
  configuration: string[];
  approver: string;
  /** Hours of day the IQ Cell typically runs in, for co-activation. */
  activeHours: number[];
  /** Days since the last run, driving fibre saturation. */
  lastRunDaysAgo: number;
  pinnedVersionsBehind: number;
}

/** Deterministic PRNG. Small, dependency-free and stable across runs. */
export const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

interface Domain {
  name: string;
  /** Concrete, named pieces of work — not verb × noun combinations. */
  tasks: string[];
  reach: string[];
  paths: string[];
  hosts: string[];
  configuration: string[];
  approver: string;
  hours: number[];
}

/**
 * Names are concrete on purpose.
 *
 * These were previously assembled from a verb list and a noun list, which
 * produced things like "Rolling launch scan" and "Post- decision capture" —
 * grammatical, evocative and impossible to picture. A reader looking at the map
 * has to be able to tell what a node *does* from its label alone, because the
 * whole claim of My IQ is that it shows coupling between real
 * work. So each name states the job in the words the person who owns it would
 * use — here, the words a cross-functional team would use every day.
 *
 * The declarations matter as much as the names. Every domain used to list
 * "Foundry deployment" in its reach and a Foundry model in its configuration,
 * which is true of essentially every IQ Cell and therefore says nothing: the
 * measured result was that all 26 cells coupled to each other, label
 * propagation collapsed to a single bundle, and the map drew 26 identically
 * coloured somata under a legend claiming colour meant group. A signal that
 * everything declares is not a signal, so the shared ones are gone and the
 * overlap between domains is now partial rather than total.
 */
const DOMAINS: readonly Domain[] = [
  {
    name: "Projects",
    tasks: [
      "Write the weekly project update",
      "Track open changes until they are complete",
      "Flag project dates at risk",
      "Prepare the Monday leadership update",
      "Compare the plan with available time and budget",
      "Prepare the project readiness summary",
    ],
    reach: ["Project files", "Microsoft 365 calendar"],
    paths: ["projects/**", "reports/**"],
    hosts: [],
    configuration: ["Reasoning model (Foundry)", "skill:project-brief", "skill:officecli-pptx"],
    approver: "dana",
    hours: [7, 8, 9],
  },
  {
    name: "Customer support",
    tasks: [
      "Group similar customer requests",
      "Prepare a clear answer for a common question",
      "Track response time against the service goal",
      "Flag customer issues that could delay a project",
      "Summarise the main customer feedback themes",
      "Write the monthly support summary",
    ],
    reach: ["Microsoft 365 mail", "Project files"],
    paths: ["support/**", "reports/**"],
    hosts: ["graph.microsoft.com"],
    configuration: ["o3 (Foundry)", "skill:customer-summary"],
    approver: "ravi",
    hours: [2, 3, 22],
  },
  {
    name: "Operations",
    tasks: [
      "Review work waiting in the shared queue",
      "Follow up on overdue requests",
      "Compare options before a purchase decision",
      "Flag a task with only one available owner",
      "Roll up cost changes into the budget",
      "Summarise the weekly operations meeting",
    ],
    reach: ["Project files", "Microsoft 365 mail"],
    paths: ["operations/**", "budget/**"],
    hosts: ["graph.microsoft.com"],
    configuration: ["Fast model (Foundry)", "skill:officecli-xlsx"],
    approver: "mei",
    hours: [8, 9, 10, 14, 15, 16],
  },
  {
    name: "Quality review",
    tasks: [
      "Review failed checks from the daily work",
      "Chart work completed right the first time",
      "Open a follow-up when the same problem repeats",
      "Summarise the daily quality check-in",
      "Compare review results with rework time",
      "Write a short report on the main issue this week",
    ],
    reach: ["Business data", "Project files"],
    paths: ["quality/**", "operations/**", "data/**"],
    hosts: [],
    configuration: ["Fast model (Foundry)", "skill:issue-triage", "skill:officecli-xlsx"],
    approver: "ravi",
    hours: [5, 6, 13, 14, 21, 22],
  },
  {
    name: "Communications",
    tasks: [
      "Group repeated feedback into clear themes",
      "Flag a message that needs a follow-up",
      "Estimate the cost of a planned change",
      "Draft a customer update",
      "Watch public feedback for new concerns",
      "Prepare a decision brief for a major issue",
    ],
    reach: ["Web (governed browser)", "Microsoft 365 mail"],
    paths: ["communications/**", "feedback/**"],
    hosts: ["feedback.example.com", "graph.microsoft.com"],
    configuration: ["o3 (Foundry)", "skill:feedback-summary", "skill:officecli-pptx"],
    approver: "mei",
    hours: [9, 10, 11],
  },
];

const ARTIFACTS = [
  "reports/project-status.docx",
  "budget/cost-summary.xlsx",
  "reports/readiness-summary.pptx",
  "support/customer-themes.md",
  "operations/open-items.md",
  "quality/weekly-issue-summary.md",
  "data/feedback.csv",
  "communications/customer-update.json",
];

/** The people who sign off. Kept short so the same-approver signal has bite. */
const APPROVERS = ["dana", "ravi", "mei"];

/**
 * Cells that answer questions over the knowledge index.
 *
 * They read a corpus and answer from it, so their declarations are genuinely
 * different: the vault index instead of a trigger and a chain of steps, no
 * artifact written, and a documents path rather than a data one. That
 * difference is the point — My IQ couples them to the other cells
 * that read the same folders, which is a real hand-off and one nobody
 * declared.
 *
 * The paths are the sections of the vault in `sample-data/demo-project`, so
 * pointing IQ Knowledge at it makes these cells describe a corpus that is
 * actually there. Naming folders that do not exist is how a demo library and
 * the surface it claims to summarise end up disagreeing.
 */
const KNOWLEDGE_CELLS: readonly { name: string; paths: string[]; approver: string }[] = [
  { name: "Ask the team notes", paths: ["knowledge/teams/**"], approver: "ravi" },
  { name: "Ask the partner notes", paths: ["knowledge/partners/**"], approver: "mei" },
  {
    name: "Ask the process notes",
    paths: ["knowledge/processes/**", "knowledge/tools/**"],
    approver: "ravi",
  },
  { name: "Ask the project notes", paths: ["knowledge/projects/**"], approver: "dana" },
  { name: "Ask the issue notes", paths: ["knowledge/issues/**"], approver: "mei" },
];

/**
 * Cells that apply an approved convention.
 *
 * A convention applied to an input. They reach nothing and write nothing,
 * which is why they show on the map as small, cheap and heavily connected —
 * a rule that everything obeys couples to everything that obeys it.
 *
 * The names match the sample memories in
 * `packages/core/src/memory/samples.ts`: `Apply: <subject>` for one,
 * `Apply N conventions` for a set. Naming them anything else would leave the
 * library describing conventions that the memory store has never heard of.
 */
const MEMORY_CELLS: readonly { name: string; approver: string }[] = [
  { name: "Apply: how we name project changes", approver: "dana" },
  { name: "Apply: what never goes in a customer update", approver: "mei" },
  { name: "Apply: which contract terms need legal review", approver: "mei" },
  { name: "Apply 3 conventions", approver: "ravi" },
];

const pick = <T>(random: () => number, rows: readonly T[]): T =>
  rows[Math.floor(random() * rows.length)] as T;

/**
 * Generate a project of IQ Cells.
 *
 * The domains overlap deliberately — shared paths, shared model deployments,
 * shared approvers, artifacts handed from one to the next — because the point
 * of My IQ is to surface coupling that no single IQ Cell
 * declares. In this scenario, a reader can see how project, operations and
 * quality work share files, skills and approvals.
 */
export const generateLibrary = (seed = 20260729, count = 26): DemoIqCell[] => {
  const random = mulberry32(seed);
  const rows: DemoIqCell[] = [];

  for (let index = 0; index < count; index += 1) {
    const domain = DOMAINS[index % DOMAINS.length] as Domain;
    // Deal the tasks round-robin rather than sampling them, so every IQ Cell in
    // the library is a different job and no name is ever a near-duplicate of
    // another. The two discarded draws keep the random stream — and therefore
    // every other generated property — identical to before this was curated.
    random();
    random();
    const round = Math.floor(index / DOMAINS.length);
    const name = domain.tasks[round % domain.tasks.length] as string;
    const runs = Math.floor(4 + random() * 260);
    rows.push({
      id: `iqcell_${index.toString().padStart(2, "0")}`,
      name: rows.some((row) => row.name === name) ? `${name} ${index}` : name,
      version: 1 + Math.floor(random() * 6),
      faces: random() > 0.55 ? ["automation", "node"] : random() > 0.5 ? ["skill", "node"] : ["node"],
      origin: "editor",
      runs,
      completionRate: Math.min(1, 0.62 + random() * 0.4),
      tokensPerRun: Math.floor(800 + random() * 34000),
      reach: domain.reach.filter(() => random() > 0.25),
      embeds: [],
      producesArtifacts: [pick(random, ARTIFACTS)],
      consumesArtifacts: random() > 0.45 ? [pick(random, ARTIFACTS)] : [],
      paths: domain.paths.filter(() => random() > 0.3),
      hosts: domain.hosts.filter(() => random() > 0.4),
      configuration: domain.configuration.filter(() => random() > 0.35),
      approver: random() > 0.8 ? pick(random, APPROVERS) : domain.approver,
      activeHours: domain.hours.filter(() => random() > 0.3),
      lastRunDaysAgo: Math.floor(random() * 45),
      pinnedVersionsBehind: random() > 0.82 ? 1 + Math.floor(random() * 3) : 0,
    });
  }

  // Question-and-answer cells over the vault. No trigger, no artifact, and the
  // vault index as their reach.
  KNOWLEDGE_CELLS.forEach((entry, offset) => {
    rows.push({
      id: `iqcell_k${offset.toString().padStart(2, "0")}`,
      name: entry.name,
      version: 1 + Math.floor(random() * 3),
      faces: ["node"],
      origin: "editor",
      runs: Math.floor(6 + random() * 120),
      completionRate: Math.min(1, 0.8 + random() * 0.2),
      tokensPerRun: Math.floor(1200 + random() * 9000),
      reach: ["Vault index"],
      embeds: [],
      producesArtifacts: [],
      consumesArtifacts: [],
      paths: entry.paths,
      hosts: [],
      configuration: [random() > 0.5 ? "Reasoning model (Foundry)" : "Fast model (Foundry)"],
      approver: entry.approver,
      activeHours: [9, 10, 11, 14, 15],
      lastRunDaysAgo: Math.floor(random() * 20),
      pinnedVersionsBehind: 0,
    });
  });

  // Convention cells. A rule applied to an input: reaches nothing, writes
  // nothing, and is cheap enough to sit inside anything else.
  MEMORY_CELLS.forEach((entry, offset) => {
    rows.push({
      id: `iqcell_m${offset.toString().padStart(2, "0")}`,
      name: entry.name,
      version: 1 + Math.floor(random() * 4),
      faces: ["node"],
      origin: "editor",
      runs: Math.floor(20 + random() * 240),
      completionRate: Math.min(1, 0.9 + random() * 0.1),
      tokensPerRun: Math.floor(300 + random() * 2200),
      reach: random() > 0.5 ? ["Vault index"] : [],
      embeds: [],
      producesArtifacts: [],
      consumesArtifacts: [],
      paths: [],
      hosts: [],
      configuration: ["o3 (Foundry)"],
      approver: entry.approver,
      activeHours: [],
      lastRunDaysAgo: Math.floor(random() * 12),
      pinnedVersionsBehind: 0,
    });
  });

  // Structural embeds: a handful of IQ Cells call another as a pinned node. A
  // convention cell is the natural thing to embed, so those are offered first.
  // Identified by their id prefix, which is stable and costs no random draw.
  for (const row of rows) {
    if (random() > 0.42) continue;
    const conventions = rows.filter((candidate) => candidate.id.startsWith("iqcell_m"));
    const target = random() > 0.45 ? pick(random, conventions) : pick(random, rows);
    if (target.id === row.id || target.embeds.includes(row.id)) continue;
    row.embeds.push(target.id);
  }

  return rows;
};

