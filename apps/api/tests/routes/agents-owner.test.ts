// SPDX-License-Identifier: Apache-2.0
/** The librarian recalls only the caller's memories; the file agent stays inside its root. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SECRET = "agents-owner-secret";
const DB = "pglite://:memory:agents-owner";
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-agent-root-"));
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.DATABASE_URL = DB;
process.env.NEXUS_EMBED_PROVIDER = "fixed";
process.env.AGENT_FS_ROOT = path.join(ROOT, "workspace");
fs.mkdirSync(process.env.AGENT_FS_ROOT);
fs.writeFileSync(path.join(ROOT, "secret.txt"), "outside the root");
fs.writeFileSync(path.join(ROOT, "workspace", "notes.txt"), "inside the root");

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.js");
const { buildServer } = await import("../../src/server.js");
const { db } = await import("@nexus/db");
const { users } = await import("@nexus/db/schema");

const ALICE = crypto.randomUUID();
const BOB = crypto.randomUUID();
const ADMIN = crypto.randomUUID();

function auth(userId: string): { authorization: string } {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "agent", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return { authorization: `Bearer ${head}.${body}.${sig}` };
}

let app: FastifyInstance;
beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  await db.insert(users).values([
    { id: ALICE, email: "alice@example.com", passwordHash: "x", role: "member" },
    { id: BOB, email: "bob@example.com", passwordHash: "x", role: "member" },
    { id: ADMIN, email: "admin@example.com", passwordHash: "x", role: "admin" },
  ]);
  app = await buildServer();
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app.close();
  await closePgPools();
});

describe("librarian", () => {
  it("never recalls another account's memories, whatever filter is sent", async () => {
    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/memory",
      headers: auth(ALICE),
      payload: { text: "Alice keeps the vault code in the blue notebook." },
    });
    expect(saved.statusCode, saved.body).toBeLessThan(300);

    const recall = (who: string, filter?: object) =>
      app
        .inject({
          method: "POST",
          url: "/api/v1/agents/librarian/query",
          headers: auth(who),
          payload: { query: "vault code notebook", ...(filter ? { filter } : {}) },
        })
        .then((r) => r.json<{ memories: { entry: { text: string } }[] }>().memories);

    expect((await recall(ALICE)).map((m) => m.entry.text)).toContain(
      "Alice keeps the vault code in the blue notebook.",
    );
    expect(await recall(BOB)).toEqual([]);
    expect(await recall(BOB, { userId: ALICE })).toEqual([]);
  });
});

describe("file agent", () => {
  it("is refused to a non-admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/file/read",
      headers: auth(ALICE),
      payload: { path: "notes.txt" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("reads inside its root and nothing outside it", async () => {
    const read = (p: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/agents/file/read",
        headers: auth(ADMIN),
        payload: { path: p },
      });
    expect((await read("notes.txt")).json<{ content: string }>().content).toBe("inside the root");
    for (const p of ["../secret.txt", path.join(ROOT, "secret.txt")]) {
      const res = await read(p);
      expect(res.statusCode, p).toBe(400);
      expect(res.body).not.toContain("outside the root");
    }
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/agents/file/list?dir=..",
      headers: auth(ADMIN),
    });
    expect(list.statusCode).toBe(400);
  });
});
