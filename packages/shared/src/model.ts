import { z } from "zod";

/**
 * Model registry contracts.
 *
 * Two providers, and only two. GitHub Copilot's models come from the SDK's
 * advertised catalogue for the signed-in account and are never configured by
 * hand; Microsoft Foundry entries are added explicitly by the user. Both are
 * read through one registry, so the composer's model picker, Control Center →
 * Models and Connections & access can never disagree about what exists.
 *
 * No key ever appears here. Foundry is reached with the Azure identity, so the
 * only secret in the system stays in the Azure CLI's own token cache.
 */

export const ModelProvider = z.enum(["copilot", "foundry"]);
export type ModelProvider = z.infer<typeof ModelProvider>;

export const ModelCapability = z.enum(["chat", "reasoning", "vision", "image", "embeddings"]);
export type ModelCapability = z.infer<typeof ModelCapability>;

/**
 * A Foundry entry names a deployment. Nothing else.
 *
 * It used to also accept a published Foundry agent by id, which meant a second
 * API surface, a second API version, a second probe shape and a discovery call
 * — all to reach a runtime the app already reaches through the Copilot SDK. The
 * option earned none of that: it doubled the Add-a-model form and every code
 * path that touched an entry, and it was never covered against a live agent.
 * Deployments are the one Foundry shape this product needs.
 */
export const DEPLOYMENT_API_VERSION = "2024-10-21";

export const ModelTestState = z.enum([
  "untested",
  "reachable",
  "unauthorized",
  "not_found",
  "failed",
]);
export type ModelTestState = z.infer<typeof ModelTestState>;

export const ModelTestResult = z.object({
  state: ModelTestState,
  message: z.string(),
  /** What the user should do next when the state is not `reachable`. */
  nextStep: z.string(),
  testedAt: z.string().datetime(),
});
export type ModelTestResult = z.infer<typeof ModelTestResult>;

/**
 * User-supplied shape of a Foundry entry. `id` is absent when creating.
 *
 * The endpoint is validated as an https URL at the boundary rather than in the
 * handler: a model entry is a network destination the agent will be pointed at,
 * so a malformed one must not survive long enough to be dialled.
 */
export const FoundryModelInput = z.object({
  id: z.string().min(1).max(120).optional(),
  displayName: z.string().min(1).max(120),
  endpoint: z
    .string()
    .url()
    .refine((value) => value.startsWith("https://"), "the endpoint must be https"),
  deploymentName: z.string().max(200).default(""),
  apiVersion: z.string().min(1).max(40).default(DEPLOYMENT_API_VERSION),
  capabilities: z.array(ModelCapability).min(1),
  /** Empty means available in every project. */
  projectIds: z.array(z.string()).default([]),
});
export type FoundryModelInput = z.infer<typeof FoundryModelInput>;

export const FoundryModelEntry = FoundryModelInput.extend({
  id: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastTest: ModelTestResult.nullable().default(null),
});
export type FoundryModelEntry = z.infer<typeof FoundryModelEntry>;

/**
 * One row of the unified catalogue, whatever the provider.
 *
 * `id` is what every other surface stores: a role default, a per-project
 * override, a council member's model, the provenance of a generated image.
 */
export const ModelCatalogEntry = z.object({
  id: z.string(),
  provider: ModelProvider,
  displayName: z.string(),
  capabilities: z.array(ModelCapability),
  /** Copilot entries are advertised, not configured; they cannot be edited. */
  editable: z.boolean(),
  /** Foundry only. Host of the endpoint — never the full URL, which may carry a path. */
  endpointHost: z.string().default(""),
  projectIds: z.array(z.string()).default([]),
  lastTest: ModelTestResult.nullable().default(null),
  /** Copilot only: whether the SDK reports the model as currently usable. */
  available: z.boolean().default(true),
});
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntry>;

/**
 * Roles a default can be set for.
 *
 * Defaults are layered: role default → per-project override → per-turn
 * override from the composer. The composer never carries its own list.
 */
export const ModelRole = z.enum([
  "chat",
  "reasoning",
  "office",
  "image",
  "research",
  "council",
]);
export type ModelRole = z.infer<typeof ModelRole>;

export const MODEL_ROLE_LABELS = {
  chat: "Chat",
  reasoning: "Reasoning",
  office: "Office authoring",
  image: "Image generation",
  research: "Research writer",
  council: "Council member",
} as const satisfies Record<ModelRole, string>;

/** The capability a model must advertise to be eligible for a role. */
export const MODEL_ROLE_CAPABILITY = {
  chat: "chat",
  reasoning: "reasoning",
  office: "chat",
  image: "image",
  research: "chat",
  council: "chat",
} as const satisfies Record<ModelRole, ModelCapability>;

export const ModelDefaults = z.object({
  /** Role → catalogue entry id, or null to fall back to the runtime default. */
  roles: z.record(ModelRole, z.string().nullable()).default({}),
  /** Project id → role → entry id. Overrides `roles` for that project. */
  projects: z.record(z.string(), z.record(ModelRole, z.string().nullable())).default({}),
});
export type ModelDefaults = z.infer<typeof ModelDefaults>;

export const ModelCatalog = z.object({
  entries: z.array(ModelCatalogEntry),
  defaults: ModelDefaults,
  /** Set when the Copilot side of the catalogue could not be read. */
  copilotError: z.string().nullable().default(null),
});
export type ModelCatalog = z.infer<typeof ModelCatalog>;

/** Whether an entry is offered in a project. Empty scope means everywhere. */
export const modelInProject = (
  entry: ModelCatalogEntry,
  projectId: string | null,
): boolean =>
  entry.projectIds.length === 0 ||
  (projectId !== null && entry.projectIds.includes(projectId));

/**
 * Which model answers for a role, given a catalogue.
 *
 * Precedence: a per-project override for the role, then the role default,
 * then the first eligible entry advertising the capability the role requires.
 * A referenced id that no longer advertises the required capability is skipped
 * rather than returned, so a stale default degrades to a working model instead
 * of one that cannot do the job.
 *
 * This lives in the shared package because it is the *meaning* of the setting,
 * and both sides need it: the privileged registry resolves it to run a turn,
 * and a surface with a model picker has to open on the same answer. When each
 * had its own copy they disagreed — Image Creation ignored the configured image
 * model entirely and opened on whatever image-capable deployment happened to be
 * first, so the image-generation default looked like it did nothing.
 */
export function resolveModelForRole(
  catalog: ModelCatalog,
  role: ModelRole,
  projectId: string | null = null,
): ModelCatalogEntry | null {
  const required = MODEL_ROLE_CAPABILITY[role];
  const byId = new Map(catalog.entries.map((entry) => [entry.id, entry]));

  const eligible = (entry: ModelCatalogEntry | undefined): entry is ModelCatalogEntry =>
    entry !== undefined &&
    entry.capabilities.includes(required) &&
    entry.available &&
    modelInProject(entry, projectId);

  if (projectId !== null) {
    const pinned = catalog.defaults.projects[projectId]?.[role];
    if (pinned) {
      const entry = byId.get(pinned);
      if (eligible(entry)) return entry;
    }
  }

  const roleDefault = catalog.defaults.roles[role];
  if (roleDefault) {
    const entry = byId.get(roleDefault);
    if (eligible(entry)) return entry;
  }

  return catalog.entries.find((entry) => eligible(entry)) ?? null;
}

/** Stable id for a Foundry entry, used as the catalogue id too. */
export const foundryModelId = (id: string): string => `foundry:${id}`;
export const copilotModelId = (name: string): string => `copilot:${name}`;

export const parseModelId = (
  id: string,
): { provider: ModelProvider; ref: string } | null => {
  const index = id.indexOf(":");
  if (index <= 0) return null;
  const provider = ModelProvider.safeParse(id.slice(0, index));
  if (!provider.success) return null;
  return { provider: provider.data, ref: id.slice(index + 1) };
};
