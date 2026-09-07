import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CONVERSATION_DESTINATIONS,
  DEFAULT_SESSION_PLACE,
  canHoldConversation,
  holdsConversation,
  modeForPlace,
  placeForTool,
  placeKey,
  type AppSurface,
  type SessionPlace,
  type SessionSummary,
  type SubMode,
} from "@iq/shared";
import { SessionRepo } from "../packages/core/src/runtime/sessions/fs-repo.js";
import { SessionsService } from "../packages/core/src/runtime/sessions/sessions.js";
import type { SessionsDeps } from "../packages/core/src/runtime/sessions/sessions.js";
import { TurnRepo } from "../packages/core/src/runtime/turns/fs-repo.js";
import { ToolRegistry } from "../packages/core/src/runtime/tools/registry.js";
import { ensureAppPaths, resolveAppPaths } from "../packages/core/src/config/paths.js";

/**
 * Clearing a conversation is not deleting it.
 *
 * The distinction is the whole point of the feature, and it lives entirely in
 * how the session log is folded: the events stay on disk, and readers ignore
 * the turns that precede the clear. These tests pin that fold, because the
 * failure mode — a "cleared" conversation that still feeds its old turns back
 * to the model — is invisible in the UI until the model says something the
 * user thought they had removed.
 */
describe("session history clear", () => {
  let root: string;
  let repo: SessionRepo;

  const at = (minute: number): string =>
    new Date(Date.UTC(2026, 6, 29, 12, minute, 0)).toISOString();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "iq-clear-"));
    const paths = resolveAppPaths(root);
    ensureAppPaths(paths);
    repo = new SessionRepo(paths);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const seed = async (): Promise<void> => {
    await repo.append("s1", [
      { type: "session_created", sessionId: "s1", at: at(0), title: "Pricing", origin: "interactive", parentSessionId: null },
      { type: "turn_appended", sessionId: "s1", at: at(1), turnId: "t1" },
      { type: "turn_appended", sessionId: "s1", at: at(2), turnId: "t2" },
    ]);
  };

  it("drops retired turns from the conversation but keeps them on the log", async () => {
    await seed();
    await repo.append("s1", [{ type: "history_cleared", sessionId: "s1", at: at(3) }]);

    expect(await repo.turnIds("s1")).toEqual([]);
    expect(await repo.allTurnIds("s1")).toEqual(["t1", "t2"]);
  });

  it("keeps the session, its title and its place in the list", async () => {
    await seed();
    await repo.append("s1", [{ type: "history_cleared", sessionId: "s1", at: at(3) }]);

    const summary = await repo.summary("s1");
    expect(summary?.title).toBe("Pricing");
    expect(summary?.turnCount).toBe(0);
    expect((await repo.list()).map((session) => session.id)).toEqual(["s1"]);
  });

  it("counts only the turns that came after the clear", async () => {
    await seed();
    await repo.append("s1", [
      { type: "history_cleared", sessionId: "s1", at: at(3) },
      { type: "turn_appended", sessionId: "s1", at: at(4), turnId: "t3" },
    ]);

    expect(await repo.turnIds("s1")).toEqual(["t3"]);
    expect((await repo.summary("s1"))?.turnCount).toBe(1);
  });

  it("resets again on a second clear", async () => {
    await seed();
    await repo.append("s1", [
      { type: "history_cleared", sessionId: "s1", at: at(3) },
      { type: "turn_appended", sessionId: "s1", at: at(4), turnId: "t3" },
      { type: "history_cleared", sessionId: "s1", at: at(5) },
    ]);

    expect(await repo.turnIds("s1")).toEqual([]);
    expect(await repo.allTurnIds("s1")).toEqual(["t1", "t2", "t3"]);
  });
});

/**
 * Where a session came from.
 *
 * The summary is the only thing the UI sees, and it is what decides whether a
 * session is offered as one of the user's conversations. A council runs each
 * member's turn as its own `sub_agent` session, so one council produces a
 * dozen; reporting them as interactive fills the rail with rows nobody
 * started. The value is on the creation event and must be read from it.
 */
describe("session origin", () => {
  let root: string;
  let repo: SessionRepo;

  const at = (minute: number): string =>
    new Date(Date.UTC(2026, 6, 31, 9, minute, 0)).toISOString();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "iq-origin-"));
    const paths = resolveAppPaths(root);
    ensureAppPaths(paths);
    repo = new SessionRepo(paths);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reports each origin as it was recorded", async () => {
    await repo.append("mine", [
      {
        type: "session_created",
        sessionId: "mine",
        at: at(0),
        title: "Pricing",
        origin: "interactive",
        parentSessionId: null,
      },
    ]);
    await repo.append("member", [
      {
        type: "session_created",
        sessionId: "member",
        at: at(1),
        title: "Headless run",
        origin: "sub_agent",
        parentSessionId: "mine",
      },
    ]);
    await repo.append("nightly", [
      {
        type: "session_created",
        sessionId: "nightly",
        at: at(2),
        title: "Nightly digest",
        origin: "scheduled",
        parentSessionId: null,
      },
    ]);

    expect((await repo.summary("mine"))?.origin).toBe("interactive");
    expect((await repo.summary("member"))?.origin).toBe("sub_agent");
    expect((await repo.summary("nightly"))?.origin).toBe("scheduled");
  });

  it("keeps the parent a sub-agent session belongs to", async () => {
    await repo.append("member", [
      {
        type: "session_created",
        sessionId: "member",
        at: at(0),
        title: "Headless run",
        origin: "sub_agent",
        parentSessionId: "council-1",
      },
    ]);

    expect((await repo.summary("member"))?.parentSessionId).toBe("council-1");
  });

  it("carries the origin through the list the UI groups by", async () => {
    for (const [id, origin] of [
      ["a", "interactive"],
      ["b", "sub_agent"],
      ["c", "sub_agent"],
    ] as const) {
      await repo.append(id, [
        {
          type: "session_created",
          sessionId: id,
          at: at(0),
          title: id,
          origin,
          parentSessionId: null,
        },
      ]);
    }

    const listed = await repo.list();
    expect(listed.filter((session) => session.origin === "interactive")).toHaveLength(1);
    expect(listed.filter((session) => session.origin === "sub_agent")).toHaveLength(2);
  });

  it("does not expose sub-agent sessions through the chat history service", async () => {
    for (const [id, origin] of [
      ["interactive", "interactive"],
      ["child", "sub_agent"],
      ["scheduled", "scheduled"],
    ] as const) {
      await repo.append(id, [
        {
          type: "session_created",
          sessionId: id,
          at: at(0),
          title: id,
          origin,
          parentSessionId: origin === "sub_agent" ? "interactive" : null,
        },
      ]);
    }

    const service = new SessionsService({ sessionRepo: repo } as SessionsDeps);

    expect((await service.list()).map((session) => session.id)).toEqual(["interactive", "scheduled"]);
  });
});

/**
 * A conversation's name.
 *
 * The list is how a conversation is found again, and every session was created
 * as "New session" with nothing ever changing it — so a second one was
 * indistinguishable from the first, and creating one looked like it had done
 * nothing. `title_changed` was in the schema and read by `summary` from the
 * beginning; nothing emitted it.
 */
describe("session title", () => {
  let root: string;
  let repo: SessionRepo;

  const at = (minute: number): string =>
    new Date(Date.UTC(2026, 6, 31, 14, minute, 0)).toISOString();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "iq-title-"));
    const paths = resolveAppPaths(root);
    ensureAppPaths(paths);
    repo = new SessionRepo(paths);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const created = (id: string, title: string): Parameters<SessionRepo["append"]>[1] => [
    { type: "session_created", sessionId: id, at: at(0), title, origin: "interactive", parentSessionId: null },
  ];

  it("is the last name given, not the one it was created with", async () => {
    await repo.append("s1", created("s1", "New session"));
    await repo.append("s1", [
      { type: "title_changed", sessionId: "s1", at: at(1), title: "Seal check decision" },
    ]);

    expect((await repo.summary("s1"))?.title).toBe("Seal check decision");
  });

  it("takes the latest of several renames", async () => {
    await repo.append("s1", created("s1", "New session"));
    await repo.append("s1", [
      { type: "title_changed", sessionId: "s1", at: at(1), title: "First" },
      { type: "title_changed", sessionId: "s1", at: at(2), title: "Second" },
    ]);

    expect((await repo.summary("s1"))?.title).toBe("Second");
  });

  it("keeps the name through a history clear", async () => {
    // Clearing empties the thread and keeps the conversation, so it must keep
    // what the conversation is called.
    await repo.append("s1", created("s1", "New session"));
    await repo.append("s1", [
      { type: "title_changed", sessionId: "s1", at: at(1), title: "Named" },
      { type: "turn_appended", sessionId: "s1", at: at(2), turnId: "t1" },
      { type: "history_cleared", sessionId: "s1", at: at(3) },
    ]);

    const summary = await repo.summary("s1");
    expect(summary?.title).toBe("Named");
    expect(summary?.turnCount).toBe(0);
  });
});

/**
 * Where a conversation is held.
 *
 * A conversation is not only a thread. "Create a deck about Microsoft" is held
 * on Co-create → Office and "search the web for X" on Co-create → Browser, so
 * selecting one in the rail has to restore the mode and the canvas tab as well
 * as the messages — otherwise the second conversation opens on the first one's
 * work and the user has to remember where they were.
 */
describe("session place", () => {
  let root: string;
  let repo: SessionRepo;
  let service: SessionsService;
  /** Every index publish, so a redundant write is visible as an extra one. */
  let published: SessionSummary[][];

  const at = (minute: number): string =>
    new Date(Date.UTC(2026, 7, 4, 10, minute, 0)).toISOString();

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "iq-place-"));
    const paths = resolveAppPaths(root);
    await ensureAppPaths(paths);
    repo = new SessionRepo(paths);
    published = [];
    service = new SessionsService({
      paths,
      sessionRepo: repo,
      publishIndex: (summaries: SessionSummary[]) => {
        published.push(summaries);
      },
    } as unknown as SessionsDeps);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const created = (id: string): Parameters<SessionRepo["append"]>[1] => [
    {
      type: "session_created",
      sessionId: id,
      at: at(0),
      title: "Deck",
      origin: "interactive",
      parentSessionId: null,
    },
  ];

  it("opens on the thread when nothing was ever recorded", async () => {
    await repo.append("s1", created("s1"));

    expect((await repo.summary("s1"))?.place).toEqual(DEFAULT_SESSION_PLACE);
  });

  it("is the last place the conversation's own work established", async () => {
    await repo.append("s1", created("s1"));
    await repo.append("s1", [
      {
        type: "place_changed",
        sessionId: "s1",
        at: at(1),
        place: { subMode: "office", surface: null },
        source: "work",
      },
      {
        type: "place_changed",
        sessionId: "s1",
        at: at(2),
        place: { subMode: "fabric", surface: null },
        source: "work",
      },
    ]);

    expect((await repo.summary("s1"))?.place).toEqual({ subMode: "fabric", surface: null });
  });

  /**
   * The defect, folded from the shape it really had on disk.
   *
   * Taken from a real profile: the conversation "create pptx about Microsoft"
   * accumulated nine navigation records as the user moved around the app with
   * it selected. Its one real signal — `office`, from the
   * `office_create_document` request in its turn log — was written seventh and
   * then buried, so the rail restored Research.
   */
  it("ignores the places an earlier build recorded from the window", async () => {
    await repo.append("s1", created("s1"));
    const wandering: Array<[SubMode, AppSurface | null]> = [
      ["fabric", null],
      ["image", null],
      ["image", "meetings"],
      ["image", "browser"],
      ["research", null],
      ["image", null],
      ["office", null],
      ["fabric", null],
      ["research", null],
    ];
    await repo.append(
      "s1",
      wandering.map(([subMode, surface], index) => ({
        type: "place_changed" as const,
        sessionId: "s1",
        at: at(index + 1),
        place: { subMode, surface },
        source: "navigation" as const,
      })),
    );

    // Not Research, and not Office either: nothing here is evidence, so the
    // session reads as unplaced and lands in the repair pass.
    expect((await repo.summary("s1"))?.place).toEqual(DEFAULT_SESSION_PLACE);
    expect((await repo.summary("s1"))?.placeKnown).toBe(false);
  });

  it("does not reorder the rail", async () => {
    // The list is sorted by `updatedAt`. Opening a tab beside a conversation is
    // navigation, not activity: letting it count would push whichever
    // conversation the user merely looked at to the top of their history.
    await repo.append("older", created("older"));
    await repo.append("newer", [
      {
        type: "session_created",
        sessionId: "newer",
        at: at(5),
        title: "Newer",
        origin: "interactive",
        parentSessionId: null,
      },
    ]);
    await repo.append("older", [
      {
        type: "place_changed",
        sessionId: "older",
        at: at(9),
        place: { subMode: "office", surface: null },
        source: "work",
      },
    ]);

    expect((await repo.list()).map((session) => session.id)).toEqual(["newer", "older"]);
  });

  it("records a move and ignores a return to the same place", async () => {
    const sessionId = await service.create({ title: "Deck" });
    published = [];

    await service.setPlace(sessionId, { subMode: "office", surface: null }, "work");
    await service.setPlace(sessionId, { subMode: "office", surface: null }, "work");

    expect((await repo.summary(sessionId))?.place).toEqual({ subMode: "office", surface: null });
    // One append, one publish. Every tool call in a six-slide deck build asks
    // for the same place, and an append-only log must not grow by a line each.
    expect(published).toHaveLength(1);
    expect(
      (await repo.read(sessionId)).filter((event) => event.type === "place_changed"),
    ).toHaveLength(1);
  });

  it("keeps its place through a history clear", async () => {
    const sessionId = await service.create({ title: "Browsing" });
    await service.setPlace(sessionId, { subMode: null, surface: "browser" }, "work");
    await repo.append(sessionId, [
      { type: "history_cleared", sessionId, at: at(8) },
    ]);

    expect((await repo.summary(sessionId))?.place).toEqual({
      subMode: null,
      surface: "browser",
    });
  });

  /**
   * The destination picker: a place stated before the conversation has done
   * anything.
   *
   * This is the one message the shell is allowed to send about where a
   * conversation belongs, and it is legitimate for the reason every navigation
   * record was not — it answers a question the user was actually asked, once,
   * at the moment the conversation is created.
   */
  it("takes the destination chosen when the conversation was started", async () => {
    const sessionId = await service.create({
      title: "Deck",
      place: { subMode: "office", surface: null },
    });

    const summary = await repo.summary(sessionId);
    expect(summary?.place).toEqual({ subMode: "office", surface: null });
    expect(summary?.placeKnown).toBe(true);
    expect(summary?.placeChosen).toBe(true);
  });

  it("does not let later work move a conversation that was placed by hand", async () => {
    const sessionId = await service.create({
      title: "Deck",
      place: { subMode: "office", surface: null },
    });

    // The agent then queries a warehouse. Under `work` alone this is
    // last-write-wins and the conversation would be re-filed under Fabric —
    // which is right for an inference and wrong against a statement.
    await service.setPlace(sessionId, { subMode: "fabric", surface: null }, "work");

    expect((await repo.summary(sessionId))?.place).toEqual({ subMode: "office", surface: null });
    // Refused before the write, so the log does not fill with records that are
    // read and discarded.
    expect(
      (await repo.read(sessionId)).filter((event) => event.type === "place_changed"),
    ).toHaveLength(1);
  });

  /**
   * Choosing the plain thread is a choice, not an absence of one.
   *
   * "The user asked for a conversation" and "nobody has said" are different
   * facts, and only the first should stop a tool call re-filing it.
   */
  it("treats an explicit Conversation as a decision, not as the default", async () => {
    const sessionId = await service.create({ place: DEFAULT_SESSION_PLACE });

    await service.setPlace(sessionId, { subMode: "office", surface: null }, "work");

    expect((await repo.summary(sessionId))?.place).toEqual(DEFAULT_SESSION_PLACE);
    expect((await repo.summary(sessionId))?.placeChosen).toBe(true);
  });

  it("leaves a conversation started with no destination open to inference", async () => {
    const sessionId = await service.create({ title: "Whatever this becomes" });

    expect((await repo.summary(sessionId))?.placeChosen).toBe(false);
    await service.setPlace(sessionId, { subMode: "office", surface: null }, "work");

    expect((await repo.summary(sessionId))?.place).toEqual({ subMode: "office", surface: null });
  });

  /**
   * Every destination the picker offers has to be one the shell can actually
   * show. The list is an offer made in the UI and `canHoldConversation` is the
   * rule the privileged side refuses a write on; nothing but a test keeps the
   * two from drifting apart, and the failure would be a menu item that
   * silently does nothing.
   */
  it("offers only destinations a conversation can be held in", () => {
    expect(CONVERSATION_DESTINATIONS.length).toBeGreaterThan(0);
    for (const place of CONVERSATION_DESTINATIONS) {
      expect(canHoldConversation(place), placeKey(place)).toBe(true);
    }
  });

  it("does not offer Team or Data agent", () => {
    // Both replace the chat pane with a surface of their own, so a conversation
    // filed on either reopens showing none of its own messages.
    const offered = CONVERSATION_DESTINATIONS.map((place) => place.subMode);
    expect(offered).not.toContain("team");
    expect(offered).not.toContain("dataagent");
  });

  it("offers each destination exactly once", () => {
    const keys = CONVERSATION_DESTINATIONS.map(placeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/**
 * Placing a conversation by the work it did.
 *
 * Recording where the *user was standing* only ever placed a conversation if
 * the user happened to be looking at the right thing. Building a deck opens
 * the Office surface by itself, so that case worked; nothing else did.
 *
 * The table below is the whole contract, and it is exhaustive over the tool
 * families this product registers. Every row states a destination or states
 * that there is deliberately none — an unlisted tool is not "unknown", it is
 * untested, and the two failures reported against this feature were both a
 * tool that had never been thought about landing somewhere by accident.
 */
describe("placing a conversation by its work", () => {
  /** tool name → family → where it files the conversation, and why. */
  const PATTERNS: ReadonlyArray<
    readonly [tool: string, family: string, place: SessionPlace | null, why: string]
  > = [
    [
      "office_create_document",
      "office",
      { subMode: "office", surface: null },
      "the deck is on the Office canvas",
    ],
    ["office_add_many", "office", { subMode: "office", surface: null }, "same document, same surface"],
    [
      "fabric_list_items",
      "fabric",
      { subMode: "fabric", surface: null },
      "reading a project is the Fabric surface",
    ],
    [
      "fabric_create_item",
      "fabric",
      { subMode: "fabric", surface: null },
      "it built an item in the project",
    ],
    [
      "fabric_ask_data_agent",
      "fabric",
      null,
      "the answer is in the thread: Chat → Data agent keeps no transcript, and this built nothing in Fabric",
    ],
    [
      "open_browser_pane",
      "browser",
      { subMode: null, surface: "browser" },
      "a surface with no sub-mode behind it, which is what the Browser is",
    ],
    ["read_browser_page", "browser", { subMode: null, surface: "browser" }, "same"],
    ["browser_click", "browser", { subMode: null, surface: "browser" }, "same"],
    ["knowledge_search", "knowledge", null, "IQ Knowledge is an IQ Cell surface and has no chat pane"],
    ["knowledge_reindex", "knowledge", null, "same"],
    ["workiq_search", "workiq", null, "reading Work IQ is something a conversation does, not somewhere it goes"],
    ["workiq_ask", "workiq", null, "same"],
    ["m365_list_recent_mail", "m365.mail", null, "reading mail moves nothing"],
    ["m365_send_mail", "m365.mail", null, "sending mail has no surface of its own"],
    ["m365_list_calendar", "m365.calendar", null, "same"],
    ["m365_resolve_link", "m365.files", null, "same"],
    ["delegate_tasks", "agent.orchestration", null, "Delegated plans is Control Center: no chat pane"],
    ["plan_status", "agent.orchestration", null, "same"],
    ["propose_skill", "agent.skills", null, "Skills is a canvas tab, and this only proposes"],
    ["remember", "agent.memory", null, "IQ Memories is an IQ Cell surface: no chat pane"],
  ];

  it.each(PATTERNS)("%s (%s) → %o — %s", (tool, family, expected) => {
    expect(placeForTool(tool, family)).toEqual(expected);
  });

  it("only ever places a conversation somewhere it can actually be read", () => {
    for (const [tool, family] of PATTERNS) {
      const place = placeForTool(tool, family);
      if (place === null) continue;
      // Every destination has to hold the thread beside it, or restoring it
      // puts the reader somewhere their own history is not on screen.
      expect(canHoldConversation(place), tool).toBe(true);
      expect(modeForPlace(place), tool).toBe("cocreate");
    }
  });

  /**
   * The three sub-modes the user asked to have checked, each answered on its
   * own terms rather than by assuming they work like Office.
   */
  it("Chat → Data agent is not a place, because it keeps nothing to come back to", () => {
    expect(holdsConversation("dataagent")).toBe(false);
    expect(canHoldConversation({ subMode: "dataagent", surface: null })).toBe(false);
    // Which is the actual fix for the reported symptom: this tool's family is
    // `fabric`, so a family-keyed rule filed every data question under
    // Co-create → Fabric.
    expect(placeForTool("fabric_ask_data_agent", "fabric")).toBeNull();
  });

  it("Co-create → Fabric is a place, and only the two building tools reach it", () => {
    expect(canHoldConversation({ subMode: "fabric", surface: null })).toBe(true);
    expect(placeForTool("fabric_create_item", "fabric")?.subMode).toBe("fabric");
    expect(placeForTool("fabric_list_items", "fabric")?.subMode).toBe("fabric");
  });

  it("Chat → Research is not a place: it owns its input and its history", () => {
    // Research has its own box to type in ("What should the report answer?")
    // and its own list of saved runs, and it replaces the thread the way Team
    // and Data agent do. With no thread beside it there is nothing to restore a
    // conversation into. No governed tool carries anything there either.
    expect(holdsConversation("research")).toBe(false);
    expect(canHoldConversation({ subMode: "research", surface: null })).toBe(false);
    expect(PATTERNS.some(([, family]) => family === "research")).toBe(false);
  });

  it("Co-create → Image Creation is the same shape as Research", () => {
    expect(holdsConversation("image")).toBe(false);
    expect(canHoldConversation({ subMode: "image", surface: null })).toBe(false);
    expect(PATTERNS.some(([, family]) => family === "images")).toBe(false);
  });

  it("Co-create → Skill Recording is the same shape again: buttons, not a thread", () => {
    expect(holdsConversation("record")).toBe(false);
    expect(canHoldConversation({ subMode: "record", surface: null })).toBe(false);
  });

  it("refuses a place naming two different modes", () => {
    // `{conversation, browser}` was the shipped browser placement and it is
    // unshowable: Chat is one pane, so entering it moved the mode to Co-create
    // and landed on whichever Co-create sub-mode happened to be selected — a
    // third place, belonging to nobody, which the shell then recorded over the
    // correct one.
    expect(canHoldConversation({ subMode: "conversation", surface: "browser" })).toBe(false);
    expect(canHoldConversation({ subMode: "office", surface: "browser" })).toBe(true);
    // The Browser said properly: a surface with no sub-mode behind it, which
    // is exactly what it is in the rail.
    expect(canHoldConversation({ subMode: null, surface: "browser" })).toBe(true);
    expect(modeForPlace({ subMode: null, surface: "browser" })).toBe("cocreate");
    // Knowledge opens under IQ Cell, so it cannot pair with a Co-create
    // sub-mode either — and IQ Cell has no chat pane, so it pairs with nothing.
    expect(canHoldConversation({ subMode: "office", surface: "knowledge" })).toBe(false);
    expect(canHoldConversation({ subMode: null, surface: "knowledge" })).toBe(false);
    // Connections and Projects suppress the chat pane outright.
    expect(canHoldConversation({ subMode: null, surface: "connections" })).toBe(false);
    // A place has to name something.
    expect(canHoldConversation({ subMode: null, surface: null })).toBe(false);
  });

  it("refuses to write a place it could not show", async () => {
    const root = mkdtempSync(join(tmpdir(), "iq-place-"));
    try {
      const paths = resolveAppPaths(root);
      await ensureAppPaths(paths);
      const store = new SessionRepo(paths);
      const service = new SessionsService({
        paths,
        sessionRepo: store,
        logger: { warn: () => undefined, info: () => undefined },
        publishIndex: () => undefined,
      } as unknown as SessionsDeps);

      const sessionId = await service.create({ title: "Browsing" });
      await service.setPlace(sessionId, { subMode: "conversation", surface: "browser" }, "work");

      // Nothing written, so nothing to undo later: this log is append-only.
      expect((await store.summary(sessionId))?.placeKnown).toBe(false);
      expect(
        (await store.read(sessionId)).filter((event) => event.type === "place_changed"),
      ).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never lets a navigation record decide, however many there are", async () => {
    const root = mkdtempSync(join(tmpdir(), "iq-rank-"));
    try {
      const paths = resolveAppPaths(root);
      await ensureAppPaths(paths);
      const store = new SessionRepo(paths);
      const service = new SessionsService({
        paths,
        sessionRepo: store,
        logger: { warn: () => undefined, info: () => undefined },
        publishIndex: () => undefined,
      } as unknown as SessionsDeps);

      const sessionId = await service.create({ title: "Deck" });
      await service.setPlace(sessionId, { subMode: "office", surface: null }, "work");
      // The user leaves the deck conversation selected and wanders off. An
      // earlier build wrote one of these per click.
      for (const subMode of ["fabric", "image", "research"] as const) {
        await service.setPlace(sessionId, { subMode, surface: null }, "navigation");
      }

      expect((await store.summary(sessionId))?.place).toEqual({
        subMode: "office",
        surface: null,
      });

      // A later, different piece of work does move it: that claim is as strong
      // as the one it replaces.
      await service.setPlace(sessionId, { subMode: "fabric", surface: null }, "work");
      expect((await store.summary(sessionId))?.place.subMode).toBe("fabric");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not confuse an unrecorded place with the default one", async () => {
    // The two are different questions, and collapsing them makes the one-time
    // backfill impossible: it could not tell which sessions it had already
    // looked at and would re-read every turn log on every launch.
    const root = mkdtempSync(join(tmpdir(), "iq-known-"));
    try {
      const paths = resolveAppPaths(root);
      await ensureAppPaths(paths);
      const store = new SessionRepo(paths);
      const service = new SessionsService({
        paths,
        sessionRepo: store,
        logger: { warn: () => undefined, info: () => undefined },
        publishIndex: () => undefined,
      } as unknown as SessionsDeps);

      const sessionId = await service.create({ title: "Quiet" });
      expect((await store.summary(sessionId))?.placeKnown).toBe(false);

      await service.setPlace(sessionId, DEFAULT_SESSION_PLACE, "work");
      expect((await store.summary(sessionId))?.placeKnown).toBe(true);
      expect((await store.summary(sessionId))?.place).toEqual(DEFAULT_SESSION_PLACE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The defect that made the whole feature look broken.
   *
   * The SDK executes every one of our governed tools as its own "custom-tool"
   * kind, so the permission request that reaches the broker carries
   * `family: "copilot.custom-tool"` for all of them — a deck build and a
   * warehouse query were indistinguishable, and everything landed wherever the
   * last recognisable family had pointed. Only the tool *name* survives, and
   * the registry is keyed on it.
   */
  it("reads the family from the tool name, not from what the SDK calls it", () => {
    const registry = new ToolRegistry(
      { decide: async () => ({ decision: "allow", source: "tenant_policy", reason: "test" }) },
      { record: async () => {} } as never,
    );
    for (const [name, family] of [
      ["office_create_document", "office"],
      ["fabric_ask_data_agent", "fabric"],
      ["workiq_search", "workiq"],
    ] as const) {
      registry.register({
        name,
        family,
        risk: "read",
        description: name,
        parameters: z.object({}),
        summarize: () => name,
        handler: async () => null,
      });
    }

    expect(registry.familyOf("office_create_document")).toBe("office");
    expect(
      placeForTool("office_create_document", registry.familyOf("office_create_document")),
    ).toEqual({ subMode: "office", surface: null });
    // Same family, opposite answer — which is precisely what a family-keyed
    // rule could not express.
    expect(
      placeForTool("fabric_ask_data_agent", registry.familyOf("fabric_ask_data_agent")),
    ).toBeNull();
    expect(placeForTool("workiq_search", registry.familyOf("workiq_search"))).toBeNull();
    // An MCP tool or an SDK built-in is not registered here, so it names no
    // family and must file a conversation nowhere.
    expect(registry.familyOf("copilot.custom-tool")).toBeNull();
    expect(placeForTool("copilot.custom-tool", null)).toBeNull();
  });
});

/**
 * Repairing the conversations an earlier build mis-filed.
 *
 * Not a hypothetical. Both fixtures below are the event sequences taken off a
 * real profile at `~/.iq-compiler/sessions`, and both displayed the wrong tab:
 * a deck conversation that opened on Research, and a browsing conversation
 * that opened on Fabric.
 *
 * The log is append-only, so the bad records cannot be removed — the repair
 * has to outvote them. It works because the fold now counts only `work`
 * records, which makes a session carrying nothing but navigation read as
 * *unplaced*, which is exactly the condition that brings it here.
 */
describe("repairing the places already on disk", () => {
  let root: string;
  let repo: SessionRepo;
  let service: SessionsService;
  let turns: Map<string, Array<{ toolName: string; family: string }>>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "iq-repair-"));
    const paths = resolveAppPaths(root);
    await ensureAppPaths(paths);
    repo = new SessionRepo(paths);
    turns = new Map();
    service = new SessionsService({
      paths,
      sessionRepo: repo,
      logger: { warn: () => undefined, info: () => undefined },
      publishIndex: () => undefined,
      toolRegistry: {
        familyOf: (name: string) =>
          [...turns.values()].flat().find((call) => call.toolName === name)?.family ?? null,
      },
    } as unknown as SessionsDeps);
    // The turns are read through `getTurns`, which folds real turn logs. Here
    // only the tool calls matter, so the fold is stubbed with them.
    Object.defineProperty(service, "getTurns", {
      value: async (sessionId: string) => [{ toolCalls: turns.get(sessionId) ?? [] }],
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const wander = (
    sessionId: string,
    places: ReadonlyArray<[SubMode | null, AppSurface | null]>,
  ): SessionEventList =>
    places.map(([subMode, surface], index) => ({
      type: "place_changed" as const,
      sessionId,
      at: new Date(Date.UTC(2026, 7, 3, 12, index)).toISOString(),
      place: { subMode, surface },
      source: "navigation" as const,
    }));

  it("re-files the deck conversation that opened on Research", async () => {
    const id = "ses_b6c74d29";
    await repo.append(id, [
      {
        type: "session_created",
        sessionId: id,
        at: new Date(Date.UTC(2026, 7, 3, 7, 56)).toISOString(),
        title: "create pptx about Microsoft",
        origin: "interactive",
        parentSessionId: null,
      },
    ]);
    // Verbatim from the profile: nine of them, with the one true answer
    // written seventh and buried by the two that followed.
    await repo.append(
      id,
      wander(id, [
        ["fabric", null],
        ["image", null],
        ["image", "meetings"],
        ["image", "browser"],
        ["research", null],
        ["image", null],
        ["office", null],
        ["fabric", null],
        ["research", null],
      ]),
    );
    // The turn timed out after thirty minutes and its one tool call was denied
    // by default — and the request is still in the log, which is why this
    // works at all. What a conversation set out to do is what it is about.
    turns.set(id, [{ toolName: "office_create_document", family: "office" }]);

    expect((await repo.summary(id))?.place.subMode).not.toBe("office");

    await service.placeExistingConversations();

    expect((await repo.summary(id))?.place).toEqual({ subMode: "office", surface: null });
    expect((await repo.summary(id))?.placeKnown).toBe(true);
  });

  it("re-files the browsing conversation that opened on Fabric", async () => {
    const id = "ses_90976cc6";
    await repo.append(id, [
      {
        type: "session_created",
        sessionId: id,
        at: new Date(Date.UTC(2026, 7, 3, 9, 0)).toISOString(),
        title: "google search - browser",
        origin: "interactive",
        parentSessionId: null,
      },
    ]);
    await repo.append(
      id,
      wander(id, [
        ["conversation", "browser"],
        ["fabric", "browser"],
        ["fabric", null],
        ["image", null],
      ]),
    );
    turns.set(id, [{ toolName: "read_browser_page", family: "browser" }]);

    await service.placeExistingConversations();

    // A surface with no sub-mode behind it, which is what the Browser is. The
    // first record above — `conversation/browser` — was the old attempt at
    // saying this, and it names a mode with no canvas.
    expect((await repo.summary(id))?.place).toEqual({ subMode: null, surface: "browser" });
    expect(canHoldConversation((await repo.summary(id))!.place)).toBe(true);
  });

  it("re-files a conversation chosen for a surface that no longer shows chat", async () => {
    const id = "ses_withdrawn_choice";
    await repo.append(id, [
      {
        type: "session_created",
        sessionId: id,
        at: new Date(Date.UTC(2026, 8, 1, 10, 12)).toISOString(),
        title: "Skill recording",
        origin: "interactive",
        parentSessionId: null,
      },
      {
        type: "place_changed",
        sessionId: id,
        at: new Date(Date.UTC(2026, 8, 1, 10, 12)).toISOString(),
        place: { subMode: "record", surface: null },
        source: "chosen",
      },
    ]);

    const before = await repo.summary(id);
    expect(before?.placeKnown).toBe(false);
    expect(before?.placeChosen).toBe(false);

    await service.placeExistingConversations();

    const repaired = await repo.summary(id);
    expect(repaired?.place).toEqual(DEFAULT_SESSION_PLACE);
    expect(repaired?.placeKnown).toBe(true);
    expect(canHoldConversation(repaired!.place)).toBe(true);
  });

  it("settles, so a second boot re-reads nothing", async () => {
    const id = "ses_quiet";
    await repo.append(id, [
      {
        type: "session_created",
        sessionId: id,
        at: new Date(Date.UTC(2026, 7, 3, 9, 0)).toISOString(),
        title: "Just talking",
        origin: "interactive",
        parentSessionId: null,
      },
    ]);
    await repo.append(id, wander(id, [["research", null]]));

    // No placeable work, so the derived answer is the default — and it is
    // written anyway, because "belongs on the thread" and "nobody has worked
    // it out yet" have to be distinguishable or this runs forever.
    await service.placeExistingConversations();
    expect((await repo.summary(id))?.place).toEqual(DEFAULT_SESSION_PLACE);
    expect((await repo.summary(id))?.placeKnown).toBe(true);

    const before = (await repo.read(id)).length;
    await service.placeExistingConversations();
    expect((await repo.read(id)).length).toBe(before);
  });
});

/** The event shape `SessionRepo.append` takes, without importing the union. */
type SessionEventList = Parameters<SessionRepo["append"]>[1];

/**
 * Sweeping unreachable conversation data.
 *
 * This deletes files, so what it must never do matters more than what it does.
 * A conversation the user emptied on purpose reads as having no turns and is
 * kept; the conversation on screen is kept however empty it is; a turn log
 * younger than the grace period is kept, because a turn is written before the
 * session records it and for that moment every live turn looks orphaned.
 */
describe("session sweep", () => {
  let root: string;
  let repo: SessionRepo;
  let turnRepo: TurnRepo;
  let turnsDir: string;
  let service: SessionsService;
  /** How often the rail was told to redraw. */
  let publishes: number;

  /** Well past the settle window, so these fixtures are judged, not skipped. */
  const at = (minute: number): string =>
    new Date(Date.UTC(2026, 6, 13, 8, minute, 0)).toISOString();

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "iq-sweep-"));
    const paths = resolveAppPaths(root);
    await ensureAppPaths(paths);
    turnsDir = paths.turns;
    repo = new SessionRepo(paths);
    turnRepo = new TurnRepo(paths);
    publishes = 0;
    service = new SessionsService({
      paths,
      sessionRepo: repo,
      turnRepo,
      runtime: { deleteSession: async () => undefined },
      logger: { warn: () => undefined, info: () => undefined },
      publishIndex: () => {
        publishes += 1;
      },
    } as unknown as SessionsDeps);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const born = (
    id: string,
    origin: "interactive" | "scheduled" | "sub_agent",
    parentSessionId: string | null = null,
  ): SessionEventList => [
    { type: "session_created", sessionId: id, at: at(0), title: "Thread", origin, parentSessionId },
  ];

  /** A turn log on disk, optionally backdated past the one-hour grace period. */
  const turnLog = (turnId: string, old: boolean): void => {
    const file = join(turnsDir, `${turnId}.jsonl`);
    writeFileSync(file, "");
    if (old) {
      const when = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(file, when, when);
    }
  };

  /** Put a turn in flight — what `run()` does and a test has no model for. */
  const running = (target: SessionsService, turnId: string, sessionId: string): void => {
    (target as unknown as { active: Map<string, { sessionId: string }> }).active.set(turnId, {
      sessionId,
    });
  };

  it("redraws the rail once, however much it removes", async () => {
    // Publishing folds every session log again. Doing it per deletion is what
    // turned a sweep of 74 conversations into a wait with no end in sight.
    for (let index = 0; index < 12; index++) {
      await repo.append(`gone${index}`, born(`gone${index}`, "sub_agent"));
    }

    const swept = await service.sweep({ apply: true });

    expect(swept.abandonedRuns).toBe(12);
    expect(publishes).toBe(1);
  });

  it("does not redraw the rail for a preview", async () => {
    await repo.append("gone", born("gone", "sub_agent"));

    await service.sweep({ apply: false });

    expect(publishes).toBe(0);
  });

  it("counts without touching anything when it is only asked", async () => {
    await repo.append("empty", born("empty", "interactive"));
    turnLog("orphan", true);

    const preview = await service.sweep({ apply: false });

    expect(preview.emptySessions).toBe(1);
    expect(preview.orphanTurns).toBe(1);
    expect((await repo.list()).map((session) => session.id)).toEqual(["empty"]);
    expect(existsSync(join(turnsDir, "orphan.jsonl"))).toBe(true);
  });

  it("removes a conversation that never held a turn", async () => {
    await repo.append("empty", born("empty", "interactive"));

    const swept = await service.sweep({ apply: true });

    expect(swept.emptySessions).toBe(1);
    expect(await repo.list()).toEqual([]);
  });

  it("keeps a conversation the user emptied on purpose", async () => {
    await repo.append("cleared", [
      ...born("cleared", "interactive"),
      { type: "turn_appended", sessionId: "cleared", at: at(1), turnId: "t1" },
      { type: "history_cleared", sessionId: "cleared", at: at(2) },
    ]);

    const swept = await service.sweep({ apply: true });

    // The fold reports no turns, which is exactly what an abandoned thread
    // looks like. The log is what tells them apart.
    expect((await repo.summary("cleared"))?.turnCount).toBe(0);
    expect(swept.emptySessions).toBe(0);
    expect((await repo.list()).map((session) => session.id)).toEqual(["cleared"]);
  });

  it("keeps the conversation on screen, empty or not", async () => {
    await repo.append("open", born("open", "interactive"));

    const swept = await service.sweep({ apply: true, keepSessionId: "open" });

    expect(swept.emptySessions).toBe(0);
    expect((await repo.list()).map((session) => session.id)).toEqual(["open"]);
  });

  it("removes a sub-agent session no conversation can open, and no other", async () => {
    await repo.append("parent", [
      ...born("parent", "interactive"),
      { type: "turn_appended", sessionId: "parent", at: at(1), turnId: "t1" },
    ]);
    await repo.append("child", born("child", "sub_agent", "parent"));
    await repo.append("grandchild", born("grandchild", "sub_agent", "child"));
    await repo.append("stray", born("stray", "sub_agent", "deleted-long-ago"));

    const swept = await service.sweep({ apply: true });

    expect(swept.abandonedRuns).toBe(1);
    expect((await repo.list()).map((session) => session.id).sort()).toEqual([
      "child",
      "grandchild",
      "parent",
    ]);
  });

  it("removes a run that recorded no parent at all", async () => {
    // What research and delegated runs actually write. The link is null, not
    // missing, so nothing has ever been able to reach these.
    await repo.append("root", [
      ...born("root", "sub_agent"),
      { type: "turn_appended", sessionId: "root", at: at(1), turnId: "t1" },
    ]);
    await repo.append("under", born("under", "sub_agent", "root"));

    const swept = await service.sweep({ apply: true });

    expect(swept.abandonedRuns).toBe(2);
    expect(await repo.list()).toEqual([]);
  });

  it("leaves a scheduled conversation alone — the rail lists those", async () => {
    await repo.append("nightly", born("nightly", "scheduled"));
    await repo.append("worker", born("worker", "sub_agent", "nightly"));

    const swept = await service.sweep({ apply: true });

    expect(swept.emptySessions).toBe(0);
    expect(swept.abandonedRuns).toBe(0);
    expect((await repo.list()).map((session) => session.id).sort()).toEqual(["nightly", "worker"]);
  });

  it("does not judge work from the last hour", async () => {
    await repo.append("running", born("running", "sub_agent"));
    await repo.append("running", [
      { type: "turn_appended", sessionId: "running", at: new Date().toISOString(), turnId: "now" },
    ]);

    const swept = await service.sweep({ apply: true });

    expect(swept.abandonedRuns).toBe(0);
    expect((await repo.list()).map((session) => session.id)).toEqual(["running"]);
  });

  it("spares a running turn's session and everything it hangs off", async () => {
    // A turn is recorded when it starts, so a long research run looks exactly
    // as old as one abandoned an hour ago. Only the live turn says otherwise.
    await repo.append("root", born("root", "sub_agent"));
    await repo.append("worker", [
      ...born("worker", "sub_agent", "root"),
      { type: "turn_appended", sessionId: "worker", at: at(1), turnId: "slow" },
    ]);
    await repo.append("idle", born("idle", "sub_agent"));
    running(service, "slow", "worker");

    const swept = await service.sweep({ apply: true });

    expect(swept.abandonedRuns).toBe(1);
    expect((await repo.list()).map((session) => session.id).sort()).toEqual(["root", "worker"]);
  });

  it("removes turn logs nothing refers to, but spares the ones just written", async () => {
    await repo.append("live", [
      ...born("live", "interactive"),
      { type: "turn_appended", sessionId: "live", at: at(1), turnId: "kept" },
    ]);
    turnLog("kept", true);
    turnLog("orphan", true);
    turnLog("starting", false);

    const swept = await service.sweep({ apply: true });

    expect(swept.orphanTurns).toBe(1);
    expect(existsSync(join(turnsDir, "kept.jsonl"))).toBe(true);
    expect(existsSync(join(turnsDir, "starting.jsonl"))).toBe(true);
    expect(existsSync(join(turnsDir, "orphan.jsonl"))).toBe(false);
  });

  it("counts a doomed conversation's turns with the conversation, not twice", async () => {
    await repo.append("gone", [
      ...born("gone", "sub_agent", "deleted-long-ago"),
      { type: "turn_appended", sessionId: "gone", at: at(1), turnId: "owned" },
    ]);
    turnLog("owned", true);

    const preview = await service.sweep({ apply: false });
    expect(preview.abandonedRuns).toBe(1);
    expect(preview.orphanTurns).toBe(0);

    const swept = await service.sweep({ apply: true });
    expect(swept.abandonedRuns).toBe(1);
    expect(swept.orphanTurns).toBe(0);
    expect(existsSync(join(turnsDir, "owned.jsonl"))).toBe(false);
  });
});
