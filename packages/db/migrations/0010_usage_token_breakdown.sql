-- SPDX-License-Identifier: Apache-2.0
-- Migration 0010: per-request token/cost breakdown on usage_events + a BYOK
--                 monthly USD spend-cap on api_keys.
-- Run after 0009_prompts_and_build_tasks.sql.
--
-- Free/open: these meter and cap the user's OWN provider (BYOK) spend. Nexus
-- never charges for itself. monthly_cost_cap_usd NULL = uncapped.

-- ── usage_events: token breakdown + priced USD cost ─────────────────────────────
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "model"              text;
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "prompt_tokens"      integer          NOT NULL DEFAULT 0;
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "completion_tokens"  integer          NOT NULL DEFAULT 0;
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "cache_read_tokens"  integer          NOT NULL DEFAULT 0;
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "cache_write_tokens" integer          NOT NULL DEFAULT 0;
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "cost_usd"           double precision NOT NULL DEFAULT 0;

-- ── api_keys: monthly BYOK spend cap (USD) ──────────────────────────────────────
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "monthly_cost_cap_usd" double precision;
