-- SPDX-License-Identifier: Apache-2.0
-- Phase 2: Postgres LISTEN/NOTIFY for real-time council enqueuing.
--
-- Creates a trigger function that fires NOTIFY on every INSERT to signals.
-- The SignalNotifyListener in @nexus/worker subscribes with pg LISTEN and
-- immediately enqueues council.deliberate jobs for qualifying signals,
-- replacing the 5-second polling loop for the hot path.
--
-- Run via: make migrate  (drizzle-kit migrate against DATABASE_URL)
-- Or push to Neon: make migrate-neon

CREATE OR REPLACE FUNCTION nexus_notify_signal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('nexus_signals', row_to_json(NEW)::text);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS signals_after_insert ON signals;
CREATE TRIGGER signals_after_insert
  AFTER INSERT ON signals
  FOR EACH ROW
  EXECUTE FUNCTION nexus_notify_signal();
