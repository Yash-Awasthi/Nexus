-- SPDX-License-Identifier: Apache-2.0
-- Migration 0009: prompts, prompt_versions, build_tasks
--
-- These three tables are addressed by the api-bridge route layer through a raw
-- `pg.Pool` (apps/api/src/routes/api-bridge.ts `_getPool()`), NOT the drizzle
-- connection, and historically existed only in the production Neon database with
-- no migration. That meant a fresh/local database had no such tables and the
-- Prompts and Build pages returned empty or errored.
--
-- Column types here match exactly what the route code expects:
--   * prompts.id / prompt_versions.id are uuid (route passes request.params.id
--     straight into the query — no integer parse).
--   * build_tasks.id is an integer serial (route does parseInt on it) with a
--     self-referential parent_id for the DAG (Build page).
-- All statements are idempotent (IF NOT EXISTS) so this is safe to re-run.

-- ─── prompts ─────────────────────────────────────────────────────────────────
-- Managed by: apps/api/src/routes/api-bridge.ts  (GET/POST /api/prompts, etc.)

CREATE TABLE IF NOT EXISTS "prompts" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"        text NOT NULL,
  "description" text,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);

-- ─── prompt_versions ─────────────────────────────────────────────────────────
-- One row per saved version; version_num auto-increments per prompt. Deleting a
-- prompt cascades to its versions (the DELETE /prompts/:id route relies on this).

CREATE TABLE IF NOT EXISTS "prompt_versions" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "prompt_id"   uuid NOT NULL REFERENCES "prompts" ("id") ON DELETE CASCADE,
  "version_num" integer NOT NULL,
  "content"     text NOT NULL,
  "model"       text,
  "temperature" numeric,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "prompt_versions_prompt_id_idx"
  ON "prompt_versions" ("prompt_id");

CREATE UNIQUE INDEX IF NOT EXISTS "prompt_versions_prompt_id_version_num_idx"
  ON "prompt_versions" ("prompt_id", "version_num");

-- ─── build_tasks ─────────────────────────────────────────────────────────────
-- Kanban + DAG backing store. parent_id is self-referential; ON DELETE SET NULL
-- so removing a parent task leaves its subtasks as roots rather than failing.

CREATE TABLE IF NOT EXISTS "build_tasks" (
  "id"           serial PRIMARY KEY,
  "user_id"      text,
  "parent_id"    integer REFERENCES "build_tasks" ("id") ON DELETE SET NULL,
  "title"        text NOT NULL,
  "description"  text,
  "status"       text NOT NULL DEFAULT 'planned',
  "claimed_by"   text,
  "claimed_at"   timestamptz,
  "output"       text,
  "submitted_at" timestamptz,
  "is_locked"    boolean NOT NULL DEFAULT false,
  "meta"         jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "build_tasks_parent_id_idx"
  ON "build_tasks" ("parent_id");

CREATE INDEX IF NOT EXISTS "build_tasks_status_idx"
  ON "build_tasks" ("status");
