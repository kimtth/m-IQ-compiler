import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Send, Sparkles, User } from "lucide-react";
import {
  CONNECTOME_PERSONAS,
  COUPLING_LABELS,
  ORIGIN_LABELS,
  type ConnectomeEdge,
  type ConnectomeFindingKind,
  type ConnectomeGraph,
  type ConnectomePersona,
  type ConnectomeReport,
  type CouplingComponent,
} from "@iq/shared";
import { ChatMessage } from "../message.js";

/**
 * Asking the map questions.
 *
 * The map answers a question the eye is good at — what is near what — and is
 * useless for the questions people actually arrive with: which of these costs
 * the most, what is only held together by one link, why are these two joined
 * at all. Those answers are already in the analysis; they were just spread
 * across a table, a report pane and a details dialog.
 *
 * **No model is asked.** Every answer here is computed from the graph the
 * analysis produced, which is the same promise the rest of this surface makes:
 * the picture is rendered deterministically and so is this. That has a real
 * consequence — the vocabulary is finite, and a question outside it is told so
 * plainly rather than being answered with something plausible. An invented
 * answer about your own automations is worse than no answer.
 *
 * Three properties make it something to read rather than a console dump:
 *
 *  1. **Answers are rows, not prose.** A ranked answer is a list of figures,
 *     and a list of figures typed into a paragraph cannot be scanned. Each row
 *     carries the entity, the reason and the number, with a bar for the share,
 *     and clicking one selects it on the map.
 *  2. **Every answer offers what to ask next.** A surface where each answer is
 *     a dead end makes the reader do the work of knowing what it can do. The
 *     follow-ups are the map of the vocabulary, drawn as you go.
 *  3. **It shows its working.** Name two IQ Cells and the reply is the six
 *     signals, each one's score, its weight and the product — the same
 *     arithmetic the report prints. A strength figure that cannot be checked
 *     is not evidence.
 */

/**
 * One line of an answer.
 *
 * The figure and the reason are separate fields rather than one sentence,
 * because they are read differently: the eye scans the column of numbers and
 * only then reads across to the reason for the one it stopped on.
 */
interface AnswerRow {
  /** The node or edge this row is about, or null when it is not on the map. */
  id: string | null;
  kind: "node" | "edge";
  label: string;
  /** Why this row is here. */
  note?: string;
  /** The figure, set in mono so the column lines up. */
  value?: string;
  /** 0..1. Draws a proportion bar behind the row. */
  share?: number;
  /** Colour carries meaning, never rank: `danger` is a problem, not a maximum. */
  tone?: "neutral" | "warn" | "danger";
}

export interface Answer {
  headline: string;
  rows: AnswerRow[];
  /** The qualification. Always the last thing said. */
  note: string | null;
  /** What this answer invites next. */
  next: string[];
}

/**
 * What the fallback says.
 *
 * Named so a test can assert that no follow-up this surface offers ever lands
 * on it. A suggestion that leads to "I cannot answer that" is worse than no
 * suggestion, and in a demo it is the one thing that must not happen.
 */
export const NO_ANSWER = "I only read this analysis, so that is all I can answer from.";

interface Turn {
  id: number;
  question: string;
  answer: Answer;
}

interface ChatProps {
  report: ConnectomeReport | null;
  /** Who the findings are ordered for. Sets what is offered and what leads. */
  persona: ConnectomePersona;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
}

/**
 * The question that gets at each kind of finding.
 *
 * Keyed on the finding kind so a persona's declared concerns can be turned
 * into questions without a second table saying which persona asks what. One
 * list to keep in step instead of nine.
 */
const KIND_QUESTION: Readonly<Record<ConnectomeFindingKind, string>> = {
  cost_concentration: "What costs the most?",
  permission_concentration: "What reaches outside?",
  fragility: "What is failing?",
  redundancy: "What overlaps?",
  stale_pin: "What is out of date?",
  orphan: "What is isolated?",
};

const KIND_ORDER: readonly ConnectomeFindingKind[] = [
  "fragility",
  "cost_concentration",
  "permission_concentration",
  "redundancy",
  "stale_pin",
  "orphan",
];

const nameOf = (graph: ConnectomeGraph, id: string): string =>
  graph.nodes.find((node) => node.id === id)?.name ?? id;

const edgeLabel = (graph: ConnectomeGraph, edge: ConnectomeEdge): string =>
  `${nameOf(graph, edge.source)} ↔ ${nameOf(graph, edge.target)}`;

const percent = (value: number): string => `${Math.round(value * 100)}%`;

const nodeRow = (graph: ConnectomeGraph, id: string, rest: Partial<AnswerRow> = {}): AnswerRow => ({
  id,
  kind: "node",
  label: nameOf(graph, id),
  ...rest,
});

const edgeRow = (graph: ConnectomeGraph, edge: ConnectomeEdge, rest: Partial<AnswerRow> = {}): AnswerRow => ({
  id: edge.id,
  kind: "edge",
  label: edgeLabel(graph, edge),
  ...rest,
});

const strongestEdge = (graph: ConnectomeGraph): ConnectomeEdge | undefined =>
  [...graph.edges].sort((a, b) => b.strength - a.strength)[0];

/** The question that would make this analysis show its working, with real names in it. */
const pairQuestion = (graph: ConnectomeGraph): string | null => {
  const top = strongestEdge(graph);
  if (top === undefined) return null;
  return `Why are ${nameOf(graph, top.source)} and ${nameOf(graph, top.target)} connected?`;
};

const unique = (rows: readonly string[]): string[] => [...new Set(rows)];

/**
 * What to offer this reader.
 *
 * The persona's declared concerns come first, then the rest of the vocabulary,
 * so a Budget owner opens on cost and a Security reviewer on reach — without
 * either being unable to reach the other questions. `all` has no declared
 * concerns and falls straight through to the full list.
 */
export const suggestionsFor = (report: ConnectomeReport, persona: ConnectomePersona): string[] => {
  const leads = CONNECTOME_PERSONAS[persona].leads;
  const pair = pairQuestion(report.graph);
  return unique([
    "What should I do first?",
    ...leads.map((kind) => KIND_QUESTION[kind]),
    ...(pair === null ? [] : [pair]),
    ...KIND_ORDER.map((kind) => KIND_QUESTION[kind]),
    "What are the strongest connections?",
    "What groups are there?",
  ]).slice(0, 6);
};

/** Findings of one kind, as rows. Shared by the four questions that ask for one. */
const findingRows = (report: ConnectomeReport, kind: ConnectomeFindingKind): AnswerRow[] =>
  report.findings
    .filter((finding) => finding.kind === kind)
    .slice(0, 6)
    .map((finding) => {
      const cite = finding.cites[0] ?? null;
      return {
        id: cite,
        kind: cite !== null && cite.includes("~") ? ("edge" as const) : ("node" as const),
        label: finding.title,
        note: finding.action,
      };
    });

/**
 * The two IQ Cells a question names.
 *
 * A name contained inside another name would match both, so only maximal
 * matches are kept: "Contract review" must not be read as a second cell when
 * the reader typed "Contract review triage".
 */
const IGNORED_NAME_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "in",
  "is",
  "of",
  "the",
  "to",
  "why",
]);

/**
 * The reader usually copies a visible label, but may add an article or change
 * punctuation while turning it into a question. Those words do not identify an
 * IQ Cell, so leave them out before looking for its name.
 */
const nameWords = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word !== "" && !IGNORED_NAME_WORDS.has(word))
    .join(" ");

const namedIn = (graph: ConnectomeGraph, q: string): ConnectomeGraph["nodes"] => {
  const question = nameWords(q);
  const matched = graph.nodes.filter((node) => {
    const name = nameWords(node.name);
    return name !== "" && question.includes(name);
  });
  return matched.filter(
    (node) =>
      !matched.some(
        (other) => other.id !== node.id && other.name.toLowerCase().includes(node.name.toLowerCase()),
      ),
  );
};

/**
 * Answer from the graph.
 *
 * Deliberately a pure function of the question, the report and the persona:
 * the same question against the same analysis always gives the same answer,
 * which is what makes an answer here quotable in the same way the map's hash
 * is. The persona changes what is offered and what leads; it never changes a
 * figure, because the figures are the same for everyone.
 */
export function answer(
  question: string,
  report: ConnectomeReport,
  persona: ConnectomePersona,
): Answer {
  const graph = report.graph;
  const lens = CONNECTOME_PERSONAS[persona];
  const q = question.trim().toLowerCase();
  const pair = pairQuestion(graph);
  const fallbackNext = unique([
    "What should I do first?",
    ...(pair === null ? [] : [pair]),
    "What are the strongest connections?",
  ]);

  if (q === "") {
    return { headline: "Ask something about the map.", rows: [], note: null, next: fallbackNext };
  }

  const named = namedIn(graph, q);

  // Two names beat every keyword, and this is the answer worth arriving for:
  // the strength figure taken apart into the six comparisons that produced it.
  if (named.length >= 2) {
    const [a, b] = named as [ConnectomeGraph["nodes"][number], ConnectomeGraph["nodes"][number]];
    const edge = graph.edges.find(
      (row) =>
        (row.source === a.id && row.target === b.id) || (row.source === b.id && row.target === a.id),
    );

    if (edge === undefined) {
      return {
        headline: `${a.name} and ${b.name} are not connected in this analysis.`,
        rows: [a, b].map((node) =>
          nodeRow(graph, node.id, {
            note: `Reaches ${node.reach.join(", ") || "nothing outside the project"}`,
            value: `${graph.edges.filter((row) => row.source === node.id || row.target === node.id).length} links`,
          }),
        ),
        note: `They share too little to clear the noise floor. A pair below it is dropped rather than drawn, because a graph where everything is connected carries as much information as one where nothing is.`,
        next: unique([
          `What is ${a.name}?`,
          `What is ${b.name}?`,
          "What are the strongest connections?",
        ]),
      };
    }

    const weights = report.selection.weights;
    return {
      headline: `${a.name} and ${b.name} — ${percent(edge.strength)}, ${ORIGIN_LABELS[edge.origin].toLowerCase()}.`,
      rows: edge.evidence.map((item) => ({
        id: null,
        kind: "node" as const,
        label: COUPLING_LABELS[item.component],
        note: item.detail,
        value: `${item.score.toFixed(2)} × ${(weights[item.component as CouplingComponent] ?? 0).toFixed(2)} = ${(item.score * (weights[item.component as CouplingComponent] ?? 0)).toFixed(2)}`,
        share: item.score,
      })),
      note: `Those products, divided by the most any pair could score, are the ${percent(edge.strength)}. Nothing was read from inside an artifact — every line is a declaration both IQ Cells already carry.`,
      next: unique([
        `What is ${a.name}?`,
        "What are the strongest connections?",
        "What should I do first?",
      ]),
    };
  }

  if (named.length === 1) {
    const node = named[0] as ConnectomeGraph["nodes"][number];
    const touching = graph.edges
      .filter((edge) => edge.source === node.id || edge.target === node.id)
      .sort((a, b) => b.strength - a.strength);
    const bundle = graph.bundles.find((row) => row.id === node.bundleId);
    const other = touching[0];
    return {
      headline: `${node.name} — v${node.version}, ${node.runs} runs, ${percent(node.completionRate)} completion.`,
      rows: [
        {
          id: null,
          kind: "node",
          label: "Cost over the window",
          value: `${(node.tokensPerRun * node.runs).toLocaleString()} tokens`,
        },
        {
          id: null,
          kind: "node",
          label: "Reach",
          value: node.reach.join(", ") || "inside the project only",
          tone: node.reach.length > 0 ? "warn" : "neutral",
        },
        { id: null, kind: "node", label: "Group", value: bundle?.name ?? "none" },
        ...touching.slice(0, 4).map((edge) =>
          edgeRow(graph, edge, {
            note: edge.evidence[0]
              ? COUPLING_LABELS[edge.evidence[0].component].toLowerCase()
              : "no stated reason",
            value: percent(edge.strength),
            share: edge.strength,
          }),
        ),
      ],
      note:
        touching.length === 0
          ? "Nothing else in the selection is coupled to it above the noise floor."
          : `${touching.length} connection${touching.length === 1 ? "" : "s"} in all.`,
      next: unique([
        ...(other === undefined
          ? []
          : [
              `Why are ${nameOf(graph, other.source)} and ${nameOf(graph, other.target)} connected?`,
            ]),
        "What costs the most?",
        "What should I do first?",
      ]),
    };
  }

  // The persona's whole point, asked directly.
  if (/\b(first|start|priorit|urgent|matter|should i|focus)\b/.test(q)) {
    if (report.findings.length === 0) {
      return {
        headline: "The analysis raised nothing to act on for this selection.",
        rows: [],
        note: lens.blindSpot,
        next: fallbackNext,
      };
    }
    return {
      headline: `Read as ${lens.label}: ${lens.question}`,
      // Eight rather than four now the list folds at three: the fold is what
      // keeps the answer short, so the cap only has to stop it being a page
      // when it is opened.
      rows: report.findings.slice(0, 8).map((finding) => {
        const cite = finding.cites[0] ?? null;
        return {
          id: cite,
          kind: cite !== null && cite.includes("~") ? ("edge" as const) : ("node" as const),
          label: finding.title,
          note: finding.action,
          value: finding.kind.replace(/_/g, " "),
          tone:
            finding.kind === "fragility" || finding.kind === "permission_concentration"
              ? ("danger" as const)
              : ("warn" as const),
        };
      }),
      note: `Ordered for that reader, never filtered for them — all ${report.findings.length} are in the report. ${lens.blindSpot}`,
      next: unique([
        ...lens.leads.map((kind) => KIND_QUESTION[kind]),
        "What did you find?",
        "What groups are there?",
      ]),
    };
  }

  if (/strong|top|closest|tightest|coupled/.test(q)) {
    const top = [...graph.edges].sort((a, b) => b.strength - a.strength).slice(0, 6);
    if (top.length === 0) {
      return {
        headline: "Nothing is coupled above the noise floor.",
        rows: [],
        note: null,
        next: fallbackNext,
      };
    }
    return {
      headline: `The strongest ${top.length} of ${graph.edges.length} connections.`,
      rows: top.map((edge) =>
        edgeRow(graph, edge, {
          note: `${ORIGIN_LABELS[edge.origin].toLowerCase()} · ${edge.evidence[0] ? COUPLING_LABELS[edge.evidence[0].component].toLowerCase() : "no stated reason"}`,
          value: percent(edge.strength),
          share: edge.strength,
        }),
      ),
      note: "Declared means one IQ Cell embeds the other. Inferred is a hypothesis from shared signals — it grants nothing and changes no execution.",
      next: unique([
        ...(pair === null ? [] : [pair]),
        "What groups are there?",
        "What should I do first?",
      ]),
    };
  }

  if (/group|bundle|cluster|community/.test(q)) {
    if (graph.bundles.length === 0) {
      return { headline: "No groups formed.", rows: [], note: null, next: fallbackNext };
    }
    return {
      headline: `${graph.bundles.length} group${graph.bundles.length === 1 ? "" : "s"}, by cost share.`,
      rows: [...graph.bundles]
        .sort((a, b) => b.costShare - a.costShare)
        .map((bundle) => ({
          id: bundle.members[0] ?? null,
          kind: "node" as const,
          label: bundle.name,
          note: `${bundle.members.length} IQ Cells · shares ${bundle.shares.join(", ") || "nothing named"}`,
          value: `${percent(bundle.costShare)} cost`,
          share: bundle.costShare,
        })),
      note: "A group is what came out of moving each IQ Cell to whichever group its strongest neighbours were already in. It is named after whatever its members most have in common.",
      next: unique(["What costs the most?", "What overlaps?", "What should I do first?"]),
    };
  }

  if (/cost|token|expensive|spend|budget|price/.test(q)) {
    const total = graph.nodes.reduce((sum, node) => sum + node.tokensPerRun * node.runs, 0) || 1;
    const dear = [...graph.nodes]
      .sort((a, b) => b.tokensPerRun * b.runs - a.tokensPerRun * a.runs)
      .slice(0, 6);
    const topShare = ((dear[0]?.tokensPerRun ?? 0) * (dear[0]?.runs ?? 0)) / total;
    return {
      headline: `Token spend over ${report.selection.windowDays} days — runs × tokens per run.`,
      rows: dear.map((node) =>
        nodeRow(graph, node.id, {
          note: `${node.runs} runs at ~${node.tokensPerRun.toLocaleString()} each`,
          value: percent((node.tokensPerRun * node.runs) / total),
          share: (node.tokensPerRun * node.runs) / total,
          tone: (node.tokensPerRun * node.runs) / total >= 0.18 ? "warn" : "neutral",
        }),
      ),
      note: `The top ${dear.length} are ${percent(dear.reduce((sum, node) => sum + node.tokensPerRun * node.runs, 0) / total)} of everything spent here${topShare >= 0.18 ? ", and one IQ Cell alone is over a fifth of it" : ""}. Run history is demo data, so the ranking is sound and the absolute figures are not.`,
      next: unique(["What overlaps?", "What groups are there?", "What should I do first?"]),
    };
  }

  if (/fail|broken|complet|reliab|health|flak|retry/.test(q)) {
    const weak = [...graph.nodes]
      .filter((node) => node.completionRate < 0.9)
      .sort((a, b) => a.completionRate - b.completionRate)
      .slice(0, 6);
    if (weak.length === 0) {
      return {
        headline: "Every selected IQ Cell completes at least 90% of its runs.",
        rows: [],
        note: null,
        next: fallbackNext,
      };
    }
    const degree = (id: string): number =>
      graph.edges.filter((edge) => edge.source === id || edge.target === id).length;
    return {
      headline: `${weak.length} IQ Cells complete under 90% of their runs.`,
      rows: weak.map((node) =>
        nodeRow(graph, node.id, {
          note: `${node.runs} runs · ${degree(node.id)} things depend on it`,
          value: percent(node.completionRate),
          share: node.completionRate,
          tone: node.completionRate < 0.7 ? "danger" : "warn",
        }),
      ),
      note: "A low completion rate on its own is a nuisance. On something with a lot of connections it is a fragile hub, and that is what the findings call out.",
      next: unique(["What should I do first?", "What reaches outside?", "What did you find?"]),
    };
  }

  if (/reach|outside|web|external|mail|permission|risk|access|grant/.test(q)) {
    const outward = graph.nodes.filter((node) =>
      node.reach.some((reach) => /web|mail|host|365|browser/i.test(reach)),
    );
    if (outward.length === 0) {
      return {
        headline: "Nothing in this selection reaches beyond the project.",
        rows: [],
        note: null,
        next: fallbackNext,
      };
    }
    const held = new Map<string, number>();
    for (const node of graph.nodes) {
      for (const reach of node.reach) held.set(reach, (held.get(reach) ?? 0) + 1);
    }
    return {
      headline: `${outward.length} of ${graph.nodes.length} IQ Cells reach beyond the project.`,
      rows: [
        ...[...held.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([reach, count]) => ({
            id: null,
            kind: "node" as const,
            label: reach,
            note: "held by",
            value: `${count} of ${graph.nodes.length}`,
            share: count / graph.nodes.length,
            tone: count >= Math.max(4, graph.nodes.length * 0.45) ? ("danger" as const) : ("warn" as const),
          })),
        ...outward.slice(0, 4).map((node) =>
          nodeRow(graph, node.id, { note: node.reach.join(", ") }),
        ),
      ],
      note: "Reach is what each IQ Cell declares, not a record of what it touched — the audit log is that. A grant this widely held is hard to withdraw without breaking work, which is the whole difficulty.",
      next: unique(["What should I do first?", "What is out of date?", "What did you find?"]),
    };
  }

  const byKind: readonly [RegExp, ConnectomeFindingKind][] = [
    [/overlap|duplicat|twice|same job|redundan/, "redundancy"],
    [/out of date|stale|behind|pinned|old version|upgrade/, "stale_pin"],
    [/isolat|orphan|unused|alone|nobody|disconnect/, "orphan"],
  ];
  for (const [pattern, kind] of byKind) {
    if (!pattern.test(q)) continue;
    const rows = findingRows(report, kind);
    if (rows.length === 0) {
      return {
        headline: `Nothing in this selection was flagged as ${kind.replace(/_/g, " ")}.`,
        rows: [],
        note: null,
        next: fallbackNext,
      };
    }
    return {
      headline: `${rows.length} flagged as ${kind.replace(/_/g, " ")}.`,
      rows,
      note: "Each row's second line is the next step. The report never performs it.",
      next: unique(["What should I do first?", "What did you find?", "What costs the most?"]),
    };
  }

  if (/find|issue|problem|wrong|report|concern|everything/.test(q)) {
    if (report.findings.length === 0) {
      return { headline: "The analysis raised nothing.", rows: [], note: null, next: fallbackNext };
    }
    return {
      headline: `${report.findings.length} findings, ordered for ${lens.label}.`,
      rows: report.findings.slice(0, 10).map((finding) => {
        const cite = finding.cites[0] ?? null;
        return {
          id: cite,
          kind: cite !== null && cite.includes("~") ? ("edge" as const) : ("node" as const),
          label: finding.title,
          note: finding.action,
          value: finding.kind.replace(/_/g, " "),
        };
      }),
      note: lens.blindSpot,
      next: unique(["What should I do first?", ...(pair === null ? [] : [pair])]),
    };
  }

  if (/why|because|evidence|reason|how do you know/.test(q)) {
    const top = strongestEdge(graph);
    if (top === undefined) {
      return {
        headline: "There are no connections to explain.",
        rows: [],
        note: null,
        next: fallbackNext,
      };
    }
    return {
      headline: "Name two IQ Cells and I will take their strength figure apart.",
      rows: [
        edgeRow(graph, top, {
          note: "the strongest pair in this analysis",
          value: percent(top.strength),
          share: top.strength,
        }),
      ],
      note: "Every strength figure is six comparisons of declarations both IQ Cells already carry, each multiplied by its weight. Nothing is read from inside an artifact and no model is asked.",
      next: unique([...(pair === null ? [] : [pair]), "What are the strongest connections?"]),
    };
  }

  if (/how many|count|size|summary|overview|how big|hash/.test(q)) {
    const structural = graph.edges.filter((edge) => edge.origin === "structural").length;
    return {
      headline: `${graph.nodes.length} IQ Cells over ${report.selection.windowDays} days.`,
      rows: [
        {
          id: null,
          kind: "node",
          label: "Connections above the noise floor",
          value: `${graph.edges.length}`,
        },
        {
          id: null,
          kind: "node",
          label: "Declared / inferred",
          value: `${structural} / ${graph.edges.length - structural}`,
        },
        { id: null, kind: "node", label: "Groups", value: `${graph.bundles.length}` },
        { id: null, kind: "node", label: "Findings", value: `${report.findings.length}` },
        { id: null, kind: "node", label: "Graph hash", value: graph.hash },
      ],
      note: "The hash is the receipt. The same selection, window and weights always produce it, and always draw the same picture.",
      next: fallbackNext,
    };
  }

  return {
    headline: NO_ANSWER,
    rows: [],
    note: "No model is asked here. Anything outside what the analysis computed, I would be making up — and an invented answer about your own automations is worse than no answer.",
    next: unique([
      "What should I do first?",
      ...KIND_ORDER.map((kind) => KIND_QUESTION[kind]),
      ...(pair === null ? [] : [pair]),
    ]).slice(0, 6),
  };
}

/** How many rows an answer shows before the rest are folded away. */
const VISIBLE_ROWS = 3;

/**
 * The answer, three rows at a time.
 *
 * A finding's row is a title, a next step and a figure — five lines once the
 * title wraps in a column this narrow. Ten of them is a page, and a page is
 * not an answer: the reader scrolls past the thing they asked for to reach the
 * next question. Three is what the pane shows without scrolling, and the rows
 * are ranked, so the three that fit are the three that matter. The rest are
 * one click away and the count says how many there are, which is the part that
 * stops a fold from hiding the scale of the problem.
 */
function Rows({
  rows,
  onSelectNode,
  onSelectEdge,
}: {
  rows: readonly AnswerRow[];
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;

  const shown = open ? rows : rows.slice(0, VISIBLE_ROWS);
  const hidden = rows.length - shown.length;

  return (
    <>
      <ul className="chat-rows">
        {shown.map((row, index) => {
          const body = (
            <>
              <span className="chat-row-name">{row.label}</span>
              {row.note !== undefined && <span className="chat-row-note">{row.note}</span>}
            </>
          );
          return (
            <li
              key={`${row.id ?? row.label}-${index}`}
              className="chat-row"
              data-tone={row.tone ?? "neutral"}
            >
              {row.share !== undefined && (
                <span
                  className="chat-row-bar"
                  style={{ width: `${Math.max(2, Math.round(row.share * 100))}%` }}
                  aria-hidden="true"
                />
              )}
              {row.id === null ? (
                <span className="chat-row-label">{body}</span>
              ) : (
                <button
                  className="chat-row-label"
                  title={`Show ${row.label} on the map`}
                  onClick={() =>
                    row.kind === "node" ? onSelectNode(row.id as string) : onSelectEdge(row.id as string)
                  }
                >
                  {body}
                </button>
              )}
              {row.value !== undefined && <span className="chat-row-value">{row.value}</span>}
            </li>
          );
        })}
      </ul>
      {(hidden > 0 || open) && (
        <button className="chat-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Show fewer" : `Show ${hidden} more`}
        </button>
      )}
    </>
  );
}

/** How many follow-ups are shown before the rest are folded away. */
const VISIBLE_SUGGESTIONS = 3;

/**
 * The questions on offer, three at a time.
 *
 * Every answer hands over what to ask next, and printing all of them turns the
 * foot of each answer into a wall of sentences that competes with the answer
 * for attention — the thing the reader actually came for ends up framed by six
 * other questions. Three is enough to be a real choice and short enough to
 * read past; the rest are one click away, which costs nothing to ignore.
 *
 * The state is per instance, so expanding the follow-ups under one answer does
 * not unfold every other answer in the log.
 */
function Suggestions({
  questions,
  className,
  onPick,
}: {
  questions: readonly string[];
  className: string;
  onPick: (question: string) => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (questions.length === 0) return null;

  const shown = open ? questions : questions.slice(0, VISIBLE_SUGGESTIONS);
  const hidden = questions.length - shown.length;

  return (
    <div className={className}>
      {shown.map((question) => (
        // The chip is one line and clips, so the full question stays reachable
        // on hover rather than only in the answer it produces.
        <button key={question} className="chip" title={question} onClick={() => onPick(question)}>
          {question}
        </button>
      ))}
      {(hidden > 0 || open) && (
        <button
          className="chip chip-more"
          aria-expanded={open}
          title={open ? "Fold the rest away" : "Show the other questions this can answer"}
          onClick={() => setOpen(!open)}
        >
          {open ? "Fewer" : `+${hidden} more`}
        </button>
      )}
    </div>
  );
}

export function ConnectomeChat({
  report,
  persona,
  onSelectNode,
  onSelectEdge,
}: ChatProps): JSX.Element {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);
  const lens = CONNECTOME_PERSONAS[persona];

  // A new analysis is a new set of facts, so the old answers would be about a
  // graph that no longer exists. A persona change is not one: the graph is the
  // same graph, and clearing the exchange would throw away the comparison the
  // reader was making.
  const hash = report?.graph.hash ?? null;
  useEffect(() => {
    setTurns([]);
  }, [hash]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const ask = (question: string): void => {
    if (report === null || question.trim() === "") return;
    setTurns((current) => [
      ...current,
      { id: current.length, question: question.trim(), answer: answer(question, report, persona) },
    ]);
    setDraft("");
  };

  const suggestions = useMemo(
    () => (report === null ? [] : suggestionsFor(report, persona)),
    [persona, report],
  );

  if (report === null) {
    return (
      <div className="connectome-chat">
        <div className="chat-log">
          <p className="muted">
            Press Analyse first. This answers from the analysis, so there is nothing to
            read until one has been run.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="connectome-chat">
      {/* The claim, kept in view rather than made once and scrolled away. Both
          halves matter: the persona sets what is offered, and the figures are
          the same whoever is asking. */}
      <p className="chat-lens">
        Persona <strong>{lens.label}</strong> · answered from this analysis alone, no model asked.
        The figures are the same for everyone.
      </p>

      <div className="chat-log">
        {turns.map((turn) => (
          <div key={turn.id}>
            <ChatMessage role="user" name="You" icon={User}>
              {turn.question}
            </ChatMessage>
            <ChatMessage role="agent" name="My IQ" icon={Sparkles}>
              <p className="chat-headline">{turn.answer.headline}</p>
              <Rows
                rows={turn.answer.rows}
                onSelectNode={onSelectNode}
                onSelectEdge={onSelectEdge}
              />
              {turn.answer.note !== null && <p className="chat-note">{turn.answer.note}</p>}
              {turn.answer.next.length > 0 && (
                <Suggestions className="chat-next" questions={turn.answer.next} onPick={ask} />
              )}
            </ChatMessage>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {turns.length === 0 && (
        <Suggestions className="chat-suggestions" questions={suggestions} onPick={ask} />
      )}

      <div className="mini-composer">
        <input
          value={draft}
          placeholder="Ask about the map, or name two IQ Cells"
          aria-label="Ask about the map"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") ask(draft);
          }}
        />
        <button
          className="primary icon"
          disabled={draft.trim() === ""}
          title="Ask"
          aria-label="Ask"
          onClick={() => ask(draft)}
        >
          <Send size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
