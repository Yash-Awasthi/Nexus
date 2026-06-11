<!-- SPDX-License-Identifier: Apache-2.0 -->
# 0012 — Reproducible Builds

**Status:** Accepted
**Date:** 2026-06-11

## Context
"Works on my machine" failures are expensive. Container supply-chain attacks via mutable `latest` tags are a real threat vector.

## Decision
- Node version pinned to `20.18.0` via `.nvmrc`.
- Python version pinned to `3.11` via `.python-version`.
- pnpm version pinned to `9.x` in `package.json#packageManager`.
- All `FROM` directives in Dockerfiles reference SHA256 digests, not tags.
- `pnpm install --frozen-lockfile` is required in CI.
- Renovate-bot opens auto-PRs for dependency upgrades; humans review and merge.

## Consequences
- CI is deterministic across machines and time.
- Base image updates require a PR (intentional).
- SHA256 pinning means images must be updated explicitly when base images release security patches — Renovate handles this automatically.
