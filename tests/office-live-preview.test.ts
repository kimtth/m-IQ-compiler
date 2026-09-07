import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Everything from source, never from the `@iq/core` entry point — that entry
// resolves to `dist`, and a class taken from there is a different declaration
// than the one `OfficeCli` (imported from source) expects.
import { createLogger } from "../packages/core/src/util/logger.js";
import {
  ensureAppPaths,
  resolveAppPaths,
  type AppPaths,
} from "../packages/core/src/config/paths.js";
import { AuditLog } from "../packages/core/src/audit/audit-log.js";
import { OfficeCli } from "../packages/core/src/office/officecli.js";
import { createOfficeTools } from "../packages/core/src/office/tools.js";
import type { ToolContext } from "../packages/core/src/runtime/tools/registry.js";

/**
 * Live preview, against the **real** OfficeCLI binary.
 *
 * The unit tests use a fake subprocess, which can only prove that we compose
 * the argv we meant to compose. It cannot answer the question that matters —
 * *does a preview taken while the deck is being built actually show the deck
 * being built?* — because that depends on OfficeCLI's own flush and render
 * behaviour, not on ours. So this suite drives the installed binary.
 *
 * It is skipped when no binary is installed, rather than failing: the managed
 * install is a download, and a machine without it is not a broken checkout.
 * The binary is reached through a junction into a throwaway app root, so the
 * suite never writes to the developer's real IQ_HOME.
 */

const IQ_HOME = process.env["IQ_HOME"] ?? join(homedir(), ".iq-compiler");
const INSTALLED_TOOLS = join(IQ_HOME, "tools", "officecli");
const installed = existsSync(INSTALLED_TOOLS);

let root: string;
let paths: AppPaths;
let project: string;
let link: string;
let cli: OfficeCli;

/**
 * A deck rendered to HTML, reduced to its readable text.
 *
 * Entities are decoded, not just tags stripped: a slide titled "AI & Innovation"
 * is rendered as `AI &amp; Innovation`, and a test that could not see through
 * that would report a working batch as a failure.
 */
const rendered = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_match, entity: string) => {
      const table: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        "#39": "'",
        apos: "'",
        nbsp: " ",
      };
      return table[entity] ?? _match;
    })
    .replace(/\s+/g, " ");

/**
 * Delete the temp tree, tolerating a resident that has not finished exiting.
 *
 * `close` returns when OfficeCLI has flushed, but the process itself goes away
 * a moment later and Windows keeps the handle until it does. Under a full-suite
 * run that moment is long enough to fail an immediate delete, which would make
 * this suite flaky for a reason that has nothing to do with what it tests.
 */
async function removeTree(path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * Whether the file can be opened for writing.
 *
 * On Windows a resident OfficeCLI process holds the document, and an exclusive
 * open is the only honest way to ask "has it let go?" — the file exists either
 * way.
 */
function writable(path: string): boolean {
  try {
    closeSync(openSync(path, "r+"));
    return true;
  } catch {
    return false;
  }
}

/**
 * A geometry readback in points.
 *
 * OfficeCLI answers in whatever unit is closest to the stored value — `66pt`,
 * `29.21cm`, `4351338emu` all come back from the same `get` — so a comparison
 * has to normalise before it means anything.
 */
function pt(value: unknown): number {
  const text = String(value);
  const match = /^(-?[\d.]+)\s*(pt|cm|mm|in|emu|px)?$/i.exec(text);
  if (!match) throw new Error(`not a length: ${text}`);
  const size = Number(match[1]);
  switch ((match[2] ?? "pt").toLowerCase()) {
    case "cm":
      return (size / 2.54) * 72;
    case "mm":
      return (size / 25.4) * 72;
    case "in":
      return size * 72;
    case "emu":
      return size / 12_700;
    case "px":
      return (size / 96) * 72;
    default:
      return size;
  }
}

const context = (turnId: string): ToolContext =>
  ({
    turnId,
    sessionId: "session-live",
    correlationId: "corr-live",
    logger: createLogger("error"),
  }) as unknown as ToolContext;

describe.skipIf(!installed)("OfficeCLI live preview (real binary)", () => {
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "iq-office-live-"));
    paths = resolveAppPaths(root);
    await ensureAppPaths(paths);
    project = paths.project;

    // A junction, not a copy: the binary is a self-contained .NET build and
    // copying it per test would dominate the run.
    mkdirSync(join(root, "tools"), { recursive: true });
    link = join(root, "tools", "officecli");
    symlinkSync(INSTALLED_TOOLS, link, "junction");

    cli = new OfficeCli({
      logger: createLogger("error"),
      audit: new AuditLog(paths),
      paths,
      projectDir: () => project,
      correlationId: () => "corr-live",
    });
  });

  afterEach(async () => {
    // OfficeCLI keeps a resident process holding every document it mutated, so
    // the temp tree cannot be deleted until they are closed. This is also the
    // teardown the app performs on quit.
    await cli.disposeAll().catch(() => undefined);
    // Remove the junction explicitly, and first: it points at the developer's
    // real OfficeCLI install and must never be recursed into. `rmdirSync`
    // removes the reparse point itself — a junction is a directory, so `rmSync`
    // refuses it and `unlinkSync` cannot take it.
    rmdirSync(link);
    await removeTree(root);
  }, 30_000);

  it("finds the installed binary and reports it ready", async () => {
    const status = await cli.status();
    expect(status.state).toBe("ready");
    expect(status.version).toMatch(/^\d+\.\d+\.\d+/);
  }, 60_000);

  it("shows the deck growing: every added slide appears in the next render", async () => {
    // This is the claim the surface makes. Each render happens between two
    // mutations, so it is a picture of a real, settled, half-built deck.
    await cli.invoke("create", [], { targetPath: "deck.pptx", turnId: "turn-1" });

    const frames: string[] = [];
    for (const title of ["Company Overview", "Cloud Services", "Global Impact"]) {
      await cli.invoke("add", ["/", "--type", "slide"], {
        targetPath: "deck.pptx",
        turnId: "turn-1",
      });
      const slide = frames.length + 1;
      await cli.invoke("add", [`/slide[${slide}]`, "--type", "shape", "--prop", `text=${title}`], {
        targetPath: "deck.pptx",
        turnId: "turn-1",
      });
      const preview = await cli.preview("deck.pptx", "html");
      expect(preview.problem).toBe("");
      frames.push(rendered(preview.content));
    }

    // Each frame contains everything the previous one did, plus the new slide.
    expect(frames[0]).toContain("Company Overview");
    expect(frames[1]).toContain("Company Overview");
    expect(frames[1]).toContain("Cloud Services");
    expect(frames[2]).toContain("Global Impact");
    expect(frames[2]!.length).toBeGreaterThan(frames[0]!.length);
  }, 180_000);

  it("is labelled generating until the writing turn ends, then settles", async () => {
    await cli.invoke("create", [], { targetPath: "deck.pptx", turnId: "turn-2" });
    await cli.invoke("add", ["/", "--type", "slide"], {
      targetPath: "deck.pptx",
      turnId: "turn-2",
    });
    expect((await cli.preview("deck.pptx", "html")).generating).toBe(true);

    cli.finishTurn("turn-2");
    const settled = await cli.preview("deck.pptx", "html");
    expect(settled.generating).toBe(false);
    expect(settled.problem).toBe("");
  }, 180_000);

  it("renders correctly even when previews and mutations are issued together", async () => {
    // The renderer fires a preview on every change event, so previews really do
    // arrive while the agent is still writing. Serialised, none of them may
    // fail and none may corrupt the document.
    await cli.invoke("create", [], { targetPath: "deck.pptx", turnId: "turn-3" });
    await cli.invoke("add", ["/", "--type", "slide"], {
      targetPath: "deck.pptx",
      turnId: "turn-3",
    });

    const work = [
      cli.invoke("add", ["/slide[1]", "--type", "shape", "--prop", "text=Alpha"], {
        targetPath: "deck.pptx",
        turnId: "turn-3",
      }),
      cli.preview("deck.pptx", "html"),
      cli.invoke("add", ["/", "--type", "slide"], {
        targetPath: "deck.pptx",
        turnId: "turn-3",
      }),
      cli.preview("deck.pptx", "html"),
    ];
    const settled = await Promise.allSettled(work);
    expect(settled.every((entry) => entry.status === "fulfilled")).toBe(true);

    // The document survived the interleaving: it still validates, and the text
    // written during it is present.
    const validate = await cli.invoke("validate", ["--json"], { targetPath: "deck.pptx" });
    expect(validate.code).toBe(0);
    expect(rendered((await cli.preview("deck.pptx", "html")).content)).toContain("Alpha");
  }, 180_000);

  it("builds a deck through the governed tools the model is offered", async () => {
    // The closest a test can get to a real turn without a model: the same tool
    // objects the SDK is handed, invoked with the same argument shapes.
    const tools = createOfficeTools({ office: cli });
    const tool = (name: string) => tools.find((entry) => entry.name === name)!;

    const created = (await tool("office_create_document").handler(
      { path: "brief.pptx" },
      context("turn-4"),
    )) as { ok: boolean };
    expect(created.ok).toBe(true);

    await tool("office_add_content").handler(
      { path: "brief.pptx", target: "/", type: "slide", properties: [] },
      context("turn-4"),
    );
    const added = (await tool("office_add_content").handler(
      {
        path: "brief.pptx",
        target: "/slide[1]",
        type: "shape",
        properties: ["text=Microsoft: Innovation & Technology", "x=2cm", "y=4cm"],
      },
      context("turn-4"),
    )) as { ok: boolean };
    expect(added.ok).toBe(true);

    const preview = await cli.preview("brief.pptx", "html");
    expect(preview.problem).toBe("");
    expect(rendered(preview.content)).toContain("Microsoft");
  }, 180_000);

  it("builds a whole deck in one approved call", async () => {
    // The shape of the fix for "each slide requests separate approval": one
    // tool call, one approval card, six slides.
    await cli.invoke("create", [], { targetPath: "one-call.pptx", turnId: "turn-6" });

    const titles = ["Company Overview", "Core Products", "Cloud Services", "AI & Innovation"];
    const items = titles.flatMap((title, index) => [
      { target: "/", type: "slide" },
      {
        target: `/slide[${index + 1}]`,
        type: "shape",
        properties: [`text=${title}`, "x=2cm", "y=3cm"],
      },
    ]);

    const result = await cli.addMany("one-call.pptx", items, { turnId: "turn-6" });
    expect(result.code, result.stderr || result.stdout).toBe(0);

    const preview = await cli.preview("one-call.pptx", "html");
    expect(preview.problem).toBe("");
    const text = rendered(preview.content);
    for (const title of titles) expect(text).toContain(title);
  }, 180_000);

  it("renders a deck from layouts, so the placeholders are laid out by the master", async () => {
    // What the skill now tells the model to do. A slide carrying `layout`,
    // `title` and `text` materialises the master's own title and body
    // placeholders — full width, body below the title, 44pt/24pt. Adding bare
    // shapes without geometry instead is what produced the deck the user
    // reported as useless: OfficeCLI's default box is 10cm × 5cm at y=1.5cm,
    // so every slide was a quarter-width block of text sitting on its own title.
    const items = [
      {
        target: "/",
        type: "slide",
        properties: ["layout=Title Slide", "title=Microsoft", "text=Global technology leader"],
      },
      {
        target: "/",
        type: "slide",
        properties: [
          "layout=Title and Content",
          "title=Company Overview",
          // A real newline, not a literal `\n`: batch items travel as JSON, so
          // by the time OfficeCLI reads the value the escape is already a
          // newline. Each one starts a new bullet.
          "text=Founded: 1975\nHeadquarters: Redmond\nCEO: Satya Nadella",
        ],
      },
    ];
    await cli.invoke("create", [], { targetPath: "layouts.pptx", turnId: "turn-7" });
    const result = await cli.addMany("layouts.pptx", items, { turnId: "turn-7" });
    expect(result.code, result.stderr || result.stdout).toBe(0);

    const body = await cli.invoke("query", ["slide[2] shape", "--json"], {
      targetPath: "layouts.pptx",
    });
    const found = JSON.parse(body.stdout) as {
      data: { results: { format: Record<string, unknown>; children: unknown[] }[] };
    };
    const shapes = found.data.results;
    const title = shapes.find((shape) => shape.format["isTitle"] === true)!;
    const content = shapes.find((shape) => shape.format["phType"] === "body")!;

    // The body sits below the title rather than on top of it, and the bullets
    // are separate paragraphs rather than one run.
    expect(pt(title.format["y"])).toBeLessThan(pt(content.format["y"]));
    expect(pt(title.format["y"]) + pt(title.format["height"])).toBeLessThanOrEqual(
      pt(content.format["y"]),
    );
    expect(content.children.length).toBe(3);
  }, 180_000);

  it("takes the slide navigator out of the rendered preview", async () => {
    // The canvas renders this markup with `sandbox=""`, so OfficeCLI's
    // script-driven thumbnail strip and ☰ toggle can never work there.
    await cli.invoke("create", [], { targetPath: "nav.pptx", turnId: "turn-8" });
    await cli.addMany(
      "nav.pptx",
      [
        { target: "/", type: "slide", properties: ["layout=Title Only", "title=One"] },
        { target: "/", type: "slide", properties: ["layout=Title Only", "title=Two"] },
      ],
      { turnId: "turn-8" },
    );

    const preview = await cli.preview("nav.pptx", "html");
    expect(preview.problem).toBe("");
    // The markup is gone. The orphaned CSS rules and the `toggleSidebar`
    // function stay — they are inert, and rewriting a stylesheet we do not own
    // is a bigger risk than leaving a dead selector in it.
    expect(preview.content).not.toContain('<div class="sidebar">');
    expect(preview.content).not.toContain("<button");
    expect(preview.content).not.toContain('class="thumb"');
    expect(preview.content).not.toContain('<div class="thumb-inner">');
    // The slides themselves are untouched.
    const text = rendered(preview.content);
    expect(text).toContain("One");
    expect(text).toContain("Two");
  }, 180_000);

  it("renders through the document's own application, or says why it cannot", async () => {
    // The truth check. `--render native` drives PowerPoint, which is the only
    // renderer here that answers "does this fit?" — the HTML view draws
    // placeholder text a quarter too small and clips overflow instead of
    // spilling it, so it flatters the document twice over.
    //
    // Both outcomes are asserted because both are normal: most machines have no
    // PowerPoint, and absence must arrive as a message about installing it, not
    // as a thrown error or a silent fall back to the renderer under suspicion.
    await cli.invoke("create", [], { targetPath: "real.pptx", turnId: "turn-9" });
    await cli.addMany(
      "real.pptx",
      [
        {
          target: "/",
          type: "slide",
          properties: ["layout=Title and Content", "title=Fit", "text=one\ntwo"],
        },
      ],
      { turnId: "turn-9" },
    );
    cli.finishTurn("turn-9");

    const render = await cli.renderNative("real.pptx", { page: 1 });
    expect(render.page).toBe(1);
    expect(render.kind).toBe("pptx");
    if (render.image === "") {
      expect(render.problem).toMatch(/PowerPoint or Word/i);
    } else {
      expect(render.problem).toBe("");
      expect(render.image.startsWith("data:image/png;base64,")).toBe(true);
      // A real PNG, not an empty file dressed as one.
      expect(render.image.length).toBeGreaterThan(2_000);
    }

    // The scratch file is not state: whatever happened, nothing is left behind.
    expect(existsSync(paths.renders) ? readdirSync(paths.renders) : []).toEqual([]);
  }, 240_000);

  it("builds every slide pattern the skill tells the model to use", async () => {
    // `skills/officecli-pptx/SKILL.md` now asks for a designed deck — cards,
    // charts, a Mermaid flowchart, a populated table, a gradient cover — rather
    // than bullets on white. Every one of those recipes is an OfficeCLI feature
    // that can change under us, and a skill that recommends something the
    // binary rejects fails as a silently plainer deck rather than as an error.
    // So each pattern is built here, from the same property names the skill
    // prints.
    await cli.invoke("create", [], { targetPath: "design.pptx", turnId: "turn-10" });

    const result = await cli.addMany(
      "design.pptx",
      [
        // Cover: gradient background, accent bar, oversized title.
        { target: "/", type: "slide", properties: ["layout=Blank", "background=0B1B3A-1E3A8A-315"] },
        {
          target: "/slide[1]",
          type: "shape",
          properties: [
            "geometry=rect",
            "x=66pt",
            "y=200pt",
            "width=8pt",
            "height=120pt",
            "fill=F59E0B",
            "line=none",
          ],
        },
        // KPI card: rounded, shadowed, text centred in the shape.
        { target: "/", type: "slide", properties: ["layout=Title Only", "title=The numbers"] },
        {
          target: "/slide[2]",
          type: "shape",
          properties: [
            "geometry=roundRect",
            "x=66pt",
            "y=170pt",
            "width=250pt",
            "height=150pt",
            "fill=1E3A8A",
            "shadow=000000",
            "text=$8.5M",
            "color=FFFFFF",
            "align=center",
            "valign=middle",
          ],
        },
        // Chart from inline series — no spreadsheet involved.
        { target: "/", type: "slide", properties: ["layout=Title Only", "title=Revenue"] },
        {
          target: "/slide[3]",
          type: "chart",
          properties: [
            "chartType=column",
            "categories=Q1,Q2,Q3,Q4",
            "data=2025:2.1,2.8,3.2,4.5;2024:1.8,2.3,2.7,3.6",
            "x=66pt",
            "y=150pt",
            "width=560pt",
            "height=330pt",
            "legend=bottom",
          ],
        },
        // Mermaid, synthesised into editable shapes with no browser and no CDN.
        { target: "/", type: "slide", properties: ["layout=Title Only", "title=Pipeline"] },
        {
          target: "/slide[4]",
          type: "diagram",
          properties: [
            "mermaid=flowchart LR; A[Lead] --> B[Qualified]; B --> C{Pilot?}; C -->|yes| D[Revenue]",
            "render=native",
            "x=66pt",
            "y=150pt",
            "width=828pt",
            "height=330pt",
          ],
        },
        // Table populated in the same call — one approval, not one per cell.
        { target: "/", type: "slide", properties: ["layout=Title Only", "title=Regions"] },
        {
          target: "/slide[5]",
          type: "table",
          properties: [
            "data=Region,Revenue;North America,$4.2M;Europe,$2.8M",
            "style=medium2",
            "firstRow=true",
            "x=66pt",
            "y=150pt",
            "width=828pt",
            "height=260pt",
          ],
        },
        // Speaker notes, so the slide does not have to carry the script.
        { target: "/slide[5]", type: "notes", properties: ["text=Europe missed on currency."] },
      ],
      { turnId: "turn-10" },
    );
    expect(result.code, result.stderr || result.stdout).toBe(0);
    // `batch` continues past a failed item by default, so a zero exit code is
    // not on its own proof that every pattern worked.
    expect(result.stdout).not.toMatch(/"failed":\s*[1-9]/);

    const validate = await cli.invoke("validate", ["--json"], { targetPath: "design.pptx" });
    expect(validate.code).toBe(0);

    // The diagram is the one that can fail quietly: `render=native` supports
    // flowchart and sequenceDiagram only, and it lands as a single group.
    const diagram = await cli.invoke("query", ["slide[4] group", "--json"], {
      targetPath: "design.pptx",
    });
    expect(JSON.parse(diagram.stdout).data.matches).toBeGreaterThan(0);

    // The card kept the geometry it was asked for, rather than falling back to
    // a plain rectangle in a default box.
    const cards = await cli.invoke("query", ["slide[2] shape", "--json"], {
      targetPath: "design.pptx",
    });
    const shapes = (
      JSON.parse(cards.stdout) as { data: { results: { format: Record<string, unknown> }[] } }
    ).data.results;
    const card = shapes.find((shape) => shape.format["geometry"] === "roundRect");
    expect(card).toBeDefined();
    expect(pt(card!.format["width"])).toBeCloseTo(250, 0);
  }, 240_000);

  it("gives each document a folder of its own, so a project stays readable", async () => {
    // Four attempts at one deck plus eight SVGs used to land in the project
    // root together. The deck now owns a directory, and its resources belong
    // beside it — which is only useful if the caller is told where that is.
    await cli.invoke("create", [], { targetPath: "Quarterly.pptx", turnId: "turn-11" });
    cli.finishTurn("turn-11");

    expect(cli.documentPath("Quarterly.pptx")).toBe("Quarterly/Quarterly.pptx");
    expect(existsSync(join(project, "Quarterly", "Quarterly.pptx"))).toBe(true);
    expect(existsSync(join(project, "Quarterly.pptx"))).toBe(false);

    // Every later verb reaches it by the same bare name the model chose.
    const validate = await cli.invoke("validate", ["--json"], { targetPath: "Quarterly.pptx" });
    expect(validate.code).toBe(0);
  }, 180_000);

  it("releases the file when the turn ends, so the artifact can be opened", async () => {
    // OfficeCLI holds a resident process after any mutation — `create` reports
    // it keeps the document "open in background". Until it is closed the file
    // is locked, which is precisely what the canvas warns the user not to do.
    // A finished turn must not leave the app doing it.
    await cli.invoke("create", [], { targetPath: "final.pptx", turnId: "turn-5" });
    await cli.invoke("add", ["/", "--type", "slide"], {
      targetPath: "final.pptx",
      turnId: "turn-5",
    });

    cli.finishTurn("turn-5");
    // A document is given a folder of its own, so the artifact is not where the
    // name alone would suggest — `cli.documentPath` is how anything outside the
    // service learns where it went.
    const artifact = join(project, cli.documentPath("final.pptx"));
    // Closing is I/O, so wait for the release rather than assuming it.
    await expect.poll(() => writable(artifact), { timeout: 30_000 }).toBe(true);
  }, 180_000);
});
