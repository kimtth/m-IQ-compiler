import { useCallback, useEffect, useState } from "react";
import { DEVICE_SAMPLE_MODULE, type SampleModuleId, type SampleModuleStatus, type SampleStatus } from "@iq/shared";
import { call, subscribe } from "../bridge.js";
import {
  countDemoIqCells,
  forgetRemovedDemoIqCells,
  reconcileDemoIqCells,
  removeDemoIqCells,
} from "./iqcells.js";

/**
 * The renderer's half of the samples hub.
 *
 * Four of the five modules live on the privileged side and are reported by
 * `samples:status`. The fifth — the demo IQ Cell library — lives in this
 * process's `localStorage`, so main can neither read nor change it. This hook
 * is where the two halves become one list, so every surface asks one question
 * and no caller has to know which side owns what.
 *
 * `enabled` defaults to `true` while the first read is in flight, matching the
 * stored default. Assuming `false` would make the demo library flicker out and
 * back on every launch.
 */

const DEVICE_MODULE: SampleModuleId = DEVICE_SAMPLE_MODULE.id;

export interface Samples {
  enabled: boolean;
  modules: SampleModuleStatus[];
  setEnabled: (enabled: boolean) => Promise<void>;
  load: (module: SampleModuleId) => Promise<string>;
  clear: (module: SampleModuleId) => Promise<string>;
}

/** The device-owned row, read from this process's own storage. */
function deviceModule(projectId: string | null): SampleModuleStatus {
  const cells = countDemoIqCells(projectId);
  return {
    // How this module names itself is `@iq/shared`'s answer, not this file's:
    // the privileged hub lists the same row and the two used to hold separate,
    // byte-identical copies of the label and the detail.
    ...DEVICE_SAMPLE_MODULE,
    loaded: cells > 0,
    summary: `${cells} demo cells in the library`,
    warning: "",
  };
}

export function useSamples(projectId: string | null = null): Samples {
  const [status, setStatus] = useState<SampleStatus>({ enabled: true, modules: [] });
  const [device, setDevice] = useState<SampleModuleStatus>(() => deviceModule(projectId));

  const refresh = useCallback(async () => {
    setDevice(deviceModule(projectId));
    try {
      setStatus(await call("samples:status"));
    } catch {
      // A surface that offers samples must still work when the hub cannot be
      // read; the offers simply stay as they were.
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    return subscribe<SampleStatus>("samples:changed", setStatus);
  }, [refresh]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    setStatus(await call("samples:setEnabled", { enabled }));
  }, []);

  /**
   * Load or clear one module.
   *
   * The device-owned module is handled here and the rest go to the hub, which
   * is the only place this split exists. Both return the sentence to show the
   * user, so the caller never has to compose one from a count.
   */
  const act = useCallback(
    async (module: SampleModuleId, which: "load" | "clear"): Promise<string> => {
      if (module === DEVICE_MODULE) {
        let message: string;
        if (which === "load") {
          // Forgetting the removals first is what makes this the inverse of
          // clear: the removal ledger is what stops a deleted demo cell coming
          // back, and it would just as happily stop this from adding one.
          forgetRemovedDemoIqCells(projectId);
          const added = reconcileDemoIqCells(projectId);
          message = `Added ${added} demo IQ Cells. They are ordinary records — rename, open or remove any of them.`;
        } else {
          const removed = removeDemoIqCells(projectId);
          message = `Removed ${removed} demo IQ Cells. Cells you compiled yourself are untouched.`;
        }
        setDevice(deviceModule(projectId));
        return message;
      }

      const channel = which === "load" ? "samples:load" : "samples:clear";
      const result = await call(channel, { module });
      setStatus(result.status);
      return result.message;
    },
    [projectId],
  );

  return {
    enabled: status.enabled,
    // Device row last: the app-owned modules are the ones whose state survives
    // a reinstall, and they are what someone auditing their data cares about.
    modules: [...status.modules, device],
    setEnabled,
    load: (module) => act(module, "load"),
    clear: (module) => act(module, "clear"),
  };
}

/**
 * Just the flag, for a surface that only needs to know whether to offer.
 *
 * Separate from {@link useSamples} because most callers want exactly this and
 * nothing else, and reading the whole status would make them re-render on every
 * load or clear anywhere in the app.
 */
export function useSampleData(): boolean {
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    call("samples:status")
      .then((status) => setEnabled(status.enabled))
      .catch(() => undefined);
    return subscribe<SampleStatus>("samples:changed", (status) => setEnabled(status.enabled));
  }, []);

  return enabled;
}
