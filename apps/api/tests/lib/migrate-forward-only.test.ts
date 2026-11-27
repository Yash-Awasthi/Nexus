// SPDX-License-Identifier: Apache-2.0
/**
 * A migration must survive the data the previous release already wrote.
 *
 * The check runs a real Postgres (embedded PGlite) and applies the shipped migrations
 * in two steps, the way a deploy does: first everything up to the newest migration —
 * that is the schema the running release knows — then the newest migration on top of
 * rows in the shape the *older* code wrote.
 *
 * The memory-owner backfill (0022) is the split point: it moves the owner between `user_id` and
 * `metadata.userId`, which is exactly the kind of migration that looks fine on an empty database and
 * damages one with history, so the rows below are the two halves each side wrote before it existed.
 * Every migration after it is applied in the same deploy, so a later migration is also proven to survive
 * rows the older code wrote — the file stops being a test of one migration and becomes a test of the
 * newest release.
 */
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { migrateEmbedded } from "../../src/lib/migrate-embedded.ts";
import { closePgPools, getPgPool } from "../../src/lib/pg-pool.ts";

const MIGRATIONS = fileURLToPath(new URL("../../../../packages/db/migrations", import.meta.url));
const PREVIOUS = "pglite://:memory:forward-only";

afterAll(async () => {
  await closePgPools();
});

type Pool = NonNullable<ReturnType<typeof getPgPool>>;

/** Tables and columns as they are right now, for an additive-only comparison. */
async function shape(pool: Pool): Promise<Record<string, string[]>> {
  const res = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' ORDER BY table_name, column_name`,
  );
  const out: Record<string, string[]> = {};
  for (const row of res.rows) (out[row.table_name] ??= []).push(row.column_name);
  return out;
}

describe("a migration applies over the previous release's data", () => {
  it("backfills both owner spellings without losing a column", async () => {
    const all = readdirSync(MIGRATIONS)
      .filter((name) => name.includes("_00"))
      .sort();
    const backfill = all.findIndex((name) => /_0022_/.test(name));
    expect(
      backfill,
      "the memory-owner backfill migration is the split point of this test",
    ).toBeGreaterThan(0);
    const previousRelease = all.slice(0, backfill);
    const deploy = all.slice(backfill);

    // The previous release: every migration the running code already knows.
    const dir = mkdtempSync(path.join(tmpdir(), "nexus-forward-only-"));
    for (const name of previousRelease)
      cpSync(path.join(MIGRATIONS, name), path.join(dir, name), { recursive: true });

    const previous = process.env.NEXUS_MIGRATIONS_DIR;
    try {
      process.env.NEXUS_MIGRATIONS_DIR = dir;
      const pool = getPgPool(PREVIOUS)!;
      const first = await migrateEmbedded(pool);
      for (const name of deploy) expect(first.applied).not.toContain(name);

      // Rows written by the older code: one side stored the owner in metadata only, the
      // other in user_id only. Neither copy is visible to the other page.
      const embedding = `[${Array.from({ length: 768 }, () => 0.01).join(",")}]`;
      await pool.query(
        `INSERT INTO memory_entries (id, text, embedding, metadata, created_at, user_id)
         VALUES ($1, $2, $3::vector, $4::jsonb, $5, NULL)`,
        ["legacy-metadata", "written by the memory page", embedding, '{"userId":"u-1"}', 1],
      );
      await pool.query(
        `INSERT INTO memory_entries (id, text, embedding, metadata, created_at, user_id)
         VALUES ($1, $2, $3::vector, $4::jsonb, $5, $6)`,
        ["legacy-user-id", "written by /api/v1/memory", embedding, "{}", 2, "u-2"],
      );
      const before = await shape(pool);

      // The deploy: the backfill and everything after it run against that data.
      delete process.env.NEXUS_MIGRATIONS_DIR;
      const second = await migrateEmbedded(pool);
      expect(second.applied).toEqual(deploy);

      const rows = await pool.query<{
        id: string;
        user_id: string | null;
        metadata: { userId?: string };
      }>(`SELECT id, user_id, metadata FROM memory_entries ORDER BY created_at`);
      expect(rows.rows).toEqual([
        { id: "legacy-metadata", user_id: "u-1", metadata: { userId: "u-1" } },
        { id: "legacy-user-id", user_id: "u-2", metadata: { userId: "u-2" } },
      ]);

      // Forward-only means additive: every table and column that existed still exists.
      const after = await shape(pool);
      for (const [table, columns] of Object.entries(before)) {
        expect(after[table], `table ${table} was removed by ${deploy.join(", ")}`).toBeDefined();
        for (const column of columns)
          expect(after[table], `${table}.${column} was removed by ${deploy.join(", ")}`).toContain(
            column,
          );
      }
    } finally {
      if (previous === undefined) delete process.env.NEXUS_MIGRATIONS_DIR;
      else process.env.NEXUS_MIGRATIONS_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
