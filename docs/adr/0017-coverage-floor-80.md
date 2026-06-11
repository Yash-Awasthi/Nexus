<!-- SPDX-License-Identifier: Apache-2.0 -->
# 0017 — Mandatory Code Coverage Floor: 80%

**Status:** Accepted
**Date:** 2026-06-11

## Context
workspace has 0 tests. GhostStack has 499. Judica has 375 spec files. The gap is large and a coverage floor prevents regression.

## Decision
- CI blocks PRs that lower line coverage below **80%** on any published package.
- `@nexus/governance`, `@nexus/runtime`, `@nexus/council`, `@nexus/auth` require **≥ 90%**.
- Thin SDK passthrough adapters may be exempted (documented per-adapter) — the exemption must be explicit in the adapter's `package.json` or test config, not silent.
- Coverage is measured by Vitest's built-in V8 provider.

## Consequences
- Merging code without tests is blocked.
- Large refactors that are hard to test require explicit justification for coverage exemptions.
- The floor compounds: every new package starts with a coverage requirement from day one.
