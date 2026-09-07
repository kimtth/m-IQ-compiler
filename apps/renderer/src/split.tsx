import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Resizable columns inside a canvas surface.
 *
 * `panes.ts` owns the workbench's top-level panes. This is the same idea one
 * level down: a surface that shows a list, a work area and a report needs its
 * own dividers, because a column sized for the demo's shortest name is useless
 * for a real one and no amount of tuning a fixed width fixes that.
 *
 * The rules are deliberately identical to `panes.ts`, so the two behave the
 * same under the hand:
 *
 *  1. Exactly one column is elastic. Every other column carries an explicit
 *     pixel width, so a divider drag changes one width and only the elastic
 *     column absorbs the difference — the column on the far side keeps its
 *     width exactly.
 *  2. Every column declares a minimum, and the elastic one declares its own.
 *     A drag stops at whichever floor it reaches first.
 *  3. Widths persist per surface and per scope, and a restored layout that no
 *     longer fits is discarded rather than producing sub-minimum columns.
 */

export interface ColumnSpec {
  readonly min: number;
  readonly initial: number;
  /** Which side of the elastic column this one sits on. */
  readonly side: "left" | "right";
}

export interface Split<K extends string> {
  readonly containerRef: (node: HTMLDivElement | null) => void;
  readonly widthOf: (column: K) => number;
  readonly startDrag: (column: K, event: React.PointerEvent) => void;
  /** Grid template for the container, dividers included. */
  readonly template: string;
  readonly reset: () => void;
}

const storageKey = (surface: string, scope: string): string => `iq.split.${surface}.${scope}`;

const readStored = (surface: string, scope: string): Record<string, number> => {
  try {
    const raw = window.localStorage.getItem(storageKey(surface, scope));
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
};

/**
 * Width of the divider, in pixels. Kept in sync with `.split-divider`.
 *
 * A line, not a band. The hit area is widened in CSS instead, so making this
 * thinner costs nothing in grabbability.
 */
export const DIVIDER = 1;

export function useSplit<K extends string>(
  surface: string,
  scope: string,
  /**
   * The columns that are present *right now*.
   *
   * Partial because a surface may close one: My IQ's report column
   * is absent until asked for. Leaving the entry out is what removes the
   * column from the grid, which is a different thing from a column of zero
   * width — that one still takes a divider, still answers `widthOf`, and still
   * has to be reasoned about by everything that sizes the elastic column.
   */
  specs: Readonly<Partial<Record<K, ColumnSpec>>>,
  elasticMin: number,
): Split<K> {
  const keys = Object.keys(specs) as K[];
  const [available, setAvailable] = useState(0);
  const [widths, setWidths] = useState<Record<string, number>>(() => readStored(surface, scope));
  const node = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setWidths(readStored(surface, scope));
  }, [scope, surface]);

  useEffect(() => {
    if (Object.keys(widths).length === 0) return;
    try {
      window.localStorage.setItem(storageKey(surface, scope), JSON.stringify(widths));
    } catch {
      // A remembered layout is a convenience; losing it must never break the
      // surface that uses it.
    }
  }, [scope, surface, widths]);

  const containerRef = useCallback((element: HTMLDivElement | null) => {
    node.current = element;
    if (element !== null) setAvailable(element.clientWidth);
  }, []);

  useEffect(() => {
    const element = node.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      setAvailable(entries[0]?.contentRect.width ?? element.clientWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef]);

  /**
   * A column that is not currently present has no width to report and nothing
   * to drag. Rather than let `undefined` reach the arithmetic, absent columns
   * are treated as the zero-width, zero-minimum columns they effectively are;
   * they never appear in `keys`, so this only guards a caller asking about a
   * column it has closed.
   */
  const ABSENT: ColumnSpec = { min: 0, initial: 0, side: "right" };
  const specOf = (column: K): ColumnSpec => specs[column] ?? ABSENT;

  const requested = useCallback(
    (column: K): number => {
      const spec = specs[column];
      if (spec === undefined) return 0;
      return Math.max(spec.min, widths[column] ?? spec.initial);
    },
    [specs, widths],
  );

  /**
   * Fall back to the defaults when the remembered layout no longer fits.
   *
   * Honouring a width saved on a wider window would push the elastic column
   * under its floor, which is exactly the distortion the container exists to
   * prevent.
   */
  const fits =
    available === 0 ||
    keys.reduce((sum, column) => sum + requested(column), 0) +
      DIVIDER * keys.length +
      elasticMin <=
      available;

  const widthOf = (column: K): number =>
    fits ? requested(column) : Math.max(specOf(column).min, specOf(column).initial);

  const startDrag = (column: K, event: React.PointerEvent): void => {
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const spec = specOf(column);
    const startX = event.clientX;
    const startWidth = widthOf(column);
    // A divider left of the elastic column grows its column as the pointer
    // moves right; one on the right grows it as the pointer moves left.
    const direction = spec.side === "left" ? 1 : -1;
    const others = keys
      .filter((other) => other !== column)
      .reduce((sum, other) => sum + widthOf(other), 0);
    const ceiling = Math.max(
      spec.min,
      available - others - elasticMin - DIVIDER * keys.length,
    );

    const move = (moved: PointerEvent): void => {
      const delta = (moved.clientX - startX) * direction;
      const next = Math.min(ceiling, Math.max(spec.min, startWidth + delta));
      setWidths((current) => ({ ...current, [column]: Math.round(next) }));
    };
    const end = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  const left = keys.filter((column) => specOf(column).side === "left");
  const right = keys.filter((column) => specOf(column).side === "right");
  const template = [
    ...left.flatMap((column) => [`${widthOf(column)}px`, `${DIVIDER}px`]),
    "minmax(0, 1fr)",
    ...right.flatMap((column) => [`${DIVIDER}px`, `${widthOf(column)}px`]),
  ].join(" ");

  return {
    containerRef,
    widthOf,
    startDrag,
    template,
    reset: useCallback(() => setWidths({}), []),
  };
}

/** The handle itself. Kept here so every surface renders the same affordance. */
export function SplitDivider({
  label,
  onPointerDown,
}: {
  label: string;
  onPointerDown: (event: React.PointerEvent) => void;
}): JSX.Element {
  return (
    <div
      className="split-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
    />
  );
}
