-- SPDX-License-Identifier: Apache-2.0
-- 0002_auto_schema_tables — captures four tables that packages self-create at
-- runtime via CREATE TABLE IF NOT EXISTS.  Running this migration at deploy time
-- ensures the schema exists before the first request and makes pgvector extension
-- requirements explicit so infrastructure-as-code tools can track them.
--
-- Safe to run multiple times (all statements are idempotent).
-- Depends on: pgvector extension (for memory_entries.embedding column).

-- ─── memory_entries ──────────────────────────────────────────────────────────
-- Managed by: @nexus/memory PgVectorStore.init()

CREATE TABLE IF NOT EXISTS memory_entries (
  id          TEXT        PRIMARY KEY,
  text        TEXT        NOT NULL,
  embedding   vector(768) NOT NULL,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  created_at  INTEGER     NOT NULL,
  expires_at  INTEGER,
  user_id     TEXT                   -- multi-tenant ACL
);

ALTER TABLE memory_entries
  ADD COLUMN IF NOT EXISTS user_id TEXT;

CREATE INDEX IF NOT EXISTS memory_entries_created_at_idx
  ON memory_entries (created_at);

CREATE INDEX IF NOT EXISTS memory_entries_user_id_idx
  ON memory_entries (user_id)
  WHERE user_id IS NOT NULL;

-- IVFFlat ANN index (built once store reaches ~10k rows for meaningful speedup)
-- Requires: CREATE EXTENSION IF NOT EXISTS vector;
-- CREATE INDEX IF NOT EXISTS memory_entries_embedding_idx
--   ON memory_entries USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ─── sync_patches ─────────────────────────────────────────────────────────────
-- Managed by: @nexus/session-sync DrizzleSyncStore.ensureSchema()

CREATE TABLE IF NOT EXISTS sync_patches (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  device_id   TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  clock       JSONB NOT NULL,
  patch       JSONB NOT NULL,
  applied_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_patches_session_id_idx
  ON sync_patches (session_id, applied_at DESC);

-- ─── brief_digests ────────────────────────────────────────────────────────────
-- Managed by: @nexus/brief-engine PgBriefStore.ensureSchema()

CREATE TABLE IF NOT EXISTS brief_digests (
  domain     TEXT NOT NULL,
  digest     TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (domain, digest)
);

CREATE INDEX IF NOT EXISTS brief_digests_domain_idx
  ON brief_digests (domain);

-- ─── wiki_articles ────────────────────────────────────────────────────────────
-- Managed by: @nexus/wiki-updater PgWikiStore.init()

CREATE TABLE IF NOT EXISTS wiki_articles (
  id          TEXT PRIMARY KEY,
  title       TEXT        NOT NULL,
  content     TEXT        NOT NULL,
  tags        TEXT[]      NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version     INTEGER     NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS wiki_articles_title_idx
  ON wiki_articles (title);

CREATE INDEX IF NOT EXISTS wiki_articles_updated_at_idx
  ON wiki_articles (updated_at DESC);
