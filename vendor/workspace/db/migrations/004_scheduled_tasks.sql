-- Migration 004: Scheduled tasks table for the scheduler agent
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id         SERIAL PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  cron       TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  task_input TEXT NOT NULL,
  timezone   TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  enabled    BOOLEAN NOT NULL DEFAULT true,
  last_run   TIMESTAMPTZ,
  next_run   TIMESTAMPTZ,
  run_count  INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(enabled);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_agent_id ON scheduled_tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks(next_run);
