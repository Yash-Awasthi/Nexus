-- Agent key/value state store
CREATE TABLE IF NOT EXISTS agent_state (
  agent_id   TEXT        NOT NULL,
  key        TEXT        NOT NULL,
  value      JSONB       NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, key)
);

CREATE INDEX IF NOT EXISTS idx_agent_state_agent_id ON agent_state (agent_id);
