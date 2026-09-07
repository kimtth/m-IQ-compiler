import { z } from "zod";

/**
 * Microsoft Entra ID identity and scope contracts.
 *
 * IQ Compiler is registration-free: the user never supplies a client id, tenant
 * id or redirect URI. Microsoft identity is borrowed from the Azure CLI's own
 * first-party client (`az login` / `az account get-access-token`).
 *
 * The consequence is that Entra-enforced *incremental consent per Graph scope*
 * is not available — the CLI can only issue resource-level `.default` tokens.
 * The capability map below is therefore enforced by the app itself: it drives
 * the consent ledger, the tenant policy deny-list and the audit record, and it
 * decides which resource token a capability is allowed to obtain at all. A
 * capability that has not been consented to never reaches token acquisition.
 */

export const EntraAccount = z.object({
  homeAccountId: z.string(),
  /** Entra object id of the signed-in user. */
  oid: z.string(),
  tenantId: z.string(),
  username: z.string(),
  name: z.string().nullable(),
});
export type EntraAccount = z.infer<typeof EntraAccount>;

export const AuthStatus = z.discriminatedUnion("state", [
  /**
   * The Azure CLI is not installed or not on PATH. The app still runs — chat
   * needs no Microsoft identity — and every Azure-bound capability stays
   * unavailable with an actionable message rather than a silent failure.
   */
  z.object({ state: z.literal("cli_missing"), message: z.string() }),
  z.object({ state: z.literal("signed_out") }),
  z.object({ state: z.literal("signing_in") }),
  z.object({
    state: z.literal("signed_in"),
    account: EntraAccount,
    grantedScopes: z.array(z.string()),
  }),
  z.object({ state: z.literal("error"), message: z.string() }),
]);
export type AuthStatus = z.infer<typeof AuthStatus>;

/**
 * Least-privilege capability map.
 *
 * Scopes are grouped per capability so that consent is requested incrementally
 * at the moment of first use, rather than as one broad up-front grant. Only
 * delegated scopes are used; the desktop client never holds application
 * permissions.
 */
export const CAPABILITY_SCOPES = {
  "auth.signin": ["openid", "profile", "offline_access", "User.Read"],
  "m365.mail.read": ["Mail.Read"],
  "m365.mail.send": ["Mail.Send"],
  "m365.calendar.read": ["Calendars.Read"],
  "m365.calendar.write": ["Calendars.ReadWrite"],
  "m365.files.read": ["Files.Read.All"],
  "m365.files.write": ["Files.ReadWrite.All"],
  "m365.sites.read": ["Sites.Read.All"],
  "m365.people.read": ["People.Read"],
  "m365.teams.read": ["Chat.Read", "ChannelMessage.Read.All"],
  /**
   * Azure AI Speech, used by meeting transcription and voice interaction.
   *
   * This is the only capability whose scope is not Microsoft Graph. It is
   * requested at first use like every other one, so an install that never
   * touches voice never asks for it — and a tenant that wants voice off can
   * deny the scope in `deniedScopes` without touching anything else.
   */
  "azure.speech": ["https://cognitiveservices.azure.com/.default"],
  /**
   * Microsoft Foundry: chat, reasoning and image deployments. Reached with the
   * Azure identity, so no endpoint key is ever stored by this app.
   *
   * The audience is `ai.azure.com`, which is what a Foundry resource
   * (`‹name›.services.ai.azure.com`) issues its samples against and what the v1
   * surface expects. It is deliberately *not* `cognitiveservices.azure.com`:
   * that is the classic Azure OpenAI audience, and a token minted for it is not
   * accepted everywhere a Foundry deployment is reached.
   */
  "azure.foundry": ["https://ai.azure.com/.default"],
  /**
   * Microsoft Fabric: project items, artifact creation and the Data Agent.
   *
   * A separate capability from `azure.foundry` despite both being Azure rather
   * than Graph, because it is a separate resource with a separate token and a
   * tenant may well allow one and not the other. Fabric is also the only
   * capability here that can *create* things in a shared project, which is
   * precisely the sort of thing an administrator wants to be able to deny on
   * its own.
   */
  "azure.fabric": ["https://api.fabric.microsoft.com/.default"],
} as const satisfies Record<string, readonly string[]>;

export type Capability = keyof typeof CAPABILITY_SCOPES;

/** Resolve the minimum scope set for a group of capabilities, de-duplicated. */
export function scopesForCapabilities(capabilities: readonly Capability[]): string[] {
  const set = new Set<string>();
  for (const capability of capabilities) {
    for (const scope of CAPABILITY_SCOPES[capability]) set.add(scope);
  }
  return [...set].sort();
}

/**
 * The Azure resource each capability draws its token from.
 *
 * Without an app registration a token can only be requested per resource, so
 * this is the real boundary the identity provider enforces. `CAPABILITY_SCOPES`
 * stays the boundary the *app* enforces, and remains the unit of consent, audit
 * and tenant policy.
 */
export const CAPABILITY_RESOURCE = {
  "auth.signin": "https://graph.microsoft.com",
  "m365.mail.read": "https://graph.microsoft.com",
  "m365.mail.send": "https://graph.microsoft.com",
  "m365.calendar.read": "https://graph.microsoft.com",
  "m365.calendar.write": "https://graph.microsoft.com",
  "m365.files.read": "https://graph.microsoft.com",
  "m365.files.write": "https://graph.microsoft.com",
  "m365.sites.read": "https://graph.microsoft.com",
  "m365.people.read": "https://graph.microsoft.com",
  "m365.teams.read": "https://graph.microsoft.com",
  "azure.speech": "https://cognitiveservices.azure.com",
  "azure.foundry": "https://ai.azure.com",
  "azure.fabric": "https://api.fabric.microsoft.com",
} as const satisfies Record<Capability, string>;

export const resourceForCapability = (capability: Capability): string =>
  CAPABILITY_RESOURCE[capability];

/**
 * A tenant the signed-in account can reach.
 *
 * Once the account is known the app lists these and offers them as a picker,
 * so switching tenant never requires pasting a GUID a second time. The raw
 * field stays available for a tenant not in the list — one the user is being
 * invited into, for example.
 */
export const TenantSummary = z.object({
  tenantId: z.string(),
  displayName: z.string(),
  defaultDomain: z.string(),
  /** True for the tenant the current session is signed in to. */
  current: z.boolean().default(false),
});
export type TenantSummary = z.infer<typeof TenantSummary>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * A tenant identifier is a GUID or a domain. Validated before sign-in is
 * attempted so a typo is a field error rather than an opaque AADSTS failure
 * three seconds into an interactive browser flow.
 */
export const isTenantIdentifier = (value: string): boolean => {
  const trimmed = value.trim();
  return GUID.test(trimmed) || DOMAIN.test(trimmed);
};

/**
 * Why an Azure sign-in failed, in the terms the user can act on.
 *
 * `wrong_tenant` is the one worth naming: AADSTS50020 reads like a permission
 * problem but means the account is not a member of the requested tenant, and
 * the fix is the tenant picker rather than a support ticket.
 */
export const AzureFailureKind = z.enum([
  "cli_missing",
  "cancelled",
  "wrong_tenant",
  "consent_required",
  "expired",
  "not_signed_in",
  "failed",
]);
export type AzureFailureKind = z.infer<typeof AzureFailureKind>;

/**
 * GitHub Copilot connection state.
 *
 * The agent runtime is the GitHub Copilot SDK, so a Copilot sign-in is the one
 * connection the app cannot work without — it is surfaced before the project
 * opens rather than failing mid-turn. The SDK owns the device-code flow and the
 * credential store under `COPILOT_HOME`; IQ Compiler only reads the result, so
 * no GitHub token ever passes through IQ Compiler's own storage.
 */
export const CopilotAuthStatus = z.discriminatedUnion("state", [
  /** The runtime has not been started yet, so nothing can be asserted. */
  z.object({ state: z.literal("unknown") }),
  z.object({ state: z.literal("signed_out"), message: z.string() }),
  z.object({
    state: z.literal("signed_in"),
    login: z.string().nullable(),
    host: z.string().nullable(),
    /**
     * How the runtime authenticated. `env` and `gh-cli` mean the credential
     * came from outside the app, which is worth showing: it explains why
     * signing out inside IQ Compiler would not change anything.
     */
    authType: z.string().nullable(),
  }),
  z.object({ state: z.literal("error"), message: z.string() }),
]);
export type CopilotAuthStatus = z.infer<typeof CopilotAuthStatus>;
