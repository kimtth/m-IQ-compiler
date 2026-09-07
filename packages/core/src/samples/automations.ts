import { ScheduledJob } from "@iq/shared";

/**
 * Worked examples for Automations.
 *
 * The Automations surface is one of the hardest to judge empty: a scheduler
 * with no jobs in it says nothing about what a job *is* — an objective, a
 * trigger, a narrowed tool set and a retry policy — and the form asks for all
 * four before showing any of them together.
 *
 * Three rules make this safe to ship:
 *
 *  1. **Every sample is disabled.** A seeded automation that ran would send a
 *     turn nobody asked for, against the user's mail, on their token budget.
 *     Loading examples must never start work; enabling one is a decision the
 *     user makes afterwards, in full view of the objective.
 *  2. **Fixed ids**, so seeding twice adds nothing and clearing can only ever
 *     remove a sample — never a job someone wrote.
 *  3. **Read-only tool families.** Even enabled by mistake, none of these can
 *     send, delete or change anything.
 *
 * The objectives are deliberately real rather than "do the thing": a schedule
 * is judged by whether the sentence would produce something useful at 07:00 on
 * a Monday, and a placeholder teaches nobody that.
 */

export const SAMPLE_JOB_ID_PREFIX = "job_sample_";

/** Timestamps are fixed so seeding is byte-identical every time. */
const AT = "2026-01-06T08:00:00.000Z";

export const SAMPLE_JOBS: ScheduledJob[] = [
  ScheduledJob.parse({
    id: `${SAMPLE_JOB_ID_PREFIX}01`,
    name: "Monday morning inbox digest",
    objective:
      "Summarise everything that arrived in my inbox since Friday evening. Group it by sender, " +
      "put anything that names me directly or asks a question first, and say plainly which " +
      "messages appear to need an answer today. Do not reply to anything.",
    trigger: { kind: "cron", expression: "0 7 * * 1", timezone: "UTC" },
    enabled: false,
    toolFamilies: ["workiq"],
    skills: [],
    retry: { maxAttempts: 2, backoffMs: 60_000 },
    timeoutMs: 10 * 60_000,
    createdAt: AT,
    updatedAt: AT,
  }),
  ScheduledJob.parse({
    id: `${SAMPLE_JOB_ID_PREFIX}02`,
    name: "Tomorrow's meetings, the evening before",
    objective:
      "List tomorrow's meetings. For each one say who called it, what it is about, and whether " +
      "anything in my recent mail or files looks like preparation I have not done. Say so " +
      "explicitly when there is nothing to prepare.",
    trigger: { kind: "cron", expression: "0 17 * * 1-5", timezone: "UTC" },
    enabled: false,
    toolFamilies: ["workiq"],
    skills: [],
    retry: { maxAttempts: 2, backoffMs: 60_000 },
    timeoutMs: 10 * 60_000,
    createdAt: AT,
    updatedAt: AT,
  }),
  ScheduledJob.parse({
    id: `${SAMPLE_JOB_ID_PREFIX}03`,
    name: "Weekly knowledge-vault gaps",
    objective:
      "Search the knowledge index for notes that are linked to but do not exist, and for notes " +
      "with no links at all. Report both lists. Write nothing.",
    trigger: { kind: "interval", everyMs: 7 * 24 * 60 * 60_000 },
    enabled: false,
    toolFamilies: ["knowledge"],
    skills: [],
    retry: { maxAttempts: 1, backoffMs: 30_000 },
    timeoutMs: 5 * 60_000,
    createdAt: AT,
    updatedAt: AT,
  }),
];

export const isSampleJob = (jobId: string): boolean => jobId.startsWith(SAMPLE_JOB_ID_PREFIX);
