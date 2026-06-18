<!-- SPDX-License-Identifier: Apache-2.0 -->

# 0014 — i18n-Ready Strings

**Status:** Accepted (amended 2026-06-18 — phased implementation, correct package name)
**Date:** 2026-06-11

## Context

Hard-coded English strings in UI components make future internationalisation a full rewrite instead of a translation task. The original ADR referenced `@nexus/web` — the actual UI package is `@nexus/ui` (React Router 7, `apps/ui/`).

## Decision

**Phase 1 (v1.0 — current):** The `@nexus/ui` app ships a lightweight i18n utility at `apps/ui/app/lib/i18n.ts`. New components SHOULD use it for user-facing labels. Existing hardcoded strings are NOT blocked — they will be migrated progressively. No CI block on hardcoded strings in v1.

**Phase 2 (post-v1.0):** Extract all user-facing strings to `apps/ui/app/lib/i18n/locales/en-US.ts`. Enforce via `eslint-plugin-i18n-json` or equivalent. Community-contributed locales accepted via PR.

`next-intl` is **not used** (Next.js is not in the stack) — the custom `i18n.ts` utility handles translation lookups with the same API contract.

## Consequences

- v1 ships with mostly English hardcoded strings — acceptable for MVP.
- Phase 2 migration is mechanical (search-and-replace + catalogue entry).
- No CI gate on hardcoded strings until Phase 2 is scoped.
- API error messages remain English-only by convention.
