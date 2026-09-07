import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Everything from source, never from the `@iq/core` entry point. That entry
// resolves to `dist`, and a class taken from there is a *different declaration*
// than the one `OfficeCli` (imported from source) expects — TypeScript rejects
// the assignment on the private field. Nothing here is typechecked by
// `pnpm typecheck`, so the mismatch only ever shows up in the editor.
import { createLogger } from "../packages/core/src/util/logger.js";
import {
  ensureAppPaths,
  resolveAppPaths,
  type AppPaths,
} from "../packages/core/src/config/paths.js";
import { AuditLog } from "../packages/core/src/audit/audit-log.js";
import {
  OfficeCli,
  placeDocument,
  preparePreviewHtml,
  type OfficeSpawn,
  type OfficeSpawnResult,
} from "../packages/core/src/office/officecli.js";
import { createOfficeTools } from "../packages/core/src/office/tools.js";

/**
 * OfficeCLI is an arbitrary file writer pointed at a user path by a model, so
 * the tests pin the safety properties rather than the plumbing: only allowed
 * subcommands run, no path may escape the project, the exact binary version
 * is written into the audit trail of every call, and a preview renders through
 * the view engine. Nothing here executes a real binary or touches the network —
 * the subprocess boundary is a fake that records what it was asked to run.
 */

interface Recorded {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

/** A fake OfficeCLI: answers `--version`, echoes a fixed render, records calls. */
function fakeSpawn(): { spawn: OfficeSpawn; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const spawn: OfficeSpawn = async (command, args, options): Promise<OfficeSpawnResult> => {
    calls.push({ command, args, env: options.env });
    if (args.includes("--version")) {
      return { code: 0, stdout: "officecli 9.9.9\n", stderr: "" };
    }
    if (args[0] === "view") {
      return { code: 0, stdout: "<html><body>rendered</body></html>", stderr: "" };
    }
    return { code: 0, stdout: '{"success":true}', stderr: "" };
  };
  return { spawn, calls };
}

let root: string;
let paths: AppPaths;
let project: string;
let audit: AuditLog;

function makeCli(spawn: OfficeSpawn): OfficeCli {
  return new OfficeCli({
    logger: createLogger("error"),
    audit,
    paths,
    projectDir: () => project,
    correlationId: () => "corr-office",
    spawnImpl: spawn,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iq-office-"));
  paths = resolveAppPaths(root);
  ensureAppPaths(paths);
  project = paths.project;
  audit = new AuditLog(paths);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("OfficeCli.status", () => {
  it("reports ready with the version parsed from the binary on PATH", async () => {
    const { spawn } = fakeSpawn();
    const status = await makeCli(spawn).status();
    expect(status.state).toBe("ready");
    expect(status.origin).toBe("path");
    expect(status.version).toBe("9.9.9");
  });

  it("reports missing when no binary answers --version", async () => {
    const spawn: OfficeSpawn = async () => ({ code: 1, stdout: "", stderr: "not found" });
    const status = await makeCli(spawn).status();
    expect(status.state).toBe("missing");
    expect(status.origin).toBe("none");
    expect(status.message).toMatch(/not installed/i);
  });
});

describe("OfficeCli.invoke — subcommand allow-listing", () => {
  it("runs an allowed subcommand", async () => {
    const { spawn, calls } = fakeSpawn();
    const cli = makeCli(spawn);
    const result = await cli.invoke("create", [], { targetPath: "deck.pptx" });
    expect(result.code).toBe(0);
    // The first non-probe call is the create; its argv leads with the verb.
    const create = calls.find((c) => c.args[0] === "create");
    expect(create).toBeDefined();
    expect(create!.args[0]).toBe("create");
  });

  it("refuses a subcommand outside the closed set, before spawning it", async () => {
    const { spawn, calls } = fakeSpawn();
    const cli = makeCli(spawn);
    await expect(cli.invoke("delete-everything", [], { targetPath: "deck.pptx" })).rejects.toThrow(
      /not an allowed OfficeCLI subcommand/i,
    );
    expect(calls.some((c) => c.args[0] === "delete-everything")).toBe(false);
  });

  it("injects the resident-flush and skip-update environment", async () => {
    const { spawn, calls } = fakeSpawn();
    await makeCli(spawn).invoke("create", [], { targetPath: "deck.pptx" });
    const create = calls.find((c) => c.args[0] === "create")!;
    expect(create.env["OFFICECLI_RESIDENT_FLUSH"]).toBe("each");
    expect(create.env["OFFICECLI_SKIP_UPDATE"]).toBe("1");
  });
});

describe("OfficeCli.invoke — path containment", () => {
  it("refuses a target that escapes the project", async () => {
    const { spawn, calls } = fakeSpawn();
    const cli = makeCli(spawn);
    await expect(cli.invoke("create", [], { targetPath: "../../evil.docx" })).rejects.toThrow(
      /leaves the project/i,
    );
    expect(calls.some((c) => c.args[0] === "create")).toBe(false);
  });

  it("refuses an absolute path smuggled through the argument list", async () => {
    const { spawn } = fakeSpawn();
    const cli = makeCli(spawn);
    await expect(
      cli.invoke("add", ["/", "--prop", "src=C:\\Windows\\win.ini"], { targetPath: "deck.pptx" }),
    ).rejects.toThrow(/names a file path/i);
  });

  it("allows OfficeCLI element selectors, which are not file paths", async () => {
    // `isAbsolute("/")` is true on Windows too, so the old guard denied every
    // add/set/remove the agent issued — a deck could be created and then never
    // filled in. Selectors address a node in the document, not a place on disk.
    const { spawn, calls } = fakeSpawn();
    const cli = makeCli(spawn);
    await cli.invoke("add", ["/", "--type", "slide"], { targetPath: "deck.pptx" });
    await cli.invoke("add", ["/slide[1]", "--prop", "text=Q4"], { targetPath: "deck.pptx" });
    await cli.invoke("set", ["/body/p[1]/r[2]", "--prop", "bold=true"], { targetPath: "q4.docx" });
    expect(calls.filter((c) => c.args[0] === "add")).toHaveLength(2);
    expect(calls.filter((c) => c.args[0] === "set")).toHaveLength(1);
  });

  it("refuses a path hidden in a property value, where the old guard saw nothing", async () => {
    // `isAbsolute("src=C:\\…")` is false — the `key=` prefix hid it — so the
    // value half is what gets examined now.
    const { spawn } = fakeSpawn();
    const cli = makeCli(spawn);
    await expect(
      cli.invoke("add", ["/", "--prop", "src=..\\..\\outside.png"], { targetPath: "deck.pptx" }),
    ).rejects.toThrow(/names a file path/i);
    await expect(
      cli.invoke("add", ["/", "--prop", "src=\\\\server\\share\\x.png"], { targetPath: "deck.pptx" }),
    ).rejects.toThrow(/names a file path/i);
  });

  it("does not mistake ordinary prose for a path", async () => {
    const { spawn, calls } = fakeSpawn();
    const cli = makeCli(spawn);
    await cli.invoke("add", ["/", "--prop", "text=Revenue grew 20% and/or held flat"], {
      targetPath: "deck.pptx",
    });
    expect(calls.some((c) => c.args[0] === "add")).toBe(true);
  });

  it("refuses a non-Office file extension", async () => {
    const { spawn } = fakeSpawn();
    const cli = makeCli(spawn);
    await expect(cli.invoke("create", [], { targetPath: "notes.txt" })).rejects.toThrow(
      /\.docx, \.xlsx or \.pptx/i,
    );
  });

  it("refuses when no project is bound", async () => {
    const cli = new OfficeCli({
      logger: createLogger("error"),
      audit,
      paths,
      projectDir: () => null,
      correlationId: () => "corr-office",
      spawnImpl: fakeSpawn().spawn,
    });
    await expect(cli.invoke("create", [], { targetPath: "deck.pptx" })).rejects.toThrow(
      /requires a bound project/i,
    );
  });
});

describe("OfficeCli — audit", () => {
  it("records the OfficeCLI version and the subcommand in the audit trail", async () => {
    const { spawn } = fakeSpawn();
    await makeCli(spawn).invoke("create", [], { targetPath: "reports/q4.docx" });

    const records = await audit.query({ family: "office", limit: 10 });
    const create = records.find((r) => r.action === "office.create");
    expect(create).toBeDefined();
    expect(create!.outcome).toBe("succeeded");
    expect(create!.resources).toContain("officecli@9.9.9");
    // The target is recorded project-relative, never absolute.
    expect(create!.resources.some((r) => r.replace(/\\/g, "/") === "reports/q4.docx")).toBe(true);
  });

  it("audits a refused subcommand as denied", async () => {
    const { spawn } = fakeSpawn();
    await makeCli(spawn)
      .invoke("nuke", [], { targetPath: "deck.pptx" })
      .catch(() => undefined);

    const records = await audit.query({ family: "office", limit: 10 });
    const denied = records.find((r) => r.outcome === "denied");
    expect(denied).toBeDefined();
    expect(denied!.reason).toMatch(/unknown subcommand/i);
  });
});

/**
 * A page shaped like OfficeCLI's real HTML view: a script-built thumbnail
 * navigator that names every slide, then the slides themselves.
 *
 * Both halves carry `data-slide`, which is the trap — reading the slide list
 * before the navigator is removed reports every deck twice.
 */
const NAVIGATOR_PAGE = [
  "<html><head><style>:root{--slide-design-w:960pt;--slide-design-h:540pt;}</style></head><body>",
  '<div class="toggle-zone"></div><button class="sidebar-toggle" onclick="toggleSidebar()">☰</button>',
  '<div class="sidebar">',
  '  <div class="sidebar-title">deck.pptx</div>',
  '  <div class="thumb" data-slide="1"><div class="thumb-inner"></div></div>',
  '  <div class="thumb" data-slide="2"><div class="thumb-inner"></div></div>',
  "</div>",
  '<div class="main">',
  '<div class="slide-container" data-slide="1">',
  '  <div class="slide-label">Slide 1</div>',
  '  <div class="shape"><div class="para">Company Overview</div></div>',
  '  <div class="shape"><div class="para"><span class="bullet">•</span>Founded 1975</div>',
  '    <div class="para"><span class="bullet">•</span>Redmond, Washington</div></div>',
  "</div>",
  '<div class="slide-container" data-slide="2">',
  '  <div class="slide-label">Slide 2</div>',
  '  <div class="shape"><div class="para">AI &amp; Innovation</div></div>',
  "</div>",
  "</div>",
  "</body></html>",
].join("\n");

/** A fake OfficeCLI whose `view` answers with {@link NAVIGATOR_PAGE}. */
function navigatorSpawn(): OfficeSpawn {
  return async (_command, args) => {
    if (args.includes("--version")) return { code: 0, stdout: "officecli 9.9.9", stderr: "" };
    if (args[0] === "view") return { code: 0, stdout: NAVIGATOR_PAGE, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("OfficeCli — a document gets a folder of its own", () => {
  /**
   * A deck is not one file. It is the file, the images it references, and the
   * versions that came before it — and all of those used to land in the
   * project root. Four attempts at one deck plus eight SVGs left a root
   * nobody could read.
   */
  it("places a bare name in a folder named after it", () => {
    expect(placeDocument(project, "Deck.pptx")).toBe("Deck/Deck.pptx");
    expect(placeDocument(project, "Q4 Review.docx")).toBe("Q4 Review/Q4 Review.docx");
  });

  it("leaves a path that already names a folder alone", () => {
    // The caller has placed it. Second-guessing would make a document
    // unreachable by the name its author chose.
    expect(placeDocument(project, "reports/q4.docx")).toBe("reports/q4.docx");
  });

  it("leaves a file that already exists where it was asked for", () => {
    // Otherwise this rule would orphan every document written before it, and
    // ignore a file the user put in the root deliberately.
    writeFileSync(join(project, "Legacy.pptx"), "");
    expect(placeDocument(project, "Legacy.pptx")).toBe("Legacy.pptx");
  });

  it("invents no folder for a name that has no stem", () => {
    expect(placeDocument(project, ".pptx")).toBe(".pptx");
  });

  it("routes every verb to the same place, so the model can keep its own name", () => {
    // The rule is a pure function of the path — no lookup table, no per-session
    // map — so `Deck.pptx` means the same file on the next call, in the next
    // turn, and after a restart.
    const first = placeDocument(project, "Deck.pptx");
    const second = placeDocument(project, "Deck.pptx");
    expect(second).toBe(first);
  });

  it("creates the folder before writing, because OfficeCLI will not", async () => {
    // The real binary fails with "could not find a part of the path" when the
    // parent directory is missing.
    const { spawn, calls } = fakeSpawn();
    const cli = makeCli(spawn);
    await cli.invoke("create", [], { targetPath: "Deck.pptx" });

    expect(existsSync(join(project, "Deck"))).toBe(true);
    const created = calls.find((entry) => entry.args[0] === "create");
    expect(created?.args[1]).toBe(join(project, "Deck", "Deck.pptx"));
  });

  it("reports where the document went, so resources can be written beside it", async () => {
    const { spawn } = fakeSpawn();
    expect(makeCli(spawn).documentPath("Deck.pptx")).toBe("Deck/Deck.pptx");
  });

  it("still refuses a path that escapes the project", async () => {
    const { spawn } = fakeSpawn();
    await expect(
      makeCli(spawn).invoke("create", [], { targetPath: "../escape.pptx" }),
    ).rejects.toThrow(/leaves the project/i);
  });
});

describe("OfficeCli.preview", () => {
  it("renders through the view engine and returns the markup", async () => {
    const { spawn, calls } = fakeSpawn();
    const preview = await makeCli(spawn).preview("deck.pptx", "html");
    expect(preview.kind).toBe("pptx");
    expect(preview.format).toBe("html");
    expect(preview.content).toContain("rendered");
    expect(preview.generating).toBe(false);
    // Rendering is a `view` call, never `watch`.
    expect(calls.some((c) => c.args[0] === "view" && c.args.includes("html"))).toBe(true);
    expect(calls.some((c) => c.args.includes("watch"))).toBe(false);
  });

  it("labels the preview read-only while a document is generating", async () => {
    const { spawn } = fakeSpawn();
    const cli = makeCli(spawn);
    cli.beginGeneration("deck.pptx");
    const preview = await cli.preview("deck.pptx", "html");
    expect(preview.generating).toBe(true);
  });

  it("reports an unrenderable document as a problem rather than throwing", async () => {
    // A half-built deck is routinely not renderable yet. Throwing turned a
    // healthy build into a stream of error toasts, so it is a state now.
    const spawn: OfficeSpawn = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, stdout: "officecli 9.9.9", stderr: "" };
      if (args[0] === "view") return { code: 3, stdout: "", stderr: "presentation has no slides" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const preview = await makeCli(spawn).preview("deck.pptx", "html");
    expect(preview.content).toBe("");
    expect(preview.problem).toMatch(/no slides/i);
  });

  it("still throws when the path is a refusal rather than an unready document", async () => {
    const { spawn } = fakeSpawn();
    await expect(makeCli(spawn).preview("../escape.pptx", "html")).rejects.toThrow(
      /leaves the project/i,
    );
  });

  it("strips OfficeCLI's slide navigator, which cannot work in the sandboxed frame", async () => {
    // The thumbnails, the ☰ toggle and the keyboard paging are all script
    // driven, and the canvas renders this markup with `sandbox=""` and no
    // `allow-scripts`. Left in, the user gets a column of blank boxes that do
    // nothing when clicked.
    const preview = await makeCli(navigatorSpawn()).preview("deck.pptx", "html");
    expect(preview.content).not.toContain('class="sidebar"');
    expect(preview.content).not.toContain("sidebar-toggle");
    expect(preview.content).not.toContain("toggle-zone");
    // Every thumbnail goes with it — a nested-div count, not a lazy regex.
    expect(preview.content).not.toContain("thumb-inner");
    // …and the slides, which are the whole point of the preview, survive.
    expect(preview.content).toContain("Company Overview");
    expect(preview.content).toContain('<div class="main">');
  });

  it("publishes the slide list the removed navigator was trying to be", async () => {
    // The index is drawn by the host page, outside the sandbox, so the slides
    // have to leave core as data rather than as markup. Each row is the title
    // shape only — running the title into its own bullets made a six-slide
    // index read as six paragraphs.
    const preview = await makeCli(navigatorSpawn()).preview("deck.pptx", "html");
    expect(preview.slides).toEqual([
      { number: 1, title: "Company Overview" },
      { number: 2, title: "AI & Innovation" },
    ]);
  });

  it("publishes the slide design size, because the frame cannot fit itself", async () => {
    // OfficeCLI fits slides to the viewport in a resize handler, and the canvas
    // frame runs no scripts. Without the design size the host cannot scale it,
    // and every slide draws at 960pt with its edges outside the frame.
    const preview = await makeCli(navigatorSpawn()).preview("deck.pptx", "html");
    expect(preview.slideWidthPt).toBe(960);
    expect(preview.slideHeightPt).toBe(540);
  });

  it("counts each slide once, though the navigator names them too", async () => {
    // The sidebar carries a `data-slide` box per slide. Reading the list from
    // the markup before stripping would double every deck.
    const { slides } = preparePreviewHtml(NAVIGATOR_PAGE);
    expect(slides.map((slide) => slide.number)).toEqual([1, 2]);
  });

  it("leaves markup it does not recognise alone", async () => {
    // A future OfficeCLI may rename the navigator. Finding nothing must mean
    // "change nothing", never "truncate the document".
    const plain = "<html><body><p>slides</p></body></html>";
    expect(preparePreviewHtml(plain)).toEqual({
      html: plain,
      slides: [],
      slideWidthPt: 0,
      slideHeightPt: 0,
    });
  });
});

describe("OfficeCli — one process at a time per document", () => {
  it("never lets a render overlap a mutation of the same file", async () => {
    // The whole point of the lock: an Office file is a zip rewritten wholesale,
    // so a `view` inside a write reads a torn file — and on Windows the
    // reader's share-lock can fail the write, meaning the preview would break
    // the generation it is meant to be showing.
    let active = 0;
    let overlapped = false;
    const spawn: OfficeSpawn = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, stdout: "officecli 9.9.9", stderr: "" };
      active += 1;
      if (active > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { code: 0, stdout: args[0] === "view" ? "<html>ok</html>" : "{}", stderr: "" };
    };
    const cli = makeCli(spawn);

    await Promise.all([
      cli.invoke("add", ["/"], { targetPath: "deck.pptx" }),
      cli.preview("deck.pptx", "html"),
      cli.invoke("add", ["/"], { targetPath: "deck.pptx" }),
      cli.preview("deck.pptx", "html"),
    ]);

    expect(overlapped).toBe(false);
  });

  it("does not serialise unrelated documents against each other", async () => {
    let active = 0;
    let concurrent = 0;
    const spawn: OfficeSpawn = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, stdout: "officecli 9.9.9", stderr: "" };
      active += 1;
      concurrent = Math.max(concurrent, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { code: 0, stdout: "{}", stderr: "" };
    };
    const cli = makeCli(spawn);
    // Warm the version probe so it cannot be one of the two measured calls.
    await cli.status();

    await Promise.all([
      cli.invoke("add", ["/"], { targetPath: "deck.pptx" }),
      cli.invoke("add", ["/"], { targetPath: "notes.docx" }),
    ]);

    expect(concurrent).toBe(2);
  });
});

describe("OfficeCli — generation is bounded by the turn", () => {
  it("marks a document generating from the first mutation and releases it when the turn ends", async () => {
    const { spawn } = fakeSpawn();
    const cli = makeCli(spawn);
    const seen: boolean[] = [];
    cli.onChange((change) => seen.push(change.generating));

    await cli.invoke("create", [], { targetPath: "deck.pptx", turnId: "turn-1" });
    await cli.invoke("add", ["/"], { targetPath: "deck.pptx", turnId: "turn-1" });
    expect((await cli.preview("deck.pptx", "html")).generating).toBe(true);

    cli.finishTurn("turn-1");
    expect((await cli.preview("deck.pptx", "html")).generating).toBe(false);
    // Both mutations announced themselves as part of a generation, and the end
    // of the turn announced the settled document.
    expect(seen.slice(0, 2)).toEqual([true, true]);
    expect(seen.at(-1)).toBe(false);
  });

  it("releases a document when the writing turn fails, not only when it succeeds", async () => {
    // A failed or cancelled turn leaves the file half-built; leaving the
    // preview labelled "generating" would tell the user to wait for a run that
    // has already stopped.
    const { spawn } = fakeSpawn();
    const cli = makeCli(spawn);
    await cli.invoke("add", ["/"], { targetPath: "deck.pptx", turnId: "turn-2" });
    cli.finishTurn("turn-2");
    expect((await cli.preview("deck.pptx", "html")).generating).toBe(false);
  });

  it("leaves a document alone when another turn is still writing it", async () => {
    const { spawn } = fakeSpawn();
    const cli = makeCli(spawn);
    await cli.invoke("add", ["/"], { targetPath: "deck.pptx", turnId: "turn-a" });
    await cli.invoke("add", ["/"], { targetPath: "deck.pptx", turnId: "turn-b" });

    cli.finishTurn("turn-a");
    expect((await cli.preview("deck.pptx", "html")).generating).toBe(true);
    cli.finishTurn("turn-b");
    expect((await cli.preview("deck.pptx", "html")).generating).toBe(false);
  });

  it("does not start a generation for a call with no turn behind it", async () => {
    const { spawn } = fakeSpawn();
    const cli = makeCli(spawn);
    await cli.invoke("add", ["/"], { targetPath: "deck.pptx" });
    expect((await cli.preview("deck.pptx", "html")).generating).toBe(false);
  });

  it("never announces a document settled while a later turn is still writing it", async () => {
    // `finishTurn` clears the flag synchronously and lets `settle` close the
    // file afterwards. A turn that claims the document in between must not be
    // told its build has finished: the close is queued behind the per-document
    // lock, so the settled announcement can otherwise land after the new turn's
    // first mutation and read as "done" on a deck that is still growing.
    const { spawn } = fakeSpawn();
    const cli = makeCli(spawn);
    await cli.invoke("add", ["/"], { targetPath: "deck.pptx", turnId: "turn-a" });

    cli.finishTurn("turn-a");
    await cli.invoke("add", ["/"], { targetPath: "deck.pptx", turnId: "turn-b" });

    const seen: boolean[] = [];
    cli.onChange((change) => seen.push(change.generating));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(seen.includes(false)).toBe(false);
    expect((await cli.preview("deck.pptx", "html")).generating).toBe(true);
  });
});

describe("OfficeCli — how a change names the file it touched", () => {
  it("names the file the same way the project navigator does", async () => {
    // `ProjectService.list` and `documentPath` both spell a project-relative
    // path with `/`. An unnormalised `relative()` gives `Deck\Deck.pptx` on
    // Windows, so a consumer comparing the two never matches — which is what
    // left `.tree-row.touched` styled and never applied.
    const { spawn } = fakeSpawn();
    const cli = makeCli(spawn);
    const seen: string[] = [];
    cli.onChange((change) => seen.push(change.path));

    await cli.invoke("create", [], { targetPath: "Deck.pptx" });

    expect(seen[0]).toBe("Deck/Deck.pptx");
    expect(seen[0]).toBe(cli.documentPath("Deck.pptx"));
    expect(seen.every((path) => !path.includes("\\"))).toBe(true);
  });

  it("says which project the change happened in", async () => {
    // A project-relative path is not unique: two projects can both hold
    // `Deck/Deck.pptx`, so a consumer keying on the path alone cannot tell a
    // late event from the project just left from a fresh one here.
    const { spawn } = fakeSpawn();
    const cli = new OfficeCli({
      logger: createLogger("error"),
      audit,
      paths,
      projectDir: () => project,
      projectId: () => "ws_42",
      correlationId: () => "corr-office",
      spawnImpl: spawn,
    });
    const seen: (string | null)[] = [];
    cli.onChange((change) => seen.push(change.projectId));

    await cli.invoke("create", [], { targetPath: "deck.pptx" });
    expect(seen[0]).toBe("ws_42");
  });
});

describe("OfficeCli.addMany", () => {
  it("builds every element in one OfficeCLI call", async () => {
    // The reason this exists: one call is one approval card. Seventeen
    // `office_add_content` calls were seventeen cards for one request.
    const { spawn, calls } = fakeSpawn();
    await makeCli(spawn).addMany(
      "deck.pptx",
      [
        { target: "/", type: "slide" },
        { target: "/slide[1]", type: "shape", properties: ["text=Microsoft", "x=2cm"] },
      ],
      { turnId: "turn-1" },
    );

    const batch = calls.filter((call) => call.args[0] === "batch");
    expect(batch).toHaveLength(1);
    expect(calls.some((call) => call.args[0] === "add")).toBe(false);
  });

  it("sends the items as OfficeCLI batch JSON on stdin", async () => {
    let sent = "";
    const spawn: OfficeSpawn = async (_command, args, options) => {
      if (args.includes("--version")) return { code: 0, stdout: "officecli 9.9.9", stderr: "" };
      if (args[0] === "batch") sent = options.input ?? "";
      return { code: 0, stdout: "{}", stderr: "" };
    };
    await makeCli(spawn).addMany("deck.pptx", [
      { target: "/slide[1]", type: "shape", properties: ["text=Hi", "x=1cm"] },
    ]);

    expect(JSON.parse(sent)).toEqual([
      { command: "add", parent: "/slide[1]", type: "shape", props: { text: "Hi", x: "1cm" } },
    ]);
  });

  it("fixes the verb to add, so a batch can never carry a destructive one", async () => {
    // OfficeCLI's batch format accepts set/remove/move/swap in the same array.
    // Those stay individually approved by design, so the caller never gets to
    // name the command.
    let sent = "";
    const spawn: OfficeSpawn = async (_command, args, options) => {
      if (args.includes("--version")) return { code: 0, stdout: "officecli 9.9.9", stderr: "" };
      if (args[0] === "batch") sent = options.input ?? "";
      return { code: 0, stdout: "{}", stderr: "" };
    };
    await makeCli(spawn).addMany("deck.pptx", [
      { target: "/", type: "slide" },
      { target: "/slide[1]", type: "shape" },
    ]);

    const commands = JSON.parse(sent) as Array<{ command: string }>;
    expect(commands.every((entry) => entry.command === "add")).toBe(true);
  });

  it("refuses a file path hidden in a property, which stdin would smuggle past argv", async () => {
    // Batch arguments travel as JSON on stdin, so the argv containment guard
    // never sees them.
    const { spawn, calls } = fakeSpawn();
    const cli = makeCli(spawn);
    await expect(
      cli.addMany("deck.pptx", [
        { target: "/slide[1]", type: "picture", properties: ["src=C:\\Windows\\win.ini"] },
      ]),
    ).rejects.toThrow(/names a file path/i);
    await expect(
      cli.addMany("deck.pptx", [
        { target: "/slide[1]", type: "picture", properties: ["src=..\\..\\outside.png"] },
      ]),
    ).rejects.toThrow(/names a file path/i);
    expect(calls.some((call) => call.args[0] === "batch")).toBe(false);
  });

  it("refuses a target that is not an element path", async () => {
    const { spawn } = fakeSpawn();
    await expect(
      makeCli(spawn).addMany("deck.pptx", [{ target: "C:\\Windows", type: "slide" }]),
    ).rejects.toThrow(/element path/i);
  });

  it("refuses an empty batch rather than running a no-op", async () => {
    const { spawn } = fakeSpawn();
    await expect(makeCli(spawn).addMany("deck.pptx", [])).rejects.toThrow(/nothing to add/i);
  });
});

describe("createOfficeTools", () => {
  it("marks the destructive verbs so they cannot be auto-approved", () => {
    const { spawn } = fakeSpawn();
    const tools = createOfficeTools({ office: makeCli(spawn) });
    const risk = (name: string) => tools.find((t) => t.name === name)?.risk;

    expect(risk("office_set_content")).toBe("destructive");
    expect(risk("office_remove_element")).toBe("destructive");
    expect(risk("office_merge_template")).toBe("destructive");
    expect(risk("office_create_document")).toBe("write");
    expect(risk("office_query_structure")).toBe("read");
    expect(tools.every((t) => t.family === "office")).toBe(true);
  });

  it("offers the batch add at the same risk as a single add", () => {
    // It is additive only, so it must be remembered by "Allow for this
    // conversation" on exactly the same terms — otherwise the tool that exists
    // to stop the approval storm would itself prompt every time.
    const { spawn } = fakeSpawn();
    const tools = createOfficeTools({ office: makeCli(spawn) });
    const risk = (name: string) => tools.find((t) => t.name === name)?.risk;

    expect(risk("office_add_many")).toBe("write");
    expect(risk("office_add_many")).toBe(risk("office_add_content"));
  });

  it("summarizes a call in plain English naming the subcommand and path", () => {
    const { spawn } = fakeSpawn();
    const tools = createOfficeTools({ office: makeCli(spawn) });
    const create = tools.find((t) => t.name === "office_create_document")!;
    expect(create.summarize({ path: "reports/q4.docx" })).toMatch(/create.*reports\/q4\.docx/i);
  });
});
