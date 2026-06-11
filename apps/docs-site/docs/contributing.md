---
id: contributing
title: Contributing
sidebar_position: 11
---

# Contributing to NEXUS

Thank you for considering a contribution! NEXUS follows strict quality gates — read this guide before opening a PR.

## Developer Certificate of Origin (DCO)

All commits must be signed off with `git commit -s`. This certifies that you wrote the code and have the right to contribute it.

```bash
git commit -s -m "feat(adapter): add Stripe webhook adapter"
```

## Code style

- **TypeScript:** `strict: true`, no `any`, TSDoc on all exports
- **Python:** Ruff formatter + mypy `--strict`
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`)

## Adding an adapter

See the [Plugin Author Guide](./plugin-author-guide) — the full walkthrough takes < 30 minutes.

Open a PR with label `adapter-proposal`. Include:
- The adapter implementation in `packages/adapters/<name>/`
- Tests with ≥ 80% coverage
- `README.md` documenting required env vars

## Running the test suite

```bash
pnpm test                    # all packages
pnpm --filter @nexus/council test   # single package
pnpm typecheck               # TypeScript across all packages
pnpm lint                    # ESLint + Ruff
```

## PR checklist

- [ ] `pnpm typecheck` green
- [ ] `pnpm test` green (coverage ≥ 80%)
- [ ] `pnpm lint` green
- [ ] SPDX header on every new file: `// SPDX-License-Identifier: Apache-2.0`
- [ ] Conventional commit message
- [ ] DCO sign-off (`git commit -s`)
- [ ] `docs/adr/` updated if architectural decision was made

## Getting help

- Open a [GitHub Discussion](https://github.com/Yash-Awasthi/Nexus/discussions)
- Check existing [ADRs](./adrs) before proposing architecture changes
- Review `GOVERNANCE.md` for the project decision-making process
