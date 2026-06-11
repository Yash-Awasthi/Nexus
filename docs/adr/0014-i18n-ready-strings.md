<!-- SPDX-License-Identifier: Apache-2.0 -->
# 0014 — i18n-Ready Strings

**Status:** Accepted
**Date:** 2026-06-11

## Context
Hard-coded English strings in UI components make future internationalisation a full rewrite instead of a translation task.

## Decision
All user-facing strings in `@nexus/web` are extracted to message catalogues in `apps/web/app/messages/*.json`. `next-intl` (or equivalent) is used for rendering. No hard-coded UI strings outside the message files. `en-US` ships with v1.0.0. Community-contributed locales are accepted via PR.

## Consequences
- Adding a new UI string requires a message catalogue entry — slightly more work per string.
- Community translation PRs are mechanically straightforward.
- API error messages are English-only (by convention); only user-facing UI text is i18n'd.
