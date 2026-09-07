import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MYIQ_DEFAULT_NAME,
  MYIQ_REQUIRES_SAMPLE_DATA,
  MYIQ_SNAPSHOT_FILE,
  MYIQ_SNAPSHOT_VERSION,
  MyIqSnapshot,
  SAMPLE_MEMORY_ID_PREFIX,
  type MyIqEndpoint,
  type MyIqMemory,
  type MyIqNote,
  type MyIqPublishRequest,
  type MyIqPublishResult,
  type MyIqStatus,
} from "@iq/shared";
import type { AppPaths } from "../config/paths.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { Logger } from "../util/logger.js";
import type { Actor } from "../mcp/registry.js";

/**
 * Publishes My IQ as a snapshot an MCP server can serve.
 *
 * Everything about this class is arranged so that the answer to "could this
 * ever hand somebody's real work to another program?" is no, and is checkable
 * without reading the whole file:
 *
 *  - `publish` refuses outright unless sample data is on. That is the gate for
 *    IQ Cells, because a cell someone compiled themselves is shaped exactly
 *    like a generated one and no per-record filter could honestly tell them
 *    apart (see `MYIQ_REQUIRES_SAMPLE_DATA`).
 *  - Memories are filtered by id prefix, which *is* provable: the sample set
 *    has fixed `mem_sample_NN` ids.
 *  - The knowledge vault is included only while it reports `isSamples`, which
 *    the vault persists rather than deriving by comparing paths.
 *  - The snapshot is stamped `sampleDataOnly: true` and the server refuses one
 *    without it, so the guarantee survives a future change to this file.
 *
 * Nothing here starts a process. The server is spawned by whichever app
 * connects to it, which is what keeps this app from holding an open surface
 * onto its own data for the sake of a demo.
 */

/**
 * Where the built server lives.
 *
 * Resolved from this module's own location rather than from the process's
 * working directory, which is whatever Electron was started in and is not a
 * property of the installation. `IQ_MYIQ_SERVER` overrides it, the same escape
 * hatch the other resolved binaries have.
 */
export function myIqServerEntry(): string {
  const override = process.env["IQ_MYIQ_SERVER"];
  if (override !== undefined && override !== "") return override;
  const here = fileURLToPath(new URL(".", import.meta.url));
  // packages/core/dist/myiq/ -> packages/myiq-mcp/dist/index.js
  return resolve(here, "..", "..", "..", "myiq-mcp", "dist", "index.js");
}

export interface MyIqPublisherDeps {  paths: AppPaths;
  audit: AuditLog;
  logger: Logger;
  /** The app-wide sample-data flag. Read live, never cached. */
  sampleDataEnabled: () => boolean;
  /** Approved and pending memories, already loaded. */
  listMemories: () => Promise<
    ReadonlyArray<{
      id: string;
      subject: string;
      fact: string;
      memoryType: string;
      status: string;
    }>
  >;
  /** The knowledge vault's own account of itself. */
  vaultState: () => Promise<{ isSamples: boolean }>;
  /** Indexed notes, for the note list. */
  listNotes: () => Promise<ReadonlyArray<{ path: string; title: string }>>;
  /** Absolute path to the built server entry point. */
  serverEntry: () => string;
}

export class MyIqPublisher {
  constructor(private readonly deps: MyIqPublisherDeps) {}

  private get snapshotPath(): string {
    return join(this.deps.paths.myiq, MYIQ_SNAPSHOT_FILE);
  }

  /**
   * How another app is told to reach the server.
   *
   * `process.execPath` is deliberately **not** used: in a packaged build that
   * is Electron, not Node, and handing a client an Electron binary to spawn as
   * a stdio server would fail in a way that reads as our bug. The command is
   * plain `node`, which the connecting app resolves on its own PATH.
   */
  endpoint(): MyIqEndpoint {
    const entry = this.deps.serverEntry();
    const config = {
      servers: {
        "my-iq": {
          type: "stdio",
          command: "node",
          args: [entry],
          env: { IQ_HOME: this.deps.paths.root },
        },
      },
    };
    return {
      command: "node",
      args: [entry],
      clientConfig: JSON.stringify(config, null, 2),
    };
  }

  /** What the MCP surface shows without anyone pressing anything. */
  async status(): Promise<MyIqStatus> {
    const endpoint = this.endpoint();
    const snapshot = await this.read();
    if (snapshot === null) {
      return {
        published: false,
        publishedAt: "",
        name: "",
        shared: false,
        snapshotPath: "",
        cellCount: 0,
        memoryCount: 0,
        noteCount: 0,
        hasConnectome: false,
        endpoint,
      };
    }
    return {
      published: true,
      publishedAt: snapshot.publishedAt,
      name: snapshot.name === "" ? MYIQ_DEFAULT_NAME : snapshot.name,
      shared: snapshot.shared,
      snapshotPath: this.snapshotPath,
      cellCount: snapshot.cells.length,
      memoryCount: snapshot.memories.length,
      noteCount: snapshot.notes.length,
      hasConnectome: snapshot.connectome !== null,
      endpoint,
    };
  }

  /**
   * Write the snapshot.
   *
   * The refusal is first and is a thrown error rather than an empty publish:
   * "published nothing" and "declined to publish" are different answers, and
   * only the second tells the user what to do about it.
   */
  async publish(
    input: MyIqPublishRequest,
    actor: Actor,
    correlationId: string,
  ): Promise<MyIqPublishResult> {
    if (!this.deps.sampleDataEnabled()) {
      await this.deps.audit.record({
        actor: { kind: "user", oid: actor.oid, tenantId: actor.tenantId },
        action: "myiq.publish",
        family: "mcp",
        outcome: "denied",
        correlationId,
        resources: [],
        reason: "sample data is off",
      });
      throw new Error(MYIQ_REQUIRES_SAMPLE_DATA);
    }

    const offered = await this.deps.listMemories();
    const memories: MyIqMemory[] = offered
      .filter((memory) => memory.id.startsWith(SAMPLE_MEMORY_ID_PREFIX))
      .map((memory) => ({
        id: memory.id,
        subject: memory.subject,
        fact: memory.fact,
        memoryType: memory.memoryType,
        status: memory.status,
      }));
    const droppedMemories = offered.length - memories.length;

    const vault = await this.deps.vaultState();
    const notes: MyIqNote[] = vault.isSamples
      ? (await this.deps.listNotes()).map((note) => ({ path: note.path, title: note.title }))
      : [];

    const snapshot = MyIqSnapshot.parse({
      schemaVersion: MYIQ_SNAPSHOT_VERSION,
      publishedAt: new Date().toISOString(),
      // Named here rather than in the renderer so an empty box and a missing
      // field land on the same value, whichever side the publish came from.
      name: (input.name ?? "").trim() === "" ? MYIQ_DEFAULT_NAME : (input.name ?? "").trim(),
      shared: input.shared ?? false,
      sampleDataOnly: true,
      cells: input.cells,
      connectome: input.connectome,
      memories,
      notes,
    });

    await mkdir(this.deps.paths.myiq, { recursive: true });
    await writeFile(this.snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

    await this.deps.audit.record({
      actor: { kind: "user", oid: actor.oid, tenantId: actor.tenantId },
      action: "myiq.publish",
      family: "mcp",
      outcome: "succeeded",
      correlationId,
      resources: [this.snapshotPath],
      reason: `"${snapshot.name}"${snapshot.shared ? ", shared" : ", not shared"}: ${snapshot.cells.length} IQ Cells, ${memories.length} memories, ${notes.length} notes`,
    });

    this.deps.logger.info("published My IQ over MCP", {
      name: snapshot.name,
      shared: snapshot.shared,
      cells: snapshot.cells.length,
      memories: memories.length,
      notes: notes.length,
    });

    return {
      status: await this.status(),
      droppedMemories,
      skippedVault: !vault.isSamples,
    };
  }

  /** The snapshot, or null when nothing has been published or it is unreadable. */
  private async read(): Promise<MyIqSnapshot | null> {
    const raw = await readFile(this.snapshotPath, "utf8").catch(() => null);
    if (raw === null) return null;
    const parsed = MyIqSnapshot.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) {
      this.deps.logger.warn("unreadable My IQ snapshot", { path: this.snapshotPath });
      return null;
    }
    return parsed.data;
  }
}
