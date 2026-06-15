// SPDX-License-Identifier: Apache-2.0
/**
 * Vitest global setup — runs before every test file's module graph is evaluated.
 *
 * DATABASE_URL must be present before @nexus/db is imported (it calls createClient()
 * at module scope and throws immediately if the var is missing).
 * A non-reachable fake URL is enough — queries will fail at runtime, but
 * tests that don't exercise DB paths work without a real Postgres instance.
 */

// Prevent @nexus/db from throwing "DATABASE_URL is required" at import time.
// Tests that hit DB-backed routes will receive 500/502; tests targeting
// in-memory routes are unaffected.
if (!process.env.DATABASE_URL) {
  // Neon-shaped URL so NeonConnector/isNeonUrl checks pass at parse time.
  // No real connection is made during unit tests — queries fail at runtime
  // with ECONNREFUSED, not at import/construction time.
  process.env.DATABASE_URL = "postgresql://nexus_test:nexus_test@ep-test-abc123.us-east-2.aws.neon.tech/nexus_test?sslmode=require";
}
