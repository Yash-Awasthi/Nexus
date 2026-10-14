-- SPDX-License-Identifier: Apache-2.0
-- Migration 0020: personal-access token last-used IP
--
-- The address that last used a token, shown beside its last-used time so an owner can spot a
-- token used from somewhere unexpected. BYOK rows leave it NULL.

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "last_used_ip" text;
