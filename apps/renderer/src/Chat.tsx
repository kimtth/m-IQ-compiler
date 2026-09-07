import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  canRemember,
  fileReference,
  fileReferences,
  withoutFileReference,
  FILE_REFERENCE_PREFIX,
  type AuthStatus,
  type McpServerRecord,
  type ModelCatalog,
  type ModelCatalogEntry,
  type PermissionDecision,
  type SpeechStatus,
  type ToolCallState,
  type TurnEvent,
  type TurnState,
} from "@iq/shared";
import { call, subscribe } from "./bridge.js";
import {
  answer,
  autoAnswers,
  cardsFor,
  EMPTY_LOG,
  record,
  turnsIn,
  type ApprovalAnswer,
  type ApprovalGroup,
  type TurnEventLog,
} from "./approvals.js";
import { detailOf, summarizeActivity } from "./activity.js";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Eraser,
  Laptop,
  LoaderCircle,
  Mic,
  Paperclip,
  Plus,
  Sparkles,
  User,
  X,
} from "lucide-react";
import { usePushToTalk, useSpeaker } from "./audio.js";
import { MessageBody } from "./markdown.js";
import { ChatMessage } from "./message.js";

export type ApprovalMode = "ask" | "auto_safe";


export interface ChatProps {
  sessionId: string | null;
  auth: AuthStatus;
  projectId: string | null;
  /**
   * A project file to reference, from the navigator's "Add File to Chat".
   * The `nonce` is what makes adding the same file twice work.
   */
  attach?: { path: string; nonce: number } | null;
  /**
   * A request written by another surface, waiting to be finished and sent.
   * The `nonce` is what makes handing the same text over twice work.
   */
  prompt?: { text: string; nonce: number } | null;
  onError: (problem: unknown) => void;
}

export function Chat({
  sessionId,
  auth,
  projectId,
  attach,
  prompt,
  onError,
}: ChatProps): JSX.Element {
  const [turns, setTurns] = useState<TurnState[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [speech, setSpeech] = useState<SpeechStatus | null>(null);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("ask");
  /**
   * Per-turn model override. Empty means the role default, layered as the
   * registry describes: role default → per-project override → this.
   *
   * The picker reads the one registry rather than carrying a list of its own,
   * which is the only way Connections & access and the composer can be
   * guaranteed to agree about what exists.
   */
  const [modelId, setModelId] = useState("");
  const [models, setModels] = useState<ModelCatalogEntry[]>([]);
  /** Configured MCP servers, for the picker under the box. */
  const [mcpServers, setMcpServers] = useState<McpServerRecord[]>([]);
  /**
   * Set when Stop has been pressed and the turn has not ended yet.
   *
   * Stopping is not instant — the turn has to unwind, and delegated work has to
   * be cancelled after it. Without this the button looked identical before and
   * after the press, so a slow stop was indistinguishable from a dead button.
   */
  const [stopping, setStopping] = useState(false);
  const talk = usePushToTalk({
    onTranscript: (text) => setDraft((current) => (current ? `${current} ${text}` : text)),
    onError,
  });
  const speaker = useSpeaker(onError);
  /** Live events, ordered and de-duplicated by the approval queue. */
  const log = useRef<TurnEventLog>(EMPTY_LOG);
  /** Turns already completed before this window started watching. */
  const history = useRef<TurnState[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  /**
   * Put the cursor back in the box.
   *
   * A native `<select>` takes keyboard focus when it is used, and its popup is
   * an OS window rather than part of the page — so after choosing a model the
   * caret was on the picker and typing went nowhere. The composer is where
   * every one of those controls expects the user to go next, so it takes the
   * focus back rather than leaving them to find it.
   */
  const refocus = useCallback(() => composer.current?.focus(), []);

  // Auto-approval expires with the session and with the project binding, so
  // a grant can never outlive the context the user granted it in.
  useEffect(() => {
    setApprovalMode("ask");
  }, [sessionId, projectId]);

  // Voice controls only appear when Azure Speech is actually configured; a
  // dead microphone button is worse than no microphone button.
  useEffect(() => {
    // See SpeechConnection: register the listener before the first read so a
    // main-process `speech:changed` during core startup cannot be missed.
    const stop = subscribe<SpeechStatus>("speech:changed", setSpeech);
    void call("speech:status")
      .then(setSpeech)
      .catch(() => setSpeech({ state: "not_configured", message: "unavailable" }));
    return stop;
  }, []);
  const voice = speech?.state === "ready";

  /**
   * Bring a file the user picked in the navigator into the composer.
   *
   * Added as `file: <project-relative path>` on a line of its own. That
   * syntax is not decoration: {@link fileReferences} is what the privileged
   * side parses, and it reads every referenced file out of the bound project
   * and puts the contents in the turn. Before this the path went in backticked
   * and nothing else happened — the model was handed a filename in a turn that
   * had never opened it, so "add file to chat" added a string.
   *
   * Nothing is read here and nothing is sent: the user still writes the request
   * and presses send, so one click cannot become a disclosure. The line is
   * plain text they can see, edit or delete.
   *
   * Keyed on the nonce, never run-once: the pane is not remounted between
   * additions.
   */
  useEffect(() => {
    if (!attach) return;
    setDraft((current) => {
      const reference = fileReference(attach.path);
      if (current.trim() === "") return `${reference}\n`;
      return current.endsWith("\n") ? `${current}${reference}\n` : `${current}\n${reference}\n`;
    });
  }, [attach]);

  /**
   * Bring a request another surface wrote into the composer.
   *
   * Same rule as an attached file, for the same reason: appended, never sent,
   * never replacing what is already in the box. A surface that could send on
   * the user's behalf would turn one click somewhere else into a turn the user
   * did not write, and a surface that could clear the box would lose whatever
   * they were halfway through typing.
   *
   * Keyed on the nonce, never run-once: the pane is not remounted between
   * handoffs.
   */
  useEffect(() => {
    if (!prompt) return;
    const text = prompt.text.trim();
    if (text === "") return;
    setDraft((current) => (current.trim() === "" ? `${text}\n` : `${current.trimEnd()}\n\n${text}\n`));
    composer.current?.focus();
  }, [prompt]);

  /**
   * The attached files, as chips above the box.
   *
   * Derived from the draft rather than held beside it. The `file:` line is
   * still the only record — it is what the privileged side parses and what the
   * user can type by hand — so a chip is a *view* of a line, and typing the
   * line yourself puts a chip there too. Holding a separate list would give
   * the composer two answers to "what is attached", and the wrong one is the
   * one on screen.
   */
  const attachments = useMemo(() => fileReferences(draft), [draft]);

  const detach = useCallback(
    (path: string) => {
      setDraft((current) => withoutFileReference(current, path));
      refocus();
    },
    [refocus],
  );

  /**
   * Start a reference the user finishes typing.
   *
   * Files normally arrive from the navigator's "Add File to Chat"; this is for
   * the case where the file is not in the tree in front of them. It writes the
   * prefix and nothing else — no dialog, no read — so the same rule holds: the
   * composer never opens a file, it only says which one to open.
   */
  const startReference = useCallback(() => {
    setDraft((current) =>
      current === "" || current.endsWith("\n")
        ? `${current}${FILE_REFERENCE_PREFIX} `
        : `${current}\n${FILE_REFERENCE_PREFIX} `,
    );
    refocus();
  }, [refocus]);

  // The catalogue, for the composer's picker. It follows `models:changed` so a
  // model added in Control Center is offered here without a reload.
  useEffect(() => {
    const read = (catalog: ModelCatalog): void => setModels(catalog.entries);
    void call("models:catalog").then(read).catch(onError);
    return subscribe<ModelCatalog>("models:changed", read);
  }, [onError]);

  /**
   * The configured MCP servers.
   *
   * Read on mount and again whenever the picker is opened. There is no
   * `mcp:changed` push channel, so a server added or approved in Control Center
   * would otherwise be missing from a chat pane that has been open since before
   * it existed. Re-reading on open costs one call at the moment someone is
   * about to look at the list, which is the only moment it has to be right.
   */
  const loadMcp = useCallback(() => {
    void call("mcp:list").then(setMcpServers).catch(onError);
  }, [onError]);

  useEffect(loadMcp, [loadMcp]);

  // "Stopping…" lasts until the turn actually ends, which is what the turn
  // stream reports. Clearing it when the IPC call returns would be wrong: that
  // only says the request was accepted.
  useEffect(() => {
    if (!turns.some((turn) => turn.status === "running")) setStopping(false);
  }, [turns]);

  /**
   * Turn one server on or off.
   *
   * The same global switch Control Center owns, surfaced where it is needed.
   * It is not scoped to this turn, and the label says so — a per-turn scope
   * would be a different thing, and pretending this is one would be a lie the
   * next turn exposes.
   */
  const toggleMcp = useCallback(
    (id: string) => {
      const server = mcpServers.find((candidate) => candidate.id === id);
      if (!server) return;
      void call("mcp:setEnabled", { id, enabled: !server.enabled })
        .then(() => call("mcp:list"))
        .then(setMcpServers)
        .catch(onError);
      refocus();
    },
    [mcpServers, onError, refocus],
  );

  /**
   * A server is only usable when it is on *and* has an approved tool.
   *
   * That is the registry's rule, not this pane's: `setEnabled` refuses a server
   * with no approved tools, and the session is only handed servers that clear
   * both. Counting `enabled` alone would claim a server was live that the model
   * is never offered.
   */
  const mcpOn = useMemo(
    () => mcpServers.filter((server) => server.enabled && server.approvedTools.length > 0).length,
    [mcpServers],
  );

  /**
   * Foundry deployments first.
   *
   * They are the handful of entries someone configured deliberately. Copilot's
   * catalogue is long and advertised rather than configured, so it sits below
   * rather than burying four deliberate entries under forty.
   *
   * Foundry entries are listed but **not selectable**: an interactive turn runs
   * in a Copilot SDK session, and the SDK only knows Copilot model names, so
   * picking one could only ever fail the turn. Shown greyed with the reason on
   * the group, rather than offered and then refused — the same rule the MCP and
   * research surfaces follow.
   */
  const grouped = useMemo(() => {
    const usable = models.filter(
      (entry) =>
        entry.capabilities.includes("chat") &&
        entry.available &&
        (entry.projectIds.length === 0 ||
          (projectId !== null && entry.projectIds.includes(projectId))),
    );
    return {
      deployments: usable.filter((entry) => entry.provider === "foundry"),
      copilot: usable.filter((entry) => entry.provider === "copilot"),
    };
  }, [models, projectId]);

  // An override that is no longer in the catalogue — or one that was never
  // selectable — would silently send to the role default while still claiming
  // to be selected.
  useEffect(() => {
    if (modelId === "") return;
    const entry = models.find((candidate) => candidate.id === modelId);
    if (!entry || entry.provider !== "copilot") setModelId("");
  }, [models, modelId]);

  // The fold, the ordering and the de-duplication all belong to the approval
  // queue: a settlement lost to a duplicate `seq` is what leaves a card nobody
  // can dismiss, so that rule lives beside the rule about showing cards.
  const rebuild = useCallback(() => {
    setTurns(turnsIn(log.current, sessionId, history.current));
  }, [sessionId]);

  useEffect(() => {
    log.current = EMPTY_LOG;
    history.current = [];
    setTurns([]);
    if (!sessionId) return;

    let cancelled = false;
    void (async () => {
      try {
        const restored = await call("sessions:turns", { sessionId });
        if (cancelled) return;
        history.current = restored;
        rebuild();
      } catch (problem) {
        onError(problem);
      }
    })();

    const unsubscribe = subscribe<TurnEvent>("turns:event", (event) => {
      const next = record(log.current, event);
      // Unchanged means a duplicate delivery: nothing to redraw.
      if (next === log.current) return;
      log.current = next;
      rebuild();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId, rebuild, onError]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  // A conversation the user just opened or created is a conversation they are
  // about to type in. Without this, "New conversation" left the caret wherever
  // it happened to be — usually the rail button — and the empty box looked
  // like it was refusing input.
  useEffect(() => {
    if (sessionId) refocus();
  }, [sessionId, refocus]);

  /**
   * Post the queue's answers.
   *
   * *Which* answers a click produces is `answer`'s decision, not this file's —
   * including the `*_always` first-member rule, which is only correct because
   * the broker sweeps the rest in another process. That reasoning used to be a
   * comment here, which is a privileged invariant living in an untrusted
   * component.
   */
  const post = useCallback(
    async (answers: readonly ApprovalAnswer[]): Promise<void> => {
      for (const { turnId, toolCallId, decision } of answers) {
        try {
          await call("sessions:respondToPermission", { turnId, toolCallId, decision });
        } catch (problem) {
          onError(problem);
        }
      }
    },
    [onError],
  );

  const decideBatch = useCallback(
    async (group: ApprovalGroup, decision: PermissionDecision): Promise<void> => {
      await post(answer(group, decision));
    },
    [post],
  );

  // Auto-approval answers on the user's behalf through the same channel as a
  // click, so the decision is recorded in the audit log identically.
  useEffect(() => {
    if (approvalMode !== "auto_safe") return;
    void post(autoAnswers(turns));
  }, [approvalMode, turns, post]);

  const send = async (): Promise<void> => {
    if (!sessionId || draft.trim().length === 0) return;
    setSending(true);
    try {
      await call("sessions:sendMessage", {
        sessionId,
        content: draft.trim(),
        skills: [],
        ...(modelId === "" ? {} : { modelId }),
      });
      setDraft("");
      // Sending with the button moves focus to the button; the next thing the
      // user does is type again.
      refocus();
    } catch (problem) {
      onError(problem);
    } finally {
      setSending(false);
    }
  };

  if (!sessionId) {
    return (
      <div className="pane-body">
        <p className="muted">Create a conversation to begin.</p>
      </div>
    );
  }

  const running = turns.some((turn) => turn.status === "running");
  const groups = cardsFor(turns, approvalMode);

  /**
   * Empty this conversation without discarding it.
   *
   * Deliberately separate from deleting the session in the rail: the user keeps
   * the thread, its title and its place in the list, and simply starts over in
   * it. Guarded by a confirm because the turns are gone for good, and refused
   * while a turn is in flight — clearing under a running turn would leave the
   * runtime answering into a transcript that no longer exists.
   */
  const clearHistory = async (): Promise<void> => {
    if (!sessionId || running || turns.length === 0) return;
    const ok = window.confirm(
      "Clear this conversation's history? The conversation itself is kept — only its messages are removed, and they cannot be recovered.",
    );
    if (!ok) return;
    try {
      await call("sessions:clear", { sessionId });
      log.current = EMPTY_LOG;
      history.current = [];
      setTurns([]);
      // The Clear button only exists while there are turns, so clearing
      // unmounts the control the user just pressed and focus falls to the
      // document — an empty conversation that will not take typing. The next
      // thing they do is write the first message of the new one.
      refocus();
    } catch (problem) {
      onError(problem);
    }
  };

  return (
    <>
      <div className="pane-header">
        <span className="pane-title">Conversation</span>
        {running && <span className="pill">Working…</span>}
        {auth.state !== "signed_in" && <span className="pill warn">Microsoft sign-in needed</span>}
        <div className="spacer" />
        {turns.length > 0 && !running && (
          <button
            className="ghost icon"
            onClick={() => void clearHistory()}
            title="Clear history — keeps the conversation, removes its messages"
            aria-label="Clear history"
          >
            <Eraser size={16} aria-hidden />
          </button>
        )}
        {running && (
          <button
            className="danger"
            disabled={stopping}
            title="Stop this turn. Work already in flight has to unwind first."
            onClick={() => {
              const active = turns.find((turn) => turn.status === "running");
              if (!active) return;
              setStopping(true);
              void call("sessions:stopTurn", {
                turnId: active.turnId,
                reason: "stopped by user",
              }).catch(onError);
            }}
          >
            {stopping ? "Stopping…" : "Stop"}
          </button>
        )}
      </div>

      <div className="messages">
        {turns.length === 0 && (
          <p className="muted">
            Ask about your mail, meetings or documents. Anything that sends or changes
            something will ask you first.
          </p>
        )}

        {turns.map((turn) => (
          <div key={turn.turnId}>
            {turn.messages.map((message, index) => (
              <ChatMessage
                key={`${turn.turnId}:${index}`}
                role={message.role === "user" ? "user" : "agent"}
                name={message.role === "user" ? "You" : "IQ Compiler"}
                icon={message.role === "user" ? User : Sparkles}
                action={
                  voice && message.role !== "user" && message.content.trim().length > 0 ? (
                    <button
                      className="link"
                      onClick={() => {
                        const id = `${turn.turnId}:${index}`;
                        if (speaker.speakingId === id) speaker.stop();
                        else void speaker.speak(id, message.content);
                      }}
                    >
                      {speaker.speakingId === `${turn.turnId}:${index}` ? "Stop" : "Speak"}
                    </button>
                  ) : undefined
                }
              >
                <MessageBody text={message.content} />
              </ChatMessage>
            ))}

            {/* One block for the whole turn's machinery, collapsed to a line.
                Every tool call used to be its own card — twenty of them for one
                request, most saying "No output recorded." */}
            <ActivityLog calls={turn.toolCalls} turnStatus={turn.status} />
          </div>
        ))}

        {groups.map((group) => (
          <ApprovalCard
            key={group.key}
            group={group}
            onDecide={(decision) => void decideBatch(group, decision)}
          />
        ))}

        {turns
          .filter((turn) => turn.status === "failed" && turn.error)
          .map((turn) => (
            <div className="card" key={`${turn.turnId}:error`}>
              <h3>That turn did not finish</h3>
              <div className="muted">{turn.error}</div>
            </div>
          ))}

        <div ref={bottom} />
      </div>

      <div className="composer">
        <div className="composer-box">
          {attachments.length > 0 && (
            <div className="composer-attachments">
              {attachments.map((path) => {
                const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
                return (
                  <span className="attachment-chip" key={path} title={path}>
                    <Paperclip size={12} aria-hidden="true" />
                    <span className="attachment-name">{cut < 0 ? path : path.slice(cut + 1)}</span>
                    {cut > 0 && <span className="attachment-dir">{path.slice(0, cut)}</span>}
                    <button
                      className="icon"
                      aria-label={`Remove ${path}`}
                      title="Remove this file"
                      onClick={() => detach(path)}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          <textarea
            ref={composer}
            value={draft}
            placeholder="Ask about your work…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          {/* One flat toolbar along the bottom of the box, not a row of framed
              widgets. Everything in here changes what *this* turn does; what
              the turn runs under is in the strip below the box. */}
          <div className="composer-actions">
            <div className="composer-pickers">
              <button
                className="composer-tool"
                title="Attach a file — writes a `file:` line you finish"
                aria-label="Attach a file"
                onClick={startReference}
              >
                <Plus size={16} aria-hidden="true" />
              </button>
              <select
                className="composer-picker"
                aria-label="Model"
                value={modelId}
                title="Which model answers this turn"
                onChange={(event) => {
                  setModelId(event.target.value);
                  refocus();
                }}
              >
                <option value="">Default model</option>
                {grouped.deployments.length > 0 && (
                  <optgroup label="Foundry deployments — not available for chat turns" disabled>
                    {grouped.deployments.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.displayName}
                      </option>
                    ))}
                  </optgroup>
                )}
                {grouped.copilot.length > 0 && (
                  <optgroup label="GitHub Copilot">
                    {grouped.copilot.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.displayName}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>

            <div className="composer-submit">
              {voice && (
                /* "Hold to talk" named the gesture and not the feature, so it
                   read as an instruction for something the user had not been
                   told existed. The mic says what it is at a glance, the word
                   says it in text, and the tooltip keeps the gesture. */
                <button
                  className={`composer-tool${talk.recording ? " danger" : ""}`}
                  title="Hold to speak"
                  aria-label="Voice"
                  disabled={talk.transcribing}
                  onMouseDown={() => void talk.start()}
                  onMouseUp={() => void talk.stop()}
                  onMouseLeave={() => {
                    if (talk.recording) void talk.stop();
                  }}
                >
                  {talk.transcribing ? (
                    <LoaderCircle size={14} className="spin" aria-hidden="true" />
                  ) : (
                    <Mic size={14} aria-hidden="true" />
                  )}{" "}
                  {talk.recording ? "Listening…" : talk.transcribing ? "Transcribing…" : "Voice"}
                </button>
              )}
              <button
                className="primary composer-send"
                title="Send — Enter sends, Shift+Enter starts a line"
                aria-label="Send"
                disabled={sending || draft.trim().length === 0}
                onClick={() => void send()}
              >
                <ArrowUp size={16} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        {/* Under the box, because none of it is part of the message. It is the
            standing answer to "where does this run and what will it ask me",
            which a person wants visible while typing and never wants to have
            opened a menu to find. */}
        <div className="composer-status">
          <span
            className="composer-status-item"
            title="The agent loop runs in this app, on this machine. Model calls still go to the provider you picked."
          >
            <Laptop size={12} aria-hidden="true" /> Local
          </span>
          <span className="composer-status-divider" aria-hidden="true" />
          <select
            className="composer-picker"
            aria-label="Approvals"
            value={approvalMode}
            onChange={(event) => {
              setApprovalMode(event.target.value as ApprovalMode);
              refocus();
            }}
          >
            <option value="ask">Ask before every tool</option>
            <option value="auto_safe">Auto-approve read-only tools</option>
          </select>
          {approvalMode === "auto_safe" && (
            <span className="pill warn" title="Expires with this session and project">
              Scoped to this session
            </span>
          )}
          <span className="composer-status-divider" aria-hidden="true" />
          {/* Which MCP servers the model is offered. The value is pinned to the
              summary and every entry is an action, because this is a list of
              switches rather than a choice of one — a native select is the only
              thing in this strip, and a second widget style here would cost
              more than the semantics gain. */}
          <select
            className="composer-picker"
            aria-label="MCP servers"
            title="Which MCP servers the model can call. Choosing one turns it on or off for every conversation."
            value=""
            onMouseDown={loadMcp}
            onFocus={loadMcp}
            onChange={(event) => toggleMcp(event.target.value)}
          >
            <option value="">
              {mcpServers.length === 0 ? "No MCP servers" : `MCP · ${mcpOn} of ${mcpServers.length} on`}
            </option>
            {mcpServers.length === 0 ? (
              <option value="" disabled>
                Add one in Control Center → MCP servers
              </option>
            ) : (
              mcpServers.map((server) => {
                // Offered greyed with the reason rather than offered and then
                // refused: the registry rejects enabling a server that has no
                // approved tool, so choosing it here could only ever fail.
                const ready = server.approvedTools.length > 0;
                return (
                  <option key={server.id} value={server.id} disabled={!ready}>
                    {server.label} ·{" "}
                    {!ready ? "needs an approved tool" : server.enabled ? "on" : "off"}
                  </option>
                );
              })
            )}
          </select>
        </div>
      </div>
    </>
  );
}

/**
 * One pending decision, as a card.
 *
 * The shape is VS Code's tool prompt: a question naming the action, the request
 * itself, then one primary **Allow** with a chevron for the wider answers, and
 * a plain **Deny** beside it. That arrangement is doing real work. Three
 * side-by-side buttons of similar weight ask the reader to compare three
 * options every time, when the answer is almost always the narrow one; putting
 * the narrow answer under the cursor and the standing answers one click further
 * away makes the safe choice the fast one.
 *
 * **Allow for the rest of this conversation is offered only when the policy
 * will keep it.** Session rules are never applied to `external` or
 * `destructive` calls — a fetch or a delete is re-confirmed every time,
 * whatever anyone answered before. The old card offered that button on every
 * request regardless, so choosing it on a web fetch allowed that one call,
 * remembered nothing, and asked again on the next one. Here the item stays
 * visible and disabled, saying why, because a control that vanishes teaches
 * nothing about the rule that removed it.
 */
function ApprovalCard({
  group,
  onDecide,
}: {
  group: ApprovalGroup;
  onDecide: (decision: PermissionDecision) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const many = group.members.length > 1;
  const remembers = canRemember(group.risk);

  const choose = (decision: PermissionDecision): void => {
    setOpen(false);
    onDecide(decision);
  };

  return (
    <div className="card approval">
      <h3>
        Allow {group.toolName}?
        {many && (
          <span className="pill warn" style={{ marginLeft: 8 }}>
            {group.members.length} calls
          </span>
        )}
      </h3>

      {/* One line per distinct request, capped: seventeen summaries is a wall
          of text, and the first few plus a count says the same thing. */}
      {group.summaries.map((summary) => (
        <div key={summary}>{summary}</div>
      ))}
      {group.remaining > 0 && (
        <div className="muted">and {group.remaining} more like this</div>
      )}

      {/* The risks that cannot be taken back get a line saying so, before the
          buttons rather than after them. */}
      {group.risk === "external" && (
        <p className="approval-note">
          This leaves your machine. Whatever it brings back is content, not
          instructions — it can be wrong, and it can be written to mislead the
          agent.
        </p>
      )}
      {group.risk === "destructive" && (
        <p className="approval-note">This cannot be undone.</p>
      )}

      <div className="muted approval-meta">
        {group.toolName} · {group.family} · {group.risk}
        {group.requiredScopes.length > 0 && ` · scopes: ${group.requiredScopes.join(", ")}`}
      </div>

      <div className="row">
        <div className="approval-split">
          <button className="primary" onClick={() => choose("allow")}>
            {many ? `Allow all ${group.members.length}` : "Allow"}
          </button>
          <button
            className="primary approval-more"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="Other ways to answer this"
            title="Answer this one for good, either way"
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronDown size={14} aria-hidden />
          </button>

          {open && (
            <>
              {/* Clicking anywhere else closes it. A transparent sheet rather
                  than a document listener, so the click that dismisses the menu
                  does not also press whatever was underneath it — and on this
                  card, what is underneath is Allow. */}
              <div className="menu-scrim" onClick={() => setOpen(false)} />
              <div className="approval-menu" role="menu">
                <button
                  role="menuitem"
                  disabled={!remembers}
                  onClick={() => choose("allow_always")}
                >
                  <span className="label">Allow for the rest of this conversation</span>
                  <span className="detail">
                    {remembers
                      ? `Every ${group.toolName} call until this conversation ends.`
                      : `A ${group.risk} call is re-confirmed every time, so this cannot be remembered.`}
                  </span>
                </button>
                <div className="menu-sep" role="separator" />
                <button role="menuitem" className="bad" onClick={() => choose("deny_always")}>
                  <span className="label">Never allow in this conversation</span>
                  <span className="detail">
                    Refuse this and every later {group.toolName} call without asking again.
                  </span>
                </button>
              </div>
            </>
          )}
        </div>

        <button className="danger" onClick={() => choose("deny")}>
          {many ? "Deny all" : "Deny"}
        </button>
      </div>
    </div>
  );
}

/**
 * A turn's tool activity as one collapsible block.
 *
 * Collapsed is the default and, for almost every turn, the end of it: while the
 * turn runs the line says what is happening now, and afterwards it says how
 * many steps it took. The answer above it is what the user asked for; the
 * twenty calls that produced it are evidence, and evidence belongs behind a
 * disclosure rather than in front of the reader.
 *
 * Not a `<details>` element. The open state has to survive the re-render that
 * every streamed event causes, and it also has to *not* reset when a step is
 * added — a native `<details>` inside a list that grows underneath it is fine,
 * but the summary line here changes on every tick and React would rebuild it.
 * A button plus `aria-expanded` is the same affordance with state we control.
 */
function ActivityLog({
  calls,
  turnStatus,
}: {
  calls: readonly ToolCallState[];
  turnStatus: TurnState["status"];
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const activity = useMemo(() => summarizeActivity(calls, turnStatus), [calls, turnStatus]);

  if (activity.total === 0) return null;

  const busy = activity.running > 0;
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className={`activity${busy ? " busy" : ""}`}>
      <button
        type="button"
        className="activity-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="activity-icon" aria-hidden>
          {busy ? (
            <LoaderCircle size={13} className="spin" />
          ) : activity.failed > 0 ? (
            <CircleAlert size={13} />
          ) : (
            <Sparkles size={13} />
          )}
        </span>
        <span className="activity-headline">{activity.headline}</span>
        {/* The count only earns its place once it says more than the headline. */}
        {!busy && activity.steps.length > 1 && (
          <span className="activity-count">{activity.steps.length} tools</span>
        )}
        <Chevron size={14} aria-hidden />
      </button>

      {open && (
        <div className="activity-body">
          {activity.steps.map((step) => (
            <div className="activity-step" key={step.key}>
              <div className="activity-step-head">
                <span
                  className={`pill${
                    step.status === "succeeded"
                      ? " ok"
                      : step.status === "failed" || step.status === "denied"
                        ? " bad"
                        : step.status === "awaiting_approval"
                          ? " warn"
                          : ""
                  }`}
                >
                  {step.status === "awaiting_approval" ? "waiting" : step.status}
                </span>
                <strong>{step.label}</strong>
                {step.showFamily && <span className="muted">{step.family}</span>}
                {/* Identical calls are counted, never listed one per row —
                    six of them differ only in which slide they target. */}
                {step.calls.length > 1 && (
                  <span className="activity-count">×{step.calls.length}</span>
                )}
              </div>
              {step.hasDetail && (
                <div className="activity-output">
                  {step.calls.map((one) => {
                    const detail = detailOf(one);
                    if (detail === "") return null;
                    return (
                      <pre key={one.toolCallId} className={one.error ? "bad" : undefined}>
                        {detail}
                      </pre>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
