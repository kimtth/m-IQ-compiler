import { z } from "zod";
import type { AnyGovernedTool } from "../runtime/tools/registry.js";
import type { KnowledgeGraphService } from "./knowledge-graph.js";

/**
 * Knowledge tools.
 *
 * Reading a note is a read, so these do not prompt under the default policy —
 * but their results are marked untrusted. Project files can be written by the
 * agent itself, by a sub-agent or by whatever the user dropped there, so their
 * text must never be treated as instructions when it re-enters the context.
 */
export function createKnowledgeTools(deps: { knowledge: KnowledgeGraphService }): AnyGovernedTool[] {
  return [searchTool(deps), nodeTool(deps), reindexTool(deps)];
}

function searchTool(deps: { knowledge: KnowledgeGraphService }): AnyGovernedTool {
  const parameters = z.object({
    query: z.string().min(2).describe("Words to look for in titles, tags, paths and body text."),
    limit: z.number().int().min(1).max(50).default(10),
  });

  return {
    name: "knowledge_search",
    family: "knowledge",
    description:
      "Search the local knowledge graph of project documents and installed skills. Use before asking the user for context they may already have written down.",
    risk: "read",
    parameters,
    summarize: (args) => `Search local notes for "${args.query}"`,
    handler: async (args, context) => {
      const hits = await deps.knowledge.search(args.query, args.limit, context.correlationId);
      return { ok: true, hits };
    },
    untrustedResult: true,
  };
}

function nodeTool(deps: { knowledge: KnowledgeGraphService }): AnyGovernedTool {
  const parameters = z.object({
    id: z
      .string()
      .min(1)
      .describe("Node id from knowledge_search, e.g. document:notes/plan.md or skill:mail-triage."),
  });

  return {
    name: "knowledge_node",
    family: "knowledge",
    description:
      "Read one node of the knowledge graph: its text, its tags, what it links to, and what links back to it.",
    risk: "read",
    parameters,
    summarize: (args) => `Read knowledge node ${args.id}`,
    resources: (args) => [args.id],
    handler: async (args, context) => {
      const detail = await deps.knowledge.node(args.id, context.correlationId);
      if (!detail) return { ok: false, error: `unknown node ${args.id}` };
      return {
        ok: true,
        node: detail.node,
        content: detail.content,
        links: detail.outgoing.map((edge) => ({ id: edge.node.id, title: edge.node.title, kind: edge.kind })),
        backlinks: detail.incoming.map((edge) => ({ id: edge.node.id, title: edge.node.title, kind: edge.kind })),
      };
    },
    untrustedResult: true,
  };
}

function reindexTool(deps: { knowledge: KnowledgeGraphService }): AnyGovernedTool {
  return {
    name: "knowledge_reindex",
    family: "knowledge",
    description:
      "Rebuild the knowledge graph from the project directory. Call after creating or editing files that later steps need to find.",
    risk: "read",
    parameters: z.object({}),
    summarize: () => "Rebuild the local knowledge graph",
    handler: async (_args, context) => ({
      ok: true,
      summary: await deps.knowledge.reindex(context.correlationId),
    }),
  };
}
