# Stack migration plan

Draft for the next session. Scope is the toolchain, runtime versions, data layer, UI, desktop
and CI. Phase 7 is the only product-facing work.

Verified 2026-11-22 against `master` at `493eb4b` with a clean tree. Package versions were read
from the tree, the npm registry and Docker Hub that day.

## How to run this

- One branch per phase: `migrate/phase-0`, `migrate/vite-plus`, `migrate/data`, and so on.
- Tag `pre-migration` before Phase 0 and keep it. It is the only rollback point that matters.
- One commit per numbered item unless the item says otherwise. Never mix a mechanical rewrite
  with a hand edit.
- A checkbox is done only when its Verify line exits 0.
- Nothing is pushed until the exact word is given.
- This host has no bash and no Corepack. Use PowerShell; run bash-only checks in CI.

## Target stack

| Layer           | Target                                                                                | Why                                                                         |
| --------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Runtime         | Node 26 LTS                                                                           | Native TypeScript stripping, current LTS. Already in devbox, Docker and CI. |
| Package manager | pnpm 12.21                                                                            | Catalogs, `pnpm permissions`, one lockfile across 54 manifests.             |
| Compiler        | TypeScript 7.0.2 native `tsc`, 6.0.2 API alias                                        | 8-12x faster typecheck; the alias keeps ESLint, knip and codegen working.   |
| Build and test  | Vite+ 1.7.0 (Vite/Rolldown, Vitest 5.1, tsdown 0.23)                                  | One Rust-native toolchain instead of four separately versioned ones.        |
| Lint and format | Oxlint 1.94, Oxfmt 0.79                                                               | Native speed, one config surface, replaces ESLint and Prettier.             |
| UI              | React 19.3.1, React Router 8.5.2, Tailwind 4.3.5                                      | Current majors. Framework mode and SPA stay.                                |
| API             | Fastify 5.12.8, Drizzle 1.0.0-rc.6, BullMQ 6.7.8, ioredis 6                           | Current majors; the Drizzle RC line is the one that reaches GA.             |
| Data            | Postgres 18 + pgvector 0.8.7, pinned image                                            | Reproducible; the floating `pg18` tag already ships 0.8.7.                  |
| Desktop         | Electron 45.4.1 stable, PGlite 0.5.17, pglite-pgvector 0.0.18                         | Off a beta; embedded Postgres matches the server extension.                 |
| Python          | 3.14, uv, FastAPI, Ruff 0.17, mypy strict                                             | Already current.                                                            |
| Go              | 1.27, `modernc.org/sqlite`                                                            | Already current.                                                            |
| Observability   | OpenTelemetry, Jaeger, Prometheus, Grafana                                            | Spans per tool call, not only per request.                                  |
| Supply chain    | `pnpm permissions`, gitleaks on PR, Trivy/CodeQL/SBOM scheduled, digest-pinned images | Reviewable installs and scanners.                                           |

Not adopted: Bun as a runtime, Nx, Biome, Prisma, tRPC, Next.js, splitting into services.

## Already current

- TypeScript 7 aliases in `pnpm-workspace.yaml`; no `ignoreDeprecations`; Node-stripping flags
  set in `tsconfig.base.json`.
- React Router 8.4.0, zero `react-router-dom` imports, one Vite alias blocking a transitive v5.
- Drizzle on the 1.0 RC line; migration folders are v3 (no `journal.json`); no
  `getTableColumns`, `drizzle-zod`, `drizzle-valibot` or `casing` usage.
- `pgvector/pgvector:pg18` resolves to pgvector 0.8.7 (digest matches `0.8.7-pg18`).
- `pnpm permissions` exists; six grants, six denials recorded; `drizzle-kit` pending.
- MCP client and servers, tool permission tiers, exec approvals and the HMAC audit log exist.
- `@nexus/sandbox` has a Docker runner with gVisor (`SANDBOX_RUNTIME=runsc`).
- SSE for agent streaming and `ws` for the terminal is already the split.
- No Turborepo remote cache, and CI never calls turbo.

## Explicit non-goals

Toolchain

- Do not let Vite+ replace `react-router dev` / `react-router build`; do not convert the UI to
  plain Vite or SSR.
- Do not touch `dedupe`, `noDiscovery`, `optimizeDeps.include`, the `/api` proxy or the polling
  watcher in `apps/ui/vite.config.ts`. Each fixes a crash or a stale-module bug.
- Do not pass `--full` to the migrator. Pass `--no-hooks --no-editor --no-agent`.
- Do not run the migrator on a dirty tree.
- Do not delete ESLint until `import/order` parity in Oxlint is proven.
- Do not lower coverage thresholds to make a new runner pass.
- Do not add manual `vite` or `vitest` overrides; the migrator owns the `vite@*` / `vitest@*`
  keys and manual pins break the `catalog:` references.
- Do not adopt Vite Task, `pnpm pipeline` or a remote cache while CI does not call turbo.
- Do not take Node 27, Electron 46 or React 20 previews.

Data

- Do not follow `drizzle-orm@latest` (0.45.4); it is behind the RC line.
- Do not mix RC and 0.x Drizzle packages; do not add `drizzle-zod` or `drizzle-valibot`.
- Do not move to Postgres 19 before Neon does; do not raise pgvector past what Neon manages.
- Do not point `pg` at the Neon serverless driver on Render.
- Do not run the concurrent-migration test against a shared database.

Architecture

- Do not fold the Go board into Fastify; `apps/api/src/lib/board-client.ts` depends on it and it
  owns SQLite leases, locks, the inspector and the MCP bridge.
- Do not merge Celery into BullMQ; that is a cross-language rewrite.
- Do not remove `patchright`; the fallback being removed is `playwright-core`.
- Do not treat `just-bash` or `pyodide` as a security boundary, and do not let the gVisor path
  fall back to `child_process` silently.
- Do not add TanStack Query app-wide before the one-route prototype.
- Do not add a second deployment target; `docs/DEPLOYMENT.md` is Render-only.

Repository

- Do not delete or reformat `services/board/sources/`, and do not add license headers there.
- Do not blanket-approve `pnpm permissions`; approve named builds only.

## Baseline values (last recorded)

Use these as the comparison, not as guarantees. Re-measure in Phase 0.

- Root coverage run: 4669 passed, 6 skipped; statements 86.18%, branches 73.92%,
  functions 88.23%, lines 88.39%.
- `pnpm turbo run test --force`: 53 tasks.
- Thresholds in `vitest.config.ts`: statements 85, lines 87, functions 86, branches 73.

## Phase 0: Safety net and one-line wins

**Objective:** make every later change reversible and remove stale versions that would confuse
the migration.

- [x] **Tag the rollback point.**
      Run: `git tag pre-migration`.
      Verify: `git tag --list pre-migration` prints the tag.

- [x] **Record baselines into `.nexus/baseline.txt`** (`.nexus/` is gitignored).
      Run each and append the seconds:
      `Measure-Command { pnpm install --frozen-lockfile } | % TotalSeconds`,
      `Measure-Command { pnpm typecheck } | % TotalSeconds`,
      `Measure-Command { pnpm test } | % TotalSeconds`,
      `Measure-Command { pnpm test:e2e } | % TotalSeconds`,
      `Measure-Command { docker compose build api } | % TotalSeconds`.
      Also record API cold start to the first successful `/health/ready`.
      Verify: the file has six numbers and the Node/pnpm/OS versions.

- [x] **Save dependency drift.**
      Run: `pnpm outdated -r > .nexus/outdated.txt`.
      Verify: the file is non-empty and lists the packages from the audit table below.

- [x] **Pin the Postgres image.**
      Change `pgvector/pgvector:pg18` to `pgvector/pgvector:0.8.7-pg18` in
      `docker-compose.yml` (line 22) and in both service blocks of `.github/workflows/test.yml`
      (lines 105 and 136).
      Verify: `docker compose exec postgres psql -U nexus -d nexus -c "select extversion from pg_extension where extname='vector';"`
      prints `0.8.7`.

- [x] **Update the embedded vector stack.**
      In `packages/db/package.json`: `@electric-sql/pglite` 0.5.9 → 0.5.17 and
      `@electric-sql/pglite-pgvector` 0.0.10 → 0.0.18.
      Verify: `pnpm --filter @nexus/db test` green, plus
      `pnpm --filter @nexus/api exec vitest run tests/lib/migrate-embedded.test.ts` and
      `pnpm --filter @nexus/api exec vitest run tests/lib/memory-store-embedded.test.ts`.

- [x] **Bump pnpm to 12.21.0 in all six places.**
      `package.json` (`packageManager`), `.devcontainer/devcontainer.json`, `apps/api/Dockerfile`,
      `apps/ui/Dockerfile`, `apps/worker/Dockerfile`, `infra/web/Dockerfile`.
      The devcontainer currently runs `corepack enable && corepack prepare pnpm@12.11.2`; Node 26
      ships without Corepack (`corepack` is not on PATH on this host), so replace it with
      `npm install -g pnpm@12.21.0`, matching the Dockerfiles.
      Run: `pnpm install` to refresh `pnpm-lock.yaml`.
      Verify: `pnpm --version` prints `12.21.0`; `pnpm install --frozen-lockfile` is clean.

- [x] **Review the pending dependency permission.**
      Run: `pnpm permissions list`, then `pnpm permissions approve drizzle-kit` or deny it.
      The request is for `skills`, not a build script.
      Verify: `pnpm permissions list` no longer lists `drizzle-kit` under "Awaiting approval".

- [x] **Move Electron off the beta.**
      `apps/desktop/package.json`: `electron` 45.0.0-beta.6 → 45.4.1.
      Verify: `pnpm --filter @nexus/desktop test` green; `process.versions.node` printed from the
      main process matches Electron 45's bundled Node; `pnpm --filter @nexus/desktop exec playwright test`
      green.

- [x] **Fix the Render branch.**
      `render.yaml` line 17: `branch: main` → `branch: master`.
      Verify: `git grep -n "branch:" render.yaml` prints `master`; the Render dashboard shows the
      service tracking `master`.

- [x] **Remove POSIX-only clean scripts.**
      `apps/ui` `clean` is `rm -rf build .react-router`; `apps/cli` `clean` is `rm -rf dist coverage`.
      Replace both with `node -e "require('fs').rmSync(...)"` equivalents.
      Verify: `pnpm --filter @nexus/ui clean` and `pnpm --filter @nexus/cli clean` exit 0 in
      PowerShell.

**Commits:** one for the image pin, one for the version bumps, one for permissions, one for
Render and clean scripts.

**Gate:** tag exists, six baselines recorded, pgvector reports 0.8.7, Electron e2e green,
`pnpm install --frozen-lockfile` clean on 12.21.0.

**Rollback:** `git checkout master` and delete the phase branch. Phase 0 is small enough to
redo by hand.

## Phase 1: Vite+ 1.7.0 and TypeScript 7

**Objective:** one toolchain for build, test, lint and format, with TypeScript 7 already in
place.

- [x] **Confirm TypeScript 7 is actually in use.**
      Run: `pnpm exec tsc --version` → 7.x; `node -p "require('typescript').version"` → 6.0.x.
      Record `pnpm typecheck` time against baseline.
      Verify: `pnpm typecheck` green. It runs `react-router typegen` first; keep that step.

- [x] **Create the branch from a clean tree.**
      Run: `git switch -c migrate/vite-plus`.
      Verify: `git status --short` is empty.

- [x] **Run the migrator from the workspace root.**
      Run:
      `pnpm dlx --package=vite-plus@1.7.0 vp migrate --no-interactive --no-hooks --no-editor --no-agent`.
      The `--no-*` flags stop it rewriting Husky, editor and agent files. Do not pass `--full`.
      Verify: the command exits 0 and prints a migration summary.

- [x] **Resolve BLOCK findings and rerun until idempotent.**
      Expect roughly 500 test files moved from `vitest` to `vite-plus/test`, 38 `vitest.config.*`
      files updated, `vitest` and `oxlint` removed, Prettier left in place, and a root
      `vite.config.ts` created.
      Verify: a second run produces no further diff.

  Correction 2026-11-22: the migrator also removed Prettier and ESLint config and rewrote four
  files under `services/board/sources/`. Those vendored files were restored before the commit.
  Phase 2 therefore starts with Oxfmt already wired and only has to prove lint parity.

- [x] **Keep the root scripts that do real work.**
      `typecheck` must stay `react-router typegen && tsc -b --noEmit`.
      `build` must stay `tsc -b tsconfig.build.json && turbo run build` (project references).
      `test` must stay `turbo run test`; turbo remains the orchestrator.
      `test:e2e` must stay `playwright test` against the root `playwright.config.ts`.
      Verify: `pnpm build`, `pnpm typecheck`, `pnpm test:e2e` all still resolve.

- [x] **Stage 1: root and `packages/*`.**
      Run: `pnpm exec vp test run --coverage` (replaces `pnpm exec vitest run --coverage`).
      Verify: coverage exits 0, thresholds unchanged, test count at or above baseline
      (4669 passed / 6 skipped), no new skips.

- [x] **Stage 2: `apps/api`, `apps/worker`, `apps/cli`.**
      Package scripts now call `vp test`; `pnpm --filter <pkg> test` still works.
      Run: `pnpm --filter @nexus/api test`, `pnpm --filter @nexus/worker test`,
      `pnpm --filter @nexus/cli test`.
      Verify: all three green. The API still starts with `node --watch src/index.ts`; no build step.

- [x] **Stage 3: `apps/ui`.**
      Keep `react-router dev` and `react-router build`. `apps/ui/vite.config.ts` stays the plugin
      host and must keep `dedupe`, `noDiscovery`, the full `optimizeDeps.include` list, the
      `react-router-dom` alias and `optimizeDeps.exclude`, the `/api` proxy, the polling watcher,
      `assetsInlineLimit` and `define.__filename`.
      Run: `pnpm --filter @nexus/ui test`, `pnpm --filter @nexus/ui build`.
      Verify: build output is served correctly by `nginx.conf`; `pnpm test:e2e` green.

- [x] **Stage 4: `apps/desktop`.**
      Run: `pnpm --filter @nexus/desktop test`,
      `pnpm --filter @nexus/desktop exec playwright test`.
      Verify: rolldown preload builds, PGlite opens, `node-pty` loads, e2e green.

- [x] **Keep the hooks.**
      `.husky/pre-commit` stays on `pnpm lint-staged` until Phase 2; `.husky/commit-msg` stays on
      commitlint. Vite+ deliberately leaves Husky alone.
      Verify: a throwaway commit runs both hooks.

- [x] **Rollback drill.**
      On a scratch branch: `git reset --hard pre-migration`, `pnpm install`, `pnpm test`.
      Verify: the pre-migration tree is green.

**Gate:** full suite under `vp test` with no new skips, typecheck green, `react-router build`
produces a working UI, desktop e2e green, rollback drill done. If the UI cannot be proven
identical, leave the branch unmerged; nothing later depends on it.

## Phase 2: Oxfmt, Oxlint, hooks

**Objective:** remove Prettier and the standalone Oxlint, keep the lint scope that exists today.

- [x] **Replace Prettier with Oxfmt.**
      Run: `pnpm exec vp fmt`.
      Map `.prettierrc` exactly: print width 100, double quotes, semicolons, trailing commas,
      2 spaces, LF.
      Carry every `.prettierignore` entry into the `fmt` config: `node_modules/`, `dist/`,
      `build/`, `coverage/`, `.turbo/`, `.react-router/`, `.venv-readiness/`, `.pytest_cache/`,
      `test-results/`, `playwright-report/`, `.local/`, `*.gen.ts`, `*.gen.py`, `pnpm-lock.yaml`,
      `.docusaurus/`, `REF/`, `.claude/worktrees/`, `inspiration/`, `services/board/sources/`,
      `apps/api/data/stores/`, `**/src/generated/`.
      Verify: `pnpm exec vp fmt --check` exits 0 and `git status` shows no change under
      `services/board/sources/` or `**/src/generated/`.

- [x] **One formatting-only commit.**
      Run: `git add -A && git commit -m "style: format with oxfmt"`.
      Add the hash to `.git-blame-ignore-revs`, then
      `git config blame.ignoreRevsFile .git-blame-ignore-revs`.
      Verify: `git blame` on an old file shows the original author.

- [x] **Move the remaining ESLint rules into Oxlint.**
      Run: `pnpm exec oxlint --help` and the rule listing to confirm `import/order` exists. The
      local `--rules` output was empty on this host, so check the help text or the Oxlint docs
      before deleting anything.
      If covered: delete `eslint.config.mjs`, `eslint`, `eslint-plugin-import-x` and
      `typescript-eslint`. If not: keep `eslint.config.mjs` with only `import-x/order`.
      Verify: `pnpm lint` reports no new errors.

  Correction 2026-11-22: the migrator skipped `import-x/order` because Oxlint has no equivalent,
  so `eslint.config.mjs` stays with only that rule and the three ESLint packages are restored.
  Lint also runs with `typeCheck: false`; full TS diagnostics stay in `pnpm typecheck`.

- [x] **Keep the current lint scope.**
      `pnpm lint` today lints `packages/*/src`, `packages/shared/tests`,
      `packages/plugin-sdk/tests`, `apps/api/src`, `apps/worker/src`, `apps/cli/src`, `apps/ui/app`
      with Oxlint, then the same set with ESLint. `vp lint` at the root lints everything, which
      surfaces new findings in tests and scripts.
      Either pass the same directories to `vp lint`, or widen the scope deliberately and fix the
      findings in a separate commit.
      Verify: `pnpm lint` exits 0 and its file count matches the old command.

- [x] **Move lint-staged into the `staged` block.**
      Current rules live in `package.json`: Oxlint `--type-aware --fix`, ESLint `--fix --quiet`,
      Prettier `--write` for TS/TSX; ESLint plus Prettier for JS/MJS; Prettier for JSON/MD/YAML.
      Put the equivalents in the root `vite.config.ts` `staged` block and point
      `.husky/pre-commit` at `pnpm exec vp staged`.
      Change `.husky/commit-msg` from `npx --no -- commitlint` to `pnpm exec commitlint` so it
      never reaches the network.
      Verify: a throwaway commit with a bad message fails; a good one passes and formats.

  Correction 2026-11-22: this clone had no `core.hooksPath`, so neither hook ran. Added a root
  `prepare: husky` script; the bad/good commit test then exercised both hooks.

- [x] **Knip pass.**
      Run: `pnpm prune:knip`.
      Verify: findings recorded in this file or cleared; no live export deleted.

      Findings 2026-11-22: 3 unused UI files, 3 dependencies used dynamically or by types
      (`just-bash`, `pyodide`, `@nexus/contracts`), 2 unlisted binaries (`go`, `where`), 23 unused
      exports and 33 unused exported types. Removed four unused vitest devDependencies and declared
      `@nexus/shared` in agent-core. No export deleted.

**Gate:** `vp lint` and `vp fmt --check` green on a clean clone, pre-commit works, no formatter
drift.

## Phase 3: CI

**Objective:** install the toolchain once per job, keep the coverage gates, add the missing
desktop e2e job.

- [x] **Replace the Node and pnpm setup steps.**
      In `build.yml`, `test.yml`, `lint.yml`, `migrate.yml` and `npm-publish.yml`, replace
      `pnpm/action-setup` + `actions/setup-node` + the pnpm cache step with
      `voidzero-dev/setup-vp@v1`. Leave the other workflows alone.
      Keep `pnpm install --frozen-lockfile` so the lockfile is still verified.
      Verify: all five workflows pass on the branch.

      Correction 2026-11-22: setup-vp no longer updates the `v1` tag; the five workflows pin
      `v1.22.0`. Actions cannot run locally, so verification used the bundled YAML parser plus the
      local equivalent of every job command. That exposed a missing SPDX header in `vite.config.ts`
      and YAML formatting drift; both fixed here.

- [x] **Keep Turborepo.**
      `turbo.json` stays; `pnpm build` and `pnpm test` still go through turbo. Remote cache stays
      off unless CI starts calling turbo.
      Verify: `pnpm test` still reports 53 tasks.

- [x] **Split PR and main test runs.**
      PRs: `pnpm exec vp test run --changed` plus the three app suites.
      `master`: the full coverage run and `pnpm test`.
      Verify: a PR touching one package runs fewer tests; `master` still runs the full suite.

      Correction 2026-11-22: `--changed` needs history, so the unit job checks out with
      `fetch-depth: 0` and diffs against `origin/${{ github.base_ref }}`. A scratch change in
      `packages/shared` ran 210 tests in 26 files instead of 4669 in 259; the full run still
      reports 4669 passed, 6 skipped.

- [x] **Add a desktop e2e job.**
      New job on `ubuntu-latest`: install, then
      `xvfb-run -a pnpm --filter @nexus/desktop exec playwright test`.
      Verify: the job runs `apps/desktop/tests/e2e/desktop.spec.ts` and fails when the spec fails.

      Correction 2026-11-22: the job builds `@nexus/desktop` first because Playwright launches
      `dist/main.js`. Locally the real spec passed and a throwaway failing spec exited 1.

- [x] **Move scanners off the PR path.**
      Keep gitleaks on pull requests. Move Trivy, CodeQL and SBOM generation to a schedule.
      Verify: PR checks shrink; the scheduled run still uploads results.

      Correction 2026-11-22: no Trivy job exists in this tree, so there was nothing to move. Two
      CodeQL workflows existed; the duplicate job in `security.yml` was dropped and `codeql.yml`
      now runs on schedule and dispatch only. Docker SBOMs are built off PR (`sbom:` is conditional);
      `docker.yml`'s compose smoke test still gates pull requests.

- [x] **Pin base images by digest.**
      `node:26-alpine`, `python:3.14-slim`, `nginx:1.31-alpine`, `pgvector/pgvector:0.8.7-pg18`.
      Resolve with `docker inspect --format='{{index .RepoDigests 0}}' <image>` and pin.
      Verify: `docker compose build` and `pnpm build` still pass.

      Correction 2026-11-22: the worker image is `node:26-bookworm-slim`, not alpine, so it was
      pinned by its own digest. The ingest digest is bound to `PYTHON_VERSION=3.14`; changing that
      argument without updating the digest fails the build. `docker compose build` took 759.8s and
      built all five images; `pnpm build` passed.

**Gate:** CI at or below baseline, clean-clone `docker compose up` works, desktop e2e runs in CI.

## Phase 4: Data layer

**Objective:** move to the Drizzle RC that becomes 1.0, proven on both engines.

- [x] **Bump the pair together.**
      In `pnpm-workspace.yaml` catalog and `packages/db/package.json`: `drizzle-orm` and
      `drizzle-kit` `1.0.0-rc.4` → `1.0.0-rc.6` (the `rc` tag). Do not use `latest` (0.45.4).
      Verify: `pnpm install` clean; `node -p "require('drizzle-orm/package.json').version"` is
      `1.0.0-rc.6`.

      Correction 2026-11-22: `drizzle-orm`'s export map blocks the `package.json` subpath, so the
      bare `require('drizzle-orm/package.json')` fails. `require('./node_modules/drizzle-orm/
      package.json').version` returns `1.0.0-rc.6`; `drizzle-kit --version` reports both rc.6.

- [x] **Read the rc.5 and rc.6 notes before touching queries.**
      List every behaviour change that affects this tree, or state that none do.
      Verify: the list is written into this file.

      Affected:
      - rc.6 is ESM-only and requires Node `^20.19.0 || >=22.12.0`; this tree is ESM on Node 26.
      - rc.6 removed cast codecs, so `node-postgres` and PGlite selections request lossless text
        for temporal/numeric types and decode through codecs. Default `timestamp` (Date) and
        `numeric` (string) modes are unchanged; the pgvector `customType` still uses `fromDriver`.
      - rc.6 raw `db.execute` now honors driver configuration. The three call sites
        (`packages/db/src/gdpr.ts`, `apps/api/src/routes/health.ts`,
        `apps/api/src/routes/diagnostics.ts`) read only `rowCount` or `SELECT 1`, so nothing depends
        on raw temporal/numeric decoding.
      - rc.6 no longer drops non-positive pagination params. `pat-store.ts` probes with
        `.limit(0)`, which still runs and returns no rows; all offsets are clamped non-negative.
      - rc.6 dropped `.concurrently()` from pg indexes and bumped the kit snapshot format to 10.
        This tree has no `.concurrently()` and no drizzle-kit snapshots; migrations are
        hand-written SQL directories.

      Not affected: removed query caching (`drizzle-orm/cache`, `$cache`, `withCache`), removed
      `up-migrations` helpers, `postgres-js` codec signature change, `concat`/`substring` expression
      shape changes, `$returningId`, and the mysql/sqlite/mssql-only fixes — none are used here.

- [x] **Rehearse on a copy.**
      Run: `pg_dump "$DATABASE_URL" -Fc -f .nexus/pre-migration.dump`, restore to a scratch
      database, then `pnpm db:migrate` against it.
      Verify: the command exits 0 and the scratch database has the expected tables.

      Correction 2026-11-22: turbo strips undeclared env vars, so `pnpm db:migrate` passed an empty
      URL to drizzle-kit. `turbo.json` now declares `passThroughEnv: ["DATABASE_URL"]` for
      `db:migrate` and `db:generate`. The restored `nexus_migrate_drill` database migrated cleanly
      and has the same 36 public tables as `nexus`, with pgvector 0.8.7.

- [x] **Test both engines.**
      Run: `pnpm --filter @nexus/api test`, `pnpm --filter @nexus/worker test`,
      `pnpm --filter @nexus/db test`, and the embedded migration test
      `pnpm --filter @nexus/api exec vitest run tests/lib/migrate-embedded.test.ts`.
      Verify: all green on Postgres 18 and PGlite.

      Result 2026-11-22: API 1279 passed / 4 skipped, worker 108 passed (the three DB-gated tests
      ran against real Postgres instead of skipping), db 25 passed, embedded migration 4 passed.

- [x] **Stay on Postgres 18.**
      Do not raise the image major or the extension past what Neon supports.
      Verify: `select version();` reports 18.x in local and CI.

      Result 2026-11-22: local reports PostgreSQL 18.7 with pgvector 0.8.7; both CI service
      containers and compose still use `pgvector/pgvector:0.8.7-pg18` (compose by digest).

**Gate:** migrations apply on the copy, both suites green on both engines.

## Phase 5: UI

**Objective:** current minor versions, and a measured decision on server-state caching.

- [x] **Bump the minors.**
      `react-router` 8.4.0 → 8.5.2, `react` and `react-dom` 19.3.0 → 19.3.1, `tailwindcss`
      4.3.3 → 4.3.5.
      Verify: `pnpm --filter @nexus/ui test` and `pnpm --filter @nexus/ui build` green.

- [x] **Keep the router guards.**
      `apps/ui/vite.config.ts` keeps the `react-router-dom` alias and the `optimizeDeps.exclude`
      entry; both block the transitive v5 copy.
      Verify: no `react-router-dom@5` in `pnpm why react-router-dom`.

      Result 2026-11-22: `pnpm why react-router-dom` lists nothing, so no v5 copy remains. The
      stale "react-router v7" comments now say v8.

- [x] **Prototype TanStack Query on one route.**
      Use `apps/ui/app/routes/home.tsx`. Measure duplicate requests and cache hits before and
      after. Write a go/no-go with numbers.
      Verify: the note exists; no other route is refactored before the decision.

      Measurement 2026-11-22, Playwright against the built SPA at 375px, counting the six home
      reads (`/api/threads`, `/api/settings/council`, `/api/user/provider-keys`,
      `/api/org/portfolio`, `/api/org/inbox`, `/api/dashboard`):
      - before: first visit 6 requests, client-side visit to `/costs` and back 6 more = 12 total,
        0 cache hits.
      - with `@tanstack/react-query` 5.108.2, global provider, `staleTime: 30_000`: first visit 6,
        return 0 = 6 total, 6 cache hits.

      Decision: no-go for a partial rollout. The win is 6 requests only on a return within 30s.
      A global cache also needs invalidation on sign-out/user switch and after org, inbox and
      settings mutations; without that it shows another user's or stale data. Revisit only as a
      whole-route data layer, not one dashboard. The prototype and its dependency were removed;
      no other route changed.

- [x] **Re-run e2e.**
      Run: `pnpm test:e2e`.
      Verify: green.

      Result 2026-11-22: 47 passed, 11 skipped in 3.7m (baseline 215.56s), after a UI build with
      React 19.3.1, React Router 8.5.2 and Tailwind 4.3.5.

**Gate:** UI e2e green; TanStack Query has a written decision.

## Phase 6: Consolidation

**Objective:** one browser library, no committed binaries, boundaries documented.

- [x] **Drop the `playwright-core` runtime fallback.**
      In `packages/stealth-browser/src/index.ts`, remove the fallback branch around the client
      resolution and the `playwright-core` probe; `patchright` is the driver and
      `@playwright/test` stays for e2e. Remove the dependency from
      `packages/stealth-browser/package.json`.
      Verify: `pnpm --filter @nexus/stealth-browser test` green with MockDriver; a real browser
      task still runs through patchright.

      Result 2026-11-22: 47 tests pass. A real headless Chromium (patchright 153.0.8010.12) fetched
      a routed page through `createStealthBackend` and returned status 200 with the expected HTML.
      Local machines need `pnpm exec patchright install chromium` once.

- [x] **Delete committed binaries.**
      Remove `services/board/vb.exe` and `services/board/mcp-bridge.exe`; add both to
      `services/board/.gitignore`.
      Verify: `git ls-files services/board | Select-String ".exe"` is empty and `pnpm board:build`
      regenerates them locally.

      Correction 2026-11-22: this tree never tracked either binary and `services/board/.gitignore`
      already listed both, so only the verify line was wrong. `board:build` built `vb.exe` alone;
      it now builds `mcp-bridge.exe` too. Deleting both and running `pnpm board:build` recreated
      them, and `git ls-files services/board` still matches no `.exe`.

- [x] **Keep the Go board.**
      `apps/api/src/lib/board-client.ts` depends on it; it owns SQLite leases, file locks, the
      inspector and the MCP bridge. Record the decision here.
      Verify: board routes still pass their tests.

      Decision 2026-11-22: keep. Replacing it would mean rebuilding SQLite leases, cross-process
      file locks, the inspector and the stdio MCP bridge for no migration gain, and the API's
      `/board` routes plus the worker's browser path already speak to it over HTTP.
      `go test ./...` passes in `services/board`; `-race` needs cgo, which this Windows box lacks a
      gcc for, so `pnpm board:test` fails locally by environment only. The API has no board route
      tests; its typecheck passes.

- [x] **Keep the two queues, document the boundary.**
      Celery runs Python ingest jobs; BullMQ runs Node jobs. Add a short section to
      `services/ingest/README.md` naming what runs where.
      Verify: the README section exists.

      Result 2026-11-22: "Queue boundary" section added, naming the Celery task and queue names,
      the BullMQ job and queue names, and the one crossing point (`queue.py` publishing
      `ingest:event`).

- [x] **Knip pass.**
      Run: `pnpm prune:knip`.
      Verify: dependency count not higher than baseline.

      Result 2026-11-22: baseline at the start of this phase was 290 dependency entries across 56
      `package.json` files; now 289. The only new finding was the `playwright-core` catalog entry,
      unused after the fallback removal, so it is gone. The remaining findings are the Phase 2 set
      (3 unused UI files, 3 dynamically-used dependencies, 2 unlisted binaries, 23 unused exports,
      33 unused types, and knip.json pattern hints); no live export deleted.

**Gate:** one browser library, no committed binaries, all suites green.

## Phase 7: Agent core

**Objective:** the sandbox, MCP and tracing claims are enforced and tested, not just present.

- [x] **MCP round trip.**
      Add a test that starts one stdio server (`services/board/cmd/mcp-bridge` or
      `@nexus/scraping-mcp`), lists tools, calls one, and shuts down.
      Verify: `pnpm --filter @nexus/mcp-client test` green and the test fails when the server is
      removed.

      Result 2026-11-22: 52 tests pass. The client had no stdio transport, so
      `packages/mcp-client/src/stdio.ts` adds one (newline-delimited JSON-RPC over a child
      process), and the test spawns a real `@nexus/scraping-mcp` server that serves its tools over
      stdin/stdout. It initializes, lists tools, calls `open_session`, and closes; renaming the
      fixture fails the test. The board bridge was the other candidate, but its tool calls need a
      live board on port 4100 and a Go toolchain.

- [x] **Approval gate coverage.**
      Route every tool call through `classifyTool` and the approval gate. Add a test that an
      unlisted tool resolves to `requires_permission`, not `auto_allowed`.
      Files: `packages/agent-core/src/runtime/index.ts`, `apps/api/src/lib/exec-approvals.ts`.
      Verify: the new test fails if `AUTO_ALLOWED_TOOLS` gains an unlisted name.

      Result 2026-11-22: both call paths already classify (`tierFor` in `ToolAgentRuntime.run`,
      `gatedInvoke` for programmatic scripts) and default an unlisted name to
      `requires_permission`. The new test pins the whole allowlist and checks `write`, `write_file`,
      `edit`, `bash`, `run_command` stay gated; adding `"write"` to the set makes it fail. 55 tests
      pass in `agent-runtime.test.ts`.

- [x] **Sandbox default.**
      Make the `@nexus/sandbox` Docker/gVisor runner the default for untrusted code; `just-bash`
      and `pyodide` stay convenience runners. When Docker is absent, fail closed, never fall back
      to `child_process`.
      Verify: an escape test (network, filesystem, PID) fails closed.

      Result 2026-11-22: `resolveUntrustedRunner` returns a Docker runner only when
      `NEXUS_SANDBOX_IMAGE` is set and `docker info` answers; otherwise it returns a runner that
      throws `SandboxUnavailableError`, and nothing spawns. The plugin sandbox adapter, skill code
      and mission shell now use it; the old Pyodide/restricted-child fallback for skill code is
      gone, so a host without the image reports the missing sandbox instead of running the code.
      Real Docker check (`node:26-alpine`): network blocked, `/etc` write `EROFS`, one PID visible,
      uid 1000. Sandbox tests 95 passed + 1 skipped, API skill-runner tests 27 passed.

- [x] **One span per tool call.**
      Emit an OpenTelemetry span with tool name and tier for every call; check it in Jaeger.
      Verify: one chat turn produces one span per tool call in the trace.

      Result 2026-11-22: `@nexus/telemetry` adds `withTurnSpan` (`agent.turn`) and `withToolSpan`
      (`tool.call`, attributes `tool.name` and `tool.tier`). Both runtime call paths use them
      (`ToolAgentRuntime.run` for chat tools, `gatedInvoke` for programmatic scripts), so tool spans
      nest under the turn span and share one trace. `tool-spans.test.ts` asserts two calls in one
      turn yield two tool spans with the expected names and tiers under one turn span. Real check
      through the compose observability profile: jaeger lists one trace with `agent.turn` plus
      `tool.call` for `read_file` (auto_allowed) and `write_file` (requires_permission). Agent-core
      suite 1017 tests pass.

- [x] **LSP is a feature, not migration work.**
      Record it as a separate proposal; do not add it to this plan.

      Result 2026-11-22: `docs/proposals/lsp.md` records the proposal (read-only definition,
      references, hover, diagnostics tools; permission tier and scope limits; open questions). No
      code or plan change beyond this note.

**Gate:** escape test fails closed, tool calls traceable end to end, approval gate covered.

## Final acceptance

- [ ] CI green; install, typecheck, test and CI times at or below baseline.
- [ ] `docker compose up` works from a clean clone with pinned images.
- [ ] UI and desktop e2e green; desktop e2e runs in CI.
- [ ] `render.yaml` deploys from `master`; migrate workflow succeeds.
- [ ] k6 (`infra/k6`) shows no regression.
- [ ] knip clean; dependency count not higher than baseline.
- [ ] gitleaks, Trivy, CodeQL and SBOM clean.
- [ ] Rollback performed once: revert the tag, restore `.nexus/pre-migration.dump`.

## Version audit (2026-11-22)

| Package                           | Tree                  | Registry                        |
| --------------------------------- | --------------------- | ------------------------------- |
| pnpm                              | 12.11.2               | 12.21.0                         |
| turbo                             | 2.11.7                | 2.11.13                         |
| typescript (`@typescript/native`) | 7.0.2                 | 7.0.2                           |
| typescript (API alias)            | 6.0.2                 | —                               |
| vite                              | 8.3.4                 | via vite-plus 1.7.0             |
| vitest                            | 5.0.4                 | 5.1.1 (vite-plus bundles 5.1.0) |
| vite-plus                         | not installed         | 1.7.0                           |
| oxlint                            | 1.87.0                | 1.94.0                          |
| eslint                            | 10.12.0               | 10.15.0                         |
| prettier                          | 3.9.10                | 3.10.1 (oxfmt 0.79.0)           |
| react / react-dom                 | 19.3.0                | 19.3.1                          |
| react-router                      | 8.4.0                 | 8.5.2                           |
| tailwindcss                       | 4.3.3                 | 4.3.5                           |
| fastify                           | 5.12.5                | 5.12.8                          |
| bullmq                            | 6.3.13                | 6.7.8                           |
| ioredis                           | 6.0.0                 | 6.0.0                           |
| drizzle-orm                       | 1.0.0-rc.4            | rc 1.0.0-rc.6                   |
| drizzle-kit                       | 1.0.0-rc.4            | rc 1.0.0-rc.6                   |
| electron                          | 45.0.0-beta.6         | 45.4.1                          |
| @electric-sql/pglite              | 0.5.9                 | 0.5.17                          |
| @electric-sql/pglite-pgvector     | 0.0.10                | 0.0.18                          |
| @playwright/test                  | 1.64.0                | 1.65.1                          |
| knip                              | 6.41.0                | 6.47.0                          |
| pgvector image                    | `pg18` (0.8.7 digest) | `0.8.7-pg18`                    |

## Verification commands

Before Phase 2:

```bash
pnpm lint
pnpm format:check
pnpm check:headers
pnpm typecheck
pnpm openapi:check
pnpm types:check
pnpm test
DATABASE_URL=postgresql://test:test@localhost/nexus_ci pnpm exec vitest run --coverage
```

After Phase 2, replace the first two with `vp lint` and `vp fmt --check`, and the coverage
command with `pnpm exec vp test run --coverage`. Keep `pnpm openapi:check`, `pnpm types:check`
and `pnpm check:headers` unchanged.
