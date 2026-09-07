import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Download, ExternalLink, MonitorCheck, RefreshCw, TriangleAlert } from "lucide-react";
import type { OfficeChange, OfficeDocument, OfficePreview, OfficeRender, OfficeStatus } from "@iq/shared";
import { call } from "./bridge.js";

/**
 * Co-create → Office.
 *
 * OfficeCLI is an internal, first-party tool the app discovers or installs; it
 * is never a command line typed by the user. This surface shows the tool state,
 * offers a one-click install when it is missing, and hosts the live preview of
 * the artifact under generation, refreshing on every OfficeCLI mutation.
 *
 * The mutation stream is **not** subscribed to here. It is held by `App`, and
 * arrives as {@link OfficeProps.change}. A surface only exists while its canvas
 * tab is the active one, so a subscription owned here missed every mutation
 * made from Chat — including the one that should have opened this surface in
 * the first place. Taking it as a prop is what lets the preview be *opened by*
 * the event it is meant to display.
 *
 * That stream is global, though, and the preview is not: it belongs to the
 * conversation. A mutation is filed against the conversation that was open when
 * it landed, and selecting a conversation reopens the document it was working
 * on. Without that, two conversations building two artifacts showed whichever
 * one moved last, and going back to the other meant finding it in the list.
 *
 * The returned markup is generated output, not trusted input, so it is rendered
 * inside a sandboxed iframe with no same-origin grant — never injected with
 * dangerouslySetInnerHTML.
 */

interface OfficeProps {
  projectId: string | null;
  /** The conversation this preview belongs to, or null before one is open. */
  sessionId: string | null;
  /** The most recent OfficeCLI mutation, or null before anything has been built. */
  change: OfficeChange | null;
  onError: (problem: unknown) => void;
  /** Open the previewed artifact as a canvas tab, so it lives beside the chat. */
  onOpenFile?: (path: string) => void;
}

export function Office({
  projectId,
  sessionId,
  change,
  onError,
  onOpenFile,
}: OfficeProps): JSX.Element {
  const [status, setStatus] = useState<OfficeStatus>({
    state: "unknown",
    version: "",
    origin: "none",
    message: "",
  });
  const [activePath, setActivePath] = useState("");
  /** Office files already in the project, newest first. */
  const [documents, setDocuments] = useState<OfficeDocument[]>([]);
  const [preview, setPreview] = useState<OfficePreview | null>(null);
  const [rendering, setRendering] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The slide the index has focused, or null for the whole document. */
  const [selected, setSelected] = useState<number | null>(null);
  /** The last true-to-file render, or null while only the fast preview exists. */
  const [render, setRender] = useState<OfficeRender | null>(null);
  const [renderingNative, setRenderingNative] = useState(false);
  /**
   * Pixels the frame may occupy, measured rather than assumed.
   *
   * The sandboxed document cannot fit itself — that is a script — so the fit is
   * computed out here, and it can only be computed from a real measurement: the
   * pane is resizable and the slide index takes a fixed 200px out of it.
   *
   * A **callback ref**, not `useRef` + a mount effect. The stage does not exist
   * until a preview arrives, so an effect with `[]` deps runs while the ref is
   * still null, attaches nothing, and never runs again — leaving the width at 0
   * and the fit at 1, which draws the frame at the slide's full 1280px and cuts
   * the right-hand third off every slide. A callback ref fires when the node
   * appears, which is the event we actually care about.
   */
  const [stageWidth, setStageWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const stage = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (node === null) return;
    setStageWidth(node.clientWidth);
    const next = new ResizeObserver(([entry]) => {
      if (entry) setStageWidth(entry.contentRect.width);
    });
    next.observe(node);
    observer.current = next;
  }, []);
  /** A render is in flight; a change that arrives meanwhile is remembered here. */
  const inFlight = useRef(false);
  const queued = useRef<string | null>(null);
  /** Paths the document list already knows, so a mutation only re-lists new ones. */
  const known = useRef(new Set<string>());
  /**
   * The last mutation acted on, so a re-render is not mistaken for a new one.
   *
   * `undefined` until the first render: a mutation already on screen when this
   * surface mounts happened before, and belongs to whoever was here then.
   */
  const handledChange = useRef<OfficeChange | null | undefined>(undefined);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await call("office:status"));
    } catch (problem) {
      onError(problem);
    }
  }, [onError]);

  /**
   * Render one frame, then immediately render again if the document moved on.
   *
   * A trailing coalesce, not a queue. Six slides arrive as six mutations, and
   * rendering each one in turn means the preview is still drawing slide two
   * when the deck is finished — every frame but the last is work nobody sees.
   * Collapsing to "render the newest state as soon as the current render ends"
   * costs at most one stale frame and always converges on what is actually on
   * disk.
   *
   * A render that comes back with a `problem` is *not* an error: a half-built
   * document is routinely not renderable. The last good frame stays on screen
   * and the note is shown beside it, so a healthy build does not look broken.
   */
  const loadPreview = useCallback(
    async (path: string) => {
      if (path === "") return;
      if (inFlight.current) {
        queued.current = path;
        return;
      }
      inFlight.current = true;
      setRendering(true);
      try {
        for (;;) {
          const next = await call("office:preview", { path, format: "html" });
          setPreview((current) =>
            next.problem !== "" && current !== null
              ? // Keep the last readable frame; adopt everything else about the
                // new one, including why it could not be drawn.
                { ...next, content: current.content }
              : next,
          );
          const again = queued.current;
          queued.current = null;
          if (again === null) return;
          path = again;
        }
      } catch (problem) {
        // A refusal (no project, path outside it) is a real fault; an
        // unrenderable document comes back as `problem`, not as a throw.
        onError(problem);
      } finally {
        inFlight.current = false;
        setRendering(false);
      }
    },
    [onError],
  );

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  /**
   * Open a document the user chose.
   *
   * Their choice is filed against the conversation, the same as a mutation is:
   * picking a deck from the list is a statement about what this conversation is
   * working on, and it has to survive leaving the surface.
   */
  const openDocument = useCallback(
    (path: string) => {
      setActivePath(path);
      void loadPreview(path);
      if (sessionId !== null) {
        void call("office:remember", { sessionId, path }).catch(onError);
      }
    },
    [loadPreview, sessionId, onError],
  );

  /** What the project already holds. A directory read; it starts no OfficeCLI. */
  const loadDocuments = useCallback(async () => {
    try {
      const found = await call("office:documents");
      known.current = new Set(found.map((document) => document.path));
      setDocuments(found);
    } catch (problem) {
      onError(problem);
    }
  }, [onError]);

  // A different project is a different set of documents, and the one on screen
  // does not belong to it.
  useEffect(() => {
    setActivePath("");
    setPreview(null);
    void loadDocuments();
  }, [projectId, loadDocuments]);

  /**
   * A different conversation is a different piece of work.
   *
   * The document it was on is asked for and opened; if it has none — a new
   * conversation, or one whose document was made in another project — the
   * preview is cleared and the fallback below picks the newest in the project.
   * Clearing first matters: leaving the previous conversation's deck up while
   * this one loads reads as though it belongs here.
   */
  useEffect(() => {
    if (sessionId === null) return;
    let cancelled = false;
    setActivePath("");
    setPreview(null);
    void (async () => {
      try {
        const remembered = await call("office:recall", { sessionId });
        if (cancelled || remembered === "") return;
        setActivePath(remembered);
        void loadPreview(remembered);
      } catch (problem) {
        if (!cancelled) onError(problem);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, projectId, loadPreview, onError]);

  /**
   * Each OfficeCLI mutation names the artifact it touched, so follow the most
   * recent one. Keyed on the change's timestamp rather than run once on mount:
   * mutations keep arriving while this surface is open, and re-rendering the
   * same path is exactly the point — slide six has to appear without a click.
   *
   * Only a mutation not seen before counts. Switching conversation re-runs this
   * effect with the same change, and acting on it then would hand the previous
   * conversation's document to the one just opened.
   */
  useEffect(() => {
    const seen = handledChange.current;
    handledChange.current = change;
    if (seen === undefined || !change || change === seen) return;
    setActivePath(change.path);
    void loadPreview(change.path);
    // The conversation that was open when the mutation landed owns it, so
    // coming back to that conversation comes back to this document.
    if (sessionId !== null) {
      void call("office:remember", { sessionId, path: change.path }).catch(onError);
    }
    // Only a document the list has never seen is worth another directory read.
    if (!known.current.has(change.path)) {
      known.current.add(change.path);
      void loadDocuments();
    }
  }, [change, sessionId, loadPreview, loadDocuments, onError]);

  /**
   * Open the newest document the project already holds.
   *
   * The mutation stream only speaks about this session, so reopening the app —
   * or just leaving this surface and coming back — left the preview empty
   * beside a project that already held the deck. A live mutation still wins:
   * this only runs while nothing is open, which is also what makes it the
   * fallback for a conversation with no document of its own yet.
   */
  useEffect(() => {
    if (activePath !== "") return;
    const newest = documents[0];
    if (!newest) return;
    // Not filed against the conversation: nobody chose it, and a conversation
    // that has built nothing does not own the last thing another one built.
    setActivePath(newest.path);
    void loadPreview(newest.path);
  }, [documents, activePath, loadPreview]);

  /**
   * The focused slide, honoured only while it still exists.
   *
   * A deck grows under the user, and it is also rebuilt: choosing slide 5 and
   * then asking for a three-slide deck would otherwise leave the frame showing
   * nothing at all, which reads as a broken preview rather than a stale
   * selection. Derived rather than corrected by an effect, so there is never a
   * frame drawn from a selection that has already gone.
   */
  const slides = preview?.slides ?? [];
  const focused = slides.some((slide) => slide.number === selected) ? selected : null;

  // Switching document clears the selection outright — slide 5 of the deck is
  // not slide 5 of the next one.
  const activeDocument = preview?.path ?? "";
  useEffect(() => {
    setSelected(null);
  }, [activeDocument]);

  /**
   * A true-to-file render is thrown away whenever the document moves, or the
   * focus does.
   *
   * It is a photograph of one state of one page. Keeping it on screen beside a
   * preview that has since moved on would make it the most trusted thing in the
   * card and the most out of date — which is the failure it exists to prevent.
   */
  const previewAt = preview?.generatedAt ?? "";
  useEffect(() => {
    setRender(null);
  }, [activeDocument, focused, previewAt]);

  const generatingNow = change?.generating ?? false;

  const install = async (): Promise<void> => {
    setBusy(true);
    try {
      await call("office:install");
      await loadStatus();
    } catch (problem) {
      onError(problem);
    } finally {
      setBusy(false);
    }
  };

  // The change is newer than the render it triggered, so it wins: a preview
  // captured a moment ago would otherwise claim the file is settled while the
  // next slide is already being written.
  const generating = generatingNow || (preview?.generating ?? false);

  /**
   * Render through PowerPoint or Word: the only view here that answers "does
   * this fit?". Costs seconds and starts an Office application, so it is a
   * button and never automatic. Refused while the document is being written —
   * a native render opens the file, which is the very thing the notice above
   * tells the user not to do mid-run.
   */
  const renderNative = async (): Promise<void> => {
    if (activePath === "") return;
    setRenderingNative(true);
    try {
      setRender(await call("office:render", { path: activePath, page: focused }));
    } catch (problem) {
      onError(problem);
    } finally {
      setRenderingNative(false);
    }
  };

  return (
    <div className="stack">
      <div className="card">
        <div className="row between">
          <div>
            <strong>OfficeCLI</strong>
            <div className="muted">
              {status.state === "ready"
                ? `Ready · ${status.version || "version unknown"} · ${status.origin}`
                : status.message || describeState(status.state)}
            </div>
          </div>
          <div className="row">
            <span className={`pill${status.state === "ready" ? " ok" : status.state === "error" ? " bad" : " warn"}`}>
              {status.state}
            </span>
            <button className="icon" title="Refresh status" aria-label="Refresh OfficeCLI status" onClick={() => void loadStatus()}>
              <RefreshCw size={16} aria-hidden />
            </button>
          </div>
        </div>

        {(status.state === "missing" || status.state === "error") && (
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" disabled={busy} onClick={() => void install()}>
              <Download size={16} aria-hidden /> {busy ? "Installing…" : "Install OfficeCLI"}
            </button>
            <span className="muted">
              Installs a pinned, self-contained build into the app's own tool directory.
            </span>
          </div>
        )}
      </div>

      <div className="card" style={{ minHeight: 0 }}>
        <div className="row between">
          <div>
            <strong>{render === null ? "Content preview" : "Rendered by PowerPoint"}</strong>
            <div className="muted mono" style={{ fontSize: 11 }}>
              {activePath || "No document under generation yet."}
            </div>
          </div>
          <div className="row">
            {rendering && <span className="pill">rendering…</span>}
            {generating && <span className="pill warn">generating · read-only</span>}
            {documents.length > 1 && (
              <select
                value={activePath}
                aria-label="Document to preview"
                title="Office files in this project"
                onChange={(event) => openDocument(event.target.value)}
              >
                {documents.map((document) => (
                  <option key={document.path} value={document.path}>
                    {document.path}
                  </option>
                ))}
              </select>
            )}
            {activePath !== "" && (
              <button
                disabled={generating || renderingNative}
                title={
                  generating
                    ? "Available once the document is finished — a true render opens the file."
                    : focused === null
                      ? "Render every page through PowerPoint or Word"
                      : `Render slide ${focused} through PowerPoint or Word`
                }
                onClick={() => void renderNative()}
              >
                <MonitorCheck size={16} aria-hidden />{" "}
                {renderingNative ? "Rendering…" : "Check the real layout"}
              </button>
            )}
            {activePath !== "" && onOpenFile && (
              <button className="icon" title="Open in canvas" aria-label="Open in canvas" onClick={() => onOpenFile(activePath)}>
                <ExternalLink size={16} aria-hidden />
              </button>
            )}
            {activePath !== "" && (
              <button className="icon" title="Refresh preview" aria-label="Refresh preview" onClick={() => void loadPreview(activePath)}>
                <RefreshCw size={16} aria-hidden />
              </button>
            )}
          </div>
        </div>

        {generating && (
          <div className="notice row" style={{ marginTop: 8 }}>
            <TriangleAlert size={16} aria-hidden />
            <span>
              This preview is read-only while OfficeCLI is writing. Do not open the file in the
              system app mid-run — it locks the file and the generation fails.
            </span>
          </div>
        )}

        {render !== null && render.problem !== "" && (
          <div className="notice row" style={{ marginTop: 8 }}>
            <TriangleAlert size={16} aria-hidden />
            <span>{render.problem}</span>
          </div>
        )}

        {preview !== null && preview.problem !== "" && (
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            {preview.content === ""
              ? `Nothing to draw yet — ${preview.problem}`
              : `Showing the last frame that rendered — ${preview.problem}`}
          </p>
        )}

        {render !== null && render.image !== "" ? (
          <div className="preview-split">
            {slides.length > 1 && (
              <SlideIndex slides={slides} selected={focused} onSelect={setSelected} />
            )}
            <div className="preview-stage" ref={stage}>
              <img
                className="preview-render"
                src={render.image}
                alt={
                  render.page === null
                    ? `Every page of ${render.path}, rendered by its own application`
                    : `Page ${render.page} of ${render.path}, rendered by its own application`
                }
              />
            </div>
          </div>
        ) : preview && preview.content !== "" ? (
          <div className="preview-split">
            {slides.length > 1 && (
              <SlideIndex slides={slides} selected={focused} onSelect={setSelected} />
            )}
            <div className="preview-stage" ref={stage}>
              <PreviewFrame preview={preview} selected={focused} width={stageWidth} />
            </div>
          </div>
        ) : (
          <div className="stack">
            <p className="muted">
              Ask the agent to create a document, spreadsheet or deck — in Chat or here. This
              surface opens by itself when one is written, and refreshes as it is built.
            </p>
            {/* A project can gain a document from outside this app, so the list
                is worth re-reading on demand rather than only on open. */}
            <div className="row">
              <button onClick={() => void loadDocuments()}>
                <RefreshCw size={16} aria-hidden /> Load from project
              </button>
            </div>
          </div>
        )}

        {preview !== null && preview.content !== "" && (
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            {render !== null && render.image !== ""
              ? "This is the file as PowerPoint draws it. Choose a slide, or refresh, to go back to the live preview."
              : "Live, and accurate about content — but not about layout. It draws placeholder text a quarter too small and hides text that overflows, so use “Check the real layout” before you trust the fit."}
          </p>
        )}
        {projectId === null && (
          <p className="muted" style={{ fontSize: 12 }}>
            Bind a project to write Office artifacts into it.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Render generated markup in a sandboxed iframe, fitted, with a working index.
 *
 * `sandbox` with no `allow-same-origin` means the document cannot reach this
 * app's origin, storage or IPC — exactly what we want for output the agent
 * produced rather than a page we trust. It also means no script in that
 * document runs, and that has a consequence beyond the stripped navigator:
 * OfficeCLI fits slides to the viewport in `scaleSlides()`, a resize handler.
 * Without it every slide draws at its full 960pt — 1280 CSS px — and a frame
 * half that wide shows the middle of the slide with both edges cut off.
 *
 * So the frame is given the slide's own design width, which is the width its
 * layout was written for, and is **scaled with `transform`**. Measured in a
 * browser, not assumed:
 *
 *  - `zoom` on the iframe does nothing at all. The frame keeps its 1280px box,
 *    overflows its container and the slide stays cropped. This was tried first
 *    and shipped broken.
 *  - `zoom` on a wrapper *div* around the iframe is no better.
 *  - `transform: scale()` works. Because transforms do not affect layout, the
 *    stage must own the visible height and clip, and the frame is absolutely
 *    positioned inside it at full size with its height divided by the scale.
 *
 * Scaling the frame rather than rewriting the markup also means a resize never
 * re-loads it: `srcDoc` changes remount the document and would restart the
 * render on every pixel of a drag.
 */
function PreviewFrame({
  preview,
  selected,
  width,
}: {
  preview: OfficePreview;
  selected: number | null;
  /** Pixels available for the frame, measured from the layout. */
  width: number;
}): JSX.Element {
  const doc =
    preview.format === "svg"
      ? `<!doctype html><meta charset="utf-8"><body style="margin:0">${preview.content}</body>`
      : preview.content;

  // Appended, never merged into the document's own rules. `:not()` leaves the
  // chosen slide with whatever display OfficeCLI gave it, so we never have to
  // guess what that is; the padding override removes the only thing besides the
  // slide that competes for the frame's width, so the fit below is exact.
  const focus =
    selected === null
      ? ""
      : `.slide-container:not([data-slide="${selected}"]){display:none!important}`;
  const injected = `<style>.main{padding-left:0!important;padding-right:0!important}${focus}</style>`;

  // 96/72: OfficeCLI states the design size in points, CSS lays out in pixels.
  const designPx = preview.slideWidthPt > 0 ? (preview.slideWidthPt * 96) / 72 : 0;
  // The document scrolls, so its own vertical scrollbar takes width the slide
  // cannot have. Unaccounted for, it costs the slide its right-hand edge.
  const basis = designPx + SCROLLBAR_PX;
  // Until the stage has been measured the frame takes the room it is given, so
  // an unmeasured first paint can never be a frame wider than the pane.
  const measured = designPx > 0 && width > 0;
  // Never scale up. A one-slide deck in a wide pane should sit at its true size
  // rather than be blown up past the resolution it was rendered at.
  const fit = measured ? Math.min(1, width / basis) : 1;

  return (
    <iframe
      title={`Preview of ${preview.path}`}
      sandbox=""
      srcDoc={doc + injected}
      style={
        measured
          ? {
              position: "absolute",
              left: 0,
              top: 0,
              width: `${basis}px`,
              // Divided by the scale, so what is drawn is the stage's own
              // height whatever the scale turns out to be.
              height: `${PREVIEW_HEIGHT_VH / fit}vh`,
              transform: `scale(${fit})`,
              transformOrigin: "0 0",
              border: "0",
              background: "var(--bg-base)",
            }
          : { width: "100%", height: "100%", border: "0", background: "var(--bg-base)" }
      }
    />
  );
}

/** Width a scrolling document's vertical scrollbar takes from the slide. */
const SCROLLBAR_PX = 16;
/** Kept with `.preview-stage` in styles.css; the frame height is derived from it. */
const PREVIEW_HEIGHT_VH = 60;

/**
 * The slide index the sandbox cannot draw.
 *
 * Text, not thumbnails: a thumbnail would mean one more iframe per slide, and
 * the number plus the slide's own first line is what makes a slide
 * recognisable in a narrow column anyway.
 */
function SlideIndex({
  slides,
  selected,
  onSelect,
}: {
  slides: OfficePreview["slides"];
  selected: number | null;
  onSelect: (slide: number | null) => void;
}): JSX.Element {
  return (
    <nav className="slide-index" aria-label="Slides">
      <button
        type="button"
        className={`slide-index-item${selected === null ? " active" : ""}`}
        aria-current={selected === null}
        onClick={() => onSelect(null)}
      >
        <span className="num">All</span>
        <span className="label">{slides.length} slides</span>
      </button>
      {slides.map((slide) => (
        <button
          key={slide.number}
          type="button"
          className={`slide-index-item${selected === slide.number ? " active" : ""}`}
          aria-current={selected === slide.number}
          onClick={() => onSelect(slide.number)}
        >
          <span className="num">{slide.number}</span>
          <span className="label">{slide.title || "Empty slide"}</span>
        </button>
      ))}
    </nav>
  );
}

function describeState(state: OfficeStatus["state"]): string {
  switch (state) {
    case "installing":
      return "Installing the pinned OfficeCLI build…";
    case "missing":
      return "OfficeCLI is not installed yet.";
    case "unknown":
      return "Checking for OfficeCLI…";
    default:
      return "";
  }
}
