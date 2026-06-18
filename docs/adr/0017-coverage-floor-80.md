<!-- SPDX-License-Identifier: Apache-2.0 -->

# 0017 — Mandatory Code Coverage Floor: 80%

**Status:** Accepted (amended 2026-06-18 — clarified scope; new-package grace period added)
**Date:** 2026-06-11

## Context

The monorepo has 151 packages. 76 have vitest configs with coverage thresholds. 75 do not — many are thin adapters, utility wrappers, or packages created post-audit. The original decision implied universal 80% from day one, which is unworkable at this package count.

## Decision

- CI blocks PRs that lower coverage below the **configured threshold** on any package that **already has a vitest config with thresholds**.
- `@nexus/governance`, `@nexus/runtime`, `@nexus/council`, `@nexus/auth` require **≥ 90%**.
- All other published packages: **≥ 80%** lines/functions/branches.
- **New packages:** Must add a `vitest.config.ts` with thresholds within **2 sprints** of first commit. Until then, CI does not enforce coverage (the package simply has no coverage data).
- **Thin adapters / passthrough packages** (e.g. `@nexus/image-transformations` without sharp): exempt from branch/function thresholds due to optional-dep code paths. Exemption must be documented in `vitest.config.ts` comment.
- Coverage is measured by Vitest's V8 provider.

## Consequences

- PRs to existing well-tested packages cannot regress coverage.
- New packages have a grace window before they need tests — unblocking rapid iteration.
- 75 packages without configs are on the 2-sprint clock from this amendment.
- Thin adapters do not need to mock optional deps to hit 80% branch coverage.
