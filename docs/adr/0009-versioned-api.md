<!-- SPDX-License-Identifier: Apache-2.0 -->
# 0009 — Versioned API (/v1/…)

**Status:** Accepted
**Date:** 2026-06-11

## Context
Judica's API routes are unversioned (`/council/deliberate`, `/signals`, etc.). Adding a version prefix after v1.0.0 would break all existing clients.

## Decision
All `@nexus/api` routes carry a `/v1/` prefix from day one. Deprecation policy: a route is supported for 2 minor versions after a replacement is introduced, then removed in the next major.

## Consequences
- Route breakage is never silent — version changes are explicit.
- Clients can pin to `/v1/` and upgrade deliberately.
- More characters to type. Worth it.
