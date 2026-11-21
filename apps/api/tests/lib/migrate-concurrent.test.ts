// SPDX-License-Identifier: Apache-2.0
/**
 * Two API instances boot together, so two migrate steps race. This runs the
 * real migration files against a real Postgres and asserts the advisory lock
 * serializes them: every migration lands once, and neither run fails on DDL the
 * other just applied.
 *
 * Gated on NEXUS_TEST_POSTGRES_URL so the default hermetic suite (which stubs
 * pg) still runs everywhere; the CI job points it at a pgvector service.
 */
import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vite-plus/test";

import { migrateEmbedded } from "../../src/lib/migrate-embedded.ts";
import { withMigrationLock } from "../../src/lib/migration-lock.ts";

vi.unmock("pg");

const PG_URL = process.env.NEXUS_TEST_POSTGRES_URL ?? "";

async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: PG_URL });
  await client.connect();
  return client;
}

describe.runIf(PG_URL.length > 0)("concurrent migrations on Postgres", () => {
  const clients: pg.Client[] = [];

  afterAll(async () => {
    await Promise.allSettled(clients.map((client) => client.end()));
  });

  it("serializes two instances and records every migration once", async () => {
    // A clean database, so the ledger starts empty and both instances really race.
    const admin = await connect();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS public CASCADE`);
      await admin.query(`CREATE SCHEMA public`);
      await admin.query(`CREATE EXTENSION IF NOT EXISTS vector`).catch(() => {
        // A server without pgvector skips that migration; the lock claim still holds.
      });
    } finally {
      await admin.end();
    }

    const [first, second] = await Promise.all([connect(), connect()]);
    clients.push(first, second);

    const run = (client: pg.Client) =>
      withMigrationLock(PG_URL, async () => migrateEmbedded(client), {
        retryMs: 25,
        timeoutMs: 120_000,
      });

    const results = await Promise.all([run(first), run(second)]);

    const applied = results.flatMap((result) => result.applied);
    expect(applied.length).toBeGreaterThan(0);
    // The second instance waited, saw the ledger, and applied nothing.
    expect(new Set(applied).size).toBe(applied.length);
    expect(results.filter((result) => result.applied.length > 0)).toHaveLength(1);

    const ledger = await first.query<{ name: string; n: number }>(
      `SELECT name, count(*)::int AS n
         FROM nexus_drizzle_migrations
        GROUP BY name
       HAVING count(*) > 1`,
    );
    expect(ledger.rows).toEqual([]);

    const users = await first.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'users'`,
    );
    expect(users.rows[0]!.n).toBe(1);
  }, 180_000);
});
