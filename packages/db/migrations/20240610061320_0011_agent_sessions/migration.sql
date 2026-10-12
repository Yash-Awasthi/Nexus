-- SPDX-License-Identifier: Apache-2.0
-- Migration 0011: agent_sessions
--
-- Persisted state of a coding-agent (ToolAgentRuntime) run so a session can be
-- resumed: a new agent.run with the same id reloads `messages` and continues.
-- Mirrors packages/db/src/schema/agent-sessions.ts. No secrets are stored here.

CREATE TABLE IF NOT EXISTS "agent_sessions" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid,
  "task_id"     uuid,
  "status"      text NOT NULL DEFAULT 'active',
  "instruction" text,
  "messages"    jsonb NOT NULL DEFAULT '[]'::jsonb,
  "usage"       jsonb,
  "error"       text,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "agent_sessions_user_id_idx" ON "agent_sessions" ("user_id");
CREATE INDEX IF NOT EXISTS "agent_sessions_task_id_idx" ON "agent_sessions" ("task_id");
CREATE INDEX IF NOT EXISTS "agent_sessions_status_idx" ON "agent_sessions" ("status");
