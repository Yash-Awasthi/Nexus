-- SPDX-License-Identifier: Apache-2.0
-- Migration 0014: provider_models — model catalog seeded from models.dev (§1.5)
-- Run after 0013_orchestration_runs.sql
--
-- One row per model definition from the models.dev catalogue (or a curated
-- fixture). Rows are written by `nexus models seed [--file <path>]` — never by
-- a startup network pull — and read into the in-memory ProviderRegistry at API
-- boot. Shape mirrors the ModelDefinition type in @nexus/provider-registry:
-- prices are USD per 1M tokens (null = free), ids are namespaced provider/model.

CREATE TABLE IF NOT EXISTS "provider_models" (
  "id"                     text        PRIMARY KEY,
  "provider"               text        NOT NULL,
  "name"                   text        NOT NULL,
  "context_window"         integer     NOT NULL DEFAULT 8192,
  "max_output_tokens"      integer     NOT NULL DEFAULT 4096,
  "cost_per_input_token"   double precision,
  "cost_per_output_token"  double precision,
  "cost_per_cache_read_token"  double precision,
  "cost_per_cache_write_token" double precision,
  "input_modalities"       jsonb,
  "output_modalities"      jsonb,
  "knowledge_cutoff"       text,
  "release_date"           text,
  "deprecated"             boolean     NOT NULL DEFAULT false,
  "capabilities"           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "source"                 text        NOT NULL DEFAULT 'models.dev',
  "created_at"             timestamptz NOT NULL DEFAULT now(),
  "updated_at"             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "provider_models_provider_idx"
  ON "provider_models" ("provider");
