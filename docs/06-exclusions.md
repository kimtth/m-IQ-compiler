# Explicit exclusions

IQ Compiler is scoped to Microsoft products, Microsoft 365, Microsoft Foundry,
Work IQ and Entra ID. This document names what is out of scope so that "not
built yet" and "not in scope" are never confused.

## Non-Microsoft integrations (excluded by scope)

| Excluded | Microsoft path taken instead |
|---|---|
| Google OAuth, Gmail, Google Calendar, Google Drive | Entra ID + Microsoft Graph (mail, calendar, files) |
| Slack | Microsoft Teams via Graph, if and when added |
| WhatsApp, Telegram | none |
| Composio and its connector catalogue | first-party Graph and Work IQ tools |
| Fireflies, Granola (meeting capture) | Meetings — local capture with Azure AI Speech transcription |
| X / Twitter search | none |
| Home Assistant, Spotify | none |
| Discord | none |

## Non-Microsoft model providers (excluded by scope)

Anthropic, OpenAI, OpenRouter, Ollama, Nous Portal and similar direct provider
integrations are out of scope. IQ Compiler uses the GitHub
Copilot SDK as its only agent runtime, as directed by `AGENTS.md`. Microsoft
Foundry is the intended path for any additional model surface.

## Non-Microsoft developer platforms (excluded by scope)

GitLab, Bitbucket, Gitea, Linear and Jira integrations are excluded. Azure DevOps and GitHub are the supported directions.

## Excluded infrastructure and runtime models

- **Multi-CLI agent support** (Claude Code, Codex, Gemini CLI, Amp,
  Cursor as interchangeable backends). IQ Compiler has one runtime by design;
  interchangeable agent backends would make the governance chain
  backend-specific.
- **Hosted gateway or relay backend.** IQ Compiler runs the agent runtime
  locally. A hosted relay would move tokens and retrieved content off the
  user's machine, which the local-first, audited design specifically avoids.
- **Python runtime and OpenAI-compatible API server.** IQ Compiler is
  TypeScript end to end, and exposing an API server would create a second
  entry point that bypasses the Electron permission UI.
- **Headless web search and fetch APIs.** A search-API or fetch-API integration
  is excluded as an unbounded untrusted-content intake with no Microsoft
  identity boundary. Reaching the open web is not excluded: the built-in browser
  does it, with no host allow-list, under the tenant deny-list, one governed
  tool per verb, host-only audit and capped untrusted text. Work IQ and Graph
  remain the sanctioned paths for the user's own work.
- **Arbitrary third-party MCP servers.** The plumbing exists in the runtime, and
  the suggestion catalog lists Microsoft-published servers only — Power BI
  modeling, Work IQ and MarkItDown. A catalog entry is a prefilled form, not a
  grant: it lands disabled with nothing approved, and every tool still
  goes through inspection, per-tool approval and the same consent gate as
  everything else. A non-Microsoft server can still be added by hand — that is
  the user's decision to make and it is audited — but the product does not
  suggest one.
- **CLI automation for a running Obsidian desktop instance.** This would drive a
  third-party CLI over a *running* Obsidian desktop instance, and its plugin and
  theme commands run arbitrary JavaScript in that instance. That is an external
  prerequisite the product does not ship, a second write path into the vault
  outside the project boundary, and an ungoverned subprocess. The three format
  bundled vault-format skills (`obsidian-markdown`, `obsidian-bases`,
  `json-canvas`) need no CLI: the app writes vault formats directly, inside the
  project navigator's tree.
- **Global article-extraction subprocess.** Clean article extraction is
  genuinely useful, but the skill requires `npm install -g defuddle` and a shell
  call, and the capability already exists: the built-in browser's page-read verb
  returns capped text, explicitly labelled untrusted, audited host-only, and
  individually approved. Adding a second, ungoverned intake path for the same
  content would put untrusted web text into the model outside that chain.
- **`@playwright/mcp` as a running MCP server.** Attaching it to the
  pane's browser means opening a CDP debugging port on a profile the user has
  signed in to, which any local process could then drive. Attaching it to its
  own browser means a second cookie jar, which defeats the entire point of one
  shared pane. Playwright's semantics — locators, actionability waiting, the
  `Input.insertText` path that carries IME-composed text — are used directly in
  the main process instead, where every verb enters the governed tool registry,
  the approval path and the audit log like any other tool.
- **A hand-written verb set over Electron's `webContents.debugger`** (option A′
  in the design discussion). It avoids a second process, but reimplements
  element addressing, actionability waiting, frame and shadow-DOM traversal, and
  a long tail of verbs that Playwright already maintains — and Electron exposes
  only a subset of CDP. The maintenance asymmetry decided it.

## Capabilities not built (in scope, not excluded)

These are Microsoft-compatible and remain candidates. They are not listed again
here, because a second list drifts from the first: the current set is the
**Current gaps** table in [`07-reference-features.md`](07-reference-features.md),
and the surfaces that exist but do no work are in
[`08-product-ready.md`](08-product-ready.md).

OfficeCLI is no longer among them. It is a governed tool family of nine `office`
tools, invoked through the permission chain rather than the runtime's shell
tool, and a pinned version is installed by the app when none is on PATH.
