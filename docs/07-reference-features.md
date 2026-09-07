# IQ Compiler — implemented features

An inventory of what the application actually does today. Every row points at
the code that implements it, relative to `iq-compiler/`. Status values:

- **Built in** — implemented and reachable from the UI or the agent.
- **Configurable** — implemented, but inert until an endpoint, credential or
  policy file is supplied.
- **Partial** — the mechanism exists; a named part of it does not.
- **Not built** — in scope and named here because a reader would look for it,
  but not implemented.
- **Elsewhere** — implemented, in a different part of the product than the
  section it is being looked for in.

Anything not listed here is not implemented. For capabilities that were
considered and deliberately left out, see
[`06-exclusions.md`](06-exclusions.md). For surfaces that look live and are
not, see [`08-product-ready.md`](08-product-ready.md).

---

## Identity and authorization

The app requires **no application registration**: no `client_id`, no configured
`tenant_id`, no client secret. Two connections must both be green before the
main window opens.

| Feature | Status | Description |
|---|---|---|
| Registration-free Azure identity | Built in | Tokens are acquired through the signed-in Azure CLI identity — `az login` for interactive sign-in, `AzureCliCredential` for silent acquisition and status checks. Nothing about an app identity is registered or stored. |
| GitHub Copilot connection | Built in | The agent runtime authenticates through the Copilot SDK's own device flow, persisted on the device. State is read from the SDK's auth status, never from an app-held token. |
| Stale-token defence | Built in | `GITHUB_TOKEN`-family variables are stripped from the runtime environment before launch, because the SDK otherwise picks up a non-Copilot token and reports "No model available". |
| Both-connections gate | Built in | The sign-in card blocks **Continue** until both Azure and Copilot report connected. Connection order is not enforced — either button may be used first. |
| Sign-in card | Built in | One centred card: lock glyph, title, two-line explainer, tenant field, one primary button per connection with a status dot and status line beneath it, gated Continue, and a footer note explaining what each sign-in does. |
| Tenant override | Built in | The Tenant ID field is optional and read-only by default with an inline **Edit** affordance. Blank means the account's home tenant. |
| GUID or domain | Built in | The field accepts either a tenant GUID or a domain such as `contoso.onmicrosoft.com`, and validates the format before attempting sign-in. |
| Known-tenant picker | Built in | After sign-in the tenants the account can reach are listed with display name, domain and GUID, so a switch is a click rather than a pasted GUID. The raw field stays available for a tenant not in the list. |
| Account-picker forcing | Built in | Interactive sign-in clears cached CLI accounts first; otherwise a tenant switch silently reuses the previous identity and fails with `AADSTS50020`. |
| `--allow-no-subscriptions` | Built in | Sign-in succeeds for an identity-only tenant with no Azure subscription. |
| Tenant switching after launch | Built in | Switching from *Connections & access* re-runs the same flow, invalidates cached resource tokens, warns that Foundry entries bound to the previous tenant are affected, and re-verifies them afterwards. |
| Distinguished failure states | Built in | Azure CLI missing or not on PATH, user cancelled, not a member of the requested tenant (`AADSTS50020`, which offers the tenant picker), consent or conditional access required, token expired, and generic failure — each with its next step and a retry. Copilot has its own set: device-flow pending, device-flow expired, no Copilot entitlement, stale `GITHUB_TOKEN`. |
| Per-resource, per-action tokens | Built in | Nine declared capabilities (`m365.mail.read`, `m365.mail.send`, `m365.calendar.read/write`, `m365.files.read/write`, `m365.sites.read`, `m365.people.read`, `m365.teams.read`) plus `azure.speech` acquire their own token at first use. `scopesForCapabilities()` resolves the smallest de-duplicated set. |
| Consent ledger | Built in | Because the CLI's first-party client cannot do incremental consent, least privilege is enforced by an app-side ledger: a capability is unusable until the user grants it, and each grant is audited. |
| Tenant deny floor | Configurable | `allowedTenantIds` refuses sign-in from outside the list; `deniedScopes` blocks a capability before any token request is made and audits the refusal. |
| Tokens stay privileged | Built in | Acquisition happens only in the main process; no token or key crosses IPC, and none appears in a log or audit record. |
| Sign-out | Built in | Clears the account and cached state and emits an audit record. |

*Code:* `packages/core/src/entra/`, `packages/shared/src/entra.ts`,
`apps/renderer/src/SignIn.tsx`.
*Tests:* `tests/entra-auth.test.ts`.

## Modes, sub-modes and projects

Every capability declares exactly one top-level mode and one sub-mode. The mode
switch is pinned at the top of the icon rail and never collapses.

| Feature | Status | Description |
|---|---|---|
| Five top-level modes | Built in | `chat`, `cocreate`, `flow` (IQ Cell, beta), `hub` (Connectome IQ, beta) and `control` — the canonical map lives in `packages/shared/src/mode.ts`, not in the UI. Four are segments in the mode switch; Control Center is a rail destination above *Projects*, because it governs work rather than being a way of doing it. |
| Chat sub-modes | Built in | **Conversation** (default), **Team** (council), **Research** and **Data agent**. |
| Co-create sub-modes | Built in | **Fabric** (default), **Office**, **Image Creation** and **Skill Recording**. |
| IQ Cell sub-modes | Built in | In rail order: **My IQ** (default), then a rule, then **IQ Industry**, **IQ Workflow**, **IQ Knowledge**, **IQ Memories** and **IQ Cell library**. Industry, Knowledge, Workflow and approved Memories are the four source types, and each cell comes from one of them. The library holds versioned cells and My IQ analyses selected cells together. All but IQ Memories carry `beta: true` in `mode.ts`, which the rail renders as a suffix on the entry. `beta` means demo-scoped — stub persistence or no runtime behind the surface — not merely new. |
| Connectome IQ sub-modes | Built in | One: **Connectome IQ** itself. The mode holds a single destination because every place in the app is a sub-mode — a mode without one would be a place nothing could record, restore or audit. |
| Control Center destinations | Built in | Automations, Delegated plans, Audit, Sample data, Clean. Memories moved to IQ Cell and Models to *Connections & access*; neither is offered here. |
| Project requirement per sub-mode | Built in | `SUB_MODES` carries `requiresProject`; Chat may run without one, every Co-create sub-mode requires one, Control Center offers an all-projects filter. |
| One conversation, many surfaces | Built in | All modes share the same conversation object. Promoting a chat to Co-create asks for a project and binds it; demoting keeps the thread and unbinds the panes. Switching modes never loses conversation state. |
| Mode stamped on every action | Built in | `ModeContext` (mode, sub-mode, project id) is recorded on audit records, so a governance record names where an action ran. |
| Named projects | Built in | A project is a directory plus the sessions, artifacts, skills, MCP connections, knowledge index and memories bound to it. The registry owns the list and the binding; the navigator, the tool sandbox and the audit record all read the active directory from it. |
| Boundary safety | Built in | `create` refuses the app's own state root or any ancestor of it, and stores the realpath rather than following a symlink. |
| Removal never deletes files | Built in | Removing a project drops the registry entry and any binding; the directory and its contents are left alone. |
| Migration of an existing install | Built in | An unnamed root is converted on first load into a record named "Project" and bound, so files and history survive the move to named projects. |
| Migration of the workspace-to-project rename | Built in | State written before the rename is moved and rewritten once at boot: `<userData>/workspace` becomes `project`, `workspaces.json` becomes `projects.json`, and `workspaceId` becomes `projectId` in the records. Fabric's own state is skipped by path, so a Fabric workspace GUID survives untouched. |
| Open a folder as a project | Built in | The navigator's folder button picks a directory and adopts it, or rebinds the existing record when it is already registered. |

*Code:* `packages/shared/src/mode.ts`, `packages/core/src/project/`,
`packages/core/src/config/migrate.ts`.
*Tests:* `tests/project.test.ts`, `tests/project-registry.test.ts`,
`tests/state-migration.test.ts`.

## Agent runtime

| Feature | Status | Description |
|---|---|---|
| GitHub Copilot SDK runtime | Built in | The agent runs on `@github/copilot-sdk`, launched over stdio against the bundled native `copilot` executable — the only form that works inside Electron. |
| Foundry as second runtime | Configurable | A model entry may point at a Foundry deployment or a published Foundry agent; both are reached with the Azure identity. |
| Durable turn log | Built in | Eleven event types (`turn_created`, `user_message`, `assistant_message`, `reasoning_delta`, `tool_call_requested`, `tool_permission_settled`, `tool_call_completed`, `turn_suspended`, `turn_completed`, `turn_failed`, `turn_cancelled`) are appended to a per-turn JSONL log. |
| Turn state by fold | Built in | Turn state is never stored; it is derived by folding the event log, so the UI and a crash recovery see identical state. |
| Session log and index | Built in | A per-session JSONL log of five event types (`session_created`, `turn_appended`, `title_changed`, `place_changed`, `history_cleared`); the session list is derived by folding it. |
| Immutable per-turn snapshot | Built in | Each turn records the model, skills, tool families, mode and project it ran with, so a past turn stays explicable after configuration changes. |
| Streaming to the UI | Built in | Assistant text, reasoning deltas, tool calls and permission requests stream to the renderer as they occur, and the user message is appended to the transcript the moment it is sent. |
| Chat history restore | Built in | Reopening a session refolds every stored turn and overlays live events by turn id. |
| Stop a running turn | Built in | Cancels in flight and records `turn_cancelled` with a reason. |
| Crash reconciliation | Built in | Turns interrupted by a crash are marked failed on boot and are never silently replayed. |
| Explicit resume | Built in | `sessions:resume` is the deliberate path back into an interrupted session. |
| Token usage accounting | Built in | Input/output/total tokens are recorded on `turn_completed`. |
| Session deletion | Built in | Removes the session, its turn logs and the runtime-side session together, from the session list's own control. |

*Code:* `packages/core/src/runtime/copilot/copilot-runtime.ts`,
`packages/core/src/runtime/sessions/`, `packages/shared/src/{events,reducers}.ts`.
*Tests:* `tests/reduce-turn.test.ts`.

## Governance and permissions

| Feature | Status | Description |
|---|---|---|
| Single permission chain | Built in | Every custom tool call runs validate → policy → approval → audit → execute → audit, in the privileged process. |
| Decision recorded before the effect | Built in | The permission outcome is durably written before the side effect runs, so a crash can never hide an action that may have happened. |
| Four risk classes | Built in | `read` runs unprompted; `write` prompts and may be remembered; `external` and `destructive` are irreversible and are re-confirmed every single time. |
| No global bypass | Built in | There is no "YOLO" or blanket approval-bypass control anywhere in the product. |
| Scoped, expiring auto-approval | Not built | The intended composer control — auto-approval of a named safe tool set, scoped to the session and project and expiring with it — is not implemented. Today the equivalent is the per-family "always" session rule, which is narrower in what it grants but has no expiry. |
| Tenant policy outranks the user | Built in | `requireApprovalForWrites` is evaluated above session rules, so a managed approval floor cannot be switched off by answering "always" once. |
| Fail-closed default | Built in | An unrecognised risk level or a family outside the allow-list reaches a default deny rather than falling through. |
| Session allow/deny rules | Built in | "Always" and "never" answers are remembered per family+tool for the session only, and never leak into unattended runs. |
| Runtime built-in permissions | Built in | The SDK's own shell/file/URL/MCP permission requests are funnelled into the same broker; an unknown kind is classified `destructive`. |
| Argument validation | Built in | Tool arguments are zod-validated before the policy sees them, and the JSON Schema handed to the model is generated from the same schema. |
| Untrusted-result marking | Built in | Every Microsoft 365, Work IQ, browser-page, knowledge and sub-agent result is flagged `untrusted` in the turn log and rendered as such. |
| Secret redaction | Built in | Sharing URLs are stripped of query strings and tokens before they reach a summary, the audit log or a log line. |
| Managed policy file | Configurable | Policy is read from an Intune/GPO-populated machine path in preference to the local file; a malformed managed policy is a hard failure, never a silent downgrade. |

*Code:* `packages/core/src/policy/`, `packages/core/src/runtime/tools/registry.ts`.
*Tests:* `tests/permission-policy.test.ts`.

## Audit

| Feature | Status | Description |
|---|---|---|
| Append-only audit log | Built in | JSONL partitioned by UTC day, never rewritten in place. |
| Coverage | Built in | Sign-in, sign-out, tenant switch, each capability grant, every permission decision and tool outcome, Work IQ consent, skill enable/propose/approve/archive/import/export, the memory lifecycle and every automatic derivation, scheduled runs, plan transitions, model-registry changes and tests, MCP server and tool grants, OfficeCLI invocations with subcommand and version, image generations, research fetches, council member turns, vault selection and reindex, browser navigation and page reads, and Speech resource registration, removal and connection tests. |
| Mode and project on the record | Built in | Each record carries the project, mode and sub-mode the action ran in. |
| Correlation ids | Built in | One id links a job run, plan, research run or council session to every session, turn and tool call it produced, and cross-links the governance record to artifact history. |
| Four outcomes | Built in | `allowed`, `denied`, `failed`, `succeeded`. |
| Audit query UI | Built in | Control Center → Audit filters by correlation id, tool family and project, newest first, bounded scan, exportable. |
| Crash log | Built in | Fatal main-process errors are appended to `main-crash.log`, because Windows detaches stdio from GUI processes. |
| Structured logging | Built in | JSON log lines with component bindings. |

*Code:* `packages/core/src/audit/audit-log.ts`, `packages/shared/src/audit.ts`.

## Microsoft 365

| Feature | Status | Description |
|---|---|---|
| Microsoft Graph tools | Removed | There are none. Graph tokens carry the app's Azure identity rather than the user's Microsoft 365 account, so a Graph mail tool is denied in a tenant where Work IQ works — and offering both means the model picks the one that fails. |
| Microsoft 365 data | Via Work IQ | Mail, calendar, chat, meetings and documents are reached only through the Work IQ MCP server, which signs in with its own account. |

*Code:* `packages/core/src/workiq/`, `packages/myiq-mcp/`.

## Work IQ

| Feature | Status | Description |
|---|---|---|
| `workiq_ask` | Configurable | Natural-language question across Outlook, Teams, Calendar, SharePoint and OneDrive, answered with citations. |
| `workiq_search` | Configurable | Ranked search over selectable Microsoft 365 surfaces. |
| Separate consent gate | Built in | Work IQ is off until the user accepts its terms explicitly; enabling Microsoft 365 does not enable it. Acceptance is versioned and audited per account. |
| Transport indirection | Not wired | Tools talk to a `WorkIqClient` interface and `McpWorkIqClient` implements it, but nothing constructs one: `AppOptions.workIqClient` is never set, so `createWorkIqTools` never runs and the governed `workiq` family is not registered. The interface is the seam it was designed to be; the seam is empty. Microsoft 365 data reaches the app through the `workiq` MCP server instead. |

*Code:* `packages/core/src/workiq/`.

## Models (Connections & access)

| Feature | Status | Description |
|---|---|---|
| One registry, one place to edit it | Built in | The composer's picker and *Connections & access* read the same store, so they cannot disagree about what exists or which model a role resolves to. Control Center had a second Models rail onto the same registry and it was removed: a Foundry deployment is an endpoint plus an identity, which is a connection. |
| Two providers only | Built in | **GitHub Copilot** models are advertised by the SDK for the signed-in account and are never editable. **Microsoft Foundry** entries are configured by the user and are the only thing persisted. |
| Foundry entry shape | Built in | Display name, endpoint URL, deployment name, capability set (chat, reasoning, vision, image generation, embeddings), and an optional per-project restriction. The **API version** field appears only for chat or reasoning deployments, which use Azure OpenAI's versioned deployment route. An image-only `gpt-image-2` deployment uses the unversioned `/openai/v1` surface, sends its deployment name as `model`, and neither asks for nor sends an API version. |
| Foundry agents | Configurable | An entry may reference a published Foundry agent by agent id, so the app calls the agent instead of a raw deployment. |
| No keys stored | Built in | A Foundry entry is a network destination plus a capability claim, reached with the Azure identity. `models.json` holds nothing dangerous to read. |
| Test in place | Built in | A minimal round-trip reports reachable / unauthorized / not found / failed with the actionable next step, and stores a last-tested timestamp. |
| Broken advertised catalogue is survivable | Built in | If the Copilot side cannot be read the catalogue still returns every Foundry entry and sets `copilotError`. |
| Layered defaults | Built in | A default model per role — chat, reasoning, Office authoring, image generation, research writer, council member — overridable per project and per turn from the composer. Roles are capability-checked against the entry (`MODEL_ROLE_CAPABILITY`). |

*Code:* `packages/core/src/models/registry.ts`, `packages/core/src/models/foundry-client.ts`.
*Tests:* `tests/model-registry.test.ts`.

## Control Center — Automations

| Feature | Status | Description |
|---|---|---|
| Four trigger kinds | Built in | `manual`, `cron` (5-field, with timezone), `interval`, and one-shot `once`. |
| Fresh session per run | Built in | Each run gets a new session with a job-scoped tool set and pre-activated skills, so interactive approvals never leak into unattended work. |
| Derived occurrences | Built in | The next fire time is computed from the trigger and run history rather than stored, so it cannot drift out of sync with the schedule. |
| Idempotency fencing | Built in | Every run carries a `jobId:scheduledFor` key; a duplicate tick is a no-op. |
| Single-flight per job | Built in | A job can never overlap itself. |
| Per-run timeout | Built in | Default 10 minutes; a runaway run is failed and released rather than holding the scheduler. |
| Retry with backoff | Built in | Bounded attempts, exponential backoff with a factor and a ceiling, and a recorded `nextAttemptAt`. A failed run's retry is safe to repeat. |
| Concurrency cap | Built in | `maxConcurrentJobs` limits simultaneous runs regardless of how many are due. |
| Catch-up bound | Built in | Missed occurrences are picked up only within a one-hour window by default; older ones are skipped rather than replayed in a burst after downtime. |
| Run history | Built in | Six statuses (`pending`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled`) with attempt, duration, session id and error. |
| Run now, cancel, enable/disable | Built in | Manual control over any automation. |
| Cron validation | Built in | Expressions are validated at creation, so an automation cannot be saved in a state that never fires. |
| Worked examples, inert | Built in | Three sample jobs across different trigger shapes. Every one arrives **disabled** with read-only tool families, is re-disabled on every load, and is skipped by the scheduler entirely while the sample-data flag is off. Loading examples never starts unattended work. |

*Code:* `packages/core/src/scheduler/scheduler.ts`, `packages/shared/src/schedule.ts`.
*Tests:* `tests/scheduler.test.ts`, `tests/sample-automations.test.ts`.

## Control Center — Delegated plans

| Feature | Status | Description |
|---|---|---|
| `delegate_tasks` | Built in | The agent decomposes work into up to 12 tasks with declared dependencies and dispatches them as sub-agents. |
| Isolated sub-agent context | Built in | A sub-agent sees none of the parent conversation; the instruction must be self-contained, which the tool description enforces. |
| Parallel execution | Built in | Independent tasks run concurrently up to the plan's `maxParallel`, itself capped by the tenant's `maxParallelSubAgents`. |
| Restricted per-task toolsets | Built in | A task may request narrower tool families; requesting an unavailable family fails the call rather than silently widening. |
| Dependency DAG | Built in | Tasks are promoted only when every dependency has succeeded, and the plan renders as a DAG with per-node status, agent and model. |
| Cycle rejection | Built in | A cyclic plan is refused at creation, because a cycle hangs rather than fails. |
| Human decision gates | Built in | A gate holds a named subset of tasks until a person answers; the answer is audited. |
| Per-task retry | Built in | Bounded `maxAttempts`, after which the task fails and its dependents fail with it, instead of spinning. |
| Manual task retry | Built in | A settled node can be retried individually. |
| Plan cancellation | Built in | Cancels the plan and its outstanding tasks. |
| `plan_status` | Built in | Lets the agent read back its own plan's progress. |
| Durable plan documents | Built in | Plans survive restart; mutations are serialised under a per-plan mutex. |
| Worked example, finished | Built in | One sample plan: a three-way fan-out, a gate and a task that waited on all of it. Every task is `succeeded` and no gate is pending, so the coordinator dispatches nothing and no sub-agent is spawned. |

*Code:* `packages/core/src/orchestration/coordinator.ts`, `packages/core/src/runtime/tools/agent-tools.ts`.
*Tests:* `tests/orchestration.test.ts`, `tests/sample-automations.test.ts`.

## Control Center — Sample data

| Feature | Status | Description |
|---|---|---|
| One hub, five modules | Built in | IQ Memories, IQ Knowledge, the IQ Cell library & Connectome, Automations and Delegated plans. Adding a sixth means adding a row to `MODULES` in the hub and nothing else. |
| One channel family | Built in | `samples:status`, `samples:setEnabled`, `samples:load`, `samples:clear`. The module is a value, not a channel name. The eight per-surface seed/clear channels this replaced are gone. |
| Global flag | Built in | Offered on the sign-in gate and here. Off hides every offer and stops the demo IQ Cells being reconciled back — it **deletes nothing**. Persisted in `config/app.json`. |
| App-owned vs device-owned | Built in | Four modules live under `IQ_HOME` and are reported by the hub. The IQ Cell library is the renderer's `localStorage`, so the privileged side neither reads nor claims to; the renderer hook is where the two halves become one list. |
| Fixed sets only | Built in | Each module's data is a constant in privileged code, so "load the examples" cannot become a side door that writes arbitrary memories, notes, schedules or plans. Fixed `*_sample_` ids make loading idempotent and clearing incapable of touching a real record. |
| Reversible | Built in | Every module's Clear removes only its own samples, and stays available whatever the flag says — a vault already written to disk has to be removable. |

*Code:* `packages/core/src/samples/`, `apps/renderer/src/samples/`.
*Tests:* `tests/samples-hub.test.ts`, `tests/sample-automations.test.ts`, `tests/sample-memories.test.ts`, `tests/sample-vault.test.ts`.

## Control Center — Clean

| Feature | Status | Description |
|---|---|---|
| Reachability, not age | Built in | Four kinds of debris: conversations that never held a turn, sub-agent runs no conversation can open, turn logs nothing refers to, and remembered browser pages belonging to conversations that no longer exist. Nothing is removed for being old or large. |
| Reachability is transitive | Built in | A sub-agent session is listed nowhere, so the only way back to one is the conversation that spawned it — and that one's parent, because a run can delegate to a run. It survives only if the chain ends at a listed conversation that is still here. A `parentSessionId` of `null` is unreachable, not exempt: research and delegated runs create their roots that way. |
| Counts first | Built in | `sessions:sweep` with `apply: false` reports what a sweep would remove and writes nothing. The panel scans on open and after every clean, so the button always names a number the user has seen. |
| What it refuses to touch | Built in | Anything in use, which is never judged at all: the conversation on screen, a session with a turn running, one waiting on an approval card, and everything those hang off. A turn is recorded when it *starts*, so a long research run looks exactly as old as an abandoned one — the live turn is the only honest answer, not the clock. Then: anything whose `updatedAt` is inside the settle window of one hour; a conversation the user emptied with Clear history, where the fold reports no turns but the log still holds the turn ids; a turn log younger than the window; scheduled conversations, which the rail lists. |
| One sweep, two owners | Built in | Sessions and turns belong to `SessionsService`; remembered pages belong to the browser pane. The sweep runs first and hands back the surviving session ids, so the page count is measured against what actually survived — a preview and a real clean report the same number. |
| One pass, one repaint | Built in | Each session log is read once into a `turnsOf` map, deletions go through `removeSession` rather than `delete`, and the rail is published once at the end. Publishing re-folds every session log, so doing it per deletion made a 74-conversation sweep read thousands of files and repaint the rail 74 times. The panel says `Scanning…` or `Cleaning…` while it works and shows `—` for a count nobody has answered yet. |

*Code:* `packages/core/src/runtime/sessions/sessions.ts`, `apps/main/src/browser-pane.ts`, `apps/renderer/src/ControlCenter.tsx`.
*Tests:* `tests/session-clear.test.ts`.

## Skills

| Feature | Status | Description |
|---|---|---|
| Agent Skills format | Built in | `SKILL.md` with YAML frontmatter per the agentskills.io specification: `name`, `description`, `license`, `allowed-tools`. The directory name and the `name` field must match exactly. |
| Progressive disclosure | Built in | Only descriptions are loaded eagerly; a skill body is read when the skill is invoked. |
| Three source locations | Built in | Bundled (read-only), user, and agent proposals — later locations shadow earlier ones by name. |
| Thirteen bundled skills | Built in | `workiq-copilot`, `scheduled-digest`, `document-drafting`, `meeting-notes`, `academic-paper`, `csv-dashboard`, `officecli-docx`, `officecli-xlsx`, `officecli-pptx`, `flow-modeling`, plus the vault-authoring set `obsidian-markdown`, `obsidian-bases` and `json-canvas`. |
| Enable/disable | Built in | Per-skill toggle, persisted, audited, scoped to a project and revocable. |
| Import | Built in | A skill directory or archive is validated against the specification, its declarations are shown before anything is enabled, and explicit approval is required. Install never enables. |
| Export | Built in | Produces a portable, specification-compliant `SKILL.md` bundle. |
| Bounded transfer | Built in | Import and export are capped at 200 files, 8 MiB total, 2 MiB per file and 8 directory levels, so a malformed or hostile bundle cannot exhaust the process. |
| `propose_skill` | Built in | The agent may write a skill proposal, which lands in `.proposals` and is **not loadable**. |
| Proposals compiled from memories | Built in | The curator writes proposals into the same staging area under a `learned-` prefix. See [Memory and skill derivation](#memory-and-skill-derivation). |
| Improved by evolution | Built in | **Improve…** on the Skills surface runs a DSPy + GEPA optimizer in a Python sidecar (`native/iq-evolve`, installed by `pnpm prepare:evolve` into `<IQ_HOME>/tools/evolve-py`). It generates an evaluation set from the skill's own text, scores the skill as it stands, then rewrites the body against an LLM judge's written feedback. The third producer of proposals, and the only one that improves a skill that already exists. |
| Evolution runs on Copilot | Built in | The model is the `reasoning` role default and must be a GitHub Copilot model; the sidecar is answered through the Copilot CLI, so there is no endpoint, no API key and no model setting of its own. A Foundry default is reported as a precondition rather than failing mid-run. The agent is given no tools — this is completion, not agentic work. |
| Evolution is bounded | Built in | Only the body is evolved: the YAML frontmatter is held aside, so `allowed-tools` cannot be self-widened. Four gates — not empty, size, section coverage, purpose preserved — are refusals, not advice, and the winner must also beat the baseline or nothing is proposed. There is no fallback optimizer: a run that cannot use GEPA fails and says so. |
| Human approval to activate | Built in | Approval promotes a proposal to a loadable skill and records the approver's oid and tenant. This is the only path to loadability, whether the proposal was written by `propose_skill`, imported, compiled from memories, or evolved. |
| Archive | Built in | Removes a skill from the active set, audited. |
| Tool-family narrowing | Partial | `allowed-tools` is a declaration and can never widen beyond consent and policy. It is not yet enforced: `PermissionPolicy.skillPermits` has no call sites, and six bundled skills list individual tool names where the method expects families, so wiring it as written would deny the whole `office` family. |
| Restore / pin / rollback | Not built | Review, approve, archive, import and export exist; restore, pin and rollback do not. |

*Code:* `packages/core/src/skills/`, `skills/*/SKILL.md`, `native/iq-evolve/`.
*Tests:* `tests/skill-transfer.test.ts`, `tests/bundled-skills.test.ts`, `tests/skill-evolution.test.ts`.

## Memory and skill derivation

| Feature | Status | Description |
|---|---|---|
| `remember` | Built in | The agent may record a durable fact about the user or their conventions, with a subject, scope, rationale and citations. |
| Approval before effect | Built in | A memory lands as `pending` and is never read back into a prompt. Approval records the approver's Entra oid and tenant. |
| Control Center is the only editor | Built in | Memories are created in Chat and Co-create; listing, searching, filtering by project, inspecting provenance, editing, revoking and exporting happen only in Control Center → Memories. |
| Duplicate suppression | Built in | Re-asserting a fact already known under the same subject returns the existing record instead of queueing a copy. |
| Supersession | Built in | Approving a fact retires an older identical one on the same subject, so a compiled skill never states a rule twice. |
| Automatic derivation | Built in | Approved memories are grouped by subject slug; once a subject reaches `minMemoriesPerDerivedSkill` (default 3) it is compiled into a skill proposal named `learned-<subject>`. |
| Double approval | Built in | The compiled artifact is a *proposal*. It needs the same human approval as any agent-authored skill, so automation shortens authoring and never review. |
| Idempotent and retry-safe | Built in | Each derivation stores a signature over the contributing memory ids and revisions; an unchanged corpus is skipped. The pass is single-flighted, runs on every approval, and re-runs on start to catch up after a crash. |
| Verbatim provenance | Built in | The compiled body quotes each fact with its memory id, scope and citation, and the record names the conversation and turn that produced it. |
| Namespaced output | Built in | The `learned-` prefix means a compiled skill can never silently shadow a bundled or hand-written one. |
| Policy control | Built in | `allowAutomaticSkillDerivation` disables compilation and `minMemoriesPerDerivedSkill` raises the evidence bar; a refusal is audited as `memory.derive` / `denied` rather than passing silently. |
| Audited lifecycle | Built in | `memory.record`, `memory.approve`, `memory.reject`, `memory.delete` and `memory.derive` are audit records in the `memory` family; the proposal each derivation writes is separately audited as `skill.propose`. |

*Code:* `packages/core/src/memory/store.ts`, `packages/core/src/memory/curator.ts`.
*Tests:* `tests/memory-curator.test.ts`.

## Co-create — Office

| Feature | Status | Description |
|---|---|---|
| OfficeCLI as a first-party tool | Built in | An existing `officecli` on PATH is discovered; otherwise a pinned known-good version is installed into the app's own tool directory. The version is recorded in the audit record of every invocation. It is not a user prerequisite. |
| Governed tool family | Built in | Nine tools in family `office`: `office_create_document`, `office_add_content`, `office_add_many`, `office_set_content`, `office_remove_element`, `office_merge_template`, `office_query_structure`, `office_validate_document`, `office_render_preview`. |
| Closed subcommand set | Built in | A fixed `OfficeSubcommand` union; the agent never composes a free-form command line. |
| Subprocess containment | Built in | `shell: false`, argument arrays only, every target path re-checked to be inside the active project, bounded output and a per-invocation timeout. |
| Resident mode for multi-step edits | Built in | `open` / `close` hold a document across mutations, with `OFFICECLI_RESIDENT_FLUSH=each` so a preview always reads current state rather than a stale file, and `OFFICECLI_SKIP_UPDATE=1` so a run never self-updates mid-task. |
| Live canvas preview | Built in | Each mutation emits `office:changed` and the canvas tab re-renders through OfficeCLI's own `view … html\|svg\|screenshot` output. No `watch` HTTP server is exposed. |
| Read-only labelling | Built in | The preview is explicitly labelled read-only while a generation is in flight, and the header warns that opening the file in the system app mid-run locks it. |
| Destructive operations never auto-approved | Built in | `remove`, raw set and overwriting an existing file are outside the auto-approvable safe set. |
| Skills per output type | Built in | `officecli-docx`, `officecli-xlsx`, `officecli-pptx`, plus the higher-level `academic-paper` and `csv-dashboard` presets. |
| Ordinary artifacts | Partial | Every generated file appears in the navigator and is indexed. Per-artifact snapshot-and-history is not implemented. |

*Code:* `packages/core/src/office/officecli.ts`, `packages/core/src/office/tools.ts`, `apps/renderer/src/Office.tsx`.
*Tests:* `tests/officecli.test.ts`.

## Co-create — Image Creation

| Feature | Status | Description |
|---|---|---|
| Foundry-only provider | Built in | Images come from a Microsoft Foundry image deployment (a gpt-image deployment, `gpt-image-2` in the current samples) registered under *Connections & access*. There is no third-party image provider. |
| Capability check before invocation | Built in | The selected entry must advertise the `image` capability; a mismatch is reported rather than attempted. |
| Image surface in the canvas | Built in | A conversation: prompts and results run down the page oldest first, with a composer pinned underneath. Per-image actions — change this image, change one area of it, make another like it, save to project, view generation parameters. |
| Follow-up prompts edit the image | Built in | A turn names the image it continues from; the source path and the conversation it belongs to are resolved on the privileged side. Editing needs a bound project, because an edit re-reads its source from the project; without one the edit actions are disabled with the reason on them. |
| Region selector | Built in | A brush paints the area an edit applies to. The mask travels with the request and is never written to disk. The area is a hint, not a boundary, and the surface says so. |
| Operations follow the deployment | Built in | Text-to-image, image edit with a source and optional mask, variations, and batch generation with a visible count and cost estimate, limited to what the deployment advertises. |
| Provenance on every generation | Built in | Model deployment name, endpoint, prompt, seed or parameters, whether the edit was confined to a painted area, timestamp and project. |
| Provenance written on save | Built in | Saving an image writes its provenance beside the file and into the audit record. |
| Bounded run history | Built in | Runs are kept in `config/image-runs.json`, capped at 50, and grouped into conversations for the surface. Deleting a conversation forgets the runs and leaves the files. |
| Saved images are ordinary artifacts | Built in | They appear in the navigator, open in the canvas image viewer, and can be attached to a chat turn or embedded into an Office artifact. |

*Code:* `packages/core/src/images/`, `apps/renderer/src/Images.tsx`.
*Tests:* `tests/image-service.test.ts`.

## Chat — Research

| Feature | Status | Description |
|---|---|---|
| Visible plan | Built in | The topic is decomposed into questions; the plan renders in the canvas with per-question status, sources consulted and findings. |
| Editable plan | Built in | Questions can be added, removed or edited, and a single question re-run without restarting the report. |
| Parallel gathering, single writer | Built in | Independent questions are delegated through the orchestration coordinator — so a research run appears in Control Center → Delegated plans — while one writer agent synthesises the report so voice and structure stay consistent. |
| Citation discipline enforced in code | Built in | Every claim carries a citation to a URL, an API response, a Microsoft 365 item or a project artifact. A claim that cannot be sourced is emitted as `unverified` rather than stated. |
| Conflicts reported, not resolved | Built in | Disagreeing sources produce a `ResearchConflict` in the report instead of a silent pick. |
| Governed sources | Built in | Web fetches use the browser's containment rules and deny-list, API calls go through the governed tool registry with per-host approval, and Microsoft 365 / Work IQ reads use per-resource tokens. Every fetch is audited host-only. |
| Project artifact output | Built in | Markdown by default with a source table, a coverage summary naming what could not be answered, and a re-run control against the same plan. Exportable to `.docx` through the Office sub-mode. |
| Durable and resumable | Built in | State lives under `<root>/research/<id>/run.json`; a long run survives restart, and each question is safe to retry individually. |
| Live status per question | Built in | A one-line status expandable to the full trace. |
| Reasoning graph | Built in | The Agent Framework sidecar's own executors and edges, drawn left to right by rank as React Flow nodes. Node colour is the kind of step — plan, research, question, reflect, write — and status is the treatment of that colour: faded for not started, ringed for running, solid for done, grey for skipped. A failure takes the red fill and keeps its kind on the border. Both are `data-kind` and `data-status` in CSS, so a theme change is a cascade. Layout is a pure function of the graph, so a status change never moves a node. The drawing box and the pane grow together with the widest rank, which keeps sixteen questions readable instead of a bar of touching discs. |

*Code:* `packages/core/src/research/`, `apps/renderer/src/Research.tsx`,
`apps/renderer/src/ResearchGraph.tsx`.
*Tests:* `tests/research-service.test.ts`, `tests/research-graph-layout.test.ts`.

## Co-create — Skill Recording

Do a task once by hand; get a skill that repeats it. Four steps — record,
analyse, approve, build — each a separate action, because each has a different
consequence and only one of them leaves the machine.

| Feature | Status | Description |
|---|---|---|
| Versioned capture notice | Built in | The notice text and its version live in the privileged process. The renderer sends back the version it displayed, and capture is refused if it is not the current one. |
| Capture is local, analysis is not | Built in | Recording needs only the acknowledged notice version — nothing is sent anywhere. Analysis is the egress, because it hands window titles, URLs and clipboard previews to a model, so it separately requires a signed-in account and an explicit `contentReviewed` acknowledgement typed as a literal `true`. The two gates are different questions and are asked separately. |
| Identity stamped by the privileged side | Built in | The account credited with the analysis acknowledgement is read from the signed-in session in main. The renderer cannot name it. |
| Input, window, URL and clipboard events | Built in | Collectors fan into one append-only `events.jsonl`: clicks and keystrokes, the foreground window and its title, the URL of the active browser tab, and a bounded preview of clipboard text. |
| Screen capture | Configurable | Off by default. One low-rate video plus extracted stills, so a step can be reviewed as a picture rather than a coordinate. It runs in a hidden window on its own session partition, so granting it video never widens the main window's permissions — the main window denies video throughout. |
| Spoken narration | Configurable | Say what you are doing while you do it. Transcribed on this device by the same `WhisperService` the Meetings surface uses, and aligned to the steps it was spoken over. |
| Markers while recording | Built in | A note can be dropped into the timeline mid-capture, so "this bit matters" survives to the review. |
| Correlation is a pure function | Built in | `correlate()` turns the raw timeline into steps — attaching the nearest frame and the narration spoken over each — with no I/O, so what a recording *means* is unit-testable without a screen. Its output, the `SessionBundle`, is deterministic. |
| Review before anything is built | Built in | Steps can be renamed, reordered, dropped, and values marked as parameters. Feedback re-runs the plan rather than editing the model's output by hand. |
| Builds into what already exists | Built in | A skill is emitted through `SkillStore.propose()` and lands in the same approval queue as an agent-authored one; an automation is registered with the `Scheduler`. Recording gains no private execution path. |
| Derived files are rebuildable | Built in | `bundle.json`, `analysis.json` and `build.json` are all recomputable from `events.jsonl`, `frames/` and `narration.wav`, so any of them can be deleted and re-run. |
| Boot reconciliation | Built in | A recording left open by a crash is closed on the next start. |
| Refusals are audited | Built in | Every rejected start, analysis or build writes the reason, so an attempt to record or analyse without consent leaves a trace. |
| Path traversal refused | Built in | Recording ids are matched against a fixed pattern and frame files against `frame-\d{6}\.jpg`, so neither an index nor a manifest can name a path outside its own directory. |

*Code:* `packages/shared/src/recording.ts`, `packages/core/src/recording/`, `apps/main/src/recording/`, `apps/renderer/src/Recording.tsx`.
*Tests:* `tests/recording.test.ts`.

## Chat — Team (council)

| Feature | Status | Description |
|---|---|---|
| Explicit, editable roster | Built in | 2–6 members chosen before the run, each with a name, a stance or role brief, a model and an optional skill or MCP grant. Preset councils ship, and a roster can be saved. |
| A distinct chair | Built in | The chair is not a member. It restates the question and decision criteria, orders the rounds, prevents repetition, calls the debate when positions stop moving or the budget is spent, and writes the verdict. |
| Rounds as the unit of progress | Built in | Opening statements → rebuttals → convergence → verdict, against a round budget set before the run and shown as progress. |
| Round-boundary human control | Built in | `inject`, `forceVerdict` and `cancel` act only at a round boundary, so a member's turn is never torn in half. |
| Legible transcript | Built in | Each contribution is a card with member, stance, model and a one-line summary, expandable to the full argument and its tool calls. Rounds are grouped and collapsible. |
| Structured verdict | Built in | Recommendation, decision criteria, strongest argument for and against, attributed dissent, confidence and open questions — parsed against a schema, not free prose. |
| Exportable and citable | Built in | With a project bound, the verdict is written into it as Markdown and indexed. |
| Cost visibility and budget | Built in | A live per-run estimate, and the round budget is required up front. |
| Grants can only narrow | Built in | A member cannot hold a broader tool grant than the user's own session. |
| Audited per member turn | Built in | Role, model and round number on every record. |
| Runs without a project | Built in | Team mode may run unbound; the verdict is then held in the session. |
| Seats read as people | Built in | Each member carries an avatar tinted from a hash of its name, so the same member looks the same in the roster, in every round and in the verdict. |
| A worked example | Built in | **Load sample** fills a genuinely debatable question, three stances written to conflict, and a round budget. It fills the form and stops — nothing runs until the user says so. |

*Code:* `packages/core/src/council/`, `apps/renderer/src/Council.tsx`.
*Tests:* `tests/council-service.test.ts`.

## Knowledge graph and vault

| Feature | Status | Description |
|---|---|---|
| The vault is the corpus root | Built in | The graph is built over a curated **vault** — an Obsidian-style isolated directory of notes and media — not over the project, so intermediate files the agent writes never become nodes. |
| Choosing the vault is a first-class control | Built in | A directory picker and a reset control in the Knowledge surface. Selection is audited, invalidates the cached index and triggers a reindex. |
| No write grant | Built in | Choosing a vault grants no write access; the agent's file boundary is still the project navigator's tree. |
| Vault boundary safety | Built in | Stored as a realpath, never a symlink, and refused when it is the app's state root or an ancestor of it. |
| Project fallback | Built in | With no vault chosen the graph indexes the project, so an install that never touches the setting behaves as before. |
| Link grammar | Built in | `[[wiki links]]`, inline markdown links to local files and `#tags` become edges; a link with no target becomes a `missing` node rather than being dropped, so broken references stay visible. |
| Skills in the graph | Built in | Every installed skill is a node, so a skill's coverage of the corpus is visible. |
| Bounded scanning | Built in | At most 4000 files, 1 MB per file, 8 directory levels; symlinks are refused and every path is re-checked to be inside the chosen root. |
| Zoom and pan | Built in | Scroll or pinch to zoom, drag to pan, zoom-to-fit and zoom-to-selection. |
| Grouping and legend | Built in | Nodes are grouped and coloured by source folder or collection, with a visible legend. |
| Provenance on nodes and edges | Built in | Source file or artifact, the vault it was read from, how it was extracted and when it was last indexed. |
| Reveal in navigator | Built in | Selecting a node reveals its source and opens the underlying artifact in the canvas — when the vault sits inside the project. |
| Graph and table views | Built in | Two views over the same index. There is no third file browser: the navigator is the file view. |
| Search and detail | Built in | Ranked title/tag/body search, and a node view with excerpt, outgoing links and backlinks. |
| Governed tools | Built in | `knowledge_search`, `knowledge_node` and `knowledge_reindex`, family `knowledge`, all read-risk; results are marked untrusted so indexed text cannot be treated as instructions. |
| Persisted index | Built in | Written atomically to `knowledge/graph.json` and rebuilt in the background at startup; each rebuild writes an audit record. |

*Code:* `packages/core/src/knowledge/`, `apps/renderer/src/Knowledge.tsx`.
*Tests:* `tests/knowledge-graph.test.ts`, `tests/knowledge-vault.test.ts`.

## Built-in browser

| Feature | Status | Description |
|---|---|---|
| In-app pane | Built in | A main-process `WebContentsView` positioned over a rectangle the renderer reports. The renderer keeps `webviewTag: false` and its `default-src 'none'` CSP — no remote content is ever loaded into the application window itself. |
| No host allow-list | Built in | Pages generally reachable in a normal browser are reachable here. Only `https:` is required. |
| Deny-list for known-malicious hosts | Configurable | Tenant policy may deny named hosts or disable the pane outright; it cannot impose a general-purpose allow-list. |
| Every hop re-checked | Built in | `will-navigate`, `will-redirect` and window-open requests run the same check, so a redirect cannot slip past the deny-list. |
| Isolated session | Built in | Its own partition, no preload, no Node integration, downloads cancelled, and media/geolocation/clipboard/notification permissions denied. |
| Navigation cannot escape the pane | Built in | Navigation events are contained; they never reach the application window. |
| Agent control of the pane | Built in | Thirteen tools in family `browser`. External risk: `open_browser_pane`, `read_browser_page`, `browser_elements`, `browser_click`, `browser_fill`, `browser_select`, `browser_press_key`. Write risk: `browser_go_back`, `browser_go_forward`, `browser_reload`, `browser_scroll`, `browser_wait_for`, `close_browser_pane`. Reading is a separately approved call that returns capped, untrusted text; the acting verbs are confirmed individually and are outside every auto-approvable safe set. |
| Host-only audit | Built in | Navigation and read records store the host, never the full URL, because paths and queries carry tokens. |
| Bot walls are their own outcome | Built in | A CAPTCHA, an interstitial or a rate-limit notice is reported as a challenge — not as a failure to retry, and not as page content to read. The host is then refused for the rest of the session, so one wall costs one challenge instead of a loop. The remedy is named and it is the user's: the page is open in their pane and they can solve it there. |

*Code:* `packages/core/src/browser/`, `apps/main/src/browser-pane.ts`, `apps/renderer/src/BrowserPane.tsx`.
*Tests:* `tests/browser-url-policy.test.ts`, `tests/browser-challenge.test.ts`.

## MCP

| Feature | Status | Description |
|---|---|---|
| Nothing connects automatically | Built in | A server is added, inspected and enabled by hand; no server is contacted at boot without an explicit enablement. |
| Inspect before grant | Built in | The advertised tool list is shown before any tool becomes callable. |
| Approval per tool name | Built in | A grant names an individual tool, not a server, so a server that later advertises a new tool does not gain it silently. |
| Deny floor | Built in | `gate()` refuses any tool that is not currently granted, ahead of the permission chain. |
| Same governance as built-in tools | Built in | MCP tools enter the same registry, policy, approval and audit path. |
| Full lifecycle from the UI | Built in | Add, edit, enable, disable and remove a server, with changes persisted atomically and audited. |
| Catalog of Microsoft servers | Built in | Prefilled entries carrying the prerequisite and the reach being agreed to. Adding one lands an inert server; it is documentation with a form attached, not a grant. |
| Catalog contents | Built in | Three entries: **Power BI modeling** (`npx -y @microsoft/powerbi-modeling-mcp --start`), **Work IQ** (`npx -y @microsoft/workiq mcp`) and **MarkItDown** (`markitdown-mcp`, installed first with `uv tool install markitdown-mcp`). |
| Seeded servers | Built in | Ids in `MCP_SEEDED_SERVER_IDS` are registered on first load in the inert state — disabled, never inspected, nothing approved. The seeding is recorded, so a server the user removes stays removed. Power BI modeling and Work IQ are seeded; MarkItDown is not, because it can read any file this process can. |
| Launching a stdio server | Built in | `shell: false` with an explicit argument list, so a command from a settings field can never become a command line. The command is resolved against `PATH` and `PATHEXT` first, and an npm batch shim is run as `node <its script>`. |

*Code:* `packages/core/src/mcp/registry.ts`, `packages/core/src/util/executable.ts`, `apps/renderer/src/Mcp.tsx`.
*Tests:* `tests/mcp-registry.test.ts`, `tests/executable-resolution.test.ts`.

## Co-create — Fabric

| Feature | Status | Description |
|---|---|---|
| Project registration | Built in | One project GUID, reached with the Azure identity. No key field exists. |
| Grounded on the upstream bundle | Built in | Runs read `microsoft/skills-for-fabric` as resolved on the machine — an explicit setting, `IQ_FABRIC_SKILLS`, the copy `pnpm prepare:fabric-skills` downloaded, or a GitHub Copilot CLI plugin install. A run without it is refused rather than guessed at. |
| The whole bundle is visible | Built in | Skills, agents, shared `common/` references and each bundle's declared version and MCP servers are listed read-only under **Skills**. |
| Three governed tools | Built in | `fabric_list_items` (read), `fabric_create_item` (write) and `fabric_ask_data_agent` (read). Anything workload-specific belongs in the upstream skills. |
| What a run created | Built in | Read back by diffing the item list before and after, never taken from the agent's own account of itself. |
| Source files are an allow-list | Built in | Ticked files, never a folder: a pipeline pointed at a directory ingests whatever happens to be in it. |

*Code:* `packages/core/src/fabric/`, `apps/renderer/src/Fabric.tsx`.
*Tests:* `tests/fabric-skill-pack.test.ts`.

## Chat — Data agent

| Feature | Status | Description |
|---|---|---|
| Its own connection | Built in | Registered separately from the Fabric workspace, because the two are separately obtainable: a published agent can be handed to someone with no rights on the workspace around it. |
| Two routes to one endpoint | Built in | **In a project** takes the agent's item GUID and composes the URL; **published URL** takes it verbatim. Both dial the same API with the Azure identity. |
| Distinguishes unconfigured from unaddressable | Built in | A project-mode connection with no project to compose from reports `needs a project`, not `not connected` — the user did their part and the remedy is elsewhere. |
| Reachability is a real question | Built in | *Test* asks the agent to answer, because a probe that only resolved DNS would call an agent reachable whose thread route rejects the token. |
| Traces always shown | Built in | The tool calls behind an answer are listed with it, never behind a toggle: the answer is a claim about the user's own warehouse made by queries they did not write. |
| Answers are untrusted content | Built in | Rendered as text. Nothing in an answer is executed, followed or turned into a tool call. |

*Code:* `packages/core/src/fabric/data-agent.ts`, `packages/core/src/fabric/registry.ts`, `apps/renderer/src/DataAgent.tsx`.
*Tests:* `tests/fabric-data-agent-connection.test.ts`.

## Meetings

| Feature | Status | Description |
|---|---|---|
| Versioned recording notice | Built in | The notice text and its version live in the privileged process. The renderer sends back the version it displayed, and capture is refused if it is not the current one — a changed notice must be read again. |
| Attributable consent | Built in | Capture requires a signed-in account. The consent record stores who acknowledged it, in which tenant, when, and which sources were chosen. There is no code path that starts a capture without a stored `RecordingConsent`. |
| Explicit participant confirmation | Built in | `participantsInformed` is typed as a literal `true`; a request cannot type-check or parse without it. |
| Refusals are audited | Built in | Every rejected attempt writes `meeting.capture_refused` with the reason, so an attempt to record without consent leaves a trace rather than nothing. |
| Microphone and system audio | Partly built | The microphone is captured by the renderer and both sources mix into one track. System audio is offered only when the `iq-audio` sidecar resolves; otherwise the source is disabled with the remedy attached and is stripped from what is sent. |
| Chunked upload | Built in | Audio is handed to the privileged side every 5 seconds and appended to disk, so a crash loses seconds rather than a meeting. |
| Azure AI Speech transcription | Configurable | Fast transcription with diarization; segments carry speaker, start and end. Audio never leaves the device except to the tenant's own Speech resource. |
| Audio discarded unless kept | Built in | `retainAudio` defaults to `false` in the service, so a consent entry that says nothing about retention gets deletion: on a successful transcription the audio file is deleted and the deletion is audited. Retention is a per-meeting choice, offered pre-selected in the panel. Audio is deliberately kept when transcription *fails*, so a retry is possible. |
| Retry transcription | Built in | A failed transcription can be retried from the retained audio without re-recording. |
| Notes from a transcript | Built in | The `meeting-notes` skill produces summary, decisions, actions and open questions. The note-writing turn runs with **no tools at all**, because a transcript is untrusted input. |
| Boot reconciliation | Built in | A meeting left `recording` by a crash is closed on the next start rather than accepting audio forever. |
| Non-dismissable indicator | Built in | While a capture runs the UI shows an unconditional recording pill; someone walking past the screen can tell the room is being recorded. |
| Always-present record control | Built in | A sticky bar carries the state (`Ready` / `Starting` / `Recording` / `Saving`), a timer, and one button that both starts and stops. When recording is impossible the button is disabled with the reason attached rather than hidden, so "not available" reads differently from "not built". |
| Screen recording | Elsewhere | Meetings captures audio only. Screen capture belongs to *Co-create → Skill Recording*, where the point is to learn a task rather than to minute a conversation. A screen recording made with any other tool becomes a transcript through **Transcribe a file…**. |
| System audio on Windows | **Implemented** | A browser engine cannot capture desktop audio on Windows — `getDisplayMedia` audio is tab-scoped. `native/iq-audio` (a cpal/WASAPI sidecar) is built by `pnpm prepare:audio`, resolved like FFmpeg, and driven from `packages/core/src/media/audio.ts`. It owns the recording file: meeting capture no longer runs in the renderer, and no audio crosses the IPC boundary. The cost is that there is no echo cancellation — the renderer's `getUserMedia` supplied it — so recording microphone and system together on speakers picks the far end up twice; the Record tab says so. |

*Code:* `packages/core/src/meetings/meetings.ts`, `packages/core/src/media/audio.ts`, `native/iq-audio/`, `apps/renderer/src/meetings.tsx`, `skills/meeting-notes/`.
*Tests:* `tests/meetings.test.ts`, `tests/e2e/cocreate-surfaces.e2e.ts`.

## Voice and Azure AI Speech

| Feature | Status | Description |
|---|---|---|
| Push-to-talk | Built in | Hold to record, release to transcribe into the composer. The clip is held in the renderer until release, so a cancelled press leaves nothing anywhere. |
| Spoken replies | Built in | Any assistant message can be read aloud; one player at a time, and the object URL is revoked on stop. |
| Identity-only authentication | Built in | Speech is called with an Entra bearer token acquired for the `azure.speech` capability. Resource keys are not supported and have no representation in the code or on disk, so a tenant that forbids key authentication is the supported case rather than a limitation. |
| Register a resource in place | Built in | *Connections & access* → **Add Speech resource** takes a display name, the resource's **custom domain endpoint** (`https://‹name›.cognitiveservices.azure.com`) and a locale. A custom-domain resource routes REST calls differently from regional endpoints, so the app accepts this one resource-base form; it does not claim that every regional Speech API rejects Entra tokens. Editing re-points the entry and clears the prior verification; **Remove** unregisters it. Registration and removal are audited by host, never by full URL. |
| Network requirement | Built in | IQ Compiler stores no resource key and calls the custom-domain Speech endpoints with an Entra bearer token. Per the Speech private-endpoint guidance this requires Networking → **All networks**. Selected or private networks require `Ocp-Apim-Subscription-Key` for the special STT/TTS endpoints, so the Test control reports the bearer rejection with that exact remedy rather than suggesting a role that is already assigned. |
| No voice picker | Built in | The synthesis voice is not asked for. It is a Speech catalogue identifier, so a free-text box registers a typo cleanly and then fails at the first spoken reply — the failure this panel exists to move earlier. Registrations take the default voice; `IQ_SPEECH_VOICE` overrides it for a host, and `speech:synthesize` accepts one per request. An existing voice survives an edit. |
| Connection check | Built in | The Speech card shows the endpoint and locale, and a **Test connection** control that performs a voice-list round-trip on that endpoint and reports reachable / unauthorized / not found / failed / not configured with the next step and a last-tested timestamp. |
| Policy-aware reporting | Built in | When tenant policy denies the Cognitive Services scope the card says so explicitly instead of reporting a network failure. |
| Inert without a registration | Built in | With no Speech resource the service reports `not_configured` and the voice controls do not render. A dead microphone button is worse than none. |
| Bounded payloads | Built in | One audio payload is capped at ~12 MiB and validated as real base64 in main; synthesis is capped at 4,000 characters and truncated rather than rejected. |
| Environment fallback | Built in | `IQ_SPEECH_ENDPOINT` registers the same resource for a headless host and is reported as non-editable. `IQ_SPEECH_KEY` is not read. |

*Code:* `packages/core/src/speech/speech.ts`, `packages/core/src/speech/registry.ts`, `apps/renderer/src/audio.ts`, `apps/renderer/src/panels/connections.tsx`.
*Tests:* `tests/speech-connection.test.ts`.

## Connections & access

| Feature | Status | Description |
|---|---|---|
| One canvas tab | Built in | The single place the user sees what the app can reach, opened as a canvas tab like any other surface. |
| Identity | Built in | The Azure account, the active tenant with a switch control, and the GitHub Copilot connection, each with status, last-verified time and a re-verify action. |
| Microsoft Foundry | Built in | The model registry — endpoints, deployments, agents, capability sets, per-project scope and the per-entry Test with its last-tested timestamp. The only place it is edited. |
| Azure AI Speech | Built in | Add, edit and remove the Speech resource in place — display name, custom domain endpoint and locale — plus the Test control. Access is the Azure identity; no key is asked for or stored. |
| Microsoft 365 and Work IQ | Built in | The capabilities currently granted, when each was last used, and a revoke control. |
| Tool sources | Built in | MCP servers, skills, OfficeCLI and the browser, each with its enablement state and approved tool families. |
| Every change audited | Built in | Grants, revocations, tests and tenant switches all leave records. |

*Code:* `apps/renderer/src/panels/connections.tsx`, `apps/renderer/src/App.tsx`.

## Desktop application and UI

| Feature | Status | Description |
|---|---|---|
| Sandboxed renderer | Built in | `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webviewTag: false`. The preload is bundled into one self-contained file so the sandbox can stay on. |
| Typed IPC contract | Built in | 202 request channels and 25 push channels. Each request channel carries a zod schema and an unknown channel throws rather than passing through; the push direction is a type map, not a runtime guard, because main → renderer never needed one. |
| Main-process handlers | Built in | Registration is split by area across `apps/main/src/ipc/` — `context`, `workspace`, `knowledge`, `authoring`, `capture` and `fabric` over a shared `index`. A mapped type makes an unhandled channel a compile error. |
| Double validation | Built in | Arguments are validated in the preload and re-validated in main — the renderer is never trusted. |
| Icon rail navigation | Built in | A persistent left rail carries the mode switch pinned at the top, sub-modes and destinations below it, and account plus settings at the bottom. There is no application-level top tab strip. |
| Rail expansion overlays | Built in | Expanding the rail overlays the chat panel; it never adds or resizes a column. |
| Rail entries explain themselves | Built in | Every rail entry carries the one-line `detail` from `mode.ts` beneath its label. The line is clamped to one row and the entry's tooltip carries label and detail in full, so a long description never costs the list a row. |
| Three panes in Co-create | Built in | Icon rail · chat · canvas · project navigator, with the canvas the largest pane. There is no fourth column. |
| One tab concept | Built in | The canvas tab strip holds open artifacts *and* every secondary surface — knowledge, browser, skills, MCP, the Office preview, the image surface, the research plan, Connections & access, and Control Center's destinations. Selecting a rail destination opens a canvas tab. |
| Type-aware viewers | Partial | Markdown and code open in a viewer with line numbers and a Source / Preview toggle; images open in a fit-to-pane viewer; Office artifacts get the live OfficeCLI preview. Paged PDF/document view with a thumbnail rail, the per-worksheet spreadsheet grid and the HTML Code/Preview toggle are not implemented. |
| Artifact history | Not built | The canvas header has no snapshot-and-history or revert control; artifact versioning is not implemented. The audit log remains the governance record. |
| Read-only previews say so | Built in | The Office preview shows a `generating · read-only` pill and warns that opening the file in its own application mid-run locks it. |
| Layout owned by the container | Built in | Each pane declares a minimum width and either a fixed width or a flex weight; the container distributes remaining space and never lets a pane fall below its minimum. Panes are `min-width: 0` flex children with internal scrolling, so a wide table or long path scrolls inside its pane instead of widening it. |
| Two-pane drag resize | Built in | Dragging a divider moves space only between the two adjacent panes; the rest keep their width exactly. |
| Persisted widths | Built in | Widths persist per project and are restored on reopen; restored widths that no longer fit fall back to the default distribution rather than producing sub-minimum panes. |
| Priority collapse | Built in | When the total minimum exceeds the window, panes collapse by priority — navigator first, then chat — rather than squeezing all three. At the narrowest width the layout becomes a single pane with a chat ⇄ canvas toggle. |
| Permanent side panel | Built in | The session sidebar is always displayed; there is no hide control for it, and the word "Collapse" appears nowhere in the UI. |
| Chat landing surface | Built in | Chat's empty state is a centred greeting, one composer, an optional project scope selector and a small grid of starter assistants — not a dashboard. |
| Composer footer | Partial | Attachments, model and voice controls sit in one footer row rather than scattered around the page; the approval control described in the design is not there yet. |
| Inline approval cards | Built in | Permission requests render in the transcript with the summary, scopes and resources, and four answers (allow, allow always, deny, deny always). |
| Tool calls as compact cards | Built in | Command or arguments, a success/failure indicator, and long output collapsed behind an expander. |
| Design tokens | Built in | Colours are CSS custom properties defined once per scheme and consumed through role tokens; components never hardcode a hex value. Tints are produced with `color-mix` against an existing token. |
| Light default, dark option | Built in | Light is the `:root` default; dark is a `[data-theme='dark']` override of the same token names, so no component branches on the active theme. |
| Monochrome visual language | Built in | Palette, typography, radius and elevation are quiet, with colour reserved for state. Role token names are canonical and earlier names are thin aliases over them. |
| `lucide-react` only | Built in | One icon library, one import path, a 16/20/24 size scale, sized and coloured by token. Icon-only controls carry an accessible name and a tooltip. |
| Motion | Built in | Short easing-based transitions on hover, selection, pane resize, tab switching and message arrival, plus a streaming indicator and skeleton states. No animation library. |
| Renderer diagnostics | Built in | Console errors, failed loads, preload errors and renderer crashes are surfaced on the main process's stderr, where they are otherwise invisible. |
| Startup screenshot check | Built in | `IQ_CAPTURE_TO=<path>` writes a PNG of the painted window, proving the UI rendered rather than only that the process started. |
| Navigation containment | Built in | `setWindowOpenHandler` and `will-navigate` deny in-app navigation and hand the URL to the real browser. |
| Audio-only media grants | Built in | The main process answers Chromium's permission and display-media requests itself: microphone and loopback **audio** are granted, video and every other permission refused. A sandboxed renderer cannot widen this. |
| Live push updates | Built in | Turn events, session index, auth status, job runs, plan updates, skill changes, knowledge changes, browser changes, meetings, memories, model changes, Office mutations, image runs, research, council and project changes all stream to the UI. |
| Graceful degradation | Built in | An absent Work IQ endpoint, an unconfigured Speech resource or a runtime that fails to start are each reported in the UI without preventing boot. |
| Local-first storage | Built in | Sessions, turns, skills, memories, plans, jobs, runs, models, MCP servers, research runs and audit are files under the Electron user-data directory. Nothing is sent anywhere but Microsoft endpoints and the Copilot runtime. |
| Atomic writes | Built in | Write-then-rename for documents that must not be observed half-written. |

*Code:* `apps/main/`, `apps/preload/`, `apps/renderer/`, `packages/shared/src/ipc.ts`.

---

## Verification

```powershell
cd iq-compiler
pnpm typecheck                     # shared, core, myiq-mcp, preload, main — NOT the renderer
pnpm --filter @iq/renderer build   # the only renderer typecheck
pnpm run build                     # shared → core → preload → myiq-mcp → renderer → main
pnpm test                          # 817 tests across 69 files
pnpm test:e2e                      # 11 Playwright files over the real window; needs pnpm build first
```

At startup the app registers 33 governed tools across 7 families:
`agent.memory` (1), `agent.orchestration` (2), `agent.skills` (1), `browser`
(13), `fabric` (3), `knowledge` (3) and `office` (9). Two more join in the
`workiq` family once a Work IQ endpoint is configured, plus every individually
approved MCP tool in the `mcp` family. There are no Microsoft Graph tools:
Microsoft 365 data is reached only through the Work IQ MCP server.

Three of those families are conditional on the install rather than on a
credential: `browser` needs the pane, `knowledge` needs
`knowledgeGraphEnabled` in tenant policy, and `workiq` needs an endpoint. The
`fabric` tools register unconditionally and refuse with a message naming the
fix, because an agent that cannot see the capability exists gives a worse
answer than one that can name what is missing.

---

## Current gaps

These gaps belong to the current application.

| Gap | Notes |
|---|---|
| No scoped auto-approval control | The design calls for session- and project-scoped, expiring auto-approval of a named safe tool set in the composer. Only the older per-family "always" session rule exists. |
| No artifact history | Snapshot, version list and revert in the canvas header are not implemented, so the audit log is currently the only record of what an agent changed in a file. |
| Viewer coverage | Markdown, code, images and the Office live preview are covered; paged PDF with a thumbnail rail, a per-worksheet spreadsheet grid and an HTML Code/Preview toggle are not. |
| Microsoft 365 breadth | Four tools against nine consented capabilities; files, sites, people and Teams have no tool surface. |
| IQ Workflow runs nothing, by design | It is a conceptual modeller: a diagram describes how work happens and nothing on the canvas executes. There is no `flow:*` IPC family, and diagrams live in the renderer's `localStorage`. See [`08-product-ready.md`](08-product-ready.md#1-iq-workflow). |
| My IQ reads fixtures | The analysis is real and deterministic; its input is 26 seeded cells plus the bundled industry primers, not the user's own IQ Cells. See [`08-product-ready.md`](08-product-ready.md#2-my-iq). |
| Connectome IQ lists fixtures | Every IQ on the hub but your own card is defined in `apps/renderer/src/samples/sharedIq.ts`. Nothing is fetched, nobody else's IQ arrives, and the tool console answers from the fixture. The surface says so. |
| Renderer has no component tests | There is no jsdom or testing-library dependency, so UI surfaces — including the pane-sizing rules and the Speech card — are verified by build, typecheck and manual run only. |
| Foundry agents are untested against a live agent | The entry shape and call path exist; there is no automated coverage of calling a published Foundry agent. |
