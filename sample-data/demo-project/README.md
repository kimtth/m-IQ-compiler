# Demo project

What to bind when you want IQ Knowledge and IQ Memories to have something real
to work on. Everything in it is invented and uses plain terms that do not need
industry knowledge.

```
demo-project/
  knowledge/     111 Obsidian-style notes — the vault
```

Both surfaces can also load their samples from inside the app, without going
near this directory: **IQ Knowledge → Load samples** and
**IQ Cell → IQ Memories → Load samples**. Each has a **Clear samples** beside
it, because trying a demo must not be a one-way change to your own data.

## The vault

Bind it in **IQ Knowledge** → *Choose vault…* and point at
`sample-data/demo-project/knowledge` — or press **Load samples**, which writes
the same notes into the app's own `samples/knowledge-vault` directory and
indexes them. This copy exists so the vault can be opened in Obsidian and read
as plain Markdown without launching anything.

### The notes are the point

A knowledge graph is not a drawing. It is a *consequence* of how Markdown files
are written, and these notes are written the way a real Obsidian vault is:

```markdown
---
title: "Project team"
aliases:
  - "Project group"
tags:
  - team
  - people
category: "Teams"
---

# Project team

> [!abstract] Reference note
> What the project team owns and how it works with the rest of the organisation.

## Connected concepts

- [[Planning]]
- [[Customer portal]]

---

## Purpose

The project team leads [[Planning|planning]] for [[Customer portal|customer portal]].

## Working agreement

The team follows [[Change naming|change naming]] and records decisions where everyone can find them.
```

Every part of that does something to the graph, and between them the notes
exercise the whole grammar in `packages/core/src/knowledge/indexer.ts`:

| Written | What the index does with it |
|---|---|
| `tags:` in frontmatter | A `#tag` node, and a `tagged` edge to it. |
| `aliases:` in frontmatter | A second name the note can be linked *by* — which is why `[[Project group]]` lands on **Project team**. |
| `[[Target]]` | A `links` edge. |
| `[[Target\|label]]` | The same edge, read as prose. |
| `[../processes/x.md](..)` | A relative Markdown link, resolved by path or by file name. |
| An unresolved link | A `missing` node, exactly as Obsidian shows one. This vault has none. |

An earlier version of this vault emitted a heading, a line of hashtags and a
bullet list. It produced the same graph and taught a reader nothing about where
a graph comes from.

### Why it is generated

What the graph has to demonstrate is **density** — a graph is only worth looking
at when there is a shape to see, and a shape needs several hundred links.
Hand-writing that produces either a dozen notes with three links each, which
draws as a scattering of dots, or a mass nobody can keep consistent. The
generator is seeded, so the same vault comes out every time and the picture you
learn to recognise does not rearrange itself.

Density comes from the **node count, not from the links per note**. That
distinction is the whole thing: an early version had 112 notes with nine links
each, and a force layout given fifteen attractions per node has nothing to do
but collapse — it drew as one black disc. The vault now has more notes carrying
three or four links each, which is what produces a picture with a shape in it.

graph being ten disconnected clusters.
The structure supplies the links without padding them. A project connects its
teams, work areas, processes and guidance. Those are real relations, and they
cross sections, which is what stops the graph being disconnected clusters.

| Section | What it is |
|---|---|
| `teams/` | People who own work. |
| `workstreams/` | Shared areas of work. |
| `processes/` | Repeatable steps. |
| `policies/` | Plain guidance. |
| `tools/` | Places where work is recorded. |
| `partners/` | External working relationships. |
| `projects/` | Goals, decisions and open work. |
| `issues/` | Problems that need a next step. |
| `people/` | Named owners. |
| `records/` | A work-area record for each project. |

The generated vault has 109 notes across these sections. It has enough links to
make a useful graph while staying quick to open.

The notes themselves are defined once, in
[`packages/core/src/samples/vault.ts`](../../packages/core/src/samples/vault.ts),
because the app writes the same vault when you press **Load samples** and two
copies of a generated corpus drift the first time either is edited. To change it,
edit that file and re-run the writer:

```powershell
pnpm run deps
node sample-data/generate-vault.mjs
```

## Memories

Open **IQ Cell → IQ Memories** and click **Load samples**. Nine records appear.

There is no file to copy, and nothing here to load — the set lives in privileged
code at `packages/core/src/memory/samples.ts`, because a general import path
would let the UI, or an agent driving it, write memory content of its own
choosing. The button asks for *that* set and can say nothing else.

**A memory is not a project artifact.** It lives in the app's own data
directory, not in the bound project — `<IQ_HOME>/memories/memories.json`,
where `IQ_HOME` defaults to `~/.iq-compiler`. Like the knowledge vault, the
store is app-wide rather than per-project. That is why loading the sample
project brings no memories with it, and why this needs its own button.

### Why only two are pending

Two arrive as `pending`, six as `approved`, one as `rejected`.

A memory has no effect until a person approves it, and nothing compiled from one
becomes active without a second approval in Skills. That double gate is the
feature — so a set that arrived entirely pre-approved would skip the one step it
exists to show. But a long queue is not a demonstration of review either; it is
a chore, and the first thing anyone does with one is stop reading it. Two is
enough to show the step, and they are deliberately one `project` and one
`user`, so the scope pill is not a control the demo never exercises.

The settled eight are there because real approval needs an Entra sign-in, and a
demo that cannot reach Compile without one shows nothing. They record their
decider as `sample-data`: no person decided them, and the audit trail should not
imply one did.

### What it demonstrates

| Step | What you see |
|---|---|
| Click **Load samples** | **Awaiting your review (2)**, each with its rationale and its citation, above six approved and one rejected. |
| Click it again | Nothing is added. The ids are fixed, so it never disturbs what you have since approved or forgotten. |
| Tick one, **Compile** | `Apply: <subject>` published to the IQ Cell library under the **IQ Memories** filter. |
| Tick three, **Compile** | One cell applying all three, whose prompt lists every convention and tells the model to name conflicts rather than pick one. |
| Compile the same set again | **v2 of one cell**, not a second v1. Identity is the set, not the click. |
| Compile a different set | A separate cell. One store, many cells. |
| **Forget** one | It is gone, and stays gone until you load the samples again. |
| **Clear samples** | All ten go. Anything the assistant proposed stays — the filter is the fixed `mem_sample_` id prefix, which `record` never mints. |

Three of the approved subjects match the IQ Memories cells the Neural
Connectome's demo library names, so the library and the store describe the same
conventions rather than two unrelated inventions. Every citation points at a
note that exists under `knowledge/`, which
[`tests/sample-vault.test.ts`](../../tests/sample-vault.test.ts) checks.
