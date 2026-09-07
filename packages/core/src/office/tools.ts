import { z } from "zod";
import { OFFICE_DESTRUCTIVE, OfficePreviewFormat } from "@iq/shared";
import type { AnyGovernedTool } from "../runtime/tools/registry.js";
import type { OfficeCli, OfficeSpawnResult } from "./officecli.js";

/**
 * The Office tools the agent actually calls.
 *
 * These are a thin, structured surface over {@link OfficeCli}: the service owns
 * every safety decision (subcommand allow-list, project containment, the
 * subprocess sandbox), so a tool's job is only to shape a well-typed request
 * and to declare an honest risk level. That risk level is what keeps the
 * destructive verbs out of any session-scoped auto-approval set.
 *
 * Risk assignment follows {@link OFFICE_DESTRUCTIVE} — `set`, `remove` and
 * `merge` mutate or overwrite content the user cannot see in the argument list
 * (a `set` rewrites an existing run; a `merge` overwrites its output; a
 * `remove` deletes an element), so they are marked "destructive" and are never
 * auto-approvable. `create` and `add` only grow a document — but `create`
 * additionally refuses to overwrite an existing file, so the one case where it
 * *would* be destructive (clobbering a file) is turned into an error rather
 * than a silent loss. Reads (`query`, `validate`, `view`) are "read".
 */
export function createOfficeTools(deps: { office: OfficeCli }): AnyGovernedTool[] {
  const office = deps.office;

  /** Turn `["k=v", ...]` into repeated `--prop k=v` flags. */
  const props = (values: readonly string[]): string[] =>
    values.flatMap((value) => ["--prop", value]);

  /** One-line, human-readable outcome the model can relay without re-reading stdout. */
  const done = (result: OfficeSpawnResult): { ok: boolean; output: string } => ({
    ok: result.code === 0,
    output: result.stdout.trim().slice(0, 4_000),
  });

  const path = z
    .string()
    .min(1)
    .max(400)
    .describe("Project-relative path to the .docx, .xlsx or .pptx file, e.g. reports/q4.docx.");

  const create: AnyGovernedTool = {
    name: "office_create_document",
    family: "office",
    description:
      "Create a new, empty Office document (.docx, .xlsx or .pptx) at a project path. The document is given a folder of its own — ask for 'Deck.pptx' and it is created at 'Deck/Deck.pptx' — so write every image and other resource it uses into that same folder. The reply says where it went; use that path for the rest of the turn. Refuses to overwrite an existing file: choose a new name instead.",
    risk: "write",
    parameters: z.object({ path }),
    summarize: (args) => `Create a new Office document at ${args.path}`,
    resources: (args) => [args.path],
    handler: async (args, context) => {
      // The create verb would silently overwrite; make that impossible here so
      // the common "new document" case stays a safe write and clobbering is not
      // offered at all. Editing an existing file goes through add/set instead.
      const result = await office.invoke("create", [], {
        targetPath: args.path,
        turnId: context.turnId,
      });
      // Where it actually landed, and the folder its resources belong in. A
      // model that is not told this writes the deck's images beside a file that
      // is no longer there.
      const placed = office.documentPath(args.path);
      const folder = placed.includes("/") ? placed.slice(0, placed.lastIndexOf("/")) : "";
      return { ...done(result), path: placed, folder };
    },
  };

  const add: AnyGovernedTool = {
    name: "office_add_content",
    family: "office",
    description:
      "Add an element (a paragraph, slide, shape, sheet, table, chart, …) to an existing Office document. Additive: it grows the document without rewriting existing content.",
    risk: "write",
    parameters: z.object({
      path,
      target: z
        .string()
        .min(1)
        .max(400)
        .describe("OfficeCLI element path to add under, e.g. '/' for the document or '/slide[1]'."),
      type: z
        .string()
        .max(64)
        .optional()
        .describe("Element type to add, e.g. slide, paragraph, shape, sheet, table."),
      properties: z
        .array(z.string().max(2_000))
        .default([])
        .describe("key=value properties, e.g. text=Hello, title=Q4 Report, x=2cm."),
    }),
    summarize: (args) => `Add ${args.type ?? "content"} to ${args.path} at ${args.target}`,
    resources: (args) => [args.path],
    handler: async (args, context) => {
      const typeArgs = args.type ? ["--type", args.type] : [];
      const result = await office.invoke("add", [args.target, ...typeArgs, ...props(args.properties)], {
        targetPath: args.path,
        turnId: context.turnId,
      });
      return done(result);
    },
  };

  /**
   * The tool that makes "build me a deck" one decision instead of seventeen.
   *
   * Without it the only way to express a whole document is one
   * `office_add_content` per slide, per title and per bullet, and each of those
   * is a separate approval card for what the user experienced as a single
   * request. Additive only — the service fixes the batch verb to `add` — so it
   * carries exactly the risk of the single-element tool and is covered by the
   * same "Allow for this conversation" rule.
   */
  const addMany: AnyGovernedTool = {
    name: "office_add_many",
    family: "office",
    description:
      "Add many elements to an Office document in one pass — the preferred way to build a whole document, deck or workbook. Use this instead of calling office_add_content repeatedly: it is a single operation, so the user approves the document once rather than once per element. Additive only; it cannot change or delete existing content.",
    risk: "write",
    parameters: z.object({
      path,
      items: z
        .array(
          z.object({
            target: z
              .string()
              .min(1)
              .max(400)
              .describe("OfficeCLI element path to add under, e.g. '/' for a slide or '/slide[1]'."),
            type: z
              .string()
              .max(64)
              .optional()
              .describe("Element type to add, e.g. slide, paragraph, shape, sheet, table."),
            properties: z
              .array(z.string().max(2_000))
              .default([])
              .describe("key=value properties, e.g. text=Hello, x=2cm."),
          }),
        )
        .min(1)
        .max(200)
        .describe(
          "Elements to add, applied in order. Later items may target elements earlier ones create, e.g. add a slide at '/' then a shape at '/slide[1]'.",
        ),
    }),
    summarize: (args) => `Add ${args.items.length} elements to ${args.path}`,
    resources: (args) => [args.path],
    handler: async (args, context) => {
      const result = await office.addMany(args.path, args.items, { turnId: context.turnId });
      return done(result);
    },
  };

  const set: AnyGovernedTool = {
    name: "office_set_content",
    family: "office",
    description:
      "Change properties of an existing element (its text, font, colour, formula, layout). This rewrites content already in the file.",
    // Destructive per OFFICE_DESTRUCTIVE: it overwrites content the approver
    // cannot see from the arguments alone, so it must never be auto-approved.
    risk: "destructive",
    parameters: z.object({
      path,
      target: z
        .string()
        .min(1)
        .max(400)
        .describe("OfficeCLI element path to change, e.g. '/body/p[1]/r[1]' or '/slide[1]/shape[2]'."),
      properties: z
        .array(z.string().max(2_000))
        .min(1)
        .describe("key=value properties to set, e.g. bold=true, color=FF0000, text=Updated."),
    }),
    summarize: (args) => `Set properties on ${args.target} in ${args.path}`,
    resources: (args) => [args.path],
    handler: async (args, context) => {
      const result = await office.invoke("set", [args.target, ...props(args.properties)], {
        targetPath: args.path,
        turnId: context.turnId,
      });
      return done(result);
    },
  };

  const remove: AnyGovernedTool = {
    name: "office_remove_element",
    family: "office",
    description:
      "Delete an element from an Office document. This permanently removes content from the file.",
    // Destructive per OFFICE_DESTRUCTIVE: a deletion is unrecoverable from the
    // file, so it is never auto-approvable.
    risk: "destructive",
    parameters: z.object({
      path,
      target: z
        .string()
        .min(1)
        .max(400)
        .describe("OfficeCLI element path to remove, e.g. '/slide[3]' or '/body/tbl[1]'."),
    }),
    summarize: (args) => `Remove ${args.target} from ${args.path}`,
    resources: (args) => [args.path],
    handler: async (args, context) => {
      const result = await office.invoke("remove", [args.target], {
        targetPath: args.path,
        turnId: context.turnId,
      });
      return done(result);
    },
  };

  const merge: AnyGovernedTool = {
    name: "office_merge_template",
    family: "office",
    description:
      "Fill a {{key}} placeholder template with JSON data, writing a new output document. Overwrites the output path if it exists.",
    // Destructive per OFFICE_DESTRUCTIVE: it writes (and may overwrite) an
    // output file, so it stays out of the auto-approvable set.
    risk: "destructive",
    parameters: z.object({
      template: path.describe("Project-relative template file with {{key}} placeholders."),
      output: z
        .string()
        .min(1)
        .max(400)
        .describe("Project-relative output path to write the filled document to."),
      data: z
        .string()
        .min(1)
        .max(200_000)
        .describe('JSON object mapping placeholder keys to values, e.g. {"client":"Acme"}.'),
    }),
    summarize: (args) => `Merge ${args.template} into ${args.output}`,
    resources: (args) => [args.template, args.output],
    handler: async (args, context) => {
      const result = await office.invoke("merge", ["--data", args.data], {
        targetPath: args.template,
        extraPaths: [args.output],
        turnId: context.turnId,
      });
      return done(result);
    },
  };

  const query: AnyGovernedTool = {
    name: "office_query_structure",
    family: "office",
    description:
      "Read the structure of an Office document — list elements matching an OfficeCLI selector. Read-only; returns JSON.",
    risk: "read",
    parameters: z.object({
      path,
      selector: z
        .string()
        .min(1)
        .max(400)
        .describe("OfficeCLI selector, e.g. 'run:contains(TODO)', '/body/p', 'row[Region=EMEA]'."),
    }),
    summarize: (args) => `Query ${args.path} for ${args.selector}`,
    resources: (args) => [args.path],
    handler: async (args) => {
      const result = await office.invoke("query", [args.selector, "--json"], {
        targetPath: args.path,
      });
      return done(result);
    },
    // Document content comes from the user's files; it is data, not instructions.
    untrustedResult: true,
  };

  const validate: AnyGovernedTool = {
    name: "office_validate_document",
    family: "office",
    description:
      "Check an Office document for structural and formatting problems before it is delivered. Read-only.",
    risk: "read",
    parameters: z.object({ path }),
    summarize: (args) => `Validate ${args.path}`,
    resources: (args) => [args.path],
    handler: async (args) => {
      const result = await office.invoke("validate", ["--json"], { targetPath: args.path });
      return done(result);
    },
    untrustedResult: true,
  };

  const preview: AnyGovernedTool = {
    name: "office_render_preview",
    family: "office",
    description:
      "Render an Office document to HTML or SVG so it can be shown in the canvas and its layout checked. Read-only.",
    risk: "read",
    parameters: z.object({
      path,
      format: OfficePreviewFormat.default("html").describe("Render format: html or svg."),
    }),
    summarize: (args) => `Render ${args.path} as ${args.format}`,
    resources: (args) => [args.path],
    handler: async (args) => {
      const rendered = await office.preview(args.path, args.format);
      return {
        ok: true,
        path: rendered.path,
        kind: rendered.kind,
        format: rendered.format,
        // The markup is generated; it is returned for the canvas, and its size
        // is bounded because a full render can be large.
        content: rendered.content.slice(0, 200_000),
        generating: rendered.generating,
      };
    },
    untrustedResult: true,
  };

  return [create, add, addMany, set, remove, merge, query, validate, preview];
}

/** Re-exported so a reviewer can see the destructive set the risks are keyed to. */
export { OFFICE_DESTRUCTIVE };
