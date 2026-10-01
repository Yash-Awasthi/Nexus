-- SPDX-License-Identifier: Apache-2.0
-- Migration 0012: oauth_credentials — per-user OAuth tokens (llm-oauth providers)
-- Run after 0011_agent_sessions.sql

-- ── oauth_credentials ───────────────────────────────────────────────────────────
-- The whole token bundle is sealed as one AES-256-GCM blob. sealed_tokens holds
-- base64([iv|tag|ciphertext]) of JSON(OAuthTokens) (access + refresh + expiry),
-- wire-compatible with the BYOK secret-crypto vault. The refresh token is never
-- stored in the clear. scope + expires_at are non-secret mirrors for querying
-- "expiring soon" without decrypting.
--
-- One live credential per (user_id, provider). Per packages/llm-oauth/SECURITY.md
-- §7, revocation is a HARD DELETE (no soft-delete column) — a soft-deleted sealed
-- token is still a live grant.

CREATE TABLE IF NOT EXISTS "oauth_credentials" (
  "id"                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"           uuid        NOT NULL,
  "provider"          text        NOT NULL,
  "sealed_tokens"     text        NOT NULL,
  "scope"             text,
  "expires_at"        timestamptz,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now(),
  "last_refreshed_at" timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "oauth_credentials_user_provider_udx"
  ON "oauth_credentials" ("user_id", "provider");

CREATE INDEX IF NOT EXISTS "oauth_credentials_user_id_idx"
  ON "oauth_credentials" ("user_id");
