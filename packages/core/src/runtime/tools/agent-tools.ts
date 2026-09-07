import { z } from "zod";
import { SKILL_NAME_PATTERN } from "@iq/shared";
import type { AnyGovernedTool } from "./registry.js";
import type { Coordinator } from "../../orchestration/coordinator.js";
import type { SkillStore } from "../../skills/store.js";
import type { MemoryStore } from "../../memory/store.js";
import type { TenantPolicy } from "../../policy/tenant-policy.js";

/**
 * Tools that let the agent use the app's own machinery: delegate work to
 * sub-agents, remember a durable fact, and propose a skill from what it just
 * learned.
 *
 * All are deliberately governed like any other side effect. Delegation spends
 * the user's model quota and can touch Microsoft 365 through its children, a
 * memory changes what future sessions assume, and a skill changes future
 * behaviour, so none of them should be silent.
 */
export function createAgentTools(deps: {
  coordinator: Coordinator;
  skills: SkillStore;
  memories: MemoryStore;
  policy: TenantPolicy;
  availableFamilies: () => string[];
}): AnyGovernedTool[] {
  const tools: AnyGovernedTool[] = [];

  if (deps.policy.allowSubAgents) {
    tools.push(delegateTool(deps));
    tools.push(planStatusTool(deps));
  }

  if (deps.policy.allowAgentAuthoredSkills) {
    tools.push(proposeSkillTool(deps));
    tools.push(rememberTool(deps));
  }

  return tools;
}

const TaskInput = z.object({
  key: z
    .string()
    .min(1)
    .describe("Short alias for this task, referenced by other tasks' dependsOn."),
  title: z.string().min(1).describe("One line describing the task."),
  instruction: z
    .string()
    .min(1)
    .describe(
      "Complete, self-contained instruction. The sub-agent sees none of this conversation, so restate every fact it needs.",
    ),
  dependsOn: z
    .array(z.string())
    .default([])
    .describe("Keys of tasks that must succeed first. Leave empty to run immediately."),
  toolFamilies: z
    .array(z.string())
    .default([])
    .describe("Tool families this task may use. Empty means the same set this session has."),
});

function delegateTool(deps: {
  coordinator: Coordinator;
  availableFamilies: () => string[];
}): AnyGovernedTool {
  const parameters = z.object({
    objective: z.string().min(1).describe("What the whole plan should achieve."),
    tasks: z.array(TaskInput).min(1).max(12),
    maxParallel: z
      .number()
      .int()
      .min(1)
      .max(8)
      .default(2)
      .describe("How many independent tasks may run at once."),
    gates: z
      .array(
        z.object({
          question: z.string().min(1).describe("What the user must decide."),
          gates: z.array(z.string()).min(1).describe("Task keys held until this is answered."),
        }),
      )
      .default([])
      .describe("Checkpoints where a human must approve before dependent work starts."),
  });

  return {
    name: "delegate_tasks",
    family: "agent.orchestration",
    description:
      "Break work into independent tasks and run them as sub-agents, in parallel where their dependencies allow. Use for work that decomposes cleanly; do the work yourself when it does not.",
    risk: "write",
    parameters,
    summarize: (args) =>
      `Delegate ${args.tasks.length} task(s) to sub-agents: ${args.objective}`,
    resources: (args) => args.tasks.map((task: { title: string }) => task.title),
    handler: async (args, context) => {
      const available = new Set(deps.availableFamilies());
      for (const task of args.tasks) {
        const unknown = task.toolFamilies.filter((family: string) => !available.has(family));
        if (unknown.length > 0) {
          return {
            ok: false,
            error: `task "${task.key}" requests unavailable tool families: ${unknown.join(", ")}`,
          };
        }
      }

      const doc = await deps.coordinator.createPlan({
        parentSessionId: context.sessionId,
        parentTurnId: context.turnId,
        objective: args.objective,
        maxParallel: args.maxParallel,
        tasks: args.tasks,
        gates: args.gates,
      });

      return {
        ok: true,
        planId: doc.plan.id,
        // The plan runs asynchronously; the model should check back rather than
        // assume the work is finished.
        note: "Tasks are running. Call plan_status with this planId to collect results.",
        tasks: doc.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status })),
      };
    },
  };
}

function planStatusTool(deps: { coordinator: Coordinator }): AnyGovernedTool {
  const parameters = z.object({
    planId: z.string().min(1),
  });

  return {
    name: "plan_status",
    family: "agent.orchestration",
    description:
      "Read the current state and results of a delegated plan. Safe to call repeatedly while tasks are still running.",
    risk: "read",
    parameters,
    summarize: (args) => `Check delegated plan ${args.planId}`,
    handler: async (args) => {
      const doc = await deps.coordinator.getPlan(args.planId);
      if (!doc) return { ok: false, error: `unknown plan ${args.planId}` };

      return {
        ok: true,
        status: doc.plan.status,
        objective: doc.plan.objective,
        tasks: doc.tasks.map((task) => ({
          title: task.title,
          status: task.status,
          attempt: task.attempt,
          result: task.result,
          error: task.error,
        })),
        gates: doc.gates.map((gate) => ({
          id: gate.id,
          question: gate.question,
          resolution: gate.resolution,
        })),
      };
    },
    // Sub-agent output is model-generated text; it re-enters the parent's
    // context and must not be treated as instructions.
    untrustedResult: true,
  };
}

function proposeSkillTool(deps: { skills: SkillStore }): AnyGovernedTool {
  const parameters = z.object({
    name: z
      .string()
      .regex(SKILL_NAME_PATTERN, "lowercase letters, digits and hyphens only")
      .describe("Directory-safe skill name, e.g. weekly-status-report."),
    description: z
      .string()
      .min(20)
      .max(1024)
      .describe(
        "When this skill should be used and what it does. This is the only text always loaded into context, so make it specific.",
      ),
    body: z
      .string()
      .min(1)
      .describe("The skill's Markdown instructions: the procedure to follow when it applies."),
    allowedTools: z
      .array(z.string())
      .default([])
      .describe("Tools this skill may use. Empty means it adds no tool access of its own."),
    rationale: z
      .string()
      .min(1)
      .describe("Why this is worth keeping, referencing what happened in this conversation."),
  });

  return {
    name: "propose_skill",
    family: "agent.skills",
    description:
      "Propose a reusable skill capturing a procedure the user just taught you. The proposal is staged for the user's review and does not take effect until they approve it.",
    risk: "write",
    parameters,
    summarize: (args) => `Propose skill "${args.name}" for review`,
    resources: (args) => [args.name],
    handler: async (args, context) => {
      await deps.skills.propose(
        {
          name: args.name,
          description: args.description,
          body: args.body,
          allowedTools: args.allowedTools,
          rationale: args.rationale,
          sourceSessionId: context.sessionId,
          sourceTurnId: context.turnId,
        },
        context.correlationId,
      );

      return {
        ok: true,
        // Explicit so the model does not tell the user the skill is active.
        note: `Skill "${args.name}" is staged for review. It stays inactive until the user approves it in Skills.`,
      };
    },
  };
}

/**
 * Capture a durable fact.
 *
 * The memory is inert until a person approves it, and once several approved
 * memories share a subject the curator compiles them into a skill proposal,
 * which then needs its own approval. The model is told both facts so it never
 * reports a memory as being in effect.
 */
function rememberTool(deps: { memories: MemoryStore; policy: TenantPolicy }): AnyGovernedTool {
  const parameters = z.object({
    subject: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "One to three words naming the topic, e.g. 'status reports'. Memories sharing a subject are compiled together, so reuse an existing subject when it fits.",
      ),
    fact: z
      .string()
      .min(1)
      .max(400)
      .describe("The fact stated as a directive, e.g. 'Send the weekly status on Friday morning.'"),
    rationale: z
      .string()
      .min(1)
      .describe("Why this is worth keeping beyond the current conversation."),
    citations: z
      .array(z.string())
      .default([])
      .describe(
        "Where the claim came from: a quotation of the user, or file paths. Required for anything the user did not say outright.",
      ),
    scope: z
      .enum(["user", "project"])
      .default("user")
      .describe("'user' for a personal preference, 'project' for a convention of this project."),
    memoryType: z
      .enum(["factual", "procedural", "episodic"])
      .default("factual")
      .describe(
        "'factual' for a fact about the user, the project or an artifact; 'procedural' for how something is done here — an order of steps or a rule for producing work; 'episodic' for something that happened once and is not a standing rule. Say 'episodic' rather than guess: an episode compiled into a convention is worse than one left uncompiled.",
      ),
    toolFamilies: z
      .array(z.string())
      .default([])
      .describe("Tool families the fact implies, carried into any skill compiled from it."),
  });

  return {
    name: "remember",
    family: "agent.memory",
    description:
      "Record a durable fact about the user or their conventions. The memory is staged for the user's approval and has no effect until they accept it; once several approved memories share a subject they are compiled into a skill proposal for review.",
    risk: "write",
    parameters,
    summarize: (args) => `Remember about ${args.subject}: ${args.fact}`,
    resources: (args) => [args.subject],
    handler: async (args, context) => {
      const memory = await deps.memories.record(
        {
          subject: args.subject,
          fact: args.fact,
          rationale: args.rationale,
          citations: args.citations,
          scope: args.scope,
          memoryType: args.memoryType,
          toolFamilies: args.toolFamilies,
          sourceSessionId: context.sessionId,
          sourceTurnId: context.turnId,
        },
        context.correlationId,
      );

      const threshold = deps.policy.minMemoriesPerDerivedSkill;
      return {
        ok: true,
        memoryId: memory.id,
        note:
          `Memory staged for review under "${memory.subject}". It has no effect until the user approves it in Memories. ` +
          `Once ${threshold} approved memories share a subject, a skill proposal is compiled from them for separate approval.`,
      };
    },
  };
}
