-- SPDX-License-Identifier: Apache-2.0
-- Migration 0010: mcp_servers
--
-- Per-user registry of external MCP servers (replaces the in-memory/hardcoded
-- list). An optional API key is stored AES-256-GCM encrypted in encrypted_api_key
-- (base64([iv|tag|ciphertext])); the raw key is never persisted in plaintext and
-- never returned over HTTP. Mirrors packages/db/src/schema/mcp-servers.ts.

CREATE TABLE IF NOT EXISTS "mcp_servers" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"              uuid NOT NULL,
  "name"                 text NOT NULL,
  "description"          text,
  "transport_type"       text NOT NULL DEFAULT 'http',
  "endpoint"             text NOT NULL,
  "encrypted_api_key"    text,
  "key_prefix"           text,
  "config"               jsonb,
  "tools"                jsonb,
  "status"               text NOT NULL DEFAULT 'inactive',
  "enabled"              boolean NOT NULL DEFAULT true,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now(),
  "last_health_check_at" timestamptz,
  "deleted_at"           timestamptz
);

-- One live server per (user, name); soft-deleted rows are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_servers_user_name_udx"
  ON "mcp_servers" ("user_id", "name")
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "mcp_servers_user_id_idx"
  ON "mcp_servers" ("user_id");
