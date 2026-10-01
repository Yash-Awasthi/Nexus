-- SPDX-License-Identifier: Apache-2.0
-- ─── api_keys PAT persistence columns (playtest round 5) ─────────────────────
-- lib/pat-store.ts persists personal-access tokens (nxk_*) in api_keys.
-- These columns carry the PAT-specific fields missing from the original
-- table. Raw tokens are still NEVER stored — SHA-256 key_hash only.
-- BYOK keys (packages/billing) are untouched: they leave the new columns
-- at their defaults.

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "expires_at"  timestamptz;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "last_used_at" timestamptz;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "tier"        text NOT NULL DEFAULT 'basic';
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "scopes"      jsonb NOT NULL DEFAULT '["*"]'::jsonb;