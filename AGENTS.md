# IQ Compiler

- Electron + React/TypeScript desktop app; GitHub Copilot SDK agent runtime. Node ≥22; pnpm 10.32.0.
- `apps/`: privileged main process, sandboxed preload, renderer. `packages/core`: services/governance; `shared`: contracts; `myiq-mcp`: published My IQ snapshot server.
- Preserve renderer isolation, validated IPC, permission/approval gates, and audit logging. Never bundle credentials or user runtime data.
- IQ Workflow models/exports diagrams; it does not execute workflows. My IQ analysis and Connectome IQ use demo fixtures, not live organizational telemetry.
- Preserve this distribution's two Industry primers: Software and IT Consulting. Check with `pnpm industry:limit:check`.
- Validate with `pnpm build` then `pnpm test`; use `pnpm test:e2e` for UI changes. `pnpm typecheck` alone excludes the renderer.
- Launch: `pnpm start`. Package: `pnpm package`. Do not hand-edit generated build or release output.
- Record unverified premises in [UNCONFIRMED_ASSUMPTIONS.md](UNCONFIRMED_ASSUMPTIONS.md) before implementation.
- Consult [architecture](docs/01-architecture.md) and [product limits](docs/08-product-ready.md); verify documentation against code.