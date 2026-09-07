import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canHoldConversation, placeForTool, type SessionPlace } from "@iq/shared";
import { BrowserUrlPolicy } from "../packages/core/src/browser/url-policy.js";
import { createBrowserTools } from "../packages/core/src/browser/tools.js";
import { createFabricTools } from "../packages/core/src/fabric/tools.js";
import { createKnowledgeTools } from "../packages/core/src/knowledge/tools.js";
import { createOfficeTools } from "../packages/core/src/office/tools.js";
import { createAgentTools } from "../packages/core/src/runtime/tools/agent-tools.js";
import { ToolRegistry, type AnyGovernedTool } from "../packages/core/src/runtime/tools/registry.js";
import { createWorkIqTools } from "../packages/core/src/workiq/workiq-tools.js";

/**
 * Every governed tool must have a parameter schema the SDK can be given.
 *
 * `fabric_create_item` shipped with a `z.unknown()` field. It registered
 * happily and then threw "unsupported Zod type in tool schema: ZodUnknown" on
 * the first turn that offered the Fabric family, so a schema defect presented
 * as "every Fabric run fails". Conversion now happens in `register()`, and this
 * test registers the whole product's tool set so that a new tool with an
 * unconvertible schema fails here rather than in front of a user.
 */

function registry(): ToolRegistry {
  return new ToolRegistry(
    { decide: async () => ({ decision: "allow", source: "tenant_policy", reason: "test" }) },
    { record: async () => {} } as never,
  );
}

/**
 * Every tool the app registers, built with stub dependencies.
 *
 * The factories are called exactly as `Container.registerTools` calls them, and
 * the policy flags are all on, so the set here is the widest one a tenant can
 * see. Nothing is invoked — only the declarations matter.
 */
const noop = (): never => {
  throw new Error("declarations only: no tool is invoked here");
};

function allTools(): AnyGovernedTool[] {
  return [
    ...createWorkIqTools({
      client: {} as never,
      gate: {} as never,
      currentOid: () => null,
    }),
    ...createAgentTools({
      coordinator: {} as never,
      skills: {} as never,
      memories: {} as never,
      policy: { allowSubAgents: true, allowAgentAuthoredSkills: true } as never,
      availableFamilies: () => [],
    }),
    ...createKnowledgeTools({ knowledge: {} as never }),
    ...createBrowserTools({
      policy: new BrowserUrlPolicy({ browserEnabled: true, browserDeniedHosts: [] } as never),
      // Every capability the factory gates a tool on. A bare `{}` builds only
      // `open_browser_pane` — ten of the eleven browser tools never exist, so
      // a suite claiming to be exhaustive over the product's tools silently
      // was not. That is how the browser family came to be reasoned about from
      // one member.
      pane: {
        read: noop,
        elements: noop,
        click: noop,
        fill: noop,
        select: noop,
        press: noop,
        scroll: noop,
        waitFor: noop,
        close: noop,
      } as never,
    }),
    ...createOfficeTools({ office: {} as never }),
    ...createFabricTools({
      client: {} as never,
      dataAgent: {} as never,
      connection: () => null,
      dataAgentBaseUrl: () => "",
    }),
  ];
}

describe("tool schemas", () => {
  it("every registered tool converts to an SDK schema", () => {
    const tools = allTools();
    expect(tools.length).toBeGreaterThan(0);

    const registered = registry();
    for (const tool of tools) {
      expect(() => registered.register(tool), `tool ${tool.name}`).not.toThrow();
    }

    // Offered to a session, every one of them carries an object schema.
    const sdk = registered.toSdkTools([], () => ({
      sessionId: "s",
      turnId: "t",
      correlationId: "c",
      logger: {} as never,
    }));
    expect(sdk).toHaveLength(tools.length);
    for (const tool of sdk) {
      expect(tool.parameters).toMatchObject({ type: "object" });
    }
  });

  it("a tool whose schema cannot be converted is refused at registration", () => {
    const registered = registry();
    expect(() =>
      registered.register({
        name: "bad_tool",
        family: "test",
        description: "unconvertible",
        risk: "read",
        parameters: z.object({ definition: z.unknown() }),
        summarize: () => "bad",
        handler: async () => null,
      }),
    ).toThrow(/bad_tool.*unusable parameter schema.*ZodUnknown/s);

    // And it is not half-registered: the failed tool is offered to nobody.
    expect(registered.list()).toHaveLength(0);
  });
});

/**
 * Every governed tool has an answer to "where does this file the conversation".
 *
 * The exhaustive half of the placement contract. `tests/session-clear.test.ts`
 * states each pattern one by one and says why; this one guarantees the list is
 * complete, by asking the real tool set rather than a table someone maintained
 * by hand. A tool added without a placement decision either lands nowhere —
 * which is fine, and is what most of them should do — or lands somewhere, and
 * then it has to be *this* list that grows, deliberately.
 *
 * Both failures reported against this feature were a tool nobody had thought
 * about: `fabric_ask_data_agent` inheriting Co-create → Fabric from its family,
 * and before that every governed tool inheriting nothing at all because the SDK
 * calls them all `copilot.custom-tool`.
 */
describe("every tool is placed, or deliberately not", () => {
  /** The complete set of tools that move a conversation, and where to. */
  const PLACING: Readonly<Record<string, SessionPlace>> = {
    office_create_document: { subMode: "office", surface: null },
    office_add_content: { subMode: "office", surface: null },
    office_add_many: { subMode: "office", surface: null },
    office_set_content: { subMode: "office", surface: null },
    office_remove_element: { subMode: "office", surface: null },
    office_merge_template: { subMode: "office", surface: null },
    office_query_structure: { subMode: "office", surface: null },
    office_validate_document: { subMode: "office", surface: null },
    office_render_preview: { subMode: "office", surface: null },
    fabric_list_items: { subMode: "fabric", surface: null },
    fabric_create_item: { subMode: "fabric", surface: null },
    // The Browser is a surface with no sub-mode behind it, which is why a
    // place's sub-mode half is nullable. Ten tools drive it and all ten mean
    // the same destination.
    open_browser_pane: { subMode: null, surface: "browser" },
    close_browser_pane: { subMode: null, surface: "browser" },
    read_browser_page: { subMode: null, surface: "browser" },
    browser_elements: { subMode: null, surface: "browser" },
    browser_click: { subMode: null, surface: "browser" },
    browser_fill: { subMode: null, surface: "browser" },
    browser_select: { subMode: null, surface: "browser" },
    browser_press_key: { subMode: null, surface: "browser" },
    browser_scroll: { subMode: null, surface: "browser" },
    browser_wait_for: { subMode: null, surface: "browser" },
  };

  it("places exactly the tools on the list, and no others", () => {
    const placed = new Map<string, SessionPlace>();
    for (const tool of allTools()) {
      const place = placeForTool(tool.name, tool.family);
      if (place !== null) placed.set(tool.name, place);
    }
    expect(Object.fromEntries([...placed].sort())).toEqual(
      Object.fromEntries(Object.entries(PLACING).sort()),
    );
  });

  it("never places one somewhere its own history would be invisible", () => {
    for (const tool of allTools()) {
      const place = placeForTool(tool.name, tool.family);
      if (place === null) continue;
      expect(canHoldConversation(place), tool.name).toBe(true);
    }
  });

  it("covers every family the product registers, one way or the other", () => {
    // Not an assertion about behaviour so much as about attention: this is the
    // list a reviewer has to look at when a family is added, and it fails when
    // one appears that nobody has decided about.
    const families = [...new Set(allTools().map((tool) => tool.family))].sort();
    expect(families).toEqual([
      "agent.memory",
      "agent.orchestration",
      "agent.skills",
      "browser",
      "fabric",
      "knowledge",
      "office",
      "workiq",
    ]);
  });
});
