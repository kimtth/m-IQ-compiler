# IQ Compiler — architecture

IQ Compiler is a Microsoft-ecosystem agent project. It is a desktop
application in which a person delegates work that spans their Microsoft 365
data, and every action the agent takes is either something the person approved
or something a policy explicitly allowed, with a durable record either way.

IQ Compiler is a local-first Electron application with a privileged main
process, a sandboxed renderer, and turn/session logs on disk. Its integration
surface is Microsoft-native: Entra ID for Azure identity, Work IQ MCP for
Microsoft 365 data, and the GitHub Copilot SDK as the agent runtime. There are
no direct Microsoft Graph tools for mail, calendar or files.

## Process model

```
┌────────────────────────────────────────────────────────────┐
│ Renderer (sandboxed, no Node, context-isolated)            │
│   React UI, five top-level modes over 18 sub-modes:        │
│     Chat · Co-create · IQ Cell · Connectome IQ ·           │
│     Control Center                                         │
│   plus seven surfaces opened as canvas tabs: Knowledge ·   │
│     Browser · Meetings · Skills · MCP · Projects ·         │
│     Connections & access                                   │
└───────────────────────────┬────────────────────────────────┘
                            │ contextBridge, zod-validated
┌───────────────────────────▼────────────────────────────────┐
│ Preload (CommonJS, sandbox-compatible)                     │
│   validateIpcRequest(channel, args) before forwarding      │
└───────────────────────────┬────────────────────────────────┘
                            │ ipcRenderer.invoke / on
┌───────────────────────────▼────────────────────────────────┐
│ Main process (privileged) — apps/main                      │
│   apps/main/src/ipc/ — handlers split by area, registered  │
│     through one exhaustive map; every argument re-validated│
│   Arguments from IpcRequestArgs, returns from IpcResult    │
│   One emitter over EMITTER_CHANNELS for every push         │
│   BrowserPane (Playwright → out-of-process Edge/Chrome,    │
│                CDP screencast in, input events out)        │
└───────────────────────────┬────────────────────────────────┘
                            │ direct calls
┌───────────────────────────▼────────────────────────────────┐
│ @iq/core                                                   │
│   SessionsService ── CopilotRuntime ── ToolRegistry        │
│   Scheduler        Coordinator       PermissionPolicy      │
│   EntraAuth  WorkIqConsentGate  SkillStore                 │
│   KnowledgeGraphService   BrowserUrlPolicy                 │
│   MemoryStore ── SkillCurator                              │
│   AuditLog (append-only)                                   │
└───────────────────────────┬────────────────────────────────┘
                            │ stdio JSON-RPC
┌───────────────────────────▼────────────────────────────────┐
│ GitHub Copilot runtime (native `copilot` executable)       │
└────────────────────────────────────────────────────────────┘
```

The renderer is untrusted, which means `sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false`, a strict CSP, and both `setWindowOpenHandler` and
`will-navigate` denying navigation out of the bundle.

## Components and why each exists

### `@iq/shared` — the contract layer

Zod schemas for every value that crosses a boundary: turn events, session
summaries, permission requests, skills, memories, scheduled jobs, orchestration
plans, audit records, Entra status, and the IPC channel map. It is the single
definition of the data model; the main process, the preload bridge and the
renderer all validate against the same schemas.

**The IPC contract has two halves, and they are typed differently on purpose.**
`IPC_REQUEST_SCHEMAS` is the runtime guard on the untrusted direction —
`validateIpcRequest` parses every renderer argument before privileged code sees
it. `IpcResults` is the *response* contract. It provides compile-time types, not
runtime response validation. Main handlers and the renderer's `call` use it to
check the response shapes declared there.

Three types come out of that, and the distinction between the first two
matters:

- `IpcRequestArgs<C>` — `z.infer`, what a **handler** receives, after defaults.
- `IpcRequestInput<C>` — `z.input`, what a **caller** sends, before defaults.
  The renderer has never sent `subMode` or `projectId` on a message and never
  needed to; typing the caller on the output shape would demand the very fields
  the boundary exists to supply.
- `IpcResult<C>` — the response, falling back to `unknown` for a channel with
  no declared shape. `unknown` rather than `void`: such a channel does answer
  something, we have simply not written down what.

Some channels answer shapes that live in `@iq/core` or in the renderer
(`fabric:contextStatus`, `knowledge:ingest`, `meetings:notice`,
`orchestration:plans`, `recording:notice`, `skills:listProposals`,
`projects:list`). Their callers use `callAs<T>` to assert the response shape.
The diagram assistant also asserts `sessions:sendMessage` and
`sessions:getTurn`, whose results are not declared in `IpcResults`.
Both call paths use the same response-envelope handling; `call` additionally
checks request inputs and derives its result type from the shared contract.

`AppSurface` carries the same treatment. A surface is described **once**, in
`SURFACES`: its label, its detail, the mode whose rail lists it, whether the
rail offers it at all, and the panes it does without. `modeForSurface`,
`panesHiddenBy`, `railSurfacesFor` and the rule behind `canHoldConversation`
are all reads of that record. Only the icon stays in the renderer, because a
React component cannot cross IPC and a place does.

The shared package emits ES modules only. The main process is also an ES module
package; the preload bundles the shared code instead of loading it at runtime.

The preload is bundled into one self-contained CommonJS file by Vite. This is
not a packaging preference — a sandboxed preload runs in a restricted module
system that resolves only Electron and a few built-ins, so a bare
`require("@iq/shared")` fails there. The failure is near-silent: the bridge is
never exposed and the window renders empty. Bundling keeps `sandbox: true`
while still validating IPC against the shared schemas.

### `@iq/core` — the governed runtime

**`CopilotRuntime`** bridges the Copilot SDK. The SDK owns planning, model
calls and tool execution; IQ Compiler does not reimplement any of that. What
the bridge adds is durability and governance: every SDK event that matters is
mirrored into an append-only turn log, so a turn's state can be recovered by
folding its events after a crash or a missed live update. The bridge reduces, persists, and then publishes events so recovery and live updates use the same state model.

**`ToolRegistry`** is the governance choke point. Every custom tool call goes
through the same chain, in this order:

```
validate args (zod) → PermissionPolicy.evaluate → [ApprovalBroker if "ask"]
→ audit the decision → execute → audit the outcome
```

The decision is written to the durable audit log **before** the side effect
runs. A crash between the two leaves a record that the action was authorised
and may have happened, which is the recoverable failure; the reverse ordering
would allow an unrecorded side effect. Custom tools are registered with
`skipPermission: true` because our own chain, running in the privileged
process, is the authority — not the runtime's.

The SDK's own built-in permissions (shell, file writes, URLs, MCP) arrive
through `onPermissionRequest` and are mapped onto the same `ApprovalBroker`. An
unrecognised permission kind is classified `destructive`, so the system fails
closed on anything it does not understand.

**`EntraAuth`** is a public client: no client secret, no application
permissions. The agent can therefore never exceed what the signed-in user is
themselves permitted to do. Sign-in requests only the base scopes; every
capability scope is requested at first use and recorded.

**`SessionsService`** owns the turn lifecycle and implements `ApprovalBroker`.
It writes the turn log before the session's reference to it, so a crash can
leave an orphaned turn (harmless) but never a dangling reference.

**`Scheduler`** runs unattended jobs. Occurrences are derived from the trigger
and the last run rather than stored, so a stored "next run" can never drift out
of sync with the schedule. Each run has an idempotency key of
`jobId:scheduledFor`, a single-flight guard per job, a timeout, and exponential
backoff with full jitter.

**`Coordinator`** executes a task DAG for sub-agent delegation: it promotes
tasks whose dependencies have succeeded, honours human decision gates,
dispatches up to `maxParallel` concurrently, retries within `maxAttempts`, and
settles the plan. Cycles are rejected at creation time — a cycle would leave
its tasks permanently blocked, which hangs rather than fails.

**`ResearchService`** runs a topic as a reviewable plan: decompose, let the user
edit the questions, gather each one as a Coordinator task, then let a manager
turn read the round back and decide whether to spend another. Two budgets bound
it, and both live on the persisted run rather than in memory — `maxRounds` and
`maxParallel`. That placement is the point: the approve channel carries only a
run id, so a cap held in a process map is a cap that is only ever its default,
and a later round or a restart would silently change how hard the run executes.

The Agent Framework graph runs **alongside** it. `observe()` drives the
`native/iq-research` sidecar for the workflow's own event stream, which is what
the reasoning graph draws; the Coordinator keeps ownership of findings,
citation discipline and per-question retry, so a machine with no prepared Python
environment loses the picture and nothing else. `cancel()` stops both — the
delegated plan and the sidecar's child process — because a run the user has
abandoned must stop spending its budget on either path.

**`SkillStore`** implements Agent Skills. Bundled skills ship with the product;
user skills live in the app directory; agent-authored skills land in a
`.proposals` staging area and are unloadable until a human approves them.

**`SpeechService`** is the only path by which audio leaves the device, and it
goes to one place: the tenant's own Azure AI Speech resource, always
authenticated with an Entra token — resource keys have no representation in the
code, which is what lets it run in tenants where key authentication is
disabled. **`SpeechRegistry`** is its configuration sibling of `ModelRegistry`:
the user registers one **custom domain endpoint**
(`https://‹name›.cognitiveservices.azure.com`) in *Connections & access*, it is
persisted as atomic JSON holding nothing secret, and the service reads it
through a getter so a registration takes effect immediately. The endpoint is
the whole registration — there is no region and no ARM resource id, because a
custom-domain Speech resource uses a different routing model: REST calls replace
the regional host with the custom host and preserve (or, for text-to-speech,
transform) the service path. The app supports that one resource-base form. This
is not a claim that regional Speech APIs globally reject Entra tokens; they have
their own endpoint and authorization flows. The app stores no resource key, so
its bearer-token path requires the Speech resource's Networking mode to be
**All networks**. Selected or private-network special STT/TTS endpoints require
a resource key and are intentionally unsupported. It is inert unless registered,
so voice and meeting capture are opt-in, not on by default.

**`MeetingsService`** owns capture, transcription and notes. Consent is
structural rather than procedural: `start()` has no path that produces a
recording without a stored `RecordingConsent` carrying the current notice
version and the Entra identity that acknowledged it, and every refusal is
audited. Audio is deleted as soon as a transcript exists unless the consent
entry asked for retention — `retainAudio` defaults to `false` in the service,
so the deleting path is the one taken when nobody says otherwise. The
transcript is what the product needs, and the audio is the more sensitive
artefact.

It records **audio only**. A video the user already has is turned into a
transcript through *Transcribe a file…*, so `FfmpegService` covers exactly that
path: probe a media file, and reduce it to audio for Azure or whisper.cpp.

The recording control is **always on screen** — a sticky bar carrying the state
(`Ready` / `Starting` / `Recording` / `Saving`), a timer, and one button that
both starts and stops. When recording is impossible the button is disabled with
the reason attached, never hidden, so "not available" is distinguishable from
"not built". `tests/e2e/cocreate-surfaces.e2e.ts` asserts this signed out, which is
the state a fresh install is in.

**`RecordingService`** turns a task done by hand into a skill. It owns the four
steps — record, analyse, approve, build — and each is a separate call, because
each has a different consequence and only one of them leaves the machine.

Capture is local and needs only the current notice version: `RecorderController`
fans input, window, browser-URL and clipboard events from the collectors into
one append-only `events.jsonl`, optionally alongside a low-rate screen capture
and a narration track transcribed by the same `WhisperService` the Meetings
surface uses. Analysis is the egress — it sends window titles, URLs and
clipboard previews to a model — so it is the step that requires a signed-in
account, an explicit `contentReviewed` acknowledgement, and an identity stamped
by the privileged side rather than sent by the renderer. The two gates are
structural: there is no path to `analyse()` that produces a result without
both.

`correlate()` is a pure function over the timeline, so what a recording *means*
is unit-testable without a screen: it groups raw events into steps, attaches the
frame nearest each step and the narration spoken over it, and produces the
deterministic `SessionBundle` the analyst reads. The user then edits the plan —
rename steps, drop them, mark values as parameters — and only an approved plan
is built. `RecordingBuilder` emits a skill through `SkillStore.propose()` or an
automation through the `Scheduler`, which means a recording produces exactly the
artefacts the rest of the app already governs; it does not gain a private
execution path of its own.

Screen capture runs in a hidden `BrowserWindow` on its own session partition, so
granting it video cannot widen the main window's permissions — the main window
denies video outright and keeps doing so while a recording is running.

**`MemoryStore` and `SkillCurator`** keep memory and skill derivation under human control. A memory recorded by the agent is inert until a person approves it;
the curator then groups approved memories by subject and compiles a group that
has passed the evidence threshold into a skill *proposal*, which needs its own
approval. Derivation is single-flighted and keyed by a signature over the
contributing memories, so it is idempotent, safe to re-run on every approval,
and safe to retry after a crash — it runs once more on each start to catch up.

**`AuditLog`** is append-only JSONL. Every identity event, permission decision,
tool outcome, scheduled run, plan transition and skill lifecycle change lands
here with an actor, an outcome and a correlation id.

**`AppEmitter`** is everything main tells the renderer, and which channel each
fact goes out on is `EMITTER_CHANNELS` — one map, checked with `satisfies`
against both `keyof AppEmitter` and `IpcEventChannel`. A method added without a
channel fails to compile, and so does a channel name that does not exist. It
used to be four parallel lists across three files with nothing comparing them,
over a `send` that took a bare `string`, so a mistyped channel compiled and
pushed to nothing. `emitterOver(send)` builds the emitter from that map; the
host supplies only *how* to send. One entry maps to `null` — `audit`, meaning
declared and deliberately not pushed, because an audit record is durable and
read back through `audit:query` and nothing subscribes to it live.

**Fabric is two registrations, not one.** `FabricRegistry` holds the workspace
artifacts are built in; `FabricDataAgentRegistry` holds the Data Agent that
answers questions, reachable either by its item id in a project or by a
published URL. The two are separately obtainable — a published agent can be
handed to someone with no rights on the project around it — so neither
requires the other. Both are reached with the Azure identity and neither takes
a key. `FabricService` grounds every co-creation run on the
`microsoft/skills-for-fabric` bundle resolved from the machine, and refuses to
run without it rather than inventing item definitions against a live project.

**`McpRegistry`** is a consent record rather than a connection pool: adding a
server stores configuration, inspection lists what it advertises, approval is
per tool by name, and only then can it be enabled. Servers named in
`MCP_SEEDED_SERVER_IDS` are registered on first load in exactly that inert
state, and a removal is recorded so it stays removed.

Spawning those servers goes through `util/executable.ts`. A configured command
is never run through a shell, so on Windows it is resolved against `PATH` and
`PATHEXT` first, and an npm batch shim is rewritten to `node <the script behind
it>` — `CreateProcess` does not consult `PATHEXT`, and Node will not spawn a
`.cmd` without a shell.

**`KnowledgeGraphService`** indexes the project and the installed skills into
a graph of documents, skills, tags and unresolved references. Parsing is a pure
function (`indexer.ts`) so the link grammar is unit-testable without a disk;
the service adds only bounded traversal, atomic persistence and audit. A
reference with no target becomes a `missing` node rather than being discarded,
because a broken link is information. Results are returned as untrusted
content: an indexed document is data, never instruction.

**`BrowserUrlPolicy`** is the single navigation rule for the browser pane —
`https:` only, no credentials in the URL, minus whatever hosts the tenant
deny-lists. There is deliberately no allow-list: a page a person can reach in
an ordinary browser is reachable here, and the tenant can still block known-bad
hosts or switch the pane off entirely.

**`BrowserPane`** (main process) is the one browser both the user and the agent
share. It launches an installed Edge or Chrome through Playwright with a
persistent profile, streams the viewport into the renderer as CDP screencast
frames, and forwards the user's input back — so the renderer never holds remote
DOM, and the agent's automation and the user's session sit in the same cookie
jar. Its `agentHost()` exposes the pane to `@iq/core`'s `BrowserPaneHost` seam:
navigate, read, history, and the act verbs (`elements`, `click`, `fill`,
`select`, `press`, `scroll`, `waitFor`). Elements are addressed by handles the
pane mints rather than by coordinates, and `BrowserUrlPolicy` is enforced per
request through a Playwright route handler.

### IQ Cell → IQ Workflow

IQ Workflow is a **conceptual business-flow modeller**. Someone draws how work
actually happens — who does what, where it branches, what comes out — and the
diagram leaves as Mermaid, Markdown, SVG or a re-importable bundle. **Nothing on
the canvas executes.** There is no compile step, no dry run and no contract; the
product's job is to make the picture right and let it travel.

The notation is a flowchart aligned **1:1 with Mermaid shapes**, so a diagram
drawn here can be pasted into a wiki, a pull request or an IQ Industry primer
and still be a diagram. BPMN was rejected: it is a specification for executable
process models, and modelling a process nobody intends to execute in a notation
built for execution invites the reader to expect a runtime.

Seven kinds, and no more:

| Kind | Shape | Mermaid | Means |
|---|---|---|---|
| `start` | stadium | `([ ])` | where the flow begins |
| `end` | stadium | `([ ])` | an outcome |
| `step` | box | `[ ]` | someone or something does work |
| `decision` | diamond | `{ }` | a branch; the edges carry the answers |
| `subflow` | subroutine | `[[ ]]` | a flow described elsewhere |
| `data` | round | `( )` | a document, record or dataset |
| `note` | — | not exported | an annotation, attached by a dashed link |

Owner and system are **config fields on a step**, not node kinds and not lanes.
A swimlane forces every step to belong to exactly one owner, which is false of
most real work and makes the diagram about the org chart rather than about the
work.

The modules in `apps/renderer/src/flow/`:

| Module | Responsibility |
|---|---|
| `catalog.ts` | The seven kinds: shape, family, config fields, and the retired-kind fallback |
| `graph.ts` | Graph mutation, the three connection refusals, `topoOrder` and `sourceHash` |
| `compile.ts` | `validate`, `blocking` and `describe` — the checks and the prose |
| `assemble.ts` | Steps plus links in, laid-out `FlowGraph` out. Shared by the samples, the reconstructions and the Mermaid importer |
| `export.ts` | `toMermaid`, `toMarkdown`, `toSvg` |
| `fromMermaid.ts` | Mermaid text onto the canvas, reusing `industry/mermaid.ts` |
| `storage.ts` | Per-project persistence, bundle import/export, publishing, and the ten worked samples |
| `nodes.tsx` | The five shapes as React Flow nodes, each with four handles |
| `edges.tsx` | The arrow and the words on it |
| `Flow.tsx` | The surface: palette, canvas, inspector, drawer |

Seven properties matter more than the feature list:

**The canvas is [React Flow](https://reactflow.dev) (`@xyflow/react`, MIT).**
Panning, zooming, minimap, marquee select, keyboard delete, snapping and
handle-to-handle connection are all things a hand-rolled canvas has to reinvent
badly. React Flow owns the interaction; the app owns the vocabulary. Select on
the `data-flow-*` attributes rather than on `.react-flow__*`, which belongs to
the library.

**Layout is not source.** `sourceHash` covers nodes, edges and configuration and
deliberately excludes coordinates, so moving a card never changes what the
diagram says.

**Drawing and publishing are separate acts.** A diagram on the canvas is a
**draft**; **Publish** records a versioned **IQ Cell** so the diagram stays
findable in the library. Nothing reaches the library until Publish is pressed.

**Cycles are allowed.** Real processes loop — a rejected pull request goes back
to the author and round again. The only connections refused are an unknown node, a
node joined to itself, and a pair already joined. Every node has four handles
and the canvas runs in loose connection mode, so a loop can go back up the left
of the page; pinning a node to one entry and one exit would force the author to
lay the diagram out to suit the tool.

**The checks read the drawing, not a build.** `validate` reports six codes, and
the header pill says **Complete**, **Draft** or **Invalid** — three words about
whether a reader could follow the picture:

| Code | Severity | Says |
|---|---|---|
| `FLOW001` | info | The canvas is empty. Drop a Start on it to begin. |
| `FLOW002` | error | A flow needs a Start. |
| `FLOW003` | warning | Nothing leads to this step. |
| `FLOW004` | warning | A decision with fewer than two ways out is not a branch. |
| `FLOW005` | warning | The flow has no End, so it does not say how it finishes. |
| `FLOW010` | warning | This kind is retired. |

`FLOW003` is raised only for the process family. A Data or Note card hanging off
the side of a diagram is normal — an annotation is *about* the flow rather than
*in* it — so calling it unreachable would be noise.

**A retired kind still opens.** Thirty-four kinds were removed when the runtime
palette was retired, but drafts live in `localStorage` and outlive the release
that wrote them. `specOf` resolves with a fallback rather than indexing: an
unknown kind yields an inert "Retired step" spec with no config, drawn inside a
dotted warning wrapper, and `validate` says so once as `FLOW010` and then skips
every other check for that node. One clear sentence beats a dozen consequential
complaints about a card the author cannot configure.

**Plain English is a way in.** **Describe your process** sends a sentence to the
agent with the `flow-modeling` skill, which answers with a Mermaid flowchart;
`fromMermaid.ts` parses it and lays it out as an editable diagram. It reuses the
parser IQ Industry already has, because a second Mermaid parser in the same app
is a second set of shapes to keep in step with the first. The answer never
overwrites what is on the canvas — it lands as a new draft. If the parser cannot
read the reply it returns **null** and the raw text is shown instead: half a
diagram silently asserts a process nobody described.

### IQ Cell → My IQ

My IQ is the parent layer: not what one IQ Cell does, but what the
whole body of work looks like. It is a **reading** surface — nothing on it
executes and no edge is drawn by hand. The run control is **Analyse**, because
the surface is already called My IQ and a button repeating the name of the page
it sits on says nothing about what pressing it does.

It is *rendered, not generated*. `analyze.ts` compares every selected pair on
six declared signals, weights them, keeps what clears `LATENT_FLOOR`, and seeds
clustering and layout from a hash of the selection — so the same selection
always produces the same graph, the same picture and the same citable finding.
No model is involved.

**Persona** picks the stakeholder the findings are ordered for: Everything,
CEO, Manager, Product owner, Engineering lead, Security reviewer, Compliance
officer, Budget owner or Operator. Each names the finding kinds it leads with,
and `orderFindingsFor` puts those first. No two personas may declare the same
order — a lens that matches another is a label and nothing else.

Two properties hold it honest. It **orders, never filters** — promoting cost
concentration must not bury a permission finding the reader did not think to
ask for — and each persona carries the blind spot its ordering creates, which
is printed in the report's limits. It is also **outside the graph hash**, so
changing reader re-reads the analysis already in hand: no second run, and not
one node moves.

**Ask about the map** shares the right column with the report. It answers from
the graph the analysis produced and never from a model, which is what keeps a
question as reproducible as the picture: the same question against the same
hash always gives the same figures. The cost is a finite vocabulary, so outside
it the reply says so rather than inventing something — an invented answer about
someone's own automations is worse than no answer.

Three properties make it readable rather than a console dump. Answers are
**rows**, each carrying the entity, the reason, the figure and a bar for its
share, and clicking one selects it on the map. Every answer **offers what to
ask next**, so the vocabulary is drawn as the exchange goes and a demo needs no
typing. And it **shows its working**: name two IQ Cells and the reply is the
six signals with each score, its weight and the product — the arithmetic behind
the strength figure, which is otherwise a number nobody can check.

The persona sets the opening questions and what leads, and touches no figure. A
cost that changed with who was asking would not be a cost.

Two views read the same index:

| View | What it is for |
|---|---|
| **Map** | The tractography render — the shape of the whole body of work |
| **Table** | The exact numbers, sortable and exportable |

The map **stays mounted and is hidden** when the table is showing. It owns a
WebGL context bound to one canvas element, and unmounting that element on a
view switch destroyed it under a live scene, which is why the map used to
return blank and unresponsive after a trip through the table.

**The nodes carry names.** A dot the chat can cite is of no use if the reader
cannot find it, so each node is captioned with the shortest form of its name
that still identifies it — `labels.ts` drops the opening words every IQ Cell
name shares, cuts at a word boundary and never lets two cells share a caption.
The captions are HTML over the canvas, positioned each frame by projecting the
node through the camera, because canvas text has no font stack, no theme and
no ellipsis. Sixteen names show at rest, the busiest first; selecting a node
names it and everything it is paired with, and selecting a tract names its two
ends. A name is dropped rather than moved when it would overlap one already
placed, since two overlapping captions identify neither node.

**Density is a measured property, not a taste.** `tests/e2e/connectome-framing
.e2e.ts` screenshots the canvas and reads two numbers off it, because every
unmeasured judgement about this surface has been wrong at least once.

- *Framing.* `lookAt` centres the centroid of the node cloud, which is not
  where the ink is: at a 19° tilt the near half of the envelope projects larger
  than the far half, so the visible mass sits below the geometric centre and
  the picture read as bottom-heavy. `FRAME_LIFT` displaces the target down the
  screen — down-the-screen being derived from the opening angles rather than
  written as an axis, since at this tilt it is mostly −z and no axis names it.
  Measured: centroid 0.57 of the canvas before, 0.414 after, which is ≈0.475 of
  the whole pane once the tab strip and transport bar above the canvas count.
- *Brightness.* The material is additive, so every overlapping fibre adds
  light. Three settings drive it together and all three had been pushed the
  wrong way at once: `MAX_FIBRES` 12,000 → 7,000, per-edge fibres `18 + s*72`
  → `8 + s*52`, and `LATENT_FLOOR` 0.10 → 0.22. The floor matters most: a weak
  coupling drawn with 18 fibres was as bright as a strong one drawn with 24, so
  the weak half of the graph was contributing most of the glare while carrying
  the least information. Measured mean luminance is now 35 of 255.

The floor has now been wrong in both directions. At 0.16 forty IQ Cells drew as
a few tracts over an empty field; at 0.10 everything connected to everything,
which carries the same amount of information and looks like a haze. It is a
claim about what counts as a finding, and under-claiming with the number stated
in the report is the safer error. The table view is where an exhaustive reading
belongs.

**The report column is closed when the surface opens.** The map is the elastic
column, so 340px of prose beside it is 340px the picture does not get — and the
report is empty until an analysis has run, so it was spending that width on an
empty state. `useSplit` takes a `Partial` record of columns now: leaving the
entry out is what removes the column, which is a different thing from a column
of zero width that still takes a divider and still has to be reasoned about.

**The analysis is published over MCP, not into the library.** `Publish` first
asks for a name and whether the IQ is shared. The name defaults to *My IQ* and
sharing defaults to on; an empty name is refused, because an IQ nobody can name
is an IQ nobody can find in the hub. Both travel with the snapshot
(`MyIqSnapshot.name`, `.shared`), are reported back by `myiq:status`, and are
recorded in the audit line. Sharing governs the Connectome IQ listing only — an
unshared IQ still serves over MCP, because the server is how *you* read your own
work from another app.

The surface then hands the cells and the reading over them to the MCP server,
and the notice says what went out: `Sales IQ is published: 40 IQ Cells and the
analysis of 40. It is listed in Connectome IQ as shared.` It files
nothing. An IQ Cell is a business flow somebody drew; a coupling analysis is a
reading of the library, so putting it back in the library would have made the
list answer two different questions at once. About two seconds later a separate
dialog offers the client configuration to copy, which is the step a person
actually has to take next.

**Both visual surfaces fit their pane and explain themselves.** The camera
frames the extent of what was actually laid out rather than a fixed distance,
and both surfaces re-fit from a `ResizeObserver` on the surface itself — the
panes resize far more often than the window does, so a window listener misses
every case that matters.

A **time lapse** (`timelapse.ts`) plays by default on both visual views. It
replays the graph in the order it came into being — each IQ Cell appearing on
the day it was first published, each coupling on the day it first carried a run
— with a transport bar carrying play/pause, reset, a scrubber, a reading of how
much of the graph has arrived, and how far back in time the view is standing.
It stands down the instant the reader pans, zooms or picks anything, and
`prefers-reduced-motion` holds it at `now` rather than replaying.

This replaced a guided tour that walked the busiest nodes and strongest links.
The tour was a claim about which parts of the reader's own estate mattered,
asserted by the app; growth is a fact about how the estate got here, and lets
the reader draw the conclusion. Both are derived from the analysis, so both
were deterministic — determinism was never the thing that was wrong.

### Connectome IQ

**A conceptual demo, and it says so.** Connectome IQ is an organization view of
an AI-driven company: the company is the root, each published IQ is a business
function, and each IQ Cell is an AI role under that function. It carries
`beta: true` and a chip on the surface because every specialized IQ in the chart
is fixture data. No network call is made and nothing leaves the device.

**It is a top-level mode, not a sub-mode of IQ Cell.** IQ Cell is where work is
compiled into cells; this is where the compiled result meets other people's.
Under IQ Cell it read as one more authoring step, which is the one thing it is
not. The mode holds a single sub-mode, `hub`, because every place in this app is
a sub-mode — a mode without one would be a place nothing could record, restore
or audit.

**The hierarchy is company → specialized IQ → AI role.** The root reports how
many functions and roles the organization holds. Each specialized IQ names its
team and human sponsor, shows its run count, and expands to the IQ Cells that do
the repeatable work. Branches can be expanded one at a time or together. Search
reaches the function, sponsor, team, topics and role names without changing the
organizational order.

**The company is a demo; your publication state is real.** The root reads
`myiq:status` and says whether the user's published My IQ supplies shared
context. The five specialized IQs come from
`apps/renderer/src/samples/sharedIq.ts`, which is the only definition of them:
one owner, one team, a summary, IQ Cells with real-looking run figures, findings
and stated limits. They are device-owned sample data, so they sit under the
renderer `samples/` hub with the rest of it.

**The MCP story is shown, not simulated.** Selecting a specialized IQ or one of
its roles opens a detail column with findings, limits, client configuration and
a console that runs the five `myiq_*` tools. Several functions can be added to
one company context; the client configuration and console then address all of
them. `sharedIqToolResult` is a pure function that mirrors the real server's
wording from `packages/myiq-mcp`, and every answer ends by saying it is sample
data.

The organization is the main work area. The functions sit on one grid row and
span a subgrid, so every function card is the same height and the role lists all
start on the same line whatever the text length. Tracks share the pane and cap at
300px, so all five functions stay on screen at a normal window and a filtered
result of one or two does not stretch across the pane. The chart scrolls when the
pane gets too small for the minimum track width or when all roles are open. The
detail column scrolls independently. Under a narrow window the detail moves below
the chart instead of reducing the hierarchy to unreadable cards. There is no
split handle: the hierarchy needs a predictable branch width, not an arbitrary
user-set width.

### Columns inside a canvas surface

`panes.ts` owns the workbench's four top-level panes. Surfaces that themselves
carry columns — IQ Workflow's palette · canvas · inspector, My IQ's
list · map · report — own theirs through `split.tsx`, which repeats the same
rules one level down:

- exactly one column is elastic (the canvas, the map); every other column
  carries an explicit pixel width, so a divider drag changes one width and only
  the elastic column absorbs the difference — the column on the far side keeps
  its width exactly;
- every column declares a minimum, and so does the elastic one; a drag stops at
  whichever floor it reaches first;
- widths persist per surface and per project, and a restored layout that no
  longer fits the current window is discarded in favour of the defaults rather
  than producing sub-minimum columns.

The hook owns `grid-template-columns` outright and renders it inline; the values
in `styles/iq-cell.css` and `styles/connectome.css` are only the pre-measurement
fallbacks. A name a user wrote is not a length the stylesheet can know, so the
control is a handle, not a wider constant.

Related: the global `input, textarea, select` rule set `width: 100%`, which also
reached `input[type="checkbox"]`. Inside a flex row that made the checkbox a
greedy item that ate the row and squeezed the label beside it down to an
ellipsis. Checkbox and radio are now excluded from the text-field rule and
sized as the glyphs they are.

## Cross-cutting decisions

**A fresh session per unattended unit of work.**A scheduled run and a
sub-agent task each get a new session. Neither inherits interactive approvals,
so an "allow always" a user granted while watching cannot silently authorise an
unattended action later.

**Crash-interrupted work is failed, never auto-resumed.** On boot, interrupted
turns and job runs are marked failed. Automatically replaying an unattended
turn risks repeating an external effect that already happened; a person can
retry explicitly once they know what occurred.

**Everything retrieved is untrusted.** Microsoft 365 content, Work IQ results
and sub-agent output are flagged `untrusted` in the turn log, and the system
prompt states that retrieved content is data and never instructions. This is
the prompt-injection boundary.

**Degrade, do not fail closed at boot.** A missing Entra registration or an
unavailable agent runtime is reported in the UI; the window still opens, the
audit log is still readable. Refusing to start would remove the user's ability
to diagnose the problem.

**A conversation remembers where it happened, and the core is what remembers.**
Every session carries a `place` — a sub-mode and an optional canvas surface —
so reopening it from the conversation list restores the tab it was held in
rather than dropping the reader wherever they happened to be standing. The
renderer records the place when the reader navigates while a conversation is
open, but it cannot be the only writer: a conversation started from the launcher
and answered entirely by tool calls never touches a tab, and would be filed
under the default forever. `SessionsService` therefore also places a session
from the work it does, in `decide()`, on the first governed call.

Three rules make that work, and each of them was a defect first.

**The inference keys off the tool name, never the family on the approval
request.** The agent SDK reports `family: "copilot.custom-tool"` for every
governed tool it forwards, so a request to create a deck and a request to query
a warehouse arrive indistinguishable; only `ToolRegistry.familyOf(name)` knows
which is which. But the family is too coarse *even when it is correct*:
`fabric_ask_data_agent` and `fabric_create_item` share the family `fabric` and
belong in opposite places, because one built an item in a project and the
other asked a question whose answer is in the thread. `placeForTool(name,
family)` in `packages/shared/src/mode.ts` is a per-tool table with a family
fallback, and an entry of `null` means *asked, and deliberately nowhere*.

**A place must be one the shell can show, and that is checked before it is
written.** `canHoldConversation` refuses a sub-mode whose surface keeps no
transcript to come back to — Chat → Team and Chat → Data agent both replace the
thread with their own state — and refuses IQ Cell and Control Center outright,
since neither has a chat pane. It also refuses a *pair* naming two different
modes. `{conversation, browser}` shipped as the browser's placement and is
exactly that: Chat is one pane, so entering it moved the mode to Co-create and
landed on whichever Co-create sub-mode happened to be selected — a third place,
belonging to nobody, which the shell then recorded over the correct one. The
log is append-only, so the boundary has to be before the write.

**Work outranks navigation.** `place_changed` carries a `source`, and
`SessionRepo.summary` folds the two separately and resolves at the end. The
shell cannot tell "I want this conversation filed here" from "I left this
conversation selected while I looked at something else" — both are the same
click — whereas what a conversation ran is not ambiguous. Under the old
last-write-wins fold, opening a deck conversation and glancing at the Fabric tab
re-filed it under Fabric permanently.

A session records `placeKnown` separately from `place`. Without it there is no
way to distinguish "this belongs in the default place" from "nobody has looked
yet", and the first navigation in an unrelated tab would overwrite a place the
work had correctly inferred. Sessions written before places existed are
backfilled once at boot by replaying their turns through the same tool-name
lookup, and are marked known even when the answer is the default — otherwise
they would be re-examined on every start.

The complete placement table is pinned twice: `tests/session-clear.test.ts`
states every pattern with its reason, and `tests/tool-schemas.test.ts` asserts
against the *real* tool set that the placing tools are exactly the expected
eleven and that no other family has been added without a decision.

## Storage layout

```
<userData>/
  config/         tenant policy, skill state, app.json (the sample-data flag),
                  media.json, projects.json (the registered projects and which
                  one is bound), and one file per registered connection:
                  speech.json, models.json, mcp-servers.json, fabric.json (the
                  workspace) and fabric-data-agent.json
  project/        directories the app creates for projects it names itself. A
                  project bound from a folder the user picked lives where they
                  picked it and is only pointed at from projects.json
  sessions/       one JSONL event log per session
  turns/          one JSONL event log per turn
  skills/         user- and agent-authored skills
    .proposals/   agent-authored skills awaiting human approval
  knowledge/      graph.json, the persisted project index
  memories/       memories.json — durable facts and derivation bookkeeping
  samples/        the demo knowledge vault, when it is loaded. The only sample
                  set that is files rather than records; everything else lives
                  in the store it belongs to, under fixed `*_sample_` ids
  jobs.json       scheduled job definitions
  runs.jsonl      scheduled run history
  council/        one directory per council run
  orchestration/  orchestration plan documents
  research/       one directory per research run, each holding run.json —
                  the plan, its questions and findings, the round ledger and
                  the Agent Framework graph
  meetings/       meetings.json index, then one directory per meeting:
                    audio.wav (written by the iq-audio sidecar; deleted after
                      transcription unless retained)
                    transcript.jsonl
                    notes.md
  recordings/     recordings.json index, then one directory per recording:
                    events.jsonl (the captured timeline, append-only)
                    video.webm, frames/ and frames.json (screen capture, when
                      it was asked for)
                    narration.wav and narration.json (when narration was asked
                      for)
                    bundle.json, analysis.json, build.json — all derived, and
                      all rebuildable from the three above, which is what makes
                      them safe to delete and re-run
  renders/        scratch PNGs from the native Office renderer. Each is read
                  once and deleted; anything left is a crashed render. Safe to
                  delete.
  tools/          binaries `pnpm prepare:*` downloads, the research sidecar's
                  Python environment, and the resolved skills-for-fabric
                  bundle. Safe to delete.
  audit.jsonl     append-only audit log
```

No credential appears in this tree. Microsoft tokens live in the Azure CLI's own
OS-backed cache and the GitHub credential under the Copilot runtime's
`COPILOT_HOME`, so the application has no secret store of its own to protect.

Writes that must not be observed half-complete use write-then-rename. Mutations
to a plan document are taken under a per-key mutex.

### The workspace-to-project rename

The app used to call a bound directory a *workspace*. So does Microsoft Fabric,
about something else entirely, one tab away. The code now says **project** for
ours and keeps **workspace** for Fabric's, and the word `workspace` anywhere in
this repo means Fabric's.

An install written by an older build is brought forward once, at boot, by
`packages/core/src/config/migrate.ts`. It moves `<userData>/workspace` to
`project` and `config/workspaces.json` to `projects.json`, then walks the JSON
and JSONL under config, sessions, turns, jobs, orchestration, memories,
knowledge, meetings and recordings renaming *keys* — `workspaceId` to
`projectId`, and the rest of the map in that file.

Three things it deliberately does not do:

- **Values are left alone**, apart from the one enum that carried the word: a
  memory scoped to `"workspace"` becomes `"project"`. A bound directory may
  genuinely be called `C:\work\workspace`, and rewriting that would point the
  app at a folder that does not exist.
- **Fabric's state is skipped by path, not by shape** — `config/fabric.json`,
  `config/fabric-data-agent.json` and everything under `<userData>/fabric`. A
  persisted Fabric run carries a real `workspaceId`, a GUID that addresses a
  workspace in Fabric's API, and renaming it would break the run.
- **The audit log is not rewritten.** It records what happened, and an entry
  that says `workspace.bind` is a true statement about an older build.

It runs before `ensureAppPaths`, which would otherwise create an empty `project`
directory and block the move, and it refuses to overwrite anything the new build
has already written. `tests/state-migration.test.ts` pins all of it, including
that a persisted Fabric run survives untouched.

Saved flow graphs are the exception, because device storage has no boot step:
`listFlows` normalises the old config values on read.

IQ Workflow drafts and the IQ Cell library are the exception: while the surface
is in beta they live on the device, keyed per project as `iq.flows.<project>`
and `iq.iqcells.<project>`. `storage.ts` migrates the earlier
`iq.iqlets.<project>` key on first read — a rename is not a reason to lose
someone's work. Nothing under `<userData>` is written by this surface, which is
also why nothing on it executes.

They are reached through `flow/device.ts` rather than `window.localStorage`
directly. `DeviceStore` is `read`/`write`/`remove` plus `announce`/`listen` —
the last pair because the Connectome → canvas handoff is a contract between two
surfaces, and as a bare `window` custom event it was two components talking
through a global with nothing declaring that they did. There are two adapters:
the browser one that ships, and an in-memory one the tests run on. That is what
makes it a seam rather than a hypothetical one, and it is the same interface a
later privileged implementation would satisfy.

The seam also bounds a leak. Because this store had none, the fact that one
module is device-owned had to surface in `SampleOwner`, in the samples hub, in
the IPC channel set and in a renderer hook before it could be presented at all
— `DEVICE_SAMPLE_MODULE` in `@iq/shared` is what stops the two sides describing
that module in separate, byte-identical copies.
