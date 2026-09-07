import { describe, expect, it, vi } from "vitest";
import { CopilotRuntime } from "../packages/core/src/runtime/copilot/copilot-runtime.js";

describe("CopilotRuntime session configuration", () => {
  it("rebuilds an existing session when an MCP server is enabled", async () => {
    const session = { disconnect: vi.fn(async () => undefined) };
    const resumed: unknown[] = [];
    const created: unknown[] = [];
    let firstResume = true;
    const client = {
      start: async () => undefined,
      stop: async () => [],
      resumeSession: async (_id: string, config: unknown) => {
        resumed.push(config);
        if (firstResume) {
          firstResume = false;
          throw new Error("no saved session");
        }
        return session;
      },
      createSession: async (config: unknown) => {
        created.push(config);
        return session;
      },
    };
    const runtime = new CopilotRuntime({
      turnRepo: {},
      toolRegistry: {
        toSdkTools: () => [],
      },
      broker: {},
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      publish: () => undefined,
      clientFactory: () => client as never,
    } as never);
    await runtime.start();

    const base = {
      sessionId: "ses_1",
      model: "gpt-5.6-terra",
      allowedFamilies: ["workiq"],
      skillDirectories: [],
      disabledSkills: [],
      workingDirectory: "C:/project",
      mcpServers: {},
    };

    await runtime.ensureSession(base);
    await runtime.ensureSession(base);

    expect(created).toHaveLength(1);
    expect(resumed).toHaveLength(1);

    const mcpServers = {
      workiq: {
        type: "local",
        command: "npx",
        args: ["-y", "@microsoft/workiq", "mcp"],
        env: {},
        tools: ["ask"],
      },
    };
    await runtime.ensureSession({ ...base, mcpServers });

    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(resumed).toHaveLength(2);
    expect(resumed[1]).toMatchObject({ mcpServers });
  });
});