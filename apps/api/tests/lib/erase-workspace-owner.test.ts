// SPDX-License-Identifier: Apache-2.0
/** A workspace owner can erase their account: shared workspaces pass to a member, solo ones go. */
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:erase-workspace-owner";
process.env.DATABASE_URL = DB;

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { db, eraseUserData } = await import("@nexus/db");

const pool = () => getPgPool(DB)!;
const one = async <T>(text: string, params: unknown[] = []) =>
  (await pool().query<T>(text, params)).rows[0]!;

beforeAll(async () => {
  await migrateEmbedded(pool());
}, 120_000);
afterAll(async () => {
  await closePgPools();
});

async function user(email: string) {
  return (
    await one<{ id: string }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
      [email],
    )
  ).id;
}

async function workspace(slug: string, ownerId: string) {
  const { id } = await one<{ id: string }>(
    "INSERT INTO workspaces (slug, name, owner_id) VALUES ($1, $1, $2) RETURNING id",
    [slug, ownerId],
  );
  await pool().query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
    [id, ownerId],
  );
  return id;
}

it("hands shared workspaces to the senior member, deletes solo ones, keeps their invites", async () => {
  const owner = await user("owner@example.com");
  const member = await user("member@example.com");
  const admin = await user("admin@example.com");
  const shared = await workspace("shared", owner);
  const solo = await workspace("solo", owner);
  await pool().query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'admin')",
    [shared, member, admin],
  );
  await pool().query(
    `INSERT INTO workspace_invitations (workspace_id, email, token_hash, invited_by_user_id, expires_at)
     VALUES ($1, 'new@example.com', 'h1', $2, now() + interval '1 day')`,
    [shared, owner],
  );

  await eraseUserData(db as never, owner);

  expect(await one("SELECT count(*)::int AS n FROM users WHERE id = $1", [owner])).toEqual({
    n: 0,
  });
  expect(await one("SELECT owner_id FROM workspaces WHERE id = $1", [shared])).toEqual({
    owner_id: admin,
  });
  expect(
    await one("SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [
      shared,
      admin,
    ]),
  ).toEqual({ role: "owner" });
  expect(
    await one("SELECT invited_by_user_id FROM workspace_invitations WHERE workspace_id = $1", [
      shared,
    ]),
  ).toEqual({ invited_by_user_id: admin });
  expect(await one("SELECT count(*)::int AS n FROM workspaces WHERE id = $1", [solo])).toEqual({
    n: 0,
  });
});
