import { useCallback, useState } from "react";

/**
 * One action, with the envelope written once.
 *
 * Every surface in this app does the same thing when the user presses a button:
 * mark itself busy, call across the bridge, refresh, report a failure to the
 * shell, clear busy. It was written out by hand 131 times. That is not a style
 * problem — the `finally` was correct in each copy by luck rather than by
 * construction, and a copy that omits it leaves every control on the surface
 * disabled with no way back except a reload.
 *
 * `busy` is offered but never forced: a surface that has nothing to disable can
 * ignore it and still get the error reporting.
 */
export interface Action {
  /** True while an action is in flight. */
  busy: boolean;
  /**
   * Run one action, marking the surface busy for its duration. Returns `true`
   * when it completed, so a caller can close a form or clear a draft only on
   * success.
   */
  run: (action: () => Promise<void>) => Promise<boolean>;
  /**
   * Run one action without touching `busy`.
   *
   * Plenty of calls report a failure but disable nothing while they are in
   * flight — a background refresh, a search that runs as you type. Those want
   * the error envelope and nothing else. Routing them through `run` would
   * disable controls that used to stay live, which is a change in behaviour,
   * not a tidy-up.
   */
  attempt: (action: () => Promise<void>) => Promise<boolean>;
}

export function useAction(onError: (problem: unknown) => void): Action {
  const [busy, setBusy] = useState(false);

  const attempt = useCallback(
    async (action: () => Promise<void>): Promise<boolean> => {
      try {
        await action();
        return true;
      } catch (problem) {
        onError(problem);
        return false;
      }
    },
    [onError],
  );

  const run = useCallback(
    async (action: () => Promise<void>): Promise<boolean> => {
      setBusy(true);
      try {
        return await attempt(action);
      } finally {
        setBusy(false);
      }
    },
    [attempt],
  );

  return { busy, run, attempt };
}
