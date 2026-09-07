import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { BrowserFrame, BrowserInput, BrowserState } from "@iq/shared";
import { call, subscribe } from "./bridge.js";

/**
 * Browser panel.
 *
 * What is drawn here is a picture of a page, never the page. The page runs in a
 * separate browser process driven by Playwright; this component paints the
 * JPEG frames it streams and forwards the user's mouse and keyboard back into
 * it. That is what allows a browser to exist beside `webviewTag: false` and a
 * `default-src 'none'` policy: no remote DOM and no remote script ever enters
 * this document, so a hostile page has nothing here to attack.
 *
 * It also means the user and the agent operate the *same* browser — one
 * process, one profile, one cookie jar — so signing in here signs the agent in
 * too.
 */
export function BrowserPanel({
  sessionId,
  onError,
}: {
  /** The conversation on screen. Its page is the one the pane comes back to. */
  sessionId: string | null;
  onError: (problem: unknown) => void;
}): JSX.Element {
  const [state, setState] = useState<BrowserState | null>(null);
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);

  const surface = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);

  const report = useCallback(
    (visible: boolean) => {
      const box = surface.current?.getBoundingClientRect();
      if (!box) return;
      void call("browser:setBounds", {
        x: Math.round(box.left),
        y: Math.round(box.top),
        width: Math.round(box.width),
        height: Math.round(box.height),
        visible,
      }).catch(onError);
    },
    [onError],
  );

  useEffect(() => {
    // `restore` reads the state and, if this conversation had a page open last
    // time, reopens it. Asking for the state alone left the user staring at a
    // blank pane and retyping a URL every time they came back. Run again when
    // the conversation changes, because each one keeps its own page.
    void call("browser:restore", { sessionId: sessionId ?? "" }).then(setState).catch(onError);
    const offState = subscribe<BrowserState>("browser:changed", setState);
    const offFrame = subscribe<BrowserFrame>("browser:frame", setFrame);
    return () => {
      offState();
      offFrame();
    };
  }, [sessionId, onError]);

  useEffect(() => {
    report(true);

    const onLayoutChange = (): void => report(true);
    const observer = new ResizeObserver(onLayoutChange);
    if (surface.current) observer.observe(surface.current);
    window.addEventListener("resize", onLayoutChange);

    // Unmount means the user switched tabs. Reporting invisibility stops the
    // screencast, so a hidden pane costs nothing and cannot be typed into.
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onLayoutChange);
      report(false);
    };
  }, [report]);

  const send = useCallback(
    (input: BrowserInput) => {
      void call("browser:input", input).catch(onError);
    },
    [onError],
  );

  const go = async (): Promise<void> => {
    if (address.trim().length === 0) return;
    try {
      setState(await call("browser:navigate", { url: address.trim() }));
      setEditing(false);
    } catch (problem) {
      onError(problem);
    }
  };

  const act = async (
    channel:
      | "browser:back"
      | "browser:forward"
      | "browser:reload"
      | "browser:stop"
      | "browser:close",
  ): Promise<void> => {
    try {
      setState(await call(channel));
      if (channel === "browser:close") setFrame(null);
    } catch (problem) {
      onError(problem);
    }
  };

  /**
   * Map a click on the rendered image back to page coordinates.
   *
   * The image is scaled to fit the pane, so the page's own CSS pixels are the
   * only coordinate space the browser will accept.
   */
  const toPage = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const box = image.current?.getBoundingClientRect();
    if (!box || !frame || box.width === 0 || box.height === 0) return { x: 0, y: 0 };
    return {
      x: Math.round((event.clientX - box.left) * (frame.width / box.width)),
      y: Math.round((event.clientY - box.top) * (frame.height / box.height)),
    };
  };

  const button = (code: number): "left" | "middle" | "right" =>
    code === 1 ? "middle" : code === 2 ? "right" : "left";

  const live = frame !== null && (state?.open ?? false);

  if (state && !state.enabled) {
    return (
      <>
        <div className="pane-header">
          <strong>Browser</strong>
        </div>
        <div className="pane-body">
          <div className="card">
            <span className="pill warn">Disabled</span>
            <span className="muted" style={{ marginLeft: 8 }}>
              The built-in browser is switched off by tenant policy.
            </span>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="pane-header">
        <button
          className="icon"
          disabled={!state?.canGoBack}
          onClick={() => void act("browser:back")}
          title="Back"
          aria-label="Back"
        >
          <ArrowLeft className="lucide" size={16} aria-hidden="true" />
        </button>
        <button
          className="icon"
          disabled={!state?.canGoForward}
          onClick={() => void act("browser:forward")}
          title="Forward"
          aria-label="Forward"
        >
          <ArrowRight className="lucide" size={16} aria-hidden="true" />
        </button>
        <button
          disabled={!state?.open}
          onClick={() => void act(state?.loading ? "browser:stop" : "browser:reload")}
        >
          {state?.loading ? "Stop" : "Reload"}
        </button>
        <div style={{ flex: 1 }}>
          <input
            placeholder="https://…"
            value={editing ? address : (state?.url ?? "")}
            onFocus={() => {
              setAddress(state?.url ?? "");
              setEditing(true);
            }}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void go();
              if (event.key === "Escape") setEditing(false);
            }}
          />
        </div>
        <button className="primary" onClick={() => void go()}>
          Go
        </button>
        <button disabled={!state?.open} onClick={() => void act("browser:close")}>
          Close
        </button>
      </div>

      {state?.blocked && <div className="error">Blocked: {state.blocked}</div>}

      <div className="pane-body" style={{ display: "flex", flexDirection: "column", padding: 0 }}>
        <div
          ref={surface}
          style={{
            position: "relative",
            flex: 1,
            minHeight: 200,
            overflow: "hidden",
            background: "var(--surface-sunken)",
          }}
        >
          {live && frame && (
            <>
              <img
                ref={image}
                src={`data:image/jpeg;base64,${frame.data}`}
                alt={state?.title ? `Page: ${state.title}` : "Browser page"}
                draggable={false}
                style={{
                  display: "block",
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                  userSelect: "none",
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  keys.current?.focus();
                  send({
                    kind: "mouse",
                    type: "mousePressed",
                    ...toPage(event),
                    button: button(event.button),
                    clickCount: event.detail || 1,
                  });
                }}
                onMouseUp={(event) => {
                  event.preventDefault();
                  send({
                    kind: "mouse",
                    type: "mouseReleased",
                    ...toPage(event),
                    button: button(event.button),
                    clickCount: event.detail || 1,
                  });
                }}
                onMouseMove={(event) => {
                  send({
                    kind: "mouse",
                    type: "mouseMoved",
                    ...toPage(event),
                    button: "none",
                    clickCount: 0,
                  });
                }}
                onContextMenu={(event) => event.preventDefault()}
                onWheel={(event) => {
                  send({
                    kind: "wheel",
                    ...toPage(event),
                    deltaX: -event.deltaX,
                    deltaY: -event.deltaY,
                  });
                }}
              />
              {/*
                Keyboard capture.

                `pointerEvents: none` is load-bearing: an invisible overlay that
                accepts the mouse would swallow every click before the image saw
                it. Text arrives already composed by the IME and is sent as text
                rather than as key events, because a keycode cannot carry Hangul
                or kana. Only the control keys travel as keys.
              */}
              <textarea
                ref={keys}
                aria-label="Browser page keyboard input"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                style={{
                  position: "absolute",
                  inset: 0,
                  opacity: 0,
                  border: 0,
                  padding: 0,
                  resize: "none",
                  pointerEvents: "none",
                }}
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={(event) => {
                  composing.current = false;
                  if (event.data) send({ kind: "text", text: event.data });
                  event.currentTarget.value = "";
                }}
                onChange={(event) => {
                  if (composing.current) return;
                  const typed = event.target.value;
                  if (typed) send({ kind: "text", text: typed });
                  event.target.value = "";
                }}
                onKeyDown={(event) => {
                  if (composing.current) return;
                  if (!CONTROL_KEYS.has(event.key) && !event.ctrlKey && !event.metaKey) return;
                  event.preventDefault();
                  send({
                    kind: "key",
                    key: event.key,
                    code: event.code,
                    keyCode: event.keyCode,
                    ctrl: event.ctrlKey,
                    alt: event.altKey,
                    shift: event.shiftKey,
                    meta: event.metaKey,
                  });
                }}
              />
            </>
          )}

          {!live && (
            <div style={{ padding: 20 }}>
              {state?.engine === "unavailable" ? (
                <>
                  <span className="pill warn">No browser engine</span>
                  <p className="muted">{state.engineDetail}</p>
                </>
              ) : state?.engine === "starting" ? (
                <p className="muted">Starting the browser…</p>
              ) : (
                <p className="muted">
                  Pages open here. Anything you could reach in an ordinary browser
                  loads, over https only. You and the agent share this browser, so a
                  site you sign in to here stays signed in for the agent.
                </p>
              )}
              {(state?.deniedHosts.length ?? 0) > 0 && (
                <>
                  <p className="muted">Your tenant blocks these hosts:</p>
                  <div className="row">
                    {(state?.deniedHosts ?? []).map((host) => (
                      <span className="pill" key={host}>
                        {host}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** Keys whose keycode is the point, and which no IME will compose. */
const CONTROL_KEYS = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Escape",
]);
