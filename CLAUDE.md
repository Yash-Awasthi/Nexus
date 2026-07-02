# NEXUS — Claude Code Project Guide

Multi-agent AI orchestration platform. **110-package TypeScript monorepo** (pnpm workspaces + Turbo).
BYOK: bring-your-own LLM keys; no data leaves the deployment.

## Active work — start here

- **Plan / spec:** [ROADMAP.md](ROADMAP.md) — forward-only execution spec. Work items are `N.k`
  (Files / Do / Done), fork-free, sequenced under **Order of work**. Its **Execution protocol** is
  authoritative for _how_ to work: inline only (no workflows/subagents/parallel), one item per
  commit, the checkpoint-commit + PROGRESS-update cadence, and the build/test gotchas.
- **Resume state:** [PROGRESS.md](PROGRESS.md) (gitignored) — the "Now / Next / Shipped" pointer;
  its format is defined in ROADMAP.md. **Read PROGRESS.md first when resuming**, then ROADMAP.md.
- Executing the roadmap? Follow it as written and **don't re-audit the codebase to confirm facts
  already stated there** — the paths / shipped-state are current; act on them.

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

| Task             | Command                               |
| ---------------- | ------------------------------------- |
| Install          | `pnpm install`                        |
| Build all        | `pnpm build` (`turbo run build`)      |
| Dev (all, watch) | `pnpm dev`                            |
| Test all         | `pnpm test`                           |
| Unit tests       | `pnpm test:unit`                      |
| Typecheck        | `pnpm typecheck`                      |
| Lint             | `pnpm lint` / `pnpm lint:fix`         |
| Format           | `pnpm format`                         |
| DB migrate       | `pnpm db:migrate`                     |
| Infra up         | `docker compose up -d postgres redis` |

**Scope to one package** (much faster — do this when working on a single package):

```
pnpm --filter @nexus/council test
pnpm --filter @nexus/council typecheck
pnpm --filter @nexus/council build
```

> `turbo` is often **not on PATH directly** — invoke it through the `pnpm` scripts
> (`pnpm build` = `turbo run build`) or use `pnpm --filter <pkg> <script>` per package.
> `apps/api`/`apps/worker` consume built `dist`: after editing a package's `src`, run its
> `build` before an app typecheck will see the change.

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

## Commits

- **Authorship:** always commit as author **`Yash-Awasthi <yashawasthi12032006@gmail.com>`**
  (author = committer).
- **No `Co-Authored-By` trailer by default.** Add the co-author trailer **only** for **CI fixes and
  error/bug corrections** — never for features, docs, or refactors:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Don't commit unless asked — **except** ROADMAP.md items, which carry a standing checkpoint-commit
  approval (see ROADMAP's Execution protocol).
- Always branch off `main` (never commit to `main`); **never push / open a PR** unless asked.
- Stage explicit paths — **never `git add -A`**. Never stage `.claude/settings.json` or `.directory`.
- Conventional Commits (commitlint + Husky enforce).
