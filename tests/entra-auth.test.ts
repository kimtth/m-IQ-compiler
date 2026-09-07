import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuditLog,
  AzureCliMissingError,
  DEFAULT_TENANT_POLICY,
  EntraAuth,
  classifyCliFailure,
  createLogger,
  ensureAppPaths,
  resetAzCommandCache,
  resolveAppPaths,
  resolveAzCommand,
  spawnAzureCli,
  type AppPaths,
  type CliResult,
} from "@iq/core";

/**
 * IQ Compiler has no Entra app registration, so identity is borrowed from the
 * Azure CLI. These tests pin the behaviours that make that safe rather than the
 * CLI plumbing: a missing CLI degrades instead of crashing, an interactive
 * sign-in always clears the previous session first (otherwise a tenant switch
 * silently reuses the old identity), a denied scope never reaches token
 * acquisition, and failures stay distinguishable enough to act on.
 */

let root: string;
let paths: AppPaths;
let calls: string[][];
let responses: Map<string, CliResult | Error>;

const ok = (stdout: string): CliResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): CliResult => ({ code: 1, stdout: "", stderr });

const ACCOUNT = JSON.stringify({
  id: "sub-1",
  name: "Contoso",
  tenantId: "tid-1",
  user: { name: "ada@contoso.com", type: "user" },
});

function build(): EntraAuth {
  return new EntraAuth({
    logger: createLogger("error"),
    audit: new AuditLog(paths),
    tenantPolicy: DEFAULT_TENANT_POLICY,
    runCli: async (args) => {
      calls.push([...args]);
      const reply = responses.get(args[0] ?? "") ?? fail("unexpected command");
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "iq-entra-"));
  paths = resolveAppPaths(root);
  await ensureAppPaths(paths);
  calls = [];
  responses = new Map<string, CliResult | Error>([
    ["account", ok(ACCOUNT)],
    ["login", ok("[]")],
    ["logout", ok("")],
  ]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("EntraAuth", () => {
  it("adopts an existing CLI session on boot without prompting", async () => {
    const auth = build();
    const status = await auth.initialize();

    expect(status.state).toBe("signed_in");
    expect(auth.currentAccount()?.username).toBe("ada@contoso.com");
    expect(calls.some((args) => args[0] === "login")).toBe(false);
  });

  it("reports signed_out rather than failing when no CLI session exists", async () => {
    responses.set("account", fail("Please run 'az login' to setup account."));
    const auth = build();

    expect((await auth.initialize()).state).toBe("signed_out");
    expect(auth.currentAccount()).toBeNull();
  });

  it("degrades to cli_missing when the Azure CLI is not installed", async () => {
    responses.set("account", new AzureCliMissingError());
    const auth = build();
    const status = await auth.initialize();

    expect(status.state).toBe("cli_missing");
    expect(auth.isConfigured()).toBe(false);
  });

  it("logs out before an interactive sign-in so a tenant switch takes effect", async () => {
    const auth = build();
    await auth.signIn("corr-1", "other-tenant");

    const order = calls.map((args) => args[0]);
    expect(order.indexOf("logout")).toBeLessThan(order.indexOf("login"));
    const login = calls.find((args) => args[0] === "login") ?? [];
    expect(login).toContain("--allow-no-subscriptions");
    expect(login.join(" ")).toContain("--tenant other-tenant");
  });

  it("treats a blank tenant as the home tenant", async () => {
    const auth = build();
    await auth.signIn("corr-1", "   ");

    const login = calls.find((args) => args[0] === "login") ?? [];
    expect(login).not.toContain("--tenant");
    expect(auth.preferredTenantId()).toBeNull();
  });

  it("drops the session when the preferred tenant changes", async () => {
    const auth = build();
    await auth.initialize();
    expect(auth.getStatus().state).toBe("signed_in");

    auth.setPreferredTenantId("tid-2");

    expect(auth.getStatus().state).toBe("signed_out");
    expect(auth.currentAccount()).toBeNull();
  });

  it("refuses a capability whose scope the tenant policy denies", async () => {
    const audit = new AuditLog(paths);
    const auth = new EntraAuth({
      logger: createLogger("error"),
      audit,
      tenantPolicy: { ...DEFAULT_TENANT_POLICY, deniedScopes: ["Mail.Send"] },
      runCli: async (args) => {
        calls.push([...args]);
        return ok(ACCOUNT);
      },
    });
    await auth.initialize();
    calls.length = 0;

    await expect(auth.acquireForCapability("m365.mail.send", "corr-1")).rejects.toThrow(
      /denied by tenant policy/,
    );
    // The important part: no token was ever requested for a denied scope.
    expect(calls).toHaveLength(0);
  });

  it("requests a resource token and records consent once per capability", async () => {
    const auth = build();
    await auth.initialize();
    responses.set("account", ok(JSON.stringify({ accessToken: "token-1" })));
    calls.length = 0;

    expect(await auth.acquireForCapability("m365.mail.read", "corr-1")).toBe("token-1");
    expect(await auth.acquireForCapability("m365.mail.read", "corr-2")).toBe("token-1");

    const tokenCalls = calls.filter((args) => args[1] === "get-access-token");
    expect(tokenCalls).toHaveLength(2);
    expect(tokenCalls[0]?.join(" ")).toContain("--resource https://graph.microsoft.com");

    const audit = new AuditLog(paths);
    const consents = (await audit.query({ limit: 100 })).filter(
      (record) => record.action === "auth.consent" && record.outcome === "allowed",
    );
    expect(consents).toHaveLength(1);
  });

  it("uses the Speech resource rather than Graph for voice", async () => {
    const auth = build();
    await auth.initialize();
    responses.set("account", ok(JSON.stringify({ accessToken: "token-2" })));
    calls.length = 0;

    await auth.acquireForCapability("azure.speech", "corr-1");

    expect(calls[0]?.join(" ")).toContain("https://cognitiveservices.azure.com");
  });

  it("refuses to acquire a token when nobody is signed in", async () => {
    responses.set("account", fail("Please run 'az login' to setup account."));
    const auth = build();
    await auth.initialize();

    await expect(auth.acquireForCapability("m365.files.read", "corr-1")).rejects.toThrow(
      /Connect your Microsoft account/,
    );
  });

  it("forgets the account when the CLI reports the session has lapsed", async () => {
    const auth = build();
    await auth.initialize();
    responses.set("account", fail("Please run 'az login' to setup account."));

    await expect(auth.acquireForCapability("m365.files.read", "corr-1")).rejects.toThrow();
    expect(auth.getStatus().state).toBe("signed_out");
  });

  it("rejects an account from a tenant the policy does not permit", async () => {
    const auth = new EntraAuth({
      logger: createLogger("error"),
      audit: new AuditLog(paths),
      tenantPolicy: { ...DEFAULT_TENANT_POLICY, allowedTenantIds: ["tid-allowed"] },
      runCli: async () => ok(ACCOUNT),
    });

    expect((await auth.initialize()).state).toBe("signed_out");
    expect(auth.currentAccount()).toBeNull();
  });
});

describe("EntraAuth multi-tenant", () => {
  const account = (tenantId: string): string =>
    JSON.stringify({ id: "sub-1", name: "Contoso", tenantId, user: { name: "ada@contoso.com" } });

  function deps() {
    return {
      logger: createLogger("error"),
      audit: new AuditLog(paths),
      tenantPolicy: DEFAULT_TENANT_POLICY,
    };
  }

  it("lists tenants for the picker and marks the signed-in one current", async () => {
    const auth = new EntraAuth({
      ...deps(),
      runCli: async (args) => {
        if (args[1] === "show") return ok(account("tid-1"));
        if (args[1] === "tenant") {
          return ok(
            JSON.stringify([
              { tenantId: "tid-1", displayName: "Contoso", defaultDomainName: "contoso.onmicrosoft.com" },
              { tenantId: "tid-2", displayName: "Fabrikam", defaultDomainName: "fabrikam.com" },
            ]),
          );
        }
        return fail("unexpected");
      },
    });
    await auth.initialize();

    const tenants = await auth.listTenants();
    expect(tenants.map((tenant) => tenant.tenantId)).toEqual(["tid-1", "tid-2"]);
    expect(tenants.find((tenant) => tenant.tenantId === "tid-1")?.current).toBe(true);
    expect(tenants.find((tenant) => tenant.tenantId === "tid-2")?.current).toBe(false);
  });

  it("falls back to the subscription list when the tenant subcommand is unavailable", async () => {
    const auth = new EntraAuth({
      ...deps(),
      runCli: async (args) => {
        if (args[1] === "show") return ok(account("tid-1"));
        if (args[1] === "tenant") return fail("ERROR: 'tenant' is not a recognized command");
        if (args[1] === "list") {
          return ok(JSON.stringify([{ tenantId: "tid-1", name: "Sub A" }, { tenantId: "tid-9", name: "Sub B" }]));
        }
        return fail("unexpected");
      },
    });
    await auth.initialize();

    const tenants = await auth.listTenants();
    expect(tenants.map((tenant) => tenant.tenantId).sort()).toEqual(["tid-1", "tid-9"]);
  });

  it("returns an empty picker rather than throwing when listing fails", async () => {
    const auth = new EntraAuth({
      ...deps(),
      runCli: async (args) => (args[1] === "show" ? ok(account("tid-1")) : fail("boom")),
    });
    await auth.initialize();
    await expect(auth.listTenants()).resolves.toEqual([]);
  });

  it("rejects a malformed tenant identifier before touching the CLI", async () => {
    const seen: string[][] = [];
    const auth = new EntraAuth({
      ...deps(),
      runCli: async (args) => {
        seen.push([...args]);
        return ok(account("tid-1"));
      },
    });

    await expect(auth.switchTenant("not a tenant!", "corr-x")).rejects.toThrow(/valid tenant/i);
    expect(seen).toHaveLength(0);
  });

  it("switches tenant: logs out first, re-signs in, and announces the change", async () => {
    let reported = "tid-1";
    const seen: string[][] = [];
    const auth = new EntraAuth({
      ...deps(),
      runCli: async (args) => {
        seen.push([...args]);
        if (args[0] === "logout") return ok("");
        if (args[0] === "login") return ok("[]");
        if (args[1] === "show") return ok(account(reported));
        return fail("unexpected");
      },
    });
    await auth.initialize();

    let changedTo: string | null | undefined;
    auth.onTenantChanged((tenantId) => {
      changedTo = tenantId;
    });

    // The interactive flow lands in the requested tenant.
    reported = "contoso.onmicrosoft.com";
    seen.length = 0;
    const status = await auth.switchTenant("contoso.onmicrosoft.com", "corr-switch");

    expect(status.state).toBe("signed_in");
    const order = seen.map((args) => args[0]);
    expect(order.indexOf("logout")).toBeLessThan(order.indexOf("login"));
    const login = seen.find((args) => args[0] === "login") ?? [];
    expect(login.join(" ")).toContain("--tenant contoso.onmicrosoft.com");
    expect(changedTo).toBe("contoso.onmicrosoft.com");

    const audit = new AuditLog(paths);
    const switches = (await audit.query({ limit: 100 })).filter(
      (record) => record.action === "auth.tenant.switch" && record.outcome === "succeeded",
    );
    expect(switches).toHaveLength(1);
  });

  it("surfaces wrong_tenant on the error when the account is not a member", async () => {
    const auth = new EntraAuth({
      ...deps(),
      runCli: async (args) => {
        if (args[0] === "logout") return ok("");
        if (args[0] === "login") {
          return fail("ERROR: AADSTS50020: User account does not exist in tenant 'tid-x'.");
        }
        return ok(account("tid-1"));
      },
    });

    await expect(auth.switchTenant("00000000-0000-0000-0000-000000000000", "corr")).rejects.toMatchObject({
      failure: { kind: "wrong_tenant" },
    });
  });
});

describe("classifyCliFailure", () => {
  it("names a tenant-membership failure and points at the tenant picker", () => {
    const failure = classifyCliFailure(
      "ERROR: AADSTS50020: User account 'ada@contoso.com' from identity provider does not exist in tenant",
      1,
    );
    expect(failure.kind).toBe("wrong_tenant");
    expect(failure.message).toMatch(/tenant picker/i);
    expect(failure.message).toMatch(/not a permissions problem/i);
  });

  it("recognises a lapsed session as something a sign-in fixes", () => {
    expect(classifyCliFailure("Please run 'az login' to setup account.", 1).kind).toBe(
      "not_signed_in",
    );
  });

  it("classifies an expired token as expired, not a generic failure", () => {
    expect(classifyCliFailure("AADSTS700082: The refresh token has expired.", 1).kind).toBe(
      "expired",
    );
  });

  it("treats interaction_required and conditional access as consent_required", () => {
    expect(classifyCliFailure("AADSTS50076 interaction_required", 1).kind).toBe("consent_required");
    expect(classifyCliFailure("ERROR: conditional access policy blocked", 1).kind).toBe(
      "consent_required",
    );
  });

  it("uses the enum spelling for a cancelled sign-in", () => {
    expect(classifyCliFailure("The user canceled the authentication", 1).kind).toBe("cancelled");
  });

  it("falls back to the CLI's own text rather than inventing a reason", () => {
    const failure = classifyCliFailure("ERROR: something unusual happened", 3);
    expect(failure.kind).toBe("failed");
    expect(failure.message).toContain("something unusual");
  });
});

/**
 * Locating the CLI is its own hazard on Windows.
 *
 * `az` is only ever a `.cmd` shim there, and since the fix for CVE-2024-27980
 * Node refuses to spawn a batch file without a shell — the user sees a bare
 * `spawn EINVAL` and no way forward. These tests pin the unwrapping that avoids
 * both that failure and the shell it would otherwise take to work around it.
 */
describe("resolveAzCommand", () => {
  const originalPath = process.env["PATH"];

  afterEach(() => {
    process.env["PATH"] = originalPath;
    resetAzCommandCache();
  });

  it("never resolves to a batch shim, which node cannot spawn", () => {
    resetAzCommandCache();
    const found = resolveAzCommand();
    if (!found) return; // No Azure CLI on this machine; nothing to assert.
    expect(found.command.toLowerCase()).not.toMatch(/\.(cmd|bat)$/);
  });

  it("prefers the interpreter the shim itself invokes", () => {
    if (process.platform !== "win32") return;

    const wbin = mkdtempSync(join(tmpdir(), "az-wbin-"));
    const install = join(wbin, "..");
    writeFileSync(join(wbin, "az.cmd"), "@echo off\r\n");
    writeFileSync(join(install, "python.exe"), "");

    process.env["PATH"] = wbin;
    resetAzCommandCache();

    const found = resolveAzCommand();
    expect(found?.via).toBe("python");
    expect(found?.command).toBe(join(install, "python.exe"));
    // The shim runs `python -IBm azure.cli %*`, so the module must be named the
    // same way or every argument would be read as a python option.
    expect(found?.prefixArgs).toEqual(["-IBm", "azure.cli"]);

    rmSync(wbin, { recursive: true, force: true });
    rmSync(join(install, "python.exe"), { force: true });
  });

  it("reports a missing CLI rather than a spawn error", async () => {
    process.env["PATH"] = mkdtempSync(join(tmpdir(), "az-empty-"));
    resetAzCommandCache();

    if (process.platform !== "win32") return;
    await expect(spawnAzureCli(["account", "show"])).rejects.toBeInstanceOf(AzureCliMissingError);
  });
});
