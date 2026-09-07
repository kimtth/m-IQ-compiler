import { useCallback, useMemo, useRef, useState } from "react";
import { RECENCY_WINDOW_DAYS, arrivalOf, type ConnectomeGraph } from "@iq/shared";

/**
 * Connectome → the time lapse.
 *
 * The map answered "what is here" and nothing else. It drew a still field of
 * tracts, and the only animation was a guided tour that flew the camera
 * between them — which shows where things *are* and never shows anything
 * happening. A workload that has been steady for a month and one that appeared
 * last Tuesday drew identically, and the difference between those two is most
 * of what a reader wants from a picture of their own work.
 *
 * So the reveal became a clock. Every tract and every cell carries the point in
 * the window at which it was last carrying work, and playing the lapse moves
 * through that window: the picture assembles itself in the order the work
 * actually happened, and finishes on the complete map.
 *
 * This hook owns the *reading* — which day is on screen, and how much of the
 * body of work exists by then. The playback itself belongs to the scene, which
 * advances it per frame and reports back; driving sixty React renders a second
 * to move a slider is not a thing worth doing, so the reading is quantised to
 * whole days and only re-renders when the day changes.
 */

export interface TimeLapseFrame {
  /** 0 at the far end of the window, 1 now. */
  readonly epoch: number;
  /** Days before today being shown. 0 is today. */
  readonly daysAgo: number;
  /** How the day is said, in the words a reader would use. */
  readonly label: string;
  /** IQ Cells that had run by this point. */
  readonly cells: number;
  /** Couplings carrying work by this point. */
  readonly couplings: number;
}

export interface TimeLapse {
  readonly frame: TimeLapseFrame;
  readonly playing: boolean;
  readonly total: { cells: number; couplings: number };
  readonly play: () => void;
  /**
   * Play from the far end of the window, whatever the clock currently says.
   *
   * Distinct from {@link play}, which resumes from where the reader left off
   * and only rewinds a lapse that has already finished. A new analysis is a
   * new body of work, so it is shown from the beginning — and unlike `play`
   * this closes over nothing, which matters because it is called from a run
   * that captured the callback on an earlier render.
   */
  readonly restart: () => void;
  readonly pause: () => void;
  /** Scrub to a moment. Stops playback: the reader is driving now. */
  readonly scrub: (epoch: number) => void;
  /** Called by the scene as playback advances. */
  readonly advance: (epoch: number) => void;
  readonly reset: () => void;
}

const labelFor = (daysAgo: number): string => {
  if (daysAgo <= 0) return "today";
  if (daysAgo === 1) return "yesterday";
  if (daysAgo < 14) return `${daysAgo} days ago`;
  const weeks = Math.round(daysAgo / 7);
  return `${weeks} weeks ago`;
};

export const useTimeLapse = (graph: ConnectomeGraph | null): TimeLapse => {
  const [epoch, setEpoch] = useState(1);
  const [playing, setPlaying] = useState(false);
  /**
   * The last epoch that produced a render.
   *
   * The scene reports every frame. Rounding to the day the reading is about to
   * show, and skipping anything that would not change it, is what keeps a
   * nine-second playback to a few dozen renders instead of five hundred.
   */
  const shown = useRef(1);

  /**
   * When each cell and each coupling arrives, sorted.
   *
   * Sorted once per graph so the counts at a moment are two binary searches
   * rather than a scan of every node and edge on every frame.
   */
  const arrivals = useMemo(() => {
    const cells = (graph?.nodes ?? []).map((node) => arrivalOf(node.lastRunDaysAgo)).sort((a, b) => a - b);
    const couplings = (graph?.edges ?? []).map((edge) => edge.recency).sort((a, b) => a - b);
    return { cells, couplings };
  }, [graph]);

  /** How many of a sorted arrival list have landed by `at`. */
  const landed = (sorted: readonly number[], at: number): number => {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((sorted[mid] as number) <= at) low = mid + 1;
      else high = mid;
    }
    return low;
  };

  const frame = useMemo<TimeLapseFrame>(() => {
    const daysAgo = Math.round((1 - epoch) * RECENCY_WINDOW_DAYS);
    return {
      epoch,
      daysAgo,
      label: labelFor(daysAgo),
      cells: landed(arrivals.cells, epoch),
      couplings: landed(arrivals.couplings, epoch),
    };
  }, [arrivals, epoch]);

  const advance = useCallback((next: number) => {
    // One render per day of the window, not one per frame.
    const day = Math.round((1 - next) * RECENCY_WINDOW_DAYS);
    const previous = Math.round((1 - shown.current) * RECENCY_WINDOW_DAYS);
    if (day === previous && next < 1) return;
    shown.current = next;
    setEpoch(next);
    if (next >= 1) setPlaying(false);
  }, []);

  const play = useCallback(() => {
    // Pressing play on a finished lapse must play it again rather than do
    // nothing, which is indistinguishable from a broken control.
    if (epoch >= 0.999) {
      shown.current = 0;
      setEpoch(0);
    }
    setPlaying(true);
  }, [epoch]);

  const pause = useCallback(() => setPlaying(false), []);

  const restart = useCallback(() => {
    shown.current = 0;
    setEpoch(0);
    setPlaying(true);
  }, []);

  const scrub = useCallback((next: number) => {
    const clamped = Math.min(1, Math.max(0, next));
    shown.current = clamped;
    setEpoch(clamped);
    setPlaying(false);
  }, []);

  const reset = useCallback(() => {
    shown.current = 1;
    setEpoch(1);
    setPlaying(false);
  }, []);

  return {
    frame,
    playing,
    total: { cells: arrivals.cells.length, couplings: arrivals.couplings.length },
    play,
    restart,
    pause,
    scrub,
    advance,
    reset,
  };
};
