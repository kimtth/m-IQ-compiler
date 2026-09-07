# System tests

End-to-end runs against the real app. The packaged main process starts, a real
window paints, and the specs click the same controls a person would. Nothing is
mocked, so a green run means the interaction is feasible in the shipped window
rather than in a jsdom approximation of it.

These are **not** unit tests. `pnpm test` stays fast and hermetic and needs no
build; this suite needs a build and a display. They live under `tests/` beside
the unit suite — one place to look for a test — and stay a separate runner:
`vitest.config.ts` collects `tests/**/*.test.ts`, this one collects
`tests/e2e/**/*.e2e.ts`, so the two never run together by accident.

## Running

```powershell
cd d:\Code\IQ-compiler\iq-compiler
pnpm build          # required — the specs launch apps/main/dist
pnpm test:e2e
```

One spec at a time. Each owns a real window with a GPU context, a throwaway
Electron profile *and* a throwaway `IQ_HOME`, so running them in parallel turns
a slow machine into a flaky one for no gain. Both directories matter: the
Electron profile holds `localStorage`, and everything the privileged side owns
— sessions, skills, memories, `config/*.json` — lives under `IQ_HOME`. A spec
asserting "a fresh profile offers exactly these MCP servers" is only true if
both are its own.

To run one file:

```powershell
pnpm test:e2e -- tests/e2e/iq-connectome.e2e.ts
```

## Two exceptions

`browser-restore.e2e.ts` breaks two of the rules above, and has to.

It **reuses one `IQ_HOME` across two launches**, because what it tests is what
survives a restart. `launchApp({ home })` takes a home the spec made itself, and
leaves it alone on close.

It is also the **only spec that needs the network**. The pane accepts `https:`
only, so a local server would need a certificate Chromium trusts; the thing
under test is a real browser returning to a real page. It loads
`https://example.com/`, and `IQ_E2E_URL` overrides that on a machine that cannot
reach it.

## What is covered, and what is not

| Spec | Drives |
|---|---|
| `sign-in-gate.e2e.ts` | The pre-app gate, signed out: the card, the tenant override, tenant validation, and Continue refusing while a connection is not green. |
| `iq-cell.e2e.ts` | IQ Cell → IQ Workflow: the renames, the seven-kind palette, opening a sample, renaming a diagram, drawing one by hand — placing nodes, dragging one apart from another, dragging a handle to connect them, labelling the arrow from the inspector — exporting Mermaid, publishing to the library, and importing the sample `.iqcell.json` bundles. |
| `iq-connectome.e2e.ts` | IQ Cell → My IQ: the rename, the automotive demo library, analysis, both views, the node details dialog, asking the map questions, pane resizing, and publishing My IQ over MCP. |
| `chat-surfaces.e2e.ts` | Chat → Data agent (offered in the rail, legible with nothing connected), the landing page, Control Center carrying no History control, Team member avatars and the sample council, and the panes each surface suppresses. |
| `cocreate-surfaces.e2e.ts` | Meeting Recordings: the record control, present and refused-with-a-reason while signed out. Plus the seeded MCP server, the Fabric skill pack in Skills, and Fabric refusing without a workspace. |
| `browser-restore.e2e.ts` | Co-create → Browser: the pane returns to its last page after the app is closed and reopened, and does not remember a page that failed to load. |

Two conventions run through these. Anything asserted about a *refused* state is
asserted signed out, because that is the state a fresh install is in and the
only one the harness can reach honestly. And anything asserting a pane is
**absent** establishes a control case first — the workbench also sheds panes
when the window is narrow, so "the chat pane is gone" proves nothing on its
own.

Three things are deliberately left to a person, and are written up in
[system-test-plan.md](system-test-plan.md):

- **Picking a node on the 3D map.** Hitting a sphere means hitting a raycast
  target whose screen position depends on the GPU, the window size and the
  reveal animation. The list and the report pane reach the same state through
  the same handlers, so the specs go through those; a human confirms the map.
- **Export.** It goes through the browser's download machinery, which in
  Electron raises a save dialog and would hang an unattended run.
- **Anything needing an identity.** See below.

## The identity boundary

The app does not open until both connections are green. The specs get past that
with `IQ_E2E=1`, which the main process turns into `?e2e=1` on the renderer URL,
and which makes the renderer start inside the shell instead of on the card. A
banner says so on screen for as long as the flag is on.

**It grants nothing.** No token is acquired and none is held, so every
privileged handler refuses exactly as it would for a signed-out user. That is
why most specs stay on IQ Cell: the editor and My IQ are entirely
renderer-local, so they are fully exercisable, while Chat, Co-create, Work IQ,
Microsoft 365 and Foundry are not — and testing them properly needs a signed-in
machine and a human, not a flag.

The two newer specs work *with* that boundary rather than around it. A surface
that cannot act without an identity must still say so legibly, and "legibly" is
assertable: the record button is present and disabled with its reason attached,
the Data agent surface names the connection it lacks and offers the way to add
it, and Fabric refuses with the place to register a workspace. Those are the
states a new user meets first.

The flag is off by default and is not read anywhere except at window creation.

## Writing a spec

Four things about the workbench catch specs out:

- **`expect.poll` only works inside a test body.** In `beforeAll`, use a
  Playwright waiter (`locator.waitFor`).
- **Scope rail clicks to `.rail`.** Once a surface is open the canvas tab strip
  carries a `Close <name>` button, so an unscoped role match resolves to two.
- **Scope pane content to `.pane.canvas`.** The project navigator is also a
  pane with its own `.pane-body` and `.pane-header`. Not every surface has a
  `.pane-body` at all — the MCP surface renders a bare `.card`.
- **Several labels are `text-transform: uppercase`.** `innerText` returns what
  was rendered, so a rail heading reads `CONVERSATIONS` and a status pill reads
  `DRAFT`. Match headings and pills case-insensitively; the casing belongs to
  the stylesheet.

And six about the IQ Workflow canvas, which is the one surface a spec draws on
rather than reads:

- **On the IQ Workflow canvas, select on the `data-flow-*` attributes, never on
  `.react-flow__node` or `.react-flow__edge`.** Those belong to the library and
  will change when it is upgraded. The hooks are `data-flow-node`,
  `data-flow-label`, `data-flow-palette`, `data-flow-tab`, `data-flow-edge-label`
  and `data-flow-mermaid`.
- **The palette's drag is HTML5 drag-and-drop.** It carries `text/iq-node` on a
  `DataTransfer`, which a synthesised pointer cannot produce, so Playwright
  cannot drive it. The palette button also places on click, and that is the path
  the spec takes. Connecting two nodes *is* a real pointer drag, so that part is
  driven as a user would.
- **Handles are transparent until hovered.** That is paint, not hit-testing, so
  aim at the box `boundingBox()` reports rather than waiting for a visibility
  the design does not intend.
- **A connection has to be released on a handle, not on the node.** React Flow
  joins whatever falls inside its connection radius, which is 20px, and the
  middle of a node is further than that from all four of its handles. Dropping
  on the body silently draws nothing.
- **A fresh node lands almost on top of the last one.** Successive placements
  are offset by a few pixels, and two overlapping nodes cannot be joined by
  pointer — nor could a person do it. Drag them apart first.
- **An arrow is labelled from the inspector.** Drawing one selects it, and the
  `Arrow label` field is right there. Double-clicking the arrow itself works
  too, but a curve inside a wide bounding box is not a target a spec should aim
  at.

## Sample files

Sample data lives in [`../../sample-data/`](../../sample-data), not in this
directory. `tests/e2e/` is code and `sample-data/` is material, and keeping them
apart means a spec has to name the file it loads rather than reaching for
whatever happens to sit beside it. It is also the set a manual tester opens, and
nobody should have to read a test harness to find it.

- `sample-data/iq-cells/*.iqcell.json` — three exported diagram bundles in the
  format **Export** writes and **Import** reads. Used by the IQ Workflow spec
  and loadable by hand.
- `sample-data/project/` — a small software delivery project tree. Bind
  it in **Projects** to give Co-create and the navigator something real to
  show. Its folders line up with the five domains the Neural Connectome demo
  library is themed around, and the sample bundles name paths inside it.

Everything in it is fabricated: no real service, vendor, customer, incident or
ticket is described, and nothing would need careful handling if it leaked. A
fixture that needs handling with care is a fixture nobody will use.

