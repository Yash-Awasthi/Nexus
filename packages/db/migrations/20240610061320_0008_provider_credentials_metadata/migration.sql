-- SPDX-License-Identifier: Apache-2.0
-- Migration 0008: provider connection metadata + nullable key
-- Run after 0007_user_provider_credentials.sql
--
-- The Language Models page manages full provider connections (base URL, enabled
-- models), not just bare keys. Add those columns and allow a null encrypted_key
-- so local/self-hosted connections (e.g. ollama, custom base URLs) can be stored
-- without a secret.

ALTER TABLE "user_provider_credentials"
  ALTER COLUMN "encrypted_key" DROP NOT NULL;

ALTER TABLE "user_provider_credentials"
  ADD COLUMN IF NOT EXISTS "base_url" text;

ALTER TABLE "user_provider_credentials"
  ADD COLUMN IF NOT EXISTS "models" jsonb;
