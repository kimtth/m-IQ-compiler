/**
 * A generated, plain-language demo knowledge vault.
 *
 * The sample shows how an Obsidian-style knowledge graph is built without
 * assuming that the reader knows a specialist industry. Its organisation has
 * ordinary teams, projects, processes, tools, partners and open issues.
 */

export interface SampleNote {
  readonly path: string;
  readonly text: string;
}

const SECTIONS = {
  teams: [
    "Project team", "Customer team", "Operations team", "Quality team",
    "Finance team", "Legal team", "Technology team", "Leadership team",
  ],
  workstreams: [
    "Planning", "Customer requests", "Daily operations", "Quality checks", "Budget tracking",
    "Contract review", "System updates", "Team communications", "Training", "Reporting",
  ],
  processes: [
    "Plan a project", "Answer a customer request", "Review daily work", "Check completed work",
    "Approve a purchase", "Review a contract", "Handle a change", "Share an update",
    "Train a new team member", "Close an issue",
  ],
  policies: [
    "Change naming", "Customer updates", "Data access", "Purchase approval",
    "Contract checks", "Issue tracking", "Meeting notes", "File storage",
  ],
  tools: [
    "Project board", "Shared inbox", "Work queue", "Review checklist", "Budget sheet",
    "Contract folder", "Team calendar", "Report template",
  ],
  partners: [
    "Bright Path", "Clear View", "North Star", "Open Hands", "Good Works", "Common Ground",
    "First Step", "Shared Way",
  ],
  projects: ["Customer portal", "Service improvement", "Office move", "New team training"],
  issues: [
    "Late response", "Missing information", "Repeated error", "Unclear owner", "Budget change",
    "Approval delay", "Outdated document", "Training gap", "Customer concern", "System outage",
  ],
  people: ["dana", "ravi", "mei"],
} as const;

type Section = keyof typeof SECTIONS;

const TAGS: Record<Section | "records", readonly string[]> = {
  teams: ["team", "people"],
  workstreams: ["work", "planning"],
  processes: ["process", "how-we-work"],
  policies: ["policy", "guidance"],
  tools: ["tool", "work"],
  partners: ["partner", "relationship"],
  projects: ["project", "planning"],
  issues: ["issue", "quality"],
  people: ["owner"],
  records: ["record", "project"],
};

const CATEGORIES: Record<Section | "records", string> = {
  teams: "Teams",
  workstreams: "Work areas",
  processes: "Ways of working",
  policies: "Guidance",
  tools: "Tools",
  partners: "Partners",
  projects: "Projects",
  issues: "Open issues",
  people: "People",
  records: "Project records",
};

const ALIASES: Record<string, readonly string[]> = {
  "Project team": ["Project group"],
  "Customer team": ["Support team"],
  "Daily operations": ["Daily work"],
  "Quality checks": ["Reviews"],
  "Project board": ["Board"],
  "Shared inbox": ["Inbox"],
  "Customer portal": ["Portal"],
  "System outage": ["Service interruption"],
};

const slug = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const link = (target: string, label?: string): string =>
  label && label !== target ? `[[${target}|${label}]]` : `[[${target}]]`;

interface NoteSpec {
  section: Section | "records";
  title: string;
  connected: readonly string[];
  summary: string;
  body: readonly { heading: string; text: string }[];
}

const render = (spec: NoteSpec): string => {
  const aliases = ALIASES[spec.title] ?? [];
  return [
    "---",
    `title: "${spec.title}"`,
    ...(aliases.length > 0 ? ["aliases:", ...aliases.map((alias) => `  - "${alias}"`)] : []),
    "tags:",
    ...TAGS[spec.section].map((tag) => `  - ${tag}`),
    `category: "${CATEGORIES[spec.section]}"`,
    "---",
    "",
    `# ${spec.title}`,
    "",
    "> [!abstract] Reference note",
    `> ${spec.summary}`,
    "",
    "## Connected concepts",
    "",
    ...spec.connected.map((target) => `- ${link(target)}`),
    "",
    "---",
    "",
    ...spec.body.flatMap(({ heading, text }) => [`## ${heading}`, "", text, ""]),
    ...(spec.title === "Customer portal"
      ? ["## Related file", "", "See [the planning note](../workstreams/planning.md) for the first set of tasks.", ""]
      : []),
  ].join("\n");
};

const pick = <T>(rows: readonly T[], index: number): T => rows[index % rows.length] as T;

function build(): SampleNote[] {
  const notes: SampleNote[] = [];
  const add = (spec: NoteSpec): void => {
    notes.push({ path: `${spec.section}/${slug(spec.title)}.md`, text: render(spec) });
  };

  for (const [index, team] of SECTIONS.teams.entries()) {
    const work = pick(SECTIONS.workstreams, index);
    const project = pick(SECTIONS.projects, index);
    const policy = pick(SECTIONS.policies, index);
    add({
      section: "teams",
      title: team,
      connected: [work, project, policy],
      summary: `What the ${team.toLowerCase()} owns and how it works with the rest of the organisation.`,
      body: [
        { heading: "Purpose", text: `The ${team.toLowerCase()} leads ${link(work, work.toLowerCase())} for ${link(project, project.toLowerCase())}.` },
        { heading: "Working agreement", text: `The team follows ${link(policy, policy.toLowerCase())} and records decisions where everyone can find them.` },
      ],
    });
  }

  for (const [index, work] of SECTIONS.workstreams.entries()) {
    const team = pick(SECTIONS.teams, index);
    const process = pick(SECTIONS.processes, index);
    const tool = pick(SECTIONS.tools, index);
    const issue = pick(SECTIONS.issues, index);
    add({
      section: "workstreams",
      title: work,
      connected: [team, process, tool, issue],
      summary: `The shared work area for ${work.toLowerCase()}.`,
      body: [
        { heading: "How work moves", text: `${link(team)} uses ${link(process, process.toLowerCase())} and tracks the work in ${link(tool, tool.toLowerCase())}.` },
        { heading: "Attention", text: `The current example to watch is ${link(issue, issue.toLowerCase())}.` },
      ],
    });
  }

  for (const [index, process] of SECTIONS.processes.entries()) {
    const tool = pick(SECTIONS.tools, index + 1);
    const policy = pick(SECTIONS.policies, index);
    const issue = pick(SECTIONS.issues, index + 2);
    add({
      section: "processes",
      title: process,
      connected: [tool, policy, issue],
      summary: `Simple steps for how the team handles ${process.toLowerCase()}.`,
      body: [
        { heading: "Steps", text: `Use ${link(tool, tool.toLowerCase())}, follow ${link(policy, policy.toLowerCase())}, and make the next owner clear.` },
        { heading: "When it goes wrong", text: `If work is blocked, record ${link(issue, issue.toLowerCase())} and agree on the next step.` },
      ],
    });
  }

  for (const [index, policy] of SECTIONS.policies.entries()) {
    const process = pick(SECTIONS.processes, index);
    const project = pick(SECTIONS.projects, index);
    add({
      section: "policies",
      title: policy,
      connected: [process, project],
      summary: `Plain guidance for ${policy.toLowerCase()}.`,
      body: [
        { heading: "Rule", text: `Use this guidance during ${link(process, process.toLowerCase())}, especially when working on ${link(project, project.toLowerCase())}.` },
        { heading: "Why it matters", text: `Clear, repeatable steps help people make the same decision when the situation is similar.` },
      ],
    });
  }

  for (const [index, tool] of SECTIONS.tools.entries()) {
    const process = pick(SECTIONS.processes, index);
    const team = pick(SECTIONS.teams, index + 2);
    add({
      section: "tools",
      title: tool,
      connected: [process, team],
      summary: `How the ${tool.toLowerCase()} supports everyday work.`,
      body: [
        { heading: "Use", text: `The ${link(team, team.toLowerCase())} uses this during ${link(process, process.toLowerCase())}.` },
        { heading: "Good practice", text: `Keep the latest information here so another person can understand the work without asking for background.` },
      ],
    });
  }

  for (const [index, partner] of SECTIONS.partners.entries()) {
    const work = pick(SECTIONS.workstreams, index + 3);
    const policy = pick(SECTIONS.policies, index + 1);
    add({
      section: "partners",
      title: partner,
      connected: [work, policy],
      summary: `The working relationship with ${partner}.`,
      body: [
        { heading: "Shared work", text: `${partner} contributes to ${link(work, work.toLowerCase())}.` },
        { heading: "Expectations", text: `Agree the scope, dates and owners in writing, using ${link(policy, policy.toLowerCase())}.` },
      ],
    });
  }

  for (const [index, project] of SECTIONS.projects.entries()) {
    const work = [pick(SECTIONS.workstreams, index), pick(SECTIONS.workstreams, index + 3), pick(SECTIONS.workstreams, index + 6)];
    const policies = [pick(SECTIONS.policies, index), pick(SECTIONS.policies, index + 4)];
    const owner = pick(SECTIONS.people, index);
    add({
      section: "projects",
      title: project,
      connected: [...work, ...policies, owner],
      summary: `Goals, decisions and open work for ${project.toLowerCase()}.`,
      body: [
        { heading: "Current work", text: `The project brings together ${work.map((item) => link(item, item.toLowerCase())).join(", ")}.` },
        { heading: "Ownership", text: `${link(owner)} keeps the update clear: what changed, what is at risk and what needs a decision.` },
      ],
    });
  }

  for (const [index, issue] of SECTIONS.issues.entries()) {
    const process = pick(SECTIONS.processes, index + 4);
    const tool = pick(SECTIONS.tools, index + 2);
    const project = pick(SECTIONS.projects, index);
    add({
      section: "issues",
      title: issue,
      connected: [process, tool, project],
      summary: `A simple record for the issue called ${issue.toLowerCase()}.`,
      body: [
        { heading: "Response", text: `Use ${link(process, process.toLowerCase())} and record the evidence in ${link(tool, tool.toLowerCase())}.` },
        { heading: "Context", text: `The issue affects ${link(project, project.toLowerCase())}; update the owner when the next step is known.` },
      ],
    });
  }

  for (const [index, person] of SECTIONS.people.entries()) {
    const team = pick(SECTIONS.teams, index);
    const project = pick(SECTIONS.projects, index);
    add({
      section: "people",
      title: person,
      connected: [team, project],
      summary: `The role ${person} plays in the sample organisation.`,
      body: [
        { heading: "Role", text: `${person} helps the ${link(team, team.toLowerCase())} make decisions for ${link(project, project.toLowerCase())}.` },
        { heading: "Handover", text: `They make the next owner and the reason for a decision clear before work moves on.` },
      ],
    });
  }

  for (const project of SECTIONS.projects) {
    for (const work of SECTIONS.workstreams) {
      const team = pick(SECTIONS.teams, SECTIONS.workstreams.indexOf(work));
      const process = pick(SECTIONS.processes, SECTIONS.workstreams.indexOf(work));
      add({
        section: "records",
        title: `${work} — ${project}`,
        connected: [work, project, team, process],
        summary: `A short record of ${work.toLowerCase()} for ${project.toLowerCase()}.`,
        body: [
          { heading: "Record", text: `This work belongs to ${link(project, project.toLowerCase())}. The ${link(team, team.toLowerCase())} follows ${link(process, process.toLowerCase())}.` },
          { heading: "Status", text: `See the related ${link(work, work.toLowerCase())} note for the current owner, next step and decision.` },
        ],
      });
    }
  }

  return notes;
}

export const SAMPLE_VAULT_NOTES: readonly SampleNote[] = Object.freeze(build());

export const SAMPLE_VAULT_SUMMARY = Object.freeze({
  notes: SAMPLE_VAULT_NOTES.length,
  sections: new Set(SAMPLE_VAULT_NOTES.map((note) => note.path.split("/")[0])).size,
});

/** Extra source files shown before compilation; they are not indexed. */
export const SAMPLE_SOURCE_FILES: readonly SampleNote[] = Object.freeze([
  {
    path: "reports/weekly-update.md",
    text: "# Weekly update\n\nThe team agreed the next owner for each open item.\n",
  },
  {
    path: "data/work-summary.csv",
    text: "area,open_items,completed_items\nplanning,3,12\noperations,5,24\nquality,2,18\n",
  },
  {
    path: "meetings/team-check-in.md",
    text: "# Team check-in\n\n## Decisions\n\n- Keep the customer update short and clear.\n",
  },
]);
