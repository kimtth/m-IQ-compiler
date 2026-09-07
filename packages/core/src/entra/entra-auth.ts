import {
  CAPABILITY_SCOPES,
  isTenantIdentifier,
  resourceForCapability,
  scopesForCapabilities,
  type AuthStatus,
  type Capability,
  type EntraAccount,
  type TenantSummary,
} from "@iq/shared";
import type { Logger } from "../util/logger.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { TenantPolicy } from "../policy/tenant-policy.js";
import { messageOf } from "../util/text.js";
import {
  AzureCliError,
  AzureCliMissingError,
  classifyCliFailure,
  parseCliJson,
  spawnAzureCli,
  type CliResult,
  type RunCli,
} from "./azure-cli.js";

/**
 * Microsoft identity, without an app registration.
 *
 * The user is never asked for a client id, tenant id or redirect URI. Sign-in
 * runs the Azure CLI's own interactive flow and tokens are minted against the
 * CLI's first-party client, the way `AzureCliCredential` does. Two details of
 * that flow are load-bearing:
 *
 *  - `az logout` runs before every interactive sign-in. Without it a tenant
 *    switch silently reuses the previous identity and then fails with
 *    AADSTS50020, which reads like a permission problem but is not one.
 *  - `--allow-no-subscriptions` is always passed, because an identity used only
 *    for Graph and Work IQ frequently has no Azure subscription at all.
 *
 * The trade-off of borrowing the CLI's client is that Entra cannot enforce
 * incremental per-scope consent: tokens are resource-scoped. Least privilege is
 * therefore enforced here, in the app: a capability must survive the tenant
 * policy deny-list and be recorded in the consent ledger before its resource
 * token is ever requested.
 */

export interface EntraAuthDeps {
  logger: Logger;
  audit: AuditLog;
  tenantPolicy: TenantPolicy;
  /** Overridable for tests; defaults to spawning the real `az` executable. */
  runCli?: RunCli;
}

interface AzAccount {
  id?: string;
  name?: string;
  tenantId?: string;
  homeTenantId?: string;
  user?: { name?: string; type?: string };
}

/**
 * A row of `az account tenant list`. The CLI names the domain field
 * `defaultDomainName`; older CLIs omit the subcommand entirely, which is why
 * `listTenants` has a subscription-derived fallback.
 */
interface AzTenant {
  tenantId?: string;
  displayName?: string;
  defaultDomainName?: string;
}

export class EntraAuth {
  private readonly runCli: RunCli;
  private account: EntraAccount | null = null;
  private status: AuthStatus = { state: "signed_out" };
  /** Tenant the user pinned, or null to use the account's home tenant. */
  private tenantId: string | null = null;
  /** Capabilities whose consent has already been recorded this session. */
  private readonly consented = new Set<Capability>();
  private readonly granted = new Set<string>();
  private readonly listeners = new Set<(status: AuthStatus) => void>();
  /**
   * Fired when the active tenant changes under a switch. The orchestrator uses
   * it to invalidate Foundry model verification and any endpoint bound to the
   * tenant we just left — a deployment reachable in one tenant says nothing
   * about the next, so its "reachable" verdict must be re-earned.
   */
  private readonly tenantListeners = new Set<(tenantId: string | null) => void>();

  constructor(private readonly deps: EntraAuthDeps) {
    this.runCli = deps.runCli ?? spawnAzureCli;
  }

  onStatusChange(listener: (status: AuthStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Observe tenant switches. Returns an unsubscribe, like `onStatusChange`.
   *
   * The listener receives the tenant id now in effect (or null for the account's
   * home tenant), so a downstream registry can drop cached tokens and endpoints
   * bound to the previous tenant rather than discovering the mismatch mid-turn.
   */
  onTenantChanged(listener: (tenantId: string | null) => void): () => void {
    this.tenantListeners.add(listener);
    return () => this.tenantListeners.delete(listener);
  }

  getStatus(): AuthStatus {
    return this.status;
  }

  /** The signed-in identity, or null. Used to scope per-user state and audit. */
  currentAccount(): { oid: string; tenantId: string; username: string } | null {
    if (!this.account) return null;
    return {
      oid: this.account.oid,
      tenantId: this.account.tenantId,
      username: this.account.username,
    };
  }

  /**
   * True when Microsoft-backed capabilities are usable at all.
   *
   * Kept as a capability probe rather than a registration probe: there is no
   * registration any more, only a CLI that is present or absent.
   */
  isConfigured(): boolean {
    return this.status.state !== "cli_missing";
  }

  /** The tenant the next sign-in will target, or null for the home tenant. */
  preferredTenantId(): string | null {
    return this.tenantId;
  }

  /**
   * Pin a tenant for subsequent sign-ins.
   *
   * Changing it invalidates the current session, because a token issued by one
   * tenant tells us nothing about access in another.
   */
  setPreferredTenantId(tenantId: string | null): void {
    const next = tenantId && tenantId.trim() ? tenantId.trim() : null;
    if (next === this.tenantId) return;
    this.tenantId = next;
    if (this.status.state === "signed_in") {
      this.account = null;
      this.consented.clear();
      this.granted.clear();
      this.setStatus({ state: "signed_out" });
    }
  }

  private setStatus(status: AuthStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  /**
   * List the tenants the signed-in account can reach, for the tenant picker.
   *
   * Once the account is known the app offers these instead of asking the user to
   * paste a GUID a second time. `az account tenant list` is the direct source,
   * but it only exists on newer CLIs (it ships with the `account` extension), so
   * a non-zero exit or an "unrecognized" error falls back to deriving the tenant
   * set from `az account list --all`, which every CLI has. Either way a failure
   * yields an empty list with a logged reason rather than throwing: the raw
   * tenant field always remains, so a missing picker must never block sign-in.
   */
  async listTenants(): Promise<TenantSummary[]> {
    const current = this.account?.tenantId ?? this.tenantId ?? null;
    try {
      const result = await this.az(["account", "tenant", "list", "-o", "json"], 30_000);
      if (result.code === 0) {
        const rows = parseCliJson<AzTenant[]>(result.stdout);
        const tenants = rows
          .filter((row): row is AzTenant & { tenantId: string } => Boolean(row.tenantId))
          .map<TenantSummary>((row) => ({
            tenantId: row.tenantId,
            displayName: row.displayName ?? row.defaultDomainName ?? row.tenantId,
            defaultDomain: row.defaultDomainName ?? "",
            current: current !== null && row.tenantId === current,
          }));
        if (tenants.length > 0) return tenants;
      } else {
        this.deps.logger.debug("entra.listTenants.subcommand", {
          reason: firstLine(result.stderr) || `exit ${result.code}`,
        });
      }
    } catch (error) {
      if (error instanceof AzureCliMissingError) return [];
      this.deps.logger.debug("entra.listTenants.subcommand", { message: messageOf(error) });
    }

    // Fallback: every CLI can list subscriptions, and each carries its tenant.
    // Subscription names are not tenant names, so the id doubles as the display
    // name here; the picker still shows a real, selectable tenant.
    try {
      const result = await this.az(["account", "list", "--all", "-o", "json"], 30_000);
      if (result.code !== 0) {
        this.deps.logger.debug("entra.listTenants.fallback", {
          reason: firstLine(result.stderr) || `exit ${result.code}`,
        });
        return [];
      }
      const subs = parseCliJson<AzAccount[]>(result.stdout);
      const byTenant = new Map<string, TenantSummary>();
      for (const sub of subs) {
        const tenantId = sub.tenantId ?? sub.homeTenantId;
        if (!tenantId || byTenant.has(tenantId)) continue;
        byTenant.set(tenantId, {
          tenantId,
          displayName: tenantId,
          defaultDomain: "",
          current: current !== null && tenantId === current,
        });
      }
      return [...byTenant.values()];
    } catch (error) {
      if (error instanceof AzureCliMissingError) return [];
      this.deps.logger.debug("entra.listTenants.fallback", { message: messageOf(error) });
      return [];
    }
  }

  /**
   * Switch the active tenant and re-authenticate against it.
   *
   * Distinct from `setPreferredTenantId`, which only records the target for the
   * next sign-in. Switching is a full re-authentication with four load-bearing
   * steps: the identifier is validated *before any CLI call* so a typo is a
   * field error rather than an opaque AADSTS failure; the cached resource tokens
   * and the consent ledger are dropped, because a token minted by one tenant
   * says nothing about access in another; the interactive flow re-runs via
   * `signIn`, which clears the cached CLI account first (see the class comment —
   * without the `az logout` the CLI silently reuses the old identity and the
   * switch fails with AADSTS50020); and the change is audited and announced to
   * `onTenantChanged` listeners so tenant-bound state elsewhere is invalidated.
   */
  async switchTenant(tenantId: string | null, correlationId: string): Promise<AuthStatus> {
    let target: string | null = null;
    if (tenantId !== null) {
      target = tenantId.trim();
      if (!target || !isTenantIdentifier(target)) {
        throw new AzureCliError({
          kind: "failed",
          message: `"${tenantId}" is not a valid tenant. Enter a tenant GUID or a domain such as contoso.onmicrosoft.com.`,
        });
      }
    }

    const previousTenantId = this.account?.tenantId ?? this.tenantId ?? null;

    // Drop the whole resource-token and consent ledger before the switch; none
    // of it carries across a tenant boundary.
    this.consented.clear();
    this.granted.clear();

    try {
      const status = await this.signIn(correlationId, target);
      await this.deps.audit.record({
        actor: this.auditActor(),
        action: "auth.tenant.switch",
        family: "identity",
        outcome: "succeeded",
        correlationId,
        reason: `tenant ${previousTenantId ?? "home"} -> ${this.account?.tenantId ?? target ?? "home"}`,
      });
      const now = this.account?.tenantId ?? null;
      for (const listener of this.tenantListeners) listener(now);
      return status;
    } catch (error) {
      await this.deps.audit.record({
        actor: { kind: "system" },
        action: "auth.tenant.switch",
        family: "identity",
        outcome: "failed",
        correlationId,
        reason: `tenant ${previousTenantId ?? "home"} -> ${target ?? "home"}: ${messageOf(error)}`,
      });
      throw error;
    }
  }

  private async az(args: readonly string[], timeoutMs?: number): Promise<CliResult> {
    try {
      return await this.runCli(args, timeoutMs);
    } catch (error) {
      if (error instanceof AzureCliMissingError) {
        this.account = null;
        this.setStatus({ state: "cli_missing", message: error.message });
      }
      throw error;
    }
  }

  /**
   * Detect an existing CLI session on boot, without prompting.
   *
   * A missing CLI is a status, not a crash: chat and local skills work without
   * any Microsoft identity, so the app must still start and explain itself.
   */
  async initialize(): Promise<AuthStatus> {
    try {
      const result = await this.az(["account", "show", "-o", "json"], 30_000);
      if (result.code !== 0) {
        this.setStatus({ state: "signed_out" });
        return this.status;
      }
      const account = this.toAccount(parseCliJson<AzAccount>(result.stdout));
      this.assertTenantAllowed(account.tenantId);
      this.adopt(account);
    } catch (error) {
      if (error instanceof AzureCliMissingError) return this.status;
      this.deps.logger.debug("entra.initialize", { message: messageOf(error) });
      this.setStatus({ state: "signed_out" });
    }
    return this.status;
  }

  /**
   * Interactive sign-in through the Azure CLI.
   *
   * `az logout` first is deliberate: see the class comment. Its failure is
   * ignored because "not logged in" is the state we are trying to reach.
   */
  async signIn(correlationId: string, tenantId?: string | null): Promise<AuthStatus> {
    if (tenantId !== undefined) this.setPreferredTenantId(tenantId);
    this.setStatus({ state: "signing_in" });

    try {
      await this.az(["logout"], 60_000).catch(() => undefined);

      const args = ["login", "--allow-no-subscriptions", "-o", "json"];
      if (this.tenantId) args.push("--tenant", this.tenantId);
      const result = await this.az(args);
      if (result.code !== 0) throw new AzureCliError(classifyCliFailure(result.stderr, result.code));

      const shown = await this.az(["account", "show", "-o", "json"], 30_000);
      if (shown.code !== 0) throw new AzureCliError(classifyCliFailure(shown.stderr, shown.code));

      const account = this.toAccount(parseCliJson<AzAccount>(shown.stdout));
      this.assertTenantAllowed(account.tenantId);

      await this.deps.audit.record({
        actor: { kind: "user", oid: account.oid, tenantId: account.tenantId },
        action: "auth.signin",
        family: "identity",
        outcome: "succeeded",
        correlationId,
        scopes: [...CAPABILITY_SCOPES["auth.signin"]],
      });

      this.adopt(account);
      return this.status;
    } catch (error) {
      const message = messageOf(error);
      await this.deps.audit.record({
        actor: { kind: "system" },
        action: "auth.signin",
        family: "identity",
        outcome: "failed",
        correlationId,
        reason: message,
      });
      if (this.status.state !== "cli_missing") this.setStatus({ state: "error", message });
      throw error;
    }
  }

  async signOut(correlationId: string): Promise<void> {
    const account = this.account;
    try {
      await this.az(["logout"], 60_000);
    } catch (error) {
      this.deps.logger.debug("entra.signout", { message: messageOf(error) });
    }
    if (account) {
      await this.deps.audit.record({
        actor: { kind: "user", oid: account.oid, tenantId: account.tenantId },
        action: "auth.signout",
        family: "identity",
        outcome: "succeeded",
        correlationId,
      });
    }
    this.account = null;
    this.consented.clear();
    this.granted.clear();
    if (this.status.state !== "cli_missing") this.setStatus({ state: "signed_out" });
  }

  /**
   * Acquire a token for one capability.
   *
   * This stays the single entry point for every Graph, Work IQ and Speech call,
   * which is what keeps the capability surface honest even though the underlying
   * token is resource-scoped rather than scope-scoped.
   */
  async acquireForCapability(capability: Capability, correlationId: string): Promise<string> {
    const scopes = scopesForCapabilities([capability]);

    const blocked = scopes.find((scope) => this.deps.tenantPolicy.deniedScopes.includes(scope));
    if (blocked) {
      await this.deps.audit.record({
        actor: this.auditActor(),
        action: "auth.consent",
        family: "identity",
        outcome: "denied",
        correlationId,
        scopes,
        reason: `scope "${blocked}" is denied by tenant policy`,
      });
      throw new Error(`scope "${blocked}" is denied by tenant policy`);
    }

    const account = this.account;
    if (!account) {
      throw new AzureCliError({
        kind: "not_signed_in",
        message: "Connect your Microsoft account to use this capability.",
      });
    }

    const resource = resourceForCapability(capability);
    const args = ["account", "get-access-token", "--resource", resource, "-o", "json"];
    if (this.tenantId) args.push("--tenant", this.tenantId);

    const result = await this.az(args, 120_000);
    if (result.code !== 0) {
      const failure = classifyCliFailure(result.stderr, result.code);
      await this.deps.audit.record({
        actor: this.auditActor(),
        action: "auth.consent",
        family: "identity",
        outcome: "failed",
        correlationId,
        scopes,
        reason: failure.message,
      });
      if (failure.kind === "not_signed_in") {
        this.account = null;
        this.setStatus({ state: "signed_out" });
      }
      throw new AzureCliError(failure);
    }

    const token = parseCliJson<{ accessToken?: string }>(result.stdout).accessToken;
    if (!token) throw new Error(`no token returned for ${capability}`);

    if (!this.consented.has(capability)) {
      this.consented.add(capability);
      await this.deps.audit.record({
        actor: this.auditActor(),
        action: "auth.consent",
        family: "identity",
        outcome: "allowed",
        correlationId,
        scopes,
        reason: `first use of ${capability} against ${resource}`,
      });
    }

    let changed = false;
    for (const scope of scopes) {
      if (!this.granted.has(scope)) {
        this.granted.add(scope);
        changed = true;
      }
    }
    if (changed) this.adopt(account);

    return token;
  }

  private adopt(account: EntraAccount): void {
    this.account = account;
    this.setStatus({
      state: "signed_in",
      account,
      grantedScopes: [...this.granted].sort(),
    });
  }

  private auditActor() {
    const account = this.account;
    return account
      ? ({ kind: "user", oid: account.oid, tenantId: account.tenantId } as const)
      : ({ kind: "system" } as const);
  }

  private assertTenantAllowed(tenantId: string): void {
    const allowed = this.deps.tenantPolicy.allowedTenantIds;
    if (allowed.length > 0 && !allowed.includes(tenantId)) {
      throw new Error(`tenant ${tenantId} is not permitted by policy`);
    }
  }

  /**
   * Map `az account show` onto our account shape.
   *
   * The CLI reports the tenant and the user principal name but not the Entra
   * object id. Rather than pay for an extra Graph round-trip on every boot, the
   * UPN is used as the stable per-user key; it is unique within a tenant, which
   * is all the audit log and per-user state need.
   */
  private toAccount(raw: AzAccount): EntraAccount {
    const tenantId = raw.tenantId ?? raw.homeTenantId ?? "";
    const username = raw.user?.name ?? "";
    if (!tenantId || !username) throw new Error("Azure CLI returned an incomplete account");
    return {
      homeAccountId: `${username}.${tenantId}`,
      oid: username,
      tenantId,
      username,
      name: raw.name ?? null,
    };
  }
}

/** First non-empty line of CLI stderr, for a terse debug reason. */
function firstLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?? "";
}
