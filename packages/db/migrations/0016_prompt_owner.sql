-- SPDX-License-Identifier: Apache-2.0
-- Migration 0016: prompt ownership
--
-- Prompts had no owner, so every account listed and edited every other
-- account's prompts. Rows written before this migration keep a NULL owner and
-- stay visible to all; new rows belong to their creator.

ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "user_id" text;

CREATE INDEX IF NOT EXISTS "prompts_user_id_idx" ON "prompts" ("user_id");
