// SPDX-License-Identifier: Apache-2.0
/**
 * Vitest global setup — runs before every test file's module graph is evaluated.
 *
 * §16.8 — hermetic `buildServer()`:
 *
 * 1. DATABASE_URL must be present before @nexus/db is imported (it calls
 *    createClient() at module scope and throws immediately if the var is
 *    missing). A non-reachable fake URL is enough — queries fail at runtime,
 *    but tests that don't exercise DB paths work without a real Postgres.
 *
 * 2. `pg` is stubbed with a no-op Pool. obs-providers.ts constructs a
 *    Pg-backed store at MODULE SCOPE whenever DATABASE_URL is set (which this
 *    setup guarantees), firing an eager CREATE TABLE at import — against a
 *    fake URL that means a real connection attempt per test file (slow, and
 *    an unhandled-rejection source). The stub keeps every route-test file
 *    hermetic by default; a file that needs real pg behavior can re-mock or
 *    `vi.unmock("pg")` (hoisting means per-file mocks still win).
 */
import { vi } from "vitest";

// Prevent @nexus/db from throwing "DATABASE_URL is required" at import time.
// Tests that hit DB-backed routes will receive 500/502; tests targeting
// in-memory routes are unaffected.
if (!process.env.DATABASE_URL) {
  // Neon-shaped URL so NeonConnector/isNeonUrl checks pass at parse time.
  // No real connection is made during unit tests — queries fail at runtime
  // with ECONNREFUSED, not at import/construction time.
  process.env.DATABASE_URL =
    "postgresql://nexus_test:nexus_test@ep-test-abc123.us-east-2.aws.neon.tech/nexus_test?sslmode=require";
}

vi.mock("pg", () => {
  // Plain functions, NOT vi.fn(): suites call vi.restoreAllMocks() in
  // afterEach, which strips vi.fn() implementations — and the PersistentStore
  // pool is module-scope, so a restored query() would return undefined and
  // blow up `.catch(...)` in every test after the first restore.
  const noopQuery = (): Promise<{ rows: never[]; rowCount: number }> =>
    Promise.resolve({ rows: [], rowCount: 0 });
  class FakePool {
    query = noopQuery;
    on = (): FakePool => this;
    end = (): Promise<void> => Promise.resolve();
    connect = (): Promise<{ query: typeof noopQuery; release: () => void }> =>
      Promise.resolve({ query: noopQuery, release: () => {} });
  }
  return { Pool: FakePool };
});
