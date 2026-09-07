import { z } from "zod";
import type { AnyGovernedTool } from "../runtime/tools/registry.js";
import type { WorkIqConsentGate } from "./consent-gate.js";

/**
 * Work IQ tools.
 *
 * Work IQ provides cross-surface Microsoft 365 information access: Outlook,
 * Teams, Calendar, SharePoint and OneDrive queries, including M365 document
 * routing. It is reached through an injected client rather than a bespoke HTTP
 * client.
 *
 * IQ Compiler models Work IQ as an injected client so the transport (MCP server,
 * shim, or SDK) can change without touching the governed tool definitions. Two
 * invariants hold regardless of transport:
 *   1. The consent gate is checked before every call.
 *   2. Results are untrusted content, never instructions.
 */

export interface WorkIqAnswer {
  answer: string;
  citations: Array<{ title: string; url: string; kind: string }>;
}

export interface WorkIqHit {
  id: string;
  title: string;
  kind: string;
  url: string;
  snippet: string;
  modifiedAt: string | null;
}

/** Transport-agnostic Work IQ client. */
export interface WorkIqClient {
  /** Natural-language question answered over the user's M365 corpus. */
  ask(question: string, correlationId: string): Promise<WorkIqAnswer>;
  /** Structured retrieval across named M365 surfaces. */
  search(
    query: string,
    surfaces: readonly string[],
    limit: number,
    correlationId: string,
  ): Promise<WorkIqHit[]>;
}

export interface WorkIqToolDeps {
  client: WorkIqClient;
  gate: WorkIqConsentGate;
  /** Current signed-in user's object id, or null when signed out. */
  currentOid: () => string | null;
}

const SURFACES = ["outlook", "teams", "calendar", "sharepoint", "onedrive"] as const;

export function createWorkIqTools(deps: WorkIqToolDeps): AnyGovernedTool[] {
  const tools: AnyGovernedTool[] = [
    {
      name: "workiq_ask",
      family: "workiq",
      description:
        "Ask a natural-language question about the user's Microsoft 365 working context (Outlook, Teams, Calendar, SharePoint, OneDrive) and get a synthesised answer with citations. Use for questions like 'what did we decide about X' or 'what is top of mind this week'.",
      risk: "read",
      untrustedResult: true,
      parameters: z.object({
        question: z.string().min(1).describe("The question to answer."),
      }),
      summarize: (args) => `Ask Work IQ: ${truncate(args.question, 80)}`,
      handler: async (args, context) => {
        await deps.gate.assertOpen(deps.currentOid(), context.correlationId);
        return deps.client.ask(args.question, context.correlationId);
      },
    },

    {
      name: "workiq_search",
      family: "workiq",
      description:
        "Search across Microsoft 365 surfaces for messages, meetings, files and chats matching a query. Returns ranked results with links.",
      risk: "read",
      untrustedResult: true,
      parameters: z.object({
        query: z.string().min(1).describe("The search query."),
        surfaces: z
          .array(z.enum(SURFACES))
          .default([...SURFACES])
          .describe("Which Microsoft 365 surfaces to search."),
        limit: z.number().int().min(1).max(50).default(15).describe("Maximum results."),
      }),
      summarize: (args) =>
        `Search Work IQ (${args.surfaces.join(", ")}) for ${truncate(args.query, 60)}`,
      handler: async (args, context) => {
        await deps.gate.assertOpen(deps.currentOid(), context.correlationId);
        return deps.client.search(args.query, args.surfaces, args.limit, context.correlationId);
      },
    },
  ];

  return tools;
}

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}\u2026`;

/**
 * Work IQ client backed by the Work IQ MCP server.
 *
 * The MCP server is registered on the Copilot session by name; this adapter
 * invokes it through the session's MCP dispatch. It is kept behind the
 * `WorkIqClient` interface so that the governed tools above never learn the
 * transport.
 */
export interface McpInvoker {
  callTool(server: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
}

export class McpWorkIqClient implements WorkIqClient {
  constructor(
    private readonly mcp: McpInvoker,
    private readonly serverName = "workiq",
  ) {}

  async ask(question: string, _correlationId: string): Promise<WorkIqAnswer> {
    const raw = await this.mcp.callTool(this.serverName, "ask", { question });
    const shape = z.object({
      answer: z.string(),
      citations: z
        .array(z.object({ title: z.string(), url: z.string(), kind: z.string() }))
        .default([]),
    });
    return shape.parse(raw);
  }

  async search(
    query: string,
    surfaces: readonly string[],
    limit: number,
    _correlationId: string,
  ): Promise<WorkIqHit[]> {
    const raw = await this.mcp.callTool(this.serverName, "retrieve", {
      query,
      surfaces: [...surfaces],
      limit,
    });
    const shape = z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        kind: z.string(),
        url: z.string(),
        snippet: z.string(),
        modifiedAt: z.string().nullable().default(null),
      }),
    );
    return shape.parse(raw);
  }
}
