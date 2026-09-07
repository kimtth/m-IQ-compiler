import { z } from "zod";
import { FABRIC_ARTIFACT_LABELS, type FabricConnection } from "@iq/shared";
import type { AnyGovernedTool } from "../runtime/tools/registry.js";
import type { FabricClient } from "./fabric-client.js";
import type { FabricDataAgentClient } from "./data-agent.js";

/**
 * Governed Fabric tools.
 *
 * Fabric writes are declared tools, not shell commands. Reaching the Fabric
 * REST API through a shell and `az account get-access-token` works, but it
 * makes every write an unclassified shell call: the approval prompt says "run
 * PowerShell", the audit record says "run PowerShell", and a semantic
 * guardrail has to read the command text back to work out whether it was
 * destructive.
 *
 * So creating a lakehouse is a `write` against a named workspace, it declares
 * the `azure.fabric` capability, its summary names the item, and it is refused
 * outright when no workspace is registered. The existing approval broker,
 * tenant policy and audit log then apply to Fabric exactly as they apply to
 * Office or Graph — no second guardrail, because the classification is declared
 * rather than inferred.
 *
 * Deliberately three tools and no more. Everything past "what is here", "make
 * this" and "ask the data" is workload-specific knowledge that belongs in the
 * upstream `microsoft/skills-for-fabric` bundle, which the agent reads. Adding
 * a `fabric_create_lakehouse` here would be this app owning a Fabric API shape
 * again, one function at a time.
 */

export interface FabricToolDeps {
  client: FabricClient;
  dataAgent: FabricDataAgentClient;
  /** The registered workspace, or null. Read per call so an edit takes effect. */
  connection: () => FabricConnection | null;
  /**
   * The Data Agent's Assistants base URL, or "" when none is connected.
   *
   * Separate from `connection` because the two are separately registered: a
   * question can be asked of a published agent with no workspace registered at
   * all, and `fabric_ask_data_agent` must not refuse for the wrong reason.
   */
  dataAgentBaseUrl: () => string;
}

const ARTIFACT_HINT = Object.values(FABRIC_ARTIFACT_LABELS).join(", ");

export function createFabricTools(deps: FabricToolDeps): AnyGovernedTool[] {
  /** One place to refuse, so no tool can run against a workspace that is not set. */
  const require = (): FabricConnection => {
    const connection = deps.connection();
    if (connection === null) {
      throw new Error(
        "No Microsoft Fabric workspace is registered. Add one in Connections & access before creating or reading Fabric items.",
      );
    }
    return connection;
  };

  return [
    {
      name: "fabric_list_items",
      family: "fabric",
      description:
        "List the items in the configured Microsoft Fabric workspace — lakehouses, warehouses, notebooks, semantic models, data agents and everything else. Use this before creating anything, to see what already exists and to avoid duplicating it.",
      risk: "read",
      capability: "azure.fabric",
      // Item names and descriptions are written by other people in a shared
      // workspace, so they are content, not instruction.
      untrustedResult: true,
      parameters: z.object({
        type: z
          .string()
          .max(80)
          .default("")
          .describe("Optional Fabric item type to filter by, e.g. Lakehouse or SemanticModel."),
      }),
      summarize: (args) =>
        args.type === ""
          ? "List every item in the Fabric workspace"
          : `List ${args.type} items in the Fabric workspace`,
      resources: () => {
        const connection = deps.connection();
        return connection ? [connection.workspaceId] : [];
      },
      handler: async (args, context) => {
        const connection = require();
        const items = await deps.client.listItems(connection.workspaceId, context.correlationId);
        return args.type === ""
          ? items
          : items.filter((item) => item.type.toLowerCase() === args.type.toLowerCase());
      },
    },

    {
      name: "fabric_create_item",
      family: "fabric",
      description:
        `Create an item in the configured Microsoft Fabric workspace. Waits for the long-running ` +
        `operation to finish, so the returned id refers to an item that exists. The item type and ` +
        `definition shape are documented in the installed skills-for-fabric bundle — read the ` +
        `relevant SKILL.md before calling this. Typical targets: ${ARTIFACT_HINT}.`,
      risk: "write",
      capability: "azure.fabric",
      parameters: z.object({
        type: z
          .string()
          .min(1)
          .max(80)
          .describe("Fabric item type, e.g. Lakehouse, Notebook, SemanticModel, DataPipeline."),
        displayName: z.string().min(1).max(200).describe("Name the item appears under."),
        description: z.string().max(1_000).default("").describe("What this item is for."),
        /**
         * The Fabric item definition, stated in full rather than left open.
         *
         * Every item type shares one envelope — a list of parts, each a path,
         * a payload and the payload's encoding — and only the *contents* of
         * the parts are per-type. Declaring the envelope gives the model
         * something it can satisfy and keeps the tool schema convertible; an
         * open value would be neither.
         */
        definition: z
          .object({
            format: z
              .string()
              .max(80)
              .default("")
              .describe("Definition format for item types that declare one, e.g. `ipynb`."),
            parts: z
              .array(
                z.object({
                  path: z
                    .string()
                    .min(1)
                    .max(400)
                    .describe("Path of the part within the item, e.g. `notebook-content.py`."),
                  payload: z.string().describe("The part's content, encoded per `payloadType`."),
                  payloadType: z
                    .enum(["InlineBase64"])
                    .default("InlineBase64")
                    .describe("How `payload` is encoded. Fabric accepts InlineBase64."),
                }),
              )
              .min(1)
              .describe("The parts that make up the definition."),
          })
          .optional()
          .describe(
            "Optional item definition. The per-type shape of each part is documented in the installed skills-for-fabric bundle; omit this for item types that are created empty.",
          ),
      }),
      // Named precisely because this is what the approval prompt shows: "create
      // an item" would let a user approve a warehouse thinking it was a folder.
      summarize: (args) => `Create Fabric ${args.type} "${args.displayName}"`,
      resources: (args) => {
        const connection = deps.connection();
        return connection ? [connection.workspaceId, args.displayName] : [args.displayName];
      },
      handler: async (args, context) => {
        const connection = require();
        return deps.client.createItem(
          {
            workspaceId: connection.workspaceId,
            type: args.type,
            displayName: args.displayName,
            description: args.description,
            ...(args.definition === undefined ? {} : { definition: args.definition }),
          },
          context.correlationId,
        );
      },
    },

    {
      name: "fabric_ask_data_agent",
      family: "fabric",
      description:
        "Ask a natural-language question of the published Fabric Data Agent, which answers from the data in the workspace. Use to verify that data landed correctly after building artifacts, or to answer a question about the data itself. Returns the answer and the queries the agent ran.",
      risk: "read",
      capability: "azure.fabric",
      // The answer is generated from warehouse rows by a service; it is data.
      untrustedResult: true,
      parameters: z.object({
        question: z.string().min(1).max(2_000).describe("The question to ask of the data."),
      }),
      summarize: (args) => `Ask the Fabric Data Agent: ${truncate(args.question, 80)}`,
      handler: async (args, context) => {
        const baseUrl = deps.dataAgentBaseUrl();
        if (baseUrl === "") {
          throw new Error(
            "No Fabric Data Agent is connected. Add one in Connections & access \u2014 by its id in a Fabric workspace, or by its published URL.",
          );
        }
        return deps.dataAgent.ask({
          baseUrl,
          question: args.question,
          // The thread is named after the session, so a follow-up question in
          // the same conversation keeps the agent's context.
          sessionId: context.sessionId,
          correlationId: context.correlationId,
        });
      },
    },
  ];
}

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}\u2026`;
