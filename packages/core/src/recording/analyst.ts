import {
  AnalysisSubmission,
  BuildSubmission,
  MIN_ANALYSABLE_EVENTS,
  RecordingAnalysis,
  RecordingPlan,
  isMeaningfulEvent,
  slugifyRecordingName,
  type AnalysisFeedback,
  type BuildKind,
  type NarrationTranscript,
  type RecEvent,
  type SessionBundle,
} from "@iq/shared";
import type { CopilotRuntime } from "../runtime/copilot/copilot-runtime.js";
import type { Logger } from "../util/logger.js";
import type { RecordingStore } from "./store.js";

/**
 * Turning a capture into a description, and a description into a procedure.
 *
 * Two agents, deliberately separated, because they answer different questions
 * and fail in different ways:
 *
 *  - The **analyst** reconstructs what happened. Its output is checked against
 *    a recording, so a user can say "no, that step is wrong" and be right.
 *  - The **builder** generalises what happened into something that will run
 *    again. Its output cannot be checked against anything — it is a claim about
 *    future runs — so it is proposed as a plan first and written only after a
 *    person has agreed with the generalisation.
 *
 * Merging them would collapse that distinction, and the second failure would
 * arrive disguised as the first.
 *
 * ## Why no custom tools
 *
 * Letting the analyst page through a raw event log with tools is useful when
 * the log is the only artifact. Here the bundle is already folded into steps by
 * deterministic code, and it is small enough to hand over whole. That buys two
 * things worth more than the tools — every analysis reads exactly the evidence
 * the user can read in the bundle viewer, and the same bundle always produces
 * the same prompt, so a bad result is reproducible. Sessions therefore run with
 * **no** tool families at all: this agent reads text and returns JSON, and
 * cannot touch the machine.
 */

/**
 * A family name nothing registers.
 *
 * The runtime treats an empty `allowedFamilies` as "every family", so an empty
 * array would hand the analyst the entire tool surface. Naming a family that
 * does not exist is how you ask for none.
 */
const NO_TOOLS = ["__recording_no_tools__"];

/** A model that will not stop has to be stopped; analyses are not interactive. */
const TURN_TIMEOUT_MS = 180_000;

/** Steps beyond this are noise, and a plan nobody reads is not a plan. */
const MAX_STEPS = 40;

export interface RecordingAnalystDeps {
  store: RecordingStore;
  runtime: CopilotRuntime;
  logger: Logger;
  /** Resolved per run, so a model set after launch is the one that is used. */
  model: () => Promise<string>;
  projectDir: () => string;
  now?: () => Date;
}

export class RecordingAnalyst {
  constructor(private readonly deps: RecordingAnalystDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** A recording with nothing in it cannot be analysed, only confabulated. */
  static analysable(events: readonly RecEvent[]): boolean {
    return events.filter((event) => isMeaningfulEvent(event.type)).length >= MIN_ANALYSABLE_EVENTS;
  }

  /**
   * Reconstruct what the recording shows.
   *
   * `feedback` re-runs the same session, so the model revises rather than
   * starts over: the user's correction is a correction, not a fresh guess that
   * happens to have been given a hint.
   */
  async analyse(input: {
    recordingId: string;
    bundle: SessionBundle;
    narration: NarrationTranscript | null;
    correlationId: string;
    feedback?: AnalysisFeedback;
    previous?: RecordingAnalysis | null;
    signal?: AbortSignal;
  }): Promise<RecordingAnalysis> {
    const sessionId = `recording-analysis-${input.recordingId}`;
    const session = await this.deps.runtime.ensureSession({
      sessionId,
      model: await this.deps.model(),
      allowedFamilies: NO_TOOLS,
      skillDirectories: [],
      disabledSkills: [],
      workingDirectory: this.deps.projectDir(),
      systemPromptAppendix: ANALYST_SYSTEM,
    });

    const prompt =
      input.feedback && input.previous
        ? revisionPrompt(input.previous, input.feedback)
        : analysisPrompt(input.bundle, input.narration);

    const result = await this.deps.runtime.runTurn(session, {
      sessionId,
      turnId: `${sessionId}-r${(input.previous?.revision ?? 0) + 1}`,
      correlationId: input.correlationId,
      prompt,
      timeoutMs: TURN_TIMEOUT_MS,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (result.status !== "completed") {
      throw new Error(result.error ?? `the analysis ${result.status}`);
    }

    const submission = AnalysisSubmission.parse(extractJson(result.assistantText));
    const revision = (input.previous?.revision ?? 0) + 1;
    const at = this.now().toISOString();

    return RecordingAnalysis.parse({
      version: 1,
      recordingId: input.recordingId,
      revision,
      createdAt: at,
      title: submission.title,
      intent: submission.intent,
      intentConfidence: submission.intentConfidence,
      intentRationale: submission.intentRationale,
      steps: submission.steps.slice(0, MAX_STEPS),
      feedbackLog: [
        ...(input.previous?.feedbackLog ?? []),
        ...(input.feedback
          ? [
              {
                revision,
                at,
                overall: input.feedback.overall,
                steps: input.feedback.steps,
              },
            ]
          : []),
      ],
      // A revised analysis is unapproved by definition: approval was given to
      // the text that has just been replaced.
      approved: false,
      approvedAt: null,
      sessionId,
    });
  }

  /** Release the analysis session. Called when a recording is done with. */
  async close(recordingId: string): Promise<void> {
    await this.deps.runtime
      .closeSession(`recording-analysis-${recordingId}`)
      .catch((error: unknown) => this.deps.logger.warn("closing analysis session failed", { error }));
    await this.deps.runtime
      .closeSession(`recording-build-${recordingId}`)
      .catch(() => undefined);
  }
}

export interface RecordingBuilderDeps {
  runtime: CopilotRuntime;
  logger: Logger;
  /** Resolved per run, so a model set after launch is the one that is used. */
  model: () => Promise<string>;
  projectDir: () => string;
  /** Governed tools the plan should prefer over replaying a user interface. */
  toolCatalogue: () => string;
}

export class RecordingBuilder {
  constructor(private readonly deps: RecordingBuilderDeps) {}

  /** Propose how the recording generalises, before writing anything. */
  async plan(input: {
    recordingId: string;
    kind: BuildKind;
    analysis: RecordingAnalysis;
    correlationId: string;
    revise?: string;
    previous?: RecordingPlan | null;
    signal?: AbortSignal;
  }): Promise<RecordingPlan> {
    const sessionId = `recording-build-${input.recordingId}`;
    const session = await this.deps.runtime.ensureSession({
      sessionId,
      model: await this.deps.model(),
      allowedFamilies: NO_TOOLS,
      skillDirectories: [],
      disabledSkills: [],
      workingDirectory: this.deps.projectDir(),
      systemPromptAppendix: BUILDER_SYSTEM,
    });

    const prompt =
      input.revise && input.previous
        ? planRevisionPrompt(input.previous, input.revise)
        : planPrompt(input.kind, input.analysis, this.deps.toolCatalogue());

    const result = await this.deps.runtime.runTurn(session, {
      sessionId,
      turnId: `${sessionId}-plan-${Date.now()}`,
      correlationId: input.correlationId,
      prompt,
      timeoutMs: TURN_TIMEOUT_MS,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (result.status !== "completed") {
      throw new Error(result.error ?? `planning ${result.status}`);
    }

    const raw = extractJson(result.assistantText) as Record<string, unknown>;
    // The model picks a title far more reliably than it picks a slug, so the
    // name is derived from the title rather than trusted from the model.
    const title = typeof raw["title"] === "string" && raw["title"] ? raw["title"] : "Recorded skill";
    return RecordingPlan.parse({
      ...raw,
      kind: input.kind,
      title,
      name: slugifyRecordingName(typeof raw["name"] === "string" ? raw["name"] : title),
      steps: Array.isArray(raw["steps"]) ? raw["steps"].slice(0, MAX_STEPS) : [],
      trigger: input.kind === "automation" ? (raw["trigger"] ?? null) : null,
    });
  }

  /** Write the procedure from the plan the user agreed to. */
  async build(input: {
    recordingId: string;
    plan: RecordingPlan;
    correlationId: string;
    signal?: AbortSignal;
  }): Promise<BuildSubmission> {
    const sessionId = `recording-build-${input.recordingId}`;
    const session = await this.deps.runtime.ensureSession({
      sessionId,
      model: await this.deps.model(),
      allowedFamilies: NO_TOOLS,
      skillDirectories: [],
      disabledSkills: [],
      workingDirectory: this.deps.projectDir(),
      systemPromptAppendix: BUILDER_SYSTEM,
    });

    const result = await this.deps.runtime.runTurn(session, {
      sessionId,
      turnId: `${sessionId}-write-${Date.now()}`,
      correlationId: input.correlationId,
      prompt: writePrompt(input.plan),
      timeoutMs: TURN_TIMEOUT_MS,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (result.status !== "completed") {
      throw new Error(result.error ?? `the build ${result.status}`);
    }

    const raw = extractJson(result.assistantText) as Record<string, unknown>;
    return BuildSubmission.parse({
      ...raw,
      // The plan is what the user approved. Letting the writing pass rename or
      // re-scope the skill would put an unreviewed artifact behind a reviewed
      // decision.
      name: input.plan.name,
      description: input.plan.description,
      allowedTools: input.plan.allowedTools,
    });
  }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const JSON_RULE =
  "Reply with one JSON object and nothing else — no prose before or after, no code fence.";

const ANALYST_SYSTEM = `You reconstruct what a person did from a recording of their screen activity.

You are given a session bundle: a deterministic, pre-segmented summary of a real
work session — the applications used, window titles, page URLs, clipboard
activity and any spoken narration.

Rules that matter:
- Describe only what the evidence supports. If you cannot tell what a step
  accomplished, say so and mark it low confidence. A confident wrong step is
  worse than an honest gap, because the user will approve it.
- Write steps in the past tense, addressed to the user: "Opened the supplier
  register", not "The user opens...".
- Narration is the user explaining their own intent. Prefer it over your
  inference from window titles wherever the two disagree.
- Group by purpose, not by application. Switching to a browser to look one
  thing up and switching back is one step, not three.
- Cite evidence: event seqs (as "seq:12"), URLs, or frame file names.`;

const BUILDER_SYSTEM = `You turn a reconstructed work session into a reusable procedure.

The hard part is generalisation, not wording. A recorded run is full of
specifics — one file, one date, one supplier — and a procedure that hard-codes
them repeats that single run instead of capturing the work.

Rules that matter:
- Lift every specific literal into a named value and refer to it as {{value_id}}.
  Value ids are lowercase with underscores.
- Prefer the application's governed tools over describing user-interface steps.
  Replaying clicks is brittle and unauditable; a tool call is neither.
- Mark each step as a "calculation" (derives something) or an "action" (changes
  something). Be honest about which: a reviewer approving unattended execution
  is reading the actions.
- Do not invent steps that were not recorded, and do not carry over steps that
  were clearly incidental — a mistyped search, a detour to check email.`;

function analysisPrompt(bundle: SessionBundle, narration: NarrationTranscript | null): string {
  return [
    "Reconstruct this work session.",
    "",
    "## Session bundle",
    "```json",
    JSON.stringify(bundle, null, 2),
    "```",
    ...(narration && narration.segments.length > 0
      ? [
          "",
          "## Narration (the user speaking while they worked)",
          ...narration.segments.map((segment) => `- [${formatMs(segment.atMs)}] ${segment.text}`),
        ]
      : []),
    "",
    "## Reply",
    JSON_RULE,
    "",
    "```",
    JSON.stringify(
      {
        title: "2-5 words",
        intent: "one sentence: what this session was for",
        intentConfidence: "high | medium | low",
        intentRationale: "why you believe that",
        steps: [
          {
            id: "s1",
            title: "past tense, addressed to the user",
            detail: "what happened and what it accomplished",
            startMs: 0,
            endMs: 0,
            apps: ["Microsoft Excel"],
            evidence: ["seq:12", "https://example.com"],
            confidence: "high | medium | low",
          },
        ],
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

function revisionPrompt(previous: RecordingAnalysis, feedback: AnalysisFeedback): string {
  return [
    "The user reviewed your analysis and corrected it. Revise it.",
    "",
    "Keep everything they did not question. Change only what the feedback asks",
    "for, and anything that is now inconsistent with it.",
    "",
    "## Your previous analysis",
    "```json",
    JSON.stringify(
      {
        title: previous.title,
        intent: previous.intent,
        steps: previous.steps,
      },
      null,
      2,
    ),
    "```",
    "",
    "## Feedback",
    ...(feedback.overall ? [`Overall: ${feedback.overall}`] : []),
    ...feedback.steps.map((entry) => `- ${entry.stepId}: ${entry.note}`),
    "",
    "## Reply",
    JSON_RULE,
    "Use the same shape as before.",
  ].join("\n");
}

function planPrompt(kind: BuildKind, analysis: RecordingAnalysis, catalogue: string): string {
  return [
    kind === "skill"
      ? "Propose a reusable skill built from this session."
      : "Propose an automation built from this session, to run unattended on a schedule.",
    "",
    "## What happened",
    "```json",
    JSON.stringify(
      {
        title: analysis.title,
        intent: analysis.intent,
        steps: analysis.steps,
      },
      null,
      2,
    ),
    "```",
    "",
    "## Tools available to the procedure",
    "Prefer these over describing user-interface steps.",
    catalogue || "(none registered)",
    "",
    "## Reply",
    JSON_RULE,
    "",
    "```",
    JSON.stringify(
      {
        name: "kebab-case-slug",
        title: "short human title",
        description: "what it does and when to use it — this is how it gets selected",
        summary: "one line",
        generalization: "how the single recorded run was turned into a general procedure",
        values: [{ id: "supplier_name", name: "Supplier name", value: "recorded literal" }],
        steps: [
          {
            kind: "calculation | action",
            title: "short",
            text: "imperative and generalised, referring to {{value_id}}",
            tool: "tool name, or empty",
          },
        ],
        allowedTools: ["tool names this procedure needs"],
        ...(kind === "automation"
          ? {
              trigger: {
                kind: "cron | interval | once | manual",
                expression: "0 9 * * 1-5 (cron only)",
                timezone: "UTC (cron only)",
              },
            }
          : {}),
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

function planRevisionPrompt(previous: RecordingPlan, note: string): string {
  return [
    "The user wants the plan changed. Revise it.",
    "",
    "## Current plan",
    "```json",
    JSON.stringify(previous, null, 2),
    "```",
    "",
    "## What they asked for",
    note,
    "",
    "## Reply",
    JSON_RULE,
    "Use the same shape as before.",
  ].join("\n");
}

function writePrompt(plan: RecordingPlan): string {
  return [
    "Write the procedure for this approved plan.",
    "",
    "```json",
    JSON.stringify(plan, null, 2),
    "```",
    "",
    "Write the body as Markdown: a short paragraph on when to use it, then the",
    "steps as a numbered list. Refer to values as {{value_id}} — do not inline",
    "them, they are substituted later. Do not include YAML frontmatter; that is",
    "generated. Do not include a top-level heading.",
    "",
    "## Reply",
    JSON_RULE,
    "",
    "```",
    JSON.stringify({ body: "the Markdown procedure" }, null, 2),
    "```",
  ].join("\n");
}

function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Pull the JSON object out of a model reply.
 *
 * Asking for bare JSON works most of the time and not all of the time: a fence
 * or a sentence of preamble is the single most common way a good answer arrives
 * in an unusable wrapper. Throwing that away over punctuation would fail the
 * analysis for a reason the user cannot act on, so the object is found rather
 * than demanded.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === "object") return parsed;
    } catch {
      // Try the next shape.
    }
  }
  throw new Error("the model did not return a JSON object");
}
