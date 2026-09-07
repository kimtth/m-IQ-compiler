# Product status and limits

This document separates implemented behavior, demo data, and unavailable
features. It describes the current product, not a migration plan.

It is a companion to [`07-reference-features.md`](07-reference-features.md),
which inventories what is implemented. Where that document says **Built in**,
this one says nothing. Where it says **Partial** or **Not built**, or where the
code itself admits it performs no work, this document takes over.

## What counts as decoration

Three shapes, all of them present in this codebase:

1. **A control that looks live and does nothing.** A button, a progress line, a
   status pill with no service behind it.
2. **A number that reads as a measurement and is not.** A duration from a
   pseudo-random generator, a token cost from a constant table.
3. **A contract declared and never wired.** A schema field nothing populates, a
   method with no call sites, a CSS class nothing applies.

The third is the recurring defect shape in this repository. It reads as working
code and passes every test.

The product must distinguish a diagram from an executor and demo values from
measured work. The inventory below names those boundaries.

---

## Inventory

| Surface | What it looks like it does | What it does | Section |
|---|---|---|---|
| IQ Workflow | Describes how work happens, and exports the drawing | A conceptual modeller with publish and export, not a workflow executor. | [1](#1-iq-workflow) |
| My IQ | Analyses your IQ Cells and their run history | Analyses 26 seeded fixtures plus the bundled industry primers. The cells you draw and publish never enter it. | [2](#2-my-iq) |
| Connectome IQ | Organizes an AI-driven company as specialized IQs and AI roles | A conceptual demo. The company hierarchy and five specialized IQs are fixtures; the My IQ publication state is real and the tool console answers from fixture data. Nothing is fetched. | [3](#3-connectome-iq) |
| Composer auto-approval | Approves read-only tool requests in the current context | Implemented. Resets when the session or project changes; no clock-based expiry or custom tool-set grant. | [4](#4-smaller-decorations) |
| Artifact history | Snapshot and revert on the canvas header | Not present. | [4](#4-smaller-decorations) |
| Skill restore / pin / rollback | Version control over a skill | Not present. Review, approve, archive, import and export are. | [4](#4-smaller-decorations) |
| `PermissionPolicy.skillPermits` | A skill's `allowed-tools` narrows what it may call | Unit-tested helper with no runtime callers. It compares family names, not the tool names used by many skills. | [4](#4-smaller-decorations) |

---

## 1. IQ Workflow

### 1.1 It runs nothing, and that is the design

IQ Workflow is a **conceptual business-flow modeller**. Someone draws how work
actually happens and exports Mermaid, Markdown, SVG or a re-importable bundle.
There is no workflow executor, runtime contract, or dry run. Seven node kinds
across three families use plain, labelled arrows. React Flow provides pan,
zoom, minimap, selection, keyboard delete and snapping.

### 1.2 What is real

- `validate()` in `flow/compile.ts` produces FLOW001–FLOW005 and FLOW010, all of
  them about whether a reader could follow the picture: no Start, an unreachable
  step, a decision with one way out, no End, a retired kind.
- `flow/graph.ts` gives immutable graph operations, `topoOrder` and `sourceHash`,
  with layout deliberately excluded from the hash.
- `flow/export.ts` writes Mermaid that the parser IQ Industry already uses can
  read back, which is what makes a diagram portable rather than trapped.
- **Publish** writes a versioned `IqCellCard` into `localStorage`. It is device
  storage and the privileged process neither reads it nor claims to —
  `SampleModuleStatus.owner` carries a `device` value for exactly this reason.

### 1.3 The one thing still open

Diagrams live in the renderer's `localStorage`. That is honest today, because
nothing outside the renderer needs them. It becomes a limitation the first time
something else does — a skill that reads the diagrams a project holds, or a
sync across devices. `flow/device.ts` already provides the seam (`DeviceStore`,
`installDevice`), so moving the store to `<IQ_HOME>` is an adapter rather than a
rewrite.

**Do not treat this as a stepping stone to execution.** Making the diagrams
readable by the privileged process is a storage change. Making them *run* is a
different product, and one this document argued against on the evidence above.

---

## 2. My IQ

### 2.1 What is decoration

The library in `connectome/Connectome.tsx` is created from fixtures:

```ts
const library = useMemo<DemoIqCell[]>(() => [...industryCells(), ...generateLibrary()], []);
```

`generateLibrary()` is a seeded generator of 26 fixture cells in a software
delivery scenario. `industryCells()` is the 5 shipped industry
primers. Both are called directly, bypassing the IQ Cell library store that both
of them are also reconciled into. **A cell the user drew and published in IQ
Workflow never enters this analysis.** Nothing done on one surface changes the
other.

The surface says so — `connectome/analyze.ts` puts "Run history is generated demo
data, not telemetry from this device." in the report, and the header carries a
"Beta · demo data" chip. That honesty is correct and it is also the whole problem:
the two surfaces the product presents as a pair are not connected.

`connectome/fixtures.ts` states the reason plainly: "The beta has no run history
to read."

The analysis itself is not decoration. `analyze.ts` is deterministic, every edge
carries the evidence it was derived from, and a latent edge is a hypothesis with
citations that grants nothing. Keep it.

### 2.2 Which evidence is computable now

`couplings(a, b)` derives six components. Four of them need only a diagram.

| Component | Needs | Computable from a real `FlowGraph` today |
|---|---|---|
| `artifact_lineage` | produced / consumed artifacts | **Yes** — the `data` nodes and the direction of the arrows touching them |
| `project_reach` | declared paths | **Yes** — a `data` node's `system` and `format` fields |
| `external_reach` | reach and hosts | **Yes** — the `system` field on a step |
| `shared_configuration` | owner, system, subflows | **Yes** — step configuration and `subflow` targets |
| `co_activation` | `activeHours` | No — needs run history, which this product does not produce |
| `human_coupling` | `approver` | No — needs someone to have answered an approval |

So a real My IQ would not be empty on a fresh install. It would draw
structural couplings immediately. `ConnectomeEvidence.component` already
distinguishes structural from behavioural, so the surface can say which is which.

### 2.3 The two behavioural fields have no source

`DemoIqCell` has nineteen fields. Its header comment claims every one is
"something the real product already records". Fourteen are. Five are not, and all
five describe a run — `runs`, `completionRate`, `activeHours`, `lastRunDaysAgo`
and `approver`.

**Nothing in this product will ever fill them from IQ Workflow**, because a
diagram is not executed. That is not a gap to close; it is the shape of the
feature. Either My IQ drops the behavioural components when reading real
cells and says so, or those fields stay demo-only and the surface keeps its
"Beta · demo data" chip. Do not invent them.

### 2.4 The work

1. Read the real library. Replace the two direct generator calls with the IQ Cell
   library store — which already holds both the primers and, when the sample flag
   is on, the demo set. Today this surface does not consult the sample flag at
   all.
2. Derive the four structural components from real diagrams.
3. Report the two behavioural components as unavailable for a real cell rather
   than defaulting them to zero. A zero reads as a measurement.
4. Leave the Publish gate alone. `MyIqPublisher` refuses while sample data is off,
   and `packages/myiq-mcp` refuses a snapshot without `sampleDataOnly: true`. Two
   independent gates, because a published IQ Cell is indistinguishable
   from a generated one and no per-record filter would be honest. Real provenance
   on a real cell is what unlocks this, and that is a separate decision.

### 2.5 Frozen

The map visual is accepted and signed off. Do not change `layout()` in
`connectome/analyze.ts`, `FRAME_LIFT = 0.05` or `fitRadius = extent * 2.0 + 0.8`
in `connectome/scene.ts` while doing any of the above. Cells that draw with no
edges are data — the industry primers have `runs: 0` and no artifacts by design —
not a rendering fault.

---

## 3. Connectome IQ

### 3.1 What it is

An expandable organization chart for an AI-driven company, and a **conceptual
demo** of one structure: company → specialized IQ → AI role. It is a top-level
mode of its own, beside IQ Cell rather than inside it, and it carries
`beta: true` and a chip on the surface.

### 3.2 What is real and what is not

| Part | State |
|---|---|
| My IQ publication state in the company root | **Real.** Read from `myiq:status` — the name you gave it and whether a published IQ supplies the company's shared context. |
| Publish name and sharing | **Real.** `MyIqSnapshot.name` and `.shared` are persisted, reported by status and recorded in the audit line. |
| The company, five specialized IQs and their AI roles | **Fixtures.** Defined from `apps/renderer/src/samples/sharedIq.ts`. |
| The MCP client configuration for a shared IQ | **Shaped like the real one, pointing at nothing.** It names the sample IQ, and no server exists at that name. |
| The tool console | **A pure function.** `sharedIqToolResult` mirrors `packages/myiq-mcp`'s wording. Every answer ends by saying it is sample data. |
| Anything leaving the device | **None.** No network call is made from this surface. |

### 3.3 The work, if it is ever made real

1. Decide what a shared IQ *is* on the wire. A `MyIqSnapshot` is already the
   record; what is missing is an owner identity and a place to put it.
2. Decide who may read one. `shared` is a boolean today because a demo has no
   directory to scope it against.
3. Connect a shared IQ over MCP rather than answering from a fixture. The tool
   set is already the real one, so this is a transport change, not a redesign.

Until then the surface must keep saying what it is. A hub that quietly showed
fabricated colleagues' work would be the worst kind of decoration: it would teach
the reader that people they know are using the product.

---

## 4. Smaller decorations

| Item | State | Work |
|---|---|---|
| Composer auto-approval | Built. **Auto-approve read-only tools** answers eligible pending requests through the same permission channel as a click. It resets on session or project changes. | No clock-based expiry or user-selected tool-set grant. `isAutoApprovable(risk)` defines eligibility; tenant policy remains authoritative. |
| Artifact history | Not built. The canvas header has no snapshot or revert control. | Per-artifact snapshots in the project directory. The audit log is the governance record and stays so either way. |
| Skill restore / pin / rollback | Not built. Review, approve, archive, import and export exist. | Version records on `SkillRecord`, plus a restore path that goes through the same approval as a proposal. |
| `PermissionPolicy.skillPermits` | Unit-tested helper; no runtime callers. | It compares family names, while many bundled skills name tools. It is not runtime enforcement of those lists. |
| `OfficeCli.beginGeneration` / `endGeneration` | Reserved lifecycle methods, not called by the app. | Live generation state follows `invoke` → `markGenerating` → `finishTurn`. |

---

## Current boundaries

- My IQ analysis uses the fixture library, not the user's published diagrams.
- Behavioral coupling values are demo data, not measurements from IQ Workflow.
- Saved diagrams live on the device in `localStorage`; there is no cross-device
  synchronization or privileged diagram store.
- Shared-IQ discovery and a real company directory are not connected.

---

## Rules none of this may break

- The permission chain is validate → policy → approval → audit → execute → audit,
  in the privileged process. Nothing added to a canvas is an exception to it.
- The renderer is untrusted. No execution engine belongs in it.
- IQ Workflow describes work; it does not perform it. Do not add a node kind that
   implies otherwise.
- `destructive` is not expressible in a `DelegatedGrant`. Keep it that way.
- An unattended turn never waits on an approval card.
- A control whose precondition lives on the privileged side is **disabled with a
   reason**, never offered and then refused.
- Do not touch `generateLibrary`'s random stream. The ids and properties of every
  demo cell hang off it.
- `pnpm build` checks renderer types and builds all workspace packages and
   Electron assets. Run it before `pnpm test` and `pnpm test:e2e` so tests do not
   use stale package output. `pnpm typecheck` alone excludes the renderer.

---

## Divergences

IQ Workflow no longer matches `docs/00-agents.md` Part 2, which describes a
runtime canvas with six palette families, typed ports, a compile step, a contract
and a dry run. Part 1 and Part 2 are the verbatim design prompt and must not be
rewritten; the reversal is recorded in that document's **Divergences from the
code** table instead. Update the matching rows in
[`07-reference-features.md`](07-reference-features.md) when behaviour actually
changes — not when work is planned.
