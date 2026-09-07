import { DecisionGate, OrchestrationPlan, OrchestrationTask } from "@iq/shared";
import type { PlanDocument } from "../orchestration/coordinator.js";

/**
 * A worked example for Delegated plans.
 *
 * The surface is unreadable empty for a different reason than the others: a
 * plan is a *shape* — tasks with dependencies, a fan-out that runs in parallel,
 * a gate that stops promotion until a person answers — and none of that is
 * visible until a plan with more than one task exists. A single-task plan
 * teaches nothing a chat turn does not.
 *
 * The sample is **finished**, not running. Every task is `succeeded` and the
 * plan is `succeeded`, so the coordinator has nothing to dispatch: loading an
 * example must never spawn sub-agents or spend tokens. What it demonstrates is
 * the record a completed delegation leaves behind, which is what a reader is
 * usually trying to interpret anyway.
 *
 * The gate is left `approved` for the same reason — a `pending` gate would sit
 * in the UI asking a question about work that never happened.
 *
 * Fixed ids throughout, so seeding twice adds nothing and clearing can only
 * remove a sample.
 */

export const SAMPLE_PLAN_ID_PREFIX = "plan_sample_";

const AT = "2026-01-06T09:00:00.000Z";
const DONE = "2026-01-06T09:24:00.000Z";
const PLAN_ID = `${SAMPLE_PLAN_ID_PREFIX}01`;

const task = (
  suffix: string,
  title: string,
  instruction: string,
  dependsOn: string[],
  result: string,
  toolFamilies: string[],
): OrchestrationTask =>
  OrchestrationTask.parse({
    id: `${PLAN_ID}_task_${suffix}`,
    planId: PLAN_ID,
    title,
    instruction,
    status: "succeeded",
    dependsOn,
    toolFamilies,
    skills: [],
    // Null rather than a plausible session id: the sub-agent sessions this
    // would have created do not exist, and pointing at ones that do not is
    // worse than saying nothing.
    sessionId: null,
    attempt: 1,
    maxAttempts: 2,
    result,
    error: null,
    createdAt: AT,
    updatedAt: DONE,
  });

export const SAMPLE_PLANS: PlanDocument[] = [
  {
    plan: OrchestrationPlan.parse({
      id: PLAN_ID,
      objective:
        "Work out whether the seal-check false-fail rate is a tester problem or a process problem, " +
        "and write up what would settle it.",
      parentSessionId: "",
      maxParallel: 3,
      status: "succeeded",
      createdAt: AT,
      updatedAt: DONE,
    }),
    tasks: [
      task(
        "01",
        "Gather the line data",
        "Collect the seal-check pass/fail records for the last 30 days from the project, broken " +
          "down by station, shift and lot. Report counts, not conclusions.",
        [],
        "30 days collected. Failures are 3.1% overall but 7.4% on station 3 and under 1% elsewhere.",
        ["project.read"],
      ),
      task(
        "02",
        "Read the calibration history",
        "Find every calibration and maintenance record for the end-of-line testers in the same " +
          "period. Note anything that changed, and when.",
        [],
        "Station 3 was recalibrated on the 11th; its failure rate did not move afterwards.",
        ["project.read"],
      ),
      task(
        "03",
        "Check the teardown findings",
        "Find the teardown reports for units that failed the seal check, and say how many showed a " +
          "physical defect on inspection.",
        [],
        "41 teardowns, 4 with a confirmed seal defect. The other 37 passed an independent leak test.",
        ["project.read"],
      ),
      task(
        "04",
        "Write the finding",
        "Using the three reports above, state whether the evidence points at the tester or at the " +
          "process, and name the one measurement that would settle it. Say so if it is not settled.",
        [`${PLAN_ID}_task_01`, `${PLAN_ID}_task_02`, `${PLAN_ID}_task_03`],
        "Concentrated on one station and not reproduced on independent leak test: tester-side. " +
          "A repeatability study on station 3 against the independent method would settle it.",
        [],
      ),
    ],
    gates: [
      DecisionGate.parse({
        id: `${PLAN_ID}_gate_01`,
        planId: PLAN_ID,
        question:
          "The three fact-finding tasks disagree about the cause. Write the finding anyway, or stop " +
          "and get a repeatability study first?",
        gatedTaskIds: [`${PLAN_ID}_task_04`],
        resolution: "approved",
        resolvedBy: "sample-data",
        resolvedAt: DONE,
      }),
    ],
  },
];

export const isSamplePlan = (planId: string): boolean => planId.startsWith(SAMPLE_PLAN_ID_PREFIX);
