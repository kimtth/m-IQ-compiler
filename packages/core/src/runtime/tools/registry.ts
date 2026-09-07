import { z } from "zod";
import { defineTool, type Tool } from "@github/copilot-sdk";
import {
  newToolCallId,
  scopesForCapabilities,
  type Capability,
  type PermissionOutcome,
  type PermissionRequest,
  type RiskLevel,
} from "@iq/shared";
import type { AuditLog } from "../../audit/audit-log.js";
import type { Logger } from "../../util/logger.js";

/**
 * Governed tool.
 *
 * A governed tool self-registers, is exposed through a toolset and can be gated
 * by registry check functions. Two Microsoft-specific declarations are added:
 * the Entra capability the tool needs, and the risk level that drives approval.
 */
export interface GovernedTool<TArgs = unknown> {
  name: string;
  /** Toolset this belongs to; the unit tenant policy and skills allow or deny. */
  family: string;
  description: string;
  risk: RiskLevel;
  /** Entra capability whose scopes this tool consumes, if any. */
  capability?: Capability;
  parameters: z.ZodType<TArgs>;
  /** One-line, human-readable rendering of what the call will do. */
  summarize: (args: TArgs) => string;
  /** Resource identifiers touched, recorded for audit. */
  resources?: (args: TArgs) => string[];
  handler: (args: TArgs, context: ToolContext) => Promise<unknown>;
  /** Mark results that originate outside our trust boundary. */
  untrustedResult?: boolean;
}

/** A registered tool with its argument type erased. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyGovernedTool = GovernedTool<any>;

export interface ToolContext {
  sessionId: string;
  turnId: string;
  correlationId: string;
  logger: Logger;
}

/** Resolves an approval, either from policy alone or by asking the user. */
export interface ApprovalBroker {
  decide(
    request: PermissionRequest,
    context: ToolContext,
  ): Promise<PermissionOutcome>;
}

/**
 * Registry that turns governed tools into Copilot SDK tools.
 *
 * The SDK's own permission prompt is bypassed for these tools
 * (`skipPermission: true`) because approval must be settled by our policy chain
 * in the privileged process and written to the durable turn log before the side
 * effect starts. Deferring to the SDK prompt would leave no auditable record.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyGovernedTool>();
  /**
   * The SDK schema for each registered tool, converted once at registration.
   *
   * Converting here rather than in {@link toSdkTools} is what makes an
   * unsupported Zod shape a start-up failure instead of a run-time one: a
   * `z.unknown()` parameter used to convert cleanly enough to register and then
   * throw on the first turn that offered the tool, so the defect surfaced as
   * "every Fabric run fails" rather than as "this tool is malformed".
   */
  private readonly schemas = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly broker: ApprovalBroker,
    private readonly audit: AuditLog,
  ) {}

  register<TArgs>(tool: GovernedTool<TArgs>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool "${tool.name}" is already registered`);
    }
    let schema: Record<string, unknown>;
    try {
      schema = zodToSdkSchema(tool.parameters);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`tool "${tool.name}" has an unusable parameter schema: ${message}`);
    }
    this.tools.set(tool.name, tool as AnyGovernedTool);
    this.schemas.set(tool.name, schema);
  }

  list(): Array<{ name: string; family: string; risk: RiskLevel }> {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      family: tool.family,
      risk: tool.risk,
    }));
  }

  /**
   * The registry as prose, grouped by family.
   *
   * Written for a model rather than a screen: a plan drawn from a recording
   * should reach for a governed tool that already exists instead of describing
   * the clicks it saw, and it can only do that if it knows what exists.
   */
  catalogue(): string {
    const byFamily = new Map<string, string[]>();
    for (const tool of this.tools.values()) {
      const lines = byFamily.get(tool.family) ?? [];
      lines.push(`  - ${tool.name} (${tool.risk}): ${tool.description}`);
      byFamily.set(tool.family, lines);
    }
    return [...byFamily.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([family, lines]) => [`${family}:`, ...lines.sort()].join("\n"))
      .join("\n");
  }

  families(): string[] {    return [...new Set([...this.tools.values()].map((tool) => tool.family))].sort();
  }

  /**
   * The family a registered tool belongs to, or null for a name we never
   * registered.
   *
   * Needed because the SDK executes our governed tools as its own
   * "custom-tool" kind, so the permission request that reaches the broker
   * carries `family: "copilot.custom-tool"` for every one of them. The tool
   * *name* survives, and it is the key this registry is built on, so the real
   * family is one lookup away. Anything that reasons about what a turn is
   * doing — rather than about whether it may — has to come back here for it.
   */
  familyOf(toolName: string): string | null {
    return this.tools.get(toolName)?.family ?? null;
  }

  /**
   * Build the SDK tool list for a session, filtered to the allowed families.
   * A family absent from `allowedFamilies` is not merely denied at call time —
   * it is never offered to the model, which is the cheaper failure mode.
   *
   * Schemas are read from the cache filled at registration; this method cannot
   * fail on a bad schema, because the registry never held one.
   */
  toSdkTools(
    allowedFamilies: readonly string[],
    context: () => ToolContext,
  ): Array<Tool<any>> {
    const out: Array<Tool<any>> = [];

    for (const tool of this.tools.values()) {
      if (allowedFamilies.length > 0 && !allowedFamilies.includes(tool.family)) continue;

      out.push(
        defineTool<any>(tool.name, {
          description: tool.description,
          parameters: this.schemas.get(tool.name) ?? {},
          skipPermission: true,
          handler: async (rawArgs) => this.invoke(tool, rawArgs, context()),
        }),
      );
    }

    return out;
  }

  /** Full governed invocation: validate, authorise, audit, execute, audit. */
  private async invoke(
    tool: AnyGovernedTool,
    rawArgs: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    const parsed = tool.parameters.safeParse(rawArgs);
    if (!parsed.success) {
      return { ok: false, error: `invalid arguments: ${parsed.error.message}` };
    }
    const args = parsed.data as never;

    const request: PermissionRequest = {
      toolCallId: newToolCallId(),
      toolName: tool.name,
      family: tool.family,
      risk: tool.risk,
      summary: tool.summarize(args),
      requiredScopes: tool.capability ? scopesForCapabilities([tool.capability]) : [],
      resources: tool.resources?.(args) ?? [],
    };

    const outcome = await this.broker.decide(request, context);
    const allowed = outcome.decision === "allow" || outcome.decision === "allow_always";

    await this.audit.record({
      actor: { kind: "agent", sessionId: context.sessionId, turnId: context.turnId },
      action: `${tool.family}.${tool.name}`,
      family: tool.family,
      outcome: allowed ? "allowed" : "denied",
      correlationId: context.correlationId,
      scopes: request.requiredScopes,
      resources: request.resources,
      reason: outcome.reason,
    });

    if (!allowed) {
      // Returned rather than thrown: the model should see the refusal and adapt.
      return { ok: false, error: `denied by policy: ${outcome.reason}` };
    }

    try {
      const result = await tool.handler(args, context);
      await this.audit.record({
        actor: { kind: "agent", sessionId: context.sessionId, turnId: context.turnId },
        action: `${tool.family}.${tool.name}`,
        family: tool.family,
        outcome: "succeeded",
        correlationId: context.correlationId,
        scopes: request.requiredScopes,
        resources: request.resources,
      });
      return tool.untrustedResult
        ? { ok: true, untrusted: true, data: result }
        : { ok: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.audit.record({
        actor: { kind: "agent", sessionId: context.sessionId, turnId: context.turnId },
        action: `${tool.family}.${tool.name}`,
        family: tool.family,
        outcome: "failed",
        correlationId: context.correlationId,
        scopes: request.requiredScopes,
        resources: request.resources,
        reason: message,
      });
      context.logger.warn("tool failed", { tool: tool.name, error: message });
      return { ok: false, error: message };
    }
  }
}

/**
 * The SDK accepts either a Zod-like schema (an object exposing `toJSONSchema`)
 * or a raw JSON Schema. Zod v3 has no `toJSONSchema`, so we convert once here.
 */
function zodToSdkSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  return jsonSchemaFromZod(schema);
}

/**
 * Minimal Zod-to-JSON-Schema conversion covering the shapes tools actually use.
 * Kept deliberately small and explicit rather than pulling in a converter, so an
 * unsupported shape fails loudly at registration time instead of silently
 * producing a schema the model cannot satisfy.
 */
function jsonSchemaFromZod(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as { typeName?: string };

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = jsonSchemaFromZod(value);
        if (!value.isOptional()) required.push(key);
      }
      return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      };
    }
    case z.ZodFirstPartyTypeKind.ZodString:
      return withDescription(schema, { type: "string" });
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return withDescription(schema, { type: "number" });
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return withDescription(schema, { type: "boolean" });
    case z.ZodFirstPartyTypeKind.ZodArray:
      return withDescription(schema, {
        type: "array",
        items: jsonSchemaFromZod((schema as z.ZodArray<z.ZodTypeAny>).element),
      });
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return withDescription(schema, {
        type: "string",
        enum: [...(schema as z.ZodEnum<[string, ...string[]]>).options],
      });
    case z.ZodFirstPartyTypeKind.ZodOptional:
      return jsonSchemaFromZod((schema as z.ZodOptional<z.ZodTypeAny>).unwrap());
    case z.ZodFirstPartyTypeKind.ZodDefault:
      return jsonSchemaFromZod((schema as z.ZodDefault<z.ZodTypeAny>)._def.innerType);
    case z.ZodFirstPartyTypeKind.ZodNullable:
      return jsonSchemaFromZod((schema as z.ZodNullable<z.ZodTypeAny>).unwrap());
    default:
      throw new Error(`unsupported Zod type in tool schema: ${String(def.typeName)}`);
  }
}

function withDescription(
  schema: z.ZodTypeAny,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const description = schema.description;
  return description ? { ...base, description } : base;
}
