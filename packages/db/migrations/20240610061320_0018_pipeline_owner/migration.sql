-- SPDX-License-Identifier: Apache-2.0
-- Migration 0018: pipeline row ownership
--
-- Runtime tasks, ingested events, signals and council verdicts had no owner, so on a
-- shared server any account could list and read every other account's rows. Rows written
-- before this migration keep a NULL owner and are visible only to the desktop user.

ALTER TABLE "runtime_tasks" ADD COLUMN IF NOT EXISTS "owner_id" text;
ALTER TABLE "ingested_events" ADD COLUMN IF NOT EXISTS "owner_id" text;
ALTER TABLE "signals" ADD COLUMN IF NOT EXISTS "owner_id" text;
ALTER TABLE "verdicts" ADD COLUMN IF NOT EXISTS "owner_id" text;

CREATE INDEX IF NOT EXISTS "runtime_tasks_owner_idx" ON "runtime_tasks" ("owner_id");
CREATE INDEX IF NOT EXISTS "ingested_events_owner_idx" ON "ingested_events" ("owner_id");
CREATE INDEX IF NOT EXISTS "signals_owner_idx" ON "signals" ("owner_id");
CREATE INDEX IF NOT EXISTS "verdicts_owner_idx" ON "verdicts" ("owner_id");
