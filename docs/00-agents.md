# Agent instructions and design — IQ Compiler

The single agent-facing document for this repository. It is `AGENTS.md` and
`AGENTS2.md` consolidated: the conventions an agent must follow, then both
design documents in full, then the places where they no longer match the code.

Nothing that was decided has been dropped. `AGENTS.md` is Part 1 below and
`AGENTS2.md` is Part 2, both verbatim.

Read Parts 1 and 2 as a statement of intent, not as a description of the code.
Where they differ, **the code is the truth and the document is the thing to
fix** — the known divergences are listed at the end.

---

## Conventions

- **Where IQ Cells come from.** One surface records them — **IQ Workflow**,
  which publishes a business flow somebody drew: start → steps and decisions →
  an outcome. IQ Industry's bundled primers are reconciled into the library on
  every visit because they ship with the app. IQ Knowledge, IQ Memories, My IQ
  and Connectome IQ publish nothing into it. A surface that quietly produced an
  IQ Cell as a side effect of indexing, or of analysing, was filing a record
  nobody had asked for, describing work nobody had drawn.

  The other four values on `IqCellOrigin` exist only because records written by
  earlier builds still carry them. Every published record carries its `origin`,
  the IQ Cell library filters by it, and My IQ shows it on every
  node. `flow/route.ts` keeps an arm for all five values, because a record
  cannot be routed anywhere by an origin the router has forgotten.
- **A record's identity is what it describes, not when the button was pressed.**
  Publishing the same diagram again is a **new version of one record**;
  publishing a different one is a **different record**. Get this wrong and the
  library fills with identical v1 rows. `connectome/draft.ts` mints the stable
  id for a reconstruction and the rule is pinned by
  `tests/flow-draft-identity.test.ts`.
- **Naming.** The top-level modes are Chat, Co-create, **IQ Cell**, **Connectome
  IQ** and Control Center. Chat contains Conversation, Team, **Research** and
  **Data agent**.
  IQ Cell contains **My IQ** first, then the four source surfaces: **IQ
  Industry**, **IQ Knowledge**, **IQ Workflow** and **IQ Memories**. The **IQ
  Cell library** follows them as the store of versioned cells. Each cell comes
  from one source; the library is an output, not a fifth source. The product
  line is *Your knowledge, intelligence, and workflows.* Connectome IQ is a
  mode of its own with one destination in it.
  Never write bare "Flow", bare "Connectome", "IQ Connectome", "My
  IQ (Connectome)", "IQ
  Editor" or "Neural Connectome" in the UI, and never "IQ-cell" or "IQ-let" — it
  is **IQ Cell**, two words. In IQ Workflow the canvas document is a *diagram*
  or a *draft*; the published record is an *IQ Cell*. **Compile** describes the
  product-level path from a source into a versioned cell. It is not an IQ
  Workflow action: nothing on that canvas executes, and **Publish** only stores
  the finished diagram in the library.
- **Wording.** Pane visibility controls read **Hide Panel** / **Show Panel**.
  The word "Collapse" does not appear in the UI.
- **The rail carries only what a mode can act on.** Chat and Co-create list
  Conversations; IQ Cell and Control Center do not. A group renders only when
  it has entries — a heading over an empty list is a divider, not a grouping.
  The mode segments name the three ways work is *done* — Chat, Co-create,
  IQ Cell. Control Center governs work rather than being a way of doing it, so
  it sits at the top of the bottom group with the bound project and the
  connections; `mode === "control"` is unchanged everywhere else.
- **Home is a destination, not a state the app falls into.** It is a rail item
  that names both the sub-mode and the flag, because the chat pane picks its
  content from the sub-mode first — a control that sets only a flag renders
  nothing on Team or Data agent and reads as dead.
- **Where a conversation belongs is stated once, or inferred — never
  reported.** A conversation records a `SessionPlace` (a sub-mode, a canvas
  surface, or both) and selecting it in the rail restores that view. Three
  sources, ranked:
  | Source | Written by | Rank |
  |---|---|---|
  | `chosen` | the destination picker under **New conversation**, on `sessions:create` | wins outright |
  | `work` | the privileged side, from the tool the agent asked for | places everything unstated |
  | `navigation` | nothing, any more | folded by nobody |

  `CONVERSATION_DESTINATIONS` is what the picker offers and
  `canHoldConversation` is what the privileged side refuses a write on; a test
  proves every offer passes the rule. **Team and Data agent are not
  destinations** — both replace the chat pane with state of their own, so a
  conversation filed on either reopens showing none of its own messages. The
  shell must never send a place because a tab changed: an earlier build did,
  and one real deck conversation collected nine contradictory records.
- **Panes follow the open surface, not only the mode.** *Connections & access*
  shows the canvas alone; *Projects* keeps the navigator and drops the
  conversation, because a turn is scoped to the bound project and the control
  that rebinds it is on screen. The map lives in `SURFACE_HIDES_PANES`.
- **A surface that cannot act says why, in place.** Disable the control and
  attach the reason; never replace the surface with an explanation, and never
  hide the control. "Not available" and "not built" must not look alike.
- **Sample data is loaded, never run.** A *Load sample* control fills a form
  and stops. Nothing that spends tokens happens without the user pressing the
  run control themselves. Sample automations arrive disabled, are re-disabled
  on every load, and are skipped by the scheduler while the sample-data flag is
  off; the sample plan is already finished, so nothing is dispatched.
- **All sample handling lives in the two hubs.** `packages/core/src/samples`
  owns the fixed data, the module list, the global flag and the load/clear
  orchestration; `apps/renderer/src/samples` owns the renderer's half and the
  one module held in `localStorage`. There is one IPC family — `samples:status`,
  `samples:setEnabled`, `samples:load`, `samples:clear` — and the module is a
  *value*, not a channel name. No surface may carry its own sample constant,
  count samples by sniffing an id prefix, or add a seed/clear channel of its
  own: five surfaces each answering "is this loaded?" for themselves is what
  the hubs replaced.
- **Look.** Light theme is the default. Icons come from `lucide-react` and
  nowhere else.
- **Scope.** Microsoft-ecosystem integrations only. No third-party model or
  image providers.
- **Placement.** Every capability declares exactly one mode and one sub-mode in
  `packages/shared/src/mode.ts`. Adding one without placing it there is not
  acceptable.
- **Sample data.** `sample-data/` is material, never code. `tests/e2e/` is code.

## Where things are

| Path | What it is |
|---|---|
| `packages/shared` | zod contracts, including the mode registry and the IPC surface. ESM only |
| `packages/core` | governed runtime services |
| `packages/myiq-mcp` | the MCP server this app *publishes*, serving a sample-data snapshot over stdio |
| `apps/main` | Electron main — the only privileged process. IPC handlers live in `apps/main/src/ipc/` |
| `apps/preload` | context bridge; validates every IPC message |
| `apps/renderer` | React UI, untrusted. Styles are `styles.css` (an import list) over `apps/renderer/src/styles/` |
| `native/` | three sidecars: `iq-audio` (WASAPI loopback), `iq-evolve` (DSPy + GEPA), `iq-research` (Agent Framework) |
| `skills/` | the thirteen bundled skills, shipped read-only |
| `scripts/` | the `pnpm prepare:*` steps that fetch or build the sidecars and the Fabric skill bundle |
| `tests/` | unit suite (`*.test.ts`), and `tests/e2e/` — Playwright over the real window, plus a manual plan |
| `sample-data/` | material for the tests and for driving the app by hand |
| `docs/` | this document and the rest of the design set |

## Commands

```powershell
cd iq-compiler
pnpm typecheck                     # shared, core, myiq-mcp, preload, main — NOT the renderer
pnpm --filter @iq/renderer build   # the only renderer typecheck
pnpm test                          # unit suite, hermetic, needs no build
pnpm build                         # everything
pnpm test:e2e                      # system tests; needs pnpm build first
```

---

# Part 1 — The application

# IQ Compiler — Application Design Prompt

IQ Compiler is a specialized agent application optimized for the Microsoft ecosystem. Microsoft services and ecosystem integrations are first-party capabilities.

## Scope

- Focus exclusively on Microsoft products, Microsoft 365, Microsoft Foundry, Work IQ, and Entra ID integrations.

- Do **not** include third-party integrations such as Google or Slack.

## Product UI principles

The product UI is organized around a persistent left rail, a gated sign-in card, a minimal Chat landing surface, and a Co-create workbench with chat, canvas, and project navigator visible together. The visual system uses a light default, low-chrome surfaces, role tokens, a consistent icon library, and controls that keep approval state visible at the point of action.

Key interaction rules:

- Primary navigation lives in the left rail, with the mode switch pinned above sub-mode destinations and account/settings actions pinned to the bottom.
- Chat opens on a centered greeting, a single composer with attachment, model, approval and scope controls, and starter assistant cards.
- Co-create keeps the conversation, artifact canvas, and project navigator visible together so the user can watch file changes while reading the agent's reasoning.
- The sign-in card shows one connection row per required provider and keeps **Continue** disabled until every required connection is green.

## Product Shape — Modes and Projects

The current build groups work into **five top-level modes**, each with a small
set of named destinations, plus a project concept.

### Top-level modes

- **Chat** — the default, deliberately minimal surface: conversation, saved chats, search, model and agent selection, approvals, and voice. Nothing else competes for attention. A first-time user should be able to work here without learning any other concept. Its empty state is a centered greeting, one composer with attachment / model / approval controls, an optional project scope selector, and a small grid of starter assistants — not a dashboard.

- **Co-create** — the working surface where artifacts are produced: project files and artifacts, knowledge graph, browser, skills, MCP servers, and meetings. Its layout is specified in **Co-create Layout** below.

- **IQ Cell** — the four source surfaces, the versioned cell library, and My IQ,
  which analyses what selected cells become together.

- **Connectome IQ** — an organization view that places published IQs as
  business functions with AI roles.

- **Control Center** — the governance surface for **Automations**, **Delegated
  plans**, **Audit**, **Sample data**, and **Clean**. Skills and MCP servers are
  standing capabilities in the same rail. Control Center is read-and-configure,
  never a place where new artifacts are authored.

Mode is a single switch pinned to the **top of the icon rail**. It is the one
control that never collapses, so the user always knows which mode they are in
and can always leave it. The switch shows four work-mode segments; Control
Center remains a rail destination because it governs work rather than doing it.
Sub-modes appear below the switch, never as a second switch.

### Sub-modes

| Top-level mode | Sub-mode | Purpose |
|---|---|---|
| Chat | **Conversation** (default) | One user, one agent, one thread. |
| Chat | **Team** | A council of agents debates a question and returns a decision. |
| Chat | **Research** | A cited investigation that produces a report. |
| Chat | **Data agent** | Questions answered by a Fabric Data Agent. |
| Co-create | **Fabric** (default) | Build Microsoft Fabric artifacts from data definitions. |
| Co-create | **Office** | Document, spreadsheet, and deck authoring through OfficeCLI. |
| Co-create | **Image Creation** | Image generation and editing through a Foundry image model. |
| Co-create | **Skill Recording** | Demonstrate a task and capture it as a reusable skill. |
| IQ Cell | **My IQ** / **IQ Industry** / **IQ Workflow** / **IQ Knowledge** / **IQ Memories** / **IQ Cell library** | Create versioned cells from four source types and analyse selected cells together. |
| Connectome IQ | **Connectome IQ** | Organize published IQs as company functions with AI roles. |
| Control Center | Automations / Delegated plans / Audit / Sample data / Clean | Governance and maintenance destinations. |

- **One conversation, many surfaces.** All modes share the same conversation object; there are never parallel histories. Promoting a chat to Co-create asks for a project and binds it; demoting back to Chat keeps the thread and unbinds the panes. Entering a sub-mode changes the active agent configuration and the canvas surface, not the thread. Switching modes must not lose conversation state.

- **Project** is the unit of scoping: a named directory plus the sessions, artifacts, skills, MCP connections, knowledge index, and memories bound to it. Every agent action names the project it acted in, and audit records carry it. Chat mode may run without a project; Co-create mode requires one; Control Center shows a project filter with an "all projects" option.

- **Every capability declares exactly one mode and sub-mode.** A chat message may *create* an automation and link to it, but Control Center remains its only editor. Adding a capability without assigning it to a mode is not acceptable.

## Chat — Team Sub-mode (Council)

Team mode answers debatable questions that a single agent answers badly: trade-offs, design choices, prioritization, risk calls. It runs a **council** of agents that argue to a decision instead of a single agent producing one opinion.

- **Council composition is explicit and editable before the run.** The user picks a question and a roster of 2–6 council members. Each member has a name, a stance or role brief (for example *advocate*, *skeptic*, *cost*, *security*, *end user*), a model, and an optional skill or MCP tool grant. Ship a small set of preset councils and let the user save their own.

- **A chair agent runs the session** and is distinct from the members. It restates the question and the decision criteria, orders the rounds, prevents repetition, calls the debate when positions stop moving or the round budget is spent, and writes the verdict.

- **Rounds are the unit of progress.** Opening statements → rebuttal rounds → convergence → verdict. The round budget is set before the run and shown as a progress indicator. The user may inject a message, add a constraint, challenge a member, or force the verdict at any round boundary.

- **The transcript is legible, not a wall of text.** Each member's contribution is a card carrying the member's name, stance, model, and a one-line summary, expandable to the full argument and any tool calls it made. Rounds are visually grouped and collapsible.

- **The verdict is a structured artifact, not a paragraph.** It carries: the recommendation, the decision criteria used, the strongest argument for and against, explicit dissent attributed to the members who held it, confidence, and open questions. It is exportable to the project as Markdown and citable from later conversations.

- **Cost and safety.** A council multiplies token spend, so show a live per-run estimate and require the round budget up front. Members inherit the session's approval policy; a member cannot hold a broader tool grant than the user's own session. Every member turn is audited with its role, model, and round number.

- Team mode may run without a project. When one is bound, the verdict is written into it and indexed.

## Co-create — Office Sub-mode

Office mode authors and edits real `.docx`, `.xlsx`, and `.pptx` files through **OfficeCLI**: the agent drives a CLI, and the canvas shows the result as it is built.

- **OfficeCLI ships as an internal, first-party tool**, not a user-installed prerequisite. Discover an existing `officecli` on PATH; otherwise install and pin a known-good version into the app's own tool directory and record the version in the audit record of every invocation. OfficeCLI is a self-contained binary with the runtime embedded, Apache-2.0 licensed, available for Windows x64/arm64 (evidence: `iOfficeAI/OfficeCLI:README.md`).

- **Invocation is subprocess-based.** OfficeCLI exposes no Node API; the agent composes `create`, `add`, `set`, `remove`, `query`, `batch`, `merge`, `validate`, `view`, `open`, and `close` subcommands (evidence: `iOfficeAI/OfficeCLI:README.md` command reference). Use `open` / `close` resident mode for multi-step edits, and set `OFFICECLI_RESIDENT_FLUSH=each` so the canvas preview always reads the current state rather than a stale file.

- **The canvas previews the document while it is being generated.** Each mutation refreshes the canvas tab for that artifact. Prefer rendering through OfficeCLI's own HTML/SVG/screenshot output (`officecli view <file> html|svg|screenshot`) inside the canvas rather than embedding the `watch` HTTP server; if `watch` is used, bind it to loopback on an ephemeral port, never expose it, and tear it down with the tab. The preview is explicitly labeled read-only while a generation is in flight, and the header warns against opening the file in the system app mid-run, which locks it.

- **Office skills are Agent Skills, one per output type**: `officecli-docx`, `officecli-xlsx`, `officecli-pptx`, plus higher-level presets such as an academic-paper skill and a CSV-to-dashboard skill. Skill directory name and the `name` field in `SKILL.md` frontmatter must match exactly.

- **Governance.** OfficeCLI is a governed tool source like any other: its file writes are bounded by the project navigator's tree, every invocation is audited with the subcommand and target path, and document-destructive operations (`remove`, `raw-set`, overwriting an existing file) are never in the auto-approvable safe set.

- Every generated file is a normal project artifact: it appears in the navigator, gets snapshot-and-history in the canvas header, and is indexed into the knowledge graph.

## Co-create — Image Creation Sub-mode

Image Creation generates and edits images using an **image model served from Microsoft Foundry** (GPT-image class), selected in Control Center → Models. There is no third-party image provider.

- The canvas hosts the image surface as a **conversation**: prompts and their results run down the page oldest first, with a composer pinned underneath. The first result is a draft, and a follow-up prompt changes the image already there instead of starting a new one. Per-image actions — change this image, change one area of it, make another like it, save to project, view generation parameters — pin an image to the composer so the next turn continues from it.

- **The region selector** paints the part of a picture an edit applies to. The painted area travels with the request and is never written to disk: it describes one edit and is meaningless afterwards. The area is a hint rather than a boundary, and the surface says so.

- Editing needs a bound project, because an edit re-reads its source image from the project. With no project bound the edit actions are present and disabled with the reason on them.

- Supported operations follow what the selected Foundry deployment advertises: text-to-image, image edit with a source image and optional mask, variations, and batch generation with a visible count and cost estimate.

- **Every generation records its provenance**: model deployment name, endpoint, prompt, seed or parameters, whether the edit was confined to a painted area, timestamp, and project. Saving an image to the project writes that provenance alongside it and into the audit record.

- Images saved to the project are ordinary artifacts — they appear in the navigator, open in the canvas image viewer, and can be attached to a chat turn or embedded into an Office artifact.

- The image endpoint is reached with the Azure identity, so Image Creation is one of the capabilities that must show its connection and deployment state before the user invokes it, and offer connect-in-place rather than failing mid-generation.

## Chat — Research Sub-mode

Research produces a **comprehensive, cited report** on a topic by combining the built-in browser, HTTP/API access, Work IQ and Microsoft 365 sources, and the vault knowledge index.

- **The run is a visible plan, not a black box.** The agent decomposes the topic into questions, the plan appears in the canvas, and each question shows its status, the sources consulted, and its findings. The user can edit the plan, add or remove questions, and re-run a single question without restarting the report.

- **Parallel sub-agents gather; one agent writes.** Independent questions are delegated to sub-agents that run concurrently under the orchestration model; a single writer agent synthesizes the report so voice and structure stay consistent. Delegated runs appear in Control Center → Delegated plans.

- **Every claim carries a citation** to a URL, an API response, a Microsoft 365 item, or a project artifact. A claim that cannot be sourced is marked as unverified rather than stated. Conflicting sources are reported as a conflict, not silently resolved.

- **Sources are governed.** Web fetches use the browser's containment rules and the deny-list; the browser's page-read verb returns capped, untrusted text that is cited rather than obeyed; API calls go through the governed tool registry with per-host approval; Microsoft 365 and Work IQ reads use the Azure identity with per-resource tokens. Every fetch is audited host-only.

- **The output is a project artifact** — Markdown by default, exportable to `.docx` through the Office sub-mode — with a source table, a coverage summary naming what could not be answered, and a re-run control that refreshes the report against the same plan.

- Research runs can be long. They are resumable, safe to retry per question, and report a live status line per question expandable to the full trace.

## Control Center

Control Center is the third top-level mode and the single home for governance and configuration. It uses the same icon rail and canvas, but has no project navigator: its right pane is a detail/inspector panel for the selected record.

- **Memories** — the approved-memory store. List, search, filter by project, inspect provenance (which conversation and turn produced it), edit, revoke, and export. Memory creation still happens in Chat and Co-create; Control Center is its only editor.

- **Automations** — scheduled and recurring tasks. Create, edit, enable/disable, run-now, and inspect run history with per-run status, duration, and outcome. Failed runs show the error and a retry that is safe to repeat.

- **Delegated plans** — orchestration runs: sub-agent delegation trees and parallel task execution. Each plan shows its DAG, per-node status, the agent and model used, and an expandable trace. Nodes are individually retryable; a running plan is cancellable.

- **Audit** — the governance record: every tool invocation, permission grant, auto-approval window, connection change, and agent action, each carrying the project, mode, sub-mode, correlation ID, and outcome. Filterable and exportable. Audit is distinct from artifact history; the two cross-link by correlation ID.

- **Models** — see below.

### Control Center — Models

A single place to see and configure every model the app can use.

- **Two providers only.** **GitHub Copilot**, whose models come from the Copilot SDK's advertised catalog for the signed-in account and are not manually configured; and **Microsoft Foundry**, whose deployments the user adds explicitly.

- **A Foundry model entry carries**: a display name, the endpoint URL, the deployment name, the API version, the capability set (chat, reasoning, vision, image generation, embeddings), and an optional per-project restriction. Authentication uses the Azure identity — no keys are stored by this app. An entry may instead reference a **Foundry agent** by agent ID, in which case the app calls the agent rather than a raw deployment.

- **Every entry is testable in place.** A Test control performs a minimal round-trip and reports reachable / unauthorized / not found / failed with the actionable next step, and stores the last-tested timestamp.

- **Defaults are explicit and layered.** The user sets a default model per role — chat, reasoning, Office authoring, image generation, research writer, council member — and may override per project and per turn from the composer. The composer's model picker reads this catalog; it is never a separate list.

- Models added here are what appear in *Connections & access*; the two surfaces read one registry.

## Co-create Layout

Co-create mode uses **icon rail · chat · canvas · project navigator**. Each pane has one job, and the panes stay visible together so the user can watch the agent change a file while reading its reasoning. There is no fourth column.

**0. Icon rail (far left).** Primary navigation, and only navigation: every row in it is a place you can go. It opens at 56px — a strip of icons, each naming itself on hover — and **Show Panel** takes it to 248px, where every entry carries its label and its one-line detail. The mode switch, the destinations and the bottom group are the same at both widths; only the words leave. The control to bring them back sits in the strip, in the row it left from, and the choice is remembered.

The conversation list is not in the rail. **History**, in the bottom group, opens a 300px flyout over the work carrying the four groups — Conversations, Councils, Data agent, Unattended — with a search field over their titles. It has no scrim: the rail and the work stay clickable while it is open, so a row can be double-clicked to rename it, and it closes on its own control, on the close button or on Escape. The same list is on the Chat landing page under **Pick up where you left off**, capped at six rows per group. Only Chat and Co-create have the control, because they are the only modes that hold a conversation.

**1. Chat panel (left).** The conversation, docked beside the work rather than covering it.

- Assistant text, tool invocations, and results in one chronological column.
- Each tool call is a compact card with its command or arguments, a success or failure indicator, and long output collapsed behind an expander — never a wall of raw text.
- The composer sits at the bottom of this pane with attachments, agent, model, approval, and voice controls.
- Chat never disappears in Co-create; it is how the user acts on the project.

**2. Canvas (center).** The single place work appears, and the largest pane.

- **One tab concept in the entire product.** The canvas tab strip holds open artifacts *and* secondary surfaces — knowledge graph, browser, skills, MCP servers, the Office live preview, the image surface, the research plan and report, and *Connections & access*. Selecting a destination in the rail opens it as a canvas tab. There is no application-level tab strip. Control Center's destinations open in the canvas the same way when that mode is active.
- Tabs are closable and several stay open at once. Opening a file from chat or from the navigator opens a tab here.
- Type-aware viewers rather than one generic text box:
  - Documents and PDFs — paged view with a thumbnail rail, page navigation, and zoom.
  - Markdown and code — an editor with line numbers and a Source / Preview / split toggle.
  - Spreadsheets — a grid with one tab per worksheet.
  - HTML and web artifacts — a Code / Preview toggle with a live rendered result.
  - Images and media — a fit-to-pane viewer.
  - Office artifacts under generation — a live preview that refreshes on each OfficeCLI mutation (see *Co-create — Office Sub-mode*).
- Per-artifact actions in a consistent header: open in the system app, download, and — where the artifact is agent-modified — **snapshot and history**. Artifact history is the user-facing version list with revert; the audit log is the separate governance record. The two are distinct surfaces, cross-linked by correlation ID.
- Read-only previews must say so explicitly.

**3. Project navigator (right).** The file tree for the active project.

- Folders and files with a refresh control, reflecting the real project directory.
- Selecting a file opens it in the canvas; the tree highlights what the agent is currently touching, so file changes are visible as they happen.
- This pane is the visible boundary of the project **on the filesystem**: what is in the tree is what the agent can read or write without a further grant. It says nothing about non-file reach — Microsoft 365, Work IQ, the browser, and MCP servers are governed by the permission policy and surfaced in the *Connections & access* canvas tab, never implied by the tree.

**Pane behavior — and a bug to fix.** Panes are collapsible and resizable, but expanding one pane currently shrinks and distorts the others. Fix this properly rather than tuning widths:

- The pane container is the sole owner of layout. Every pane declares a **minimum width** and either a fixed width or a flex weight; the container distributes remaining space and never lets a pane fall below its minimum. Content inside a pane must not push it wider — panes are `min-width: 0` flex children with internal scrolling, so a wide table, a long path, or a code block scrolls inside its pane instead of expanding it.
- **Expanding the icon rail overlays the chat panel; it never adds or resizes a column.** The same applies to any transient expansion: overlay, do not reflow.
- Resizing is a drag on the divider between two adjacent panes and moves space **only between those two**. The remaining panes keep their width exactly.
- Widths persist per project and are restored on reopen. When restored widths no longer fit the current window, fall back to the default distribution rather than producing sub-minimum panes.
- When the total minimum width exceeds the window, collapse panes by priority — navigator first, then chat — instead of squeezing all three.
- At narrow widths the navigator collapses to an icon; narrower still, the layout becomes a single pane with a chat ⇄ canvas toggle. Chat and canvas are the two panes that survive.
- **Wording:** the control that hides a pane is labeled **Hide Panel** (and **Show Panel** when hidden), in its tooltip and its accessible name. The word "Collapse" does not appear in the UI.
- **Hiding the rail narrows it to icons; it never removes it.** Every destination stays clickable and stays tooltipped. A navigation surface that leaves the window entirely takes its own way back with it. Icons are the default, because the rail carries no conversation list: narrow costs labels and nothing else.
- **Navigation and history are different lists.** The rail lists places; History lists the things the user made. They used to be one column of identical rows, which meant telling a destination from a conversation required already knowing the app.

## UI and Visual Design

The surface uses Fluent as the *structural* base — neutrals, type ramp, spacing, interaction states — with an expressive layer built from shared design tokens, depth, restrained accent, and purposeful motion.

- **Token architecture.** Colors are **CSS custom properties** defined once per scheme and consumed everywhere through utility classes; components never hardcode a hex value. Light is the `:root` default, dark is a `[data-theme='dark']` override of the *same* token names, so no component knows which theme is active.

- **A layered background scale instead of one flat grey.** Define at least `--bg-base`, `--bg-1`, `--bg-2`, and `--bg-3` (the border tone) and use elevation deliberately: canvas on the base surface, chat and navigator one step up, cards and composer one step up again. This is what removes the monotony — depth through layered surfaces and soft shadows, not through heavy 1px borders everywhere.

- **A real brand ramp, not a single accent.** Define a 10-step brand ramp with a designated base step, and derive tints, hovers, selections, and subtle fills from it. Reserve a distinct `--primary` for interactive elements and keep semantic `--success` / `--warning` / `--danger` separate from brand.

- **Role tokens, not raw colors, at the call site.** Message bubbles, tool-call cards, code blocks, and status chips each get named tokens (for example a user-message background token) so a theme change is one file.

- **Give surfaces character.** Generous rounded radii on cards, composer, and message bubbles; soft shadows rather than hard strokes; a restrained brand-tinted gradient on the primary action and the mode switch; a distinct mono stack for code and CLI output. Density varies by pane — spacious in Chat's landing surface, compact in the navigator and tab strip. Do not achieve variety by inventing new colors per screen; achieve it with surface layering, radius, spacing, and typography over one palette.

- **Motion, kept small and purposeful.** Short easing-based transitions on hover, selection, pane resize, tab switching, and message arrival; a streaming indicator and skeleton states for in-flight work. No decorative animation, no animation library required.

- **Icons: `lucide-react`, exclusively.** Refactor every icon in the app to lucide-react and remove other icon sources. One import path, consistent stroke width and size scale (16 / 20 / 24), sized and colored by token — never a raw hex. Icon-only controls must always carry an accessible name and a tooltip.

- **Navigation is a persistent left icon rail**, not a top tab strip. It carries the mode switch, the sub-mode and primary destinations, and account plus settings pinned to the bottom, and expands on demand to show labels, live secondary lines, and the saved-chat list. The current top-tab layout is removed entirely.

- **Light theme is the default.** Dark theme is optional and user-selected, built from the same tokens. Do not ship a dark-by-default product; layout and palette are independent choices.

- The chat composer carries its controls in a footer row — agent, model, approval, attachments, voice, send — rather than scattering them around the page.

- **No global approval bypass.** The composer's approval control enables **session- and project-scoped auto-approval of a named safe tool set**, which expires with the session, is always audited, and never covers credential, destructive, or outbound-send tools.

- Long-running work (turns, tool calls, background agents, plans, council rounds, research questions) must be legible at a glance: a status line per item, expandable to a full trace.

- **Wording:** no "Collapse" anywhere — pane visibility controls read **Hide Panel** / **Show Panel**.

## Authentication

The app **does not require an app registration**: no `client_id`, no configured `tenant_id`, and no client secret.

- **Two connections, both required to continue.** The app does not open until *both* are green. Microsoft is not deferred to first use, because Foundry models, Work IQ, and Microsoft 365 are core to the product rather than optional extras. The sign-in card is a single centered gate with status for both connections.

  1. **Microsoft / Azure** — the tenant identity used to reach Foundry, Azure, and Microsoft 365 resources. Tokens come through the signed-in Azure CLI identity: `az login` for interactive sign-in, `AzureCliCredential` for silent token acquisition and status checks. No application identity is registered or stored by this app (evidence: `electron/azure-auth.ts`).

  2. **GitHub Copilot** — the agent runtime. Authentication uses the Copilot SDK's own device-flow credential persisted on the device, and state comes from the SDK's auth status rather than any app-held token. Stale GitHub token environment variables are stripped from the runtime environment, because the SDK otherwise picks up a non-Copilot token and reports "No model available" (evidence: `electron/copilot.ts:1055-1073`, `electron/copilot.ts:368-374`).

- **Sign-in card composition:** a centered card with a lock glyph and title; a two-line explainer stating that Azure sign-in acquires a token, GitHub Copilot connects the runtime, and the Foundry agent connection is verified inside the app; the **Tenant ID** field; a full-width primary button per connection, each with a status dot and status line directly beneath it (`Not connected — Not signed in yet.` → `Connected — <account> · <tenant name>`); a **Continue** button that stays disabled until both lines are green; and a footer note explaining what each sign-in does. Connection order is not enforced — either button may be used first.

### Multi-tenant handling

Tenant selection is a first-class part of sign-in, not a hidden setting.

- **Tenant ID is optional.** Blank means the account's home tenant. The field is **read-only by default with an inline `Edit` affordance**, so the common case is one click and the override is still discoverable (evidence: `SignInScreen.tsx:46-58`).

- **The field accepts a GUID or a domain** (for example `contoso.onmicrosoft.com`) and validates the format before attempting sign-in.

- **Remember known tenants.** Once signed in, the app lists the tenants the account can access and offers them as a picker instead of requiring the user to paste a GUID again. Each entry shows the tenant display name, the domain, and the GUID; the raw field remains available for a tenant not in the list, such as one the user is being invited into.

- **Interactive sign-in clears cached CLI accounts first** so the account picker always appears; otherwise tenant switching silently reuses the previous identity and fails with `AADSTS50020` (evidence: `azure-auth.ts`, `signInAzure`).

- **Switching tenants after launch is supported** from *Connections & access* and re-runs the same flow. Switching invalidates cached resource tokens and any Foundry endpoint bound to the previous tenant; the app says so before switching and re-verifies affected model entries afterward, rather than failing later mid-turn.

- **Failure states are distinguished and actionable**, each with the next step and a retry: Azure CLI not installed or not on PATH; user canceled; account is not a member of the requested tenant (`AADSTS50020`) — the tenant picker is offered; consent or conditional-access required; token expired; and generic failure with the underlying message. Copilot has its own set: device flow pending, device flow expired, no Copilot entitlement, and a stale `GITHUB_TOKEN` in the environment.

- Capabilities that need a resource beyond sign-in — a Foundry deployment, an Azure AI Speech resource, a Work IQ scope, a Microsoft 365 permission — show their state before the user invokes them and offer connect-in-place instead of failing mid-turn.

- Least privilege still applies: resource tokens are acquired per resource and per action, every acquisition stays in the privileged process, and tokens stay out of logs and audit records.

## Connections & Access

*Connections & access* is a canvas tab and the single place the user sees what the app can reach. It is not a second model list — it renders the same registry as Control Center → Models.

- **Identity** — the Azure account, the active tenant with a switch control, and the GitHub Copilot connection, each with status, last verified time, and a re-verify action.

- **Microsoft Foundry** — an editable list of endpoints and what is served from each:
  - **Endpoint** — the Foundry project or resource URL, plus the API version.
  - **Model deployments** — deployment name, underlying model, and capability set (chat, reasoning, vision, image generation, embeddings). The image deployment used by Image Creation is selected here.
  - **Agents** — Foundry agents referenced by agent ID, so the app can call a published agent instead of a raw deployment.
  - **Test** — a per-entry round-trip that reports reachable / unauthorized / not found / failed, with the last-tested timestamp.
  - **Scope** — an optional per-project restriction on which entries are available.
  - Authentication is the Azure identity; no endpoint keys are stored by this app.

- **Microsoft 365 and Work IQ** — the resources and scopes currently granted, when each was last used, and a revoke control.

- **Azure AI Speech** — the Speech resource behind voice input, spoken replies, and meeting transcription: its custom domain endpoint and locale. A custom-domain resource uses a different REST routing model from regional endpoints, so this endpoint is the whole registration; it is not evidence that all regional Speech APIs reject Entra tokens. No resource key has any representation here, which means the bearer-token path requires Networking → **All networks**; selected or private networks require a key for the special STT/TTS endpoints and are deliberately unsupported. A **Test** control performs a minimal round-trip and reports reachable / unauthorized / not found / not configured with the next step, and records the last-tested timestamp. When the resource is absent or tenant policy denies the Cognitive Services scope, the entry says so in place of the voice and transcription controls silently disappearing.

- **Tool sources** — MCP servers, skills, OfficeCLI, and the browser, each with its enablement state and approved tool families.

- Every change made here is audited.

## Extensibility

- **On-demand skills** — the user can **import and export** skills. Import accepts a skill directory or archive, validates it against the Agent Skills specification, shows what it declares before it is enabled, and requires explicit approval before it becomes loadable. Export produces a portable, specification-compliant bundle. Skills stay scoped to a project and remain revocable.

- **On-demand MCP** — the user can configure MCP server connections from the UI: add, edit, enable or disable, and remove a server; inspect its advertised tools before enabling any; and approve tool families individually. MCP tools enter the same governed tool registry, permission policy, and audit trail as built-in tools. Nothing connects automatically.

## Browser

- **Remove the tenant-policy host allow-list.** Pages generally reachable in a normal browser must be reachable in this app's browser pane. The current Microsoft-host allow-list is too narrow and blocks legitimate research.

- Keep the containment properties that do not restrict where the user may go: a main-process view rather than a renderer element, an isolated session with no preload and no Node integration, denied media/geolocation/clipboard/notification permissions, cancelled downloads, and navigation events that cannot escape the pane into the application.

- Keep audit records host-only, so a URL carrying a token in its path or query is never written to the log.

- A deny-list for known-malicious hosts is acceptable; a general-purpose allow-list is not.

- **The agent operates the pane, it is not merely pointed at it.** Beyond opening a URL, the agent can read the visible text of the current page, go back and forward in its history, reload it, and close the pane — the same verbs the user's toolbar offers, entering the governed tool registry like any other tool. Two rules keep that from becoming an injection channel: reading is an explicit, individually approved call rather than a side effect of navigating, and the returned text is capped and labeled untrusted data to be cited, never instructions to follow. History verbs reach no new host and are approved accordingly; navigation to a new host is re-confirmed every time.

## Knowledge Graph

- **The graph is built over a vault, not the project.** The project is where the agent writes — intermediate output, generated decks, run artifacts — and indexing it turns every scratch file into a node. The knowledge corpus is instead a directory the user curates, in Obsidian's sense of a vault: one isolated tree that owns its own notes, media, links, and tags. *Connections & access* and the Knowledge tab both show which directory is indexed.

- **Choosing the vault is a first-class control.** The Knowledge surface names the current root and offers a directory picker to set it, plus a reset to the project default. Choosing a vault grants no write access — the agent's file boundary is still the project navigator's tree — and the change is audited, invalidates the cached index, and reindexes rather than leaving a graph that describes the previous root.

- With no vault chosen the project is indexed, so an install that never touches this setting still has a graph.


- **Add zoom and pan** — scroll or pinch to zoom, drag to pan, zoom-to-fit, and zoom-to-selection. The current fixed layout is unusable at real graph sizes.

- **Make provenance obvious.** For any node and any edge, the user must be able to see where the knowledge came from: the source file or artifact, the vault it was read from, how it was extracted, and when it was last indexed. Selecting a node reveals its source in the project navigator and opens the underlying artifact in the canvas.

- Group and color nodes by source folder or collection with a visible legend, and provide node search, following the Brain view in `brain.png` and `main-chat.png`.

- Offer **graph and table views over the same index**. Do not build a third file browser: revealing a node's source selects it in the project navigator and opens it in the canvas when the vault is the project, and opens the artifact read-only in the canvas when the vault sits outside it.

## Recommended Capabilities

Evaluate and integrate the following capabilities when they fit the product goals:

- **Automations and learning:** scheduled or recurring task execution, plus creating and updating skills from user interactions and approved memories. Surfaced in Control Center → Automations.

- **Agent orchestration:** sub-agent delegation and parallel execution of independent tasks. Surfaced in Control Center → Delegated plans, and used by Research and Team modes.

- **Co-create work surfaces:** knowledge-graph capabilities, a built-in browser, meeting notes, and voice interaction.

- **Microsoft ecosystem access:** Work IQ, Microsoft 365 data access patterns, and Microsoft Entra ID authorization handling.

- **Skills:** implement skills according to the [Agent Skills specification](https://agentskills.io), including user-driven import and export.

- **MCP:** user-configured MCP server connections, governed like every other tool source.

- **Office documents:** [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) is the engine behind Co-create → Office: skill-driven subcommand invocation with a live canvas preview.

- **Image generation:** a Microsoft Foundry image deployment behind Co-create → Image Creation. No third-party image provider.

- **Agent runtime:** use the GitHub Copilot SDK as the core runtime for agentic behavior; Foundry deployments and Foundry agents are the second runtime, configured in Control Center → Models.

## Design Requirements

- Prefer Microsoft-native identity, authorization, data, observability, and deployment services.

- Authenticate without an app registration: GitHub Copilot through its SDK device flow and Microsoft through the Azure CLI identity, **both required before the app opens**, with an optional tenant override and first-class multi-tenant switching.

- Enforce least-privilege access and preserve clear auditability for user actions and agent operations, including the project, mode, and sub-mode each action ran in. No global approval bypass exists; auto-approval is scoped, expiring, and audited.

- Keep scheduled tasks, skill updates, MCP connections, sub-agent delegation, parallel execution, council rounds, research questions, and OfficeCLI invocations observable, controllable, and safe to retry.

- Every capability belongs to exactly one top-level mode — Chat, Co-create, or Control Center — and one sub-mode, and is scoped to a project. Co-create presents work as icon rail · chat · canvas · project navigator, with secondary surfaces opening as canvas tabs rather than new columns. Expanding or resizing a pane must never distort the others.

- Default to the light theme; treat dark theme as an option built from the same tokens, never the default. Structure comes from Fluent, expression from the role-token architecture, and icons from `lucide-react` only.


## Expected Output

Produce a practical implementation plan that includes:

1. The proposed architecture and the role of each selected component.

2. A prioritized feature backlog with current status and implementation notes for each feature.

3. Integration design for Work IQ, Microsoft 365, and Entra ID, including the registration-free authentication flow, the both-connections-required gate, and multi-tenant selection and switching.

4. Skill definitions that comply with the Agent Skills specification, plus the skill import/export flow, the MCP configuration flow, and the OfficeCLI skill set (`officecli-docx`, `officecli-xlsx`, `officecli-pptx`, and higher-level presets).

5. The mode and project model — Chat (Conversation, Team, Research), Co-create (Project, Office, Image Creation), and Control Center (Memories, Automations, Delegated plans, Audit, Models) — the icon-rail UI structure, the design-token system and its light default, and the Co-create three-pane layout with its pane-sizing rules.

6. The Microsoft Foundry model registry: endpoint, deployment, agent, and capability configuration; the per-role defaults; and the test/verify flow.

7. Security, governance, observability, and retry considerations, including OfficeCLI subprocess containment and research-source governance.

8. Explicit exclusions, including all non-Microsoft third-party integrations and third-party image providers.


---

# Part 2 — IQ Cell (the Action Compiler)

# IQ Compiler — Flow mode (hackathon demo)

**Scope: a demo, not a product.** This document specifies a *frontend-only*
addition to the existing app: **Flow**, a fourth top-level mode beside Chat,
Co-create and Control Center, carrying two sub-modes —
a visual **Flow** editor and a **Connectome** visualization. It extends
[Part 1](#part-1--the-application) but deliberately implements only a thin, highly visual
slice of it.

**The demo goal is visual impact.** The Connectome is the money shot: a dense,
living, three.js fibre-tract render of how a project's automations relate.
Everything else exists to make that render legible.

## Demo rules

| Rule | Meaning |
|---|---|
| **No backend integration** | Nothing in Flow touches the privileged process. No model call, no file write, no Graph, no MCP, no OfficeCLI, no scheduler. |
| **Renderer-only** | All state lives in the renderer. Persistence is `localStorage` plus JSON import/export. |
| **Mock everything** | Runs, costs, timings and analysis results come from a seeded fixture generator, labelled as demo data in the UI. |
| **Real look, fake wiring** | The palette, node forms and diagnostics look and behave like the real thing; they validate against local schemas only. |
| **Visual first** | Where effort must be traded, spend it on the Connectome render and on motion, not on semantics. |

A persistent **Demo data** chip sits in the Flow header and on the Connectome
canvas so no reviewer mistakes the fixtures for live telemetry.

## What ships

1. **Flow editor** — a Flowise/n8n-shaped canvas for composing a procedure out of
   this app's own modes.
2. **Compile (simulated)** — validate → contract → dry run, producing an
   **IQ-cell** card. No execution.
3. **Connectome** — a three.js tractography-style visualization of the IQ-cells in
   the project, plus a generated report.

Anything not in this list is out of scope for the demo, including every runtime,
governance-enforcement and storage behaviour described in the full design.

---

## 1. Flow editor

### Concept

The canvas is not "build an agent from parts" — the app already has the agent.
**The modes are the primitives.** A node is one mode-and-sub-mode invocation. An
edge is a typed hand-off. **Compile** turns the drawing into an **IQ-cell**.

**IQ-cell** is the system name; **IQ** is the short form; **myIQ** is what a user
calls their own. Same object.

### Layout

Flow is a top-level mode, so it owns the window: the icon rail stays, and the
canvas fills everything to the right of it. There is no docked chat panel and no
project navigator — Flow is a builder, not a thread, and a node editor needs
the width. The mode switch and the sub-mode rail are the only way out.

```
┌ Flow header ─ name · state · Demo data · diagnostics · Dry run · Compile ┐
├ Palette ──────┬──────────── Canvas / minimap ────────────┬ Inspector ─────┤
│ Triggers      │                                          │ Properties     │
│ Modes         │      nodes, typed edges, notes            │ Ports          │
│ Modules       │                                          │ Contract       │
│ Control       │                                          │ Dry-run output │
└───────────────┴──────────────────────────────────────────┴────────────────┘
```

Pane sizing follows the parent document's rules: fixed-width palette and
inspector with minimums, elastic canvas, content clipped and scrolled inside its
pane. Visibility controls read **Hide Panel** / **Show Panel**.

### Palette

Six families. Nodes exist as visual+schema definitions only.

- **Triggers** — `Manual`, `Chat command`.
- **Modes** — `Ask` (Chat · Conversation), `Council` (Chat · Team), `Agent task`
  (Co-create · Project), `Author document` (Office), `Generate image`,
  `Research`.
- **IQ sources** — `WorkIQ` (your working context: mail, meetings, chats,
  documents, people), `FoundryIQ` (a Foundry knowledge index or published
  agent), `FabricIQ` (governed business data: ontology, semantic model,
  lakehouse, warehouse), `WebIQ` (the public web through the contained
  browser). Each answers *where did this come from*, so each returns **cited
  chunks** rather than bare text and carries a declared reach that lands in the
  compiled contract's permission manifest.
- **Conversations & files** — `Conversation`, `Document`. The things the work
  actually runs on, placed as blocks rather than hidden in a step's settings:
  an arrow *out* of one says a step read it, an arrow *into* one says a step
  produced it, and double-clicking opens the real conversation or file. Both
  are picked from a list rather than typed, so a block can only name something
  that exists. Neither performs anything — an artifact block never adds a
  permission the manifest did not already have to state, because the write
  belongs to the step that does it.
- **Modules** — `Skill`, `Knowledge query`, `Memory write`.
- **Control** — `Branch`, `Merge`, `IQ-cell node`, `Return`.

**Retired kinds.** The palette used to also carry a generic no-code toolkit —
`Schedule`, `Project watch`, `Mail arrives`, `Meeting ends`, `Model call`,
`Browser fetch`, `HTTP request`, `Graph query`, `File read / write`, `For each`,
`Delay`, `Map` — and none of it was wired to anything. A canvas that offers a
step it cannot perform teaches the reader to distrust every other step on it, so
they were removed rather than left as decoration. `File read / write` was
additionally redundant once `Document` existed: the direction of the arrow
already said which one it was. Drafts live in `localStorage` and outlive the
release that wrote them, so a node of a retired kind still opens — as an inert
"Retired step" card with a `FLOW010` diagnostic asking for it to be replaced or
deleted, never as a blank canvas.

Governance nodes (`Approval gate`, `Budget guard`, `Redact`, `Audit note`) render
as decorative badges on nodes rather than as enforceable behaviour — they are
part of the picture, not part of a policy engine.

**Every kind carries its own `lucide-react` mark**, mapped once in `icons.ts`
and reused by the palette, the canvas card, the inspector and the keyboard
outline, so a node is recognisable by shape and not only by its family colour.
The map is exhaustive by type, and no two kinds within one family share a mark.
Glyphs inherit the family tone through `currentColor` and never carry a hex.

### Ports, types, edges

- **Control edges** — solid, top → bottom, execution order.
- **Data edges** — dashed, side ports, a typed field binding. The editor draws
  the implied ordering edge as a ghost.
- **Attachment sockets** — left edge: `Model`, `Skills[]`, `Tools[]`,
  `Connection`. One chip may feed several nodes.

Arrowheads carry direction; colour is never the sole carrier of meaning.

Types: `Text`, `Markdown`, `Json<schema>`, `FileRef`, `ArtifactRef`,
`ImageRef`, `Chunk[]`, `Citation[]`,
`Report`, `Decision`, `ToolResult`, `MemoryRef`, `ModelRef`, `SkillRef`,
`IqletRef`, `List<T>`.

Coercions are explicit and few — `Markdown → Text`, `ArtifactRef → FileRef`,
`Report → Markdown`, `Decision → Markdown`, `T → List<T>`. Anything else requires
an explicit step; there is no silent stringification.

### Node presentation

- Header strip: family icon (`lucide-react` only), editable label, bound
  capability, status. Colour is a family role token.
- Body: up to three configuration chips, then `+N settings`. Write and external
  actions state their side effect in one plain line.
- Ports: control-in top, control-out bottom, data ports on the sides, attachment
  sockets on the left; 24 px targets, type and required state in the tooltip and
  accessible name.
- Run state: a restrained queued/running animation and a stable success / pause /
  failure state in the same position, driven by the mock dry run.

### Interaction

Drag from the palette, or double-click to add at the viewport centre. Dragging
from a port into blank canvas opens a type-filtered quick-add menu. Incompatible
ports dim while dragging; releasing on one leaves the graph unchanged and names
the expected and actual types. Undo/redo, copy/paste (ids regenerated), delete,
select-all, zoom, zoom-to-fit, focus-selection. Arrow keys move a selection;
`Enter` opens the inspector, `F2` renames, `Escape` clears.

A textual accessibility outline lists the flow summary and then nodes in
topological order with their ports, connections and diagnostics, so the canvas is
usable without a pointer.

### Compile (simulated)

Three visible stages, animated in a stage panel:

1. **Validate** — local checks only: reachable trigger, no cycles, typed edges,
   required props filled, referenced palette entries exist. Diagnostics carry
   severity, a stable code, a plain explanation and click through to the
   offending node or port.
2. **Contract** — generate `<name>.contract.md` from the graph: what it does
   (plain-language step list), what it works from and what it produces (derived
   from which way an artifact block's arrows point), what it touches (a
   permission manifest derived from node kinds), the mock cost estimate, and
   when it runs.
3. **Dry run** — walk the graph against fixture samples with every node stubbed,
   animating each step, producing output shapes and a token estimate.

Compile stops there. It proves the flow is sound; it does not decide that this
version is worth keeping, so it does **not** write to the library. The contract
drawer ends in an explicit **Add to IQ-cell library**, and only that emits an
**IQ-cell card**: name, version, faces, mock last-run, completion rate and cost
per run. Face registration, scheduling and real execution remain out of scope.

The editor header carries a **sample picker** over the bundled templates. Each
instantiates as a wired, valid graph so a first-time reader has something real
to compile; loading one over existing work asks first.

### Persistence

`<name>.flow.json` (graph plus a separate layout section) and the generated
`<name>.contract.md` are held in renderer state, mirrored to `localStorage`, and
importable/exportable as files. The project navigator lists them as if they
were on disk.

---

## 2. Connectome — the demo centrepiece

The Connectome is the parent layer: not what one IQ-cell does, but **what the
whole body of work looks like**. It is a *reading surface* — nothing on it
executes, and no edge is drawn by hand.

### Visual target

The reference is a **DTI white-matter tractography render**: thousands of thin,
directionally colour-coded fibres sweeping between regions, dense in the core and
fanning at the periphery, lit so depth reads as depth.

- **Direction-coded colour**, as in tractography: red for left–right, green for
  anterior–posterior, blue for superior–inferior, interpolated along each fibre.
  Bundle identity modulates saturation on top of this, so the palette stays
  organic rather than categorical.
- **Fibres, not lines.** Each connection is a bundle of 8–40 slightly jittered
  Catmull-Rom curves, so a strong connection reads as a thick tract and a weak
  one as a wisp.
- **Bilateral organic layout.** Seeded force layout in 3D, gently mirrored about
  a central axis and shaped into a rounded hull, giving the familiar brain-like
  silhouette without pretending to be anatomy.
- **Depth cueing.** Fog, depth-modulated opacity and additive blending so the
  interior glows and the surface fibres stay crisp.

### Rendering (three.js)

| Concern | Approach |
|---|---|
| Geometry | Fibres baked into a small number of `LineSegments2` / instanced tube meshes; one draw call per bundle, not per fibre. |
| Colour | Per-vertex colour from the direction encoding; bundle tint applied in the shader. |
| Motion | A shader-driven flow pulse travelling along fibres in the direction of the connection; speed scales with run volume. |
| Camera | Orbit, pan, dolly, zoom-to-fit, zoom-to-selection, and a slow idle auto-rotate that stops on interaction. |
| Selection | GPU picking; the picked fibre bundle brightens while the rest desaturate and dim. |
| Growth | On `Neuroimage`, fibres draw in progressively over ~2 s with an eased reveal, bundle by bundle. |
| Performance | Target 60 fps at ~40 nodes / ~200 connections / ~4,000 fibre curves; degrade fibre count per connection before dropping frame rate. |
| Fallback | If WebGL is unavailable, fall back to the existing 2D graph renderer with a notice. |

Reduced-motion preference disables the pulse, the auto-rotate and the growth
animation; the static render carries the same information.

### Canvas anatomy

- **IQ-cell list (left)** — every IQ-cell in the project with version, faces,
  last run, run volume, completion rate and cost per run. Checkbox per row, with
  select-all and select-by-face in the header.
- **Views (centre)** — one index, two surfaces, switched by a tab strip:
  - **Map** — the three.js tractography render: the shape of the whole body.
    It opens on the same three-quarter view every time, so two readers
    describing "the picture" are describing the same one.
  - **Table** — the exact numbers, sortable and exportable.

  The **map stays mounted** and is hidden rather than unmounted: it owns a WebGL
  context bound to one canvas element, and tearing that element down on a view
  switch leaves a live scene drawing into nothing.
- **Report (right)** — the generated report, section-linked to the view. It
  shares its column with the map's chat, and the column is **closed when the
  surface opens**: the map is the elastic column, and prose beside it is width
  the picture does not get — for a report that is empty until something has
  been analysed.
- **`Analyse` (header)** — the single action: analyse the selection and produce
  the views and report together. Until it is pressed the canvas shows the
  selection and an estimate, not a stale picture.
- **`Compile` (header)** — publishes the finished analysis into the IQ Cell
  library as the cell that answers questions from it, pinned to the graph hash.
  Every other surface that makes something publishes it there; a surface
  missing from that list is work that has to be remembered rather than found.

The map **fits its pane**: the camera frames the extent of what was
actually laid out rather than a fixed distance, and re-fits from a
`ResizeObserver` on the surface — the panes resize far more often than the
window does.

### The time lapse

A connectome is a picture the reader did not draw, so an untouched one is easy
to mistake for decoration. The map therefore **plays a time lapse by
default**: the graph is replayed in the order it came into being, IQ Cells
appearing on the day they were first compiled and couplings on the day they
first carried a run.

This is deliberately *not* a guided tour of the finished graph. A tour asserts
which parts matter, which is a claim the app is not entitled to make on the
reader's behalf. Growth makes no such claim: it shows how the estate arrived at
its present shape, and the parts that turn out to matter are the ones the reader
watches thicken.

- **Play / pause, reset, a scrubber and a reading** sit in a band above the
  view. The reading names what is on screen — how many IQ Cells and couplings of
  the total had run by that point — and the counter says how far back in time it
  is standing, or `now` at the end.
- The lapse **stands down the instant the reader takes over** — a pan, a zoom or
  a pick. The point is to hand the view over, not to hold it.
- The epochs come from the analysis, so they are as deterministic as the graph:
  the same selection always grows the same way.
- Reduced-motion holds the graph at `now`; nothing is hidden from a reader who
  cannot watch it move.

The map is **rendered deterministically by the renderer**. No image model is
involved and none can be.

### What the analysis does (mock)

A seeded, deterministic pipeline over fixture data:

1. **Gather** — contracts, manifests, faces and mock run records for the
   selection.
2. **Edges** — *structural* where one IQ-cell embeds another; *latent* where two
   share artifacts, project paths, external hosts, model deployments,
   connections, run windows or approvers.
3. **Score** — edge strength `0..1` from weighted components; weights are shown
   and adjustable, and changing them re-renders live.
4. **Cluster** — bundles detected and named from what their members share.
5. **Layout** — seeded, so the same selection and weights give the same picture.
6. **Report** — emitted as a project artifact.

### Legend

Stated on the canvas and repeated in the report: **colour** = fibre direction,
tinted by bundle; **thickness** = strength; **solid** = structural, **dashed** =
latent; **saturation** = recency; **node size** = run volume; **node ring** =
completion rate; **badge** = permission reach.

### The report

`<name>.connectome.md`, rendered beside the map, with each section focusing the
corresponding part of the render when selected:

1. **Legend** and **selection / window / weights**.
2. **Shape** — node and edge counts, density, bundles, isolates, longest chain.
3. **Bundles** — name, members, what they share, share of total cost and runs.
4. **Strongest connections** — ranked pairs with strength, contributing
   components and one line on why they are coupled.
5. **Hubs and bridges** — high-degree IQ-cells, and the only paths between
   bundles.
6. **Findings** — typed and citing their edges: redundancy, fragility, cost
   concentration, permission concentration, stale pins, orphans.
7. **Recommended actions** — the concrete next step per finding, linking to the
   responsible IQ-cell. The report never performs an action.

---

## 3. Visual language

Follows the parent document: Fluent structure, role-token architecture, light
theme default, `lucide-react` icons only, no hard-coded hex at any call site.

Flow adds a small token group of its own — node family colours, port type
colours, edge states and the Connectome direction ramp — defined once in
`theme.css` alongside the existing roles and overridden for dark mode by the same
names.

Motion is short, eased and purposeful: node drop, edge attach, diagnostic
appearance, compile stage transitions, dry-run step progression, and the
Connectome reveal and pulse. No animation library beyond what the two render
engines already carry — three.js for the map, React Flow for the graph surfaces.

---

## Implementation shape

Renderer-only, with types shared so a later backend can adopt them unchanged.

| Location | Contents |
|---|---|
| `packages/shared/src/mode.ts` | Add `"flow"` to `SubMode` and to `SUB_MODES_BY_MODE.cocreate` (`mode: "cocreate"`, `requiresProject: true`). |
| `packages/shared/src/flow.ts` | Zod contracts: `FlowNodeKind`, `FlowPortType`, `FlowNode`, `FlowEdge`, `FlowGraph`, `FlowLayout`, `FlowDiagnostic`, `IqletCard`. Shaped like the existing `ResearchRun` / `CouncilRun` contracts. |
| `packages/shared/src/connectome.ts` | `ConnectomeSelection`, `ConnectomeNode`, `ConnectomeEdge`, `ConnectomeBundle`, `ConnectomeWeights`, `ConnectomeFinding`, `ConnectomeReport`. |
| `apps/renderer/src/flow/` | Canvas, palette, inspector, node renderers, validation, contract generation, mock dry run, `localStorage` persistence. |
| `apps/renderer/src/connectome/` | Fixture generator, edge and scoring model, seeded 3D layout, three.js scene, report generation. |
| `tests/` | `flow-graph` (invariants, type checks), `flow-contract` (deterministic output), `connectome-layout` (same seed → same coordinates), `connectome-report`. |

No new IPC channels, no `packages/core` services, no changes to the audit,
permission, scheduler or orchestration paths. If a demo need appears to require
one, cut the need instead.

---

## Build order

1. Sub-mode registration, Flow canvas shell, palette, inspector, pan/zoom,
   selection, keyboard support, `localStorage` persistence — with `Manual`,
   `Ask`, `Author document` and `Branch` only.
2. Typed ports, legal-edge feedback, live diagnostics, structured node forms,
   the full palette.
3. Simulated compile: validate → contract → animated dry run → IQ-cell card.
4. **Connectome**: fixture generator, seeded 3D layout, three.js fibre render,
   selection, camera and the reveal animation.
5. Connectome scoring, bundles, findings and the report, section-linked to the
   map.
6. Polish pass — motion, tokens, fallback, reduced-motion, and demo fixtures for
   a scripted walkthrough.

Steps 1–4 are the demo. Steps 5–6 are what make it convincing.

## Explicit non-goals

- No execution of any kind. No model calls, file writes, mail, Graph, MCP,
  OfficeCLI, browser fetches or scheduled jobs.
- No backend services, IPC channels or persistence outside the renderer.
- No real audit, permission-broker or consent integration — governance appears as
  visual affordances only.
- No IQ-cell faces (Automation, Command, Skill, MCP tool), no publishing, no
  versions-in-use, no run history beyond the mock.
- No code node, no secrets in flow files, no third-party connector catalogue.
- The Connectome map is never generated by an image model.


---

# Divergences from the code

Recorded rather than silently tolerated. Each is either a doc to fix or a piece
of work not yet done, and saying which is the point of the list.

| Where | The document says | The code does | Which is right |
|---|---|---|---|
| Mode naming | "Flow" sub-mode under Co-create; "Connectome" | Top-level mode **IQ Cell** with **IQ Industry**, **IQ Workflow**, **IQ Knowledge**, **IQ Memories**, **My IQ**, **Connectome IQ**, **IQ Cell library** | The code. The document predates the rename. |
| File naming | `<name>.flow.json` | `<name>.iqcell.json` | The code. |
| Knowledge graph | A Co-create surface | An IQ Cell surface. It indexes and answers; it publishes nothing | The code. |
| Memories | A Control Center destination | An IQ Cell destination. Approving and marking only; it publishes nothing | The code. |
| Chat layout | A docked chat panel that persists across destinations | Chat is a single pane; the canvas belongs to Co-create, IQ Cell and Control Center | The code. |
| Sign-in gating | Microsoft deferred to first use (superseded within the document itself) | Both connections required before the app opens | The code, and the document already says so later on. |
| Browser allow-list | An earlier section describes a tenant-policy host allow-list | A deny-list only | The code. The document supersedes itself further down. |
| Screen recording | A Meetings capability, with codec, frame-rate and output-folder settings | Meetings captures audio only; a video becomes a transcript through *Transcribe a file…* | The code. |
| Fabric Data Agent | A field on the Fabric workspace connection | Its own connection, reachable by workspace item id or published URL, asked from **Chat → Data agent** | The code. |
| Models | A Control Center destination | *Connections & access* only. A Foundry deployment is an endpoint plus an identity, which is a connection; two rails onto one registry gave "where do I add a deployment?" two right answers | The code. |
| Control Center | One of four mode segments | A rail destination above *Projects*. The segments name the three ways work is done; governance is the same kind of thing as the bound project and the connections. `TopMode` still has four members | The code. |
| Sample data | Per-surface Load/Clear, each surface its own | One hub and one `samples:*` channel family, with the per-surface controls kept as shortcuts into it. Adds **Sample data** as a Control Center destination | The code. |
| Meeting capture | Renderer `MediaRecorder`, chunks over IPC | The `iq-audio` sidecar writes `audio.wav` directly; no meeting audio crosses the IPC boundary. Costs echo cancellation, which the Record tab states | The code. |
| Mermaid in IQ Industry | A code block's language is stated and the source shown, because laying a figure out means either a dependency or a script in a sandboxed frame | `industry/mermaid.ts` parses the flowchart subset the primers use and `render.tsx` draws it as React SVG elements. Neither horn of that dilemma applies: there is no dependency and no markup string, so nothing to sanitise. Anything outside the subset still falls back to the source. IQ Workflow reuses the same parser for its **Describe your process** import, which is why the two vocabularies have to stay in step | The code. The old reasoning assumed a general renderer; the bundled static flowcharts do not need one. |
| MCP direction | `mcp:*` and the catalog describe servers this app connects to | It also **publishes** one: `myiq:publish` writes a sample-data snapshot that `@iq/myiq-mcp` serves to any MCP client over stdio | The code. |
| Sign-in gate | Offers **Show sample data** beside the two connections | The gate has the two connections and Continue; sample data is a Control Center setting only | The code. |
| IPC contract | "The typed IPC surface" — one contract, described in the singular | Two halves, typed differently. `IPC_REQUEST_SCHEMAS` guards the untrusted direction at run time; `IpcResults` is a *type* map for the trusted one, because main → renderer never needed a guard, it needed a contract. Callers take `IpcRequestInput` (`z.input`), handlers take `IpcRequestArgs` (`z.infer`) | The code. The document was not wrong so much as incomplete: it described the half that existed. |
| Panel modules | `panels.tsx` as one secondary-surface module | Split by importer into `panels/connections.tsx`, `panels/skills.tsx` and `panels/control.tsx`, over a shared `panels/registration.tsx`. Nine exports with two disjoint importers is a filename, not a module | The code. |
| Registration cards | Implied to be one repeated shape | Three genuinely different cards over one shared envelope (`useRegistration`, `FormField`). They speak different channels and hold different status contracts, so a single generic form would be an interface as wide as the three things it hides | The code. Stated here because "unify the three" is the obvious-looking change and it is the wrong one. |
| IQ Workflow | Part 2 describes a Flowise/n8n-shaped runtime canvas: typed ports, coercions, a simulated compile and an animated dry run | A conceptual business-flow modeller on [React Flow](https://reactflow.dev) (`@xyflow/react`, MIT). Seven kinds aligned 1:1 with Mermaid shapes, untyped arrows that carry words, and no execution anywhere. Compile, the contract and the dry run are gone; **Export** replaced them | The code. A canvas that offers a step it cannot perform teaches the reader to distrust every other step on it, and a compile stage promises a runtime that does not exist. |
| Palette | Part 2's palette lists twenty-one kinds across six families | Seven kinds across three families — the process (`start`, `step`, `decision`, `subflow`, `end`), what it handles (`data`), and annotation (`note`). Thirty-four runtime kinds and every port type were retired; a draft holding one opens as an inert "Retired step" card with `FLOW010` | The code. |
| Publishing | Part 2 lists "no publishing, no versions-in-use" as an explicit non-goal | **Publish** on IQ Workflow writes a versioned record into the IQ Cell library. IQ Industry's primers are reconciled in because they ship with the app. My IQ publishes elsewhere — its **Publish** names the IQ, asks whether it is shared, and hands the library and the analysis over it to the MCP server. It files nothing, because a reading of the library is not a member of it | The code. Publishing is what keeps a diagram findable; execution is still out of scope. |
| Execution | Part 2 states "No backend integration", "Renderer-only" and "Mock everything" | Still true of IQ Workflow, My IQ and Connectome IQ, and of nothing else. All three carry `beta: true` and say so on screen | The document, for now. Reversing it is a decision, not a bug fix — [`08-product-ready.md`](08-product-ready.md) states exactly what the reversal costs. |
| Sharing | Part 2 describes no surface for other people's work | **Connectome IQ** organizes an AI-driven company as company → specialized IQ → AI role. The five function IQs are fixtures in `apps/renderer/src/samples/sharedIq.ts`; My IQ publication state is read from the device, nothing is fetched and nothing leaves the device | The code, with the limit stated on the surface. Connectome IQ is a conceptual demo of how specialized IQs compose into a company. |
