import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Database, Plus, Send, User } from "lucide-react";
import type { DataAgentChat, FabricDataAgentStatus } from "@iq/shared";
import { call } from "./bridge.js";
import { MessageBody } from "./markdown.js";

/**
 * Chat → Data agent.
 *
 * A conversation whose answers come from a Fabric Data Agent instead of a
 * model. It exists as its own surface because until now there was nowhere to
 * *use* one: the only Q&A box lived inside Co-create → Fabric, below the build
 * form, and appeared solely once a Fabric workspace had been registered — so a
 * user who had been handed a published Data Agent URL and nothing else could
 * not reach it at all.
 *
 * Four things about the shape are deliberate.
 *
 * **The transcript is kept.** Questions and answers are written to disk by the
 * main process as they happen, so leaving the surface and coming back — or
 * restarting — shows the conversation that is still shaping the agent's
 * answers. It used to hold them in component state and nothing else, which
 * emptied the screen while the remote thread carried on remembering.
 *
 * **A conversation is a thread.** The conversation id is the session id sent to
 * the agent, so New conversation gets a fresh thread there as well as a fresh
 * pane here. Reopening an old one resumes the thread that produced it.
 *
 * **The list of conversations belongs to the rail, not to this pane.** The pane
 * shows one conversation and takes which one from the shell. A pane that keeps
 * its own history behind a toggle is a history only its author knows how to
 * find, and the rail is already where every other kind of past work is listed.
 *
 * **The answer is untrusted content.** It is rendered as text. Nothing in it is
 * executed, followed, or turned into a tool call, because it is data returned
 * by a service that queried a database other people can write to.
 */

export function DataAgent({
  chats,
  activeId,
  onNewConversation,
  onExchange,
  onError,
  onOpenConnections,
}: {
  /** Every kept conversation, newest activity first. Owned by the shell. */
  chats: DataAgentChat[];
  /** The one being shown, or null before the first has been made. */
  activeId: string | null;
  onNewConversation: () => void | Promise<void>;
  onExchange: (
    chatId: string,
    exchange: { question: string; answer: string; trace: string[]; failed: boolean },
  ) => void;
  onError: (problem: unknown) => void;
  /** Open Connections & access, where a Data Agent is registered. */
  onOpenConnections?: () => void;
}): JSX.Element {
  const [status, setStatus] = useState<FabricDataAgentStatus | null>(null);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const tail = useRef<HTMLDivElement | null>(null);

  const active = chats.find((chat) => chat.id === activeId) ?? null;
  const exchanges = active?.exchanges ?? [];

  const load = useCallback(async () => {
    try {
      setStatus(await call("dataAgent:status"));
    } catch (problem) {
      onError(problem);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  // Follow the conversation down as it grows, the way a chat pane does.
  useEffect(() => {
    tail.current?.scrollIntoView({ block: "end" });
  }, [exchanges.length, asking]);

  const ask = async (): Promise<void> => {
    const asked = question.trim();
    if (asked === "" || activeId === null || status?.state !== "ready") return;

    setAsking(true);
    setQuestion("");
    try {
      const answer = await call("fabric:ask", { question: asked, sessionId: activeId });
      onExchange(activeId, {
        question: asked,
        answer: answer.answer,
        trace: answer.trace,
        failed: false,
      });
    } catch (problem) {
      // Shown in the thread rather than only as a toast: the question it failed
      // for is the context that makes the message readable, and a failure that
      // scrolls away takes its own explanation with it.
      onExchange(activeId, {
        question: asked,
        answer: problem instanceof Error ? problem.message : String(problem),
        trace: [],
        failed: true,
      });
    } finally {
      setAsking(false);
    }
  };

  if (status === null) {
    return (
      <div className="pane-body">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (status.state !== "ready") {
    return (
      <div className="pane-body">
        <div className="empty-state">
          <Database size={20} aria-hidden="true" />
          <h2>
            {status.state === "needs_workspace"
              ? "This Data Agent cannot be addressed yet"
              : "No Fabric Data Agent connected"}
          </h2>
          <p className="muted">{status.message}</p>
          {onOpenConnections && (
            <button className="primary" onClick={onOpenConnections}>
              Open Connections &amp; access
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="pane-header">
        <span className="pane-title">Data agent</span>
        <span className="muted">
          {status.displayName} · {status.mode === "workspace" ? "via workspace" : "published URL"} ·{" "}
          {status.host}
        </span>
        <div className="spacer" />
        <button
          className="ghost icon"
          onClick={() => void onNewConversation()}
          disabled={asking}
          title="New conversation — starts a new Data Agent thread"
          aria-label="New conversation"
        >
          <Plus size={16} aria-hidden />
        </button>
      </div>

      <div className="messages">
        {exchanges.length === 0 && (
          <div className="empty-state">
            <Database size={20} aria-hidden="true" />
            <h2>Ask your data</h2>
            <p className="muted">
              Questions are answered by the Data Agent, which queries the Fabric workspace directly
              with your Azure identity. It sees what you are allowed to see, and every query it ran
              is listed under the answer.
            </p>
            <p className="muted">
              This conversation is kept and listed in the rail under Data agent, so you can leave
              and come back to it. New conversation starts a fresh thread with no memory of this
              one.
            </p>
          </div>
        )}

        {exchanges.map((exchange) => (
          <div key={exchange.id}>
            <div className="msg from-user">
              <div className="who">
                <span className="avatar" aria-hidden>
                  <User size={13} />
                </span>
                You
              </div>
              <div className="bubble">{exchange.question}</div>
            </div>

            <div className="msg from-agent">
              <div className="who">
                <span className="avatar" aria-hidden>
                  <Database size={13} />
                </span>
                Data Agent
              </div>
              <div className={`bubble${exchange.failed ? " notice" : ""}`}>
                {/* MessageBody only creates React text/code/bold elements; it
                    never injects HTML or follows a link. A Data Agent answer
                    is still untrusted content, merely rendered with the same
                    readable conversation grammar as other agent replies. */}
                <MessageBody text={exchange.answer} />
              </div>
              {exchange.trace.length > 0 && (
                <details className="trace" style={{ marginTop: 8 }}>
                  <summary className="muted">Data Agent trace</summary>
                  {exchange.trace.map((line, index) => (
                    <div className="trace-line" key={index}>
                      {line}
                    </div>
                  ))}
                </details>
              )}
            </div>
          </div>
        ))}

        {asking && (
          <div className="msg from-agent">
            <div className="who">
              <span className="avatar" aria-hidden>
                <Database size={13} />
              </span>
              Data Agent
            </div>
            <div className="bubble muted">
              <span className="spinner" aria-hidden /> Running queries. This is a poll, not a
              stream — the answer arrives whole.
            </div>
          </div>
        )}
        <div ref={tail} />
      </div>

      <div className="composer">
        <div className="composer-box">
          <textarea
            rows={2}
            placeholder="How many rows landed in the silver customer table?"
            value={question}
            disabled={asking}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void ask();
              }
            }}
          />
          <div className="composer-actions">
            <span className="muted">
              {activeId === null
                ? "No conversation is open. Start one to ask a question."
                : "Answers are grounded in the connected Fabric Data Agent."}
            </span>
            <div className="spacer" />
            <button
              className="primary composer-send"
              title={
                activeId === null
                  ? "Start a conversation first \u2014 a question is sent under its thread id"
                  : "Ask the Data Agent"
              }
              aria-label="Ask the Data Agent"
              disabled={asking || question.trim() === "" || activeId === null}
              onClick={() => void ask()}
            >
              <Send size={16} aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

