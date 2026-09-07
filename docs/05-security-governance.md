# Security, governance, observability and retry

## Least privilege

Identity, consent and per-call policy limit access. Skill declarations describe
intent but are not an additional runtime permission boundary.

1. **Identity.** The app has **no registration of its own** — no `client_id`, no
   configured `tenant_id`, no secret. Microsoft identity is borrowed from the
   Azure CLI's first-party public client, with delegated permissions only. The
  Azure resource access is bounded by that user's permissions. Work IQ MCP
  manages its own Microsoft 365 identity.
2. **Consent.** Azure resource capabilities are recorded at first use and checked
  against denied scopes. Work IQ uses separate server consent and per-tool MCP
  approval; the desktop has no direct Graph mail tools.
3. **Policy.** Every tool declares a family and a risk class. Policy is
   evaluated per call. Unknown families are denied — the default is no.
4. **Skills.** `allowed-tools` records intended tools. The `skillPermits` helper
  has no runtime callers, so this field must not be treated as an enforced
  allow-list. Skills cannot grant permission past the normal tool policy.

The renderer holds none of this. It has no Node integration, no filesystem
access and no tokens; it can only send validated IPC messages.

## The governance chain

```
tool call
  → zod-validate arguments
  → PermissionPolicy.evaluate → allow | ask | deny
  → if ask: ApprovalBroker → the human
  → AUDIT the decision            ← durable write, before any effect
  → execute
  → AUDIT the outcome
```

The decision is committed before the side effect. A crash in between leaves a
record saying the action was authorised and may have run, which is
investigable. The opposite ordering would allow a side effect with no record at
all.

Custom tools are registered with `skipPermission: true` so the runtime does not
also prompt: the authority is this chain, running in the privileged process,
and there is exactly one of it. The runtime's own built-in permissions (shell,
file write, URL fetch, MCP) are routed into the same broker via
`onPermissionRequest`, and an unrecognised permission kind is classified
`destructive` — the system fails closed on anything it does not recognise.

Risk classes are `read`, `write`, `external` and `destructive`. In the custom-tool
policy, reads run without a prompt after tenant and session deny checks. Writes
may be remembered for the session, keyed by family and tool name. Interactive
`external` and `destructive` calls require a decision each time; an "allow
always" answer is never recorded for them. Delegated grants are described below.

A device-managed `requireApprovalForWrites` is evaluated **above** session
rules, so a tenant that mandates per-call approval cannot be switched off by a
user answering "always" once.

### Delegated runs, where there is nobody to ask

A `sub_agent` or `scheduled` session runs unattended. Its execution cannot depend
on a person opening its history and answering an approval card. Two rules cover
this boundary.

**A delegated turn never waits.** An `ask` outcome in an unattended session is
settled immediately as a deny naming the family that would have been needed.

**The decision that started the run is the grant.** Approving a research plan,
answering the `write`-risk `delegate_tasks` card, or saving a scheduled job all
name the tool families the work may use; a `DelegatedGrant` carries those to the
session so they run without stopping at a card nobody will see. It is not a way
past approval — it is what the approval already meant. Its ceiling cannot
express `destructive`, tenant deny floors and `requireApprovalForWrites` both
outrank it, and every call it covers is still audited, with `source:
"delegation"` so the log never attributes it to a person who was not there.

## Prompt injection

Retrieved content is the attack surface: a mailbox, a chat and a shared
document are all writable by people who are not the user.

- Work IQ, knowledge-index, sub-agent output and project documents are untrusted
  content. Anything on disk may have been written by someone else. Do not rely
  on a universal turn-log flag or visual badge to enforce this boundary.
- The system prompt states that retrieved content is data, never instructions.
- The structural defence is that untrusted content cannot authorise anything. A
  tool call motivated by injected text still faces the same permission chain,
  with approval details supplied by the tool or runtime permission request.
- Durable artifacts are the injection target that outlives the turn. A memory
  or a skill proposed on the basis of a malicious document would otherwise be a
  standing instruction, so neither takes effect on the agent's say-so: a memory
  needs approval before it is eligible for anything, and a skill compiled from
  approved memories needs a second approval before it is loadable.

The prompt sets the content boundary; policy and approvals limit effects. They
do not guarantee that a model or user will recognize every injection attempt.

## MCP servers and the suggestion catalog

An MCP server is a third party supplying tools, so connecting one is a consent
decision: add (inert) → inspect → approve each tool by name → enable. The
product ships a small catalog of Microsoft-published servers to save typing,
and nothing else — an entry is a prefilled form. It lands disabled with no
approvals, its `expectedTools` are a claim rather than a grant, and only what
inspection actually returns can be approved.

The catalog lists three entries. Two of them — Power BI modeling and Work IQ —
are seeded on first load in the inert state: registered, disabled, never
inspected, nothing approved. The seeding is recorded, so a server the user
removes stays removed. MarkItDown is not seeded, because it can read any file
this process can.

| Entry | Command | Seeded | Why it is governed carefully |
|---|---|---|---|
| **Power BI modeling** (Microsoft) | `npx -y @microsoft/powerbi-modeling-mcp --start` | yes | Reads and edits semantic models. Its reach is whatever model the user points it at, so each tool is approved by name. |
| **Work IQ** (Microsoft) | `npx -y @microsoft/workiq mcp` | yes | Microsoft 365 reads and writes under the server's own identity. EULA acceptance and tool approval are separate; returned content is untrusted. |
| **MarkItDown** (Microsoft, `microsoft/markitdown`) | `markitdown-mcp` | no | Converts PDF, Office, image, audio, HTML, CSV, JSON, XML, ZIP and EPUB input into Markdown, which is what makes an otherwise opaque artifact readable. It accepts `file:` and `http(s):` URIs, so it is bounded by neither the project navigator's tree nor the browser's deny-list. |

Three consequences follow from MarkItDown in particular, and its catalog entry
states them before it is added rather than after:

- **Install the executable before enabling it.** `uv tool install markitdown-mcp`
  prepares the environment and puts `markitdown-mcp` on PATH. The catalog launches
  that executable directly so installation is not part of a session's MCP
  handshake. It is not bundled with the app.
- **Its reach exceeds the project.** A `file:` URI reads anything this process
  can read. That is a real grant and is presented as one — it is why the entry
  carries a caution and why approval is per tool.
- **Its output is untrusted content.** A converted PDF is a document written by
  someone else. It should be cited rather than obeyed and cannot authorise a
  tool call.

Every add, inspect, approval, enable and disable is audited with the actor and
the server id, and each call the runtime makes still passes `McpRegistry.gate`
as the deny floor beneath the permission broker.

## Audit

Append-only JSONL. One record per governed event:

```json
{
  "id": "...", "timestamp": "...", "actor": "user|agent|system|schedule",
  "action": "tool.invoke", "target": "m365_mail_send",
  "outcome": "allowed|denied|failed|succeeded",
  "sessionId": "...", "correlationId": "...", "detail": { }
}
```

Covered: sign-in and sign-out, each scope grant, every permission decision and
tool outcome, scheduled run start and settle, plan and task transitions, gate
decisions, and skill proposal, approval, rejection and archival, plus the memory
lifecycle (`memory.record`, `memory.approve`, `memory.reject`, `memory.delete`)
and every automatic derivation (`memory.derive`, including derivations refused
by tenant policy). Memory records carry the `memory` family and the proposal a
derivation writes is audited separately as `skill.propose`, so filtering by
family separates "what was remembered" from "what became loadable". A
`correlationId` links a scheduled run or a plan to every session, turn and tool
call it produced, so "why did the agent send that mail" is answerable by
following one identifier.

The log is never rewritten in place. Files are partitioned by UTC day, and
queries scan backwards from today, so retention is a matter of removing old
day files rather than editing any.

## Observability

Turn events are the primary telemetry, and they are already durable, so the
observability story is the same store as the recovery story. The UI exposes it
directly: the Jobs panel shows each run's attempt count, duration, outcome and
error; the Plans panel shows per-task state, attempt and blocking gate; the
Audit panel is a live tail with filters.

Diagnostics that proved necessary in practice: the main process writes fatal
errors to `<userData>/main-crash.log` as well as stderr, because Electron
detaches stdio from GUI processes on Windows and an unhandled main-process
exception otherwise surfaces only as a dialog titled "Error".

## Retry and idempotency

**Scheduled jobs.** Occurrences are computed from the trigger and the last run
rather than stored, so a persisted "next run" cannot drift out of sync with the
schedule. Each run carries an idempotency key of `jobId:scheduledFor`; a run
that already exists for that key is skipped, which makes a duplicated tick
harmless. A single-flight guard prevents a job from overlapping itself. Each
run has a hard timeout, so a runaway agent loop cannot monopolise the scheduler. Missed occurrences are caught up only within a bounded window;
older ones are dropped rather than replayed in a burst. Retries use exponential
backoff with full jitter, capped attempts and a capped delay.

**Orchestration tasks.** A task retries within `maxAttempts` and then settles
as `failed`, which fails its dependents rather than blocking them forever.
Repeated non-success attempts stop at `maxAttempts` to prevent spin loops. Cycles are
rejected when a plan is created, because a cycle hangs rather than fails.
Concurrency is capped by `maxParallel`.

**Memory derivation.** A derivation pass is single-flighted, so overlapping
triggers collapse into one, and each derived skill records a signature over the
memory ids and revisions that produced it. Re-running the pass over an
unchanged corpus produces nothing, which makes it safe to trigger on every
approval and to re-run on every start — the start-up pass is exactly how a
derivation interrupted by a crash is recovered, without risking a duplicate
proposal. A group that fails to compile is skipped and logged rather than
aborting the pass, so one malformed subject cannot block the others.

**What is never retried automatically.** On boot, turns and job runs that were
in flight when the process died are marked `failed`. Replaying an unattended
turn risks repeating an external effect that already occurred, and the log
cannot always distinguish "the send failed" from "the send succeeded and then
we crashed". A person retries explicitly once they know which it was.

A delegated *task* is the one exception, and only because it is not the same
claim: its status is persisted but the thing running it is an in-memory abort
controller, so a task left `running` by a crash is provably not running. On boot
the Coordinator returns it to `ready` while its attempts allow and fails it
otherwise. Leaving it alone was worse than either: `passPlan` counts a persisted
`running` as occupying a parallel slot, so a plan whose in-flight batch died came
back with phantom tasks blocking everything behind them and a plan that could
never settle.

**Isolation of unattended work.** Every scheduled run and every sub-agent task
gets a fresh session. Interactive approvals never leak into unattended
execution, so an "allow for this session" granted while a user was watching
cannot silently authorise a job at 06:00. What crosses that boundary instead is
the run's own `DelegatedGrant`, which was named when the run was authorised.

## The browser pane

Loading remote content inside a desktop agent is the largest single risk this
product takes, so the page does not run inside the application at all:

- The page runs in a **real Edge or Chrome already installed on the machine**,
  launched out-of-process by Playwright. Its viewport is streamed to the
  renderer as JPEG frames over CDP `Page.startScreencast`, and the user's mouse,
  wheel and keyboard events are forwarded back as `Input.*` events. The renderer
  therefore holds a *picture* of a page, never the page: `webviewTag` stays off,
  the CSP stays `default-src 'none'`, and no remote DOM, script or origin exists
  anywhere in the app's own process tree. VS Code's Edge DevTools extension is
  the precedent for this surface.
- The reason for one browser rather than two is that it must serve two masters.
  The user browses in it and the agent automates it, and they share one process,
  one profile and one cookie jar — otherwise "sign in here, then have the agent
  continue" is impossible, which is the single most common real task. The
  profile is persistent and belongs to the app, not to the user's own Edge.
- Containment travels with it: `acceptDownloads: false`, no granted
  permissions, popups closed and re-navigated in-pane, dialogs auto-dismissed,
  and page text capped at 20k characters.
- One rule — `BrowserUrlPolicy` — governs the user's address bar, the
  `open_browser_pane` tool and every navigation the page attempts. It is
  enforced **on the wire**: a `context.route("**/*")` handler checks every
  http(s) request and aborts a denied one, so a redirect chain, an iframe and a
  sub-resource are all checked exactly like a typed URL.
- `https:` only, and no credentials embedded in the URL. There is **no host
  allow-list**: research is a normal part of the work, so any page reachable in
  an ordinary browser loads here. What narrows it is the tenant's
  `browserDeniedHosts` deny-list, or `browserEnabled: false`; like every other
  policy switch it is a deny floor and cannot widen anything.
- Audit records carry the **host only**, and only for main-frame navigations. A
  full URL routinely carries tokens in its path or query, and auditing every
  sub-resource would drown the log that a person actually has to read.
- Input from the renderer is **refused while the pane is hidden**. A tab the
  user cannot see must not be able to act inside a page.
- The agent can **operate** the pane, not just point it somewhere. Beside
  `open_browser_pane` sit `read_browser_page`, `browser_go_back`,
  `browser_go_forward`, `browser_reload`, `browser_elements`, `browser_click`,
  `browser_fill`, `browser_select`, `browser_press_key`, `browser_scroll`,
  `browser_wait_for` and `close_browser_pane` — all in the `browser` family, all
  through the same approval path. Four limits keep that safe:
  - **Reading is separate from navigating.** `read_browser_page` and
    `browser_elements` are `external`-risk calls, so page text never enters a
    model's context without an approval that says so, and both results are
    labelled untrusted data to cite rather than instructions to follow.
  - **Acting is `external` and never auto-approved.** A click can submit a form,
    send a message or spend money, and the model may be acting on text the page
    just fed it, so `browser_click`, `browser_fill`, `browser_select` and
    `browser_press_key` are confirmed individually and are outside every
    auto-approvable safe set. Their approval cards carry the element's *visible*
    label, so the user confirms "Delete account", not "e17".
  - **No coordinates.** The agent addresses elements by a handle this process
    minted — `browser_elements` labels the live DOM and hands back `e1 button
    "Sign in"` lines. A handle is format-validated before it becomes a selector,
    so a value echoed from a hostile page cannot inject into our own query, and
    a handle we never issued resolves to nothing. Clicking at a guessed pixel is
    not an available verb.
  - **Non-Latin text is not a special case.** Fills go through Playwright's
    `fill`, which uses `Input.insertText`; a synthesised keycode cannot express
    what an IME composed, so key events are reserved for the control set where
    the keycode *is* the point.
  - History and scroll verbs stay `write` risk — they move within pages the
    policy already allowed and reach no new host.

## Recording consent and retention

Meeting capture is the one feature that creates a new, highly sensitive
artefact rather than reading an existing one, so it is governed structurally
rather than by a prompt:

- **Attributable.** Capture requires a signed-in Entra account. The stored
  `RecordingConsent` names the oid, tenant, username and time of the
  acknowledgement. Without an account there is no code path that starts a
  recording.
- **Versioned.** The notice text and its version live in the privileged
  process. The renderer echoes back the version it displayed, and a mismatch
  refuses the capture — when the notice changes, previous acknowledgements stop
  counting.
- **Explicit.** `participantsInformed` is a literal `true` in the contract; a
  request without it does not parse. The panel shows the notice with its
  checkbox already ticked and leaves it wherever the person puts it — clearing
  it blocks the capture, and the gate that matters is the versioned notice
  above it, not the number of times the box is clicked.
- **Refusals are evidence.** Every rejected attempt writes
  `meeting.capture_refused` with the reason. An attempt to record without
  consent leaves a record, which is precisely what an investigation needs.
- **Visible.** While a capture is running the UI shows a recording indicator
  that cannot be dismissed.
- **Minimised by contract.** Retention is a per-meeting field. Omit it and the
  service deletes: `retainAudio` defaults to `false` wherever consent is
  constructed, deletion happens as soon as a transcript exists, and the
  deletion is audited. The Meetings panel presents the choice pre-selected,
  because a person who opened it came to keep a recording; the decision is
  still theirs, still per meeting, and still recorded in the consent entry.
  Audio *is* kept when transcription fails, because the alternative is losing
  the meeting entirely; it is deleted on the next successful retry.
- **Narrowly permitted.** The main process grants microphone and loopback
  **audio** only. Video and every other Chromium permission are refused, and a
  sandboxed renderer cannot widen this.

The same reasoning applies to voice: a push-to-talk clip is held in the
renderer until the key is released, so a cancelled press is never sent
anywhere, and audio only ever travels to the tenant's own Azure AI Speech
resource.

## Data handling

Everything stays local: sessions, turns, skills, memories, plans, meetings,
the knowledge index and the audit log are files in the Electron
user-data directory. Nothing is sent anywhere except to Microsoft endpoints and
the GitHub Copilot runtime. No credential is stored by this application at all:
Microsoft tokens are held by the Azure CLI's own OS-backed cache and the GitHub
credential by the Copilot runtime under `COPILOT_HOME`. They are never written
to the audit log, and no log
record contains a token, a password or a full message body. Audit records for
meetings and notes carry identifiers, byte counts and character counts — never
transcript or note text.

Memories are the one class of user content deliberately written into the audit
log: a `memory.record` or `memory.approve` record carries the fact itself,
because "which claim did I approve, and when" is unanswerable otherwise. Facts
are short, user-visible and reviewable before approval, and can be removed from
the memory store with **Forget** — the audit log itself is never rewritten, so
the record of the decision survives the memory.
