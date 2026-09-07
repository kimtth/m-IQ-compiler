/**
 * Where the IQ Cell library and its drafts are kept.
 *
 * The records were reached through `window.localStorage` directly — twenty
 * calls across six modules, under seven key namespaces — so the browser API
 * *was* the interface and there was no seam at all. That had a cost beyond
 * tidiness: `reconcileCells`, the module the stale-draft defect lived in, could
 * not be tested, and the fact that this one module is device-owned had to leak
 * all the way into the shared contract (`SampleOwner`), the samples hub, the
 * IPC channel set and a renderer hook to be presentable.
 *
 * One interface, two adapters — which is what makes it a seam rather than a
 * hypothetical one. The browser adapter is what ships. The in-memory adapter is
 * what tests run against, and it is also the shape a privileged implementation
 * would satisfy, which this store's own header has anticipated from the start.
 */
export interface DeviceStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
  /**
   * Tell the rest of this process that something was staged.
   *
   * Part of the interface rather than a bare `window` event because the handoff
   * from My IQ to the canvas *is* a contract between two surfaces:
   * one writes a draft and says so, the other listens. Left as a global custom
   * event it was two components communicating through `window` with nothing
   * declaring that they did.
   */
  announce(topic: string): void;
  /** Listen for {@link announce}. Returns the unsubscribe. */
  listen(topic: string, handler: () => void): () => void;
}

/** The device this renderer really runs on. */
export const browserDevice: DeviceStore = {
  read: (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      // A profile with storage disabled reads as an empty library rather than
      // an exception thrown through a render.
      return null;
    }
  },
  write: (key, value) => {
    window.localStorage.setItem(key, value);
  },
  remove: (key) => {
    window.localStorage.removeItem(key);
  },
  announce: (topic) => {
    window.dispatchEvent(new CustomEvent(topic));
  },
  listen: (topic, handler) => {
    window.addEventListener(topic, handler);
    return () => window.removeEventListener(topic, handler);
  },
};

/** A device with no browser behind it. The second adapter. */
export function memoryDevice(): DeviceStore {
  const rows = new Map<string, string>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    read: (key) => rows.get(key) ?? null,
    write: (key, value) => {
      rows.set(key, value);
    },
    remove: (key) => {
      rows.delete(key);
    },
    announce: (topic) => {
      for (const handler of listeners.get(topic) ?? []) handler();
    },
    listen: (topic, handler) => {
      const set = listeners.get(topic) ?? new Set();
      set.add(handler);
      listeners.set(topic, set);
      return () => set.delete(handler);
    },
  };
}

let installed: DeviceStore = browserDevice;

/** The store in force. Read through a function so a test can substitute one. */
export const device = (): DeviceStore => installed;

/**
 * Run against a different device.
 *
 * Test-only, and it returns the restore rather than expecting a caller to
 * remember what was there — a store left swapped leaks into the next file.
 */
export function installDevice(next: DeviceStore): () => void {
  const previous = installed;
  installed = next;
  return () => {
    installed = previous;
  };
}
