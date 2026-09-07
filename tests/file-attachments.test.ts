import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileReference, fileReferences, withoutFileReference } from "@iq/shared";
import { SessionRepo } from "../packages/core/src/runtime/sessions/fs-repo.js";
import { SessionsService } from "../packages/core/src/runtime/sessions/sessions.js";
import type { SessionsDeps } from "../packages/core/src/runtime/sessions/sessions.js";
import { TurnRepo } from "../packages/core/src/runtime/turns/fs-repo.js";
import { ensureAppPaths, resolveAppPaths } from "../packages/core/src/config/paths.js";
import { ProjectService } from "../packages/core/src/project/project.js";

/**
 * Attaching a file to a message.
 *
 * "Add File to Chat" used to put a backticked path in the composer and stop.
 * The path was decoration: the model was handed a filename in a turn that had
 * never opened it, so it either guessed at the contents or spent a tool call
 * and an approval card finding out — for a file the user had already,
 * explicitly, chosen to share. These pin that a reference means the file is
 * *in* the turn, and that the containment the project enforces is not waived
 * to do it.
 */
describe("file references", () => {
  it("reads the whole rest of the line, because paths have spaces", () => {
    expect(fileReferences("file: reports/Q4 summary.md")).toEqual(["reports/Q4 summary.md"]);
  });

  it("takes one per line and de-duplicates", () => {
    const message = ["Compare these:", "file: a.md", "file: b.md", "file: a.md"].join("\n");
    expect(fileReferences(message)).toEqual(["a.md", "b.md"]);
  });

  it("ignores the word appearing mid-sentence", () => {
    // Otherwise "the file: it is missing" attaches a file called "it".
    expect(fileReferences("I looked at the file: it was empty")).toEqual([]);
  });

  it("strips the quoting a person might add", () => {
    expect(fileReferences('file: "notes/plan.md"')).toEqual(["notes/plan.md"]);
    expect(fileReferences("file: `notes/plan.md`")).toEqual(["notes/plan.md"]);
  });

  it("writes what it reads", () => {
    expect(fileReferences(fileReference("docs/spec.md"))).toEqual(["docs/spec.md"]);
  });
});

/**
 * Taking a reference back out.
 *
 * The composer shows references as chips, and the chip's × is the only way
 * most people will remove one. It has to agree with the reader above it: a
 * chip that leaves its line behind is a file still in the turn with nothing on
 * screen saying so.
 */
describe("removing a file reference", () => {
  it("takes out every line for that path, and leaves the rest alone", () => {
    const message = ["Compare these:", "file: a.md", "file: b.md", "file: a.md"].join("\n");
    expect(withoutFileReference(message, "a.md")).toBe(["Compare these:", "file: b.md"].join("\n"));
  });

  it("matches the quoting and spacing the reader accepts", () => {
    expect(withoutFileReference('file: "notes/plan.md"\nkeep', "notes/plan.md")).toBe("keep");
  });

  it("leaves prose that merely mentions the word", () => {
    const message = "I looked at the file: it was empty";
    expect(withoutFileReference(message, "it was empty")).toBe(message);
  });

  it("is what the reader says it is", () => {
    const message = ["file: a.md", "file: b.md", "ask"].join("\n");
    expect(fileReferences(withoutFileReference(message, "a.md"))).toEqual(["b.md"]);
  });
});

describe("attaching a file to a turn", () => {
  let root: string;
  let project: string;
  let service: SessionsService;
  let turnRepo: TurnRepo;
  /** Every prompt the runtime was asked to advance, so the turn's own input is visible. */
  let prompts: string[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "iq-attach-"));
    project = join(root, "project");
    mkdirSync(join(project, "reports"), { recursive: true });
    writeFileSync(join(project, "reports", "q4.md"), "# Q4\nRevenue was flat.\n", "utf8");

    const paths = resolveAppPaths(root);
    await ensureAppPaths(paths);
    turnRepo = new TurnRepo(paths);
    prompts = [];

    const projectService = new ProjectService({ root: () => project });

    service = new SessionsService({
      paths,
      sessionRepo: new SessionRepo(paths),
      turnRepo,
      runtime: {
        primeSequence: () => undefined,
        deleteSession: async () => undefined,
        ensureSession: async () => ({ id: "session" }),
        // The turn never really runs: what is under test is what it would have
        // been given, which is the last thing the session layer decides.
        runTurn: async (_session: unknown, input: { prompt: string }) => {
          prompts.push(input.prompt);
        },
      },
      toolRegistry: { families: () => [] },
      skills: { resolveSessionSkillConfig: async () => ({ directories: [], disabled: [] }) },
      policy: {},
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      publish: () => undefined,
      publishIndex: () => undefined,
      defaultModel: "test-model",
      projectDir: () => project,
      readProjectFile: async (path: string) => {
        const file = await projectService.read(path);
        if (file.kind !== "text") throw new Error("binary files cannot be attached to a message");
        return { path: file.path, text: file.text };
      },
    } as unknown as SessionsDeps);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Send, and wait for the turn to settle.
   *
   * `sendMessage` returns as soon as the turn is durable, not when it finishes —
   * so a test that asserted straight after it would be racing the very thing it
   * is asserting about, and would tear its temp directory down mid-write.
   */
  const send = async (content: string): Promise<string> => {
    const sessionId = await service.create({ title: "Attachments" });
    const turnId = await service.sendMessage({ sessionId, content });
    await service.awaitTurn(turnId);
    return turnId;
  };

  it("puts the file's text in the prompt the model is given", async () => {
    await send("Summarise this.\nfile: reports/q4.md");

    const prompt = prompts.at(0) ?? "";
    expect(prompt).toContain("Summarise this.");
    expect(prompt).toContain("Revenue was flat.");
    expect(prompt).toContain("reports/q4.md");
  });

  it("records which files were attached, and not their contents", async () => {
    const turnId = await send("file: reports/q4.md");
    const events = await turnRepo.read(turnId);
    const message = events.find((event) => event.type === "user_message");

    expect(message?.type === "user_message" && message.attachments).toEqual([
      { path: "reports/q4.md", mime: "text/plain" },
    ]);
    // The turn log is append-only, so a conversation that attached a long
    // document would carry a copy of it for good in a file nobody can prune.
    expect(JSON.stringify(events)).not.toContain("Revenue was flat.");
  });

  it("refuses a path that climbs out of the project, and says so in the turn", async () => {
    writeFileSync(join(root, "secrets.env"), "TOKEN=hunter2\n", "utf8");
    await send("file: ../secrets.env");

    const prompt = prompts.at(0) ?? "";
    expect(prompt).toContain("could not be read");
    expect(prompt).not.toContain("hunter2");
    // Reported to the model rather than failing the turn: "that file could not
    // be read" is a useful thing for an assistant to be able to say.
    expect(prompt).toContain("../secrets.env");
  });

  it("adds nothing when the message references nothing", async () => {
    await send("Just a question.");
    expect(prompts.at(0)).toBe("Just a question.");
  });
});
