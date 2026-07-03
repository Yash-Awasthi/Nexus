-- SPDX-License-Identifier: Apache-2.0
-- Migration 0004: password_reset_tokens table
--
-- Single-use time-limited tokens for password recovery.
-- Raw tokens are never stored; token_hash = SHA-256(raw_token).
-- Tokens expire 1 hour after creation.
-- used_at is set on redemption to prevent replay attacks.

CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id"          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "token_hash"  text        NOT NULL,
  "user_id"     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "expires_at"  timestamptz NOT NULL,
  "used_at"     timestamptz,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_token_hash_udx"
  ON "password_reset_tokens" ("token_hash");

CREATE INDEX IF NOT EXISTS "password_reset_tokens_user_id_idx"
  ON "password_reset_tokens" ("user_id");

CREATE INDEX IF NOT EXISTS "password_reset_tokens_expires_at_idx"
  ON "password_reset_tokens" ("expires_at");

-- Periodic cleanup hint: DELETE FROM password_reset_tokens
--   WHERE expires_at < now() - interval '7 days';
