import { z } from "zod";

/**
 * Modes and sub-modes.
 *
 * Every capability declares one top-level mode plus one sub-mode. This module
 * is the single place that mapping lives, so a capability cannot be added
 * without being placed: the renderer reads the rail from here, and the
 * privileged side stamps mode and sub-mode onto every audit record.
 *
 * Mode changes the layout and the active agent configuration. It never changes
 * the conversation — there is one conversation object across every mode.
 */

export const TopMode = z.enum(["chat", "cocreate", "flow", "hub", "control"]);
export type TopMode = z.infer<typeof TopMode>;

export const SubMode = z.enum([
  // Chat
  "conversation",
  "team",
  "research",
  "dataagent",
  // Co-create
  "fabric",
  "office",
  "image",
  "record",
  // IQ Cell
  "industry",
  "flow",
  "memories",
  "library",
  "connectome",
  // Connectome IQ
  "hub",

  // Control Center
  "automations",
  "plans",
  "audit",
  "samples",
  "clean",
]);
export type SubMode = z.infer<typeof SubMode>;

export interface SubModeSpec {
  readonly mode: TopMode;
  readonly label: string;
  readonly detail: string;
  /** True when the sub-mode cannot run without a bound project. */
  readonly requiresProject: boolean;
  /**
   * Marked in the rail and on the canvas tab.
   *
   * Beta means demo-scoped — the surface is backed by stub persistence or has
   * no runtime behind it — not merely new. A surface with a real backend
   * carries no tag however recently it shipped, because the tag is a warning
   * about what the feature will not do, and a warning that is not true trains
   * people to ignore the ones that are.
   */
  readonly beta?: boolean;
  /**
   * Panes this sub-mode does without.
   *
   * The same idea as {@link SurfaceSpec.hidesPanes}, for the destinations that
   * are sub-modes rather than canvas surfaces. Two of Co-create's surfaces own
   * their input — Image Creation has "Describe the image", Skill Recording is
   * driven entirely by buttons — and each keeps its own history. Beside them
   * the chat composer is a second box that looks like the one to type in and
   * does something else: it starts a conversation, which is not how either of
   * these two is run.
   */
  readonly hidesPanes?: readonly PaneId[];
}

export const SUB_MODES = {
  conversation: {
    mode: "chat",
    label: "Conversation",
    detail: "One agent, one thread",
    requiresProject: false,
  },
  team: {
    mode: "chat",
    label: "Team (Council)",
    detail: "A council debates to a decision",
    requiresProject: false,
  },
  /**
   * Ask a question too big for one turn and get a cited report back.
   *
   * Under Chat rather than Co-create because what it produces is an answer,
   * not an artifact built from material you already have. Every Co-create
   * surface takes something of yours and makes something else out of it;
   * Research starts from a question and goes looking. That is what the rest of
   * Chat does too — one agent, a council, or a Data Agent — and the only
   * difference here is how long the answer takes.
   *
   * Shaped exactly like Team: it replaces the thread with its own surface and
   * its own list of past runs, so it declares no `hidesPanes`. The chat pane is
   * not hidden, it is what Research is drawn in.
   *
   * It still requires a project, unlike everything else under Chat, because the
   * report is written into one as an artifact and cited against the vault's
   * index.
   */
  research: {
    mode: "chat",
    label: "Research",
    detail: "Cited investigation producing a report",
    requiresProject: true,
  },
  /**
   * Chat, but the answer comes from a Fabric Data Agent rather than a model.
   *
   * Under Chat and not under Co-create → Fabric, because asking questions of
   * data is a conversation, not a build step: it needs no project, no source
   * files and no skill bundle, and the person doing it often has no rights to
   * create anything. It lived inside the Fabric build surface once, where it
   * was invisible unless a project had been registered first.
   */
  dataagent: {
    mode: "chat",
    label: "Data agent",
    detail: "Ask your data through a Fabric Data Agent",
    requiresProject: false,
  },
  fabric: {
    mode: "cocreate",
    label: "Fabric",
    detail: "Build Microsoft Fabric artifacts from your data definitions",
    requiresProject: true,
  },
  office: {
    mode: "cocreate",
    label: "Office",
    detail: "Documents, spreadsheets and decks",
    requiresProject: true,
  },
  image: {
    mode: "cocreate",
    label: "Image Creation",
    detail: "Generate and edit with a Foundry image model",
    requiresProject: true,
    hidesPanes: ["chat"],
  },
  /**
   * Do the task once, by hand, and let the app write the skill.
   *
   * It sits under Co-create rather than IQ Cell because it *builds an artifact
   * from your own work*, which is what every other Co-create surface does — the
   * source material happens to be a screen recording rather than a file in the
   * project. It needs no project for the same reason: the thing being
   * recorded is usually in some other application entirely, and requiring a
   * bound project would make the surface unreachable exactly when it is most
   * useful.
   */
  record: {
    mode: "cocreate",
    label: "Skill Recording",
    detail: "Do a task once; get a skill that repeats it",
    requiresProject: false,
    hidesPanes: ["chat"],
  },
  /**
   * The domain a cell is being built for, before any of it is built.
   *
   * An IQ Cell is only as good as what it knows about the business it runs
   * in, and the fastest way to be wrong about a domain is to have never read
   * anything about it. This is a reading surface over a bundled set of
   * industry primers — no model, no network, nothing to configure — and it
   * sits first under IQ Cell because it is what you do before composing a
   * workflow, not after.
   */
  industry: {
    mode: "flow",
    label: "IQ Industry",
    detail: "Read the domain a cell will run in",
    requiresProject: false,
    beta: true,
  },
  flow: {
    mode: "flow",
    label: "IQ Workflow",
    detail: "Compose a procedure into an IQ Cell",
    requiresProject: false,
    beta: true,
  },
  library: {
    mode: "flow",
    label: "IQ Cell library",
    detail: "Every compiled cell — opens where it was made",
    requiresProject: false,
    beta: true,
  },
  connectome: {
    mode: "flow",
    label: "My IQ",
    detail: "Your knowledge, intelligence, and workflows",
    requiresProject: false,
    beta: true,
  },
  /**
   * The hub the published My IQs sit in — the whole of its own mode.
   *
   * My IQ answers "how does my own work hang together". This answers the next
   * question, which no surface in the product could: *whose else*. It is a
   * directory of IQs — your own published one, and the ones other people chose
   * to share — each readable over MCP without copying anything into this app.
   *
   * It is a top-level mode rather than a sixth entry under IQ Cell because it
   * is not a way of building a cell. IQ Cell is where work is compiled; this is
   * where the compiled result is met by other people's. Under IQ Cell it read
   * as one more authoring step, which is the one thing it is not.
   *
   * Beta, and more so than its neighbours: the directory of other people's IQs
   * is fixture data, so the surface shows the shape of the exchange rather than
   * a live one. It says so on screen.
   */
  hub: {
    mode: "hub",
    label: "Connectome IQ",
    detail: "A hub for shared My IQs",
    requiresProject: false,
    beta: true,
  },
  memories: {
    mode: "flow",
    label: "IQ Memories",
    detail: "Facts worth keeping — and compiling",
    requiresProject: false,
  },
  automations: {
    mode: "control",
    label: "Automations",
    detail: "Scheduled and recurring work",
    requiresProject: false,
  },
  plans: {
    mode: "control",
    label: "Delegated plans",
    detail: "Sub-agent delegation and parallel runs",
    requiresProject: false,
  },
  audit: {
    mode: "control",
    label: "Audit",
    detail: "Every action taken on your behalf",
    requiresProject: false,
  },
  /**
   * The worked examples, in one place.
   *
   * They used to be a Load/Clear pair on each surface that had them — IQ
   * Memories, IQ Knowledge, the demo IQ Cell library — so "is any of what I am
   * looking at made up?" could only be answered by visiting every surface and
   * knowing which ones had examples at all. It belongs in Control Center for
   * the same reason the audit log does: it is a question about the app rather
   * than work done inside it.
   */
  samples: {
    mode: "control",
    label: "Sample data",
    detail: "Load or clear the worked examples",
    requiresProject: false,
  },
  /**
   * Take out the conversation data nothing can reach.
   *
   * The store is append-only, which is right for an audit trail and leaves
   * debris no feature ever removes: threads created and never spoken to, the
   * private sessions a council or research run leaves behind, turn logs a
   * crash orphaned, and remembered browser pages for conversations that are
   * gone. It belongs in Control Center because it is a question about the app
   * rather than work done inside it — the same reason Audit and Sample data
   * are here.
   */
  clean: {
    mode: "control",
    label: "Clean",
    detail: "Remove conversation data nothing can reach",
    requiresProject: false,
  },
} as const satisfies Record<SubMode, SubModeSpec>;

/**
 * Rail order per mode. The first entry is the mode's default sub-mode.
 *
 * IQ Cell is in two parts, and the rail draws a rule between them. My IQ is
 * the output — the one thing this mode exists to produce, and the thing that
 * gets published and served over MCP. Everything under the rule is an input to
 * it: the primers in IQ Industry, the procedures in IQ Workflow, the facts in
 * IQ Memories, the compiled cells in the library. Listed flat they read as
 * five peers and the direction is lost, which is the question people actually
 * arrive with — what is made from what.
 *
 * Connectome IQ owns a mode with one destination in it. The rail still renders
 * that destination, because every place in this app is a sub-mode and a mode
 * with no sub-mode would be a place nothing could record, restore or audit.
 *
 * Control Center has no Models entry. The model registry is a *connection* —
 * an endpoint, an identity and a deployment name — and it is already on the
 * Connections surface beside Speech, Fabric and MCP. Listing the same registry
 * twice made "where do I add a deployment?" a question with two right answers
 * and no way to tell them apart.
 */
export const SUB_MODES_BY_MODE = {
  chat: ["conversation", "team", "research", "dataagent"],
  cocreate: ["fabric", "office", "image", "record"],
  flow: ["connectome", "industry", "flow", "memories", "library"],
  hub: ["hub"],
  control: ["automations", "plans", "audit", "samples", "clean"],
} as const satisfies Record<TopMode, readonly SubMode[]>;

export const MODE_LABELS = {
  chat: "Chat",
  cocreate: "Co-create",
  flow: "IQ Cell",
  hub: "Connectome IQ",
  control: "Control Center",
} as const satisfies Record<TopMode, string>;

/**
 * Secondary destinations. Each opens as a canvas tab beside the sub-modes.
 *
 * Declared here rather than in the renderer because a conversation records
 * where it is connected and that record crosses IPC: a place is a sub-mode, or
 * a sub-mode with one of these open over it.
 */
export const AppSurface = z.enum([
  "knowledge",
  "browser",
  "meetings",
  "skills",
  "mcp",
  "projects",
  "connections",
]);
export type AppSurface = z.infer<typeof AppSurface>;

/**
 * The shell's resizable columns.
 *
 * Declared beside the surfaces because a surface's most consequential property
 * is which of these it does without, and that rule already had to be stated
 * here for {@link canHoldConversation}. Held in two places it was a mirror by
 * hand: `SURFACES_WITHOUT_A_THREAD` here and `SURFACE_HIDES_PANES` in the
 * renderer, each documented as tracking the other.
 */
export const PaneId = z.enum(["chat", "canvas", "navigator", "inspector"]);
export type PaneId = z.infer<typeof PaneId>;

/**
 * Everything true of a surface that is not a picture.
 *
 * One surface used to be described in seven declarations across two files in
 * two processes: the enum, `modeForSurface`, `SURFACES_WITHOUT_A_THREAD`, the
 * renderer's own `SURFACES` table of labels, one of three per-mode arrays,
 * `SURFACE_HIDES_PANES`, and an arm of a switch. Two of those answered the same
 * question — which mode owns this — and could disagree; the arrays were what the
 * rail actually rendered, so shared's answer was the one that could be wrong
 * without anything noticing.
 *
 * Only the icon stays in the renderer, because a React component cannot cross
 * IPC and a place does.
 */
export interface SurfaceSpec {
  label: string;
  detail: string;
  /**
   * The mode whose rail lists it and whose canvas it opens on.
   *
   * Chat is deliberately one pane, so a surface asked for from there moves the
   * mode to where a canvas exists. IQ Knowledge belongs to IQ Cell: the vault
   * index is what an IQ Cell is grounded on. Skills and MCP servers belong to
   * Control Center, because neither is work — they are the standing declaration
   * of what the agent knows how to do and whose tools it may call, which is the
   * same kind of thing as the audit log and the automations beside them.
   * Browser and Meeting Recordings stay under Co-create, where the artifact is
   * produced.
   */
  mode: TopMode;
  /**
   * Whether the rail offers it as a destination.
   *
   * `false` means it is reached another way — Projects and Connections & access
   * sit in the rail's bottom group with Control Center, not among a mode's
   * surfaces. Recoverable before this only by reading three arrays and noticing
   * which two names were in none of them.
   */
  railed: boolean;
  /**
   * Panes this surface does without.
   *
   * Co-create's three-pane shape is right for authoring against a project and
   * wrong for the two surfaces that are *about* the frame rather than the work
   * inside it. Connections & access is a settings page: a conversation and a
   * file tree beside it are two competing focuses on a page whose whole job is
   * one form at a time. Projects loses the conversation for a stronger reason
   * than tidiness — a turn is scoped to the bound project, so leaving the
   * composer live next to the control that rebinds it invites a message sent
   * into the project the user is in the middle of leaving. Its navigator
   * stays: it is the preview of the project being chosen.
   */
  hidesPanes: readonly PaneId[];
  /** Rendered with a beta tag wherever the surface is named. */
  beta?: boolean;
}

export const SURFACES: Record<AppSurface, SurfaceSpec> = {
  knowledge: {
    label: "IQ Knowledge",
    detail: "Graph and table over the vault index",
    mode: "flow",
    railed: true,
    hidesPanes: [],
  },
  browser: {
    label: "Browser",
    detail: "Self-contained web browser with chat integration",
    mode: "cocreate",
    railed: true,
    hidesPanes: [],
  },
  meetings: {
    label: "Meeting Recordings",
    detail: "Recording, transcription and notes",
    mode: "cocreate",
    railed: true,
    hidesPanes: [],
  },
  skills: {
    label: "Skills",
    detail: "Procedures loaded on demand",
    mode: "control",
    railed: true,
    hidesPanes: [],
  },
  mcp: {
    label: "MCP servers",
    detail: "Configured tool sources",
    mode: "control",
    railed: true,
    hidesPanes: [],
  },
  projects: {
    label: "Projects",
    detail: "Named directories and their bindings",
    mode: "cocreate",
    railed: false,
    hidesPanes: ["chat"],
  },
  connections: {
    label: "Connections & access",
    detail: "Identity and what it reaches",
    mode: "cocreate",
    railed: false,
    hidesPanes: ["chat", "navigator"],
  },
};

/** The mode a canvas surface opens in. */
export const modeForSurface = (surface: AppSurface): TopMode => SURFACES[surface].mode;

/** Panes the shell drops while this surface is the open canvas tab. */
export const panesHiddenBy = (surface: AppSurface): readonly PaneId[] =>
  SURFACES[surface].hidesPanes;

/** Panes the shell drops while this sub-mode is the open destination. */
export const panesHiddenBySubMode = (subMode: SubMode): readonly PaneId[] => {
  const spec: SubModeSpec = SUB_MODES[subMode];
  return spec.hidesPanes ?? [];
};

/**
 * The surfaces this mode's rail offers, in declaration order.
 *
 * Derived rather than listed, so the rail and `modeForSurface` cannot give two
 * answers to "which mode owns this surface" — which they could, and the rail's
 * was the one people saw.
 */
export const railSurfacesFor = (mode: TopMode): AppSurface[] =>
  AppSurface.options.filter(
    (surface) => SURFACES[surface].mode === mode && SURFACES[surface].railed,
  );

/**
 * Where a conversation is connected.
 *
 * A conversation is not only a thread — it was held somewhere, and coming back
 * to it means coming back to that place. "Create a deck about Microsoft" ends
 * up on Co-create → Office and "search the web for X" on Co-create → Browser,
 * so selecting either in the rail has to restore the mode and the canvas tab
 * as well as the history.
 *
 * **Either half may be null, and at least one must not be.** A sub-mode alone
 * is a rail destination; a surface alone is one of the secondary destinations
 * under SURFACES, which are canvas tabs with no sub-mode behind them. The
 * Browser is the case that forced this: it is not a sub-mode and never was, so
 * the only way to express "the browser, beside the thread" used to be to pair
 * it with `conversation` — a sub-mode belonging to Chat, which has no canvas.
 * Entering that place moved the mode to Co-create and landed on whichever
 * Co-create sub-mode happened to be selected, which is how a browsing
 * conversation came back on the Fabric tab.
 *
 * The mode is not a field: it is {@link modeForPlace}. Carrying it as well
 * would be a second answer to the same question, and the two can disagree.
 */
export const SessionPlace = z.object({
  subMode: SubMode.nullable().default("conversation"),
  /** The canvas tab open over the sub-mode, or open on its own. */
  surface: AppSurface.nullable().default(null),
});
export type SessionPlace = z.infer<typeof SessionPlace>;

export const DEFAULT_SESSION_PLACE: SessionPlace = { subMode: "conversation", surface: null };

/** Which mode a place lives in. A surface alone names the mode that owns it. */
export const modeForPlace = (place: SessionPlace): TopMode =>
  place.subMode !== null ? modeOf(place.subMode) : place.surface !== null
    ? modeForSurface(place.surface)
    : "chat";

/** Whether two places name the same view. */
export const samePlace = (a: SessionPlace, b: SessionPlace): boolean =>
  a.subMode === b.subMode && a.surface === b.surface;

/** Whether a place is the plain thread, which is what an unplaced session has. */
export const isDefaultPlace = (place: SessionPlace): boolean =>
  samePlace(place, DEFAULT_SESSION_PLACE);

/**
 * The secondary destinations that replace the chat pane rather than sitting
 * beside it. A conversation filed on one of these would open with its own
 * history off screen.
 *
 * Derived from {@link SURFACES}, not listed: this used to be a hand-kept mirror
 * of `SURFACE_HIDES_PANES` in the renderer, with a comment in each saying so.
 */
const SURFACES_WITHOUT_A_THREAD: readonly AppSurface[] = AppSurface.options.filter((surface) =>
  SURFACES[surface].hidesPanes.includes("chat"),
);

/**
 * Whether a conversation's own history is legible on this sub-mode.
 *
 * A place is only worth restoring if the messages come back with it, and three
 * groups of sub-modes fail that test for three different reasons.
 *
 * - **IQ Cell and Control Center have no chat pane at all.** They are one
 *   canvas, or a canvas and an inspector; a conversation filed there would
 *   open somewhere its own history is not on screen.
 * - **Chat → Team, Chat → Research and Chat → Data agent replace the thread
 *   with their own surface.** The Data agent keeps its own conversations,
 *   filed separately and keyed to the threads the Data Agent service holds; a
 *   conversation from this rail is not one of them, so it would open showing
 *   nothing of itself. Council runs and research runs likewise have their own
 *   histories. None of the three is where the picked conversation's messages
 *   are.
 * - **Two Co-create sub-modes own their input and their history.** Image
 *   Creation and Skill Recording each have their own box to type in and their
 *   own list of past runs, so they declare `hidesPanes: ["chat"]` and there is
 *   no thread beside them to restore a conversation into.
 * - **Every other Co-create sub-mode holds the thread beside its canvas**,
 *   which is exactly the arrangement worth restoring.
 */
export const holdsConversation = (subMode: SubMode): boolean =>
  (subMode === "conversation" || modeOf(subMode) === "cocreate") &&
  !panesHiddenBySubMode(subMode).includes("chat");

/**
 * Whether the shell can actually show this place.
 *
 * Three ways a place fails, and all three have been written to a real user's
 * log by a build that shipped:
 *
 *  1. **Neither half is set.** A place has to name something.
 *  2. **The two halves name different modes.** `{conversation, browser}` says
 *     Chat, which is one pane with no canvas, so entering it moved the mode to
 *     Co-create and landed on whichever Co-create sub-mode was selected — a
 *     third place, belonging to nobody.
 *  3. **The destination shows no thread.** Team and Data agent replace the
 *     chat pane with their own state; IQ Cell and Control Center have no chat
 *     pane at all; Connections and Projects suppress it. A conversation
 *     restored to any of them opens with its own history off screen.
 *
 * The log is append-only, so this has to be asked *before* the write. There is
 * no correcting a bad place afterwards, only burying it.
 */
export const canHoldConversation = (place: SessionPlace): boolean => {
  if (place.subMode === null && place.surface === null) return false;
  if (place.subMode !== null && place.surface !== null) {
    if (modeOf(place.subMode) !== modeForSurface(place.surface)) return false;
  }
  if (place.subMode !== null && !holdsConversation(place.subMode)) return false;
  if (place.surface !== null && SURFACES_WITHOUT_A_THREAD.includes(place.surface)) return false;
  return modeForPlace(place) === "chat" || modeForPlace(place) === "cocreate";
};

/**
 * How a place came to be recorded.
 *
 * Three sources, and they are ranked rather than merged: `chosen` beats
 * `work`, which beats `navigation` — see {@link SessionRepo.summary}.
 *
 * `chosen` is the user saying, at the moment they start a conversation, what
 * it is for. It outranks everything because it is the only source that is not
 * an inference: a conversation started on Office is an Office conversation
 * even if the first thing it does is query a warehouse, and a rail whose rows
 * rearrange themselves under the person who filed them is worse than a rail
 * that files nothing.
 *
 * `work` is the inference — the tool the agent reached for. It is what places
 * every conversation nobody placed by hand.
 *
 * `navigation` exists so the fold can *ignore* the records an earlier build
 * wrote. Those records are the whole defect: the shell reported where the
 * window was pointing every time anything changed, so one real user's deck
 * conversation accumulated nine of them — fabric, image, image/meetings,
 * image/browser, research, image, **office**, fabric, research — and the last
 * one won. The correct answer was in there, seventh, buried by six clicks that
 * meant nothing.
 *
 * The shell no longer writes them. Selecting a conversation and then looking
 * at another tab is not a statement about where that conversation belongs, and
 * the shell has no way to tell the two apart.
 */
export const PlaceSource = z.enum(["chosen", "work", "navigation"]);
export type PlaceSource = z.infer<typeof PlaceSource>;

/**
 * The destinations a new conversation may be started in.
 *
 * Derived from nothing — declared, and then *proved* against
 * {@link canHoldConversation} by a test, because the two answer different
 * questions and only one of them is enforceable at the boundary. This list is
 * an offer made in the UI; `canHoldConversation` is the rule the privileged
 * side refuses a write on.
 *
 * Team, Research and Data agent are deliberately absent. All three replace the
 * chat pane with a surface of their own — the Data agent has its own
 * conversations and its own history, the council has its own runs, and a
 * research run has its own plan and report — so a conversation filed on any of
 * them reopens showing none of its own messages. They remain reachable as rail
 * destinations; what they cannot be is where a conversation *lives*.
 *
 * The shell's New conversation menu does offer a Data agent conversation, below
 * a separator and outside this list. That is not a contradiction: what it
 * starts is a thread on the Fabric service, filed in the Data agent's own
 * store and listed in its own rail group. It is not a session, and nothing
 * here will let one be written as if it were.
 *
 * Image Creation and Skill Recording are absent for the same reason one level
 * down: each owns its input box and its own history, so the shell hides the
 * chat pane while they are open and there is no thread beside them.
 *
 * Order is the order they are offered in: the plain thread first, then the two
 * Co-create surfaces that build something beside a thread, then the browser.
 */
export const CONVERSATION_DESTINATIONS: readonly SessionPlace[] = [
  { subMode: "conversation", surface: null },
  { subMode: "office", surface: null },
  { subMode: "fabric", surface: null },
  { subMode: null, surface: "browser" },
];

/** A stable key for a place — for React lists and for equality in a Map. */
export const placeKey = (place: SessionPlace): string =>
  `${place.subMode ?? ""}|${place.surface ?? ""}`;

/**
 * Where a conversation belongs, given the tool it just used.
 *
 * Keyed on the **tool name**, never on the family carried by the approval
 * request: the agent SDK forwards every governed tool as
 * `family: "copilot.custom-tool"`, so a request to build a deck and a request
 * to query a warehouse arrive indistinguishable. The family is a fallback for
 * the callers that hold a real one — the repair pass reads it off historic
 * turn logs, where our own families were recorded correctly.
 *
 * `null` in the table means *asked, and deliberately nowhere*. Most tools are
 * things a conversation does while remaining a conversation — reading mail,
 * searching the index — and moving the thread for one of those would file it
 * under a surface that shows none of the work.
 */
const PLACE_BY_TOOL: Readonly<Record<string, SessionPlace | null>> = {
  /**
   * Asking a Data Agent is family `fabric` and is emphatically not Co-create →
   * Fabric: that surface builds project items, and this call built nothing.
   * Nor is it Chat → Data agent, which keeps its own conversations and would
   * not show this one. The answer is in the thread, so the thread is where it
   * stays.
   */
  fabric_ask_data_agent: null,
};

/**
 * The family-level fallback, for the families where every member agrees.
 *
 * Only families that name a destination a conversation can be *held* in
 * appear. `knowledge` does not: IQ Knowledge is an IQ Cell surface, and IQ Cell
 * is a single canvas with no chat pane. `images` does not, because no governed
 * tool carries it — the Image Creation surface has its own prompt box, so an
 * image made there is not the selected conversation's work and filing the
 * conversation under it would repeat the mistake the shell was making.
 */
const PLACE_BY_FAMILY: Readonly<Record<string, SessionPlace>> = {
  office: { subMode: "office", surface: null },
  fabric: { subMode: "fabric", surface: null },
  /**
   * The browser is a surface with no sub-mode behind it, which is what the
   * nullable half of a place exists to say. It runs beside the thread that
   * drives it — literally the arrangement Co-create already has — and that is
   * the view a conversation which spent its life browsing should come back to.
   */
  browser: { subMode: null, surface: "browser" },
};

export const placeForTool = (toolName: string, family: string | null): SessionPlace | null => {
  const named = Object.hasOwn(PLACE_BY_TOOL, toolName) ? PLACE_BY_TOOL[toolName] : undefined;
  if (named === null) return null;
  return named ?? (family === null ? null : (PLACE_BY_FAMILY[family] ?? null));
};

/** Beta modes are demo-scoped and named as such wherever they appear. */
export const BETA_MODES: readonly TopMode[] = ["flow", "hub"];

export const defaultSubMode = (mode: TopMode): SubMode => SUB_MODES_BY_MODE[mode][0];

export const modeOf = (subMode: SubMode): TopMode => SUB_MODES[subMode].mode;

/**
 * Whether a sub-mode is still beta. Read through a helper because SUB_MODES is
 * `as const`, so the literal entries that carry no flag have no `beta` property
 * to index.
 */
export const isBetaSubMode = (subMode: SubMode): boolean =>
  (SUB_MODES[subMode] as SubModeSpec).beta === true;

/**
 * Where an action happened. Carried on audit records and on every long-running
 * run so a governance reader can tell a council turn from an Office edit.
 */
export const ModeContext = z.object({
  mode: TopMode,
  subMode: SubMode,
  projectId: z.string().nullable().default(null),
});
export type ModeContext = z.infer<typeof ModeContext>;

