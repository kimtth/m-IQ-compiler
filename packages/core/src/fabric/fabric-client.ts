import {
  FABRIC_API_ROOT,
  FabricItem,
  FabricWorkspace,
  type FabricConnection,
} from "@iq/shared";
import type { RetryPolicy } from "@iq/shared";
import { backoffDelayMs, sleep, withTimeout } from "../util/retry.js";
import type { Logger } from "../util/logger.js";

/**
 * The wire to the Microsoft Fabric item API.
 *
 * Same authentication story as the Foundry client, and for the same reason:
 * this class takes a `token` callback rather than any credential of its own.
 * Every call is bearer-authenticated with the Azure identity, minted per
 * correlation id for the `azure.fabric` capability. There is no key path
 * because there is no key.
 *
 * Two behaviours are worth naming because they are not obvious from the REST
 * docs and cost a debugging session each:
 *
 *  - **Item creation is long-running.** Fabric answers `202 Accepted` with an
 *    `Operation-Location` and a `Retry-After`, and the item does not exist until
 *    that operation reports `Succeeded`. Returning on the 202 is how a caller
 *    ends up creating a semantic model over a lakehouse that is not there yet.
 *  - **A 403 from Fabric is usually capacity, not permission.** The workspace
 *    must sit on an active Fabric capacity; a paused one refuses every write
 *    with a message that reads like an access problem. The classifier says so.
 */

export interface FabricClientDeps {
  logger: Logger;
  /** Acquire an Azure access token for `azure.fabric`. */
  token: (correlationId: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}

const REQUEST_TIMEOUT_MS = 60_000;
/** A lakehouse or warehouse can take minutes to provision. */
const OPERATION_TIMEOUT_MS = 15 * 60_000;

const RETRY: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: 500,
  backoffFactor: 2,
  maxBackoffMs: 8_000,
};

export class FabricError extends Error {
  override readonly name = "FabricError";
  constructor(
    message: string,
    readonly status: number,
    /** What the user should do next. Empty when there is nothing useful to say. */
    readonly nextStep: string = "",
  ) {
    super(message);
  }
}

export class FabricClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: FabricClientDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  // --- items ----------------------------------------------------------------

  /** Every item in a workspace. Paged; the API caps a page at 100. */
  async listItems(workspaceId: string, correlationId: string): Promise<FabricItem[]> {
    const token = await this.deps.token(correlationId);
    const items: FabricItem[] = [];
    let url = `${FABRIC_API_ROOT}/workspaces/${encodeURIComponent(workspaceId)}/items`;

    // Bounded rather than `while (true)`: a continuation token the service keeps
    // returning would otherwise loop this process forever on a bad day.
    for (let page = 0; page < 50; page += 1) {
      const response = await this.send(url, token, { method: "GET" });
      const body = await this.readJson(response);
      this.assertOk(response, body, "list the items in this workspace");

      const rows = (body as { value?: unknown }).value;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const parsed = FabricItem.safeParse({
            id: (row as { id?: unknown }).id,
            displayName: (row as { displayName?: unknown }).displayName,
            type: (row as { type?: unknown }).type,
            description: (row as { description?: unknown }).description ?? "",
            workspaceId,
          });
          if (parsed.success) items.push(parsed.data);
        }
      }

      const next = (body as { continuationUri?: unknown }).continuationUri;
      if (typeof next !== "string" || next === "") break;
      url = next;
    }

    return items;
  }

  async getItem(workspaceId: string, itemId: string, correlationId: string): Promise<FabricItem> {
    const token = await this.deps.token(correlationId);
    const url = `${FABRIC_API_ROOT}/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}`;
    const response = await this.send(url, token, { method: "GET" });
    const body = await this.readJson(response);
    this.assertOk(response, body, "read this item");

    return FabricItem.parse({
      id: (body as { id?: unknown }).id,
      displayName: (body as { displayName?: unknown }).displayName,
      type: (body as { type?: unknown }).type,
      description: (body as { description?: unknown }).description ?? "",
      workspaceId,
    });
  }

  /**
   * Create an item, waiting for the long-running operation to settle.
   *
   * `definition` is passed through untouched. Item definitions are per-type,
   * base64-part shaped, and documented in the upstream Fabric skill bundle; this
   * client validating them would be this app re-implementing knowledge it has
   * deliberately chosen not to own.
   */
  async createItem(
    input: {
      workspaceId: string;
      displayName: string;
      type: string;
      description?: string;
      definition?: unknown;
    },
    correlationId: string,
  ): Promise<FabricItem> {
    const token = await this.deps.token(correlationId);
    const url = `${FABRIC_API_ROOT}/workspaces/${encodeURIComponent(input.workspaceId)}/items`;

    const response = await this.send(url, token, {
      method: "POST",
      body: JSON.stringify({
        displayName: input.displayName,
        type: input.type,
        ...(input.description ? { description: input.description } : {}),
        ...(input.definition ? { definition: input.definition } : {}),
      }),
    });

    if (response.status === 202) {
      const operation = response.headers.get("Operation-Location");
      if (operation === null) {
        throw new FabricError(
          "Fabric accepted the request but returned no operation to poll, so the item cannot be confirmed",
          202,
          "Check the workspace in the Fabric portal before retrying — the item may have been created.",
        );
      }
      const settled = await this.awaitOperation(operation, token, correlationId);
      return FabricItem.parse({
        id: (settled as { id?: unknown }).id ?? "",
        displayName: (settled as { displayName?: unknown }).displayName ?? input.displayName,
        type: (settled as { type?: unknown }).type ?? input.type,
        description: (settled as { description?: unknown }).description ?? input.description ?? "",
        workspaceId: input.workspaceId,
      });
    }

    const body = await this.readJson(response);
    this.assertOk(response, body, `create a ${input.type} in this workspace`);

    return FabricItem.parse({
      id: (body as { id?: unknown }).id ?? "",
      displayName: (body as { displayName?: unknown }).displayName ?? input.displayName,
      type: (body as { type?: unknown }).type ?? input.type,
      description: (body as { description?: unknown }).description ?? input.description ?? "",
      workspaceId: input.workspaceId,
    });
  }

  /**
   * Poll a long-running operation until it settles.
   *
   * `Retry-After` is honoured rather than replaced with a fixed interval:
   * Fabric raises it under load, and ignoring it is how a provisioning poll
   * turns into rate limiting.
   */
  private async awaitOperation(
    operationUrl: string,
    token: string,
    correlationId: string,
  ): Promise<unknown> {
    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    let waitMs = 2_000;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));

      const response = await this.send(operationUrl, token, { method: "GET" });
      const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
      if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = Math.min(retryAfter * 1_000, 30_000);

      const body = await this.readJson(response);
      this.assertOk(response, body, "check the status of this operation");

      const status = String((body as { status?: unknown }).status ?? "");
      if (status === "Succeeded") {
        // The operation body carries status, not the item. The result endpoint
        // is where the created item actually is.
        const resultUrl = `${operationUrl.replace(/\/$/, "")}/result`;
        const result = await this.send(resultUrl, token, { method: "GET" });
        if (result.ok) return await this.readJson(result);
        return body;
      }
      if (status === "Failed") {
        const detail = (body as { error?: { message?: unknown } }).error?.message;
        throw new FabricError(
          typeof detail === "string" && detail !== ""
            ? detail
            : "the Fabric operation failed without a stated reason",
          500,
          "Check the workspace's capacity and your permissions in the Fabric portal.",
        );
      }
      this.deps.logger.debug("fabric operation still running", { status, correlationId });
    }

    throw new FabricError(
      `the Fabric operation did not finish within ${OPERATION_TIMEOUT_MS / 60_000} minutes`,
      408,
      "The item may still be provisioning. Check the workspace before retrying.",
    );
  }

  /** Cheapest check that the workspace exists and the identity can read it. */
  async probe(connection: FabricConnection, correlationId: string): Promise<{ name: string }> {
    const token = await this.deps.token(correlationId);
    const url = `${FABRIC_API_ROOT}/workspaces/${encodeURIComponent(connection.workspaceId)}`;
    const response = await this.send(url, token, { method: "GET" });
    const body = await this.readJson(response);
    this.assertOk(response, body, "read this workspace");
    const name = (body as { displayName?: unknown }).displayName;
    return { name: typeof name === "string" ? name : "" };
  }

  /**
   * Every workspace the identity can see.
   *
   * Paged the same way items are, and bounded for the same reason. The list is
   * read-only and is only ever used to fill a picker, so a workspace the API
   * describes oddly is dropped rather than allowed to fail the whole call: one
   * unparseable row should not cost the user the other forty.
   */
  async listWorkspaces(correlationId: string): Promise<FabricWorkspace[]> {
    const token = await this.deps.token(correlationId);
    const workspaces: FabricWorkspace[] = [];
    let url = `${FABRIC_API_ROOT}/workspaces`;

    for (let page = 0; page < 50; page += 1) {
      const response = await this.send(url, token, { method: "GET" });
      const body = await this.readJson(response);
      this.assertOk(response, body, "list the workspaces you can see");

      const rows = (body as { value?: unknown }).value;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const parsed = FabricWorkspace.safeParse({
            id: (row as { id?: unknown }).id,
            displayName: (row as { displayName?: unknown }).displayName,
            description: (row as { description?: unknown }).description ?? "",
            capacityId: (row as { capacityId?: unknown }).capacityId ?? "",
          });
          if (parsed.success) workspaces.push(parsed.data);
        }
      }

      const next = (body as { continuationUri?: unknown }).continuationUri;
      if (typeof next !== "string" || next === "") break;
      url = next;
    }

    // Sorted here rather than in the renderer: the API returns creation order,
    // which is meaningless to the person reading the list.
    return workspaces.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  // --- transport ------------------------------------------------------------

  /**
   * One request, with retries for the transient class only.
   *
   * 429 and 5xx are retried; every 4xx is returned as-is for {@link assertOk} to
   * classify. Retrying a deterministic refusal spends four round-trips to
   * produce the same message, and delays it by several seconds.
   */
  private async send(url: string, token: string, init: RequestInit): Promise<Response> {
    let last: Response | null = null;

    for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt += 1) {
      const response = await withTimeout(
        REQUEST_TIMEOUT_MS,
        async () =>
          this.fetchImpl(url, {
            ...init,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              "Content-Type": "application/json",
              ...init.headers,
            },
          }),
        "fabric request",
      );

      if (response.status !== 429 && response.status < 500) return response;
      last = response;
      if (attempt === RETRY.maxAttempts) break;
      await sleep(backoffDelayMs(RETRY, attempt));
    }

    // Returned rather than thrown: the caller's `assertOk` produces the message,
    // so a final 503 reads like every other failure instead of a bare stack.
    return last as Response;
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.trim() === "") return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { raw: text.slice(0, 2_000) };
    }
  }

  /**
   * Turn a failure into something the user can act on.
   *
   * The 403 case is the one that earns its lines: Fabric returns it both for
   * "you may not do this" and for "the capacity behind this workspace is
   * paused", and those have completely different fixes.
   */
  private assertOk(response: Response, body: unknown, action: string): void {
    if (response.ok) return;

    const detail =
      (body as { error?: { message?: unknown }; message?: unknown }).error?.message ??
      (body as { message?: unknown }).message;
    const message =
      typeof detail === "string" && detail !== ""
        ? detail
        : `Fabric returned HTTP ${response.status}`;

    const nextStep =
      response.status === 401
        ? "Sign in to Microsoft in Connections & access, then retry."
        : response.status === 403
          ? `Could not ${action}. Check that you have the Contributor role on the workspace and that its Fabric capacity is running — a paused capacity refuses writes with this same status.`
          : response.status === 404
            ? "Check the workspace id in Connections & access; it is the GUID from the Fabric workspace URL."
            : "";

    throw new FabricError(message, response.status, nextStep);
  }
}
