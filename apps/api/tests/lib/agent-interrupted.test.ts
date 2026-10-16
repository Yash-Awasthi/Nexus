// SPDX-License-Identifier: Apache-2.0
/** A run the API was hosting dies with it, so a restart reports it failed instead of running forever. */
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:agent-interrupted";
process.env.DATABASE_URL = DB;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { failInterruptedRuns } = await import("../../src/lib/agent-queue.ts");

const pool = () => getPgPool(DB)!;

beforeAll(async () => {
  await migrateEmbedded(pool());
}, 120_000);
afterAll(async () => {
  await closePgPools();
});

it("marks in-process runs left running as failed, and leaves finished ones alone", async () => {
  await pool().query(
    "INSERT INTO agent_sessions (id, status) VALUES (gen_random_uuid(), 'running'), (gen_random_uuid(), 'completed')",
  );

  expect(await failInterruptedRuns(pool())).toBe(1);

  const { rows } = await pool().query<{ status: string; error: string | null }>(
    "SELECT status, error FROM agent_sessions ORDER BY status",
  );
  expect(rows.map((r) => r.status)).toEqual(["completed", "error"]);
  expect(rows[1]?.error).toMatch(/restart/);
});
