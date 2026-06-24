# NEXUS — Claude Code Project Guide

Multi-agent AI orchestration platform. **110-package TypeScript monorepo** (pnpm workspaces + Turbo).
BYOK: bring-your-own LLM keys; no data leaves the deployment.

## Toolchain (must match)

- **Node**: 20.x (repo pins `20.19.0` in `.nvmrc`; engines require `>=20.18.0`)
- **pnpm**: 9.x (`packageManager: pnpm@9.14.4`). Always use `pnpm`, never `npm`/`yarn`.
- **Turbo**: orchestrates all cross-package tasks.
- Infra deps for runtime: PostgreSQL (pgvector) + Redis (BullMQ) via Docker Compose.

## Layout

```
apps/
  api/        Fastify HTTP/SSE/WebSocket gateway (61 route modules)
  cli/        Developer CLI (commander.js)
  docs-site/  Docusaurus
  ingest-py/  Python ingest helpers
  ui/         React Router v7 SPA (100+ routes)
  worker/     BullMQ workers (signal/task/repeatable feed jobs)
packages/     110 scoped @nexus/* packages (council, llm-drivers, agent-runtime,
              memory, runtime, mcp-client, code-repl, gateway, retrieval, ...)
services/ingest  Python ingest service
```

Packages are workspace deps referenced as `@nexus/<name>` with `workspace:*`.

## Common commands (run from repo root)

| Task | Command |
|---|---|
| Install | `pnpm install` |
| Build all | `pnpm build` (`turbo run build`) |
| Dev (all, watch) | `pnpm dev` |
| Test all | `pnpm test` |
| Unit tests | `pnpm test:unit` |
| Typecheck | `pnpm typecheck` |
| Lint | `pnpm lint` / `pnpm lint:fix` |
| Format | `pnpm format` |
| DB migrate | `pnpm db:migrate` |
| Infra up | `docker compose up -d postgres redis` |

**Scope to one package** (much faster — do this when working on a single package):
```
pnpm --filter @nexus/council test
pnpm --filter @nexus/council typecheck
turbo run build --filter=@nexus/council
```
Per-package scripts: `build` (tsc), `dev` (tsx watch), `typecheck` (tsc --noEmit),
`lint` (eslint src/), `test` (vitest run).

## Conventions

- TypeScript strict; ESLint (flat config) + Prettier. Run `pnpm lint:fix` before committing.
- Tests: **Vitest** (unit/integration), **Playwright** (e2e/a11y, see `playwright.config.ts`).
- Every source file carries an SPDX license header (`Apache-2.0`); `pnpm check:headers` verifies.
- Commits: Conventional Commits (commitlint + Husky pre-commit hooks run lint-staged).
- Turbo tasks declare `dependsOn: ["^build"]` — building a package builds its deps first.

## Working effectively here

- This repo is large. **Prefer `pnpm --filter` / `turbo --filter` to a single package** instead of
  whole-repo runs unless a change is cross-cutting.
- Before editing a package, read its `src/` and co-located tests; mirror existing patterns.
- `.env.example` is the full env reference — copy to `.env` for local runs.
- Don't commit unless asked. When you do, branch first (don't commit to `main`).
