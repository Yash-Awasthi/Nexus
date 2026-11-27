<!-- SPDX-License-Identifier: Apache-2.0 -->

# 0024 — Budgets and retention are checked numbers, not aspirations

**Status:** Accepted
**Date:** 2026-11-25

## Context

Three kinds of number in this repository look like configuration and behave like promises:

- **Coverage floors** (`scripts/coverage-floors.test.mjs`) — the minimum line coverage each package must keep.
- **Performance budgets** (`scripts/perf-budget.test.mjs`, plus `api-boot-budget` and `bundle-budget` in
  `make verify`) — how long a boot may take, how large a bundle may be, how long a route may respond.
- **Retention** (`RETENTION` in `packages/contracts/src/shared/retention.ts`) — how long every store keeps data.

Each had a failure mode in common: the number lived somewhere reasonable, a document described it, and nothing
connected the two. A budget lowered to make a build pass, a floor deleted with the test file, a retention policy
described in prose while the store used its own literal.

## Decision

1. **Every budget and floor is a measured number with a recorded baseline**, and `make verify` fails when the
   measurement exceeds it. Numbers were taken on this hardware and written down beside the gate, not estimated.
2. **Retention is a value in code, and every value names its enforcer.** `RETENTION` entries carry
   `enforcedBy: {file, symbol}`; `apps/api/tests/lib/retention.test.ts` reads that file and fails if the symbol is
   gone. `scripts/retention-policy.test.mjs` fails if a second copy of any of those numbers appears in source, or
   if any code path learns to delete from `audit_log`.
3. **A floor may fall, but only with a reason.** Lowering one is a decision recorded here or in the plan, because
   the alternative — a floor quietly adjusted per push — makes the gate decorative.
4. **The gates that enforce these numbers are documented in `docs/OPS.md`** §10 with what they measure and what
   fails on regression, so a red build points at a number and a reason rather than at a workflow name.

## Consequences

- A failing budget is now a conversation about whether the regression is acceptable, instead of a workflow to
  skip. That is slower on the day and much faster over a quarter.
- Coverage floors are per package, not a single global percentage: a global number lets a well-covered UI package
  hide a kernel with none.
- The retention table gained stores that had been implicitly "forever" (sessions, sandbox drives) and made one row
  honest rather than invented (logs, whose window belongs to the deployment).
- These numbers are hardware-dependent. The budgets record the machine they were measured on, and a CI runner that
  differs is expected to be slower — which is why the budgets have headroom and the gate fails on regression
  rather than on a fixed millisecond count.
