import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import {
  ArrowRight,
  Blocks,
  Brain,
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  EyeOff,
  FileText,
  GitBranch,
  Lightbulb,
  MessageSquarePlus,
  MessagesSquare,
  Network,
  Play,
  Plug,
  Search,
  SendHorizontal,
  Sparkles,
  Tag,
  Terminal,
  User,
  UserRound,
  X,
} from "lucide-react";
import type { MyIqStatus } from "@iq/shared";
import { call } from "../bridge.js";
import { ChatMessage } from "../message.js";
import {
  SHARED_IQS,
  SHARED_IQ_TOOLS,
  SHARED_IQ_TOOL_ARGUMENT,
  SHARED_IQ_TOOL_DETAIL,
  findSharedIqs,
  sharedIqAsk,
  sharedIqChatPrompt,
  sharedIqClientConfig,
  sharedIqServerId,
  sharedIqSuggestions,
  sharedIqToolResult,
  sharedIqTopics,
  useSampleData,
  type SharedIq,
  type SharedIqTool,
} from "../samples/index.js";

/**
 * Connectome IQ (beta) — an org chart for an AI-driven company.
 *
 * My IQ answers "how does my own work hang together". This surface answers the
 * company question: how can several specialized IQs work as one organization?
 * The company is the root, each published IQ is a function, and its IQ Cells
 * are the AI roles that do the work. Any function can still be read over MCP
 * without copying it into this app.
 *
 * It is not under IQ Cell. IQ Cell is where work is compiled into cells; this
 * is where the compiled result meets other people's, which is a different kind
 * of activity and gets its own segment in the mode switch.
 *
 * Two halves, and they are not the same kind of thing, which the surface says
 * rather than hides:
 *
 *  - **Your IQ is real.** It is read from `myiq:status`, which reports the file
 *    the publisher actually wrote. If you have not published, the card says so
 *    and sends you to My IQ.
 *  - **Everyone else's is fixture data.** There is no exchange behind this: no
 *    server, no tenant, no sync. The directory is `SHARED_IQS`, and it follows
 *    the sample-data switch like every other worked example in the app.
 *
 * What is being demonstrated is the shape of the exchange, not the transport.
 * Each entry carries what a real one would carry, because a real one would be
 * the same `MyIqSnapshot` file this app already writes, served by the same five
 * read-only tools `@iq/myiq-mcp` already serves.
 */

/** Six tints, borrowed from the council roster for the same reason. */
const SEAT_COUNT = 6;

/**
 * A publisher, drawn as a person.
 *
 * The directory is a list of *people's* work, and five rows of identical text
 * read as one document with headings. The tint is taken from the owner's name
 * rather than the row position, so filtering or reordering the directory never
 * repaints somebody. Colour is never the only signal — the name is always
 * beside it.
 */
function OwnerAvatar({ name }: { name: string }): JSX.Element {
  const seat = seatOf(name) % SEAT_COUNT;
  return (
    <span className={`iq-hub-avatar seat-${seat}`} aria-hidden="true">
      {initials(name) === "" ? <UserRound size={14} /> : initials(name)}
    </span>
  );
}

/** A small stable hash. Only the bucket matters, so collisions are harmless. */
function seatOf(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) % 100_003;
  }
  return hash;
}

/** First letters of the first two words. Empty when the name has no letters. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => /[a-z]/i.test(part))
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * The counts an IQ carries, each behind its own glyph.
 *
 * The same four numbers used to run together in one grey sentence, which is
 * exactly the shape a reader skips. Split and labelled, they are the fastest
 * way to tell a big IQ from a small one.
 */
function IqStats({
  cells,
  edges,
  memories,
  notes,
}: {
  cells: number;
  edges?: number;
  memories: number;
  notes: number;
}): JSX.Element {
  return (
    <span className="iq-hub-stats">
      <span className="iq-hub-stat" title="IQ Cells">
        <Blocks size={12} aria-hidden="true" />
        {cells} <span className="muted">cells</span>
      </span>
      {edges !== undefined && (
        <span className="iq-hub-stat" title="Couplings found by the analysis">
          <GitBranch size={12} aria-hidden="true" />
          {edges} <span className="muted">couplings</span>
        </span>
      )}
      <span className="iq-hub-stat" title="Approved memories">
        <Brain size={12} aria-hidden="true" />
        {memories} <span className="muted">memories</span>
      </span>
      <span className="iq-hub-stat" title="Published notes">
        <FileText size={12} aria-hidden="true" />
        {notes} <span className="muted">notes</span>
      </span>
    </span>
  );
}

/** The company and its functions, shown as an expandable organization. */
function CompanyOrgChart({
  status,
  directory,
  shown,
  selected,
  selectedCell,
  connected,
  expanded,
  term,
  topic,
  topics,
  onTerm,
  onTopic,
  onSelect,
  onSelectCell,
  onToggleConnection,
  onToggleExpanded,
  onShowAll,
  onHideAll,
  onOpenMyIq,
}: {
  status: MyIqStatus | null;
  directory: readonly SharedIq[];
  shown: readonly SharedIq[];
  selected: string;
  selectedCell: string | null;
  connected: readonly string[];
  expanded: ReadonlySet<string>;
  term: string;
  topic: string;
  topics: readonly string[];
  onTerm: (value: string) => void;
  onTopic: (value: string) => void;
  onSelect: (id: string) => void;
  onSelectCell: (iqId: string, cellName: string) => void;
  onToggleConnection: (id: string) => void;
  onToggleExpanded: (id: string) => void;
  onShowAll: () => void;
  onHideAll: () => void;
  onOpenMyIq: () => void;
}): JSX.Element {
  const roleCount = directory.reduce((total, iq) => total + iq.cells.length, 0);
  const allShown = shown.length > 0 && shown.every((iq) => expanded.has(iq.id));
  const narrowed = term.trim() !== "" || topic !== "";

  return (
    <section className="iq-org" aria-label="AI-driven company organization">
      <div className="iq-org-toolbar">
        <label className="iq-hub-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={term}
            placeholder="Find a specialized IQ, team, owner or AI role"
            aria-label="Search specialized IQs"
            onChange={(event) => onTerm(event.target.value)}
          />
        </label>
        <label className="iq-hub-topic">
          <Tag size={13} aria-hidden="true" />
          <select
            value={topic}
            aria-label="Filter by business topic"
            onChange={(event) => onTopic(event.target.value)}
          >
            <option value="">All business topics</option>
            {topics.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button className="ghost" disabled={shown.length === 0} onClick={allShown ? onHideAll : onShowAll}>
          {allShown ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          {allShown ? "Hide all AI roles" : "Show all AI roles"}
        </button>
        {narrowed && (
          <span className="muted iq-hub-count" role="status">
            {shown.length} of {directory.length} specialized IQs
          </span>
        )}
      </div>

      <div className="iq-org-scroll">
        <div className="iq-org-canvas">
          <CompanyNode
            status={status}
            specialists={directory.length}
            roles={roleCount}
            connected={connected.length}
            onOpenMyIq={onOpenMyIq}
          />

          {shown.length > 0 ? (
            <div className="iq-org-branches" role="tree" aria-label="Specialized IQs">
              {shown.map((iq) => {
                const isOpen = expanded.has(iq.id);
                const isSelected = selected === iq.id;
                const isConnected = connected.includes(iq.id);
                return (
                  <section className="iq-org-branch" role="treeitem" aria-expanded={isOpen} key={iq.id}>
                    <div className={`iq-org-specialist${isSelected ? " active" : ""}${isConnected ? " connected" : ""}`}>
                      <button
                        className="iq-org-specialist-open"
                        onClick={() => onSelect(iq.id)}
                        aria-current={isSelected && selectedCell === null ? "true" : undefined}
                      >
                        <span className="iq-org-specialist-head">
                          <OwnerAvatar name={iq.owner} />
                          <span className="iq-hub-card-title">
                            <span className="chip">Specialized IQ</span>
                            <strong>{iq.name}</strong>
                            <span className="muted">{iq.team} · human sponsor {iq.owner}</span>
                          </span>
                        </span>
                        <span className="muted iq-org-specialist-summary">{iq.summary}</span>
                        <span className="iq-hub-stats">
                          <span className="iq-hub-stat"><Blocks size={12} aria-hidden="true" />{iq.cells.length} <span className="muted">AI roles</span></span>
                          <span className="iq-hub-stat"><Play size={12} aria-hidden="true" />{iq.cells.reduce((sum, cell) => sum + cell.runs, 0)} <span className="muted">runs</span></span>
                        </span>
                      </button>
                      <div className="iq-org-specialist-actions">
                        <button className="iq-hub-connect" aria-pressed={isConnected} onClick={() => onToggleConnection(iq.id)}>
                          {isConnected ? <><Check size={12} aria-hidden="true" /> In company context</> : <><Plug size={12} aria-hidden="true" /> Add to context</>}
                        </button>
                        <button
                          className="ghost iq-org-expand"
                          onClick={() => onToggleExpanded(iq.id)}
                          aria-label={`${isOpen ? "Hide" : "Show"} AI roles in ${iq.name}`}
                        >
                          {isOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                          {isOpen ? "Hide roles" : "Show roles"}
                        </button>
                      </div>
                    </div>

                    {isOpen && (
                      <div className="iq-org-roles" role="group" aria-label={`AI roles in ${iq.name}`}>
                        {iq.cells.map((cell) => (
                          <button
                            className={`iq-org-role${isSelected && selectedCell === cell.name ? " active" : ""}`}
                            key={cell.name}
                            onClick={() => onSelectCell(iq.id, cell.name)}
                          >
                            <span className="iq-org-role-label"><Blocks size={12} aria-hidden="true" /> AI role</span>
                            <strong>{cell.name}</strong>
                            <span className="muted">{cell.does}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="iq-org-empty">
              <p className="muted">No specialized IQ matches this view.</p>
              {narrowed && <button className="link" onClick={() => { onTerm(""); onTopic(""); }}>Clear the search</button>}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function ConnectomeIq({
  onError,
  onOpenMyIq,
  onOpenMcp,
  onAskInChat,
}: {
  onError: (problem: unknown) => void;
  /** Take the reader to My IQ, which is the only place an IQ is published. */
  onOpenMyIq: () => void;
  /** Take the reader to Control Center → MCP servers, where a server is added. */
  onOpenMcp: () => void;
  /** Write a request into the real chat composer and switch to it. Never sends. */
  onAskInChat: (text: string) => void;
}): JSX.Element {
  const samples = useSampleData();
  const [status, setStatus] = useState<MyIqStatus | null>(null);
  /** What was typed into the search box, verbatim. Matching lowercases its own copy. */
  const [term, setTerm] = useState("");
  /** One business topic, or "" for every topic. */
  const [topic, setTopic] = useState("");
  // Start with the organization itself. A specialist detail is supporting
  // information and should not take space until somebody asks to inspect it.
  const [selected, setSelected] = useState("");
  const [selectedCell, setSelectedCell] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(SHARED_IQS[0] === undefined ? [] : [SHARED_IQS[0].id]),
  );
  /**
   * The IQs currently connected, in the order they were connected.
   *
   * A set rather than one, because that is what serving an IQ over MCP buys.
   * An MCP client holds many servers at once, so the useful question is not
   * "what does Dana's IQ say" but "what do these five say" — and the answers
   * differing is the finding. Reading one IQ in the panel and connecting a
   * handful are separate acts, so they are separate state: opening a card to
   * read it does not quietly add a server.
   */
  const [connected, setConnected] = useState<string[]>(
    SHARED_IQS[0] === undefined ? [] : [SHARED_IQS[0].id],
  );

  useEffect(() => {
    call("myiq:status")
      .then(setStatus)
      .catch((problem: unknown) => onError(problem));
  }, [onError]);

  // The shared half is a worked example, so it follows the sample-data switch.
  // Your own IQ does not: it is a file you wrote, and hiding it would be the
  // surface lying about the state of your own machine.
  const directory = useMemo(() => (samples ? SHARED_IQS : []), [samples]);

  /** Offered from what the directory actually carries, so it can never go stale. */
  const topics = useMemo(() => sharedIqTopics(directory), [directory]);

  // A topic the directory stopped carrying would otherwise stay selected and
  // hide everything, with the control showing a value that is no longer in it.
  useEffect(() => {
    if (topic !== "" && !topics.includes(topic)) setTopic("");
  }, [topic, topics]);

  const shown = useMemo(
    () => findSharedIqs(directory, { term, topic }),
    [directory, term, topic],
  );

  // Search changes the chart, not the detail currently being read. Otherwise
  // typing one word could close an AI role mid-sentence.
  const open = directory.find((iq) => iq.id === selected) ?? null;

  // Kept in directory order so the configuration and the answers read the same
  // way twice running, whatever order the cards were pressed in.
  const session = useMemo(
    () => directory.filter((iq) => connected.includes(iq.id)),
    [connected, directory],
  );

  const toggle = useCallback((id: string) => {
    setConnected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  }, []);

  const connectAll = useCallback(() => {
    setConnected(directory.map((iq) => iq.id));
  }, [directory]);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectIq = useCallback((id: string) => {
    setSelected(id);
    setSelectedCell(null);
  }, []);

  const selectCell = useCallback((iqId: string, cellName: string) => {
    setSelected(iqId);
    setSelectedCell(cellName);
  }, []);

  const closeDetail = useCallback(() => {
    setSelected("");
    setSelectedCell(null);
  }, []);

  return (
    <div className="iq-hub">
      <header className="flow-head">
        <span className="flow-title">
          <Network size={16} aria-hidden="true" />
          <strong>Connectome IQ</strong>
        </span>
        <span className="flow-tagline">How an AI-driven company organizes specialized IQ.</span>
        <span className="chip beta">Beta · demo data</span>
        <span className="spacer" />
        {session.length > 0 && (
          <span className="chip">
            <Plug size={11} aria-hidden="true" />
            {session.length} in company context
          </span>
        )}
      </header>

      <div className={`iq-hub-body${open === null ? "" : " detail-open"}`}>
        <CompanyOrgChart
          status={status}
          directory={directory}
          shown={shown}
          selected={selected}
          selectedCell={selectedCell}
          connected={connected}
          expanded={expanded}
          term={term}
          topic={topic}
          topics={topics}
          onTerm={setTerm}
          onTopic={setTopic}
          onSelect={selectIq}
          onSelectCell={selectCell}
          onToggleConnection={toggle}
          onToggleExpanded={toggleExpanded}
          onShowAll={() => setExpanded(new Set(shown.map((iq) => iq.id)))}
          onHideAll={() => setExpanded(new Set())}
          onOpenMyIq={onOpenMyIq}
        />

        {open !== null && (
          <aside
            className="iq-hub-detail iq-org-detail"
            aria-label="Selected specialized IQ"
          >
            <button className="ghost iq-org-detail-close" onClick={closeDetail} aria-label="Close specialized IQ details">
              <X size={15} aria-hidden="true" />
            </button>
            <SharedIqDetail
              iq={open}
              focusCell={selectedCell}
              session={session}
              connected={connected.includes(open.id)}
              allConnected={session.length === directory.length && directory.length > 0}
              onToggle={() => toggle(open.id)}
              onConnectAll={connectAll}
              onOpenMcp={onOpenMcp}
              onAskInChat={onAskInChat}
            />
          </aside>
        )}
      </div>
    </div>
  );
}

/**
 * The root of the org chart. The company itself is a conceptual container;
 * the publication state inside it is real and comes from this device.
 */
function CompanyNode({
  status,
  specialists,
  roles,
  connected,
  onOpenMyIq,
}: {
  status: MyIqStatus | null;
  specialists: number;
  roles: number;
  connected: number;
  onOpenMyIq: () => void;
}): JSX.Element {
  return (
    <article className="iq-org-company">
      <div className="iq-org-company-main">
        <span className="iq-org-company-icon" aria-hidden="true">
          <Building2 size={18} />
        </span>
        <span className="iq-hub-card-title">
          <span className="chip">AI-driven company</span>
          <strong>IQ Contoso</strong>
          <span className="muted">Human-led. Specialized IQ does the repeatable work.</span>
        </span>
      </div>
      <div className="iq-org-company-stats">
        <span><strong>{specialists}</strong><span className="muted">specialized IQs</span></span>
        <span><strong>{roles}</strong><span className="muted">AI roles</span></span>
        <span><strong>{connected}</strong><span className="muted">in context</span></span>
      </div>
      <div className="iq-org-company-foot">
        <span className="muted">
          {status?.published
            ? `${status.name} supplies the company's shared context.`
            : "Publish My IQ to supply the company's shared context."}
        </span>
        <button className="link" onClick={onOpenMyIq}>
          Open My IQ <ArrowRight size={12} aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}

/**
 * One specialized IQ, opened.
 *
 * Four things, in the order somebody reads them: what it is about, what it
 * holds, what it found — with its limits attached, never without — and how to
 * read it from another app. The console at the end is the point of the surface:
 * an IQ is consumed over MCP, so the demonstration has to show a tool call and
 * its result rather than describe one.
 */
function SharedIqDetail({
  iq,
  focusCell,
  session,
  connected,
  allConnected,
  onToggle,
  onConnectAll,
  onOpenMcp,
  onAskInChat,
}: {
  /** The IQ being read. Reading is not connecting, so this may not be in the session. */
  iq: SharedIq;
  /** The AI role selected in the org chart, or null for the specialized IQ itself. */
  focusCell: string | null;
  /** Every connected IQ, in directory order. The console and the config use these. */
  session: readonly SharedIq[];
  connected: boolean;
  allConnected: boolean;
  onToggle: () => void;
  onConnectAll: () => void;
  onOpenMcp: () => void;
  onAskInChat: (text: string) => void;
}): JSX.Element {
  const [copied, setCopied] = useState(false);

  const config = sharedIqClientConfig(session);
  const focused = focusCell === null ? null : iq.cells.find((cell) => cell.name === focusCell) ?? null;

  useEffect(() => {
    setCopied(false);
  }, [config]);

  return (
    <>
      {focused !== null && (
        <div className="card iq-org-role-detail">
          <span className="chip"><Blocks size={11} aria-hidden="true" /> AI role in {iq.name}</span>
          <h3>{focused.name}</h3>
          <p>{focused.does}</p>
          <div className="iq-org-role-facts">
            <span><strong>{focused.runs}</strong><span className="muted">runs</span></span>
            <span><strong>{Math.round(focused.completion * 100)}%</strong><span className="muted">completion</span></span>
            <span><strong>v{focused.version}</strong><span className="muted">approved by {focused.approver}</span></span>
          </div>
          <p className="muted">Declared reach: {focused.reach.join(", ")}</p>
        </div>
      )}
      <div className="card">
        <div className="iq-hub-detail-head">
          <OwnerAvatar name={iq.owner} />
          <span className="iq-hub-card-title">
            <h3>{iq.name}</h3>
            <span className="muted">
              {iq.owner} · {iq.team}
            </span>
          </span>
        </div>
        <p>{iq.summary}</p>
        <span className="chips">
          {iq.topics.map((topic) => (
            <span className="chip" key={topic}>
              {topic}
            </span>
          ))}
        </span>
        <IqStats
          cells={iq.cells.length}
          edges={iq.edgeCount}
          memories={iq.memories.length}
          notes={iq.notes.length}
        />
        <p className="muted">
          <CalendarDays size={12} aria-hidden="true" /> Published {iq.publishedAt} · {iq.windowDays}{" "}
          days of history · analysis <code>{iq.hash}</code>
        </p>
        {/* Reading an IQ does not connect to it. The toggle is repeated here
            because this is where somebody decides they want it — having read
            the summary — and sending them back up to the grid to act on that
            is the kind of errand a surface should not set. */}
        <div className="row">
          <button className="iq-hub-connect" aria-pressed={connected} onClick={onToggle}>
            {connected ? (
              <>
                <Check size={12} aria-hidden="true" /> In company context
              </>
            ) : (
              <>
                <Plug size={12} aria-hidden="true" /> Add to company context
              </>
            )}
          </button>
        </div>
        <div className="row iq-hub-note">
          <Blocks size={14} aria-hidden="true" />
          <span className="muted">
            This specialized IQ is a worked example. The company hierarchy shows how a real
            organization could assign repeatable work to function-specific IQs while a human
            sponsor remains accountable. Nothing here is copied into your library: an IQ is read
            where it lives.
          </span>
        </div>
      </div>

      <div className="card">
        <h3>
          <Blocks size={14} aria-hidden="true" /> IQ Cells
        </h3>
        {iq.cells.map((cell) => (
          <div className="iq-hub-cell" key={cell.name}>
            <span className="iq-hub-cell-head">
              <strong>{cell.name}</strong>
              <span className="chip">v{cell.version}</span>
            </span>
            <span className="muted">{cell.does}</span>
            <span className="iq-hub-stats">
              <span className="iq-hub-stat">
                <Play size={12} aria-hidden="true" />
                {cell.runs} <span className="muted">runs</span>
              </span>
              <span className="iq-hub-stat">
                <span
                  className="iq-hub-meter"
                  role="img"
                  aria-label={`${Math.round(cell.completion * 100)}% completion`}
                >
                  <span style={{ width: `${Math.round(cell.completion * 100)}%` }} />
                </span>
                {Math.round(cell.completion * 100)}% <span className="muted">completion</span>
              </span>
              <span className="iq-hub-stat">
                <UserRound size={12} aria-hidden="true" />
                <span className="muted">approved by</span> {cell.approver}
              </span>
            </span>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>
          <Lightbulb size={14} aria-hidden="true" /> Findings
        </h3>
        {iq.findings.map((finding, index) => (
          <div className="finding" key={finding.title}>
            <span className="iq-hub-finding-head">
              <span className="iq-hub-finding-mark" aria-hidden="true">
                {index + 1}
              </span>
              <strong>{finding.title}</strong>
            </span>
            <span className="muted">{finding.detail}</span>
            <span className="action">
              <ArrowRight size={12} aria-hidden="true" /> {finding.action}
            </span>
          </div>
        ))}
        <h4>
          <EyeOff size={13} aria-hidden="true" /> What this analysis could not see
        </h4>
        <ul className="iq-hub-limits">
          {iq.limits.map((limit) => (
            <li className="muted" key={limit}>
              {limit}
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <div className="row between">
          <h3>
            <Plug size={14} aria-hidden="true" /> Connect over MCP
          </h3>
          <button
            className="ghost"
            disabled={session.length === 0}
            onClick={() => {
              void navigator.clipboard
                .writeText(config)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            <Copy size={14} aria-hidden="true" /> {copied ? "Copied" : "Copy"}
          </button>
        </div>
        {/* One block for every connected IQ, because that is what a client
            configuration is: a map of servers. Serving an IQ over MCP is what
            makes several of them usable at once, so a card that could only
            ever show one would be demonstrating the opposite of the claim. */}
        <p className="muted">
          {session.length === 0
            ? "No specialized IQ is in company context. Add one or more from the org chart — each is a server of its own, and a client holds as many as you give it."
            : `The same stdio server this app publishes your own IQ through, once per IQ, pointed at ${
                session.length === 1 ? "theirs" : "each of theirs"
              }. Five read-only tools each, no way to write anything back.`}
        </p>
        {session.length > 0 && (
          <span className="chips">
            {session.map((entry) => (
              <span className="chip" key={entry.id}>
                <Plug size={11} aria-hidden="true" /> {sharedIqServerId(entry)}
              </span>
            ))}
          </span>
        )}
        {session.length > 0 && <pre className="source">{config}</pre>}
        {/* Three ways out of this card, because reading a config is not the
            goal. Connect the rest, paste it into the app's own registry, or
            hand the whole thing to a conversation and let the model do the
            connecting. None of them grants anything: a server added here still
            has to be inspected and approved, and the chat handoff writes a
            message rather than sending one. */}
        <div className="row iq-hub-actions">
          {!allConnected && (
            <button className="ghost" onClick={onConnectAll}>
              <Plug size={14} aria-hidden="true" /> Connect all
            </button>
          )}
          <button className="ghost" onClick={onOpenMcp}>
            <Plug size={14} aria-hidden="true" />
            {session.length > 1 ? "Add them in MCP servers" : "Add it in MCP servers"}
          </button>
          <button
            className="ghost"
            disabled={session.length === 0}
            onClick={() => onAskInChat(sharedIqChatPrompt(session, ""))}
          >
            <MessageSquarePlus size={14} aria-hidden="true" /> Set this up in chat
          </button>
        </div>
      </div>

      <IqConsole session={session} onAskInChat={onAskInChat} />
    </>
  );
}

/** What one connected IQ answered, and the call that got it. */
interface Reply {
  iqId: string;
  iqName: string;
  server: string;
  tool: SharedIqTool;
  argument: string;
  answer: string;
}

/** One question, and every connected IQ's reply to it. */
interface Turn {
  id: number;
  /** Empty when the tool was picked by hand rather than asked for. */
  question: string;
  replies: Reply[];
}

/**
 * Ask the connected IQs, as a conversation.
 *
 * The console used to be a dropdown, a text box and a Call button, pointed at
 * one IQ. Both halves of that were wrong. Nobody arrives knowing which of five
 * tool names holds the answer, so the form asked the reader to solve the
 * problem before they could ask the question. And an IQ is served over MCP —
 * which is precisely what lets a client hold several at once — so a console
 * that could only ever address one was demonstrating the opposite of the claim.
 *
 * So the question comes first, it goes to every connected server, and each
 * reply is labelled with the server that gave it. Every reply carries the exact
 * call above it — `myiq_get_cell("…")` — because the claim being demonstrated
 * is that this is a tool call, not a chat model. The routing is a keyword match
 * and the surface says so; when it guesses wrong the wrong guess is visible and
 * the tool picker underneath overrides it.
 *
 * Routing is per IQ, not once for the set. "What does X do" is a cell lookup on
 * the IQ that has a cell called X and a list on the ones that do not, and
 * forcing one tool on all of them would turn four honest answers into three
 * wrong ones.
 *
 * Nothing is spawned. Every answer is computed from the published snapshots in
 * this process, in the wording the real server uses.
 */
function IqConsole({
  session,
  onAskInChat,
}: {
  session: readonly SharedIq[];
  onAskInChat: (text: string) => void;
}): JSX.Element {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [tool, setTool] = useState<SharedIqTool>("myiq_list_cells");
  const [argument, setArgument] = useState("");
  const log = useRef<HTMLDivElement | null>(null);

  // The set of servers is what the transcript is a transcript of. Keeping it
  // across a change would leave answers on screen from an IQ that is no longer
  // connected, which is the surface claiming a source it does not have.
  const key = session.map((iq) => iq.id).join(",");
  useEffect(() => {
    setTurns([]);
    setDraft("");
    setTool("myiq_list_cells");
    setArgument("");
  }, [key]);

  useEffect(() => {
    const node = log.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [turns]);

  /** Call one named tool on every connected server. */
  const callAll = useCallback(
    (picked: SharedIqTool, arg: string) => {
      if (session.length === 0) return;
      setTurns((current) => [
        ...current,
        {
          id: current.length + 1,
          question: "",
          replies: session.map((iq) => ({
            iqId: iq.id,
            iqName: iq.name,
            server: sharedIqServerId(iq),
            tool: picked,
            argument: arg,
            answer: sharedIqToolResult(iq, picked, arg),
          })),
        },
      ]);
    },
    [session],
  );

  const ask = useCallback(
    (question: string) => {
      const asked = question.trim();
      if (asked === "" || session.length === 0) return;
      setTurns((current) => [
        ...current,
        {
          id: current.length + 1,
          question: asked,
          replies: session.map((iq) => {
            const routed = sharedIqAsk(iq, asked);
            return {
              iqId: iq.id,
              iqName: iq.name,
              server: sharedIqServerId(iq),
              tool: routed.tool,
              argument: routed.argument,
              answer: sharedIqToolResult(iq, routed.tool, routed.argument),
            };
          }),
        },
      ]);
      setDraft("");
    },
    [session],
  );

  const suggestions = useMemo(() => sharedIqSuggestions(session), [session]);
  const needsArgument = SHARED_IQ_TOOL_ARGUMENT[tool] !== "";
  const last = turns.at(-1) ?? null;
  const many = session.length > 1;
  const target = session.length === 1 ? session[0]!.name : `${session.length} IQs`;

  return (
    <div className="card iq-hub-console">
      <div className="row between">
        <h3>
          <MessagesSquare size={14} aria-hidden="true" />
          {/* Named, not "this IQ". The panel around it is headed with the IQ
              being read, which is not necessarily the one connected — so a
              console saying "this" points at the wrong name half the time. */}
          {session.length === 0
            ? "Ask the connected IQs"
            : many
              ? `Ask these ${session.length} IQs`
              : `Ask ${session[0]!.name}`}
        </h3>
        <button
          className="ghost"
          disabled={session.length === 0}
          onClick={() => onAskInChat(sharedIqChatPrompt(session, last?.question ?? ""))}
          title="Writes the request into the chat composer. It is not sent."
        >
          <MessageSquarePlus size={14} aria-hidden="true" /> Continue in chat
        </button>
      </div>

      <div className="iq-hub-chat" ref={log}>
        {session.length === 0 ? (
          <div className="iq-hub-chat-empty">
            <Plug size={16} aria-hidden="true" />
            <p className="muted">
              No specialized IQ is in company context. Press Add to context on one or more
              functions in the org chart — the question goes to every one of them, and the answers
              differing is the point.
            </p>
          </div>
        ) : turns.length === 0 ? (
          <div className="iq-hub-chat-empty">
            <Terminal size={16} aria-hidden="true" />
            <p className="muted">
              Ask in your own words. The question is matched to one of the five read-only tools by
              keyword — no model runs here — and {many ? "each server" : "the server"} answers with
              the call it picked shown beside it.
            </p>
            <div className="chips">
              {suggestions.map((question) => (
                <button className="chip" key={question} onClick={() => ask(question)}>
                  {question}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((turn) => (
            <div key={turn.id}>
              {turn.question !== "" && (
                <ChatMessage role="user" name="You" icon={User}>
                  {turn.question}
                </ChatMessage>
              )}
              {turn.replies.map((reply) => (
                <ChatMessage role="agent" name={reply.iqName} icon={Sparkles} key={reply.iqId}>
                  <span className="iq-hub-call">
                    <Terminal size={12} aria-hidden="true" />
                    <code>
                      {reply.server} · {reply.tool}(
                      {reply.argument === "" ? "" : `"${reply.argument}"`})
                    </code>
                  </span>
                  <pre className="source">{reply.answer}</pre>
                </ChatMessage>
              ))}
            </div>
          ))
        )}
      </div>

      <div className="mini-composer">
        <input
          value={draft}
          disabled={session.length === 0}
          placeholder={`Ask ${target} a question`}
          aria-label={`Ask ${target} a question`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") ask(draft);
          }}
        />
        <button
          className="primary"
          disabled={draft.trim() === "" || session.length === 0}
          onClick={() => ask(draft)}
        >
          <SendHorizontal size={14} aria-hidden="true" /> Ask
        </button>
      </div>

      {/* The five tools stay reachable by name. The chat box is the front door,
          not a replacement: somebody checking what the server actually exposes
          needs the list, and a wrong keyword guess needs an override. */}
      <div className="iq-hub-direct">
        <label className="field">
          <span>Or call a tool directly</span>
          <select
            value={tool}
            onChange={(event) => {
              setTool(event.target.value as SharedIqTool);
              setArgument("");
            }}
          >
            {SHARED_IQ_TOOLS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {needsArgument && (
          <label className="field">
            <span>{SHARED_IQ_TOOL_ARGUMENT[tool]}</span>
            <input
              value={argument}
              disabled={session.length === 0}
              onChange={(event) => setArgument(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") callAll(tool, argument);
              }}
            />
          </label>
        )}
        <button
          className="ghost"
          disabled={session.length === 0}
          onClick={() => callAll(tool, argument)}
        >
          <Play size={14} aria-hidden="true" />
          {many ? `Call on all ${session.length}` : "Call"}
        </button>
        <span className="muted">{SHARED_IQ_TOOL_DETAIL[tool]}</span>
      </div>
    </div>
  );
}
