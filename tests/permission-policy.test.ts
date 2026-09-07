import { describe, expect, it } from "vitest";
import type { DelegatedGrant, PermissionRequest } from "@iq/shared";
import { DEFAULT_TENANT_POLICY, PermissionPolicy, newSessionRules } from "@iq/core";

const tenant = {
  ...DEFAULT_TENANT_POLICY,
  deniedToolFamilies: [],
  deniedScopes: [],
  requireApprovalForWrites: false,
  allowSubAgents: true,
  allowAgentAuthoredSkills: true,
};

const request = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  toolCallId: "call-1",
  toolName: "m365_send_mail",
  family: "m365.mail",
  risk: "external",
  summary: "Send mail",
  requiredScopes: ["Mail.Send"],
  resources: ["someone@example.com"],
  ...over,
});

describe("PermissionPolicy", () => {
  it("allows reads without prompting", () => {
    const policy = new PermissionPolicy(tenant);
    const outcome = policy.evaluate(
      request({ toolName: "m365_list_recent_mail", risk: "read" }),
      newSessionRules(),
    );
    expect(outcome.decision).toBe("allow");
  });

  it("prompts for a write and remembers an allow_always answer", () => {
    const policy = new PermissionPolicy(tenant);
    const rules = newSessionRules();
    const write = request({ toolName: "m365_resolve_link", family: "m365.files", risk: "write" });

    expect(policy.evaluate(write, rules).decision).toBe("ask");
    policy.remember(write, "allow_always", rules);
    expect(policy.evaluate(write, rules).decision).toBe("allow");
  });

  it("never remembers an allow_always answer for an external effect", () => {
    const policy = new PermissionPolicy(tenant);
    const rules = newSessionRules();
    const send = request();

    expect(policy.evaluate(send, rules).decision).toBe("ask");
    policy.remember(send, "allow_always", rules);
    // Sending mail cannot be undone, so it is re-confirmed every time.
    expect(policy.evaluate(send, rules).decision).toBe("ask");
  });

  it("never remembers an allow_always answer for a destructive effect", () => {
    const policy = new PermissionPolicy(tenant);
    const rules = newSessionRules();
    const destroy = request({ toolName: "project_delete", risk: "destructive" });

    policy.remember(destroy, "allow_always", rules);
    expect(policy.evaluate(destroy, rules).decision).toBe("ask");
  });

  it("remembers a deny_always answer at every risk level", () => {
    const policy = new PermissionPolicy(tenant);
    const rules = newSessionRules();
    const read = request({ toolName: "m365_list_recent_mail", risk: "read" });

    policy.remember(read, "deny_always", rules);
    const outcome = policy.evaluate(read, rules);
    expect(outcome.decision).toBe("deny");
    expect(outcome.source).toBe("user_rule");
  });

  it("keeps prompting for writes when the tenant mandates approval, despite an allow rule", () => {
    const policy = new PermissionPolicy({ ...tenant, requireApprovalForWrites: true });
    const rules = newSessionRules();
    const write = request({ toolName: "m365_resolve_link", family: "m365.files", risk: "write" });

    policy.remember(write, "allow_always", rules);
    // A device-managed approval floor cannot be switched off by the user.
    expect(policy.evaluate(write, rules).decision).toBe("ask");
  });

  it("lets tenant policy override a user allow rule", () => {
    const policy = new PermissionPolicy({ ...tenant, deniedToolFamilies: ["m365.mail"] });
    const rules = newSessionRules();
    rules.allowAlways.add("m365.mail:m365_send_mail");

    const outcome = policy.evaluate(request(), rules);
    expect(outcome.decision).toBe("deny");
    expect(outcome.source).toBe("tenant_policy");
  });

  it("denies a family outside the tenant allow-list", () => {
    const policy = new PermissionPolicy({ ...tenant, allowedToolFamilies: ["m365.calendar"] });
    const outcome = policy.evaluate(request(), newSessionRules());
    expect(outcome.decision).toBe("deny");
    expect(outcome.source).toBe("tenant_policy");
  });

  it("denies a call requiring a scope the tenant blocks", () => {
    const policy = new PermissionPolicy({ ...tenant, deniedScopes: ["Mail.Send"] });
    const outcome = policy.evaluate(request(), newSessionRules());
    expect(outcome.decision).toBe("deny");
    expect(outcome.reason).toContain("Mail.Send");
  });

  it("matches a skill's allowed-tools by family, wildcard, or empty list", () => {
    expect(PermissionPolicy.skillPermits([], "m365.mail")).toBe(true);
    expect(PermissionPolicy.skillPermits(["m365.mail"], "m365.mail")).toBe(true);
    expect(PermissionPolicy.skillPermits(["*"], "m365.mail")).toBe(true);
    expect(PermissionPolicy.skillPermits(["m365.calendar"], "m365.mail")).toBe(false);
  });
});

/**
 * The delegated grant.
 *
 * A research sub-agent's first move is a web fetch, which arrives as
 * `copilot.url` at risk `external` — never remembered, so always "ask". In a
 * session with no surface that ask could never be answered, and the turn burned
 * the whole wall clock before being retried once and burning it again. The
 * grant is the decision that started the run, written down; these pin what it
 * does and, more importantly, what it still cannot do.
 */
describe("PermissionPolicy with a delegated grant", () => {
  const fetch = request({
    toolName: "copilot.url",
    family: "copilot.url",
    risk: "external",
    requiredScopes: [],
  });
  const grant: DelegatedGrant = {
    families: ["browser", "knowledge", "copilot.url"],
    ceiling: "external",
  };

  it("allows an external call in a granted family instead of asking", () => {
    const policy = new PermissionPolicy(tenant);
    expect(policy.evaluate(fetch, newSessionRules()).decision).toBe("ask");

    const outcome = policy.evaluate(fetch, newSessionRules(), grant);
    expect(outcome.decision).toBe("allow");
    // Its own source, so the audit log never attributes this to a person who
    // was not there.
    expect(outcome.source).toBe("delegation");
  });

  it("still asks for a family the grant does not name", () => {
    const policy = new PermissionPolicy(tenant);
    expect(policy.evaluate(request(), newSessionRules(), grant).decision).toBe("ask");
  });

  it("cannot cover a destructive call at any ceiling", () => {
    const policy = new PermissionPolicy(tenant);
    const shell = request({ toolName: "copilot.shell", family: "copilot.shell", risk: "destructive" });
    // The ceiling enum has no `destructive` member, so naming the family is the
    // most a grant can ever do — and it is not enough.
    const wide: DelegatedGrant = { families: ["copilot.shell"], ceiling: "external" };
    expect(policy.evaluate(shell, newSessionRules(), wide).decision).toBe("ask");
  });

  it("respects a ceiling below the request's risk", () => {
    const policy = new PermissionPolicy(tenant);
    const readOnly: DelegatedGrant = { families: ["copilot.url"], ceiling: "read" };
    expect(policy.evaluate(fetch, newSessionRules(), readOnly).decision).toBe("ask");
  });

  it("is outranked by the tenant deny floor", () => {
    const policy = new PermissionPolicy({ ...tenant, deniedToolFamilies: ["copilot.url"] });
    const outcome = policy.evaluate(fetch, newSessionRules(), grant);
    expect(outcome.decision).toBe("deny");
    expect(outcome.source).toBe("tenant_policy");
  });

  it("is outranked by a tenant that requires approval for writes", () => {
    // An administrator who insists a human sees every write is saying delegated
    // work may only read. That is a coherent position and the grant must not
    // quietly overrule it.
    const policy = new PermissionPolicy({ ...tenant, requireApprovalForWrites: true });
    expect(policy.evaluate(fetch, newSessionRules(), grant).decision).toBe("ask");
  });

  it("leaves the read fast path alone", () => {
    const policy = new PermissionPolicy(tenant);
    const read = request({ toolName: "copilot.read", family: "copilot.read", risk: "read" });
    const outcome = policy.evaluate(read, newSessionRules(), { families: [], ceiling: "read" });
    expect(outcome.decision).toBe("allow");
    expect(outcome.source).toBe("user_rule");
  });
});
