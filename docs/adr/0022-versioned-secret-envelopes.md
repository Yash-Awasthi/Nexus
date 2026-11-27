<!-- SPDX-License-Identifier: Apache-2.0 -->

# 0022 — Versioned secret envelopes, and a rotation that takes two deploys

**Status:** Accepted
**Date:** 2026-11-25

## Context

Provider keys are AES-256-GCM ciphertext under `NEXUS_SECRETS_KEY` (`packages/db/src/secret-crypto.ts`). The stored
form was bare base64(`[iv|tag|ciphertext]`) with nothing in the row saying which key or which format produced it,
which left two questions unanswerable without decrypting every row and guessing:

- **"How much of the table is still on the old key?"** — a count anybody rotating a key needs before and after.
- **"Can this format change?"** — not without a migration that could tell old rows from new ones.

Changing an at-rest key was, in practice, an outage: the deploy that swapped the variable made every ciphertext
unreadable at once.

## Decision

1. **`encryptSecret` writes a `v1:` envelope.** `decryptSecret` accepts both forms, so the change needs no
   migration of values — only of description.
2. **`user_provider_credentials.key_material_version`** (migration `0023`, default `1`, partial index on `< 2`)
   says which form a row is in. `1` = legacy bare base64, `2` = current envelope. Adding a column with a default
   rewrites nothing.
3. **`NEXUS_SECRETS_KEY_PREVIOUS`** exists for exactly one deploy window. `decryptSecretAnyKey` reports **which key
   opened the row**, so the rotation pass can distinguish "already current" from "readable, needs rewriting".
4. **Rotation is a maintenance command, not a request path**: `apps/api/src/rotate-secrets.ts` (`--dry-run`
   supported) re-encrypts every row — including soft-deleted ones, whose ciphertext is what a rotation is moving
   away from — and reports `rotated / current / skipped / failed`.
5. **A row that cannot be decrypted is named and left untouched.** Deleting it would be data loss dressed as
   housekeeping; overwriting it would be worse.

## Consequences

- **The durability class of the rotation is "safe to run twice, safe to run wrong".** A second run reports every
  row as `current`; a run without the previous key reports every row as `skipped` and exits non-zero instead of
  producing a half-rotated table.
- **Operators now have a two-deploy procedure** (`docs/runbook.md` §11.4) and `.env.example` documents the
  second variable. `scripts/rotation-drill.test.mjs` reads that procedure as data, so it cannot rot into
  instructions pointing at a script that no longer exists.
- MFA and OAuth vaults use the same primitive at the lower level (`encryptWithKey`), which is unchanged; their
  envelopes are their own decisions and are not migrated by this ADR.
- Cost: one extra column, one partial index, ~90 lines of code, and a command that must be documented well enough
  to run at 3am.
