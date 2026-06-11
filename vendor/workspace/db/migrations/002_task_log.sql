-- Durable task log for audit + replay
CREATE TABLE IF NOT EXISTS task_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    TEXT        NOT NULL,
  task_id     TEXT        NOT NULL UNIQUE,
  task_type   TEXT        NOT NULL,
  input       JSONB,
  output      JSONB,
  success     BOOLEAN,
  error       TEXT,
  duration_ms INTEGER,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_task_log_agent_id  ON task_log (agent_id);
CREATE INDEX IF NOT EXISTS idx_task_log_started   ON task_log (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_log_task_type ON task_log (task_type);
