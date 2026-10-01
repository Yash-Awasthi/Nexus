// SPDX-License-Identifier: Apache-2.0
/** The server operator makes an account an admin from inside the deployment. */
import { expect, it } from "vitest";

const DB = "pglite://:memory:grant-admin";
process.env.DATABASE_URL = DB;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { getPgPool } = await import("../../src/lib/pg-pool.js");
const { grantAdmin } = await import("../../src/lib/grant-admin.js");

it("promotes an existing account by email, and says when there is none", async () => {
  const pool = getPgPool(DB)!;
  await migrateEmbedded(pool);
  await pool.query(
    "INSERT INTO users (email, password_hash, role, tier) VALUES ('ops@example.com', 'x', 'member', 'free')",
  );
  expect(await grantAdmin(pool, " OPS@example.com ")).toBe(true);
  const { rows } = await pool.query<{ role: string }>(
    "SELECT role FROM users WHERE email = 'ops@example.com'",
  );
  expect(rows[0]!.role).toBe("admin");
  expect(await grantAdmin(pool, "nobody@example.com")).toBe(false);
});
