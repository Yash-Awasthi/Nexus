<!-- SPDX-License-Identifier: Apache-2.0 -->

# Contributing to Nexus

From a fresh clone to a reviewable pull request: how to set the tree up, which commands
decide whether a PR is reviewable, and the four rules a PR has to satisfy. Each rule names
the file that implements it, so a rule that stops being true fails a check instead of
quietly becoming folklore.

## Prerequisites

| Tool    | Version                                                            | Source                                |
| ------- | ------------------------------------------------------------------ | ------------------------------------- |
| Node.js | 26 locally; `engines.node >=24` for consumers                      | `.nvmrc`, `package.json`              |
| pnpm    | 12 — `packageManager: pnpm@12.21.0` pins it                        | `package.json`                        |
| Docker  | only for Postgres, Redis and the sandbox; the API boots without it | `docs/DEPLOYMENT.md` §Offline machine |

`nvm use` reads `.nvmrc`; `devbox shell` reads `devbox.json`, which pins Node 26 and pnpm.

## Local setup

```bash
git clone https://github.com/Yash-Awasthi/Nexus.git
cd Nexus
nvm use
pnpm install
pnpm build
```

CI installs with `pnpm install --frozen-lockfile` in every workflow under
`.github/workflows/`; use that form when you are checking a lockfile change. The full stack
(Postgres, Redis, API, UI) is `docker compose up -d` then `pnpm dev` — see
`docker-compose.yml` and `docs/DEPLOYMENT.md`.

## Running locally

| Command                                         | What it runs                                                           | Source         |
| ----------------------------------------------- | ---------------------------------------------------------------------- | -------------- |
| `pnpm dev`                                      | every app in watch mode (`turbo run dev --parallel`)                   | `package.json` |
| `pnpm build`                                    | `tsc -b` then `turbo run build`                                        | `package.json` |
| `pnpm test`                                     | every workspace's unit suite (`turbo run test`)                        | `package.json` |
| `pnpm test:e2e`                                 | Playwright                                                             | `package.json` |
| `pnpm lint`                                     | `scripts/lint.mjs` — every workspace, both Go modules, plus CLI parity | `package.json` |
| `pnpm typecheck`                                | `tsc -b --noEmit` after `react-router typegen`                         | `package.json` |
| `pnpm format`                                   | rewrite formatting (`vp fmt`)                                          | `package.json` |
| `pnpm format:check`                             | fail on formatting drift                                               | `package.json` |
| `pnpm openapi:generate` / `pnpm types:generate` | regenerate the spec and contract types                                 | `package.json` |
| `pnpm db:migrate`                               | apply `packages/db/migrations`                                         | `package.json` |

## Rules before you push

Four rules decide whether a PR is reviewable at all. They are short because they are meant
to be checked, not quoted.

### 1. The pre-push gate must pass

Run the same commands CI runs, from the repo root. These are the script names in
`package.json`, and each maps to a job in `.github/workflows/`:

```bash
pnpm install            # CI uses --frozen-lockfile
pnpm typecheck          # build.yml
pnpm lint               # lint.yml (ESLint + Prettier job)
pnpm format:check       # lint.yml — `pnpm format` fixes
pnpm check:headers      # lint.yml (hygiene job): SPDX headers, scripts/check-license-headers.ts
pnpm check:docs         # lint.yml (hygiene job): every env var read is documented, scripts/check-env-docs.mjs
pnpm test               # test.yml (unit job)
```

Two more belong in the same run when your change touches them — both are gates in
`test.yml`:

```bash
pnpm openapi:check      # generated spec matches the routes
pnpm types:check        # generated contract types match the spec
```

`pnpm verify` runs the full list, derived from the workflow files by `scripts/verify.mjs`,
and reports any CI step no gate covers. A PR that fails any of these is not reviewed,
because a reviewer cannot tell a real failure from its noise.

### 2. A local run never requires a paid API

This is invariant 1 in `plan.md` §0: _no paid API is required for a local run; a missing
model key degrades, never blocks, the UI._ `docs/STATUS.md` opens with the same claim
("local, no paid APIs"), and `docs/DEPLOYMENT.md` §"Offline machine" is the path that keeps
it true without Docker, without Ollama and without a server database.

So a new feature must have a working path with no paid key: a local model, a deterministic
fallback, or an explicit "this needs a key" state the UI shows without breaking. Two
mechanical guards exist:

- `apps/api/tests/lib/offline-mode.test.ts` removes every network-shaped variable, boots
  the API and asserts `/health` answers `{"status":"ok"}`. `test.yml`'s **Offline boot (no
  Docker, no Ollama)** job runs that file on a bare runner.
- `pnpm check:offline` (`scripts/offline-check.mjs`) runs the offline acceptance checks with
  outbound sockets disabled (`scripts/e2e-offline.cjs`); a missing Ollama or SearXNG reports
  `skip` with the reason.

What neither does is scan tests for a paid key, so "only passes with a real key" is a review
rule here, not a CI failure: a test that needs a live account is a broken test.

### 3. The surface policy holds

Invariant 4 in `plan.md` §0, restated: pages removed in the pruning passes — **God Mode,
Gauntlet, Drift, Simulation, Voice, Image Gen, prediction markets, marketplace, prompts,
drive, deep research, red team, A/B arena, app builder, and the wiki/alert/brief
satellites** — are not re-added. Widening happens **inside** a surviving surface.

This is a review rule, not a task (`plan.md` §7, wave rules). No script or workflow in the
tree names those surfaces, so nothing fails automatically when one comes back; a reviewer
is the check. If you believe a removed surface should return, that is an ADR superseding
the pruning (`docs/adr/`, template at `docs/adr/_template.md`), not a diff. `docs/adr/0009-versioned-api.md`
is the related decision for the API surface itself.

### 4. One subtask, one PR

Each `plan.md` subtask is one reviewable change: one route, one component, one command. A
PR that also renames a package, reformats a directory and fixes three unrelated warnings
cannot be reviewed and will be asked to split. If the work is large, split it by subtask id
(`m4.2.3: command palette`) so the reviewer reads one thing at a time.

Also a review rule: the only machine check on a PR is the required-check list in
`.github/required-checks.json` (snapshot in `docs/OPS.md` §8), which does not count files or
subtasks.

## Writing tests

- Unit and integration tests use Vitest through `vite-plus/test` (`vp`); e2e uses
  Playwright. Test locations are per package (see `docs/TESTING.md`).
- Coverage thresholds are set once in `vitest.config.ts`: statements 85, lines 87,
  functions 86, branches 73. `test.yml` runs `pnpm exec vp test run --coverage` and
  `node scripts/coverage-floors.mjs --strict`; do not lower the numbers.
- `docs/TESTING.md` records every skip and the switch that turns it on, so a new skip needs
  an entry and a switch.

### Running one test, and debugging it

The whole suite takes minutes; one file takes seconds. The binary lives at the repo root,
so from an app directory the path is two levels up:

```bash
cd apps/api && ../../node_modules/.bin/vp test run tests/routes/webhooks.test.ts
cd apps/ui  && ../../node_modules/.bin/vp test run tests/command-palette.test.ts
cd apps/cli && ../../node_modules/.bin/vp test run tests/lib/watch-run.test.ts
cd services/board && go test ./pkg/mcp/ -run TestApproval -v
node --test scripts/actions-pinned.test.mjs      # repo-level Node scripts
```

Add `-t "part of the test name"` to run one case, and `--watch` to rerun on save. A test
that imports `src/lib/*` must sit at the matching depth: `apps/cli/tests/lib/x.test.ts`
resolves `../../src`, while `apps/cli/tests/x.test.ts` resolves `../src`.

When the assertion does not explain the failure:

```bash
node --inspect-brk ../../node_modules/.bin/vp test run tests/routes/webhooks.test.ts
LOG_LEVEL=debug pnpm dev:api     # one line per request: route, status, timing (never the body)
```

`LOG_LEVEL=debug` is the API's pino level and does not print request bodies or keys;
`pnpm dev:api` is the `@nexus/api` dev script in `package.json`. For a browser-only failure,
`pnpm test:e2e --headed` with `PWDEBUG=1` opens Playwright's inspector.

## Adding a changeset

Published packages are versioned by Changesets (`.changeset/`, decision in
`docs/adr/0013-conventional-commits-changesets.md`):

```bash
pnpm changeset          # writes .changeset/<name>.md
git add .changeset/
```

`docs/RELEASE-NOTES.md` renders the pending set, and `pnpm release:notes:check` (run in
`lint.yml`) fails when that page and the changesets disagree — so edit the changeset, not
the page. A docs-only PR has nothing to version, and no changeset.

## Commit conventions

Conventional Commits, enforced by `commitlint` in `.husky/commit-msg` and by
`.github/workflows/conventional-commits.yml`:

```
<type>(<scope>): <description>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`. Scope is the
package name, e.g. `feat(runtime): add redis queue backend`.

## Submitting a PR

1. Branch from `master` (`feat/my-feature`, `fix/my-bug`).
2. Write code, tests and docs; run the gate in rule 1.
3. Add a changeset if a published package changed.
4. Open the PR against `master` and fill in `.github/PULL_REQUEST_TEMPLATE.md`.
5. CI runs the workflows in `.github/workflows/`; the required checks are the nine listed in
   `docs/OPS.md` §8 (snapshot `.github/required-checks.json`). All must be green.

## Adding an ADR

Architecture Decision Records live in `docs/adr/` and are immutable once merged; to
supersede one, write a new ADR that says so.

```bash
cp docs/adr/_template.md docs/adr/NNNN-short-title.md
# Fill in: Status, Context, Decision, Consequences; then reference it from the code or doc
```

## Adding an adapter (plugin)

See `docs/plugin-author-guide.md`. Scaffold with `pnpm scaffold:adapter my-service`
(`scripts/scaffold.ts`), implement `defineAdapter()` from `packages/plugin-sdk`, and use the
contract helpers in `packages/plugin-sdk/src/testing.ts`.

## Adding a CLI command

Commands are declared with `commander` in `apps/cli/src/index.ts`; logic lives in
`apps/cli/src/lib/`. `pnpm cli:parity` (`scripts/cli-parity.mjs`) keeps the CLI and the API
surface in step.

## Governance extension

New policies and guardrails go in `packages/governance/src/`, implementing the relevant
interface from `packages/governance/src/interfaces/`, with unit tests for known-good and
known-bad inputs.
