import { useCallback, useEffect, useRef, useState } from "react";
import type { PaneId } from "@iq/shared";

/**
 * Pane layout for the workbench.
 *
 * The container is the sole owner of layout, which is the fix for the bug where
 * expanding one pane shrank and distorted the others. Two rules make that work:
 *
 *  1. Exactly one pane is elastic — the canvas. Every other pane carries an
 *     explicit pixel width. A divider drag therefore changes one fixed width,
 *     and only the canvas absorbs the difference; the pane on the far side of
 *     the canvas keeps its width exactly.
 *  2. Every pane declares a minimum. The container refuses to distribute space
 *     that would push a pane below it, and when the window itself is too narrow
 *     it hides panes by priority — navigator first, then chat — rather than
 *     squeezing all three.
 *
 * Widths are remembered per project. A restored layout that no longer fits
 * the current window is discarded in favour of the default distribution, so a
 * window resized on another monitor can never produce sub-minimum panes.
 */

/**
 * Re-exported, not declared.
 *
 * The pane set is `PaneId` in `@iq/shared`, because which panes a surface does
 * without is also what decides whether a conversation may be filed on it — and
 * that question is answered on the privileged side.
 */
export type { PaneId };

interface PaneSpec {
  readonly min: number;
  readonly initial: number;
}

/** The canvas is absent here deliberately: it is the elastic pane. */
const FIXED_PANES: Record<Exclude<PaneId, "canvas">, PaneSpec> = {
  chat: { min: 300, initial: 380 },
  navigator: { min: 200, initial: 260 },
  inspector: { min: 240, initial: 320 },
};

const CANVAS_MIN = 360;

/** Hidden first when space runs out. Chat and canvas are the two that survive. */
const SHED_ORDER: PaneId[] = ["inspector", "navigator", "chat"];

export interface PaneLayout {
  widths: Record<string, number>;
  hidden: Set<PaneId>;
  /** True when the window is too narrow for more than one pane at a time. */
  single: boolean;
}

const storageKey = (scope: string): string => `iq.panes.${scope}`;

function readStored(scope: string): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(storageKey(scope));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function usePaneLayout(
  visible: readonly PaneId[],
  scope: string,
): {
  layout: PaneLayout;
  containerRef: (node: HTMLDivElement | null) => void;
  widthOf: (pane: PaneId) => number;
  isHidden: (pane: PaneId) => boolean;
  startDrag: (pane: PaneId, event: React.PointerEvent) => void;
} {
  const [available, setAvailable] = useState(0);
  const [widths, setWidths] = useState<Record<string, number>>(() => readStored(scope));
  const node = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ pane: PaneId; startX: number; startWidth: number } | null>(null);

  // Widths are per project, so switching project restores that project's
  // layout rather than carrying the previous one across.
  useEffect(() => {
    setWidths(readStored(scope));
  }, [scope]);

  useEffect(() => {
    if (Object.keys(widths).length === 0) return;
    try {
      window.localStorage.setItem(storageKey(scope), JSON.stringify(widths));
    } catch {
      // A full or unavailable store costs the user a remembered layout and
      // nothing else, so it must never break the workbench.
    }
  }, [scope, widths]);

  const containerRef = useCallback((element: HTMLDivElement | null) => {
    node.current = element;
    if (!element) return;
    setAvailable(element.clientWidth);
  }, []);

  useEffect(() => {
    const element = node.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? element.clientWidth;
      setAvailable(width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef]);

  const specOf = (pane: PaneId): PaneSpec =>
    pane === "canvas" ? { min: CANVAS_MIN, initial: CANVAS_MIN } : FIXED_PANES[pane];

  const requested = (pane: PaneId): number => {
    const spec = specOf(pane);
    const stored = widths[pane];
    return Math.max(spec.min, stored ?? spec.initial);
  };

  // Shed panes by priority until what remains fits. A pane is never hidden by
  // the user — only by want of space — and it comes back when the space does.
  const hidden = new Set<PaneId>();
  let showing = visible.filter((pane) => !hidden.has(pane));
  const fixedTotal = (): number =>
    showing
      .filter((pane) => pane !== "canvas")
      .reduce((sum, pane) => sum + requested(pane), 0);

  if (available > 0) {
    const canvasVisible = showing.includes("canvas");
    while (
      showing.length > 1 &&
      fixedTotal() + (canvasVisible ? CANVAS_MIN : 0) > available
    ) {
      const victim = SHED_ORDER.find((pane) => showing.includes(pane));
      if (!victim) break;
      hidden.add(victim);
      showing = showing.filter((pane) => pane !== victim);
    }
  }

  const single = showing.length <= 1 && visible.length > 1;

  const widthOf = (pane: PaneId): number => requested(pane);
  const isHidden = (pane: PaneId): boolean => hidden.has(pane);

  /**
   * Divider drag. The pointer is captured so the gesture survives the cursor
   * leaving the divider, which is a one-pixel line and otherwise the most
   * common way a resize drag is lost.
   */
  const startDrag = (pane: PaneId, event: React.PointerEvent): void => {
    if (pane === "canvas") return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = { pane, startX: event.clientX, startWidth: requested(pane) };

    const direction = pane === "chat" ? 1 : -1;

    const move = (moveEvent: PointerEvent): void => {
      const state = drag.current;
      if (!state) return;
      const delta = (moveEvent.clientX - state.startX) * direction;
      const spec = specOf(state.pane);
      // The canvas minimum is the other end of the constraint: a drag may take
      // space from the canvas only until the canvas reaches its own floor.
      const others = showing
        .filter((other) => other !== state.pane && other !== "canvas")
        .reduce((sum, other) => sum + requested(other), 0);
      const ceiling = Math.max(spec.min, available - others - CANVAS_MIN);
      const next = Math.min(ceiling, Math.max(spec.min, state.startWidth + delta));
      setWidths((current) => ({ ...current, [state.pane]: Math.round(next) }));
    };

    const end = (): void => {
      drag.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  return {
    layout: { widths, hidden, single },
    containerRef,
    widthOf,
    isHidden,
    startDrag,
  };
}
