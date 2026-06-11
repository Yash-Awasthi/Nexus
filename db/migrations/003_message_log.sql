-- Optional: persist bus messages for replay / debugging
CREATE TABLE IF NOT EXISTS message_log (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id     TEXT        NOT NULL UNIQUE,
  topic          TEXT        NOT NULL,
  from_agent     TEXT        NOT NULL,
  to_agent       TEXT,
  payload        JSONB,
  priority       SMALLINT    NOT NULL DEFAULT 1,
  correlation_id TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_log_topic      ON message_log (topic);
CREATE INDEX IF NOT EXISTS idx_message_log_from_agent ON message_log (from_agent);
CREATE INDEX IF NOT EXISTS idx_message_log_created    ON message_log (created_at DESC);
