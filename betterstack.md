# Better Stack: Nexus

Upgrade plan built from the code itself: every `package.json` under `apps/` and `packages/`, `turbo.json`, `tsconfig.base.json`, `vitest.config.ts`, `eslint.config.js`, the import graph across `apps/*/src` and `packages/*/src`, the Python services, all Dockerfiles and compose files, and `.github/`. Target versions were read from npm, PyPI, Docker Hub, nodejs.org and GitHub releases on 2026-10-12. "Newest" includes alpha/beta/RC builds; "Stable" is the newest final release.

## What the code actually uses

- pnpm + Turborepo monorepo: 87 workspace packages, 7 apps, ~310k lines of TypeScript (`packages` ~179k, `apps/api` ~79k, `apps/ui` ~38k).
- **Every package builds with its own `tsc --project`** (86 packages) and lints with its own `eslint src/` (87). `typecheck` runs `tsc --noEmit` again in 66 of them.
- API: Fastify 5 (98 imports) + `@fastify/*` plugins, Drizzle ORM (63 imports) over three drivers: Neon serverless HTTP, `pg`, and embedded PGlite (`pglite://`).
- Worker: BullMQ 5 on ioredis.
- UI: React 19 SPA (`ssr: false`) on React Router 7 framework mode, Vite 8.2.1 (exact pin), Tailwind 4, Radix, 108 `.tsx` files.
- Desktop: Electron 44, `contextIsolation: true` but **sandbox off**, because the preload `require`s `./bridge`.
- CLI: commander 12 + chalk 5.
- Tracing: OpenTelemetry SDK 2.x with the OTLP HTTP exporter.
- Python: `services/ingest` (pyproject, Python 3.11, ~2.3k lines), `apps/ingest-py` (requirements.txt, Python 3.12, 215 lines), and `backend/services` (6 files, ~2.3k lines, **referenced by nothing**: no compose, CI or import).
- Tests: Vitest 2.1 everywhere, a root `vitest.config.ts` that aliases `@nexus/*` to `src/index.ts`, Playwright e2e.
- Both Renovate (`.github/renovate.json`) and Dependabot (`.github/dependabot.yml`) are configured.

## Version drift inside the repo

| What           | Evidence                                                                                                              | Fix                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| TypeScript     | `^5.6.3` in 57 packages, `*` in 30, `^5.4.0` in 1, `6.0.3` in 1                                                       | One version through a pnpm **catalog**                                                     |
| Vitest         | `*` in 30, `^2.1.8` in 51, `^2.1.4`, `^2.1.9`                                                                         | Catalog                                                                                    |
| `@types/node`  | `^20` at root, `^22` in 5 packages, `^25.6.0` in 1, while images run Node 26                                          | Catalog at `^26`                                                                           |
| Node in Docker | `api`/`worker` on `node:26`, `ui` and `infra/web` on `node:22-alpine`, compose dev on `node:22-alpine`, CI on Node 22 | Node 26 everywhere                                                                         |
| Python         | `services/ingest` 3.11, `apps/ingest-py` 3.12, CI 3.11                                                                | 3.14 everywhere                                                                            |
| Update bots    | Renovate and Dependabot both open PRs for the same deps                                                               | Keep Renovate (it already groups monorepos and automerges minors); delete `dependabot.yml` |

pnpm catalogs (`pnpm-workspace.yaml` → `catalog:`) let every package write `"typescript": "catalog:"`, so one edit upgrades all 87.

## Biggest structural win: stop compiling 86 packages

Today each internal package compiles to `dist/` before anything downstream can run (`dependsOn: ["^build"]` on `build`, `test`, `lint`, `typecheck` and `dev`). Two options, best first:

1. **Internal packages export TypeScript source.** Point each package's `exports` at `./src/index.ts` (with a `"default": "./dist/index.js"` condition kept for the published SDK packages only). Node 26 strips types natively, Vite and Vitest read TS directly, and the root `vitest.config.ts` already aliases `@nexus/*` to `src/index.ts`, so tests already work this way. Most `build` tasks disappear; `test`, `lint` and `typecheck` stop waiting on `^build`.
2. **TypeScript 7 with project references.** If `dist/` builds must stay, TS 7 (the Go-native compiler, 7.0.2 stable) is roughly an order of magnitude faster per package. Add `references` and run one `tsc -b` from the root instead of 86 separate processes.

Doing (1) plus TS 7 for a single root `tsc -b --noEmit` typecheck gives the fastest loop.

## Lint and format

| Tool                   | Current                                    | Stable                         | Newest         | Pick                                                                                                           |
| ---------------------- | ------------------------------------------ | ------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------- |
| ESLint                 | ^9.39.5 (9.x is now the `maintenance` tag) | 10.12.0                        | 10.12.0        | **oxlint 1.87.0** for all rules it covers, plus **ESLint 10** only for the remaining custom/import-order rules |
| typescript-eslint      | ^8.66.0                                    | 8.71.2                         | 8.71.3-alpha   | **8.71.2**                                                                                                     |
| `eslint-plugin-vitest` | ^0.5.4 (deprecated name)                   | `@vitest/eslint-plugin` 1.6.27 |                | **`@vitest/eslint-plugin` 1.6.27**                                                                             |
| `eslint-plugin-import` | ^2.31.0                                    |                                |                | **oxlint's `import` plugin**, or `eslint-plugin-import-x`                                                      |
| Prettier               | ^3.9.6                                     | 3.9.10                         | 4.0.0-alpha.13 | **3.9.10**; or **oxfmt** 0.72.0 (pre-1.0) alongside oxlint                                                     |
| knip                   | ^5.33.0                                    | 6.41.0                         |                | **6.41.0**                                                                                                     |
| madge, depcheck        | 8.0.0, 1.4.7                               |                                |                | **Remove**: knip already reports unused deps, files and exports, and oxlint has `import/no-cycle`              |

oxlint runs the whole repo in about a second, so lint can become one root task instead of 87 per-package ESLint processes with a `^build` dependency.

## Toolchain

| Item                 | Current                  | Stable      | Newest                        | Pick                                                                                                                                                                                                                 |
| -------------------- | ------------------------ | ----------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js              | `>=22.12.0`, mixed 22/26 | 24.21.0 LTS | 26.11.1 (goes LTS this month) | **26**, `engines >=24`                                                                                                                                                                                               |
| pnpm                 | 9.14.4                   | 12.11.2     | 12.11.2                       | **12.11.2** (catalogs, faster installs, `allowBuilds`)                                                                                                                                                               |
| Turborepo            | ^2.10.8                  | 2.11.7      | 2.11.8-canary.2               | **2.11.7**                                                                                                                                                                                                           |
| TypeScript           | mixed 5.x / 6.0.3 / `*`  | 7.0.2       | 7.1.0-dev                     | **7.0.2**                                                                                                                                                                                                            |
| Vitest + coverage-v8 | 2.1.x                    | 5.0.4       | 5.0.4                         | **5.0.4**                                                                                                                                                                                                            |
| Playwright           | 1.62.1                   | 1.64.0      | 1.65.0-alpha                  | **1.64.0** (`@playwright/test` and `playwright-core` together)                                                                                                                                                       |
| tsx                  | ^4.23.10                 | 4.23.15     |                               | **Remove where possible**: Node 26 runs `scripts/*.ts` and `src/index.ts` directly (`node --watch src/index.ts` replaces `tsx watch`). `apps/api` and `apps/worker` list `tsx` in `dependencies` but never import it |
| Changesets           | ^2.31.1                  | 3.0.3       |                               | **3.0.3**                                                                                                                                                                                                            |
| commitlint           | ^19.5.0                  | 21.2.3      |                               | **21.2.3**                                                                                                                                                                                                           |
| lint-staged          | ^15.2.10                 | 17.6.0      |                               | **17.6.0**                                                                                                                                                                                                           |
| husky                | ^9.1.6                   | 9.1.7       |                               | **9.1.7**                                                                                                                                                                                                            |

Vitest 2 → 5 crosses three majors. The root config only uses `defineConfig` + `resolve.alias`, which carry over. Things to check: `workspace` files become `test.projects`, `@vitest/coverage-v8` must match exactly, and the `vitest@*` packages need the catalog first so one version is installed.

## Runtime libraries

| Package                                                          | Current                               | Stable                                            | Newest          | Pick                                                                              | Notes                                                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------- | --------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fastify                                                          | ^5.11.2                               | 5.12.5                                            | 6.0.0-alpha.4   | **5.12.5**; trial 6.0 alpha on a branch                                           | 98 import sites; wait for 6.0 beta before merging                                                                                                             |
| @fastify/cors / helmet / swagger / static / multipart / sensible | 11.3 / 13.1 / 9.8 / 10.1 / 10.1 / 6.0 | 11.3.1 / 13.1.2 / 9.9.2 / 10.1.6 / 10.1.3 / 6.0.7 |                 | patch bumps                                                                       |                                                                                                                                                               |
| drizzle-orm / drizzle-kit                                        | ^0.45.2 / ^0.31.10                    | 0.45.4 / 0.31.11                                  | 1.0.0-rc.4      | **1.0.0-rc.4**                                                                    | 63 import sites; review migration output on PGlite first                                                                                                      |
| @neondatabase/serverless                                         | ^0.10.4                               | 1.2.0                                             | 1.2.0           | **1.2.0**                                                                         | 1.x makes `sql` tagged-template only (`sql.query()` for strings); `packages/db/src/client.ts` hands it to Drizzle, so check the driver wiring, not call sites |
| pg / @types/pg                                                   | ^8.22.0                               | 8.23.1                                            |                 | **8.23.1**                                                                        |                                                                                                                                                               |
| @electric-sql/pglite                                             | ^0.5.8                                | 0.5.9                                             |                 | **0.5.9**                                                                         | Declared in `apps/api` but only used via `@nexus/db`; drop the direct dependency                                                                              |
| bullmq                                                           | ^5.81.3                               | 6.3.13                                            | 6.3.13          | **6.3.13**                                                                        | Major; check job-option and worker-event changes in `apps/worker`                                                                                             |
| ioredis                                                          | ^5.11.1 / ^5.4.1                      | 6.0.0                                             | 6.1.0-beta.1    | **6.0.0**                                                                         | Align both declarations; required as BullMQ 6 peer                                                                                                            |
| @opentelemetry/sdk-trace-* / resources                           | ^2.11.0                               | 2.12.0                                            |                 | **2.12.0**                                                                        |                                                                                                                                                               |
| @opentelemetry/exporter-trace-otlp-http                          | ^0.222.0                              | 0.223.0                                           |                 | **0.223.0**                                                                       |                                                                                                                                                               |
| @opentelemetry/api                                               | ^1.9.1                                | 1.9.1                                             |                 | keep                                                                              |                                                                                                                                                               |
| ws                                                               | ^8.21.3                               | 8.22.0                                            |                 | **8.22.0**                                                                        |                                                                                                                                                               |
| react / react-dom / react-is                                     | ^19.2.5                               | 19.3.0                                            | 19.3 canary     | **19.3.0**                                                                        |                                                                                                                                                               |
| react-router / @react-router/dev                                 | ^7.18.2                               | 8.4.0                                             |                 | **8.4.0**                                                                         | Enable all v8 `future` flags on 7.18.4 first, then bump. SPA mode (`ssr: false`) keeps the change small                                                       |
| vite                                                             | 8.2.1 (exact)                         | 8.3.4                                             | 8.3.0-beta.1    | **8.3.4**                                                                         |                                                                                                                                                               |
| tailwindcss / @tailwindcss/vite                                  | ^4.3.3                                | 4.3.3                                             |                 | keep                                                                              |                                                                                                                                                               |
| radix-ui                                                         | ^1.6.7                                | 1.8.0                                             |                 | **1.8.0**                                                                         |                                                                                                                                                               |
| lucide-react                                                     | ^1.29.0                               | 1.55.0                                            |                 | **1.55.0**                                                                        |                                                                                                                                                               |
| recharts                                                         | ^3.10.1                               | 3.10.1                                            | 3.11.0-canary.5 | keep                                                                              |                                                                                                                                                               |
| @xyflow/react                                                    | ^12.11.2                              | 12.12.0                                           | 13.0.0-next.0   | **12.12.0**                                                                       |                                                                                                                                                               |
| @xterm/xterm / addon-fit                                         | ^5.5.0 / ^0.10.0                      | 6.0.0 / 0.11.0                                    | 6.1.0-beta      | **6.0.0 / 0.11.0**                                                                |                                                                                                                                                               |
| node-pty                                                         | ^1.1.0                                | 1.1.0                                             | 1.2.0-beta.15   | **1.2.0-beta.15**                                                                 |                                                                                                                                                               |
| electron                                                         | ^44.4.5                               | 44.7.0                                            | 45.0.0-beta.1   | **45.0.0-beta.1**, fallback 44.7.0                                                |                                                                                                                                                               |
| commander                                                        | ^12.1.0                               | 15.0.0                                            |                 | **15.0.0**                                                                        |                                                                                                                                                               |
| chalk                                                            | ^5.3.0                                | 6.0.1                                             |                 | **Remove**: `node:util` `styleText` covers the CLI's colouring with no dependency |
| groq-sdk                                                         | ^0.37.0                               | 1.6.0                                             |                 | **1.6.0**                                                                         |                                                                                                                                                               |
| jsdom                                                            | ^25.0.1                               | 30.1.2                                            |                 | **30.1.2**                                                                        |                                                                                                                                                               |
| fast-check                                                       | ^3.23.2                               | 4.10.2                                            |                 | **4.10.2**                                                                        |                                                                                                                                                               |
| pyodide                                                          | ^314.0.3                              | 314.0.7                                           | 315.0.0-alpha.2 | **314.0.7**                                                                       |                                                                                                                                                               |
| tesseract.js / mammoth / unpdf                                   | 7.0.0 / 1.12.3 / 1.8.1                | 7.0.0 / 1.13.0 / 1.8.1                            |                 | mammoth **1.13.0**                                                                |                                                                                                                                                               |
| three / @types/three                                             | ^0.186.1                              | 0.186.1                                           |                 | keep                                                                              |                                                                                                                                                               |
| patchright                                                       | ^1.63.0                               | 1.63.0                                            |                 | keep                                                                              |                                                                                                                                                               |
| @monaco-editor/react                                             | ^4.7.0                                | 4.7.0                                             | 4.8.0-rc.3      | **4.8.0-rc.3**                                                                    |                                                                                                                                                               |
| animejs                                                          | ^4.5.0                                | 4.5.0                                             | 5.0.0-beta.2    | keep 4.x                                                                          |                                                                                                                                                               |

## Electron security

`apps/desktop/src/main.ts` runs the preload unsandboxed because it `require`s `./bridge`, and a sandboxed preload cannot resolve local modules. Bundle the preload into one file (Rolldown 1.2.13 or esbuild) during `build`, then set `sandbox: true`. The renderer is the part of Nexus most exposed to untrusted content (scraped pages, model output), so this is the most valuable security change in the plan.

## Python services

**Consolidate first.** `services/ingest` and `apps/ingest-py` are both FastAPI ingest services and both are in `docker-compose.yml`; `backend/services` (~2.3k lines) is referenced by nothing. Pick one ingest service, fold the other's `/scan` endpoint into it, and delete `backend/services` after confirming nothing outside the repo calls it.

| Item                         | Current                                         | Stable          | Newest    | Pick                                                            |
| ---------------------------- | ----------------------------------------------- | --------------- | --------- | --------------------------------------------------------------- |
| Python                       | 3.11 / 3.12                                     | 3.14.8          | 3.15.0rc3 | **3.14**                                                        |
| Packaging                    | pip + requirements.txt / pyproject without lock | uv 0.13.0       |           | **pyproject + `uv.lock`**                                       |
| fastapi                      | 0.115.x                                         | 0.143.0         |           | **0.143.0**                                                     |
| uvicorn                      | 0.32.1                                          | 0.54.0          |           | **0.54.0**                                                      |
| pydantic / pydantic-settings | 2.10.4 / >=2.5                                  | 2.14.1 / 2.15.0 |           | **2.14.1 / 2.15.0**                                             |
| httpx                        | 0.28.1                                          | 0.28.1          | 1.0.dev6  | keep                                                            |
| asyncpg                      | >=0.29                                          | 0.32.0          |           | **0.32.0**                                                      |
| psycopg[binary]              | >=3.2.0                                         |                 |           | **Remove**: declared, never imported                            |
| celery[redis]                | >=5.4.0                                         | 5.6.3           | 5.7.0b1   | **5.6.3**                                                       |
| kombu                        | >=5.3.0                                         |                 |           | **Remove**: transitive through Celery                           |
| redis[hiredis]               | >=5.0                                           | 8.1.0           |           | **8.1.0**                                                       |
| opentelemetry-*              | >=1.27                                          | 1.45.1          |           | **1.45.1**                                                      |
| prometheus-client            | >=0.21                                          | 0.26.0          |           | **0.26.0**                                                      |
| pytest / pytest-asyncio      | >=8.3 / >=0.24                                  | 9.1.1 / 1.4.0   |           | **9.1.1 / 1.4.0**                                               |
| hypothesis                   | >=6.112                                         | 6.169.0         |           | **6.169.0**                                                     |
| schemathesis                 | >=3.34                                          | 4.31.0          |           | **4.31.0** (major, CLI changed)                                 |
| mypy                         | >=1.11                                          | 2.4.0           |           | **mypy 2.4.0**, or **ty 0.0.86** as a faster non-blocking check |
| ruff                         | >=0.6                                           | 0.17.0          |           | **0.17.0** pinned                                               |

## Infrastructure images

| Image                                  | Current           | Latest                       | Pick                                                                                     |
| -------------------------------------- | ----------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| `pgvector/pgvector`                    | pg16              | pg18                         | **pg18** (dump/restore across majors)                                                    |
| `redis`                                | 7.2.5-alpine      | 8.10.2-alpine                | **8.10-alpine**, or `valkey/valkey:9.1-alpine`                                           |
| `otel/opentelemetry-collector-contrib` | 0.109.0 / 0.102.0 | 0.162.0                      | **0.162.0** in both compose files                                                        |
| `jaegertracing/all-in-one`             | 1.57              | Jaeger v2.22.0               | **`jaegertracing/jaeger:2.22.0`** (v1 is end-of-life; v2 is built on the OTel Collector) |
| `prom/prometheus`                      | v2.52.0           | v3.15.0                      | **v3.15.0**                                                                              |
| `grafana/grafana`                      | 10.4.3            | 13.2.3                       | **13.2.3**                                                                               |
| `deadly0/bull-board`                   | 0.1.3             | bull-board v9.10.4 (library) | Mount `@bull-board/fastify` inside the API instead of a stale third-party image          |
| `nginx` (ui)                           | 1.27-alpine       | 1.31.6-alpine                | **1.31-alpine**                                                                          |
| `node` (ui, infra/web, compose dev)    | 22-alpine         | 26                           | **26-alpine**                                                                            |
| `python` (ingest)                      | 3.11 / 3.12-slim  | 3.14.8-slim                  | **3.14-slim**                                                                            |

## CI

Actions are already on current majors (`checkout@v7`, `setup-node@v7`, `pnpm/action-setup@v6`, Docker v4–v7, CodeQL v4). Remaining items:

- `node-version: "22"` in 10 jobs → `26` (keep a 24 leg in the test matrix).
- `actions/setup-python@v7` with Python 3.11 → `astral-sh/setup-uv@v10.3.0` with 3.14.
- `sigstore/cosign-installer@v3`, `anchore/sbom-action@v0`, `grafana/k6-action@v0.3.1`, `changesets/action@v1`: pin to the latest release tags (or SHAs) like the rest.

## Order of work

1. pnpm 12 + catalogs for TypeScript, Vitest, `@types/node`; delete Dependabot; drop `madge`, `depcheck`, unused `tsx`/`pglite` deps, `psycopg`, `kombu`.
2. Node 26 in every Dockerfile, compose file and CI job.
3. TypeScript 7 and a root `tsc -b --noEmit`.
4. Source-exported internal packages; remove `^build` from `test`/`lint`/`typecheck`.
5. oxlint + ESLint 10 for the leftover rules; Prettier 3.9.10 or oxfmt.
6. Vitest 5 + Playwright 1.64.
7. Runtime library bumps: Fastify plugins, OTel, React 19.3, Vite 8.3, Radix, xterm 6, commander 15, chalk → `styleText`.
8. Majors one at a time with tests between: Drizzle 1.0 RC, Neon 1.x, BullMQ 6 + ioredis 6, React Router 8, Electron 45 with the sandboxed preload.
9. Python consolidation, then Python 3.14 + uv.
10. Infrastructure images: Postgres 18, Redis 8 / Valkey 9, OTel Collector, Jaeger v2, Prometheus 3, Grafana 13.

`pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm test:e2e` should be green after each step.
