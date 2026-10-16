// SPDX-License-Identifier: Apache-2.0
/** Every table that names an account is erased with it, or deliberately kept. */
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:erasure-coverage";
process.env.DATABASE_URL = DB;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { ERASURE_COVERAGE } = await import("@nexus/db");

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
}, 120_000);
afterAll(async () => {
  await closePgPools();
});

it("covers each owner column in the migrated schema", async () => {
  const { rows } = await getPgPool(DB)!.query<{ t: string; c: string }>(
    `SELECT table_name AS t, column_name AS c FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name <> 'users'
       AND column_name IN ('user_id', 'owner_id', 'owner', 'invited_by_user_id')`,
  );
  const missing = rows.map((r) => `${r.t}.${r.c}`).filter((col) => !ERASURE_COVERAGE.has(col));
  expect(missing).toEqual([]);
});
