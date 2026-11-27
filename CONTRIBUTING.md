# Contributing to FlagGuard

Thanks for your interest! FlagGuard is a TypeScript monorepo using npm workspaces.

## Setup

```bash
npm install
npm run check   # format:check, lint, typecheck, test
```

Requires Node.js 22 or newer.

## Workflow

1. Create a branch from `main`.
2. Make your change **with tests**. Core logic is tested against the in-memory
   `FakeFlagsmith` (`@flagguard/core/testing`), so no Flagsmith account is needed.
3. Run `npm run check`.
4. Open a pull request describing _why_ the change is needed.

## Conventions

- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat(core): …`, `fix(cli): …`, `docs: …`, `test: …`, `chore: …`, `ci: …`.
- **Layering:** `HttpClient` → `FlagsmithClient` → `FlagService` → engines → adapters.
  Lower layers never import higher ones. See [docs/architecture.md](docs/architecture.md).
- **Side effects are injected** (`fetch`, clocks, loggers), so everything is testable.
- **Safety first:** any new agent action must be added to `AGENT_ACTIONS` and classified
  as risk-reducing or risk-increasing in `RISK_INCREASING_ACTIONS`.
- Prefer explicit, typed errors (`FlagGuardError` subclasses) over generic `Error`.
