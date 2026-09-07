# Manual system test — IQ Cell, My IQ and Connectome IQ

For the parts a script should not pretend to cover: the 3D map, downloads, and
anything that needs a real identity. Work through it in order; each step says
what you should see, so a failure is a difference rather than a feeling.

**Before you start**

```powershell
cd d:\Code\IQ-compiler\iq-compiler
pnpm build
pnpm start
```

Sign in to both connections when the card appears. Do **not** use `IQ_E2E=1` for
this plan — several steps are about what a signed-in app does.

Bind `iq-compiler/sample-data/project` in **Projects** before section 2.

---

## 1. The gate

| # | Do | Expect |
|---|---|---|
| 1.1 | Launch with neither connection made | The sign-in card, not the shell. No icon rail behind it. |
| 1.2 | Read the two lines under the buttons | Each names its own state. A failure names the thing that failed. |
| 1.3 | Click **Edit** next to Tenant ID, type `not a tenant`, click **Sign in to Microsoft (Azure)** | A field error naming the accepted formats. No sign-in is attempted. |
| 1.4 | Clear the field, sign in to Azure only | Continue stays disabled. The Azure line goes green; the Copilot line does not. |
| 1.5 | Sign in to GitHub Copilot | Continue enables. |
| 1.6 | Click **Continue** | The shell opens. No harness banner. |
| 1.7 | Look at the three full-width buttons on the card | Every label is centred, not pressed against the left edge. |

---

## 2. IQ Cell → IQ Workflow

Nothing on this canvas runs. It is a notation for describing how work happens,
so every check below is about whether the picture is right and whether it can
leave the app.

| # | Do | Expect |
|---|---|---|
| 2.1 | Open the **IQ Cell** mode segment | The rail shows **My IQ**, then a horizontal rule, then **IQ Industry**, **IQ Workflow**, **IQ Knowledge**, **IQ Memories** and **IQ Cell library** — no *Surfaces* or *Conversations* headings. The words "Flow" and "Connectome" appear nowhere. |
| 2.2 | Open **IQ Workflow** | An empty canvas named `Untitled diagram`, and a prompt on it: *Start with a Start*. |
| 2.3 | Read the palette | Seven kinds in three groups. **The process**: Start, Step, Decision, Subflow, End. **What it handles**: Data. **Annotation**: Note. Nothing that used to execute — no Schedule, no Model call, no HTTP request. |
| 2.4 | Choose **Samples… → Purchase request** | A diagram appears: a stadium at the top, boxes for the work, a diamond for the branch. Every arrow out of the diamond carries an answer. |
| 2.5 | Choose another sample | You are asked before the canvas is replaced. |
| 2.6 | Drag a node | It moves. The source hash in the header does **not** change — layout is cosmetic. |
| 2.7 | Drag a **Step** from the palette onto the canvas | It lands under the cursor, not with a corner at it. |
| 2.8 | Drag from a node's handle onto **another node's handle** | An arrow appears. Try it from every side: each of the four handles is both an exit and an entry, so a loop can go back up the left of the page. Release on the body rather than a handle and nothing is drawn — the drop has to land within about 20px of a handle. |
| 2.9 | Try to connect a node to itself | Refused. |
| 2.10 | Connect the same two nodes twice | Refused — they are already connected. |
| 2.11 | With the new arrow still selected, type `Approved` into **Arrow label** | The word sits on the arrow. Double-clicking the arrow opens the same field on the canvas. |
| 2.12 | Double-click a node | Its name opens for editing in place. |
| 2.13 | Select a **Step** and read the inspector | **Who does it**, **In which system**, **How long it takes** and **Notes**. Owner and system are fields on the step, not separate nodes and not lanes. |
| 2.14 | Delete the Start | The header pill turns **INVALID** and the Checks tab says *A flow needs a Start*. |
| 2.15 | Undo | The Start comes back and the pill returns to **DRAFT** or **COMPLETE**. |
| 2.16 | Add a Decision with only one arrow leaving it | A warning, not an error: a branch with one way out is not a branch. |
| 2.17 | Add a Note and attach it with an arrow | The note is drawn dashed, and it is **not** in the exported Mermaid. |
| 2.18 | Open the **Export** tab | Mermaid, opening `flowchart TD`. Stadiums as `([ ])`, boxes as `[ ]`, diamonds as `{ }`, subroutines as `[[ ]]`, rounds as `( )`. Labels are quoted. No `subgraph`, no `classDef`, no styling. |
| 2.19 | Click **Copy Mermaid**, then paste it into an **IQ Industry** primer | The existing Mermaid renderer draws the same diagram. This is the whole point of aligning the vocabulary to Mermaid shapes. |
| 2.20 | Click **Download .md**, then **Download .svg** | A readable description and a picture that can be dropped into a deck. The SVG shows what was on screen, not a picture positioned by a transform the file does not carry. |
| 2.21 | Type *a supplier submits a part, quality approves it or sends it back* into **Describe your process** and press Enter | A diagram is drawn from the answer. The canvas you were on is **not** overwritten — the result lands as a new draft and the previous one is still in the list. |
| 2.22 | Do the same with a request the model cannot turn into a flowchart | The canvas is unchanged and the Export tab shows the raw reply under *What the agent said*. Half a diagram would assert a process nobody described. |
| 2.23 | Click **Publish** | A notice reads *Recorded &lt;name&gt; v1 in the IQ Cell library*. |
| 2.24 | Deselect, look at the inspector | The published cell is listed with its version. |
| 2.25 | Click **Export** in the inspector | A save dialog offers `<name>.iqcell.json`. Save it. |
| 2.26 | Click **New**, then **Import**, and choose the file you just saved | The same diagram returns, with the same node positions. |
| 2.27 | Import `sample-data/iq-cells/incident-postmortem-decision-pack.iqcell.json` | Eleven nodes, named `Incident postmortem decision pack`. Every card is one of the seven kinds — no dotted "retired" wrapper anywhere. |
| 2.28 | Import the other two bundles in `sample-data/iq-cells/` | Nine nodes each, same result. |
| 2.29 | Click **Clear** | You are asked first. The diagram keeps its id and name — clearing is *start this one over*, not *start a different one*. |
| 2.30 | Restart the app and return to IQ Workflow | Saved diagrams and the published library are still there. |

---

## 2b. IQ Cell → IQ Cell library

| # | Do | Expect |
|---|---|---|
| 2b.1 | Open **IQ Cell library** on a fresh profile | Every IQ Cell My IQ shows is already there — the two counts match — with a notice saying they were added and will not come back if removed. |
| 2b.1a | Delete one, then restart the app | It stays deleted. |
| 2b.1b | Read the header | No origin filter row. This library is IQ Workflow's — the rail says **IQ Cell library (Workflow)** — and every row's chip reads **IQ Workflow**. |
| 2b.1c | Look at any row | A chip naming the surface it was recorded on. |
| 2b.1d | Click a cell's name | Its diagram opens on the IQ Workflow canvas. |
| 2b.1e | In **My IQ**, click the pencil on an **IQ Industry** row | **IQ Industry** opens, not the canvas. A record that ships with the app is not a diagram anyone drew. |
| 2b.1f | Do the same on a **My IQ** row | **My IQ** opens. |
| 2b.1g | Do the same on an **IQ Workflow** row | The diagram opens on the canvas, rebuilt from the cell's declarations, and the surface says so. |
| 2b.2 | Publish something from IQ Workflow, then return | The cell is listed, with the diagram it was published from named under it, filed under IQ Workflow. |
| 2b.3 | Type part of a name into the search field | The list narrows. An unmatched search says so rather than showing an empty pane. |
| 2b.4 | Click the pencil, rename, press Enter | The name changes. The version, hash and published time do **not**. |
| 2b.5 | Press Escape mid-rename | The edit is abandoned, not committed half-typed. |
| 2b.6 | Click the cell's name | IQ Workflow opens on the diagram it was published from. |
| 2b.7 | Click the bin | You are asked first, and the message says the diagram is kept. |
| 2b.8 | Confirm, then open IQ Workflow | The record is gone; the diagram is still under Saved diagrams. |

---

## 2c. IQ Cell → IQ Knowledge

The graph is a consequence of Markdown files, so there is nothing to look at
until some exist. On a fresh profile no vault is chosen and the project
fallback is empty. Start with **Load samples** in the vault card.

| # | Do | Expect |
|---|---|---|
| 2c.0 | Open **IQ Knowledge** on a fresh profile | Empty, with **Load samples** in the vault card and **load the sample vault** offered where the graph would be. |
| 2c.0a | Click **Load samples** | The card reads **Sample vault** and names a path under the app's own `samples/knowledge-vault`. A notice reports the note count. The summary line reads roughly *220 documents · 30 tags · 1301 links*. |
| 2c.0b | Open one of those files in an editor | Ordinary Obsidian Markdown: `title`/`aliases`/`tags`/`category` frontmatter, a `> [!abstract]` callout, a `## Connected concepts` list, and `[[wikilinks]]` inside the prose — not a heading and a bullet list. |
| 2c.0c | Switch to **Table** and sort by degree | The hubs are systems and programmes, not part records. Density comes from the node count. |
| 2c.0d | Look for `missing` nodes | There are none: every link the sample vault writes resolves, including `[[R48]]`, which lands on **UN R48 lighting** through a frontmatter alias. |
| 2c.0e | Read the right-hand **Files** panel | The Markdown the graph was built from, grouped by folder, with a count. 220 files across 11 folders for the sample vault. |
| 2c.0f | Type `standards` into its filter | Only `standards/` remains. Clearing the filter brings the rest back. |
| 2c.0g | Click a file name | That note is selected: the graph highlights it and the detail card below shows its frontmatter tags, its links, and its text. |
| 2c.0h | Click the file icon beside a name | The file opens in the project navigator. The panel is an inventory, not a third file browser. |
| 2c.0i | Click **Clear samples** | The card goes back to **Project (no vault chosen)**, the graph empties and the **Files** panel is empty. The directory is gone from disk. Nothing outside the app's own `samples/` was touched. |
| 2c.0j | Choose a vault of your own, then look for **Clear samples** | It is not offered — it appears only while the sample vault is the one being indexed. |
| 2c.1 | Look for **Knowledge** in Co-create | It is not there. **IQ Knowledge** lives under IQ Cell, directly below IQ Workflow. |
| 2c.2 | Open **IQ Knowledge** | The graph and the vault card, as before. |
| 2c.2a | Look at the graph | One neutral colour for every node, sized by how many things link to it, thin faint links, and labels only on the hubs — not a wall of text. No colour legend, because the picture no longer encodes colour. |
| 2c.2b | Hover a node | It and everything it links to stay lit; the rest recedes. Their labels appear. |
| 2c.3 | Look for a **Compile** button | There is none. IQ Knowledge indexes and answers; an IQ Cell is a business flow somebody drew, and a surface that quietly produced one as a side effect of indexing was filing a record nobody asked for. |
| 2c.4 | Open **IQ Cell library** | No cell was added by indexing. |

---

## 2d. IQ Cell → IQ Memories

The memory store is app-wide, not part of the bound project, so loading the
sample project brings no memories with it. Start by clicking **Load samples**
in the pane header: ten records, two pending, seven approved, one rejected.

| # | Do | Expect |
|---|---|---|
| 2d.0 | Open **IQ Memories** on a fresh profile | Empty, with **load the sample memories** offered in the empty state and **Load samples** in the header. |
| 2d.0a | Click **Load samples** | **Awaiting your review (2)** — one `project`, one `user` — then a settled list of seven approved and one rejected, **0 of 7 selected**, and a notice saying the settled ones record their decider as `sample-data`. |
| 2d.0b | Look at the header | **Load samples** has been replaced by **Clear samples**. Nothing was duplicated. |
| 2d.0c | Click **Clear samples** | All ten go, and the empty state returns. Anything the assistant proposed itself is untouched. |
| 2d.1 | Look for **IQ Memories** in Control Center | It is not there. It lives under IQ Cell. |
| 2d.2 | Open **IQ Memories** under IQ Cell | The pending queue and the settled list, as before. |
| 2d.3 | Find a **pending** memory | It has Approve and Reject, and nothing else. |
| 2d.3a | Click **Approve** while signed out | It refuses: approval must be attributable to a person. This is why eight samples arrive settled. |
| 2d.4 | Look for a **Compile** button and per-row tick boxes | Neither is there. Publishing an IQ Cell from a set of memories is gone — an IQ Cell is a business flow somebody drew, not a bundle of facts. |
| 2d.5 | From **My IQ**, open a cell that names memories | IQ Memories opens with those rows **marked**, and a line saying how many and why. Marking is what is left of the old tick boxes, and it is the part that was always answering the reader's question: which memories is this cell about. |
| 2d.6 | Click **Clear** beside that line | The marks go. Nothing else changes. |
| 2d.7 | Read **Turned into skill proposals** | Approved memories about one subject become a `learned-` skill proposal once there are enough of them. Review it in Skills; nothing installs itself. |
| 2d.8 | **Forget** a sample, then reload the pane | It stays gone. |

---

## 3. IQ Cell → My IQ

### 3.1 The library

| # | Do | Expect |
|---|---|---|
| 3.1.1 | Open **My IQ** | The header reads **My IQ**, with *Your knowledge, intelligence, and workflows.* beside it. |
| 3.1.2 | Read the IQ Cell list | Software-delivery names: release status, audit controls, dependency upgrades, pipeline failures, support tickets. No generic office tasks. |
| 3.1.3 | Click **None** | **Analyse** disables — fewer than two cells cannot be compared. |
| 3.1.4 | Click **All**, then **Analyse** | A hash appears in the header and the map draws. |
| 3.1.5 | Note the hash, click **Analyse** again | The same hash. The same selection always gives the same picture. |
| 3.1.6 | Watch the map for ten seconds without touching anything | **Nothing moves.** No growth, no drift, no firing, and the tour does not start. |
| 3.1.7 | Press the play control in the header | The traffic animates. Press it again and the picture goes still. |
| 3.1.8 | Click the pencil on a row | IQ Workflow opens with that IQ Cell's draft, and a notice says it was rebuilt from what the cell declares rather than loaded from a stored source. |
| 3.1.8a | Open the pencil on several different rows in turn | Each draws a **different shape** — the sources, skills and writes each cell declares, fanned out. Not the same two columns every time. |
| 3.1.9 | Return to My IQ and open a different row's pencil | IQ Workflow swaps to the new draft, even though its tab was already open. |

### 3.1b Asking the map

| # | Do | Expect |
|---|---|---|
| 3.1b.1 | Click **Chat** beside My IQ | The right-hand column switches from Report to Chat. The map keeps its width. |
| 3.1b.2 | Click a suggested question | An answer, with chips naming what it read. |
| 3.1b.3 | Click a chip | That IQ Cell or connection is selected and the camera moves to it. |
| 3.1b.4 | Type the name of an IQ Cell | Its runs, completion, cost, reach, group and strongest connection. |
| 3.1b.5 | Ask something it cannot answer, e.g. "what should I build next" | It says what it can answer and that no model is asked — it does not invent one. |
| 3.1b.6 | Click **Analyse** again | The log clears, because the old answers described a graph that no longer exists. |
| 3.1b.7 | Click **Report** | The report is back, unchanged. |

### 3.2 The map — the part a script cannot do honestly

| # | Do | Expect |
|---|---|---|
| 3.2.1 | Drag on the map | It orbits. Nothing jumps. |
| 3.2.2 | Scroll | It zooms toward the pointer, not toward the centre. |
| 3.2.3 | Click **Zoom to fit** | The whole graph is in frame. |
| 3.2.4 | **Click a sphere** | It highlights, the report pane names it, **and the details dialog opens.** |
| 3.2.5 | Read the dialog | The name, the group, runs, completion, tokens per run, last run, approver, version — the things a sphere cannot show. |
| 3.2.6 | Read **Reach**, **Writes**, **Reads**, **Project paths**, **Hosts**, **Configuration** | Each is either listed or explicitly says there is none. Nothing is silently blank. |
| 3.2.7 | Read **Strongest connections** | Each row names the other cell, a strength, and whether the edge is **declared** or **inferred** with its reason. An inferred edge must never read as a fact. |
| 3.2.8 | Click a connection | The dialog closes and the report pane explains that edge. |
| 3.2.9 | Click a sphere, then press **Escape** | The dialog closes. The node stays selected. |
| 3.2.10 | Click **Details** in the report card | The dialog opens again on the same node. |
| 3.2.11 | Click the dimmed area outside the dialog | It closes. |
| 3.2.12 | Click a fibre between two spheres | The connection is explained, and no details dialog opens. |
| 3.2.13 | Click **Replay the reveal** | The graph draws in again from nothing. |

### 3.3 The tour

| # | Do | Expect |
|---|---|---|
| 3.3.1 | Press play on the tour bar | It walks the stops, moving the camera and naming what you are looking at. |
| 3.3.2 | Switch to **Table** mid-tour and back | The tour keeps its place rather than restarting. |
| 3.3.3 | Confirm the details dialog did **not** open at any stop | The tour explains; it does not interrupt. |

### 3.4 Table

| # | Do | Expect |
|---|---|---|
| 3.4.1 | **Table** → click a row | The report explains that connection. No details dialog opens. |
| 3.4.2 | Table → check the sort | Strongest first. |

### 3.5 Weights, export and panes

| # | Do | Expect |
|---|---|---|
| 3.5.1 | Change a signal weight and re-analyse | The picture changes, the hash changes, and the new weights are reflected in the report. |
| 3.5.2 | Click **Export** | A save dialog offers `neural-connectome-<hash>.md`. |
| 3.5.3 | Open the saved file | The first line reads `# My IQ — N IQ Cells`, and the weights used are printed in it. |
| 3.5.4 | Drag the divider between the list and the map | Only those two change width. Neither collapses. |
| 3.5.5 | Drag the divider between the map and the report | Same. |
| 3.5.6 | Narrow the window until it cannot fit | Panes collapse by priority rather than all three being squeezed below their minimum. |
| 3.5.7 | Widen a long IQ Cell name's pane, then narrow it | The name scrolls or truncates inside its pane; it never pushes the pane wider. |

### 3.6 Publishing My IQ

| # | Do | Expect |
|---|---|---|
| 3.6.1 | Before analysing, hover **Publish** | Disabled, with a reason: a snapshot of an analysis that has not run is a record of nothing. |
| 3.6.2 | Analyse, then click **Publish** | A dialog asks for a name. It is pre-filled with *My IQ*, selected, and **Share this IQ in Connectome IQ** is ticked. |
| 3.6.3 | Clear the name | **Publish** disables. An IQ nobody can name is an IQ nobody can find. |
| 3.6.4 | Type a name and press Enter | The dialog closes and a notice reads *<name> is published: N IQ Cells and the analysis of N. It is listed in Connectome IQ as shared.* |
| 3.6.5 | Wait a couple of seconds | A second, separate dialog says *<name> is published over MCP* and hands over the client configuration to copy. |
| 3.6.6 | Publish again with the tick cleared | The notice ends *It is not shared with anyone.* The IQ still serves over MCP — sharing governs the hub listing, not the server. |
| 3.6.7 | Open the **IQ Cell library** | **Nothing new.** Publishing here hands the library to the MCP server; it does not add to it. An IQ Cell is a diagram somebody drew, and a coupling analysis is a reading of the library, not a member of it. |

### 3.7 Connectome IQ

The company chart is a conceptual demo. Its specialized IQs and AI roles are
fixture data; only the My IQ publication state in the root is real. Nothing on
it starts a process — checks below are about whether it reads truthfully, not
whether it connects.

| # | Do | Expect |
|---|---|---|
| 3.7.1 | Open the **Connectome IQ** mode segment | It is a segment of its own in the mode switch, directly after **IQ Cell**, and carries a **Beta** chip. |
| 3.7.2 | Read the header | **Connectome IQ**, *How an AI-driven company organizes specialized IQ*, with a beta chip. |
| 3.7.3 | Read the chart from the top | The **IQ Contoso** root reports specialized IQs, AI roles and functions in context. A line branches to the five business functions. |
| 3.7.4 | Read one function | It is labelled **Specialized IQ** and names the team, human sponsor, purpose, AI-role count and run count. |
| 3.7.5 | Press **Show roles** | The function expands into three connected **AI role** cards. Each names the IQ Cell and what it does. |
| 3.7.6 | Press **Show all AI roles**, then **Hide all AI roles** | All fifteen roles appear, then every role is hidden. The company and specialized IQs stay visible. |
| 3.7.7 | Click an AI role | The detail panel opens with that role's purpose, runs, completion, version, approver and declared reach. |
| 3.7.8 | Read the company root before publishing anything | It says to publish My IQ to supply shared company context and offers **Open My IQ**. |
| 3.7.9 | Publish from **My IQ**, then return | The root names the published IQ as the source of shared company context. |
| 3.7.10 | Press **Add to context** on a function | The function takes an accent rail, the button reads **In company context**, and the header counts it. |
| 3.7.11 | Add three more functions | All four stay in context. The header reads **4 in company context**. |
| 3.7.12 | Read the **Connect over MCP** card | One client configuration holding four servers, one chip per server id, each pointed at its own owner's IQ home. |
| 3.7.13 | Press **In company context** again | The function leaves the context. The configuration drops that server and the console transcript clears. |
| 3.7.14 | Press **Connect all** | Every specialized IQ is in company context and the button goes away. |
| 3.7.15 | Remove every function from context | The MCP card says no specialized IQ is in company context, the console explains how to add one, and Ask, Call and both chat buttons are disabled. |
| 3.7.16 | Press **Add them in MCP servers** | Control Center → MCP servers opens. Nothing has been added or granted. |
| 3.7.17 | Press **Set this up in chat** with several connected | The conversation opens with the request in the composer, unsent: every IQ's name, the multi-server configuration and the tool names. Nothing was sent. |
| 3.7.18 | Type a question into **Ask these N IQs** and press Ask | One transcript entry: your question once, then one reply per connected IQ, each labelled with its server id and the `myiq_*` call it was routed to. |
| 3.7.19 | Ask each of the openers offered under the empty console | Every IQ answers every opener from its own fixture, and every answer says it is sample data. |
| 3.7.20 | Pick each of the five tools under **Or call a tool directly** and press Call | All five run on every connected IQ, and every answer says it is sample data. |
| 3.7.21 | Read the disclaimer in the panel's first card | It says plainly that the specialized IQ is a worked example, the human sponsor stays accountable, and nothing is copied into the library. |

---

## 4. Accessibility and theme

| # | Do | Expect |
|---|---|---|
| 4.1 | Tab through the My IQ header | Every control is reachable and named. Icon-only buttons announce a name, not "button". |
| 4.2 | Open the details dialog with the keyboard | Focus lands on **Close details**. |
| 4.3 | Tab inside the open dialog | Focus stays in it. |
| 4.4 | Switch to the dark theme and repeat 3.1.4 | Same layout, same legibility. Light remains the default on a fresh profile. |
| 4.5 | Look for the word "Collapse" anywhere in the UI | It must not appear. Pane controls read **Hide Panel** / **Show Panel**. |
| 4.6 | Launch on a fresh profile and look at the rail | A 56px strip of icons. The mode switch, the destinations and the bottom group are all in it. |
| 4.7 | Hover each icon in the strip | Every one names itself in a tooltip. Nothing is unlabelled. |
| 4.8 | In the bottom group, click **Show Panel** | The rail widens to 248px and every entry gains its label and its one-line detail. Nothing else appears or leaves. |
| 4.9 | Click **Hide Panel** | Back to the strip. The control is in the same row it left from. Nothing floats over the workbench. |
| 4.10 | Show the panel, restart the app | It is still 248px. The choice is remembered either way. |
| 4.11 | In Chat, click **History** in the bottom group | A 300px panel opens beside the rail, over the work. It carries Conversations, Councils, Data agent and Unattended, each heading showing its count. |
| 4.12 | With the panel open, click a rail destination | It works. The panel has no scrim and stays open. |
| 4.13 | Double-click a conversation row in the panel | It becomes an editable field. Renaming from a panel that closed on the first click would be impossible. |
| 4.14 | Type into **Search conversations** | Rows filter as you type across all four groups. A group with no match disappears. No match at all reads "Nothing matches ...". |
| 4.15 | Press Escape, or click the close button | The panel goes away. |
| 4.16 | Go to IQ Cell or Control Center | There is no **History** control. Neither mode holds a conversation. |

---

## 5. The identity boundary

| # | Do | Expect |
|---|---|---|
| 5.1 | Relaunch with `IQ_E2E=1` set | The shell opens without the card, and a banner says the gate was skipped and no identity is held. |
| 5.2 | With the banner showing, open **Connections & access** | Both connections read as not connected. |
| 5.3 | With the banner showing, try a Foundry-backed surface | It refuses and says what is missing. It does not fail mid-turn with an opaque error. |
| 5.4 | With the banner showing, use IQ Cell → IQ Workflow and My IQ | Both work fully. They need no identity, which is the point. |
| 5.5 | Relaunch without the flag | The card is back and the banner is gone. |

---

## 6. Meeting Recordings — recording

The automated spec covers the *refused* states, because those need no identity.
This section is the other half: the states only a signed-in machine with a
Speech resource or a Whisper model can reach.

| # | Do | Expect |
|---|---|---|
| 6.1 | Open **Co-create → Meeting Recordings** signed in, with neither engine ready | The recorder bar still shows **Ready 00:00** and a record button. The button is disabled and its tooltip names what is missing. The form below it is intact. |
| 6.2 | Register a Speech resource in **Connections & access**, return to Meeting Recordings | The blocking notice goes. The record button is still disabled — a title and the consent tick are still required — and its tooltip now says which. |
| 6.3 | Name the meeting and tick the consent box | The record button enables. |
| 6.4 | Click it | The label goes **Starting**, then **Recording**; the dot turns red with a halo, the timer runs, and an **On air** pill appears. The engine picker and the source ticks go disabled. |
| 6.5 | Scroll the Record tab while recording | The recorder bar stays pinned at the top. The stop control never scrolls away. |
| 6.6 | Click the same button again | **Saving**, then back to **Ready**. The surface moves to **History** with the new meeting expanded, showing its transcript. |
| 6.7 | Leave Meeting Recordings, restart the app, open **History** | Every past meeting is listed with its status, engine, duration, segment count and consent. Opening one shows its transcript and its notes. |
| 6.8 | Look for a **Screen** tab | There is none. Meeting Recordings captures audio; a screen recording made elsewhere becomes a transcript through **Transcribe a file…**. |
| 6.9 | Tick **System audio (other participants)** and record a call | **Known defect.** The renderer cannot capture desktop audio on Windows, so only the microphone lands. `native/iq-audio` exists to fix this and is not yet wired in. |

---

## 7. Fabric and the Data agent

Needs a tenant with a Fabric workspace, and a published Data Agent for §7.2.

| # | Do | Expect |
|---|---|---|
| 7.1 | **Connections & access → Microsoft Fabric** | A workspace id and nothing else. No Data Agent URL field, and no key field. |
| 7.2 | **Fabric Data Agent → Connect a Data Agent → Its id in a Fabric workspace** | Two fields: the agent's GUID, and an optional workspace id explained as "leave blank to use the registered Fabric workspace". |
| 7.3 | Save, then click **Test with a question** | The agent answers. The test is a real question on purpose — a probe that only resolved DNS would call an agent reachable whose thread route rejects the token. |
| 7.4 | Switch the connection to **A published Data Agent URL** and paste one | Reachable the same way, with no Fabric workspace registered at all. |
| 7.5 | Remove the Fabric workspace, keep a workspace-mode Data Agent | The Data Agent card reads **needs a workspace** and says so — not "not connected". |
| 7.6 | **Chat → Data agent**, ask a question | The answer arrives whole (it polls, it does not stream), and the tool calls the agent ran are listed beneath it. |
| 7.7 | Look at the rail | A **Data agent** heading lists the conversation, titled by its first question, with the number of questions in it. Clicking a row opens it. |
| 7.8 | Open the chevron beside **New conversation** | **Data agent** is offered last, below a separator. Picking it lands on the surface with an empty conversation and a new thread id. |
| 7.9 | Ask a question, restart the app, click the rail row | The whole transcript comes back, questions and answers, in order. |
| 7.10 | Delete the row from the rail | It goes and does not return. The Data Agent's own thread is not claimed to be deleted. |
| 7.11 | Open **Skills** | A **Microsoft Fabric skill pack** card names the resolved bundle, its version and its source, and lists the skills, agents and shared references. |
| 7.12 | Uninstall the bundle and reopen Skills | The card says what is missing and how to get it. A Fabric run is refused rather than guessed at. |

---

## 8. MCP servers

| # | Do | Expect |
|---|---|---|
| 8.1 | Open **MCP servers** on a fresh profile | **Power BI modeling** is listed, `off`, `never inspected`. Registering is not connecting. |
| 8.2 | Click **Inspect** | It launches. **Known defect, upstream:** `@microsoft/powerbi-modeling-mcp` calls `Console.ReadKey()` on start-up, which throws when stdin is piped — as every MCP client pipes it. The error shown is the server's own. |
| 8.3 | Remove it and restart the app | It does **not** come back. Seeding happens once and the removal is recorded. |
| 8.4 | Add **MarkItDown** from the catalog on a machine with `uv` installed, inspect it | It lists `convert_to_markdown`. Nothing is callable until the tool is approved *and* the server enabled. |



