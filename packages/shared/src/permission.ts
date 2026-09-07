import { z } from "zod";

/**
 * Permission model.
 *
 * The permission checker fails closed: unknown tool families, including unknown
 * MCP families, are refused. Every request follows the same privileged path:
 * normalize it, evaluate policy, broker any approval, then write the audit
 * record.
 */

export const RiskLevel = z.enum(["read", "write", "external", "destructive"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

/**
 * What "auto-approve read-only tools" actually covers.
 *
 * Here rather than in the composer that offers the setting, for two reasons.
 * It is the definition of a promise made to the user, so it belongs somewhere
 * it can be tested against the risks the privileged side really assigns. And
 * the last version of it lived in renderer code as a hand-written list of six
 * family names, which knew nothing about the SDK's own built-ins: every
 * `copilot.*` request fell straight through it, so the mode that says it
 * answers for you did not, and the turn sat until it timed out.
 *
 * `read` only. `external` is not a synonym for harmless — it reaches the
 * network, and covers MCP calls and page fetches as well — and a control
 * labelled "read-only" must not quietly include those.
 */
export const isAutoApprovable = (risk: RiskLevel): boolean => risk === "read";

/**
 * Whether an "always" answer can outlive the call it was given for.
 *
 * `external` and `destructive` calls leave the machine or destroy state and
 * cannot be undone, so the policy re-confirms them every time whatever anyone
 * answered earlier. That rule lived only in the privileged side, where it is
 * enforced — and the card went on offering "Allow for this conversation" for a
 * web fetch, which allowed that one call, remembered nothing, and asked again
 * on the next one. The button was not broken; it was a promise the policy was
 * never going to keep.
 *
 * So the rule is stated once, here, and both sides read it: the policy to
 * enforce it, the card to stop offering what it will refuse to remember.
 */
export const canRemember = (risk: RiskLevel): boolean =>
  risk !== "external" && risk !== "destructive";


/**
 * What a delegated, unattended run may do without being asked.
 *
 * A `sub_agent` or `scheduled` session has no surface: it is not listed in the
 * rail, so no approval card is ever rendered for it and nobody can answer one.
 * Until this existed, a research sub-agent's first `Fetch URL` suspended the
 * turn on a promise no click could ever settle, the SDK's wall clock killed it
 * thirty minutes later, the Coordinator retried it once, and the whole run
 * spent an hour producing nothing — one fresh Copilot session per attempt.
 *
 * The grant is the human decision that started the run, written down. Approving
 * a research plan, or answering the `write`-risk `delegate_tasks` card, names
 * the tool families the work may use; this says those families may then run
 * without stopping at a card nobody will see. It is not a way to skip approval,
 * it is what the approval already meant.
 *
 * `destructive` is deliberately not expressible as a ceiling. A shell call or a
 * deletion cannot be authorised in advance by a decision about a topic, so an
 * unattended run that asks for one is refused rather than run unwatched.
 */
export const DelegatedGrant = z.object({
  /**
   * Families pre-authorised for this session, SDK built-ins included — they
   * live in the same namespace (`copilot.url`, `copilot.read`), and a run that
   * may read the web has to name the tool that reads it.
   */
  families: z.array(z.string()).default([]),
  ceiling: z.enum(["read", "write", "external"]).default("read"),
});
export type DelegatedGrant = z.infer<typeof DelegatedGrant>;

const RISK_ORDER: Record<RiskLevel, number> = {
  read: 0,
  write: 1,
  external: 2,
  destructive: 3,
};

/** Whether a grant covers this request. Both the family and the risk must fit. */
export const grantCovers = (
  grant: DelegatedGrant,
  request: Pick<PermissionRequest, "family" | "risk">,
): boolean =>
  grant.families.includes(request.family) &&
  RISK_ORDER[request.risk] <= RISK_ORDER[grant.ceiling];

export const PermissionDecision = z.enum([
  "allow",
  "allow_always",
  "deny",
  "deny_always",
  "ask",
]);
export type PermissionDecision = z.infer<typeof PermissionDecision>;

/** A normalized description of a side effect a tool wants to perform. */
export const PermissionRequest = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  /** Tool family, e.g. "m365.mail", "workiq", "project.fs", "office". */
  family: z.string(),
  risk: RiskLevel,
  /** Human-readable summary rendered on the approval card. */
  summary: z.string(),
  /** Entra scopes this call requires, if any. */
  requiredScopes: z.array(z.string()).default([]),
  /** Resource identifiers touched, used for audit and for allow_always keys. */
  resources: z.array(z.string()).default([]),
});
export type PermissionRequest = z.infer<typeof PermissionRequest>;

export const PermissionOutcome = z.object({
  decision: PermissionDecision,
  /**
   * Which layer settled the decision. Tenant policy always outranks the user.
   *
   * `delegation` is its own layer rather than a flavour of `user_rule` because
   * the audit log has to be able to answer "who allowed this?" with something
   * other than a person who was not there: it means the run's declared grant
   * covered the call, and the decision behind it was made when the run started.
   */
  source: z.enum(["tenant_policy", "user_rule", "user_prompt", "delegation", "default_deny"]),
  reason: z.string(),
});
export type PermissionOutcome = z.infer<typeof PermissionOutcome>;
