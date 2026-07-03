<!-- SPDX-License-Identifier: Apache-2.0 -->

# Contributing to NEXUS

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
12. [DCO sign-off](#dco-sign-off)

---

## Prerequisites

| Tool    | Version            | Install                                         |
| ------- | ------------------ | ----------------------------------------------- |
| Node.js | 20 LTS (`20.18.0`) | [nvm](https://github.com/nvm-sh/nvm): `nvm use` |
| pnpm    | 9.x                | `npm i -g pnpm@9`                               |
| Python  | 3.11               | [pyenv](https://github.com/pyenv/pyenv)         |
| Docker  | 24+                | [docker.com](https://docker.com)                |
| Git     | 2.40+              | system package manager                          |

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
nvm use                    # pins to .nvmrc (Node 20.18.0)
pnpm install               # installs all workspace dependencies
pnpm build                 # builds every package
```

For the Python ingest service:

```bash
cd services/ingest
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
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
- Coverage floor: **≥ 80%** on all published packages; **≥ 90%** on `runtime`, `governance`, `council`, `auth`.
- CI blocks PRs that lower coverage below the floor.
- Every adapter must have a contract test using `@nexus/plugin-sdk/testing`.

```bash
pnpm test --filter @nexus/runtime        # single package
pnpm test --coverage                     # with coverage report
```

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

Signed-off-by: Your Name <your@email.com>
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
# Scaffold a new adapter package
mkdir -p packages/adapters/my-service/src
# Implement defineAdapter() from @nexus/plugin-sdk
# Add contract tests using @nexus/plugin-sdk/testing
# Add to pnpm-workspace.yaml
# Add a changeset
```

---

## Adding a CLI command

New commands go in `apps/cli/src/commands/`. Each command is a file that exports a `yargs` command object. Add it to `apps/cli/src/index.ts`.

---

## Governance extension

New policies/guardrails go in `packages/governance/src/`. Implement the relevant interface from `packages/governance/src/interfaces/`. Add unit tests with known-good and known-bad inputs.

---

## DCO sign-off

Every commit must be signed off:

```bash
git commit -s -m "feat(runtime): my change"
# adds: Signed-off-by: Your Name <email>
```

To add DCO to all commits in your branch retroactively:

```bash
git rebase HEAD~N --signoff
```

The DCO check is enforced in CI via `dco.yml`.
