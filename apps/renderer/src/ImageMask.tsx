import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, PointerEvent as ReactPointerEvent } from "react";
import { Brush, Eraser, Undo2 } from "lucide-react";

/**
 * Paint the part of an image an edit should change.
 *
 * The image API takes a mask in which **transparent pixels are the area to
 * edit**, so what the brush produces is holes, not marks. On screen the same
 * strokes are drawn as a translucent wash, because a person painting needs to
 * see what they covered and "the bit that vanished" is not something an eye can
 * follow.
 *
 * The mask never becomes a file. The renderer has no way to write into a
 * project — deliberately — and a mask is a description of one edit rather than
 * an artifact worth keeping, so it travels with the request as bytes and is
 * forgotten afterwards.
 *
 * The canvas is the image's own pixel size, not its size on screen. A mask that
 * does not match the source is rejected by the API, and the display size is a
 * layout accident that changes when the pane is dragged.
 */

interface ImageMaskProps {
  /** Data URL of the image being edited. */
  src: string;
  alt: string;
  onCancel: () => void;
  /** Hands back a PNG data URL: opaque everywhere except the painted area. */
  onUse: (maskDataUrl: string) => void;
}

interface Stroke {
  points: { x: number; y: number }[];
  radius: number;
}

export function ImageMask({ src, alt, onCancel, onUse }: ImageMaskProps): JSX.Element {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [brush, setBrush] = useState(0);
  const drawing = useRef<Stroke | null>(null);

  // A brush is chosen relative to the picture. 6% of the shorter side is about
  // a fingertip on a face and a wide sweep on a landscape, which is the right
  // starting point for both.
  useEffect(() => {
    if (natural === null) return;
    setBrush(Math.round((Math.min(natural.width, natural.height) * 6) / 100));
  }, [natural]);

  /** Lay the strokes onto a context. Same geometry for screen and for export. */
  const trace = useCallback((context: CanvasRenderingContext2D, all: Stroke[]): void => {
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const stroke of all) {
      context.lineWidth = stroke.radius * 2;
      context.beginPath();
      const [first, ...rest] = stroke.points;
      if (!first) continue;
      // A tap with no drag is still a mark: start and end at the same point and
      // the round cap draws a dot.
      context.moveTo(first.x, first.y);
      if (rest.length === 0) context.lineTo(first.x, first.y);
      for (const point of rest) context.lineTo(point.x, point.y);
      context.stroke();
    }
  }, []);

  const repaint = useCallback(
    (all: Stroke[]): void => {
      const element = canvas.current;
      const context = element?.getContext("2d");
      if (!element || !context) return;
      context.clearRect(0, 0, element.width, element.height);
      context.strokeStyle = "rgba(56, 132, 255, 0.45)";
      trace(context, all);
    },
    [trace],
  );

  useEffect(() => repaint(strokes), [repaint, strokes]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  /** Client coordinates to image pixels, so the mask matches the source. */
  const at = (event: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } | null => {
    const element = canvas.current;
    if (!element) return null;
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    return {
      x: ((event.clientX - box.left) / box.width) * element.width,
      y: ((event.clientY - box.top) / box.height) * element.height,
    };
  };

  const start = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const point = at(event);
    if (point === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const stroke: Stroke = { points: [point], radius: brush };
    drawing.current = stroke;
    setStrokes((current) => [...current, stroke]);
  };

  const extend = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const stroke = drawing.current;
    if (stroke === null) return;
    const point = at(event);
    if (point === null) return;
    stroke.points.push(point);
    // The stroke object is mutated in place, so hand React a new array to make
    // it repaint. Copying every point on every pointermove is what makes a
    // brush feel heavy.
    setStrokes((current) => [...current]);
  };

  const end = (): void => {
    drawing.current = null;
  };

  /**
   * Build the mask the API reads: opaque everywhere, transparent where painted.
   *
   * `destination-out` is what turns a stroke into a hole. Drawing white on
   * black would not do — the API looks at the alpha channel, not at brightness.
   */
  const use = (): void => {
    if (natural === null || strokes.length === 0) return;
    const out = document.createElement("canvas");
    out.width = natural.width;
    out.height = natural.height;
    const context = out.getContext("2d");
    if (context === null) return;
    context.fillStyle = "#000000";
    context.fillRect(0, 0, out.width, out.height);
    context.globalCompositeOperation = "destination-out";
    context.strokeStyle = "#000000";
    trace(context, strokes);
    onUse(out.toDataURL("image/png"));
  };

  return (
    <>
      <div className="modal-scrim" onClick={onCancel} />
      <div className="modal-card image-mask" role="dialog" aria-modal="true" aria-label="Select a region to edit">
        <div className="modal-head">
          <strong>Select the area to change</strong>
        </div>
        <div className="modal-body">
          <div className="image-mask-stage">
            <img
              src={src}
              alt={alt}
              draggable={false}
              onLoad={(event) =>
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
            />
            {natural && (
              <canvas
                ref={canvas}
                width={natural.width}
                height={natural.height}
                onPointerDown={start}
                onPointerMove={extend}
                onPointerUp={end}
                onPointerCancel={end}
              />
            )}
          </div>
          <div className="row image-mask-tools">
            <Brush size={16} aria-hidden />
            <label className="field-row">
              Brush
              <input
                type="range"
                min={4}
                max={natural ? Math.round(Math.min(natural.width, natural.height) / 3) : 200}
                value={brush}
                onChange={(event) => setBrush(Number(event.target.value))}
              />
            </label>
            <button
              className="ghost"
              disabled={strokes.length === 0}
              onClick={() => setStrokes((current) => current.slice(0, -1))}
            >
              <Undo2 size={16} aria-hidden /> Undo
            </button>
            <button className="ghost" disabled={strokes.length === 0} onClick={() => setStrokes([])}>
              <Eraser size={16} aria-hidden /> Clear
            </button>
          </div>
          <p className="muted">
            Paint over what should change, then describe the change in the box below the
            conversation. The area is a hint, not a boundary — the model often adjusts pixels
            just outside it so the edit blends in.
          </p>
        </div>
        <div className="modal-foot">
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" disabled={strokes.length === 0} onClick={use}>
            Use this area
          </button>
        </div>
      </div>
    </>
  );
}
