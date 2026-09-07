import { z } from "zod";
import { join } from "node:path";
import { readJson } from "../util/jsonl.js";
import type { AppPaths } from "../config/paths.js";

/**
 * Tenant policy.
 *
 * Managed policy covers models, tools, servers and features. Enforcement lives
 * only in the privileged process, and a managed (device-administered) policy
 * always wins over a local file.
 *
 * The policy expresses a *deny floor*: it can only remove capability, never
 * grant it. A user can be more restrictive than the tenant, never less.
 */
export const TenantPolicy = z.object({
  /** Tenants permitted to sign in. Empty means "any tenant the app is consented in". */
  allowedTenantIds: z.array(z.string()).default([]),
  /** Tool families that are hard-denied regardless of user approval. */
  deniedToolFamilies: z.array(z.string()).default([]),
  /** When set, only these tool families may run. */
  allowedToolFamilies: z.array(z.string()).nullable().default(null),
  /** Entra scopes that may never be requested. */
  deniedScopes: z.array(z.string()).default([]),
  /** Models the user may select. Empty means the runtime default set. */
  allowedModels: z.array(z.string()).default([]),
  /** Model used when neither the user nor the host picks one. */
  defaultModel: z.string().default("claude-sonnet-4.5"),
  /**
   * Require fresh human approval for every write, even one the user already
   * answered "always" to in this session.
   *
   * Defaults to **false**, and that default is load-bearing. This flag outranks
   * the session allow rule (see `PermissionPolicy`), so while it was defaulted
   * to `true` the "Allow for this conversation" button could never take effect
   * on a stock install: every write reached the approval floor before the rule
   * was consulted, and a six-slide deck asked six times. Writes still prompt
   * once, and `external`/`destructive` actions are re-confirmed every time
   * whatever this says — so off is not "no approval", it is "the answer the
   * user already gave is honoured".
   *
   * An administrator who sets it to `true` still gets the floor, and it still
   * cannot be switched off from inside the app.
   */
  requireApprovalForWrites: z.boolean().default(false),
  /** Allow agent-authored skills to be proposed at all. */
  allowAgentAuthoredSkills: z.boolean().default(true),
  /**
   * Allow the user to connect MCP servers.
   *
   * A deny floor, like every other switch here: turning it off makes configured
   * servers inert rather than deleting them, so the consent record survives a
   * policy change and can be reviewed.
   */
  allowUserMcpServers: z.boolean().default(true),
  /**
   * Allow the curator to compile approved memories into skill proposals.
   * Derived proposals still require human approval; this only controls whether
   * the compilation step runs at all.
   */
  allowAutomaticSkillDerivation: z.boolean().default(true),
  /** Approved memories a subject must accumulate before it compiles to a skill. */
  minMemoriesPerDerivedSkill: z.number().int().min(1).max(20).default(3),
  /** Allow sub-agent delegation. */
  allowSubAgents: z.boolean().default(true),
  /** Maximum sub-agents dispatched concurrently, regardless of plan settings. */
  maxParallelSubAgents: z.number().int().min(1).max(16).default(4),
  /** Maximum scheduled job runs executing at the same time. */
  maxConcurrentJobs: z.number().int().min(1).max(16).default(3),
  /** Allow the built-in browser pane at all. */
  browserEnabled: z.boolean().default(true),
  /**
   * Hosts the pane may never load, as exact names or `*.suffix` patterns.
   *
   * A deny-list only. There is deliberately no allow-list: a page reachable in
   * an ordinary browser must be reachable here.
   */
  browserDeniedHosts: z.array(z.string()).default([]),
  /** Allow the local knowledge graph to be built and queried. */
  knowledgeGraphEnabled: z.boolean().default(true),
});
export type TenantPolicy = z.infer<typeof TenantPolicy>;

export const DEFAULT_TENANT_POLICY: TenantPolicy = TenantPolicy.parse({});

export type PolicySource = "managed" | "disk" | "default";

export interface ResolvedTenantPolicy {
  policy: TenantPolicy;
  source: PolicySource;
}

/**
 * Load policy, preferring the device-managed location over the local file.
 *
 * On Windows the managed path is populated by Intune/GPO; on other platforms it
 * is a machine-scoped configuration directory. A malformed managed policy is a
 * hard failure rather than a silent fallback, because silently downgrading to a
 * weaker policy is exactly the failure mode this guards against.
 */
export async function loadTenantPolicy(paths: AppPaths): Promise<ResolvedTenantPolicy> {
  const managedPath = managedPolicyPath();
  if (managedPath) {
    const managed = await readJson<unknown>(managedPath, null);
    if (managed !== null) {
      return { policy: TenantPolicy.parse(managed), source: "managed" };
    }
  }

  const local = await readJson<unknown>(join(paths.config, "tenant-policy.json"), null);
  if (local !== null) {
    return { policy: TenantPolicy.parse(local), source: "disk" };
  }

  return { policy: DEFAULT_TENANT_POLICY, source: "default" };
}

function managedPolicyPath(): string | null {
  const override = process.env["IQ_MANAGED_POLICY"];
  if (override) return override;

  if (process.platform === "win32") {
    const programData = process.env["ProgramData"];
    return programData ? join(programData, "IQCompiler", "tenant-policy.json") : null;
  }
  if (process.platform === "darwin") {
    return "/Library/Application Support/IQCompiler/tenant-policy.json";
  }
  return "/etc/iq-compiler/tenant-policy.json";
}
