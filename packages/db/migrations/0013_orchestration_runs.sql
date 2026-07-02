-- SPDX-License-Identifier: Apache-2.0
-- Migration 0013: orchestration_runs — persisted multi-agent orchestration state
-- Run after 0012_oauth_credentials.sql

-- ── orchestration_runs ──────────────────────────────────────────────────────────
-- One row per `orchestration.run` job (@nexus/agent-orchestrator fan-out). The
-- worker handler upserts on each stage transition (running → completed | failed)
-- so a run survives a worker restart: on boot, non-terminal rows are re-enqueued
-- from their stored `payload`. `id` is the free-form runId string (not a UUID) —
-- it also names the run's git worktrees/branches. `candidates`/`scores`/`winner`
-- capture the fan-out result for the compare/merge UI.

CREATE TABLE IF NOT EXISTS "orchestration_runs" (
  "id"         text        PRIMARY KEY,
  "user_id"    uuid,
  "status"     text        NOT NULL DEFAULT 'pending',
  "task"       text        NOT NULL,
  "payload"    jsonb,
  "candidates" jsonb       NOT NULL DEFAULT '[]'::jsonb,
  "scores"     jsonb,
  "winner"     text,
  "error"      text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "orchestration_runs_status_idx"
  ON "orchestration_runs" ("status");

CREATE INDEX IF NOT EXISTS "orchestration_runs_user_id_idx"
  ON "orchestration_runs" ("user_id");
