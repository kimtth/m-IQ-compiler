import { Component, Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Blocks,
  BookMarked,
  BookOpen,
  Boxes,
  Brain,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronsLeftRight,
  Clock,
  Database,
  Eraser,
  FileStack,
  FlaskConical,
  Globe,
  History as HistoryIcon,
  Home as HomeIcon,
  Image as ImageIcon,
  KeyRound,
  LayoutPanelLeft,
  MessageSquare,
  Moon,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Package,
  Pencil,
  Plus,
  ScrollText,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  Users,
  Video,
  Workflow,
  X,
  XSquare,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  CONVERSATION_DESTINATIONS,
  DEFAULT_SESSION_PLACE,
  MODE_LABELS,
  BETA_MODES,
  SUB_MODES,
  SUB_MODES_BY_MODE,
  SURFACES,
  councilRunTitle,
  defaultSubMode,
  isBetaSubMode,
  modeForSurface,
  panesHiddenBy,
  panesHiddenBySubMode,
  placeKey,
  railSurfacesFor,
  type AppSurface,
  type AuthStatus,
  type CopilotAuthStatus,
  type CouncilRun,
  type DataAgentChat,
  type OfficeChange,
  type SessionPlace,
  type SessionSummary,
  type SubMode,
  type TopMode,
  type ProjectRecord,
} from "@iq/shared";
import { call, callAs, subscribe } from "./bridge.js";
import { Chat } from "./Chat.js";
import { Knowledge } from "./Knowledge.js";
import { BrowserPanel } from "./BrowserPane.js";
import { Meetings } from "./meetings.js";
import { Recording } from "./Recording.js";
import { Navigator } from "./Navigator.js";
import { Identity, SpeechConnection, FabricConnection, DataAgentConnection } from "./panels/connections.js";
import { Skills } from "./panels/skills.js";
import { FileViewer } from "./Viewer.js";
import { McpServers } from "./Mcp.js";
import { Logo } from "./Logo.js";
import { SignIn } from "./SignIn.js";
import {
  AuditCenter,
  AutomationsCenter,
  CleanCenter,
  MemoriesCenter,
  Models,
  PlansCenter,
  RoleDefaults,
  SamplesCenter,
} from "./ControlCenter.js";
import { Council } from "./Council.js";
import { Research } from "./Research.js";
import { Images } from "./Images.js";
import { Office } from "./Office.js";
import { Fabric } from "./Fabric.js";
import { DataAgent } from "./DataAgent.js";
import { Flow } from "./flow/Flow.js";
import { Industry } from "./industry/Industry.js";
import { IqCellLibrary } from "./flow/Library.js";
import { focusFor, NO_FOCUS, type IqCellRoute, type SurfaceFocus } from "./flow/route.js";
import { Connectome } from "./connectome/Connectome.js";
import { ConnectomeIq } from "./connectome/Hub.js";
import { Projects, type ProjectState } from "./Projects.js";
import { usePaneLayout, type PaneId } from "./panes.js";
import fabricMark from "./flow/marks/fabric-iq.png";
import workMark from "./flow/marks/work-iq.png";

/**
 * The application shell.
 *
 * Three top-level modes over one conversation. Chat is the minimal surface,
 * Co-create adds the canvas and the project navigator, and Control Center is
 * where the system is observed and configured rather than worked in. The mode
 * switch is pinned to the top of the icon rail and never collapses, so the user
 * always knows where they are and can always leave.
 *
 * Switching mode changes the layout and the active agent configuration. It
 * never changes the conversation: there is one conversation object, and moving
 * between modes binds or unbinds panes around it.
 */

/**
 * Secondary surfaces. Every one of these opens as a canvas tab — there is one
 * tab concept in the entire product, and no application-level tab strip.
 *
 * The list is declared in `@iq/shared` beside the sub-modes, because a
 * conversation records which of them it is connected to and that record
 * crosses IPC.
 */
type Surface = AppSurface;

interface Destination {
  label: string;
  detail: string;
  icon: LucideIcon;
  /** A product mark to draw instead of `icon`. See {@link SUB_MODE_MARKS}. */
  mark?: string;
  /** Rendered with a beta tag wherever the destination is named. */
  beta?: boolean;
}

/**
 * The one thing about a surface that cannot cross IPC.
 *
 * Everything else — label, detail, owning mode, whether the rail offers it, the
 * panes it does without — is `SURFACES` in `@iq/shared`. It has to be: a place
 * crosses the process seam, and while the description lived on both sides the
 * two could disagree about which mode owned a surface, with the renderer's copy
 * being the one that was rendered.
 */
const SURFACE_ICONS: Record<Surface, LucideIcon> = {
  knowledge: Brain,
  browser: Globe,
  meetings: CalendarClock,
  skills: Sparkles,
  mcp: Blocks,
  projects: Boxes,
  connections: KeyRound,
};

/** A surface as a destination: the shared description plus its icon. */
const surfaceDestination = (surface: Surface): Destination => ({
  label: SURFACES[surface].label,
  detail: SURFACES[surface].detail,
  icon: SURFACE_ICONS[surface],
  ...(SURFACES[surface].beta === true ? { beta: true } : {}),
});

const SUB_MODE_ICONS: Record<SubMode, LucideIcon> = {
  conversation: MessageSquare,
  team: Users,
  dataagent: Database,
  fabric: Database,
  office: FileStack,
  image: ImageIcon,
  research: Search,
  record: Video,
  industry: BookOpen,
  flow: Workflow,
  library: Package,
  connectome: Brain,
  hub: Network,
  memories: BookMarked,
  automations: Clock,
  plans: ChevronsLeftRight,
  audit: ScrollText,
  samples: FlaskConical,
  clean: Eraser,
};

/**
 * Product marks for the sub-modes that name a Microsoft product.
 *
 * `lucide-react` is the rule for every interface icon in this app, and this is
 * the same bounded exception the flow palette already makes: a monochrome line
 * glyph cannot say "this is Fabric". It was worse than neutral here — Fabric
 * and Data Agent both drew `Database`, so two rail rows had the same
 * silhouette and neither said which product it meant.
 *
 * The marks carry their own brand colour and must not be tinted. Office reuses
 * the Work IQ mark, which is the mark of the product the sub-mode reaches.
 */
const SUB_MODE_MARKS: Partial<Record<SubMode, string>> = {
  fabric: fabricMark,
  office: workMark,
};

/**
 * The icon for a place, whichever kind it has.
 *
 * Callers should not have to know that two sub-modes are drawn from an image,
 * so this is the single entry point everywhere a destination is named.
 */
function PlaceGlyph({
  icon: Icon,
  mark,
  size = 18,
}: {
  icon: LucideIcon;
  mark?: string;
  size?: number;
}): JSX.Element {
  if (mark === undefined) return <Icon size={size} aria-hidden="true" />;
  // The source images are not square, so the box is square and the art is
  // contained inside it — otherwise the marks would sit at a different optical
  // size from the glyphs above and below them.
  return (
    <img
      className="brand-mark"
      src={mark}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
    />
  );
}

const MODE_ICONS: Record<TopMode, LucideIcon> = {
  chat: MessageSquare,
  cocreate: LayoutPanelLeft,
  flow: Workflow,
  hub: Network,
  control: ShieldCheck,
};

/**
 * How a place is named to a person.
 *
 * A place is a sub-mode, or a secondary surface, or both. Both halves are
 * described in `@iq/shared` now — `SUB_MODES` and `SURFACES` — so this only has
 * to add the icon. It used to fold two tables on opposite sides of the process
 * seam, which is how the same destination ended up with two names.
 */
function describePlace(place: SessionPlace): Destination {
  if (place.subMode !== null) {
    const spec = SUB_MODES[place.subMode];
    const mark = SUB_MODE_MARKS[place.subMode];
    return {
      label: spec.label,
      detail: spec.detail,
      icon: SUB_MODE_ICONS[place.subMode],
      ...(mark === undefined ? {} : { mark }),
      ...(isBetaSubMode(place.subMode) ? { beta: true } : {}),
    };
  }
  if (place.surface !== null) return surfaceDestination(place.surface);
  // Unreachable through CONVERSATION_DESTINATIONS, which is the only producer,
  // and `canHoldConversation` refuses a place with neither half set.
  return { label: "Conversation", detail: "One agent, one thread", icon: MessageSquare };
}

/**
 * Secondary destinations offered alongside each mode's sub-modes.
 *
 * Derived from the shared registry rather than listed here. Listing them was
 * the defect: `modeForSurface` in `@iq/shared` and these three arrays both
 * answered "which mode owns this surface", the arrays were what the rail
 * actually rendered, and nothing compared them.
 */
const IQCELL_SURFACES = railSurfacesFor("flow");
const COCREATE_SURFACES = railSurfacesFor("cocreate");
const CONTROL_SURFACES = railSurfacesFor("control");

/**
 * Panes a surface does without.
 *
 * `panesHiddenBy` in `@iq/shared`, because the same fact decides whether a
 * conversation may be *filed* on a surface — a place whose destination hides
 * the chat pane would restore a conversation with its own history off screen.
 * Held separately, the two were mirrors kept by hand.
 */
const SURFACE_HIDES_PANES = panesHiddenBy;

/**
 * Panes a sub-mode does without.
 *
 * The same rule one level down, and it exists for the same reason: Image
 * Creation, Research and Skill Recording each own their input box and their own
 * history, so the chat composer beside them is a second place to type that
 * starts a conversation instead of a run.
 */
const SUBMODE_HIDES_PANES = panesHiddenBySubMode;

/**
 * End-to-end harness.
 *
 * Set only when the main process was started with `IQ_E2E=1`, which appends
 * `?e2e=1` to the renderer URL. It opens the shell past the sign-in card so a
 * test can drive the surfaces that need no identity — the IQ Cell editor and
 * My IQ are entirely renderer-local — and it grants nothing:
 * no token is held, and every privileged handler still refuses. The banner
 * below says so on screen, so a harness window can never be mistaken for a
 * signed-in one.
 */
const HARNESS =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("e2e") === "1";

interface CanvasTab {
  id: string;
  label: string;
  beta?: boolean;
  kind: "surface" | "submode" | "file";
  surface?: Surface;
  subMode?: SubMode;
  path?: string;
}

export function App(): JSX.Element {
  const [mode, setMode] = useState<TopMode>("chat");
  // The last sub-mode per mode, so returning to a mode returns the user to
  // where they were rather than resetting them to its default. Seeded from the
  // registry rather than written out by hand: moving a sub-mode between modes
  // used to leave a stale entry here, and since `chooseMode` follows the
  // remembered sub-mode to whichever mode now owns it, the mode switch bounced
  // straight back and the destination became unreachable.
  const [subModes, setSubModes] = useState<Record<TopMode, SubMode>>(() => ({
    chat: defaultSubMode("chat"),
    cocreate: defaultSubMode("cocreate"),
    flow: defaultSubMode("flow"),
    hub: defaultSubMode("hub"),
    control: defaultSubMode("control"),
  }));
  const [auth, setAuth] = useState<AuthStatus>({ state: "signed_out" });
  const [copilot, setCopilot] = useState<CopilotAuthStatus>({ state: "unknown" });
  const [entered, setEntered] = useState(HARNESS);
  /**
   * Whether the chat pane is showing the landing page rather than a thread.
   *
   * Held separately from "has this profile ever had a conversation", which is
   * what used to decide it — and which is true forever after the first turn, so
   * the landing page became unreachable on day one. See {@link goHome}.
   */
  const [atHome, setAtHome] = useState(true);
  /**
   * What a surface should land on when something else sent the user to it.
   *
   * The IQ Cell library routes a row back to the surface it came from, and
   * "IQ Memories" is a worse answer than "the three memories this is about".
   * Held here rather than in either surface because the sender and the
   * receiver are siblings, and because a canvas tab that already exists is not
   * remounted — the receiving surface keys an effect on the value, so a second
   * request from the library lands even when its tab was already open.
   *
   * One value, not three sibling states: the three were always set by the same
   * mechanism and read by the same shape of effect, and holding them apart cost
   * three setters here and six props on {@link CanvasContent} that existed only
   * to connect two siblings.
   */
  const [focus, setFocus] = useState<SurfaceFocus>(NO_FOCUS);
  /**
   * Whether the icon rail is showing.
   *
   * One control switches between the two states rather than two controls that
   * each do half the job, and it keeps its corner: hidden, it is the only thing
   * left where the rail was, so the way back is exactly where the way out was.
   * The choice is remembered, because someone who works with the rail hidden
   * does not want to hide it again on every launch.
   *
   * Icons are the default. The rail no longer carries the conversation list, so
   * narrow costs nothing but labels — every destination is still on screen and
   * still one click away, and the work gets 192px it used to spend on words the
   * reader had already learned. Only an explicit `"0"` opens it, so the stored
   * preference still wins on every launch after the first.
   */
  const [railHidden, setRailHidden] = useState(
    () => window.localStorage.getItem("iq.rail.hidden") !== "0",
  );
  /**
   * Whether the destination picker is open under "New conversation".
   *
   * Its own state rather than a CSS hover, because the choice it offers is a
   * durable one: it decides where the conversation is filed for the rest of
   * its life, and a menu that closes when the pointer drifts is not a control
   * anyone can make a decision in.
   */
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  /**
   * Whether the History flyout is open.
   *
   * Not remembered across launches. The rail's width is a working preference —
   * someone who likes it narrow wants it narrow tomorrow — but an open flyout
   * is a thing you are in the middle of, and restoring it would put a panel
   * over the work of a session that has not started yet.
   */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  /**
   * Council runs, listed in the rail beside the conversations.
   *
   * A run is the result of a conversation the user started, and it used to be
   * reachable only from a dropdown inside the Team pane — so a run you did not
   * already have selected was, in practice, unselectable. Held here because the
   * rail needs the list; the pane keeps its own copy for the picker.
   */
  const [councilRuns, setCouncilRuns] = useState<CouncilRun[]>([]);
  const [councilRunId, setCouncilRunId] = useState<string | null>(null);
  /**
   * Data agent conversations, listed in the rail beside the conversations.
   *
   * They are kept here for the same reason council runs are: the rail is where
   * a person looks for what they said yesterday. Held behind a toggle inside
   * the Data agent pane, the history was reachable only by someone who already
   * knew it existed, and the shell's own New conversation offered no way to
   * start one — so the surface read as a box that forgets.
   *
   * They are **not** sessions. A Data agent conversation is a thread on the
   * Fabric service keyed by its own id, with no turn log and no agent behind
   * it, which is why `dataagent` stays out of `CONVERSATION_DESTINATIONS`.
   */
  const [dataAgentChats, setDataAgentChats] = useState<DataAgentChat[]>([]);
  const [dataAgentChatId, setDataAgentChatId] = useState<string | null>(null);
  /** One conversation is being created; a second request would make a blank. */
  const creatingDataAgentChat = useRef(false);
  /**
   * The surface has already been given a conversation for this visit.
   *
   * Without it the arrival effect fires again the moment the open conversation
   * is deleted, and the row the user just removed is replaced by an identical
   * blank one — which reads as a delete button that does nothing.
   */
  const enteredDataAgent = useRef(false);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<CanvasTab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [error, setError] = useState<string | null>(null);

  const subMode = subModes[mode];

  const report = useCallback((problem: unknown) => {
    setError(problem instanceof Error ? problem.message : String(problem));
  }, []);

  // Light is the default; dark is opt-in and remembered on the device.
  useEffect(() => {
    const saved = window.localStorage.getItem("iq.theme");
    if (saved === "dark" || saved === "light") setTheme(saved);
  }, []);

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    window.localStorage.setItem("iq.theme", theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem("iq.rail.hidden", railHidden ? "1" : "0");
  }, [railHidden]);

  useEffect(() => {
    void (async () => {
      try {
        setAuth(await call("auth:status"));
        setCopilot(await call("auth:copilotStatus"));
      } catch (problem) {
        report(problem);
      }
    })();
    return subscribe<AuthStatus>("auth:status", setAuth);
  }, [report]);

  const refreshProjects = useCallback(async () => {
    const state = await callAs<ProjectState>("projects:list");
    setProjects(state.projects);
    setProjectId(state.activeId);
  }, []);

  // Sessions and projects are fetched only once the gate is passed: before
  // that there is no verified identity to scope them to.
  useEffect(() => {
    if (!entered) return;

    void (async () => {
      try {
        const list = await call("sessions:list");
        setSessions(list);
        setActiveSession((current) => current ?? list[0]?.id ?? null);
        setCouncilRuns(await call("council:list"));
        const chats = await call("dataAgent:chats");
        setDataAgentChats(chats);
        setDataAgentChatId((current) => current ?? chats[0]?.id ?? null);
        await refreshProjects();
      } catch (problem) {
        report(problem);
      }
    })();

    const offIndex = subscribe<SessionSummary[]>("sessions:index", setSessions);
    // Runs stream: a council that is still arguing must appear in the rail
    // while it argues, not only once it has finished.
    const offCouncil = subscribe<CouncilRun>("council:changed", (run) =>
      setCouncilRuns((current) => [run, ...current.filter((existing) => existing.id !== run.id)]),
    );
    const offProjects = subscribe<ProjectState>("projects:changed", (state) => {
      setProjects(state.projects);
      setProjectId(state.activeId);
    });
    return () => {
      offIndex();
      offCouncil();
      offProjects();
    };
  }, [entered, refreshProjects, report]);

  const openTab = useCallback((tab: CanvasTab) => {
    setTabs((current) => (current.some((open) => open.id === tab.id) ? current : [...current, tab]));
    setActiveTab(tab.id);
  }, []);

  const openSurface = useCallback(
    (surface: Surface) => {
      // Chat has no canvas, so a surface opened from there would be a tab
      // nothing renders. The bottom-rail destinations are reachable from every
      // mode, so the mode moves to where the canvas is rather than the click
      // doing nothing. Which mode that is belongs to `modeForSurface`, which is
      // also what decides whether a recorded place is showable — answering it
      // twice is how the rail and the session log come to disagree.
      setMode((current) => (current !== "chat" ? current : modeForSurface(surface)));
      openTab({
        id: `surface:${surface}`,
        label: SURFACES[surface].label,
        beta: SURFACES[surface].beta === true,
        kind: "surface",
        surface,
      });
    },
    [openTab],
  );

  const openFile = useCallback(
    (path: string) => {
      const name = path.split(/[\\/]/).pop() ?? path;
      openTab({ id: `file:${path}`, label: name, kind: "file", path });
    },
    [openTab],
  );

  /**
   * Entering a sub-mode changes the active agent configuration and the canvas
   * surface — never the thread. Chat's sub-modes have no canvas at all, so they
   * only change what the chat pane renders.
   */
  const chooseSubMode = useCallback(
    (next: SubMode) => {
      const owner = SUB_MODES[next].mode;
      setMode(owner);
      setSubModes((current) => ({ ...current, [owner]: next }));
      // Asking for Conversation asks for the thread. {@link goHome} sets the
      // flag back afterwards, which is why this can be unconditional.
      if (next === "conversation") setAtHome(false);
      if (owner === "chat") return;
      openTab({
        id: `sub:${next}`,
        label: SUB_MODES[next].label,
        beta: isBetaSubMode(next),
        kind: "submode",
        subMode: next,
      });
    },
    [openTab],
  );

  /**
   * Take the reader to where an IQ Cell came from.
   *
   * Both the IQ Cell library and My IQ send routes here, and this
   * is the only place that knows how to navigate one — which is why they can no
   * longer disagree about where a cell belongs. The two halves are deliberately
   * separate: `focusFor` says *what the destination should land on* and is pure,
   * this says *how to get there* and is the shell's business alone.
   */
  const openIqCell = useCallback(
    (route: IqCellRoute) => {
      setFocus((current) => focusFor(route, current));
      switch (route.kind) {
        case "editor":
          chooseSubMode("flow");
          return;
        case "knowledge":
          // A surface, not a sub-mode: IQ Knowledge is reached through
          // `openSurface`, and `modeForSurface` is what decides its mode.
          openSurface("knowledge");
          return;
        case "memories":
          chooseSubMode("memories");
          return;
        case "industry":
          chooseSubMode("industry");
          return;
        case "connectome":
          chooseSubMode("connectome");
          return;
      }
    },
    [chooseSubMode, openSurface],
  );

  /**
   * Back to the chat landing page.
   *
   * Home is not a sub-mode: it is what the Conversation pane shows *instead of*
   * a thread. Reaching it therefore means naming both things. The sub-mode,
   * because the pane picks its content from that first — an earlier Home item
   * set only a flag and so rendered nothing while Team or Data agent was
   * selected, which read as a dead control. And the flag, because Home used to
   * appear only while no conversation existed at all, so the first turn anyone
   * took made the landing page unreachable for the life of the profile.
   */
  const goHome = useCallback(() => {
    chooseSubMode("conversation");
    setAtHome(true);
  }, [chooseSubMode]);

  /**
   * Follow the document the agent is building.
   *
   * This subscription belongs to the app, not to the Office surface. It used to
   * live inside `Office`, which only renders while its own canvas tab is the
   * active one — so asking for a deck in Chat built the whole file with nothing
   * on screen, and the "live preview" was live only if you had already guessed
   * to open it. Holding the last change here means the surface can be *opened
   * by* the change and still knows which file to render.
   *
   * The canvas is opened once per document rather than on every mutation: six
   * slides are six mutations, and re-entering the surface on each one would drag
   * a user who had deliberately navigated away back six times.
   */
  const [officeChange, setOfficeChange] = useState<OfficeChange | null>(null);
  const shownDocument = useRef<string | null>(null);
  useEffect(() => {
    if (!entered) return;
    return subscribe<OfficeChange>("office:changed", (change) => {
      setOfficeChange(change);
      // Keyed on the project as well as the path, because a project-relative
      // path is not unique: two projects can both hold `Deck/Deck.pptx`, and
      // on the path alone the first document built after a rebind would be
      // treated as one already shown and never open its surface.
      const document = `${change.projectId ?? ""}\u0000${change.path}`;
      if (shownDocument.current === document) return;
      shownDocument.current = document;
      chooseSubMode("office");
    });
  }, [entered, chooseSubMode]);

  /**
   * A file the user asked to bring into the conversation.
   *
   * Carried as a counter beside the path rather than as the path alone, because
   * adding the *same* file twice is a thing people do, and a bare string would
   * be an unchanged prop the second time and silently do nothing. `Chat` keys
   * its effect on the counter and appends to whatever the composer already has,
   * so the reference joins the sentence being written rather than replacing it.
   */
  const [attachment, setAttachment] = useState<{ path: string; nonce: number } | null>(null);
  const addFileToChat = useCallback(
    (path: string) => {
      // The composer only exists on the Conversation sub-mode; sending someone
      // a file that lands in a pane they cannot see is worse than not offering
      // it, so the thread is brought forward first.
      chooseSubMode("conversation");
      setAttachment((current) => ({ path, nonce: (current?.nonce ?? 0) + 1 }));
    },
    [chooseSubMode],
  );

  /**
   * A request another surface wrote, on its way to the composer.
   *
   * Same counter trick as an attachment, for the same reason: handing the same
   * text over twice is a thing people do. `Chat` appends it and stops there —
   * the user writes the rest and presses send, so a button on a read-only
   * surface can never become a turn nobody asked for.
   */
  const [chatPrompt, setChatPrompt] = useState<{ text: string; nonce: number } | null>(null);
  const askInChat = useCallback(
    (text: string) => {
      chooseSubMode("conversation");
      setChatPrompt((current) => ({ text, nonce: (current?.nonce ?? 0) + 1 }));
    },
    [chooseSubMode],
  );

  /** Open one council run on the Team card. */
  const openCouncilRun = useCallback(
    (runId: string) => {
      chooseSubMode("team");
      setCouncilRunId(runId);
    },
    [chooseSubMode],
  );

  /**
   * Name a council run.
   *
   * The reply is folded into local state by id. The service also publishes the
   * run on `council:changed`, so this is not the only path — it is the one
   * that lands in the same tick as the keystroke, and a rename that appears a
   * beat later reads as one that did not take.
   */
  const renameCouncilRun = useCallback(
    async (runId: string, title: string) => {
      try {
        const run = await call("council:rename", { runId, title });
        setCouncilRuns((current) => current.map((row) => (row.id === runId ? run : row)));
      } catch (problem) {
        report(problem);
      }
    },
    [report],
  );

  /**
   * Delete a council run.
   *
   * Removed from local state rather than waited for on the event stream:
   * `council:changed` carries a run, so there is no shape in which the service
   * can announce that one is gone — sending the deleted run would put the row
   * straight back in every list that folds the stream by id.
   */
  const deleteCouncilRun = useCallback(
    async (runId: string) => {
      try {
        await call("council:delete", { runId });
        setCouncilRuns((current) => current.filter((run) => run.id !== runId));
        setCouncilRunId((current) => (current === runId ? null : current));
      } catch (problem) {
        report(problem);
      }
    },
    [report],
  );

  /**
   * Open one Data agent conversation on its surface.
   *
   * The same shape as {@link openCouncilRun}: the rail row is the way in, so
   * the surface is entered and told what to show in one step.
   */
  const openDataAgentChat = useCallback(
    (chatId: string) => {
      chooseSubMode("dataagent");
      setDataAgentChatId(chatId);
    },
    [chooseSubMode],
  );

  /**
   * Start a Data agent conversation, or reopen the untouched one.
   *
   * The id has to exist before the first question is asked — it is the thread
   * id sent to the Data Agent — so this runs on arrival rather than on the
   * first keystroke. That is also why an existing conversation with no
   * questions in it is reused: otherwise every visit to the surface would leave
   * another blank row in the rail.
   */
  const newDataAgentChat = useCallback(async (): Promise<void> => {
    chooseSubMode("dataagent");
    const blank = dataAgentChats.find((chat) => chat.exchanges.length === 0);
    if (blank !== undefined) {
      setDataAgentChatId(blank.id);
      return;
    }
    if (creatingDataAgentChat.current) return;
    creatingDataAgentChat.current = true;
    try {
      const fresh = await call("dataAgent:newChat");
      setDataAgentChats((current) => [fresh, ...current]);
      setDataAgentChatId(fresh.id);
    } catch (problem) {
      report(problem);
    } finally {
      creatingDataAgentChat.current = false;
    }
  }, [chooseSubMode, dataAgentChats, report]);

  /**
   * Delete a Data agent conversation, here and on disk.
   *
   * The Data Agent's own thread is not deleted: this app has no supported
   * operation to erase one, and claiming otherwise would be a lie about where
   * the data went. What goes is our transcript of it.
   *
   * Deleting the open one moves to the next conversation rather than leaving
   * the surface with nothing open. Nothing open is what the arrival effect
   * repairs by making a conversation, so leaving it there would put a row
   * straight back in the rail.
   */
  const deleteDataAgentChat = useCallback(
    async (chatId: string) => {
      try {
        await call("dataAgent:deleteChat", { chatId });
        const remaining = dataAgentChats.filter((chat) => chat.id !== chatId);
        setDataAgentChats(remaining);
        setDataAgentChatId((current) =>
          current === chatId ? (remaining[0]?.id ?? null) : current,
        );
      } catch (problem) {
        report(problem);
      }
    },
    [dataAgentChats, report],
  );

  /**
   * Fold an exchange into the open Data agent conversation.
   *
   * The main process is the writer — it files the question and the answer as
   * they happen, including the failures. This is the copy the rail and the
   * pane read from, updated in the same tick so the transcript does not lag a
   * round-trip behind the answer.
   */
  const recordDataAgentExchange = useCallback(
    (
      chatId: string,
      exchange: { question: string; answer: string; trace: string[]; failed: boolean },
    ) => {
      const askedAt = new Date().toISOString();
      setDataAgentChats((current) =>
        current.map((chat) =>
          chat.id === chatId
            ? {
                ...chat,
                title: chat.title === "" ? exchange.question.slice(0, 80) : chat.title,
                exchanges: [
                  ...chat.exchanges,
                  { id: crypto.randomUUID(), askedAt, ...exchange },
                ],
                updatedAt: askedAt,
              }
            : chat,
        ),
      );
    },
    [],
  );

  // A Data agent conversation must exist before a question can be asked: its
  // id is the thread id the question is sent under. So arriving on the surface
  // with nothing open makes one.
  //
  // It runs on arrival only. Deleting the last conversation also leaves nothing
  // open, and answering that by making another one would mean the surface could
  // never be emptied — the user asked for the row to go, and it goes.
  useEffect(() => {
    if (subMode !== "dataagent") {
      enteredDataAgent.current = false;
      return;
    }
    if (enteredDataAgent.current) return;
    enteredDataAgent.current = true;
    if (dataAgentChatId !== null) return;
    void newDataAgentChat();
  }, [subMode, dataAgentChatId, newDataAgentChat]);

  /**
   * Go to a place: the sub-mode a conversation was held on, and the canvas tab
   * that was open over it.
   *
   * The sub-mode is entered first even when a surface is named, so the tab the
   * user was working *in* is open behind the one they were looking at — that
   * is the arrangement they left, and Co-create's canvas would otherwise be
   * one tab where it had been two.
   */
  const goToPlace = useCallback(
    (place: SessionPlace) => {
      // The sub-mode is entered first even when a surface is named, so the tab
      // the conversation was working *in* is open behind the one it was looking
      // at. A place with no sub-mode is one of the SURFACES destinations — the
      // Browser is the case that matters — and `openSurface` moves the mode to
      // the one that owns the canvas by itself.
      if (place.subMode !== null) chooseSubMode(place.subMode);
      if (place.surface !== null) openSurface(place.surface);
    },
    [chooseSubMode, openSurface],
  );

  /**
   * Open a conversation's history, where it was held.
   *
   * Selecting the session is not enough, twice over. The chat pane picks what
   * it renders from the sub-mode *before* it looks at the thread, so a row
   * clicked while Team or Data agent was open changed the active session and
   * then rendered the same council or data pane it was already showing — the
   * row looked dead, and the history was unreachable without first noticing
   * that some other sub-mode was selected.
   *
   * And a conversation is not only a thread: "create a deck about Microsoft"
   * belongs to Co-create → Office and "search the web for X" to Co-create →
   * Browser. Picking either from the list has to bring back the mode and the
   * canvas tab as well as the messages, or the second one opens on the first
   * one's work. Sessions recorded before places existed carry the default and
   * so open on the thread, exactly as they used to.
   */
  const openConversation = useCallback(
    (sessionId: string) => {
      setActiveSession(sessionId);
      setAtHome(false);
      goToPlace(sessions.find((session) => session.id === sessionId)?.place ?? DEFAULT_SESSION_PLACE);
    },
    [sessions, goToPlace],
  );

  /** Name a conversation. The list is how one is found again. */
  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      try {
        await call("sessions:rename", { sessionId, title });
      } catch (problem) {
        report(problem);
      }
    },
    [report],
  );

  const chooseMode = useCallback(
    (next: TopMode) => {
      // Only follow the remembered sub-mode when it still belongs to the mode
      // being asked for. Anything else and the switch would land somewhere the
      // user did not ask to go.
      const remembered = subModes[next];
      const usable = remembered !== undefined && SUB_MODES[remembered].mode === next;
      chooseSubMode(usable ? remembered : defaultSubMode(next));
    },
    [chooseSubMode, subModes],
  );

  const closeTab = (id: string): void => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== id);
      setActiveTab((selected) => (selected === id ? (next.at(-1)?.id ?? null) : selected));
      return next;
    });
  };

  /**
   * Close every open tab.
   *
   * Tabs accumulate: a rail destination, a file opened from chat and a
   * secondary surface all land in the same strip, and closing a dozen of them
   * one X at a time is the kind of chore the strip creates and never solves.
   * Nothing is lost — a tab is a view onto state held elsewhere, so this
   * reopens exactly as it was. The canvas falls back to its empty state, which
   * is the same place a fresh project starts.
   */
  const closeAllTabs = (): void => {
    setTabs([]);
    setActiveTab(null);
  };

  /**
   * Start a conversation, optionally saying up front what it is for.
   *
   * The place travels with the create call rather than being reported
   * afterwards, and that is the whole distinction between this and the
   * navigation messages the shell used to send: this one answers a question
   * the user was asked, once, before the conversation exists. It is stamped
   * `chosen` on the privileged side, which outranks every later inference from
   * the tools the agent reaches for — so a conversation started on Office is
   * still an Office conversation after it queries a warehouse.
   *
   * With no place the conversation is left unplaced, exactly as before, and
   * the first governed tool call files it.
   */
  const newSession = async (place?: SessionPlace): Promise<void> => {
    try {
      const { sessionId } = await call("sessions:create", {
        ...(place === undefined ? {} : { place }),
      });
      setActiveSession(sessionId);
      setAtHome(false);
      if (place !== undefined) goToPlace(place);
    } catch (problem) {
      report(problem);
    }
  };

  /**
   * Deleting a conversation is a rail action, so it must leave the rail open:
   * the user is managing a list and almost always deletes more than one.
   */
  const deleteSession = useCallback(
    async (id: string): Promise<void> => {
      try {
        await call("sessions:delete", { sessionId: id });
        setSessions((current) => {
          const next = current.filter((session) => session.id !== id);
          setActiveSession((selected) =>
            selected === id
              ? (next.find((session) => session.origin === "interactive")?.id ??
                next[0]?.id ??
                null)
              : selected,
          );
          return next;
        });
      } catch (problem) {
        report(problem);
      }
    },
    [report],
  );

  const bindProject = useCallback(
    async (id: string | null) => {
      try {
        await call("projects:bind", { projectId: id });
        await refreshProjects();
      } catch (problem) {
        report(problem);
      }
    },
    [refreshProjects, report],
  );

  const interactive = useMemo(
    () => sessions.filter((session) => session.origin === "interactive"),
    [sessions],
  );
  /**
   * Scheduled runs only.
   *
   * `sub_agent` sessions are deliberately absent. A council round, a research
   * question and a Fabric build each run their member turns as their own
   * session, so one council produces a dozen of them; they are the inside of a
   * run rather than something a person opens, the surface that started them
   * already shows their output, and every one of them is in the audit log.
   * Listing them here buries the user's own conversations under machinery.
   */
  const unattended = useMemo(
    () => sessions.filter((session) => session.origin === "scheduled"),
    [sessions],
  );

  /**
   * Which panes this mode uses. Control Center has no project navigator: its
   * right pane is an inspector for the selected record, because nothing there
   * is authored against the filesystem.
   *
   * Chat is always exactly one pane. It is the deliberately minimal surface —
   * conversation and nothing competing with it — and a canvas that appeared
   * the moment a bottom-rail destination was opened made it the one mode whose
   * shape changed under the reader. Those destinations open in Co-create's
   * canvas, which is where a canvas belongs.
   *
   * The open surface then subtracts from that: see {@link SURFACE_HIDES_PANES}.
   * The shape follows what is on the canvas rather than only the mode, because
   * two of the destinations are about the frame — the identity and the bound
   * project — rather than about work done inside it.
   */
  const current = tabs.find((tab) => tab.id === activeTab) ?? null;

  /**
   * Whether the rail should mark this sub-mode as where the reader is.
   *
   * `subMode` is the mode's *last chosen* sub-mode and it survives navigating
   * away, so asking it alone marked two rows at once: opening IQ Knowledge —
   * which is a canvas tab, not a sub-mode — left IQ Workflow lit as well, and
   * the rail claimed the reader was in two places. Outside Chat the canvas tab
   * is the answer, because that is the thing actually on screen. Chat has no
   * canvas, so there `subMode` is all there is; Home is its own destination, so
   * Conversation is not also lit while the landing page is showing.
   */
  const isCurrentSubMode = (candidate: SubMode): boolean => {
    if (SUB_MODES[candidate].mode === "chat") {
      return subMode === candidate && !(candidate === "conversation" && atHome);
    }
    return activeTab === `sub:${candidate}`;
  };

  /**
   * Whether the rail should mark Control Center as where the reader is.
   *
   * Same rule as {@link isCurrentSubMode}, for the same reason: asking `mode`
   * marked two rows at once. Opening Projects from inside Control Center is a
   * canvas tab and leaves the mode alone, so the rail lit both. The tab on
   * screen is the answer — Control Center is where the reader is only while one
   * of its destinations is the tab being shown.
   */
  const inControlCenter =
    current?.kind === "submode" &&
    current.subMode !== undefined &&
    SUB_MODES[current.subMode].mode === "control";

  const visiblePanes = useMemo<PaneId[]>(() => {
    const base: PaneId[] =
      mode === "chat"
        ? ["chat"]
        : mode === "cocreate"
          ? ["chat", "canvas", "navigator"]
          : mode === "flow" || mode === "hub"
            ? ["canvas"]
            : ["canvas", "inspector"];

    // A canvas tab may only subtract panes while the canvas is on screen.
    // Chat has no canvas, so the tab left open by Co-create is not visible —
    // and letting it hide the chat pane emptied the window, because chat is
    // Chat's only pane. That is the whole of "switching back to Chat shows
    // nothing": the tab was Image Creation, Research, Skill Recording,
    // Connections or Projects, each of which declares `hidesPanes: ["chat"]`.
    if (!base.includes("canvas")) return base;

    const suppressed =
      current?.kind === "surface" && current.surface !== undefined
        ? SURFACE_HIDES_PANES(current.surface)
        : current?.kind === "submode" && current.subMode !== undefined
          ? SUBMODE_HIDES_PANES(current.subMode)
          : [];
    return suppressed.length === 0 ? base : base.filter((pane) => !suppressed.includes(pane));
  }, [mode, current]);

  const panes = usePaneLayout(visiblePanes, projectId ?? "unbound");

  /*
   * The shell does not record where a conversation is held, and must not.
   *
   * It used to: whenever the mode, sub-mode or canvas tab changed with a
   * conversation selected, it reported the new view as that conversation's
   * place. Every one of those writes is ambiguous — selecting a conversation
   * and then looking at another tab is not a statement about where the
   * conversation belongs, and there is no signal here that distinguishes the
   * two. On a real profile it produced nine records for one deck conversation
   * (fabric, image, image/meetings, image/browser, research, image, office,
   * fabric, research), so the correct answer was written seventh and then
   * buried by two more clicks, and the rail restored Research.
   *
   * Placement now belongs entirely to the privileged side, which infers it
   * from what the conversation actually did. That is a fact about the
   * conversation rather than about the window, so it holds whether the user
   * watched the turn, walked away, or never opened the tab at all.
   */

  const hasConversation = activeSession !== null && interactive.length > 0;
  const activeProject = projects.find((project) => project.id === projectId) ?? null;

  /**
   * The name of the place the reader is in, for the breadcrumb.
   *
   * Two levels, never more. A trail of four is a trail nobody reads, and the
   * only question the bar has to answer is "where am I, and how do I get
   * back" — Home is the way back, this is the where.
   *
   * Chat is answered by its sub-mode rather than by the canvas tab. Chat has
   * no canvas, so `current` there is whichever tab Co-create left open, and
   * naming it would put a place on screen that is not the place you are in.
   * At Home there is no second level: Home is already the whole answer.
   */
  const place =
    mode === "chat"
      ? atHome
        ? null
        : SUB_MODES[subMode].label
      : (current?.label ?? MODE_LABELS[mode]);

  /**
   * The history, as data rather than as markup.
   *
   * It used to be four blocks of JSX inside the rail, directly under four more
   * blocks that looked exactly the same and did something else entirely. That
   * is the whole complaint: a destination and a conversation were the same row,
   * so the reader had to know the app to tell navigation from their own work.
   *
   * Built once here and rendered in two places — the Home page and the History
   * flyout — because a list that exists twice is a list that disagrees with
   * itself. The groups are the same four as before; only where they are drawn
   * and how they look have changed.
   */
  const historyGroups = useMemo<HistoryGroup[]>(() => {
    const groups: HistoryGroup[] = [];
    const inThread = mode === "chat" || mode === "cocreate";

    if (inThread && interactive.length > 0) {
      groups.push({
        id: "conversations",
        label: "Conversations",
        rows: interactive.map((session) => ({
          id: session.id,
          icon: MessageSquare,
          label: session.title,
          active: session.id === activeSession && !atHome,
          onOpen: () => openConversation(session.id),
          onRename: (title: string) => renameSession(session.id, title),
          onDelete: () => deleteSession(session.id),
        })),
      });
    }

    // Councils sit with the conversations because that is what they are: a
    // question the user asked, answered by several members instead of one.
    if (mode === "chat" && councilRuns.length > 0) {
      groups.push({
        id: "councils",
        label: "Councils",
        rows: councilRuns.map((run) => ({
          id: run.id,
          icon: Users,
          label: councilRunTitle(run),
          detail: run.status,
          active: subMode === "team" && run.id === councilRunId,
          onOpen: () => openCouncilRun(run.id),
          onRename: (title: string) => renameCouncilRun(run.id, title),
          onDelete: () => deleteCouncilRun(run.id),
        })),
      });
    }

    // Each Data agent thread is a question put to the user's own warehouse, and
    // the only way back into one is a row that says so.
    if (mode === "chat" && dataAgentChats.length > 0) {
      groups.push({
        id: "dataagent",
        label: "Data agent",
        rows: dataAgentChats.map((chat) => ({
          id: chat.id,
          icon: Database,
          label: chat.title === "" ? "New conversation" : chat.title,
          detail: `${chat.exchanges.length} question${chat.exchanges.length === 1 ? "" : "s"}`,
          active: subMode === "dataagent" && chat.id === dataAgentChatId,
          onOpen: () => openDataAgentChat(chat.id),
          onDelete: () => deleteDataAgentChat(chat.id),
        })),
      });
    }

    // Unattended runs are listed wherever a conversation list makes sense. IQ
    // Cell is the exception: it carries no conversation at all.
    if (mode !== "flow" && unattended.length > 0) {
      groups.push({
        id: "unattended",
        label: "Unattended",
        rows: unattended.map((session) => ({
          id: session.id,
          icon: Clock,
          label: session.title,
          active: session.id === activeSession,
          onOpen: () => openConversation(session.id),
          onRename: (title: string) => renameSession(session.id, title),
          onDelete: () => deleteSession(session.id),
        })),
      });
    }

    return groups;
  }, [
    activeSession,
    atHome,
    councilRunId,
    councilRuns,
    dataAgentChatId,
    dataAgentChats,
    deleteCouncilRun,
    deleteDataAgentChat,
    deleteSession,
    interactive,
    mode,
    openConversation,
    openCouncilRun,
    openDataAgentChat,
    renameCouncilRun,
    renameSession,
    subMode,
    unattended,
  ]);

  const historyCount = historyGroups.reduce((total, group) => total + group.rows.length, 0);

  /**
   * Both connections are required before the app opens. Foundry models, Work IQ
   * and Microsoft 365 are core rather than optional extras, so deferring the
   * Microsoft connection to first use would mean the product's own surfaces
   * failing mid-turn instead of at the door.
   */
  if (!entered) {
    return <SignIn auth={auth} copilot={copilot} onContinue={() => setEntered(true)} onError={report} />;
  }

  return (
    <div className={`shell${railHidden ? " rail-icons" : ""}`}>
      {HARNESS && (
        <div className="harness-banner" role="status" data-testid="harness-banner">
          E2E harness — the sign-in gate was skipped. No identity is held, so anything needing
          Azure, Microsoft 365 or Copilot will refuse.
        </div>
      )}
      <aside className={`rail${railHidden ? " icons" : ""}`}>
        {/* The mark, at the top of the rail and above everything that moves.

            It is the only fixed point in the window: the mode switch, the
            destinations and the bottom group all change with the mode, and a
            reader needs one thing that does not. No background, no border and
            no shadow — the gradient is the mark, and a plate behind it would
            read as a button. */}
        <div className="rail-brand">
          <Logo size={28} />
          <span className="label">IQ Compiler</span>
        </div>

        {/* Above the mode switch, and above everything else.

            Starting a conversation is the most frequent thing anyone does here
            and it is not a destination — it creates one. Sitting halfway down
            the rail, under whichever mode's surfaces happened to be listed, it
            moved every time the mode changed and read as one more place to go.
            At the top it is a fixed target: the same pixel, in every mode.

            Offered in Chat and Co-create only. The other two modes have no
            chat pane, so a conversation started from them would open somewhere
            the user cannot see it.

            Split, because the two things it does are not the same size. Most
            conversations are just conversations and the fast path has to stay
            one click; the chevron is for the times you already know what this
            one is for, and saying so up front is what keeps the rail from
            re-filing it later. */}
        {(mode === "chat" || mode === "cocreate") && (
          <div className="rail-new-row">
            {/* Home sits with New conversation because both start something.
                The rows below go to a place that already exists; these two
                are the entry, and an entry belongs at the entrance. */}
            {mode === "chat" && (
              <button
                className={`rail-home${subMode === "conversation" && atHome ? " active" : ""}`}
                title="Home — starting points"
                aria-label="Home"
                aria-current={subMode === "conversation" && atHome ? "page" : undefined}
                onClick={() => {
                  setNewMenuOpen(false);
                  goHome();
                }}
              >
                <HomeIcon size={16} aria-hidden="true" />
              </button>
            )}
            <button
              className="rail-new"
              title="New conversation"
              onClick={() => {
                setNewMenuOpen(false);
                void newSession();
              }}
            >
              <Plus size={16} aria-hidden="true" />
              <span>New conversation</span>
            </button>
            {/* The destination picker is dropped in icon form. Its menu is a
                two-column list of names and consequences, and there is no
                honest way to anchor that to a 56px strip. The fast path — a
                plain new conversation — is the one that survives, and the
                picker is one click away by showing the panel. */}
            {!railHidden && (
              <button
                className="rail-new-more"
                aria-haspopup="menu"
                aria-expanded={newMenuOpen}
                aria-label="Choose where this conversation belongs"
                title="Start it somewhere — Office, Fabric, Research, the Browser…"
                onClick={() => setNewMenuOpen((open) => !open)}
              >
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            )}

            {newMenuOpen && !railHidden && (
              <>
                {/* Clicking anywhere else closes it. A transparent sheet rather
                    than a document listener, so the click that dismisses the
                    menu does not also press whatever was underneath it. */}
                <div className="menu-scrim" onClick={() => setNewMenuOpen(false)} />
                <div className="rail-new-menu" role="menu">
                  <p className="context-menu-title">Start this conversation in</p>
                  {CONVERSATION_DESTINATIONS.map((place) => {
                    const destination = describePlace(place);
                    return (
                      <button
                        key={placeKey(place)}
                        role="menuitem"
                        onClick={() => {
                          setNewMenuOpen(false);
                          void newSession(place);
                        }}
                      >
                        <PlaceGlyph icon={destination.icon} mark={destination.mark} size={14} />
                        <span className="label">{destination.label}</span>
                        <span className="detail">{destination.detail}</span>
                      </button>
                    );
                  })}
                  {/* Not a destination in the list above, because it is not a
                      session: a Data agent conversation is a thread on the
                      Fabric service with no turn log behind it, and the
                      privileged side refuses to file a session there. It is
                      offered here anyway because this is where a person looks
                      to start a conversation, and leaving it out was read as
                      the surface having no history at all. */}
                  <div className="menu-separator" role="separator" />
                  <button
                    role="menuitem"
                    onClick={() => {
                      setNewMenuOpen(false);
                      void newDataAgentChat();
                    }}
                  >
                    <Database size={14} aria-hidden="true" />
                    <span className="label">Data agent</span>
                    <span className="detail">A new thread against your data</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* The one control that never collapses.

            Control Center is deliberately not here. The segments name the ways
            work is *done* — talk to one agent, build an artifact, compose a
            cell, meet the cells other people published — and Control Center is
            none of them: it is where that work is governed and configured,
            which is the same kind of thing as the bound project and the
            connections. It sits with those, under the project the governing
            applies to. */}
        <div className="mode-switch" role="tablist" aria-label="Mode">
          {(Object.keys(MODE_LABELS) as TopMode[])
            .filter((candidate) => candidate !== "control")
            .map((candidate) => {
            const Icon = MODE_ICONS[candidate];
            const beta = BETA_MODES.includes(candidate);
            return (
              <button
                key={candidate}
                role="tab"
                aria-selected={mode === candidate}
                className={`mode-segment mode-${candidate}${mode === candidate ? " active" : ""}`}
                title={beta ? `${MODE_LABELS[candidate]} (beta)` : MODE_LABELS[candidate]}
                aria-label={beta ? `${MODE_LABELS[candidate]}, beta` : MODE_LABELS[candidate]}
                onClick={() => chooseMode(candidate)}
              >
                <Icon size={18} aria-hidden="true" />
                <span className="label">
                  {MODE_LABELS[candidate]}
                  {beta && <span className="chip beta small">Beta</span>}
                </span>
              </button>
            );
          })}
        </div>

        {/* Destinations. Fixed height and never scrolled: a mode's own
            surfaces must stay where they are however long the session list
            grows. */}
        <div className="rail-group nav">
          {SUB_MODES_BY_MODE[mode].map((candidate) => (
            <Fragment key={candidate}>
              <RailItem
                icon={SUB_MODE_ICONS[candidate]}
                mark={SUB_MODE_MARKS[candidate]}
                label={SUB_MODES[candidate].label}
                detail={SUB_MODES[candidate].detail}
                beta={isBetaSubMode(candidate)}
                active={isCurrentSubMode(candidate)}
                onClick={() => chooseSubMode(candidate)}
              />
              {/* The rule under My IQ. Everything below it is an input to the
                  thing above it — primers, procedures, facts, compiled cells —
                  and a flat list of five said none of that. A line, not a
                  heading: a heading would name a group, and these are not a
                  group, they are the material one place is made from. */}
              {mode === "flow" && candidate === "connectome" && (
                <hr className="rail-rule" />
              )}
              {/* IQ Knowledge sits directly under IQ Workflow rather than in a
                  group of its own: the index is what a draft is grounded on, so
                  it reads as part of authoring. */}
              {mode === "flow" &&
                candidate === "flow" &&
                IQCELL_SURFACES.map((surface) => (
                  <RailItem
                    key={surface}
                    icon={SURFACE_ICONS[surface]}
                    label={SURFACES[surface].label}
                    detail={SURFACES[surface].detail}
                    beta={SURFACES[surface].beta === true}
                    active={activeTab === `surface:${surface}`}
                    onClick={() => openSurface(surface)}
                  />
                ))}
            </Fragment>
          ))}

          {mode === "cocreate" && (
            <>
              <RailHeading>Surfaces</RailHeading>
              {COCREATE_SURFACES.map((surface) => (
                <RailItem
                  key={surface}
                  icon={SURFACE_ICONS[surface]}
                  label={SURFACES[surface].label}
                  detail={SURFACES[surface].detail}
                  beta={SURFACES[surface].beta === true}
                  active={activeTab === `surface:${surface}`}
                  onClick={() => openSurface(surface)}
                />
              ))}
            </>
          )}

          {/* What the agent is allowed to do, rather than a thing it does:
              the procedures it may load and the third parties whose tools it
              may call. Both are governed, both are read for the same reason
              the audit log is, so both are here. */}
          {mode === "control" && (
            <>
              <RailHeading>Capabilities</RailHeading>
              {CONTROL_SURFACES.map((surface) => (
                <RailItem
                  key={surface}
                  icon={SURFACE_ICONS[surface]}
                  label={SURFACES[surface].label}
                  detail={SURFACES[surface].detail}
                  beta={SURFACES[surface].beta === true}
                  active={activeTab === `surface:${surface}`}
                  onClick={() => openSurface(surface)}
                />
              ))}
            </>
          )}
        </div>

        <div className="rail-group bottom">
          {/* The way back into your own work.
              
              The rail lists places; this opens the things you made. Keeping
              them apart is the point — they were the same column of identical
              rows, and the reader had to already know the app to tell a
              destination from a conversation. */}
          {(mode === "chat" || mode === "cocreate") && (
            <RailItem
              icon={HistoryIcon}
              label="History"
              detail={
                historyCount === 0
                  ? "Nothing yet"
                  : `${historyCount} conversation${historyCount === 1 ? "" : "s"} and runs`
              }
              active={historyOpen}
              onClick={() => setHistoryOpen(!historyOpen)}
            />
          )}
          {/* The bound project comes first: it is the thing every other
              destination acts on, and Control Center is where its rules are
              set rather than where the work is. */}
          <RailItem
            icon={Boxes}
            label="Projects"
            detail={activeProject ? activeProject.name : "No project bound"}
            active={activeTab === "surface:projects"}
            onClick={() => openSurface("projects")}
          />
          <RailItem
            icon={ShieldCheck}
            label="Control Center"
            detail="Automations, plans, audit, skills, MCP servers and sample data"
            active={inControlCenter}
            onClick={() => chooseMode("control")}
          />
          <RailItem
            icon={KeyRound}
            label="Connections & access"
            active={activeTab === "surface:connections"}
            onClick={() => openSurface("connections")}
          />
          <RailItem
            icon={theme === "light" ? Moon : Sun}
            label={theme === "light" ? "Dark theme" : "Light theme"}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          />
          {/* One control, both directions. It sits in the same row of the same
              group either way, so the way back is where the way out was — and
              in icon form it is still a labelled, reachable button rather than
              something floating over the workbench. */}
          <RailItem
            icon={railHidden ? PanelLeftOpen : PanelLeftClose}
            label={railHidden ? "Show Panel" : "Hide Panel"}
            onClick={() => setRailHidden(!railHidden)}
          />
        </div>
      </aside>

      {/* The flyout, not a column.
          
          History has to be reachable without leaving what you are doing, or
          moving it out of the rail would turn every resume into a trip through
          Home. It overlays rather than pushes: the work keeps its width, and
          nothing reflows when it opens or closes.
          
          It stays open until it is dismissed. There is no scrim, so the rail
          and the work under it stay clickable — and a row can be double-clicked
          to rename it, which a close-on-click panel makes impossible. */}
      {historyOpen && (mode === "chat" || mode === "cocreate") && (
        <div
          className="history-flyout"
          role="dialog"
          aria-label="History"
          onKeyDown={(event) => {
            if (event.key === "Escape") setHistoryOpen(false);
          }}
        >
          <div className="history-flyout-head">
            <strong>History</strong>
            <button
              className="rail-action"
              title="Close history"
              aria-label="Close history"
              onClick={() => setHistoryOpen(false)}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <ConversationList
            groups={historyGroups}
            empty="Nothing here yet. Start a conversation and it will be listed here."
          />
        </div>
      )}

      {/* Where you are, and the way back.

          The rail says what the places are; this says which one you are in.
          Two levels: Home, then here. Home is a button in every mode because
          getting out is the one thing that must never depend on where you got
          stuck.

          A sibling of the workbench rather than a child of it. The shell is a
          grid — the rail spans both rows, this is the top of the second
          column, the work is under it — so the bar spans every pane without
          becoming any one pane's header, and the workbench stays the sole
          owner of pane layout.

          Nothing else lives here. Starting a conversation is the rail's job
          and it is already the first control in it; a second New chat in the
          opposite corner was the same action twice, and a breadcrumb that
          also carries an action stops reading as a statement of where you
          are. */}
      <header className="topbar">
        <nav className="trail" aria-label="Breadcrumb">
          <button
            className="crumb"
            onClick={() => {
              chooseMode("chat");
              goHome();
            }}
            aria-current={place === null ? "page" : undefined}
          >
            Home
          </button>
          {place !== null && (
            <>
              <span className="sep" aria-hidden="true">
                /
              </span>
              <span className="here" aria-current="page" title={place}>
                {place}
              </span>
            </>
          )}
        </nav>
      </header>

      <div
        className={`workbench ${mode}${panes.layout.single ? " single" : ""}`}
        ref={panes.containerRef}
      >
        {visiblePanes.includes("chat") && !panes.isHidden("chat") && (
          <>
            <section
              className="pane chat"
              style={
                visiblePanes.includes("canvas") ? { width: panes.widthOf("chat") } : undefined
              }
            >
              {error && (
                <div className="error" onClick={() => setError(null)}>
                  {error} (click to dismiss)
                </div>
              )}
              {mode === "chat" && subMode === "team" ? (
                <Council
                  sessionId={activeSession}
                  projectId={projectId}
                  onError={report}
                  focusRunId={councilRunId}
                  onSelectRun={setCouncilRunId}
                  onDeleted={(runId) => {
                    setCouncilRuns((current) => current.filter((run) => run.id !== runId));
                    setCouncilRunId((current) => (current === runId ? null : current));
                  }}
                />
              ) : mode === "chat" && subMode === "dataagent" ? (
                <DataAgent
                  chats={dataAgentChats}
                  activeId={dataAgentChatId}
                  onNewConversation={newDataAgentChat}
                  onExchange={recordDataAgentExchange}
                  onError={report}
                  onOpenConnections={() => openSurface("connections")}
                />
              ) : mode === "chat" && subMode === "research" ? (
                <Research projectId={projectId} onError={report} />
              ) : mode === "chat" && (atHome || !hasConversation) ? (
                <Home
                  auth={auth}
                  project={activeProject}
                  history={historyGroups}
                  onStart={() => void newSession()}
                  onOpenSurface={openSurface}
                  onChooseSubMode={chooseSubMode}
                />
              ) : (
                <Chat
                  sessionId={activeSession}
                  auth={auth}
                  projectId={projectId}
                  attach={attachment}
                  prompt={chatPrompt}
                  onError={report}
                />
              )}
            </section>
            {visiblePanes.includes("canvas") && (
              <PaneDivider
                label="Resize chat and canvas"
                onPointerDown={(event) => panes.startDrag("chat", event)}
              />
            )}
          </>
        )}

        {visiblePanes.includes("canvas") && (
          <section className="pane canvas">
            <div className="canvas-tabs" role="tablist" aria-label="Open surfaces">
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  role="tab"
                  aria-selected={tab.id === activeTab}
                  className={`canvas-tab${tab.id === activeTab ? " active" : ""}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <span className="name">{tab.label}</span>
                  {tab.beta === true && <span className="chip beta small">Beta</span>}
                  <button
                    className="close"
                    title={`Close ${tab.label}`}
                    aria-label={`Close ${tab.label}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(tab.id);
                    }}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              ))}
              {tabs.length > 1 && (
                <>
                  <span className="spacer" />
                  <button
                    className="close-all"
                    title={`Close all ${tabs.length} tabs`}
                    aria-label={`Close all ${tabs.length} tabs`}
                    onClick={closeAllTabs}
                  >
                    <XSquare size={14} aria-hidden="true" />
                    <span>Close all</span>
                  </button>
                </>
              )}
            </div>

            {current ? (
              <SurfaceBoundary key={current.id} label={current.label}>
                <CanvasContent
                  tab={current}
                  auth={auth}
                  projectId={projectId}
                  sessionId={activeSession}
                  onError={report}
                  onOpenFile={openFile}
                  onOpenSurface={openSurface}
                  onChooseSubMode={chooseSubMode}
                  onBindProject={(id) => void bindProject(id)}
                  officeChange={officeChange}
                  focus={focus}
                  onOpenCell={openIqCell}
                  onAskInChat={askInChat}
                />
              </SurfaceBoundary>
            ) : (
              <CanvasEmpty
                mode={mode}
                project={activeProject}
                onOpenProjects={() => openSurface("projects")}
              />
            )}
          </section>
        )}

        {visiblePanes.includes("navigator") && !panes.isHidden("navigator") && (
          <>
            <PaneDivider
              label="Resize canvas and project"
              onPointerDown={(event) => panes.startDrag("navigator", event)}
            />
            <section className="pane navigator" style={{ width: panes.widthOf("navigator") }}>
              <Navigator
                onOpenFile={openFile}
                onAddFileToChat={addFileToChat}
                touchedPath={officeChange?.generating === true ? officeChange.path : null}
                onError={report}
              />
            </section>
          </>
        )}

        {visiblePanes.includes("inspector") && !panes.isHidden("inspector") && (
          <>
            <PaneDivider
              label="Resize canvas and details"
              onPointerDown={(event) => panes.startDrag("inspector", event)}
            />
            <section className="pane inspector" style={{ width: panes.widthOf("inspector") }}>
              <div className="pane-header">
                <span className="pane-title">Details</span>
              </div>
              {/* Control Center's destinations portal their inspector content
                  here, so the selected record is explained beside the list
                  rather than pushing it out of view. */}
              <div className="pane-body detail-panel" id="control-inspector" />
            </section>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Containment for one canvas surface.
 *
 * React unmounts the entire tree when a render throws, so a single bad surface
 * used to take the window with it — opening Control Center blanked the app
 * because one destination read a channel's payload as the wrong shape. A
 * boundary per surface turns that into a message inside the tab the user can
 * close, and leaves the rail, the tab strip and every other pane standing.
 */
class SurfaceBoundary extends Component<
  { label: string; children: React.ReactNode },
  { error: string | null }
> {
  override state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown): void {
    // The main process log is where a user is asked to look, so a surface
    // failure must not live only in the devtools console.
    console.error("surface failed to render", error);
  }

  override render(): React.ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="pane-body">
        <div className="empty-state">
          <h2>{this.props.label} could not be displayed</h2>
          <p className="muted">{this.state.error}</p>
          <button className="primary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}

/**
 * A resize handle between two adjacent panes. It moves space only between the
 * pane it is attached to and the elastic canvas; every other pane keeps its
 * width exactly.
 */
function PaneDivider({
  label,
  onPointerDown,
}: {
  label: string;
  onPointerDown: (event: React.PointerEvent) => void;
}): JSX.Element {
  return (
    <div
      className="pane-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
    />
  );
}

function RailHeading({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="rail-heading">{children}</div>;
}

function RailItem({
  icon: Icon,
  mark,
  label,
  detail,
  active,
  onClick,
  onDelete,
  onRename,
  beta = false,
}: {
  icon: LucideIcon;
  mark?: string;
  label: string;
  detail?: string;
  active?: boolean;
  beta?: boolean;
  onClick: () => void;
  onDelete?: () => void | Promise<void>;
  onRename?: (title: string) => void | Promise<void>;
}): JSX.Element {
  // Destructive actions arm on the first click and commit on the second, so a
  // mis-click never loses a conversation and no blocking dialog is needed. The
  // armed state expires on its own: disarming on pointer-leave used to fire the
  // instant the icon swapped — removing the hovered <svg> makes the browser
  // emit a pointerout with a null relatedTarget, which React reports as a leave
  // on the row — so the button re-disarmed on every click and never committed.
  const [armed, setArmed] = useState(false);
  /** The draft title while the row is being renamed, or null when it is not. */
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  if (draft !== null && onRename !== undefined) {
    const commit = (): void => {
      const next = draft.trim();
      setDraft(null);
      // An empty name is a cancel, not a rename to nothing: the row has to keep
      // something to be found by.
      if (next !== "" && next !== label) void onRename(next);
    };
    return (
      <div className="rail-row">
        <input
          className="rail-rename"
          autoFocus
          value={draft}
          aria-label={`Rename ${label}`}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setDraft(null);
          }}
        />
      </div>
    );
  }

  // The detail is clamped to one line, so the tooltip carries it in full. It is
  // a supplement, not a replacement: the line is on screen either way, and hover
  // only recovers the tail of the long ones.
  const named = beta ? `${label} (beta)` : label;
  const item = (
    <button
      className={`rail-item${active ? " active" : ""}`}
      title={detail === undefined ? named : `${named}\n${detail}`}
      aria-label={beta ? `${label}, beta` : label}
      onClick={onClick}
      onDoubleClick={onRename === undefined ? undefined : () => setDraft(label)}
    >
      <span className="glyph">
        <PlaceGlyph icon={Icon} mark={mark} />
      </span>
      <span className="label">
        {label}
        {beta && <span className="chip beta small">Beta</span>}
        {detail !== undefined && <span className="detail">{detail}</span>}
      </span>
    </button>
  );

  if (onDelete === undefined && onRename === undefined) return item;

  const actionLabel = armed ? `Confirm delete ${label}` : `Delete ${label}`;

  return (
    <div className="rail-row">
      {item}
      {onRename !== undefined && (
        <button
          className="rail-action"
          title={`Rename ${label}`}
          aria-label={`Rename ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            setDraft(label);
          }}
        >
          <Pencil size={16} aria-hidden="true" />
        </button>
      )}
      {onDelete !== undefined && (
        <button
          className={`rail-action${armed ? " armed" : ""}`}
          title={actionLabel}
          aria-label={actionLabel}
          onClick={(event) => {
            // The rail stays put: this acts on the list, it does not navigate.
            event.stopPropagation();
            if (!armed) {
              setArmed(true);
              return;
            }
            setArmed(false);
            void onDelete();
          }}
        >
          {armed ? <Check size={16} aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}

/** One row in the history: a conversation, a council run or a scheduled run. */
interface HistoryRow {
  id: string;
  icon: LucideIcon;
  label: string;
  detail?: string;
  active: boolean;
  onOpen: () => void;
  onRename?: (title: string) => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
}

/** One heading and the rows under it. */
interface HistoryGroup {
  id: string;
  label: string;
  rows: HistoryRow[];
}

/**
 * The user's own work, grouped and searchable.
 *
 * The four groups are the ones the rail used to carry, unchanged. What changed
 * is that they are no longer interleaved with navigation: a row here is
 * something you made, and every row in the rail is somewhere you can go.
 */
function ConversationList({
  groups,
  empty,
  limit,
}: {
  groups: HistoryGroup[];
  empty: string;
  /**
   * Most rows to show per group when nothing is typed. Home sets one because
   * it is a page you land on, not a list you live in; the flyout sets none.
   * Searching lifts it — a filter that only looked at the visible rows would
   * report "nothing matches" about conversations that do.
   */
  limit?: number;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const total = groups.reduce((count, group) => count + group.rows.length, 0);

  // Search appears once there is more than a screenful to scan. Under five
  // rows the eye is faster than the keyboard, and a search box over three
  // items is exactly the clutter this change is removing.
  const searchable = total > 4;

  const shown =
    needle === ""
      ? groups.map((group) => ({
          ...group,
          rows: limit === undefined ? group.rows : group.rows.slice(0, limit),
        }))
      : groups
          .map((group) => ({
            ...group,
            rows: group.rows.filter((row) => row.label.toLowerCase().includes(needle)),
          }))
          .filter((group) => group.rows.length > 0);

  return (
    <div className="conversation-list">
      {searchable && (
        <div className="conversation-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="Search conversations"
            aria-label="Search conversations"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}

      {total === 0 && <p className="conversation-empty">{empty}</p>}
      {total > 0 && shown.length === 0 && (
        <p className="conversation-empty">Nothing matches “{query.trim()}”.</p>
      )}

      {shown.map((group) => (
        <div className="conversation-group" key={group.id}>
          <div className="conversation-heading">
            {group.label}
            {/* The count is the group's true size, not the number of rows
                under it. Six rows headed "Conversations 42" says plainly that
                there are more and where to look; six rows headed
                "Conversations 6" would be a lie. */}
            <span className="count">
              {groups.find((all) => all.id === group.id)?.rows.length ?? group.rows.length}
            </span>
          </div>
          {group.rows.map((row) => (
            <RailItem
              key={row.id}
              icon={row.icon}
              label={row.label}
              detail={row.detail}
              active={row.active}
              onClick={row.onOpen}
              onRename={row.onRename}
              onDelete={row.onDelete}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Chat mode's empty state: a greeting, one entry point and a few starters.
 * Deliberately not a dashboard — a first-time user should be able to work here
 * without learning any other concept.
 */
function Home({
  auth,
  project,
  history,
  onStart,
  onOpenSurface,
  onChooseSubMode,
}: {
  auth: AuthStatus;
  project: ProjectRecord | null;
  history: HistoryGroup[];
  onStart: () => void;
  onOpenSurface: (surface: Surface) => void;
  onChooseSubMode: (subMode: SubMode) => void;
}): JSX.Element {
  // Six of the places worth knowing about on the first screen. Not the whole
  // rail — this is a way in, not a map.
  const starters: SubMode[] = ["team", "research", "office", "image", "dataagent", "record"];

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-orb" aria-hidden="true">
          <span className="orb-core"><Sparkles size={25} /></span>
          <span className="orb-node orb-node-one" />
          <span className="orb-node orb-node-two" />
          <span className="orb-node orb-node-three" />
          <span className="orb-ring orb-ring-one" />
          <span className="orb-ring orb-ring-two" />
        </div>
        <p className="home-kicker"><Sparkles size={14} aria-hidden="true" /> IQ Compiler</p>
        <h1>What are we working on?</h1>
        <p className="lede">
          Ask about your mail, meetings or documents. Anything that sends or changes something
          asks you first.
        </p>
        <button className="primary" onClick={onStart}>
          Start a conversation
        </button>

        <button className="link" onClick={() => onOpenSurface("projects")}>
          {project ? `Working in ${project.name}` : "Work in a project"}
        </button>

        {auth.state !== "signed_in" && (
          <p className="muted" style={{ textAlign: "center" }}>
            Microsoft capabilities stay unavailable until the Azure connection is verified.
          </p>
        )}

        <div className="starters">
          {starters.map((starter) => (
            <button className={`starter starter-${starter}`} key={starter} onClick={() => onChooseSubMode(starter)}>
              <span className="title">
                <PlaceGlyph icon={SUB_MODE_ICONS[starter]} mark={SUB_MODE_MARKS[starter]} size={16} />{" "}
                {SUB_MODES[starter].label}
              </span>
              <span className="detail">{SUB_MODES[starter].detail}</span>
            </button>
          ))}
        </div>

        {/* Picking up where you left off is a starting point too, so it is on
            the page that lists starting points. Absent until there is
            something to list — an empty "Recent" is a promise the first-run
            screen cannot keep. */}
        {history.length > 0 && (
          <div className="home-history">
            <h2>Pick up where you left off</h2>
            <ConversationList groups={history} empty="" limit={6} />
          </div>
        )}
      </div>
    </div>
  );
}

function CanvasEmpty({
  mode,
  project,
  onOpenProjects,
}: {
  mode: TopMode;
  project: ProjectRecord | null;
  onOpenProjects: () => void;
}): JSX.Element {
  if (mode === "cocreate" && !project) {
    return (
      <div className="canvas-empty">
        <strong>Co-create needs a project</strong>
        <span className="muted">
          A project is the directory the agent may read and write, and the scope every artifact,
          skill and memory is bound to.
        </span>
        <button className="primary" onClick={onOpenProjects}>
          Choose a project
        </button>
      </div>
    );
  }

  return (
    <div className="canvas-empty">
      <strong>Nothing open</strong>
      <span className="muted">
        Pick a destination on the left, or open a file from the project.
      </span>
    </div>
  );
}

function CanvasContent({
  tab,
  auth,
  projectId,
  sessionId,
  onError,
  onOpenFile,
  onOpenSurface,
  onChooseSubMode,
  onBindProject,
  officeChange,
  focus,
  onOpenCell,
  onAskInChat,
}: {
  tab: CanvasTab;
  auth: AuthStatus;
  projectId: string | null;
  /** The conversation on screen, for surfaces that keep state per thread. */
  sessionId: string | null;
  onError: (problem: unknown) => void;
  onOpenFile: (path: string) => void;
  onOpenSurface: (surface: Surface) => void;
  onChooseSubMode: (subMode: SubMode) => void;
  onBindProject: (id: string | null) => void;
  /** The most recent OfficeCLI mutation, so the preview follows the agent. */
  officeChange: OfficeChange | null;
  /** What a surface should land on, when something else sent the user to it. */
  focus: SurfaceFocus;
  /** Take the reader to where an IQ Cell came from. */
  onOpenCell: (route: IqCellRoute) => void;
  /** Write a request into the chat composer and go there. Never sends. */
  onAskInChat: (text: string) => void;
}): JSX.Element {
  if (tab.kind === "file" && tab.path !== undefined) {
    return <FileViewer path={tab.path} />;
  }

  if (tab.kind === "submode") {
    switch (tab.subMode) {
      case "office":
        return (
          <Office
            projectId={projectId}
            sessionId={sessionId}
            change={officeChange}
            onError={onError}
            onOpenFile={onOpenFile}
          />
        );
      case "image":
        return (
          <Images
            projectId={projectId}
            onError={onError}
            onOpenModels={() => onOpenSurface("connections")}
          />
        );
      case "record":
        return <Recording onError={onError} />;
      case "fabric":
        return <Fabric onError={onError} onOpenDataAgent={() => onChooseSubMode("dataagent")} />;
      case "industry":
        return <Industry onError={onError} focusPrimerId={focus.primerId} />;
      case "flow":
        return <Flow projectId={projectId} onError={onError} />;
      case "library":
        return (
          <IqCellLibrary projectId={projectId} onError={onError} onOpenCell={onOpenCell} />
        );
      case "connectome":
        return (
          <Connectome projectId={projectId} onError={onError} onOpenCell={onOpenCell} />
        );
      case "hub":
        return (
          <ConnectomeIq
            onError={onError}
            onOpenMyIq={() => onChooseSubMode("connectome")}
            onOpenMcp={() => onOpenSurface("mcp")}
            onAskInChat={onAskInChat}
          />
        );
      case "memories":
        return (
          <MemoriesCenter
            projectId={projectId}
            onError={onError}
            focusMemoryIds={focus.memoryIds}
          />
        );
      case "automations":
        return <AutomationsCenter projectId={projectId} onError={onError} />;
      case "plans":
        return <PlansCenter projectId={projectId} onError={onError} />;
      case "audit":
        return <AuditCenter projectId={projectId} onError={onError} />;
      case "samples":
        return <SamplesCenter projectId={projectId} onError={onError} />;
      case "clean":
        return <CleanCenter sessionId={sessionId} onError={onError} />;
      default:
        return <div className="pane-body" />;
    }
  }

  switch (tab.surface) {
    case "knowledge":
      return (
        <Knowledge
          onError={onError}
          onRevealSource={onOpenFile}
          focusNodeId={focus.knowledgeNodeId}
        />
      );
    case "browser":
      return <BrowserPanel sessionId={sessionId} onError={onError} />;
    case "meetings":
      return <Meetings onError={onError} />;
    case "skills":
      return <Skills onError={onError} />;
    case "mcp":
      // `McpServers` is a card, because it is also mounted inside Connections &
      // access. As a destination of its own it needs the pane chrome every
      // other surface brings, or it sits flush against the pane border with no
      // title over it.
      return (
        <>
          <div className="pane-header">
            <span className="pane-title">MCP servers</span>
            <span className="muted">Third parties whose tools the agent may call</span>
          </div>
          <div className="pane-body">
            <McpServers onError={onError} />
          </div>
        </>
      );
    case "projects":
      return (
        <Projects projectId={projectId} onBindProject={onBindProject} onError={onError} />
      );
    case "connections":
      return <Connections auth={auth} projectId={projectId} onError={onError} />;
    default:
      return <div className="pane-body" />;
  }
}

/**
 * Non-file reach. The project navigator shows the filesystem boundary; this
 * tab is where Microsoft 365, Work IQ, the browser and MCP reach is stated, so
 * the tree is never mistaken for the whole permission story. The model registry
 * lives here and only here: a Foundry deployment is an endpoint plus an
 * identity, which is a connection like any other.
 */
function Connections({
  auth,
  projectId,
  onError,
}: {
  auth: AuthStatus;
  projectId: string | null;
  onError: (problem: unknown) => void;
}): JSX.Element {
  return (
    <>
      <div className="pane-header">
        <span className="pane-title">Connections &amp; access</span>
        <span className="muted">What this app can reach beyond the project files</span>
      </div>
      <div className="pane-body">
        <Identity auth={auth} onError={onError} />
        <Models projectId={projectId} onError={onError} />
        <SpeechConnection onError={onError} />
        <FabricConnection onError={onError} />
        <DataAgentConnection onError={onError} />
        <McpServers onError={onError} />
        <div className="card">
          <h3>Beyond the file tree</h3>
          <p className="muted">
            The project navigator shows what the agent can read or write on disk. Microsoft 365,
            Work IQ, the browser pane and any MCP server are governed separately by the permission
            policy and are never implied by the tree.
          </p>
        </div>
        <RoleDefaults projectId={projectId} onError={onError} />
      </div>
    </>
  );
}

