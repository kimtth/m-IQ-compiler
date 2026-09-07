import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canRemember, reduceTurn } from "@iq/shared";
import type { PermissionOutcome, PermissionRequest, TurnEvent } from "@iq/shared";
import { cardsFor, EMPTY_LOG, record } from "../apps/renderer/src/approvals.js";
import { TurnRepo } from "../packages/core/src/runtime/turns/fs-repo.js";
import { SessionsService } from "../packages/core/src/runtime/sessions/sessions.js";
import type { SessionsDeps } from "../packages/core/src/runtime/sessions/sessions.js";
import { ToolRegistry } from "../packages/core/src/runtime/tools/registry.js";
import { ensureAppPaths, resolveAppPaths } from "../packages/core/src/config/paths.js";
import { PermissionPolicy, newSessionRules } from "../packages/core/src/policy/permission-policy.js";
import { DEFAULT_TENANT_POLICY } from "../packages/core/src/policy/tenant-policy.js";
import type { ToolContext } from "../packages/core/src/runtime/tools/registry.js";

/**
 * The approval broker's session rules.
 *
 * Two defects are pinned here, both of which the user saw as "even after
 * approving for the conversation, every following step asks again":
 *   1. `requireApprovalForWrites` defaulted to `true`, and it outranks the
 *      session allow rule, so the rule was unreachable on a stock install.
 *   2. Sibling requests raised before the answer stayed queued on their own
 *      promises and were never re-evaluated against the new rule.
 */

const request = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  toolCallId: "call-1",
  toolName: "office_add_content",
  family: "office",
  risk: "write",
  summary: "Add slide to Deck.pptx",
  requiredScopes: [],
  resources: ["Deck.pptx"],
  ...over,
});

describe("approval session rules", () => {
  let root: string;
  let service: SessionsService;
  let turnRepo: TurnRepo;
  /** Everything the service pushed to the UI, in delivery order. */
  let published: TurnEvent[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "iq-approvals-"));
    const paths = resolveAppPaths(root);
    await ensureAppPaths(paths);
    turnRepo = new TurnRepo(paths);
    published = [];
    const deps = {
      paths,
      turnRepo,
      // `decide` asks who can answer a card before it queues one, and the
      // answer lives in the session log: only an `interactive` session is
      // listed in the rail, so only it can render an approval at all.
      sessionRepo: { summary: async () => ({ id: "session-1", origin: "interactive" }) },
      runtime: { primeSequence: () => undefined },
      // Every permission request also files the conversation by the work it
      // does, which reads the family off the tool name. Nothing here registers
      // a tool, so nothing is filed — which is the point: placement must not
      // be able to break an approval.
      toolRegistry: new ToolRegistry(
        { decide: async () => ({ decision: "allow", source: "tenant_policy", reason: "test" }) },
        { record: async () => {} } as never,
      ),
      policy: new PermissionPolicy(DEFAULT_TENANT_POLICY),
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      publish: (event: TurnEvent) => {
        published.push(event);
      },
    } as unknown as SessionsDeps;
    service = new SessionsService(deps);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const context = (turnId: string): ToolContext =>
    ({ turnId, sessionId: "session-1", correlationId: "corr-1" }) as unknown as ToolContext;

  /**
   * `decide` writes two events before it queues, so a microtask flush is not
   * enough to know the request is on screen. Wait on the event the UI would see
   * rather than on a delay — the appends are serialised per turn now, so a
   * fixed sleep is a race on a slow disk.
   */
  const queued = async (count = 1): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const suspended = published.filter((event) => event.type === "turn_suspended").length;
      if (suspended >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`only ${published.length} events published; expected ${count} suspensions`);
  };

  it("is not gated by an approval floor out of the box", () => {
    // The floor makes the session allow rule unreachable, so defaulting it on
    // makes "Allow for this conversation" a control that can never do anything.
    expect(DEFAULT_TENANT_POLICY.requireApprovalForWrites).toBe(false);
  });

  it("refuses an answer that names a different turn than the card came from", async () => {
    // The turn is part of the claim an answer makes. It was taken on faith:
    // present in the signature, in the IPC schema and in the log line, and
    // checked nowhere, so any turn id settled any pending call.
    const pending = service.decide(request(), context("turn-1"));
    await queued(1);

    await service.respondToPermission("turn-other", "call-1", "allow");

    let answered = false;
    void pending.then(() => {
      answered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).toBe(false);

    // The real turn still settles it.
    await service.respondToPermission("turn-1", "call-1", "allow");
    expect((await pending).decision).toBe("allow");
  });

  it("settles approvals already queued when the rule is made", async () => {
    const settled: PermissionOutcome[] = [];
    const raise = (id: string): Promise<PermissionOutcome> =>
      service
        .decide(request({ toolCallId: id }), context(`turn-${id}`))
        .then((outcome) => {
          settled.push(outcome);
          return outcome;
        });

    // Six slides are six tool calls raised together, before any is answered.
    const calls = ["call-1", "call-2", "call-3"].map(raise);
    await queued(3);
    expect(settled).toHaveLength(0);

    await service.respondToPermission("turn-call-1", "call-1", "allow_always");
    const outcomes = await Promise.all(calls);

    expect(outcomes.map((outcome) => outcome.decision)).toEqual(["allow_always", "allow", "allow"]);
    expect(outcomes[1]?.source).toBe("user_rule");
  });

  it("leaves irreversible siblings on screen", async () => {
    const write = service.decide(request(), context("turn-1"));
    const destroy = service.decide(
      request({ toolCallId: "call-2", toolName: "office_delete_content", risk: "destructive" }),
      context("turn-2"),
    );
    await queued(2);

    await service.respondToPermission("turn-1", "call-1", "allow_always");
    expect((await write).decision).toBe("allow_always");

    // A destructive call is never remembered, so it must still be waiting.
    let answered = false;
    void destroy.then(() => {
      answered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).toBe(false);

    await service.respondToPermission("turn-2", "call-2", "deny");
    expect((await destroy).decision).toBe("deny");
  });

  /**
   * The bug behind "sometimes the approval dialog does not respond".
   *
   * `appendEvent` allocated a sequence number by reading the turn log and
   * adding one — a read-modify-write with nothing serialising it. Settling a
   * batch resolves every queued promise in one loop, so each waiter's
   * `tool_permission_settled` was written in the same tick, off the same read,
   * with the same `seq`.
   *
   * The renderer keys live events by `seq` so a duplicate delivery cannot
   * double-append, which means of two events sharing a number it keeps one and
   * drops the rest. The dropped ones were the settlements: the tool ran, the
   * click had worked, and the card stayed on screen with nothing left that
   * could ever remove it.
   *
   * One turn, several calls, is the shape that matters — a six-slide deck is
   * six `office_add_content` calls inside a single turn.
   */
  it("gives every settled approval its own sequence number", async () => {
    const ids = ["call-1", "call-2", "call-3", "call-4"];
    const calls = ids.map((id) =>
      service.decide(request({ toolCallId: id }), context("turn-1")),
    );
    await queued(ids.length);

    await service.respondToPermission("turn-1", "call-1", "allow_always");
    await Promise.all(calls);

    const settled = published.filter((event) => event.type === "tool_permission_settled");
    expect(settled).toHaveLength(ids.length);
    expect(new Set(settled.map((event) => event.seq)).size).toBe(ids.length);
  });

  it("leaves no approval card behind, replayed the way the UI replays them", async () => {
    // The assertion the user would make: after answering once, is the card gone?
    // Replayed through the approval queue itself — not a copy of its rule —
    // because the queue's de-duplication is where the collision did its damage.
    // Duplicating that rule into a test was the clearest sign it belonged in a
    // module of its own.
    const ids = ["call-1", "call-2", "call-3", "call-4"];
    const calls = ids.map((id) =>
      service.decide(request({ toolCallId: id }), context("turn-1")),
    );
    await queued(ids.length);
    await service.respondToPermission("turn-1", "call-1", "allow_always");
    await Promise.all(calls);

    let log = EMPTY_LOG;
    for (const event of published) log = record(log, event);
    const delivered = [...(log.byTurn.get("turn-1") ?? [])];

    expect(reduceTurn(delivered).pendingApprovals).toEqual([]);
  });

  /**
   * A request that decides to ask *before* the rule is made, but reaches the
   * queue after the sweep has run, must still be settled by it.
   *
   * Policy is evaluated at the top of `decide`, and three durable appends sit
   * between there and the queue. On a slow disk that gap is wide enough for the
   * user to answer, so the request parked on an already-swept queue and asked
   * for an answer that had just been given.
   */
  it("honours a rule made while the request was still being written down", async () => {
    const first = service.decide(request(), context("turn-1"));
    await queued(1);
    await service.respondToPermission("turn-1", "call-1", "allow_always");
    expect((await first).decision).toBe("allow_always");

    // Raised entirely after the rule exists, which is what a late arrival looks
    // like from the broker's side.
    const late = await service.decide(request({ toolCallId: "call-2" }), context("turn-1"));
    expect(late.decision).toBe("allow");
    expect(late.source).toBe("user_rule");
  });

  /**
   * The card must not offer a rule the policy will throw away.
   *
   * `external` and `destructive` calls are re-confirmed every time. The card
   * offered "Allow for this conversation" on all of them anyway, so choosing it
   * on a web fetch allowed that one call, remembered nothing, and asked again
   * on the next one — a button that looked like it had done something.
   *
   * Both sides now read `canRemember`, and this pins them together: what the
   * card is willing to offer, and what the policy is willing to keep.
   */
  it("only offers an always-rule where the policy would keep one", async () => {
    const rules = newSessionRules();
    const policy = new PermissionPolicy(DEFAULT_TENANT_POLICY);

    for (const risk of ["read", "write", "external", "destructive"] as const) {
      const asked = request({ risk });
      policy.remember(asked, "allow_always", rules);
      const kept = rules.allowAlways.has(`${asked.family}:${asked.toolName}`);
      expect(canRemember(risk), `card offers "always" for ${risk}`).toBe(kept);
      rules.allowAlways.clear();
    }
  });

  /**
   * And the card can tell which is which: `risk` survives grouping.
   *
   * It is exact rather than a guess — the group key is family plus tool name,
   * so every member is the same tool at the same risk.
   */
  it("carries the risk from the request through to the card", async () => {
    const fetching = service.decide(
      request({ toolCallId: "call-1", toolName: "fetch_url", family: "copilot.url", risk: "external" }),
      context("turn-1"),
    );
    await queued(1);

    let log = EMPTY_LOG;
    for (const event of published) log = record(log, event);
    const [card] = cardsFor([reduceTurn([...(log.byTurn.get("turn-1") ?? [])])], "ask");

    expect(card?.risk).toBe("external");
    expect(canRemember(card!.risk)).toBe(false);

    await service.respondToPermission("turn-1", "call-1", "deny");
    await fetching;
  });
});

/**
 * The deadlock behind "research runs forever and opens 70 Copilot sessions".
 *
 * A `sub_agent` session is deliberately absent from the rail, so no approval
 * card is ever drawn for it. `decide` did not know that: an "ask" joined
 * `pending` and waited for a click that could not happen, the SDK's wall clock
 * killed the turn thirty minutes later, and the Coordinator retried it once —
 * a fresh session, another thirty minutes, still nothing. Seven questions cost
 * an afternoon and produced no findings.
 *
 * The measured first move of a real gathering sub-agent was `Fetch URL`, at
 * risk `external`, which is never remembered and therefore always asks. So the
 * two halves are pinned together: an unattended run never waits, and a granted
 * family is why it has anything left to do.
 */
describe("approvals in a session nobody is watching", () => {
  let root: string;
  let service: SessionsService;

  const build = (): SessionsService => {
    const paths = resolveAppPaths(root);
    /** Enough of the session log to answer "who, if anyone, is watching this?". */
    const origins = new Map<string, string>([["session-1", "sub_agent"]]);
    return new SessionsService({
      paths,
      turnRepo: new TurnRepo(paths),
      sessionRepo: {
        append: async (sessionId: string, events: Array<{ origin?: string }>) => {
          const created = events.find((event) => event.origin);
          if (created?.origin) origins.set(sessionId, created.origin);
        },
        summary: async (sessionId: string) => ({
          id: sessionId,
          origin: origins.get(sessionId) ?? "sub_agent",
        }),
        list: async () => [],
      },
      runtime: { primeSequence: () => undefined },
      toolRegistry: new ToolRegistry(
        { decide: async () => ({ decision: "allow", source: "tenant_policy", reason: "test" }) },
        { record: async () => {} } as never,
      ),
      policy: new PermissionPolicy(DEFAULT_TENANT_POLICY),
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      publish: () => undefined,
      publishIndex: () => undefined,
    } as unknown as SessionsDeps);
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "iq-delegated-"));
    await ensureAppPaths(resolveAppPaths(root));
    service = build();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const fetch = request({
    toolCallId: "call-1",
    toolName: "copilot.url",
    family: "copilot.url",
    risk: "external",
    summary: "Fetch URL https://learn.microsoft.com/",
  });
  const context = { turnId: "turn-1", sessionId: "session-1", correlationId: "corr-1" } as never;

  it("refuses at once rather than waiting for a card nobody will see", async () => {
    // No `queued()` here on purpose: the promise has to settle on its own, and
    // the old behaviour was for it never to settle at all.
    const outcome = await service.decide(fetch, context);
    expect(outcome.decision).toBe("deny");
    expect(outcome.reason).toContain("nobody to ask");
  });

  it("allows the same call once the run's grant names its family", async () => {
    const sessionId = await service.create({
      title: "Sub-agent: what is Microsoft Sovereign Cloud?",
      origin: "sub_agent",
      grant: { families: ["browser", "copilot.url"], ceiling: "external" },
    });

    const outcome = await service.decide(fetch, {
      turnId: "turn-2",
      sessionId,
      correlationId: "corr-1",
    } as never);
    expect(outcome.decision).toBe("allow");
    expect(outcome.source).toBe("delegation");
  });

  it("still refuses a family the grant does not name, without waiting", async () => {
    const sessionId = await service.create({
      title: "Sub-agent: gather",
      origin: "sub_agent",
      grant: { families: ["knowledge"], ceiling: "external" },
    });

    const outcome = await service.decide(fetch, {
      turnId: "turn-3",
      sessionId,
      correlationId: "corr-1",
    } as never);
    expect(outcome.decision).toBe("deny");
  });

  it("gives an interactive conversation no grant, so the user is still asked", async () => {
    const sessionId = await service.create({
      title: "Conversation",
      grant: { families: ["copilot.url"], ceiling: "external" },
    });

    let settled = false;
    void service.decide(fetch, {
      turnId: "turn-4",
      sessionId,
      correlationId: "corr-1",
    } as never).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Pre-authorising someone who is present would be taking a decision they
    // are there to make.
    expect(settled).toBe(false);
  });
});
