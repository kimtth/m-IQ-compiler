import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuditLog,
  FabricDataAgentRegistry,
  ensureAppPaths,
  resolveAppPaths,
  type AppPaths,
} from "@iq/core";
import { FabricDataAgentConnectionInput, dataAgentUrlFor } from "@iq/shared";

/**
 * Connecting a Fabric Data Agent.
 *
 * The Data Agent used to be a URL field on the Fabric workspace connection,
 * which coupled two things that are separately obtainable: a published agent
 * can be handed to someone with no rights on the workspace at all, and a
 * workspace can exist with no agent published. These tests pin the split and
 * the two routes to the same endpoint.
 *
 * The endpoint shape is the part worth pinning hardest. `aiassistant/openai` is
 * not guessable and is not documented anywhere the user will look, which is
 * exactly why workspace mode exists — so that nobody has to know it.
 */

let root: string;
let paths: AppPaths;
let workspaceId: string;

const WORKSPACE = "11111111-2222-3333-4444-555555555555";
const AGENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function registry(): FabricDataAgentRegistry {
  return new FabricDataAgentRegistry({
    paths,
    audit: new AuditLog(paths),
    correlationId: () => "corr-1",
    workspaceId: () => workspaceId,
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "iq-dataagent-"));
  paths = resolveAppPaths(root);
  await ensureAppPaths(paths);
  workspaceId = "";
  // These tests own the environment fallback; a developer's own host must not
  // decide whether they pass.
  delete process.env["IQ_FABRIC_DATA_AGENT_URL"];
  delete process.env["IQ_FABRIC_DATA_AGENT_ID"];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("FabricDataAgentConnectionInput", () => {
  it("requires a Data Agent GUID in workspace mode", () => {
    expect(
      FabricDataAgentConnectionInput.safeParse({ mode: "workspace", dataAgentId: "not-a-guid" })
        .success,
    ).toBe(false);
    expect(
      FabricDataAgentConnectionInput.safeParse({ mode: "workspace", dataAgentId: AGENT }).success,
    ).toBe(true);
  });

  /**
   * The workspace is optional on purpose: blank means "the registered one",
   * which is the ordinary case. Naming one lets an agent in a *different*
   * workspace be reached without re-registering the workspace a run builds in.
   */
  it("accepts a blank workspace but not a malformed one", () => {
    expect(
      FabricDataAgentConnectionInput.safeParse({ mode: "workspace", dataAgentId: AGENT, workspaceId: "" })
        .success,
    ).toBe(true);
    expect(
      FabricDataAgentConnectionInput.safeParse({
        mode: "workspace",
        dataAgentId: AGENT,
        workspaceId: "nope",
      }).success,
    ).toBe(false);
  });

  it("requires an https URL in direct mode, and asks for no GUIDs", () => {
    expect(
      FabricDataAgentConnectionInput.safeParse({ mode: "direct", url: "http://example.invalid" })
        .success,
    ).toBe(false);
    expect(
      FabricDataAgentConnectionInput.safeParse({
        mode: "direct",
        url: "https://api.fabric.microsoft.com/v1/workspaces/x/dataagents/y/aiassistant/openai",
      }).success,
    ).toBe(true);
  });
});

describe("dataAgentUrlFor", () => {
  /**
   * Pinned against the shape the reference's own unit tests assert. If this
   * ever drifts, workspace mode dials a 404 and the user has no way to tell
   * that the id they typed was fine.
   */
  it("composes the Assistants base URL the Fabric API expects", () => {
    expect(dataAgentUrlFor(WORKSPACE, AGENT)).toBe(
      `https://api.fabric.microsoft.com/v1/workspaces/${WORKSPACE}/dataagents/${AGENT}/aiassistant/openai`,
    );
  });
});

describe("FabricDataAgentRegistry", () => {
  it("reports nothing connected on a fresh install", async () => {
    const store = registry();
    await store.load();

    expect(store.status().state).toBe("not_configured");
    expect(store.baseUrl()).toBe("");
  });

  it("composes the endpoint from the registered workspace in workspace mode", async () => {
    workspaceId = WORKSPACE;
    const store = registry();
    await store.load();
    await store.save({ mode: "workspace", dataAgentId: AGENT });

    expect(store.baseUrl()).toBe(dataAgentUrlFor(WORKSPACE, AGENT));
    const status = store.status();
    expect(status.state).toBe("ready");
    if (status.state !== "ready") return;
    expect(status.mode).toBe("workspace");
    // Host only: the path carries the workspace and item ids.
    expect(status.host).toBe("api.fabric.microsoft.com");
    expect(status.workspaceId).toBe(WORKSPACE);
  });

  it("prefers a workspace named on the connection over the registered one", async () => {
    workspaceId = WORKSPACE;
    const other = "99999999-8888-7777-6666-555555555555";
    const store = registry();
    await store.load();
    await store.save({ mode: "workspace", dataAgentId: AGENT, workspaceId: other });

    expect(store.baseUrl()).toBe(dataAgentUrlFor(other, AGENT));
  });

  /**
   * The distinction that makes the message useful: the user did their part and
   * the remedy is somewhere else entirely, so this is not `not_configured`.
   */
  it("says it needs a workspace rather than claiming nothing is connected", async () => {
    workspaceId = "";
    const store = registry();
    await store.load();
    await store.save({ mode: "workspace", dataAgentId: AGENT, displayName: "Sales agent" });

    const status = store.status();
    expect(status.state).toBe("needs_workspace");
    if (status.state !== "needs_workspace") return;
    expect(status.displayName).toBe("Sales agent");
    expect(store.baseUrl()).toBe("");
  });

  it("takes a published URL verbatim, with no workspace registered at all", async () => {
    workspaceId = "";
    const url = "https://api.fabric.microsoft.com/v1/workspaces/w/dataagents/d/aiassistant/openai";
    const store = registry();
    await store.load();
    await store.save({ mode: "direct", url });

    expect(store.baseUrl()).toBe(url);
    const status = store.status();
    expect(status.state).toBe("ready");
    if (status.state !== "ready") return;
    expect(status.mode).toBe("direct");
    // Direct mode composes no workspace, so it must not claim one.
    expect(status.workspaceId).toBe("");
  });

  it("persists across a reload, and clears on remove", async () => {
    workspaceId = WORKSPACE;
    const first = registry();
    await first.load();
    await first.save({ mode: "workspace", dataAgentId: AGENT });

    const second = registry();
    await second.load();
    expect(second.baseUrl()).toBe(dataAgentUrlFor(WORKSPACE, AGENT));

    await second.remove();
    expect(second.status().state).toBe("not_configured");

    const third = registry();
    await third.load();
    expect(third.status().state).toBe("not_configured");
  });

  /**
   * The environment variable kept its old name so a headless host that already
   * sets it needs no change from the split.
   */
  it("falls back to IQ_FABRIC_DATA_AGENT_URL, and marks it uneditable", async () => {
    process.env["IQ_FABRIC_DATA_AGENT_URL"] = "https://example.invalid/dataagents/x/aiassistant/openai";
    const store = registry();
    await store.load();

    const status = store.status();
    expect(status.state).toBe("ready");
    if (status.state !== "ready") return;
    expect(status.source).toBe("environment");
    // The host owns it; editing would write a file the host is about to override.
    expect(status.editable).toBe(false);
  });
});
