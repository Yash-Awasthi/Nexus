-- SPDX-License-Identifier: Apache-2.0
-- Migration 0005: email_verification_tokens table
--
-- One-time tokens for email address verification.
-- token_hash = SHA-256(raw_token). 24-hour TTL.
-- used_at enforces single-use to prevent replay.

CREATE TABLE IF NOT EXISTS "email_verification_tokens" (
  "id"          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "token_hash"  text        NOT NULL,
  "user_id"     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "email"       text        NOT NULL,
  "expires_at"  timestamptz NOT NULL,
  "used_at"     timestamptz,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_verification_tokens_token_hash_udx"
  ON "email_verification_tokens" ("token_hash");

CREATE INDEX IF NOT EXISTS "email_verification_tokens_user_id_idx"
  ON "email_verification_tokens" ("user_id");

CREATE INDEX IF NOT EXISTS "email_verification_tokens_email_idx"
  ON "email_verification_tokens" ("email");

-- Periodic cleanup hint: DELETE FROM email_verification_tokens
--   WHERE expires_at < now() - interval '7 days';
