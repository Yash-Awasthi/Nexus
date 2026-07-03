// SPDX-License-Identifier: Apache-2.0
/**
 * Integration test for the BYOK provider-keys routes (/api/user/provider-keys).
 *
 * Exercises the real Postgres-backed flow (encrypt → persist → list → resolve →
 * delete) plus the auth gate. Requires live infra + secrets, so it self-skips
 * in the standard suite and runs only when these env vars are present:
 *   DATABASE_URL, NEXUS_SECRETS_KEY (64 hex), NEXUS_JWT_SECRET, NEXUS_API_KEY
 *
 * Run it with:
 *   docker compose up -d postgres redis && pnpm --filter @nexus/db db:migrate
 *   DATABASE_URL=... NEXUS_SECRETS_KEY=$(openssl rand -hex 32) \
 *   NEXUS_JWT_SECRET=test-secret NEXUS_API_KEY=test-master \
 *   npx vitest run tests/routes/provider-keys.test.ts
 */
import { signJwt } from "@nexus/auth";
import { describe, it, expect } from "vitest";

const RUN =
  !!process.env.DATABASE_URL &&
  !!process.env.NEXUS_SECRETS_KEY &&
  !!process.env.NEXUS_JWT_SECRET &&
  !!process.env.NEXUS_API_KEY;

const USER_ID = "00000000-0000-0000-0000-0000000000aa";

function authHeader(): string {
  const token = signJwt(
    { sub: USER_ID, role: "admin", iat: 1_000, exp: 9_999_999_999 },
    process.env.NEXUS_JWT_SECRET!,
  );
  return `Bearer ${token}`;
}

describe.runIf(RUN)("BYOK /api/user/provider-keys (integration)", () => {
  it("requires authentication", async () => {
    const { buildServer } = await import("../../src/server.js");
    const app = await buildServer();
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/user/provider-keys",
      payload: { provider: "groq", apiKey: "gsk_testkey_123456" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("stores (encrypted), lists without the secret, and deletes a key", async () => {
    const { buildServer } = await import("../../src/server.js");
    const app = await buildServer();
    await app.ready();
    const headers = { authorization: authHeader() };
    const rawKey = "gsk_secret_value_do_not_leak_0001";

    // Store
    const post = await app.inject({
      method: "POST",
      url: "/api/user/provider-keys",
      headers,
      payload: { provider: "groq", apiKey: rawKey, label: "test" },
    });
    expect(post.statusCode).toBe(201);
    const created = post.json() as { id: string; provider: string; keyPrefix: string };
    expect(created.provider).toBe("groq");
    expect(created.keyPrefix).toBe(rawKey.slice(0, 8));
    // The raw key must never come back.
    expect(post.body).not.toContain(rawKey);

    // List — no secret, prefix only
    const list = await app.inject({ method: "GET", url: "/api/user/provider-keys", headers });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(rawKey);
    const { keys } = list.json() as { keys: { id: string; provider: string }[] };
    expect(keys.some((k) => k.id === created.id && k.provider === "groq")).toBe(true);

    // The plaintext-leaking resolve endpoint must be gone.
    const resolve = await app.inject({
      method: "GET",
      url: "/api/user/provider-keys/resolve/groq",
      headers,
    });
    expect(resolve.statusCode).toBe(404);

    // Delete (soft) — then it disappears from the list
    const del = await app.inject({
      method: "DELETE",
      url: `/api/user/provider-keys/${created.id}`,
      headers,
    });
    expect(del.statusCode).toBe(200);
    const list2 = await app.inject({ method: "GET", url: "/api/user/provider-keys", headers });
    const { keys: keys2 } = list2.json() as { keys: { id: string }[] };
    expect(keys2.some((k) => k.id === created.id)).toBe(false);

    await app.close();
  });

  it("rejects an invalid provider", async () => {
    const { buildServer } = await import("../../src/server.js");
    const app = await buildServer();
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/user/provider-keys",
      headers: { authorization: authHeader() },
      payload: { provider: "not-a-provider", apiKey: "x".repeat(12) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_provider" });
    await app.close();
  });
});
