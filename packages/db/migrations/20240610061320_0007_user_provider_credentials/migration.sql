-- SPDX-License-Identifier: Apache-2.0
-- Migration 0007: user_provider_credentials — per-user BYOK LLM provider keys
-- Run after 0006_billing.sql

-- ── user_provider_credentials ───────────────────────────────────────────────────
-- Raw provider keys are NEVER stored. encrypted_key holds base64([iv|tag|ciphertext])
-- (AES-256-GCM). key_prefix is for display; key_hash (SHA-256) supports dedup.
-- One active credential per (user_id, provider); rotation soft-deletes the old row.

CREATE TABLE IF NOT EXISTS "user_provider_credentials" (
  "id"             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"        uuid        NOT NULL,
  "provider"       text        NOT NULL,
  "label"          text,
  "encrypted_key"  text        NOT NULL,
  "key_prefix"     text,
  "key_hash"       text,
  "active"         boolean     NOT NULL DEFAULT true,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now(),
  "last_used_at"   timestamptz,
  "deleted_at"     timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_provider_credentials_user_provider_udx"
  ON "user_provider_credentials" ("user_id", "provider")
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "user_provider_credentials_user_id_idx"
  ON "user_provider_credentials" ("user_id");
