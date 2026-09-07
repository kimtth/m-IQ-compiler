import { afterEach, describe, expect, it } from "vitest";
import {
  blockedPackageHost,
  describeExit,
  probeMcpServer,
  startupComplaint,
  type McpProbeTarget,
} from "@iq/core";

/**
 * What an HTTP MCP server's refusal is allowed to look like to a person.
 *
 * Every hosted MCP server needs a token, so "server answered 401" is both the
 * commonest outcome of pressing Inspect and the least informative sentence the
 * app could produce — it repeats what the reader already assumed and discards
 * the header that says what to do about it. This pins the reading, not the
 * plumbing: a refusal has to name the resource, the scope and the client the
 * resource will accept a token from.
 *
 * The fixtures are synthetic. They preserve the shape of an RFC 9728 challenge
 * without carrying metadata from a production service.
 */

const target: McpProbeTarget = {
  id: "synthetic-oauth-server",
  transport: "http",
  command: "",
  args: [],
  env: {},
  url: "https://mcp.example.com/api",
  headers: {},
};

const CHALLENGE =
  'Bearer realm="", authorization_uri="https://login.example.com/oauth2/authorize", ' +
  'client_id="11111111-1111-1111-1111-111111111111", ' +
  'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"';

const METADATA = {
  resource: "https://mcp.example.com/api",
  authorization_servers: ["https://login.example.com/oauth2"],
  scopes_supported: ["11111111-1111-1111-1111-111111111111/Example.Read"],
  bearer_methods_supported: ["header"],
  resource_name: "Example MCP",
};

const realFetch = globalThis.fetch;

/** Answer the MCP POST with `status`, and any GET with the metadata document. */
function stubFetch(
  status: number,
  headers: Record<string, string>,
  metadata: unknown = METADATA,
  metadataUrl = "https://mcp.example.com/.well-known/oauth-protected-resource",
): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ error: { message: "Access token is empty." } }), {
        status,
        headers,
      });
    }
    if (url === metadataUrl) return new Response(JSON.stringify(metadata), { status: 200 });
    return new Response("", { status: 404 });
  }) as typeof globalThis.fetch;
  return seen;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("inspecting an HTTP MCP server that refuses", () => {
  it("reads the challenge and says what the server actually wants", async () => {
    stubFetch(401, { "www-authenticate": CHALLENGE });

    const result = await probeMcpServer(target);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("401");
    // The three facts a reader needs and could not previously get: what it is,
    // what it wants, and who it will take it from.
    expect(result.error).toContain("Example MCP");
    expect(result.error).toContain("11111111-1111-1111-1111-111111111111/Example.Read");
    expect(result.error).toContain("https://login.example.com/oauth2");
    expect(result.error).toContain("client 11111111-1111-1111-1111-111111111111");
    expect(result.error).toContain("Authorization header");
  });

  it("still explains a 401 that carries no metadata document", async () => {
    // Degrades to whatever the challenge itself carried. A server that answers
    // the older way must not produce a worse message than it did before.
    stubFetch(401, {
      "www-authenticate": 'Bearer authorization_uri="https://login.example/authorize"',
    });

    const result = await probeMcpServer(target);

    expect(result.error).toContain("OAuth access token");
    expect(result.error).toContain("https://login.example/authorize");
  });

  it("refuses to follow a metadata URL to another origin", async () => {
    /*
     * The URL comes out of a remote server's response header, so following it
     * anywhere it names would make pressing Inspect a request that server gets
     * to aim — at a cloud metadata endpoint, or at something reachable only
     * from inside the network this app runs in. The message loses a sentence;
     * nothing else is at stake.
     */
    const seen = stubFetch(
      401,
      {
        "www-authenticate":
          'Bearer client_id="c", resource_metadata="https://attacker.example/.well-known/x"',
      },
      { resource_name: "Somewhere else", scopes_supported: ["secret/scope"] },
      "https://attacker.example/.well-known/x",
    );

    const result = await probeMcpServer(target);

    expect(seen).toEqual(["https://mcp.example.com/api"]);
    expect(result.error).not.toContain("Somewhere else");
    expect(result.error).not.toContain("secret/scope");
  });

  it("reports the body for a failure that is not about authentication", async () => {
    stubFetch(503, {});

    const result = await probeMcpServer(target);

    expect(result.error).toContain("503");
    expect(result.error).toContain("Access token is empty.");
    expect(result.error).not.toContain("OAuth");
  });
});

/**
 * What a dead stdio server's exit is allowed to look like to a person.
 *
 * The synthetic stderr keeps launcher noise ahead of the useful failure so
 * the test proves that the diagnostic reads from the end.
 */
describe("a stdio server that dies", () => {
  const NPX_PREAMBLE = [
    'npm warn Unknown env config "sample-setting-one". This will stop working in the next major version of npm.',
    'npm warn Unknown env config "sample-setting-two". This will stop working in the next major version of npm.',
    'npm warn Unknown env config "sample-setting-three". This will stop working in the next major version of npm.',
  ].join("\n");

  const CRASH = [
    "Press any key to close...",
    "Unhandled exception. System.InvalidOperationException: Cannot read keys when either application does not have a console or when console input has been redirected. Try Console.Read.",
    "   at System.ConsolePal.ReadKey(Boolean intercept)",
    "   at Program.<Main>$(String[] args)",
  ].join("\n");

  it("reads past the launcher's warnings to the fault", () => {
    const message = describeExit(3_762_504_530, `${NPX_PREAMBLE}\n${CRASH}`);

    expect(message).toContain("console input has been redirected");
    expect(message).not.toContain("Unknown env config");
  });

  it("names the exit code when the number itself means something", () => {
    // 0xE0434352 is the CLR's unhandled-exception code. Node hands it back as
    // either sign depending on how the process was reaped.
    for (const code of [3_762_504_530, -532_462_766]) {
      expect(describeExit(code, CRASH)).toContain("unhandled .NET exception");
    }
  });

  it("still reports an ordinary exit code plainly", () => {
    expect(describeExit(1, "boom")).toBe("server exited (1): boom");
  });

  it("says only that the server exited when it said nothing", () => {
    expect(describeExit(2, NPX_PREAMBLE)).toBe("server exited (2)");
  });
});

/**
 * A server that starts, answers, and is still not telling the whole story.
 *
 * A synthetic server reports a startup problem on stderr but still answers.
 * The warning must remain visible even though the probe succeeds.
 */
describe("a server that started with a problem", () => {
  const STARTUP_FAILURE = [
    "[Example MCP] Failed to fetch remote tools: authentication error",
    " Error Code: EXAMPLE_AUTH_CONFIGURATION",
    " Error Message: IncorrectConfiguration",
    " See troubleshooting: https://support.example.com/auth",
    "[Example MCP] Remote tools will not be available in this session.",
  ].join("\n");

  it("keeps the complaint a successful server made on its way up", () => {
    expect(startupComplaint(STARTUP_FAILURE)).toContain("Failed to fetch remote tools");
    expect(startupComplaint(STARTUP_FAILURE)).toContain("will not be available");
  });

  it("stays quiet for an ordinary startup log", () => {
    const chatty = ["Listening on stdio", "Registered 14 tools", "Ready."].join("\n");

    expect(startupComplaint(chatty)).toBe("");
  });

  it("does not mistake the launcher's warnings for the server's", () => {
    // An alarm that is usually wrong gets ignored when it is right, and npx
    // prints `npm warn …` on a perfectly healthy run.
    expect(startupComplaint('npm warn Unknown env config "npm-globalconfig".')).toBe("");
  });
});

/**
 * A server that was never downloaded, on a machine that is not allowed to.
 *
 * `uvx` and `npx -y` fetch the server on first use, so on a managed machine the
 * commonest reason an MCP server "does not work" is that an endpoint-security
 * policy took the connection away before the package arrived. Reported as the
 * runner phrases it, that reads as a broken package or a flaky network and the
 * reader reinstalls uv for an afternoon.
 *
 * The synthetic stderr models a package-host connection blocked by endpoint
 * security.
 */
describe("a package host the machine may not reach", () => {
  const BLOCKED = [
    "error: Request failed after 3 retries in 8.3s",
    "  Caused by: Failed to fetch: `https://files.pythonhosted.org/packages/example/sample.whl.metadata`",
    "  Caused by: error sending request for url (https://files.pythonhosted.org/packages/example/sample.whl.metadata)",
    "  Caused by: client error (Connect)",
    "  Caused by: received fatal alert: HandshakeFailure",
  ].join("\n");

  it("names the policy rather than repeating the handshake error", () => {
    const reading = describeExit(2, BLOCKED);

    expect(reading).toContain("files.pythonhosted.org");
    expect(reading).toContain("never downloaded");
    // The remedy is somewhere else, and saying so is the point: otherwise the
    // reader keeps trying things inside the app.
    expect(reading).toMatch(/nothing in this app can route around it/i);
    expect(reading).toContain("1126");
  });

  it("says nothing when the registry answered for itself", () => {
    // A 404 from the registry is a real answer with a different remedy —
    // usually a misspelt package — so it must not be dressed up as a block.
    expect(
      blockedPackageHost("error: Package `markitdown-mcpp` was not found at https://pypi.org"),
    ).toBe("");
  });

  it("says nothing when the failure names no package host", () => {
    expect(blockedPackageHost("Error: connect ECONNREFUSED 127.0.0.1:5173")).toBe("");
  });
});
