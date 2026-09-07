import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BETA_MODES,
  MODE_LABELS,
  MyIqSnapshot,
  SUB_MODES,
  SUB_MODES_BY_MODE,
  defaultSubMode,
} from "@iq/shared";
import {
  SHARED_IQS,
  SHARED_IQ_TOOLS,
  findSharedIqs,
  sharedIqAsk,
  sharedIqChatPrompt,
  sharedIqClientConfig,
  sharedIqServerId,
  sharedIqSuggestions,
  sharedIqToolResult,
  sharedIqTopics,
} from "../apps/renderer/src/samples/sharedIq.js";

/**
 * Connectome IQ — the hub of shared My IQs.
 *
 * Four things are worth pinning and the rest is rendering. **Where the surface
 * sits**, because a destination the rail does not offer is unreachable however
 * good it is. **What its tool console answers**, because the surface's claim is
 * that it shows a real tool result rather than a paraphrase, and a paraphrase
 * that drifted would teach the reader something false. **How the picker is
 * searched**, because five fixture rows stand in for a tenant's worth of
 * people, and a search that only works at five is demonstrating nothing. And
 * **that the sample snapshots parse**, because their whole purpose is to be
 * droppable into an `IQ_HOME` — a file the server refuses is a file that
 * demonstrates nothing.
 */

describe("Connectome IQ — where it sits", () => {
  it("is a top-level mode, tagged beta", () => {
    expect(MODE_LABELS.hub).toBe("Connectome IQ");
    expect(BETA_MODES).toContain("hub");
    expect(SUB_MODES.hub.mode).toBe("hub");
    expect(SUB_MODES.hub.label).toBe("Connectome IQ");
    expect(SUB_MODES.hub.beta).toBe(true);
    // No project is needed. The hub reads published snapshots and fixtures,
    // neither of which is bound to a directory.
    expect(SUB_MODES.hub.requiresProject).toBe(false);
  });

  it("owns its mode outright and has left IQ Cell", () => {
    // One mode, one destination, and it is the one the segment lands on. A
    // mode whose default sub-mode belonged to another mode used to bounce the
    // switch straight back and make the destination unreachable.
    expect(SUB_MODES_BY_MODE.hub).toEqual(["hub"]);
    expect(defaultSubMode("hub")).toBe("hub");
    expect(SUB_MODES_BY_MODE.flow).not.toContain("hub");
  });

  it("keeps My IQ's own label short", () => {
    // The two names have to be told apart at a glance in a 248px rail, which
    // is what "My IQ (Connectome)" stopped being once a second surface carried
    // the word.
    expect(SUB_MODES.connectome.label).toBe("My IQ");
    expect(SUB_MODES.connectome.label).not.toContain("Connectome");
  });
});

describe("Connectome IQ — the shared IQ fixtures", () => {
  it("gives every IQ a distinct id, name and analysis hash", () => {
    const unique = (values: string[]): number => new Set(values).size;
    expect(unique(SHARED_IQS.map((iq) => iq.id))).toBe(SHARED_IQS.length);
    expect(unique(SHARED_IQS.map((iq) => iq.name))).toBe(SHARED_IQS.length);
    // Two IQs sharing a hash would read as the same analysis of the same
    // library, which is the one thing the hash is there to rule out.
    expect(unique(SHARED_IQS.map((iq) => iq.hash))).toBe(SHARED_IQS.length);
  });

  it("never separates a finding from the limits that qualify it", () => {
    for (const iq of SHARED_IQS) {
      expect(iq.findings.length).toBeGreaterThan(0);
      expect(iq.limits.length).toBeGreaterThan(0);
    }
  });

  it("points each client configuration at that person's home, not yours", () => {
    for (const iq of SHARED_IQS) {
      const config = JSON.parse(sharedIqClientConfig([iq])) as {
        servers: Record<string, { type: string; command: string; env: { IQ_HOME: string } }>;
      };
      const server = Object.values(config.servers)[0];
      expect(server?.type).toBe("stdio");
      expect(server?.command).toBe("node");
      expect(server?.env.IQ_HOME).toContain(iq.owner);
    }
  });

  // The point of serving an IQ over MCP is that a client holds many servers at
  // once. If the configuration collapsed several IQs into one entry, or reused
  // a key, connecting to the second would silently replace the first.
  it("gives every connected IQ a server of its own", () => {
    const config = JSON.parse(sharedIqClientConfig(SHARED_IQS)) as {
      servers: Record<string, { env: { IQ_HOME: string } }>;
    };
    const keys = Object.keys(config.servers);
    expect(keys).toHaveLength(SHARED_IQS.length);
    expect(new Set(keys).size).toBe(SHARED_IQS.length);
    for (const iq of SHARED_IQS) {
      const server = config.servers[sharedIqServerId(iq)];
      expect(server?.env.IQ_HOME).toContain(iq.owner);
    }
  });

  it("connects to nothing when nothing is connected", () => {
    const config = JSON.parse(sharedIqClientConfig([])) as { servers: Record<string, unknown> };
    expect(Object.keys(config.servers)).toHaveLength(0);
    expect(sharedIqChatPrompt([], "anything")).toBe("");
    expect(sharedIqSuggestions([])).toEqual([]);
  });
});

/**
 * Finding an IQ.
 *
 * The picker is five rows here and a tenant's worth of people in the thing it
 * demonstrates, so the search has to hold up at a size the fixtures never
 * reach. What is worth pinning is the behaviour a reader would notice
 * immediately if it broke: that the words they type narrow rather than widen,
 * that the box reaches the fields the card actually shows, that the rows stay
 * where they were, and that the topic list is the directory's own.
 */
describe("Connectome IQ — finding an IQ", () => {
  it("offers every topic the directory carries, once each, in order", () => {
    const topics = sharedIqTopics(SHARED_IQS);
    expect(new Set(topics).size).toBe(topics.length);
    expect([...topics].sort((left, right) => left.localeCompare(right))).toEqual(topics);
    // Offered and reachable are different claims. A topic in the list that no
    // IQ carries is a control that returns nothing and blames the reader.
    for (const topic of topics) {
      expect(findSharedIqs(SHARED_IQS, { term: "", topic }).length).toBeGreaterThan(0);
    }
    for (const iq of SHARED_IQS) {
      for (const topic of iq.topics) expect(topics).toContain(topic);
    }
  });

  it("shows the whole directory when nothing has been asked for", () => {
    expect(findSharedIqs(SHARED_IQS, { term: "", topic: "" })).toEqual([...SHARED_IQS]);
    // Whitespace is not a query. A held-down space bar should not empty the
    // picker.
    expect(findSharedIqs(SHARED_IQS, { term: "   ", topic: "" })).toEqual([...SHARED_IQS]);
  });

  it("finds an IQ by its owner, its team and what one of its cells does", () => {
    const projects = SHARED_IQS.find((iq) => iq.id === "shared_projects")!;
    expect(findSharedIqs(SHARED_IQS, { term: "dana", topic: "" })).toContain(projects);
    expect(findSharedIqs(SHARED_IQS, { term: projects.team, topic: "" })).toContain(projects);
    expect(findSharedIqs(SHARED_IQS, { term: "leadership", topic: "" })).toContain(projects);
    // Typed as it would be typed, not as it is stored.
    expect(findSharedIqs(SHARED_IQS, { term: "DANA OKAFOR", topic: "" })).toContain(projects);
  });

  it("narrows with every extra word rather than widening", () => {
    const one = findSharedIqs(SHARED_IQS, { term: "the", topic: "" });
    const two = findSharedIqs(SHARED_IQS, { term: "the dana", topic: "" });
    expect(one.length).toBeGreaterThan(two.length);
    for (const iq of two) expect(one).toContain(iq);
    // ORed, this would return everything the first word matched.
    expect(findSharedIqs(SHARED_IQS, { term: "dana zzzz", topic: "" })).toEqual([]);
  });

  it("returns nothing rather than something close", () => {
    expect(findSharedIqs(SHARED_IQS, { term: "quantum", topic: "" })).toEqual([]);
  });

  it("keeps the directory's order, so a row does not move while you type", () => {
    const found = findSharedIqs(SHARED_IQS, { term: "the", topic: "" });
    const expected = SHARED_IQS.filter((iq) => found.includes(iq));
    expect(found).toEqual([...expected]);
  });

  it("applies the topic and the words together, not one or the other", () => {
    const support = SHARED_IQS.find((iq) => iq.id === "shared_support")!;
    const topic = support.topics[0]!;
    expect(findSharedIqs(SHARED_IQS, { term: support.owner, topic })).toEqual([support]);
    // The words match this IQ and the topic does not. Both have to hold.
    const other = sharedIqTopics(SHARED_IQS).find((name) => !support.topics.includes(name))!;
    expect(findSharedIqs(SHARED_IQS, { term: support.owner, topic: other })).toEqual([]);
  });

  it("finds nothing in an empty directory instead of failing", () => {
    expect(findSharedIqs([], { term: "dana", topic: "" })).toEqual([]);
    expect(sharedIqTopics([])).toEqual([]);
  });
});

describe("Connectome IQ — the tool console", () => {
  const iq = SHARED_IQS[0]!;

  it("says every answer is sample data", () => {
    for (const tool of SHARED_IQ_TOOLS) {
      const argument = tool === "myiq_get_cell" ? iq.cells[0]!.name : "update";
      expect(sharedIqToolResult(iq, tool, argument)).toContain("Sample data");
    }
  });

  it("names the IQ when listing its cells", () => {
    const answer = sharedIqToolResult(iq, "myiq_list_cells", "");
    expect(answer).toContain(`${iq.name} — ${iq.cells.length} IQ Cells`);
    for (const cell of iq.cells) expect(answer).toContain(cell.name);
  });

  it("reports a cell's runs, reach and approver", () => {
    const cell = iq.cells[0]!;
    const answer = sharedIqToolResult(iq, "myiq_get_cell", cell.name);
    expect(answer).toContain(`version ${cell.version}`);
    expect(answer).toContain(cell.reach[0]!);
    expect(answer).toContain(cell.approver);
  });

  it("refuses to guess when nothing matches", () => {
    // A tool that answered anyway would be inventing somebody's work, which is
    // exactly the failure the whole surface is careful about.
    const answer = sharedIqToolResult(iq, "myiq_get_cell", "nothing by this name");
    expect(answer).toContain("No published IQ Cell matches");
    expect(answer).toContain("myiq_list_cells");
  });

  it("asks for an argument rather than answering an empty one", () => {
    expect(sharedIqToolResult(iq, "myiq_get_cell", "  ")).toBe("Name an IQ Cell by id or name.");
    expect(sharedIqToolResult(iq, "myiq_search_knowledge", "")).toBe("Give a query to search for.");
  });

  it("matches notes on every word, not any word", () => {
    const answer = sharedIqToolResult(iq, "myiq_search_knowledge", "weekly update");
    expect(answer).toContain("How the weekly update is written");
    expect(answer).not.toContain("What counts as a date at risk");
  });

  it("hands over the findings and the limits together", () => {
    const answer = sharedIqToolResult(iq, "myiq_connectome_summary", "");
    expect(answer).toContain(`Analysis ${iq.hash}`);
    expect(answer).toContain(iq.findings[0]!.title);
    expect(answer).toContain("What this analysis could not see");
    expect(answer).toContain(iq.limits[0]!);
  });
});

/**
 * Asking in your own words.
 *
 * The console lets a reader type a question instead of picking one of five
 * tool names. That routing is a keyword match with no model behind it, so the
 * only thing worth pinning is that it lands on the right tool for the obvious
 * questions and falls back to the cheapest answer rather than guessing.
 */
describe("Connectome IQ — routing a question to a tool", () => {
  const iq = SHARED_IQS[0]!;

  it("sends a question about conventions to the memories", () => {
    expect(sharedIqAsk(iq, "What conventions does it follow?").tool).toBe("myiq_list_memories");
    expect(sharedIqAsk(iq, "any rules I should know").tool).toBe("myiq_list_memories");
  });

  it("sends a question about the analysis to the summary", () => {
    expect(sharedIqAsk(iq, "What did the analysis find?").tool).toBe("myiq_connectome_summary");
    expect(sharedIqAsk(iq, "what could it not see").tool).toBe("myiq_connectome_summary");
  });

  it("opens the cell a question names", () => {
    const cell = iq.cells[0]!;
    const routed = sharedIqAsk(iq, `What does "${cell.name}" do?`);
    expect(routed.tool).toBe("myiq_get_cell");
    expect(routed.argument).toBe(cell.name);
    // And the answer really is that cell, not a near miss.
    expect(sharedIqToolResult(iq, routed.tool, routed.argument)).toContain(cell.name);
  });

  it("searches the notes for the subject, not for the word 'notes'", () => {
    const routed = sharedIqAsk(iq, "do the notes say anything about scheduling");
    expect(routed.tool).toBe("myiq_search_knowledge");
    expect(routed.argument).toBe("scheduling");
  });

  it("falls back to the list rather than guessing", () => {
    // Nothing to go on is not a licence to answer something else. The list is
    // the one answer that is true whatever was meant.
    expect(sharedIqAsk(iq, "hello").tool).toBe("myiq_list_cells");
    expect(sharedIqAsk(iq, "").tool).toBe("myiq_list_cells");
  });

  it("offers openers that this IQ can actually answer", () => {
    for (const iqEntry of SHARED_IQS) {
      const suggestions = sharedIqSuggestions([iqEntry]);
      expect(suggestions.length).toBeGreaterThan(0);
      for (const question of suggestions) {
        const routed = sharedIqAsk(iqEntry, question);
        const answer = sharedIqToolResult(iqEntry, routed.tool, routed.argument);
        expect(answer).toContain("Sample data");
        expect(answer).not.toContain("No published IQ Cell matches");
      }
    }
  });

  // With several IQs connected the openers have to work on all of them, since
  // one question is put to every server. An opener naming one IQ's cell would
  // be a miss on the other four.
  it("offers openers every connected IQ can answer", () => {
    const suggestions = sharedIqSuggestions(SHARED_IQS);
    expect(suggestions.length).toBeGreaterThan(0);
    for (const question of suggestions) {
      for (const iqEntry of SHARED_IQS) {
        const routed = sharedIqAsk(iqEntry, question);
        const answer = sharedIqToolResult(iqEntry, routed.tool, routed.argument);
        expect(answer).toContain("Sample data");
        expect(answer).not.toContain("No published IQ Cell matches");
      }
    }
  });

  // Routing runs per IQ, so a question naming one IQ's cell reaches that cell
  // on its own IQ and still gets a truthful answer everywhere else.
  it("routes the same question separately for each connected IQ", () => {
    const target = SHARED_IQS[0]!;
    const question = `what does "${target.cells[0]!.name}" do`;
    expect(sharedIqAsk(target, question).tool).toBe("myiq_get_cell");
    for (const iqEntry of SHARED_IQS) {
      const routed = sharedIqAsk(iqEntry, question);
      expect(sharedIqToolResult(iqEntry, routed.tool, routed.argument)).toContain("Sample data");
    }
  });
});

describe("Connectome IQ — handing an IQ to chat", () => {
  const iq = SHARED_IQS[0]!;

  it("carries the IQ, the server and the tool names", () => {
    const prompt = sharedIqChatPrompt([iq], "What did the analysis find?");
    expect(prompt).toContain(iq.name);
    expect(prompt).toContain(iq.owner);
    expect(prompt).toContain("What did the analysis find?");
    expect(prompt).toContain(sharedIqClientConfig([iq]));
    for (const tool of SHARED_IQ_TOOLS) expect(prompt).toContain(tool);
  });

  it("names every IQ when several are handed over at once", () => {
    const prompt = sharedIqChatPrompt(SHARED_IQS, "What did each analysis find?");
    for (const entry of SHARED_IQS) {
      expect(prompt).toContain(entry.name);
      expect(prompt).toContain(sharedIqServerId(entry));
    }
    expect(prompt).toContain(sharedIqClientConfig(SHARED_IQS));
  });

  it("says it is sample data, so the message cannot be read as somebody's real work", () => {
    expect(sharedIqChatPrompt([iq], "")).toContain("sample data");
    expect(sharedIqChatPrompt(SHARED_IQS, "")).toContain("sample data");
  });
});

describe("Connectome IQ — the sample snapshots on disk", () => {
  const directory = join(import.meta.dirname, "..", "sample-data", "connectome-iq");
  const files = readdirSync(directory).filter((name) => name.endsWith(".published.json"));

  it("has snapshots to serve", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s parses as a published snapshot", (file) => {
    const snapshot = MyIqSnapshot.parse(
      JSON.parse(readFileSync(join(directory, file), "utf8")) as unknown,
    );
    expect(snapshot.name).not.toBe("");
    expect(snapshot.shared).toBe(true);
    // The server refuses a snapshot without this, so a file that lost it would
    // be a file nobody can serve.
    expect(snapshot.sampleDataOnly).toBe(true);
    expect(snapshot.cells.length).toBeGreaterThan(0);
    expect(snapshot.connectome).not.toBeNull();
  });
});
