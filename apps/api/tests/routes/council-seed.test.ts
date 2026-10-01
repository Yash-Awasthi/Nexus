// SPDX-License-Identifier: Apache-2.0
/** A fresh account's council is built from the providers it saved keys for. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const SECRET = "council-seed-secret";
const DB = "pglite://:memory:council-seed-test";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.DATABASE_URL = DB;
process.env.NEXUS_SECRETS_KEY = "ab".repeat(32);
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-council-seed-"));

const { buildServer } = await import("../../src/server.js");
const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.js");
const { db } = await import("@nexus/db");
const { users } = await import("@nexus/db/schema");

async function newUser(): Promise<{ authorization: string }> {
  const id = crypto.randomUUID();
  await db.insert(users).values({ id, email: `${id}@example.com`, passwordHash: "x" });
  return { authorization: `Bearer ${tokenFor(id)}` };
}

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "agent", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

let app: FastifyInstance;
beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await closePgPools();
});

interface Member {
  provider: string;
  model: string;
  mode: string;
  enabled: boolean;
}

it("seeds the council from the caller's saved providers", async () => {
  const headers = await newUser();
  for (const payload of [
    { provider: "groq", apiKey: "gsk_test_key_0123456789" },
    {
      provider: "harbor",
      apiKey: "hb_test_key_0123456789",
      baseUrl: "https://harbor.example.com/v1",
      models: ["qwen-flash:free"],
    },
  ]) {
    const saved = await app.inject({
      method: "POST",
      url: "/api/user/provider-keys",
      headers,
      payload,
    });
    expect(saved.statusCode, saved.body).toBeLessThan(300);
  }

  const res = await app.inject({ method: "GET", url: "/api/settings/council", headers });
  const { members, seeded } = res.json<{ members: Member[]; seeded: boolean }>();

  expect(seeded).toBe(true);
  expect(members.map((m) => m.provider).sort()).toEqual(["groq", "harbor"]);
  expect(members.find((m) => m.provider === "harbor")?.model).toBe("qwen-flash:free");
  expect(members.every((m) => m.mode === "api" && m.enabled && m.model)).toBe(true);
});

it("keeps the catalogue seed for an account with no keys", async () => {
  const headers = await newUser();
  const res = await app.inject({ method: "GET", url: "/api/settings/council", headers });
  expect(res.json<{ members: Member[] }>().members.map((m) => m.provider)).toEqual([
    "openai",
    "gemini",
    "anthropic",
  ]);
});

it("tells an account with no keys that no key backs its seeded members", async () => {
  const headers = await newUser();
  const res = await app.inject({ method: "GET", url: "/api/settings/council", headers });
  const members = res.json<{ members: (Member & { keySource?: string })[] }>().members;
  expect(members.every((m) => m.mode === "api" && m.keySource === "none")).toBe(true);
});

it("reports the key behind each member it saves", async () => {
  const headers = await newUser();
  const res = await app.inject({
    method: "PUT",
    url: "/api/settings/council",
    headers,
    payload: { members: [{ id: "a", label: "A", enabled: true, provider: "groq", model: "m" }] },
  });
  expect(res.json<{ keySources: { source?: string }[] }>().keySources).toEqual([
    { index: 0, source: "none" },
  ]);
});

type Check = { index: number; status: string; availableModels?: string[] };
const save = async (headers: object, members: object[]) =>
  (
    await app.inject({ method: "PUT", url: "/api/settings/council", headers, payload: { members } })
  ).json<{ validations: Check[] }>().validations;
const member = (provider: string, model: string) => ({
  id: crypto.randomUUID(),
  label: provider,
  enabled: true,
  provider,
  model,
});

it("checks each member's model against the caller's own keys", async () => {
  const headers = await newUser();
  expect((await save(headers, [member("mistral", "mistral-small")]))[0]?.status).toBe("no_key");

  await app.inject({
    method: "POST",
    url: "/api/user/provider-keys",
    headers,
    payload: {
      provider: "harbor",
      apiKey: "hb_test_key_0123456789",
      baseUrl: "https://harbor.example.com/v1",
      models: ["qwen-flash:free"],
    },
  });
  const [ok, missing] = await save(headers, [
    member("harbor", "qwen-flash:free"),
    member("harbor", "gpt-9"),
  ]);
  expect(ok?.status).toBe("ok");
  expect(missing?.status).toBe("missing");
  expect(missing?.availableModels).toContain("qwen-flash:free");
});

it("reads a saved key's model catalogue from the provider", async () => {
  const headers = await newUser();
  await app.inject({
    method: "POST",
    url: "/api/user/provider-keys",
    headers,
    payload: { provider: "groq", apiKey: "gsk_catalog_key_0123456789" },
  });
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith("/models")) return real(input, init);
    seen.push(new Headers(init?.headers).get("authorization") ?? "");
    return new Response(JSON.stringify({ data: [{ id: "whisper-large-v3" }, { id: "llama-x" }] }), {
      status: 200,
    });
  }) as typeof fetch;
  try {
    const [ok, missing, off] = await save(headers, [
      member("groq", "llama-x"),
      member("groq", "nope"),
      { ...member("groq", "nope"), enabled: false },
    ]);
    expect(ok?.status).toBe("ok");
    expect(missing).toMatchObject({ status: "missing", availableModels: ["llama-x"] });
    expect(off?.status).toBe("skipped");
    expect(seen[0]).toBe("Bearer gsk_catalog_key_0123456789");
  } finally {
    globalThis.fetch = real;
  }
});
