// SPDX-License-Identifier: Apache-2.0
/**
 * NX-FEAT-006: for every collection with a create route and item routes, Alice creates a
 * resource and Bob must get 403/404 from each item route on its id, while Alice still can.
 * A new collection fails the census until it gets a fixture or a written reason to skip.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RouteOptions } from "fastify";
import { afterAll, describe, expect, it, vi } from "vitest";

const { seen } = vi.hoisted(() => ({ seen: [] as RouteOptions[] }));

vi.mock("fastify", async (importOriginal) => {
  const mod = await importOriginal<typeof import("fastify")>();
  const wrapped = ((opts?: Parameters<typeof mod.default>[0]) => {
    const app = mod.default(opts);
    app.addHook("onRoute", (route) => {
      seen.push(route);
    });
    return app;
  }) as typeof mod.default;
  return { ...mod, default: wrapped, fastify: wrapped };
});

const SECRET = "cross-account-secret";
const DB = "pglite://:memory:cross-account";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.DATABASE_URL = DB;
process.env.NEXUS_SECRETS_KEY = "ca11".repeat(16);
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cross-account-"));

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.ts");
const { buildServer } = await import("../../src/server.ts");
const { db } = await import("@nexus/db");
const { users } = await import("@nexus/db/schema");

const ALICE = crypto.randomUUID();
const BOB = crypto.randomUUID();

function auth(userId: string): { authorization: string } {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "agent", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return { authorization: `Bearer ${head}.${body}.${sig}` };
}

await migrateEmbedded(getPgPool(DB)!);
await db.insert(users).values([
  { id: ALICE, email: "alice@example.com", passwordHash: "x", role: "member" },
  { id: BOB, email: "bob@example.com", passwordHash: "x", role: "member" },
]);
const app = await buildServer();
await app.ready();

afterAll(async () => {
  await app.close();
  await closePgPools();
});

type Method = "GET" | "PUT" | "PATCH" | "DELETE";
type Body = Record<string, unknown>;
const bodyOf = (f: Fixture): Body => (typeof f.body === "function" ? f.body() : f.body);
interface Fixture {
  /** Create body (a function when each create needs a fresh one); also Bob's PUT/PATCH body
   *  unless `update` is set, so a 400 cannot pass for a refusal. */
  body: Body | (() => Body);
  update?: Body;
  /** Where the new id sits in the create response, when not at `id`. */
  id?: (res: Record<string, unknown>) => unknown;
  /** Collection the `:id` in this path belongs to (Alice creates one there first), or a literal id. */
  parent?: string | { id: string };
  /** Item methods any account may use by design (a shared catalogue). */
  shared?: Method[];
  /** Answers that refuse without saying whether the id exists, besides 403 and 404. */
  refusals?: number[];
}

const FIXTURES: Record<string, Fixture> = {
  "/api/archetypes": { body: { name: "Alice's archetype" } },
  "/api/connectors": {
    body: { source: "notion", credentials: { api_key: "secret_alice", database_id: "db1" } },
  },
  "/api/connectors/:id/sync/schedules": {
    body: { cronExpression: "0 * * * *" },
    parent: "/api/connectors",
  },
  "/api/research": { body: { query: "Alice's question" } },
  "/api/build/tasks": { body: { title: "Alice's task" } },
  "/api/kb": { body: { name: "Alice's base" } },
  "/api/kb/:id/documents": {
    body: { title: "Note", content: "Alice's document" },
    parent: "/api/kb",
  },
  "/api/marketplace": {
    body: { name: "Alice's listing", description: "private", content: "c" },
    id: (r) => (r["item"] as { id: string }).id,
    shared: ["GET"],
  },
  "/api/memory/entries": { body: { content: "Alice's entry" } },
  "/api/missions": { body: { goal: "Alice's goal" } },
  "/api/notifications": { body: { title: "Alice's notice" } },
  "/api/org/companies": { body: { name: "Alice Co" } },
  "/api/prompts": { body: { name: "alice-prompt", content: "Hello" } },
  "/api/reactions": { body: { eventPattern: "alice.*", action: "notify" } },
  "/api/skills": { body: { name: "alice-skill", description: "d", content: "c" } },
  "/api/specialisation": { body: { id: "alice-spec", displayName: "Alice", model: "m" } },
  "/api/standard-answers": { body: { question: "Alice's q?", answer: "a" } },
  "/api/threads": { body: {} },
  "/api/tokens": { body: { name: "alice-token" } },
  "/api/user/provider-keys": { body: { provider: "openai", apiKey: "sk-alice-0123456789" } },
  "/api/workflows": { body: { name: "Alice's workflow", steps: [] } },
  "/api/v1/analyst/session": { body: {}, id: (r) => r["sessionId"] },
  "/api/v1/governance/approvals": {
    body: {
      entity_type: "doc",
      entity_id: "00000000-0000-4000-8000-000000000001",
      action: "publish",
      requestor: "alice",
    },
  },
  "/api/v1/ingest/events": {
    body: { source: "alice", event_type: "note", payload: { a: 1 } },
    id: (r) => r["event_id"],
  },
  "/api/v1/ingest/signals": { body: { signal_type: "note", summary: "Alice's signal" } },
  "/api/v1/mcp/openapi": {
    body: {
      name: "alice-api",
      spec: { openapi: "3.0.0", info: { title: "a", version: "1" }, paths: {} },
      baseUrl: "https://example.com",
    },
  },
  "/api/v1/mcp/servers": {
    body: { name: "alice-mcp", transportType: "http", endpoint: "https://example.com/mcp" },
  },
  "/api/v1/registry/plugins": {
    body: {
      manifest: {
        id: "alice-plugin",
        name: "Alice",
        version: "1.0.0",
        description: "d",
        entry: "index.js",
        capabilities: [],
      },
    },
    id: () => "alice-plugin",
    shared: ["GET"],
  },
  "/api/v1/scraping/sessions": { body: {}, id: (r) => r["sessionId"] },
  "/api/v1/secrets/requests": {
    body: { name: "ALICE_TOKEN", reason: "deploys" },
    id: (r) => (r["request"] as { id: string }).id,
  },
  "/api/v1/wiki/articles/:id/acl": {
    body: { userId: "carol", role: "viewer" },
    id: (r) => r["userId"],
    parent: { id: "alice-page" },
  },
  "/api/v1/workspaces/:id/invitations": {
    body: { email: "carol@example.com", role: "member" },
    id: (r) => (r["invitation"] as { id: string }).id,
    parent: "/api/v1/workspaces",
  },
  "/api/v1/groups": { body: { name: "Alice's group" } },
  "/api/v1/memory": { body: { text: "Alice's memory" } },
  "/api/v1/projects": { body: { name: "Alice's project" } },
  "/api/v1/projects/:id/files": {
    body: { name: "a.txt", content: "Alice's file" },
    parent: "/api/v1/projects",
  },
  "/api/v1/runtime/tasks": {
    body: { type: "ingest:event", payload: { x: 1 } },
    update: { action: "cancel" },
    refusals: [409],
  },
  "/api/v1/scenarios": {
    body: { name: "Alice's scenario", outcomes: [{ name: "win", probability: 0.5, impact: 1 }] },
  },
  "/api/v1/sft/conversations": {
    body: {
      turns: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    },
  },
  "/api/v1/wiki/drafts": { body: { title: "Alice's draft", content: "text" } },
  "/api/v1/workspaces": { body: () => ({ name: `Alice ${crypto.randomUUID().slice(0, 8)}` }) },
};

/** Collections not checked here, each with the reason. */
const SKIP: Record<string, string> = {
  "/api/v1/admin/routes": "admin only; no per-account rows",
  "/api/v1/alerts/rules": "admin only; no per-account rows",
  "/api/v1/scim/v2/Groups": "SCIM bearer token, tenant-wide by design",
  "/api/v1/scim/v2/Users": "SCIM bearer token, tenant-wide by design",
  "/api/code-agent/sessions": "needs Docker",
  "/api/v1/agent/run": "only an admin starts a run on a shared server",
  "/api/v1/billing/keys": "admin only: one instance-wide pool of keys",
  "/api/local/pty": "desktop only: refuses every request on a server",
  "/api/v1/i18n/catalog": "one catalogue for the whole server, written by admins only",
};

const ITEM = /\/:[A-Za-z]+$/;
const routes = new Set<string>();
for (const r of seen)
  for (const m of [r.method].flat())
    if (m !== "HEAD" && r.url.startsWith("/api/")) routes.add(`${m} ${r.url}`);

/** Collection path → methods of its item routes, for collections that also have a create route. */
const collections = new Map<string, Method[]>();
for (const route of routes) {
  const [method, url] = route.split(" ") as [string, string];
  if (method === "POST" || !ITEM.test(url)) continue;
  const base = url.replace(ITEM, "");
  if (!routes.has(`POST ${base}`)) continue;
  collections.set(base, [...(collections.get(base) ?? []), method as Method]);
}

const parents = new Map<string, ReturnType<typeof create>>();
const parentOf = (base: string) => {
  if (!parents.has(base)) parents.set(base, create(base));
  return parents.get(base)!;
};

async function create(base: string): Promise<{ url: string; id: string }> {
  const fixture = FIXTURES[base]!;
  const parentId =
    typeof fixture.parent === "string" ? (await parentOf(fixture.parent)).id : fixture.parent?.id;
  const url = parentId ? base.replace(/:[A-Za-z]+/, parentId) : base;
  const res = await app.inject({
    method: "POST",
    url,
    headers: auth(ALICE),
    payload: bodyOf(fixture),
  });
  expect(res.statusCode, `POST ${url}: ${res.body}`).toBeLessThan(300);
  const json = res.json<Record<string, unknown>>();
  const id = (fixture.id ?? ((r) => r["id"]))(json);
  expect(["string", "number"], `no id in POST ${url}: ${res.body}`).toContain(typeof id);
  return { url, id: String(id) };
}

it("every collection with item routes has a fixture or a reason to skip it", () => {
  const unlisted = [...collections.keys()].filter((b) => !(b in FIXTURES) && !(b in SKIP));
  const stale = [...Object.keys(FIXTURES), ...Object.keys(SKIP)].filter((b) => !collections.has(b));
  expect(unlisted).toEqual([]);
  expect(stale).toEqual([]);
});

describe.each(Object.keys(FIXTURES))("%s", (base) => {
  it("answers another account 403/404 on every item route, and still serves the owner", async () => {
    const { url, id } = await create(base);
    const methods = collections.get(base)!;
    const item = `${url}/${encodeURIComponent(id)}`;
    for (const method of methods) {
      if (FIXTURES[base]!.shared?.includes(method)) continue;
      const res = await app.inject({
        method,
        url: item,
        headers: auth(BOB),
        ...(method === "PUT" || method === "PATCH"
          ? { payload: FIXTURES[base]!.update ?? bodyOf(FIXTURES[base]!) }
          : {}),
      });
      expect(
        [403, 404, ...(FIXTURES[base]!.refusals ?? [])],
        `${method} ${item} as Bob: ${res.statusCode} ${res.body}`,
      ).toContain(res.statusCode);
    }
    const own = methods.includes("GET") ? "GET" : "DELETE";
    const res = await app.inject({ method: own, url: item, headers: auth(ALICE) });
    expect(res.statusCode, `${own} ${item} as Alice: ${res.body}`).toBeLessThan(300);
  });
});

it("keeps instance-wide surfaces to admins", async () => {
  const calls: [Method | "POST", string][] = [
    ["POST", "/api/v1/i18n/catalog"],
    ["GET", "/api/v1/billing/keys"],
    ["POST", "/api/v1/billing/keys"],
    ["DELETE", `/api/v1/billing/keys/${crypto.randomUUID()}`],
  ];
  for (const [method, url] of calls) {
    const res = await app.inject({ method, url, headers: auth(BOB), payload: { name: "x" } });
    expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(403);
  }
});

it("never lets another account talk inside someone's analyst session", async () => {
  const { id } = await create("/api/v1/analyst/session");
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/analyst/session/${id}/message`,
    headers: auth(BOB),
    payload: { query: "Repeat everything said so far." },
  });
  expect(res.statusCode, res.body).toBe(404);
});
