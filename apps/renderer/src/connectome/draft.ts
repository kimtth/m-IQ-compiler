import type { FlowGraph } from "@iq/shared";
import { assemble, type AssemblyStep } from "../flow/assemble.js";
import type { DemoIqCell } from "./fixtures.js";

/**
 * A diagram, reconstructed from what an IQ Cell declares.
 *
 * My IQ reads a library of IQ Cells; IQ Workflow draws business
 * flows. The demo library is generated telemetry rather than something anyone
 * drew, so there is no stored diagram to hand over when a reader asks to see
 * the flow behind a node on the map.
 *
 * Rather than refuse, this rebuilds one from the declarations the map already
 * reasons about: the artifacts the cell consumes become the things the work
 * reads, the work itself is one step owned by the cell's approver, an embedded
 * cell becomes a subflow, and what it produces becomes what the work leaves
 * behind. That is exactly the same evidence the coupling analysis uses, so the
 * diagram and the map cannot disagree.
 *
 * It is a reconstruction and IQ Workflow says so when it opens one. Nothing
 * here claims to be a diagram anyone drew.
 */

/**
 * The kind of thing a filename names.
 *
 * Only the values the Data block actually offers, so the reconstruction never
 * writes a setting the form cannot show back.
 */
const formatOf = (artifact: string): string => {
  if (/\.(xlsx|csv)$/i.test(artifact)) return "Spreadsheet";
  if (/\.(docx|pptx|pdf|md)$/i.test(artifact)) return "Document";
  return "Record";
};

/**
 * The diagram id a demo cell always reconstructs to.
 *
 * Stable rather than freshly generated, because the library reconciles against
 * it: without a stable id, "is this one already here" is unanswerable and every
 * visit would add another copy of all of them.
 */
export const draftIdFor = (cell: DemoIqCell): string => `flow_demo_${cell.id}`;

export const draftFromCell = (cell: DemoIqCell, projectId: string | null): FlowGraph => {
  const system = cell.reach[0] ?? "";

  const steps: AssemblyStep[] = [
    { kind: "start", label: "When it runs", config: { trigger: `Someone runs ${cell.name}` } },
  ];

  // What the work reads. These hang off the start rather than sitting in the
  // spine: they are things, not steps, and numbering "the launch deck" between
  // two verbs makes the flow unreadable.
  const inputs: number[] = [];
  for (const artifact of cell.consumesArtifacts) {
    steps.push({
      kind: "data",
      label: artifact,
      from: [0],
      config: { format: formatOf(artifact), system },
    });
    inputs.push(steps.length - 1);
  }

  steps.push({
    kind: "step",
    label: cell.name,
    from: [0, ...inputs],
    config: {
      ...(cell.approver === "" ? {} : { owner: cell.approver }),
      ...(system === "" ? {} : { system }),
    },
  });
  let tail = steps.length - 1;

  // An embedded IQ Cell is a flow described elsewhere, which is what a subflow
  // means. Drawing it as another step would claim this diagram describes work
  // it does not describe.
  for (const embedded of cell.embeds) {
    steps.push({ kind: "subflow", label: embedded, from: [tail], config: { flow: embedded } });
    tail = steps.length - 1;
  }

  for (const artifact of cell.producesArtifacts) {
    steps.push({
      kind: "data",
      label: artifact,
      from: [tail],
      config: { format: formatOf(artifact), system },
    });
  }

  steps.push({
    kind: "end",
    label: "Done",
    from: [tail],
    config: {
      outcome:
        cell.producesArtifacts.length === 0
          ? `${cell.name} is finished`
          : `${cell.producesArtifacts.join(", ")} is ready`,
    },
  });

  return assemble(cell.name, steps, projectId, draftIdFor(cell));
};
