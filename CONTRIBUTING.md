<!-- SPDX-License-Identifier: Apache-2.0 -->

# Contributing to Nexus

Thank you for your interest in contributing. This guide covers everything you need to go from a fresh clone to a merged pull request.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Local setup](#local-setup)
3. [Running locally](#running-locally)
4. [Writing tests](#writing-tests)
5. [Adding a changeset](#adding-a-changeset)
6. [Commit conventions](#commit-conventions)
7. [Submitting a PR](#submitting-a-pr)
8. [Adding an ADR](#adding-an-adr)
9. [Adding an adapter (plugin)](#adding-an-adapter-plugin)
10. [Adding a CLI command](#adding-a-cli-command)
11. [Governance extension](#governance-extension)

---

## Prerequisites

| Tool    | Version   | Install                                         |
| ------- | --------- | ----------------------------------------------- |
| Node.js | 26 (`26`) | [nvm](https://github.com/nvm-sh/nvm): `nvm use` |
| pnpm    | 12.x      | `npm i -g pnpm@12`                              |
| Python  | 3.14 (uv) | [uv](https://docs.astral.sh/uv/)                |
| Docker  | 24+       | [docker.com](https://docker.com)                |
| Git     | 2.40+     | system package manager                          |

> **Reproducible environment (recommended):** Install [Devbox](https://www.jetify.com/devbox/docs/installing_devbox/) and run `devbox shell` from the repo root. This pins Node, pnpm, Python, and Go to the exact versions in `devbox.json` without touching your system.

---

## Local setup

### With Devbox (recommended)

```bash
# 1. Install Devbox (one-time)
curl -fsSL https://get.jetify.com/devbox | bash

# 2. Clone and enter shell
git clone https://github.com/Yash-Awasthi/Nexus.git
cd Nexus
devbox shell           # activates pinned Node / pnpm / Python / Go

# 3. Install dependencies and build
devbox run install
devbox run build
```

### Manual setup

```bash
git clone https://github.com/Yash-Awasthi/Nexus.git
cd nexus
nvm use                    # pins to .nvmrc (Node 26)
pnpm install               # installs all workspace dependencies
pnpm build                 # builds every package
```

For the Python ingest service:

```bash
cd services/ingest
uv sync --extra dev        # Python 3.14, versions pinned by uv.lock
```

Start the full stack (Postgres + Redis + API + ingest):

```bash
docker compose up -d       # starts postgres, redis, ingest (see docker-compose.yml)
pnpm dev
```

---

## Running locally

| Command              | Description                            |
| -------------------- | -------------------------------------- |
| `pnpm dev`           | Start all apps in watch mode           |
| `pnpm build`         | Build all packages                     |
| `pnpm test`          | Run all unit tests (Vitest)            |
| `pnpm test:e2e`      | Run Playwright e2e tests               |
| `pnpm lint`          | Run ESLint across the monorepo         |
| `pnpm typecheck`     | Run `tsc --noEmit` across all packages |
| `pnpm format:check`  | Check Prettier formatting              |
| `pnpm format`        | Auto-fix formatting                    |
| `pnpm generate`      | Regenerate OpenAPI clients + types     |
| `pnpm db:migrate`    | Apply all DB migrations                |
| `pnpm check:headers` | Verify SPDX license headers            |

---

## Writing tests

- All tests live in `<package>/tests/` or colocated `*.test.ts` files.
- Use **Vitest** for unit + integration tests. Use **Playwright** for e2e.
- Coverage thresholds are set once in `vitest.config.ts`: statements 85, lines 87,
  functions 86, branches 73. `pnpm exec vp test run --coverage` enforces them.
- CI blocks PRs that lower coverage below those numbers.
- Every adapter must have a contract test using `@nexus/plugin-sdk/testing`.

```bash
pnpm test --filter @nexus/agent-core        # single package
pnpm exec vp test run --coverage            # with coverage report
```

### Running one test, and debugging it

The whole suite takes minutes; one file takes seconds. Vitest in this repo is `vite-plus/test`
(`vp`), and the binary lives at the repo root, so from an app directory the path is two levels up:

```bash
cd apps/api && ../../node_modules/.bin/vp test run tests/routes/webhooks.test.ts
cd apps/ui  && ../../node_modules/.bin/vp test run tests/command-palette.test.ts
cd apps/cli && ../../node_modules/.bin/vp test run tests/lib/watch-run.test.ts
cd services/board && go test ./pkg/mcp/ -run TestApproval -v
node --test scripts/actions-pinned.test.mjs      # the repo-level Node scripts
```

Add `-t "part of the test name"` to run one case, and `--watch` to rerun on save. A test that
imports `src/lib/*` must sit at the matching depth: `apps/cli/tests/lib/x.test.ts` resolves
`../../src`, while `apps/cli/tests/x.test.ts` resolves `../src` and will fail to find the module.

When a test fails for a reason you cannot read from the assertion, debug rather than guess:

```bash
node --inspect-brk ../../node_modules/.bin/vp test run tests/routes/webhooks.test.ts
LOG_LEVEL=debug pnpm dev:api     # one line per request: route, status, timing (never the body)
```

`LOG_LEVEL=debug` is the API's own pino level; it does not print request bodies or keys. For a
route that fails only in a real browser, `pnpm test:e2e` with `--headed` and `PWDEBUG=1` opens
Playwright's inspector instead of a video of the failure.

Conventions for new work: build against mocks (`MockTransport`, an injectable `fetchFn` or
`TokenHttp`) so no test needs a live account; new env vars go in `.env.example`; every new file
carries the SPDX `Apache-2.0` header (`pnpm check:headers`); migrations are a
`packages/db/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql` folder with a timestamp later than
every existing one (folders run in name order); UI routes register in `apps/ui/app/routes.ts`, compose `app/components/page.tsx`, and follow
`provider-keys.tsx` for CRUD pages or `costs.tsx` for dashboards. Route changes regenerate
`openapi.yaml` (`pnpm openapi:generate`) and the contract types (`pnpm types:generate`).

---

## Rules before you push

Four rules decide whether a PR is reviewable at all. They are short because they are meant to
be checked, not quoted.

**1. The pre-push gate must pass.** Run the same commands CI runs, from the repo root. A PR that
fails any of these is not reviewed, because nobody can tell a real failure from its noise:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm check:headers && pnpm openapi:check
```

Two more are worth running when your change touches what they cover:

```bash
pnpm check:offline      # the local model path still works (see rule 2)
pnpm bundle:budget      # the UI route you touched is still inside its size budget
```

**2. A local run never requires a paid API.** The no-paid-API promise is a product invariant, not
a convenience: a missing model key degrades a feature and never blocks the app. So a new feature
must have a working path with no paid key — a local model, a deterministic fallback, or an
explicit "this needs a key" state that the UI shows without breaking. `pnpm check:offline` guards
it; a test that only passes with a real key is a broken test.

**3. The surface policy holds.** Removed surfaces are not re-added. God Mode, Gauntlet, Drift,
Simulation, Voice, Image Gen, prediction markets, marketplace, prompts, drive, deep research, red
team, A/B arena, app builder, and the wiki/alert/brief satellites were pruned deliberately; a PR
that brings one back is closed with a link to this section. Widening happens **inside** a
surviving surface. If you believe a removed surface should return, that is an ADR arguing against
the pruning, not a diff.

**4. One subtask, one PR.** Each `plan.md` subtask is one reviewable change: one route, one
component, one command. A PR that also renames a package, reformats a directory and fixes three
unrelated warnings cannot be reviewed and will be asked to split. If the work is large, split it
by subtask id (`m4.2.3: command palette`) so the reviewer can read one thing at a time.

---

## Adding a changeset

Every PR that modifies a published package **must** include a changeset:

```bash
pnpm changeset          # follow the interactive prompts
git add .changeset/
```

If your PR is purely docs, CI, or a test fix with no package API change, mark it with `--no-version`:

```bash
# In your PR description add:
# changeset: none
```

---

## Commit conventions

This repo uses [Conventional Commits](https://www.conventionalcommits.org/). `commitlint` enforces this on every commit.

```
<type>(<scope>): <description>

[optional body]
```

| Type       | When to use                                             |
| ---------- | ------------------------------------------------------- |
| `feat`     | New feature or capability                               |
| `fix`      | Bug fix                                                 |
| `docs`     | Documentation only                                      |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test`     | Adding or fixing tests                                  |
| `chore`    | Build system, tooling, CI                               |
| `perf`     | Performance improvement                                 |
| `ci`       | CI configuration changes                                |

Scope = package name, e.g. `feat(runtime): add redis queue backend`.

---

## Submitting a PR

1. Fork the repo and create a branch: `feat/my-feature` or `fix/my-bug`.
2. Write code, tests, and docs.
3. Add a changeset if you modified a published package.
4. Run `pnpm lint && pnpm typecheck && pnpm test` locally — all must pass.
5. Open a PR against `main`. Fill out the PR template fully.
6. CI runs automatically. All checks must be green before merge.
7. One maintainer review required.

---

## Adding an ADR

Architecture Decision Records live in `docs/adr/`. To add one:

```bash
# Create the next numbered file
cp docs/adr/_template.md docs/adr/NNNN-short-title.md
# Fill in: Status, Context, Decision, Consequences
# Reference the ADR from the relevant code or docs
```

ADRs are immutable once merged. To supersede one, create a new ADR that explicitly states it supersedes the old one.

---

## Adding an adapter (plugin)

See [`docs/plugin-author-guide.md`](docs/plugin-author-guide.md) for the full guide. Quick version:

```bash
# Scaffold a new adapter package under packages/adapters/<name>
pnpm scaffold:adapter my-service
# Implement defineAdapter() from @nexus/plugin-sdk
# Add contract tests using @nexus/plugin-sdk/testing
# Add a changeset
```

---

## Adding a CLI command

Commands are declared with `commander` in `apps/cli/src/index.ts`; their logic lives in `apps/cli/src/lib/`.

---

## Governance extension

New policies/guardrails go in `packages/governance/src/`. Implement the relevant interface from `packages/governance/src/interfaces/`. Add unit tests with known-good and known-bad inputs.
