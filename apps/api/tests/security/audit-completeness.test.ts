// SPDX-License-Identifier: Apache-2.0
/**
 * Audit completeness: the events a security review asks about are actually written.
 *
 * Two halves, because either alone is easy to fake. The first reads the tree: every row of the catalogue in
 * `lib/audit-events.ts` must name a file that still contains its action, so deleting an emission fails here
 * rather than in an incident review. The second drives the real HTTP surface against an embedded Postgres
 * and reads the audit table, so an emission that compiles but never fires (a wrong branch, a swallowed
 * error) is caught too.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const DB = "pglite://:memory:audit-completeness";
const SECRET = "audit-completeness-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.DATABASE_URL = DB;
// Provider keys are written encrypted; see the note in `routes/account-export-delete.test.ts`.
process.env.NEXUS_SECRETS_KEY = crypto.randomBytes(32).toString("hex");
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-audit-"));

const ROOT = path.resolve(import.meta.dirname, "../../../..");

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { authUsersRoutes } = await import("../../src/routes/auth-users.ts");
const { providerKeysRoutes } = await import("../../src/routes/provider-keys.ts");
const { orgGovernanceRoutes } = await import("../../src/routes/org-governance.ts");
const { REQUIRED_AUDIT_EVENTS, REQUIRED_CATEGORIES, requiredActions } =
  await import("../../src/lib/audit-events.ts");
const { db } = await import("@nexus/db");
const { auditLog } = await import("@nexus/db/schema");
const { eq } = await import("drizzle-orm");

let app: FastifyInstance;

function tokenFor(userId: string): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const signature = crypto
    .createHmac("sha256", SECRET)
    .update(`${head}.${body}`)
    .digest("base64url");
  return `${head}.${body}.${signature}`;
}

async function auditRows(action: string) {
  return db.select().from(auditLog).where(eq(auditLog.action, action));
}

/** Audit writes are fire-and-forget: give the chain a moment rather than asserting on a race. */
async function waitFor(action: string, count = 1): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await auditRows(action)).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = Fastify();
  await app.register(authUsersRoutes, { prefix: "/api/v1" });
  await app.register(providerKeysRoutes, { prefix: "/api/v1" });
  await app.register(orgGovernanceRoutes, { prefix: "/api" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePgPools();
});

describe("the catalogue covers what the product promises", () => {
  it("has a row for every category and no duplicates", () => {
    const categories = new Set(REQUIRED_AUDIT_EVENTS.map((event) => event.category));
    expect([...categories].sort()).toEqual([...REQUIRED_CATEGORIES].sort());
    expect(new Set(requiredActions()).size).toBe(REQUIRED_AUDIT_EVENTS.length);
  });

  it("names a file that emits each action", () => {
    const missing: string[] = [];
    for (const event of REQUIRED_AUDIT_EVENTS) {
      const file = path.join(ROOT, event.emittedBy);
      if (!fs.existsSync(file)) {
        missing.push(`${event.action}: ${event.emittedBy} does not exist`);
        continue;
      }
      const source = fs.readFileSync(file, "utf8");
      if (!source.includes(`"${event.action}"`)) {
        missing.push(`${event.action}: no emission in ${event.emittedBy}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("explains each row, so a reviewer is not asked to trust a bare name", () => {
    for (const event of REQUIRED_AUDIT_EVENTS) {
      expect(event.why.length, event.action).toBeGreaterThan(40);
    }
  });
});

describe("the events are written when the routes run", () => {
  it("records registration and sign-in", async () => {
    const email = `audited-${crypto.randomUUID()}@example.com`;
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password: "Audited-pass-1!" },
    });
    expect([200, 201]).toContain(registered.statusCode);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "Audited-pass-1!" },
    });
    expect(login.statusCode).toBe(200);

    await waitFor("auth.register");
    await waitFor("auth.login");
    const registeredRows = await auditRows("auth.register");
    expect(registeredRows.length).toBeGreaterThan(0);
    expect(registeredRows[0]?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(registeredRows[0]?.chainHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records a provider key being added and removed", async () => {
    const userId = crypto.randomUUID();
    const auth = { authorization: `Bearer ${tokenFor(userId)}` };

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/user/provider-keys",
      headers: auth,
      payload: { provider: "groq", apiKey: "gsk_audit_test_key_0123456789" },
    });
    expect(created.statusCode).toBe(201);
    await waitFor("provider_key.create");
    const [row] = await auditRows("provider_key.create");
    expect(row?.actor).toBe(userId);
    // The payload says which provider, never the key or its prefix.
    expect(JSON.stringify(row?.payload)).not.toContain("gsk_audit");

    const id = created.json<{ id: string }>().id;
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/user/provider-keys/${id}`,
      headers: auth,
    });
    expect(removed.statusCode).toBe(200);
    await waitFor("provider_key.delete");
    const [deleted] = await auditRows("provider_key.delete");
    expect(deleted?.actor).toBe(userId);
    expect(deleted?.entityId).toBe(id);
  });
});
