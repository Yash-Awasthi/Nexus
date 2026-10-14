// SPDX-License-Identifier: Apache-2.0
/** NX-FEAT-012: an admin sees and ends one user's sessions; a user sees which session is theirs. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const DB = "pglite://:memory:admin-sessions";
process.env.NEXUS_JWT_SECRET = "admin-sessions-secret";
process.env.NEXUS_API_KEY = "admin-sessions-master-key";
process.env.DATABASE_URL = DB;
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-admin-sessions-"));

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { authUsersRoutes } = await import("../../src/routes/auth-users.ts");
const { adminUsersRoutes } = await import("../../src/routes/admin-users.ts");

let app: FastifyInstance;
const PASSWORD = "Admin-sessions-1!";

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = Fastify();
  await app.register(authUsersRoutes, { prefix: "/api/v1" });
  await app.register(adminUsersRoutes, { prefix: "/api/v1" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePgPools();
});

let nextAddress = 1;

async function account(email: string, role?: string): Promise<string> {
  const reg = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    remoteAddress: `198.51.100.${nextAddress++}`,
    payload: { email, password: PASSWORD },
  });
  expect(reg.statusCode, reg.body).toBe(201);
  if (role)
    await getPgPool(DB)!.query("UPDATE users SET role = $1 WHERE email = $2", [role, email]);
  return reg.json<{ user: { id: string } }>().user.id;
}

async function signIn(email: string, agent: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { "user-agent": agent },
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ accessToken: string }>().accessToken;
}

const call = (method: "GET" | "DELETE", url: string, token: string) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });

type Session = { id: string; userAgent: string | null; current?: boolean };

it("lets an admin list a user's live sessions and end one of them", async () => {
  await account("boss@example.com", "admin");
  const admin = await signIn("boss@example.com", "admin-browser");
  const userId = await account("worker@example.com");
  const laptop = await signIn("worker@example.com", "laptop");
  const phone = await signIn("worker@example.com", "phone");
  await signIn("worker@example.com", "old-tablet");
  await getPgPool(DB)!.query(
    "UPDATE refresh_tokens SET expires_at = now() - interval '1 day' WHERE user_agent = 'old-tablet'",
  );

  const list = await call("GET", `/api/v1/admin/users/${userId}/sessions`, admin);
  expect(list.statusCode, list.body).toBe(200);
  const sessions = list.json<{ sessions: Session[] }>().sessions;
  const agents = sessions.map((s) => s.userAgent);
  expect(agents).toEqual(expect.arrayContaining(["laptop", "phone"]));
  expect(agents).not.toContain("old-tablet");

  const laptopId = sessions.find((s) => s.userAgent === "laptop")!.id;
  const del = await call("DELETE", `/api/v1/admin/users/${userId}/sessions/${laptopId}`, admin);
  expect(del.statusCode, del.body).toBe(204);

  expect((await call("GET", "/api/v1/auth/me", laptop)).statusCode).toBe(401);
  expect((await call("GET", "/api/v1/auth/me", phone)).statusCode).toBe(200);
});

it("answers 404 when the session belongs to someone other than the user in the path", async () => {
  await account("boss2@example.com", "admin");
  const admin = await signIn("boss2@example.com", "admin-browser");
  const aliceId = await account("alice@example.com");
  await account("bob@example.com");
  const bob = await signIn("bob@example.com", "bob-laptop");
  const bobId = (await call("GET", "/api/v1/auth/me", bob)).json<{ id: string }>().id;
  const bobSession = (await call("GET", `/api/v1/admin/users/${bobId}/sessions`, admin)).json<{
    sessions: Session[];
  }>().sessions[0]!;

  const del = await call(
    "DELETE",
    `/api/v1/admin/users/${aliceId}/sessions/${bobSession.id}`,
    admin,
  );
  expect(del.statusCode).toBe(404);
  expect((await call("GET", "/api/v1/auth/me", bob)).statusCode).toBe(200);
});

it("refuses the session routes to someone who is not an admin", async () => {
  const targetId = await account("target@example.com");
  await account("member@example.com");
  const member = await signIn("member@example.com", "member-browser");
  expect((await call("GET", `/api/v1/admin/users/${targetId}/sessions`, member)).statusCode).toBe(
    403,
  );
  expect(
    (await call("DELETE", `/api/v1/admin/users/${targetId}/sessions/any`, member)).statusCode,
  ).toBe(403);
});

it("marks the caller's own session in their session list", async () => {
  await account("self@example.com");
  await signIn("self@example.com", "desktop");
  const phone = await signIn("self@example.com", "phone");
  const sessions = (await call("GET", "/api/v1/auth/sessions", phone)).json<{
    sessions: Session[];
  }>().sessions;
  expect(sessions.filter((s) => s.current).map((s) => s.userAgent)).toEqual(["phone"]);
});
