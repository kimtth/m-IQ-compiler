import { z } from "zod";

/**
 * Publishing My IQ over MCP.
 *
 * Every other MCP contract in this app points inwards: `packages/shared/mcp.ts`
 * describes servers *this* app connects to and the consent needed to call them.
 * This one points the other way — it is the shape of what this app offers to
 * something else, so that My IQ can be read from VS Code, Claude Desktop or any
 * other MCP client.
 *
 * Three properties are deliberate and load-bearing:
 *
 *  1. **It is a snapshot, not a live view.** The IQ Cell library lives in the
 *     renderer's `localStorage`, so neither the main process nor a separate
 *     server process can read it. Publishing is the moment the renderer hands
 *     that over, which is the whole reason the button means something rather
 *     than being a label on a background service.
 *
 *  2. **It is sample data, by construction.** `sampleDataOnly` is not a hint;
 *     the publisher filters to records it can prove are samples, and the server
 *     refuses to load a snapshot that does not carry the flag. A future change
 *     that starts writing real records therefore fails closed rather than
 *     quietly serving somebody's mailbox to another program.
 *
 *  3. **It is read-only.** There is no shape here for writing anything back.
 *     A connected client can read what was published and nothing else.
 */

/** Bumped when a reader would misinterpret an older file rather than merely miss a field. */
export const MYIQ_SNAPSHOT_VERSION = 1;

/** Snapshot file name, under `AppPaths.myiq`. */
export const MYIQ_SNAPSHOT_FILE = "published.json";

/**
 * An IQ Cell as another app sees it.
 *
 * A projection of the renderer's `DemoIqCell`, not the whole thing. The fields
 * left out — activeHours, tokensPerRun, pinnedVersionsBehind and the rest — are
 * inputs to the coupling analysis, and publishing them would invite a reader to
 * recompute the map from a partial copy and disagree with the app about it.
 */
export const MyIqCell = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
  /**
   * Which surface compiled it. A free string rather than an enum: the value
   * comes from a record that outlives any one release, and the four origins
   * other than `editor` are no longer minted but are still on disk.
   */
  origin: z.string(),
  /** What the cell does, in the product's own words. */
  faces: z.array(z.string()).default([]),
  /** The systems it is declared to touch. */
  reach: z.array(z.string()).default([]),
  runs: z.number().int().nonnegative().default(0),
  completionRate: z.number().default(0),
  approver: z.string().default(""),
});
export type MyIqCell = z.infer<typeof MyIqCell>;

/**
 * The connectome analysis, summarised.
 *
 * The findings and limits travel together on purpose: a finding is a claim
 * about how someone's work hangs together, and the limits say what the analysis
 * could not see. Handing another app the first without the second would strip
 * exactly the qualification the report exists to carry.
 */
export const MyIqConnectome = z.object({
  hash: z.string(),
  nodeCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  windowDays: z.number().int().positive(),
  findings: z.array(
    z.object({
      kind: z.string(),
      title: z.string(),
      detail: z.string(),
      action: z.string(),
    }),
  ),
  limits: z.array(z.string()),
  generatedAt: z.string(),
});
export type MyIqConnectome = z.infer<typeof MyIqConnectome>;

export const MyIqMemory = z.object({
  id: z.string(),
  subject: z.string(),
  fact: z.string(),
  memoryType: z.string(),
  status: z.string(),
});
export type MyIqMemory = z.infer<typeof MyIqMemory>;

export const MyIqNote = z.object({
  /** Vault-relative, always spelled with `/`. */
  path: z.string(),
  title: z.string(),
});
export type MyIqNote = z.infer<typeof MyIqNote>;

export const MyIqSnapshot = z.object({
  schemaVersion: z.number().int().positive(),
  publishedAt: z.string(),
  /**
   * What the person called this IQ when they published it.
   *
   * Set at the publish dialog, not derived from a profile or a machine name.
   * A reader on the other side of MCP sees a directory of IQs, and "My IQ" for
   * every one of them is a directory with no information in it.
   */
  name: z.string().default(""),
  /**
   * Whether the publisher meant this for other people.
   *
   * It changes nothing about what the server serves — the same file, the same
   * five read-only tools. It is the publisher's stated intent, and it is what
   * Connectome IQ lists an IQ under. Off means published for your own tools
   * only.
   */
  shared: z.boolean().default(false),
  /**
   * Always true in a file this app writes.
   *
   * Modelled as a literal rather than a boolean so the type system carries the
   * guarantee too: there is no way to construct a valid snapshot that says
   * otherwise, and the server's parse fails on one that does.
   */
  sampleDataOnly: z.literal(true),
  cells: z.array(MyIqCell),
  connectome: MyIqConnectome.nullable(),
  memories: z.array(MyIqMemory),
  notes: z.array(MyIqNote),
});
export type MyIqSnapshot = z.infer<typeof MyIqSnapshot>;

/** Used when a publish carries no name, and when an older snapshot has none. */
export const MYIQ_DEFAULT_NAME = "My IQ";

/** What the renderer hands over. Memories and notes are read privileged-side. */
export const MyIqPublishInput = z.object({
  /** Named by the person publishing. Trimmed and defaulted by the publisher. */
  name: z.string().default(""),
  /** Their answer to "is this for other people?". */
  shared: z.boolean().default(false),
  cells: z.array(MyIqCell),
  connectome: MyIqConnectome.nullable().default(null),
});
export type MyIqPublishInput = z.infer<typeof MyIqPublishInput>;

/**
 * What a caller may hand over, before the schema fills anything in.
 *
 * `name` and `shared` are optional here and required on `MyIqPublishInput`,
 * because a default turns an absent field into a present one. The publisher
 * takes this shape so that "the renderer left the box empty" and "nothing sent
 * a name at all" are both callable rather than only the first.
 */
export type MyIqPublishRequest = z.input<typeof MyIqPublishInput>;

/**
 * How another app is told to reach the server.
 *
 * The command and args are reported rather than assumed by the UI, because the
 * server's location is a property of this installation and the renderer has no
 * business knowing where on disk anything is.
 */
export const MyIqEndpoint = z.object({
  command: z.string(),
  args: z.array(z.string()),
  /** Ready to paste into another app's MCP configuration. */
  clientConfig: z.string(),
});
export type MyIqEndpoint = z.infer<typeof MyIqEndpoint>;

export const MyIqStatus = z.object({
  published: z.boolean(),
  publishedAt: z.string().default(""),
  /** The published IQ's name. Empty until something has been published. */
  name: z.string().default(""),
  /** Whether the last publish said this IQ is for other people. */
  shared: z.boolean().default(false),
  snapshotPath: z.string().default(""),
  cellCount: z.number().int().nonnegative().default(0),
  memoryCount: z.number().int().nonnegative().default(0),
  noteCount: z.number().int().nonnegative().default(0),
  hasConnectome: z.boolean().default(false),
  endpoint: MyIqEndpoint,
});
export type MyIqStatus = z.infer<typeof MyIqStatus>;

export const MyIqPublishResult = z.object({
  status: MyIqStatus,
  /**
   * How many memories were offered and refused for not being sample data.
   *
   * Reported rather than silently dropped: "we published 8 of the 30 memories"
   * is a different fact from "we published your memories", and the surface that
   * asked for the publish is the only place that can say so.
   */
  droppedMemories: z.number().int().nonnegative().default(0),
  /** True when the knowledge vault was skipped because it is not the sample one. */
  skippedVault: z.boolean().default(false),
});
export type MyIqPublishResult = z.infer<typeof MyIqPublishResult>;

/**
 * Ids the sample memory set uses.
 *
 * The prefix is the proof: `MemoryStore.seedSamples` mints fixed
 * `mem_sample_NN` ids so seeding is idempotent and clearing can never touch a
 * real memory. That same property is what lets the publisher tell a sample from
 * a real claim without asking anyone.
 */
export const SAMPLE_MEMORY_ID_PREFIX = "mem_sample_";

/**
 * Why there is no equivalent test for a cell.
 *
 * A memory carries its own provenance in its id and the knowledge vault records
 * `isSamples` on its state, so both can be filtered record by record. The IQ
 * Cell library cannot: it is renderer `localStorage`, the demo library spans
 * all four origins, and a cell someone compiled themselves is shaped exactly
 * like a generated one. So the gate for cells is the app-wide sample-data flag,
 * checked before anything is written — publishing is refused outright while it
 * is off, rather than shipping a filter that cannot actually tell them apart.
 */
export const MYIQ_REQUIRES_SAMPLE_DATA =
  "Publishing serves sample data only. Turn on Control Center \u2192 Sample data first.";
