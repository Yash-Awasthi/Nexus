-- Migration 005: Long-term memory store for the memory agent
CREATE TABLE IF NOT EXISTS agent_memories (
  id         SERIAL PRIMARY KEY,
  content    TEXT NOT NULL,
  category   TEXT NOT NULL CHECK (category IN ('fact','preference','decision','event','relationship','technical','other')),
  tags       JSONB NOT NULL DEFAULT '[]'::jsonb,
  agent_id   TEXT NOT NULL DEFAULT 'system',
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_memories_category   ON agent_memories(category);
CREATE INDEX IF NOT EXISTS idx_agent_memories_agent_id   ON agent_memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_memories_created_at ON agent_memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_memories_tags       ON agent_memories USING GIN(tags);

-- Full text search index
CREATE INDEX IF NOT EXISTS idx_agent_memories_content_fts
  ON agent_memories USING GIN(to_tsvector('english', content));
