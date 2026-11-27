-- SPDX-License-Identifier: Apache-2.0
-- Migration 0023: key-material version for encrypted provider credentials
--
-- Ciphertext can outlive the format that produced it: a row written before the `v1:` envelope existed is a bare
-- base64 `[iv|tag|ciphertext]`, and a row written after it is prefixed. Both decrypt, so nothing breaks — but
-- "how many rows are still on the old form" was not answerable without decrypting every row and guessing at the
-- shape. This column makes it a count.
--
--   1 = legacy bare base64 (written before the envelope)
--   2 = current envelope, re-encrypted by scripts/rotate-secrets.mjs
--
-- The default is 1 so existing rows are described correctly without a backfill pass, and the rotation script is
-- what moves a row to 2. Adding a column with a default rewrites nothing on Postgres 11+.

ALTER TABLE "user_provider_credentials"
  ADD COLUMN IF NOT EXISTS "key_material_version" integer NOT NULL DEFAULT 1;

-- The rotation script scans for work by this column, so it is indexed; partial, because most instances never
-- rotate and an unconditional index on a boolean-shaped column earns nothing.
CREATE INDEX IF NOT EXISTS "user_provider_credentials_key_version_idx"
  ON "user_provider_credentials" ("key_material_version")
  WHERE "key_material_version" < 2;
