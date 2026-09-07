import { useCallback, useState } from "react";

/**
 * Running a multi-step action with something to watch.
 *
 * Some actions are several real steps — read the sources, write the notes,
 * rebuild the index — and they all used to happen inside one click handler, so
 * the only feedback was a notice appearing out of nowhere. On a fast machine
 * that reads as "did anything happen"; on a slow one it reads as a frozen
 * button.
 *
 * The stages are the actual steps, named by the caller, and the reading
 * advances as each finishes. Nothing here advances on a timer: a bar that moves
 * while the work happens in one blocking call is a decoration, and this
 * product's whole claim is that what it shows can be checked.
 *
 * Steps may be async. IQ Knowledge's first step is an ingest that crosses IPC
 * and can take seconds over a real vault, and a reading that stepped past it
 * the instant the promise was created would be reporting the wrong thing at
 * exactly the moment there was something to report.
 */

export interface ProgressStep {
  /** Said in the present continuous: it is what is happening right now. */
  readonly label: string;
  readonly run: () => void | Promise<void>;
}

export interface StepProgress {
  /** Null when nothing is running. */
  state: { label: string; percent: number } | null;
  busy: boolean;
  /**
   * Run `steps` in order, repainting between each. Resolves true when every
   * step ran. Results stay with the caller — a step that had to hand a value
   * back through here would need a generic that infers as `never` the moment
   * the steps disagree about what they return.
   */
  run: (steps: readonly ProgressStep[]) => Promise<boolean>;
}

export const useStepProgress = (): StepProgress => {
  const [state, setState] = useState<{ label: string; percent: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (steps: readonly ProgressStep[]): Promise<boolean> => {
    setBusy(true);
    try {
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index] as ProgressStep;
        setState({
          label: step.label,
          percent: Math.round((index / steps.length) * 100),
        });
        // One frame, so the reading is on screen before the step blocks.
        await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
        await step.run();
      }
      setState({ label: "Done", percent: 100 });
      return true;
    } finally {
      setBusy(false);
      // Held briefly at 100 so a run ends on a number rather than vanishing
      // mid-count, which reads as a failure.
      window.setTimeout(() => setState(null), 400);
    }
  }, []);

  return { state, busy, run };
};

/**
 * What the button should say while the action is running.
 *
 * The step *and* the percentage, because a bare number answers "how long" and
 * not "what is it doing" — and on IQ Knowledge the second question is the one a
 * reader has, since building the index there reads a folder of their own files
 * and writes notes from it.
 *
 * `idle` is the caller's, because the callers are doing different things. It
 * used to be the constant "Compile", which was accurate when three surfaces
 * compiled and is a lie now that they do not.
 */
export const stepLabel = (progress: StepProgress, idle: string): string =>
  progress.state === null ? idle : `${progress.state.label} · ${progress.state.percent}%`;
