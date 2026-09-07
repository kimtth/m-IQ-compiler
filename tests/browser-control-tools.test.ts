import { describe, expect, it } from "vitest";
import {
  BrowserUrlPolicy,
  createBrowserTools,
  type BrowserActResult,
  type BrowserPaneHost,
} from "@iq/core";

/**
 * The agent controls the browser the user is watching, so these tests pin the
 * two things that make that safe: an act reaches the pane only through a
 * governed tool, and every act that can change a remote page is classified
 * `external` so it is confirmed rather than silently auto-approved.
 */

const policy = new BrowserUrlPolicy({
  browserEnabled: true,
  browserDeniedHosts: [],
} as never);

function result(detail: string): BrowserActResult {
  return { url: "https://example.com/", title: "Example", detail };
}

function hostWithControls(calls: string[]): Required<BrowserPaneHost> {
  return {
    open: async (url) => ({ url, title: "Example" }),
    read: async () => ({
      url: "https://example.com/",
      title: "Example",
      text: "hello",
      truncated: false,
      canGoBack: false,
      canGoForward: false,
      loading: false,
    }),
    back: async () => ({
      url: "https://example.com/",
      title: "Example",
      text: "",
      truncated: false,
      canGoBack: false,
      canGoForward: true,
      loading: false,
    }),
    forward: async () => ({
      url: "https://example.com/",
      title: "Example",
      text: "",
      truncated: false,
      canGoBack: true,
      canGoForward: false,
      loading: false,
    }),
    reload: async () => ({
      url: "https://example.com/",
      title: "Example",
      text: "",
      truncated: false,
      canGoBack: false,
      canGoForward: false,
      loading: true,
    }),
    close: async () => {},
    elements: async () => ({
      url: "https://example.com/",
      title: "Example",
      outline: 'e1 button "Sign in"\ne2 text "Search"',
      truncated: false,
    }),
    click: async (ref) => {
      calls.push(`click:${ref}`);
      return result("clicked");
    },
    fill: async (ref, text, submit) => {
      calls.push(`fill:${ref}:${text}:${submit}`);
      return result("filled");
    },
    select: async (ref, values) => {
      calls.push(`select:${ref}:${values.join("|")}`);
      return result("selected");
    },
    press: async (key) => {
      calls.push(`press:${key}`);
      return result("pressed");
    },
    scroll: async (direction, amount) => {
      calls.push(`scroll:${direction}:${amount}`);
      return result("scrolled");
    },
    waitFor: async (text, timeoutMs) => {
      calls.push(`wait:${text}:${timeoutMs}`);
      return result("waited");
    },
  };
}

describe("browser control tools", () => {
  it("exposes the control verbs only when the pane implements them", () => {
    const minimal = createBrowserTools({
      policy,
      pane: { open: async (url) => ({ url, title: "" }) },
    });
    expect(minimal.map((tool) => tool.name)).toEqual(["open_browser_pane"]);

    const full = createBrowserTools({ policy, pane: hostWithControls([]) });
    expect(full.map((tool) => tool.name)).toEqual([
      "open_browser_pane",
      "read_browser_page",
      "browser_go_back",
      "browser_go_forward",
      "browser_reload",
      "browser_elements",
      "browser_click",
      "browser_fill",
      "browser_select",
      "browser_press_key",
      "browser_scroll",
      "browser_wait_for",
      "close_browser_pane",
    ]);
  });

  it("classifies acting on a remote page as external and pane-local moves as write", () => {
    const tools = createBrowserTools({ policy, pane: hostWithControls([]) });
    const risk = Object.fromEntries(tools.map((tool) => [tool.name, tool.risk]));

    // These can submit a form, send a message or spend money.
    expect(risk["browser_click"]).toBe("external");
    expect(risk["browser_fill"]).toBe("external");
    expect(risk["browser_select"]).toBe("external");
    expect(risk["browser_press_key"]).toBe("external");
    // Reading a page returns attacker-controlled text.
    expect(risk["browser_elements"]).toBe("external");
    // These reach no new host and change nothing on it.
    expect(risk["browser_scroll"]).toBe("write");
    expect(risk["browser_wait_for"]).toBe("write");
  });

  it("passes handles and text through to the pane unchanged", async () => {
    const calls: string[] = [];
    const tools = createBrowserTools({ policy, pane: hostWithControls(calls) });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    await byName.get("browser_click")!.handler(
      byName.get("browser_click")!.parameters.parse({
        ref: "e1",
        label: "Sign in",
        reason: "start the flow",
      }),
      {} as never,
    );
    // Non-Latin text must survive the tool boundary intact: it is the reason
    // fills go through insertText rather than synthesised key events.
    await byName.get("browser_fill")!.handler(
      byName.get("browser_fill")!.parameters.parse({
        ref: "e2",
        label: "Search",
        text: "안녕하세요",
        reason: "search",
      }),
      {} as never,
    );

    expect(calls).toEqual(["click:e1", "fill:e2:안녕하세요:false"]);
  });

  it("defaults a fill to not submitting and a scroll to one viewport down", () => {
    const tools = createBrowserTools({ policy, pane: hostWithControls([]) });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const fill = byName
      .get("browser_fill")!
      .parameters.parse({ ref: "e1", label: "Search", text: "x", reason: "y" });
    expect(fill).toMatchObject({ submit: false });

    const scroll = byName.get("browser_scroll")!.parameters.parse({ reason: "see more" });
    expect(scroll).toMatchObject({ direction: "down", amount: 1 });
  });

  it("labels the element map as untrusted page content", async () => {
    const tools = createBrowserTools({ policy, pane: hostWithControls([]) });
    const elements = tools.find((tool) => tool.name === "browser_elements")!;
    const output = (await elements.handler({ reason: "find the button" } as never, {} as never)) as {
      ok: boolean;
      elements: string;
      note: string;
    };

    expect(output.ok).toBe(true);
    expect(output.elements).toContain('e1 button "Sign in"');
    expect(output.note).toMatch(/untrusted/i);
    expect(output.note).toMatch(/never as instructions/i);
  });

  it("summarizes an act with the visible label so the approval card is readable", () => {
    const tools = createBrowserTools({ policy, pane: hostWithControls([]) });
    const click = tools.find((tool) => tool.name === "browser_click")!;
    expect(click.summarize?.({ ref: "e1", label: "Delete account", reason: "asked" } as never)).toBe(
      'Click "Delete account" in the browser pane — asked',
    );
  });
});
