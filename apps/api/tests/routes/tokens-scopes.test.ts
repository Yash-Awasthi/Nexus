// SPDX-License-Identifier: Apache-2.0
/**
 * PAT scope enforcement tests (playtest round 7) — through the REAL auth
 * middleware, not the function directly.
 *
 * setup.ts leaves auth in dev-bypass mode (no NEXUS_API_KEY), which skips the
 * PAT branch entirely — so this file sets a master key to force Bearer tokens
 * through authenticate() and the nxk_ path. Semantics live in
 * lib/pat-scopes.ts and are unit-tested separately.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../../src/server.js";
import { createPat } from "../../src/lib/pat-store.js";

const MASTER = "test-master-key";
let app: FastifyInstance;

beforeEach(async () => {
  vi.stubEnv("NEXUS_API_KEY", MASTER);
  app = await buildServer();
  await app.ready();
});

afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
});

async function get(url: string, bearer: string) {
  return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${bearer}` } });
}

// Store-free memory-area endpoint: GET /api/memory/entries hits PgVectorStore,
// which 500s under the hermetic test DB. /memory/backend is an echo route.
async function memoryAreaCall(bearer: string) {
  return app.inject({
    method: "POST",
    url: "/api/memory/backend",
    headers: { authorization: `Bearer ${bearer}` },
  });
}

describe("PAT scope enforcement", () => {
  it("rejects a restricted token on an endpoint outside its scopes (403)", async () => {
    const { raw } = await createPat({ ownerId: "dev", name: "memory-only", scopes: ["memory"] });
    const res = await get("/api/tokens", raw);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("INSUFFICIENT_SCOPE");
  });

  it("allows a restricted token on endpoints inside its scopes", async () => {
    const { raw } = await createPat({ ownerId: "dev", name: "tokens-scoped", scopes: ["tokens"] });
    expect((await get("/api/tokens", raw)).statusCode).toBe(200);

    const { raw: memRaw } = await createPat({
      ownerId: "dev",
      name: "memory-scoped",
      scopes: ["memory"],
    });
    expect((await memoryAreaCall(memRaw)).statusCode).toBe(200);
  });

  it("keeps dotted sub-scopes working (memory.read unlocks memory)", async () => {
    const { raw } = await createPat({
      ownerId: "dev",
      name: "dotted",
      scopes: ["memory.read"],
    });
    expect((await memoryAreaCall(raw)).statusCode).toBe(200);
    expect((await get("/api/tokens", raw)).statusCode).toBe(403);
  });

  it("tokens without a scope keep full access (back-compat), as does the master key", async () => {
    const { raw } = await createPat({ ownerId: "dev", name: "full" });
    expect((await get("/api/tokens", raw)).statusCode).toBe(200);
    expect((await memoryAreaCall(raw)).statusCode).toBe(200);
    expect((await get("/api/tokens", MASTER)).statusCode).toBe(200);
  });

  it("an unknown nxk_ token still gets 401, not 403", async () => {
    const res = await get("/api/tokens", "nxk_deadbeefdeadbeefdeadbeefdeadbeef");
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/tokens scope validation", () => {
  it("rejects the old unenforceable UI vocabulary with 400 UNKNOWN_SCOPE", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { authorization: `Bearer ${MASTER}` },
      payload: { name: "bad", scopes: ["admin:users"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("UNKNOWN_SCOPE");
  });

  it("accepts known areas and dotted variants", async () => {
    const ok = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { authorization: `Bearer ${MASTER}` },
      payload: { name: "good", scopes: ["chat", "memory.read"] },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().scopes).toEqual(["chat", "memory.read"]);
  });
});
