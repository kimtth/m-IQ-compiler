import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import {
  Copy,
  ImagePlus,
  Info,
  Lasso,
  Pencil,
  Plus,
  Save,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { imageThreads, modelInProject, resolveModelForRole } from "@iq/shared";
import type {
  GeneratedImage,
  ImageOperation,
  ImageQuality,
  ImageRequest,
  ImageRun,
  ImageSize,
  ImageThread,
  ModelCatalog,
} from "@iq/shared";
import { call, subscribe } from "./bridge.js";
import { ImageMask } from "./ImageMask.js";

/**
 * Co-create → Image Creation.
 *
 * Making an image is not a single request. The first result is a draft, and the
 * work is what follows — "warmer light", "lose the text", "same but portrait".
 * So this is a conversation: prompts and results run down the page oldest first,
 * and a follow-up changes the image already there instead of starting a new one.
 * It is the shape ChatGPT's image surface has, including the region selector,
 * which paints the part of the picture an edit applies to.
 *
 * It deliberately does not create a Chat session. An image thread is history
 * kept by the image service, not an agent loop, and mixing the two would put
 * turns into a transcript no agent ever read.
 *
 * The only image provider is a Microsoft Foundry deployment advertising the
 * `image` capability, reached with the Azure identity. When none is configured
 * we say so and offer to open Connections & access, rather than letting the
 * user fire a generation that cannot succeed. Every result carries its
 * provenance so a saved image can always be traced to its prompt and
 * deployment.
 *
 * **The picker opens on the model configured as the image-generation default**,
 * resolved with the same rule the privileged side uses (`resolveModelForRole`).
 * The picker stays, because a per-run override is a real need; what it does not
 * do is open on whichever deployment happens to sort first.
 *
 * Editing needs a project. An edit re-reads the source image off disk, and the
 * only thing that puts it there is the auto-save that runs when a project is
 * bound. So with no project the edit controls are present and disabled with the
 * reason on them — never offered and then refused.
 */

interface ImagesProps {
  projectId: string | null;
  onError: (problem: unknown) => void;
  /** Open Control Center → Models so a missing image deployment can be added. */
  onOpenModels?: () => void;
}

const SIZES: ImageSize[] = ["1024x1024", "1024x1536", "1536x1024", "auto"];
const QUALITIES: ImageQuality[] = ["low", "medium", "high", "auto"];

/** What the composer will do on send, given the image pinned to it. */
interface Continuation {
  imageId: string;
  operation: Exclude<ImageOperation, "generate">;
}

export function Images({ projectId, onError, onOpenModels }: ImagesProps): JSX.Element {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [runs, setRuns] = useState<ImageRun[]>([]);
  const [modelId, setModelId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState<ImageSize>("1024x1024");
  const [quality, setQuality] = useState<ImageQuality>("auto");
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [showParams, setShowParams] = useState<string>("");
  /** "" means the composer will start a new image rather than open a thread. */
  const [threadId, setThreadId] = useState("");
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [from, setFrom] = useState<Continuation | null>(null);
  const [maskDataUrl, setMaskDataUrl] = useState("");
  /** The image the region selector is open on, if any. */
  const [masking, setMasking] = useState<GeneratedImage | null>(null);

  const entries = useMemo(() => catalog?.entries ?? [], [catalog]);

  const imageModels = useMemo(
    () =>
      entries.filter(
        (entry) => entry.capabilities.includes("image") && modelInProject(entry, projectId),
      ),
    [entries, projectId],
  );

  /** What Models says should answer here. Null when nothing is eligible. */
  const configured = useMemo(
    () => (catalog === null ? null : resolveModelForRole(catalog, "image", projectId)),
    [catalog, projectId],
  );

  const threads = useMemo(() => imageThreads(runs), [runs]);
  const thread = useMemo(
    () => threads.find((candidate) => candidate.id === threadId) ?? null,
    [threads, threadId],
  );

  const images = useMemo(
    () => new Map(runs.flatMap((run) => run.images.map((image) => [image.id, image] as const))),
    [runs],
  );
  const parent = from === null ? null : (images.get(from.imageId) ?? null);

  const loadCatalog = useCallback(async () => {
    try {
      setCatalog(await call("models:catalog"));
    } catch (problem) {
      onError(problem);
    }
  }, [onError]);

  const loadRuns = useCallback(async () => {
    try {
      const next = await call("images:runs");
      setRuns(next);
      // Keep the conversation on screen if it still exists; otherwise fall back
      // to the newest one. "" is a new image the user asked for, not staleness.
      setThreadId((current) => {
        if (current === "") return "";
        const known = imageThreads(next);
        return known.some((candidate) => candidate.id === current) ? current : (known[0]?.id ?? "");
      });
    } catch (problem) {
      onError(problem);
    }
  }, [onError]);

  useEffect(() => {
    void loadCatalog();
    void loadRuns();
    const offModels = subscribe<ModelCatalog>("models:changed", setCatalog);
    const offRun = subscribe<ImageRun>("images:run", (run) => {
      setRuns((current) => [run, ...current.filter((existing) => existing.id !== run.id)]);
    });
    return () => {
      offModels();
      offRun();
    };
  }, [loadCatalog, loadRuns]);

  // Land on the newest conversation the first time history arrives, so the
  // surface does not open on an empty page when there is work to look at.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || threads.length === 0) return;
    landed.current = true;
    setThreadId(threads[0]?.id ?? "");
  }, [threads]);

  // Keep the selection valid, and fall back to the configured model rather than
  // to whatever happens to be first. A selection the user made by hand is left
  // alone as long as it is still eligible.
  useEffect(() => {
    if (imageModels.length === 0) {
      setModelId("");
      return;
    }
    if (!imageModels.some((entry) => entry.id === modelId)) {
      setModelId(configured?.id ?? imageModels[0]?.id ?? "");
    }
  }, [configured, imageModels, modelId]);

  useEffect(() => setDeleteArmed(false), [threadId]);

  /**
   * Bytes for images that came back from the run index without any.
   *
   * The index keeps what was asked for and where the result was put; it does
   * not keep the base64, because that is megabytes per run and the file is
   * already in the project. So a run restored after a restart arrives with
   * `savedPath` set and `dataUrl` empty, and the thread would draw broken
   * frames. This fetches the files for the conversation on screen — one
   * conversation at a time, never the whole history — through the same reader
   * the file viewer uses, which is the one path that checks the image is inside
   * the project before reading it.
   */
  const [restored, setRestored] = useState<Record<string, string>>({});

  useEffect(() => {
    if (thread === null) return;
    const missing = thread.runs
      .flatMap((run) => run.images)
      .filter(
        (image) =>
          image.dataUrl === "" && image.savedPath !== "" && restored[image.id] === undefined,
      );
    if (missing.length === 0) return;

    let cancelled = false;
    void (async () => {
      for (const image of missing) {
        try {
          const file = await call("project:read", { path: image.savedPath });
          if (cancelled) return;
          setRestored((current) => ({ ...current, [image.id]: file.dataUrl }));
        } catch {
          // A file the user moved or deleted is not an error worth a banner:
          // the run is still a true record of what was asked for. The cell
          // says so instead.
          if (cancelled) return;
          setRestored((current) => ({ ...current, [image.id]: "" }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [thread, restored]);

  const bytesOf = (image: GeneratedImage): string =>
    image.dataUrl !== "" ? image.dataUrl : (restored[image.id] ?? "");

  /** Keep the newest turn in view, the way a conversation is read. */
  const foot = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    foot.current?.scrollIntoView({ block: "end" });
  }, [thread, busy]);

  const startNew = (): void => {
    setThreadId("");
    setFrom(null);
    setMaskDataUrl("");
    setShowParams("");
  };

  const continueFrom = (image: GeneratedImage, operation: Continuation["operation"]): void => {
    setFrom({ imageId: image.id, operation });
    // A variation has nothing new to say, so it starts from what was said last.
    if (operation === "variation" && prompt.trim() === "") setPrompt(image.provenance.prompt);
  };

  const generate = async (): Promise<void> => {
    if (modelId === "" || prompt.trim() === "" || busy) return;
    setBusy(true);
    try {
      const request: ImageRequest = {
        modelId,
        operation: from?.operation ?? "generate",
        prompt: prompt.trim(),
        size,
        quality,
        count,
        // The source is resolved on the privileged side from the image being
        // continued, so the surface never has to know where a file landed.
        sourcePath: "",
        maskPath: "",
        maskDataUrl: from === null ? "" : maskDataUrl,
        parentImageId: from?.imageId ?? "",
        projectId,
      };
      const run = await call("images:generate", request);
      setRuns((current) => [run, ...current.filter((existing) => existing.id !== run.id)]);
      setThreadId(run.threadId === "" ? run.id : run.threadId);
      // A mask describes one edit. It does not carry into the next turn.
      setMaskDataUrl("");
      // A failed turn keeps the words, because the fix is usually to say it
      // differently and retyping the whole prompt to do that is a punishment.
      if (run.status !== "failed") setPrompt("");
      const last = run.images[run.images.length - 1];
      // The next turn continues from what just came back. That is what makes
      // this a conversation rather than a queue of unrelated prompts.
      if (last) setFrom({ imageId: last.id, operation: "edit" });
    } catch (problem) {
      onError(problem);
    } finally {
      setBusy(false);
    }
  };

  const save = async (run: ImageRun, image: GeneratedImage): Promise<void> => {
    try {
      await call("images:save", { runId: run.id, imageId: image.id, path: "" });
      await loadRuns();
    } catch (problem) {
      onError(problem);
    }
  };

  /** Forget one conversation. Images already saved to the project are left alone. */
  const deleteThread = async (id: string): Promise<void> => {
    try {
      await call("images:deleteThread", { threadId: id });
      setThreadId("");
      await loadRuns();
    } catch (problem) {
      onError(problem);
    }
  };

  const noModel = imageModels.length === 0;

  if (noModel) {
    return (
      <div className="stack">
        <div className="card">
          <div className="row" style={{ gap: 8 }}>
            <TriangleAlert size={16} aria-hidden />
            <strong>No image model available</strong>
          </div>
          <p className="muted">
            Image Creation needs a Microsoft Foundry deployment that advertises the image
            capability — a gpt-image deployment. Add one under Connections &amp; access, then
            return here.
          </p>
          {onOpenModels && (
            <button className="primary" onClick={onOpenModels}>
              <SlidersHorizontal size={16} aria-hidden /> Open Connections
            </button>
          )}
        </div>
      </div>
    );
  }

  /** Why an edit cannot start from this image, or "" when it can. */
  const editBlockedBecause = (image: GeneratedImage): string => {
    if (image.savedPath !== "") return "";
    return projectId === null
      ? "Editing reads the image back from the project. Bind a project, then generate it again."
      : "This image was never saved to the project, so there is nothing to edit.";
  };

  return (
    <div className="image-studio">
      <div className="pane-header">
        <span className="pane-title">Image Creation</span>
        <div className="pane-actions">
          <select
            className="composer-picker"
            aria-label="Image conversation"
            value={threadId}
            onChange={(event) => {
              setThreadId(event.target.value);
              setFrom(null);
              setMaskDataUrl("");
            }}
          >
            <option value="">New image</option>
            {threads.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {threadLabel(candidate)}
              </option>
            ))}
          </select>
          <button className="ghost" onClick={startNew} title="Start a new image">
            <Plus size={16} aria-hidden /> New image
          </button>
          {thread && (
            <button
              className={deleteArmed ? "danger" : "ghost"}
              title={
                deleteArmed
                  ? "Press again to remove this conversation from the history. Images you saved stay in the project."
                  : "Remove this conversation from the history. Images you saved stay in the project."
              }
              onClick={() => {
                if (!deleteArmed) {
                  setDeleteArmed(true);
                  return;
                }
                setDeleteArmed(false);
                void deleteThread(thread.id);
              }}
            >
              <Trash2 size={16} aria-hidden /> {deleteArmed ? "Press again to delete" : "Delete"}
            </button>
          )}
        </div>
      </div>

      <div className="pane-body image-thread">
        {thread === null ? (
          <div className="image-blank">
            <ImagePlus size={28} aria-hidden />
            <strong>Describe the image you want</strong>
            <p className="muted">
              What comes back is a draft. Keep talking to it — a different colour, a tighter crop,
              something removed — and each reply changes the picture above rather than starting a
              new one.
            </p>
          </div>
        ) : (
          thread.runs.map((run, index) => (
            <div className="image-turn" key={run.id}>
              <div className="image-ask">
                <span className="image-turn-tag">{turnTag(run, index)}</span>
                <p>{run.request.prompt}</p>
              </div>

              <div className="image-answer">
                {run.status !== "succeeded" && (
                  <span className={`pill${run.status === "failed" ? " bad" : " warn"}`}>
                    {run.status === "running" && <span className="spinner" aria-hidden />}{" "}
                    {run.status}
                  </span>
                )}
                {run.error !== "" && <div className="notice">{run.error}</div>}

                <div className="image-grid">
                  {run.images.map((image) => {
                    const blocked = editBlockedBecause(image);
                    return (
                      <div
                        className={`image-cell${from?.imageId === image.id ? " is-parent" : ""}`}
                        key={image.id}
                      >
                        {bytesOf(image) === "" ? (
                          <div className="image-missing muted">
                            {image.savedPath === ""
                              ? "This image was generated with no project bound, so there was nowhere to keep it."
                              : `Not found: ${image.savedPath}`}
                          </div>
                        ) : (
                          <img src={bytesOf(image)} alt={image.provenance.prompt} />
                        )}
                        <div className="row">
                          <button
                            className="icon"
                            title={
                              image.savedPath
                                ? "Saved"
                                : bytesOf(image) === ""
                                  ? "The bytes for this image are gone; there is nothing to save"
                                  : "Save to project"
                            }
                            aria-label="Save to project"
                            disabled={image.savedPath !== "" || bytesOf(image) === ""}
                            onClick={() => void save(run, image)}
                          >
                            <Save size={16} aria-hidden />
                          </button>
                          <button
                            className="icon"
                            title={blocked === "" ? "Change this image" : blocked}
                            aria-label="Change this image"
                            disabled={blocked !== ""}
                            onClick={() => continueFrom(image, "edit")}
                          >
                            <Pencil size={16} aria-hidden />
                          </button>
                          <button
                            className="icon"
                            title={blocked === "" ? "Change one area of this image" : blocked}
                            aria-label="Change one area of this image"
                            disabled={blocked !== "" || bytesOf(image) === ""}
                            onClick={() => {
                              continueFrom(image, "edit");
                              setMasking(image);
                            }}
                          >
                            <Lasso size={16} aria-hidden />
                          </button>
                          <button
                            className="icon"
                            title={blocked === "" ? "Make another like this" : blocked}
                            aria-label="Make another like this"
                            disabled={blocked !== ""}
                            onClick={() => continueFrom(image, "variation")}
                          >
                            <Copy size={16} aria-hidden />
                          </button>
                          <button
                            className="icon"
                            title="Generation parameters"
                            aria-label="View generation parameters"
                            onClick={() => setShowParams(showParams === image.id ? "" : image.id)}
                          >
                            <Info size={16} aria-hidden />
                          </button>
                        </div>
                        {showParams === image.id && <Provenance image={image} />}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ))
        )}
        <div ref={foot} />
      </div>

      <div className="composer">
        <div className="composer-box">
          {(parent !== null || maskDataUrl !== "") && (
            <div className="composer-attachments">
              {parent && (
                <span className="attachment-chip">
                  {bytesOf(parent) !== "" && (
                    <img className="attachment-thumb" src={bytesOf(parent)} alt="" />
                  )}
                  <span className="attachment-name">
                    {from?.operation === "variation" ? "Another like this one" : "Changing this image"}
                  </span>
                  <button
                    className="icon"
                    aria-label="Start a new image instead"
                    title="Start a new image instead"
                    onClick={() => {
                      setFrom(null);
                      setMaskDataUrl("");
                    }}
                  >
                    <X size={14} aria-hidden />
                  </button>
                </span>
              )}
              {maskDataUrl !== "" && (
                <span className="attachment-chip">
                  <Lasso size={14} aria-hidden />
                  <span className="attachment-name">Area selected</span>
                  <button
                    className="icon"
                    aria-label="Clear the selected area"
                    title="Clear the selected area"
                    onClick={() => setMaskDataUrl("")}
                  >
                    <X size={14} aria-hidden />
                  </button>
                </span>
              )}
            </div>
          )}

          <textarea
            rows={2}
            value={prompt}
            placeholder={from === null ? "Describe the image…" : "Describe the change…"}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void generate();
              }
            }}
          />

          <div className="composer-actions">
            <div className="composer-pickers">
              <select
                className="composer-picker"
                aria-label="Model"
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
              >
                {imageModels.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.displayName}
                    {entry.id === configured?.id ? " · default" : ""}
                  </option>
                ))}
              </select>
              <select
                className="composer-picker"
                aria-label="Size"
                value={size}
                onChange={(event) => setSize(event.target.value as ImageSize)}
              >
                {SIZES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <select
                className="composer-picker"
                aria-label="Quality"
                value={quality}
                onChange={(event) => setQuality(event.target.value as ImageQuality)}
              >
                {QUALITIES.map((value) => (
                  <option key={value} value={value}>
                    {value} quality
                  </option>
                ))}
              </select>
              <select
                className="composer-picker"
                aria-label="How many images"
                value={count}
                onChange={(event) => setCount(Number(event.target.value))}
              >
                {[1, 2, 3, 4].map((value) => (
                  <option key={value} value={value}>
                    ×{value}
                  </option>
                ))}
              </select>
            </div>
            <div className="composer-submit">
              <button
                className="primary composer-send"
                aria-label={busy ? "Generating…" : "Generate"}
                title={busy ? "Generating…" : "Generate"}
                disabled={busy || modelId === "" || prompt.trim() === ""}
                onClick={() => void generate()}
              >
                <ImagePlus size={16} aria-hidden />
              </button>
            </div>
          </div>
        </div>
        <div className="composer-status">
          <span className="composer-status-item">
            {from === null
              ? "A new image"
              : from.operation === "variation"
                ? "A variation of the image above"
                : maskDataUrl === ""
                  ? "Editing the image above"
                  : "Editing the selected area"}
          </span>
          <span className="composer-status-divider" aria-hidden />
          <span className="composer-status-item">{costEstimate(count, quality)}</span>
          {configured !== null && modelId !== configured.id && (
            <>
              <span className="composer-status-divider" aria-hidden />
              <span className="composer-status-item">
                Overriding the default ({configured.displayName})
              </span>
            </>
          )}
          {onOpenModels && (
            <>
              <span className="composer-status-divider" aria-hidden />
              <button className="link" onClick={onOpenModels}>
                Change the default under Connections
              </button>
            </>
          )}
        </div>
      </div>

      {masking && bytesOf(masking) !== "" && (
        <ImageMask
          src={bytesOf(masking)}
          alt={masking.provenance.prompt}
          onCancel={() => setMasking(null)}
          onUse={(mask) => {
            setMaskDataUrl(mask);
            setMasking(null);
          }}
        />
      )}
    </div>
  );
}

/** One line for the conversation picker: what it is about, and how far it got. */
function threadLabel(thread: ImageThread): string {
  const title =
    thread.title.length > 48 ? `${thread.title.slice(0, 48)}…` : thread.title || "Untitled";
  const turns = thread.runs.length;
  return `${title} · ${turns} turn${turns === 1 ? "" : "s"}`;
}

/** What this turn did, said the way the reader would say it. */
function turnTag(run: ImageRun, index: number): string {
  if (run.request.operation === "variation") return "Another like it";
  if (run.request.operation === "edit") {
    return run.images[0]?.provenance.maskRegion === true ? "Edit, in the selected area" : "Edit";
  }
  return index === 0 ? "New image" : "New image in this thread";
}

/** Provenance panel: everything needed to explain or reproduce one image. */
function Provenance({ image }: { image: GeneratedImage }): JSX.Element {
  const p = image.provenance;
  return (
    <div className="detail-panel">
      <div className="trace">
        <div className="trace-line">Deployment: {p.deploymentName}</div>
        <div className="trace-line">Endpoint: {p.endpointHost}</div>
        <div className="trace-line">Operation: {p.operation}</div>
        <div className="trace-line">Size: {p.size} · Quality: {p.quality}</div>
        {p.sourcePath !== "" && <div className="trace-line">Source: {p.sourcePath}</div>}
        {p.maskPath !== "" && <div className="trace-line">Mask: {p.maskPath}</div>}
        {p.maskRegion && <div className="trace-line">Mask: an area selected in the surface</div>}
        <div className="trace-line">When: {new Date(p.createdAt).toLocaleString()}</div>
        <div className="trace-line">Project: {p.projectId ?? "none"}</div>
        {image.savedPath !== "" && <div className="trace-line">Saved: {image.savedPath}</div>}
      </div>
    </div>
  );
}

/** Coarse, clearly-an-estimate line so the cost of a batch is visible up front. */
function costEstimate(count: number, quality: ImageQuality): string {
  const weight = quality === "high" ? 3 : quality === "medium" ? 2 : 1;
  const units = count * weight;
  return `~${units} image credit${units === 1 ? "" : "s"} (rough)`;
}
