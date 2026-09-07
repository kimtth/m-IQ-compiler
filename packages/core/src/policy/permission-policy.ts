import { canRemember, grantCovers, type DelegatedGrant } from "@iq/shared";
import type { PermissionOutcome, PermissionRequest } from "@iq/shared";
import type { TenantPolicy } from "./tenant-policy.js";

/** Key used to remember an "always" decision. Scoped to family + tool, not resource. */
const ruleKey = (request: Pick<PermissionRequest, "family" | "toolName">): string =>
  `${request.family}:${request.toolName}`;

export interface SessionRules {
  /** Rules the user chose to persist for the session. */
  allowAlways: Set<string>;
  denyAlways: Set<string>;
}

export const newSessionRules = (): SessionRules => ({
  allowAlways: new Set(),
  denyAlways: new Set(),
});

/**
 * Permission policy.
 *
 * Order of evaluation, strongest first:
 *   1. Tenant policy deny floor  - cannot be overridden by anyone.
 *   2. Tenant allow-list         - anything outside it is denied.
 *   3. Tenant scope deny floor   - a blocked Entra scope is never requested.
 *   4. Session deny rule         - user said "never" earlier in this session.
 *   5. Read-only fast path       - reads run without a prompt.
 *   6. Tenant approval floor     - forces a prompt, outranking any user rule.
 *   7. Delegated grant           - the run's declared families, for work no
 *                                  human is watching.
 *   8. Session allow rule        - user said "always" earlier in this session.
 *   9. Prompt the user.
 *  10. Default deny.
 *
 * Step 6 sits above step 8 deliberately: tenant policy always outranks the
 * user, so a device-managed `requireApprovalForWrites` cannot be switched off
 * by answering "always" once. It is off by default for exactly that reason —
 * because it makes step 8 unreachable, defaulting it on turned "Allow for this
 * conversation" into a control that could never do anything. It outranks the
 * delegated grant for the same reason: an administrator who requires a human on
 * every write means an unattended run may only read.
 *
 * Step 7 sits *above* the `external`/`destructive` re-confirmation rather than
 * below it, and that placement is the whole point. `external` is never
 * remembered — a fetch always asks — which is correct while somebody is there
 * to be asked, and a deadlock when nobody is: a delegated researcher's first
 * web fetch suspended a turn that no card could ever settle. The grant is not a
 * shortcut past that rule, it is the answer given in advance, by a person, for
 * a named set of families. `destructive` is still unreachable: {@link
 * DelegatedGrant} cannot express it as a ceiling.
 *
 * Step 10 matters: unknown tool families and unrecognised risk levels fail
 * closed by reaching the default rather than falling through to an allow.
 */
export class PermissionPolicy {
  constructor(private readonly tenant: TenantPolicy) {}

  /**
   * @param grant What this session may do without being asked, when it is a
   * delegated run with no surface. Absent for an interactive conversation,
   * where the user is the grant.
   */
  evaluate(
    request: PermissionRequest,
    rules: SessionRules,
    grant?: DelegatedGrant,
  ): PermissionOutcome {
    if (this.tenant.deniedToolFamilies.includes(request.family)) {
      return {
        decision: "deny",
        source: "tenant_policy",
        reason: `tool family "${request.family}" is denied by tenant policy`,
      };
    }

    const allowList = this.tenant.allowedToolFamilies;
    if (allowList !== null && !allowList.includes(request.family)) {
      return {
        decision: "deny",
        source: "tenant_policy",
        reason: `tool family "${request.family}" is not in the tenant allow-list`,
      };
    }

    const deniedScope = request.requiredScopes.find((scope) =>
      this.tenant.deniedScopes.includes(scope),
    );
    if (deniedScope) {
      return {
        decision: "deny",
        source: "tenant_policy",
        reason: `scope "${deniedScope}" is denied by tenant policy`,
      };
    }

    const key = ruleKey(request);

    if (rules.denyAlways.has(key)) {
      return { decision: "deny", source: "user_rule", reason: "denied for this session" };
    }

    if (request.risk === "read") {
      return { decision: "allow", source: "user_rule", reason: "read-only operation" };
    }

    // Tenant policy outranks everything below, so a tenant that mandates
    // approval always reaches a human — including in a delegated run, which
    // then simply cannot write.
    if (this.tenant.requireApprovalForWrites) {
      return { decision: "ask", source: "user_prompt", reason: "human approval required" };
    }

    if (grant && grantCovers(grant, request)) {
      return {
        decision: "allow",
        source: "delegation",
        reason: `"${request.family}" was granted to this delegated run when it was approved`,
      };
    }

    // An irreversible effect is re-confirmed every time, whatever anyone
    // answered earlier.
    if (!canRemember(request.risk)) {
      return { decision: "ask", source: "user_prompt", reason: "human approval required" };
    }

    if (request.risk === "write") {
      if (rules.allowAlways.has(key)) {
        return { decision: "allow", source: "user_rule", reason: "approved for this session" };
      }
      return { decision: "ask", source: "user_prompt", reason: "human approval required" };
    }

    return {
      decision: "deny",
      source: "default_deny",
      reason: "no rule matched; failing closed",
    };
  }

  /**
   * Record an "always" answer.
   *
   * Irreversible effects are never remembered. A sent mail cannot be recalled
   * and a deleted item cannot be restored, so both `external` and `destructive`
   * calls are re-confirmed every time even if the user answered "always" to an
   * earlier one.
   */
  remember(request: PermissionRequest, decision: PermissionOutcome["decision"], rules: SessionRules): void {
    const key = ruleKey(request);
    if (decision === "allow_always" && canRemember(request.risk)) {
      rules.allowAlways.add(key);
    } else if (decision === "deny_always") {
      rules.denyAlways.add(key);
    }
  }

  /** Whether a skill's `allowed-tools` list permits this family. */
  static skillPermits(allowedTools: readonly string[], family: string): boolean {
    if (allowedTools.length === 0) return true;
    return allowedTools.some((entry) => entry === family || entry === `${family}.*` || entry === "*");
  }
}
