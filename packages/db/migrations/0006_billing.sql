-- SPDX-License-Identifier: Apache-2.0
-- Migration 0006: Billing tables — api_keys, usage_events, subscriptions,
--                                  stripe_webhook_events
-- Run after 0005_email_verification.sql

-- ── api_keys ──────────────────────────────────────────────────────────────────
-- Raw keys are NEVER stored. SHA-256 hash used for lookup; key_prefix for display.

CREATE TABLE IF NOT EXISTS "api_keys" (
  "id"             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "key_hash"       text        NOT NULL,
  "key_prefix"     text        NOT NULL,
  "name"           text        NOT NULL,
  "owner_id"       text        NOT NULL,
  "plan"           text        NOT NULL DEFAULT 'free' CHECK ("plan" IN ('free', 'pro', 'enterprise')),
  "monthly_quota"  integer,
  "rpm_limit"      integer,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "revoked_at"     timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_key_hash_udx"  ON "api_keys" ("key_hash");
CREATE        INDEX IF NOT EXISTS "api_keys_owner_id_idx"  ON "api_keys" ("owner_id");
CREATE        INDEX IF NOT EXISTS "api_keys_plan_idx"      ON "api_keys" ("plan");

-- ── usage_events ──────────────────────────────────────────────────────────────
-- Per-request billing meter written by quota middleware.

CREATE TABLE IF NOT EXISTS "usage_events" (
  "id"           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "api_key_id"   uuid        NOT NULL REFERENCES "api_keys"("id") ON DELETE CASCADE,
  "endpoint"     text        NOT NULL,
  "cost_units"   integer     NOT NULL DEFAULT 1,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "usage_events_api_key_id_idx"  ON "usage_events" ("api_key_id");
CREATE INDEX IF NOT EXISTS "usage_events_created_at_idx"  ON "usage_events" ("created_at");

-- ── subscriptions ─────────────────────────────────────────────────────────────
-- Stripe subscription state synced via webhook.

CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id"                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id"               text        NOT NULL,
  "stripe_customer_id"     text        NOT NULL,
  "stripe_subscription_id" text        NOT NULL,
  "plan"                   text        NOT NULL CHECK ("plan" IN ('free', 'pro', 'enterprise')),
  "status"                 text        NOT NULL CHECK ("status" IN ('active', 'past_due', 'canceled', 'trialing', 'incomplete')),
  "current_period_end"     bigint,
  "cancel_at_period_end"   boolean     NOT NULL DEFAULT false,
  "created_at"             timestamptz NOT NULL DEFAULT now(),
  "updated_at"             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_stripe_sub_id_udx"        ON "subscriptions" ("stripe_subscription_id");
CREATE        INDEX IF NOT EXISTS "subscriptions_owner_id_idx"             ON "subscriptions" ("owner_id");
CREATE        INDEX IF NOT EXISTS "subscriptions_stripe_customer_id_idx"   ON "subscriptions" ("stripe_customer_id");

-- ── stripe_webhook_events ─────────────────────────────────────────────────────
-- Idempotency log — prevents double-processing Stripe webhooks.

CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
  "stripe_event_id"  text        PRIMARY KEY,
  "event_type"       text        NOT NULL,
  "processed_at"     timestamptz NOT NULL DEFAULT now(),
  "error"            text
);

CREATE INDEX IF NOT EXISTS "stripe_webhook_events_event_type_idx"    ON "stripe_webhook_events" ("event_type");
CREATE INDEX IF NOT EXISTS "stripe_webhook_events_processed_at_idx"  ON "stripe_webhook_events" ("processed_at");
