// SPDX-License-Identifier: Apache-2.0
/**
 * Marketplace route tests — the §16.7 extraction + §16.2 registry merge.
 *
 * The marketplace is now a UI projection over the plugin registry: the six
 * built-in showcase items are seeded as real manifests, publishes go through
 * the registry store, and installs bump the registry's download counter. These
 * tests pin that single-owner contract through the real HTTP surface.
 *
 * Per-user identity (stars/installs keyed on nexusUserId, "anon" only as the
 * dev-bypass fallback) is pinned by the auth-enabled describe at the bottom.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../../src/server.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildServer();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

interface MpView {
  id: string;
  name: string;
  author: string;
  description: string;
  category: string;
  downloads: number;
  rating: number;
  tags: string[];
  price: "free" | "premium";
  stars: number;
  installed: boolean;
  starred: boolean;
}

describe("GET /api/marketplace (registry-backed listing)", () => {
  it("lists the six seeded builtins with the full view shape", async () => {
    const res = await app.inject({ method: "GET", url: "/api/marketplace" });
    expect(res.statusCode).toBe(200);
    const items = res.json<{ items: MpView[] }>().items;
    expect(items).toHaveLength(6);
    expect(items.map((i) => i.id).sort()).toEqual([
      "mp_1",
      "mp_2",
      "mp_3",
      "mp_4",
      "mp_5",
      "mp_6",
    ]);
    const first = items[0]!;
    // Sorted by downloads desc — mp_3 has the most.
    expect(first.id).toBe("mp_3");
    expect(first.name).toBe("Market Research Suite");
    expect(first.author).toBe("bizinsights");
    expect(first.rating).toBe(4.9);
    expect(first.tags).toContain("analysis");
    expect(first.downloads).toBeGreaterThan(0);
    expect(typeof first.installed).toBe("boolean");
    expect(typeof first.starred).toBe("boolean");
  });

  it("filters by category and search query", async () => {
    const cat = await app.inject({
      method: "GET",
      url: "/api/marketplace?category=legal",
    });
    const catItems = cat.json<{ items: MpView[] }>().items;
    expect(catItems).toHaveLength(1);
    expect(catItems[0]!.id).toBe("mp_2");

    const q = await app.inject({ method: "GET", url: "/api/marketplace?q=code" });
    const qItems = q.json<{ items: MpView[] }>().items;
    expect(qItems.length).toBeGreaterThan(0);
    expect(qItems.every((i) => i.name.toLowerCase().includes("code"))).toBe(true);
  });

  it("detail returns 404 for an unknown id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/marketplace/nope" });
    expect(res.statusCode).toBe(404);
  });
});

describe("marketplace item interactions", () => {
  it("star → unstar round-trips the star count", async () => {
    const star = await app.inject({ method: "POST", url: "/api/marketplace/mp_1/star" });
    expect(star.statusCode).toBe(200);
    expect(star.json<{ ok: boolean; stars: number }>().stars).toBe(1);

    const detail = await app.inject({ method: "GET", url: "/api/marketplace/mp_1" });
    expect(detail.json<{ item: MpView }>().item.starred).toBe(true);
    expect(detail.json<{ item: MpView }>().item.stars).toBe(1);

    const unstar = await app.inject({ method: "DELETE", url: "/api/marketplace/mp_1/star" });
    expect(unstar.json<{ stars: number }>().stars).toBe(0);
  });

  it("install marks installed and bumps the registry download counter (single owner)", async () => {
    const before = await app.inject({ method: "GET", url: "/api/v1/registry/plugins/mp_1" });
    const beforeDl = before.json<{ downloads: number }>().downloads;

    const install = await app.inject({ method: "POST", url: "/api/marketplace/mp_1/install" });
    expect(install.statusCode).toBe(200);

    const detail = await app.inject({ method: "GET", url: "/api/marketplace/mp_1" });
    expect(detail.json<{ item: MpView }>().item.installed).toBe(true);

    // The registry — the owner of download truth — saw the install.
    const after = await app.inject({ method: "GET", url: "/api/v1/registry/plugins/mp_1" });
    expect(after.json<{ downloads: number }>().downloads).toBe(beforeDl + 1);

    const uninstall = await app.inject({ method: "DELETE", url: "/api/marketplace/mp_1/install" });
    expect(uninstall.statusCode).toBe(200);
    const afterUn = await app.inject({ method: "GET", url: "/api/marketplace/mp_1" });
    expect(afterUn.json<{ item: MpView }>().item.installed).toBe(false);
  });

  it("star/install on an unknown id → 404", async () => {
    for (const url of ["/api/marketplace/nope/star", "/api/marketplace/nope/install"]) {
      const res = await app.inject({ method: "POST", url });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe("POST /api/marketplace (publish)", () => {
  it("requires name and description", async () => {
    const res = await app.inject({ method: "POST", url: "/api/marketplace", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("publishes a new item that appears in the registry-backed listing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/marketplace",
      payload: {
        name: "Probe Plugin",
        description: "A marketplace publish test item",
        category: "testing",
        tags: ["probe"],
        price: "free",
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ ok: boolean; item: MpView }>().item;
    expect(created.name).toBe("Probe Plugin");
    expect(created.author).toBe("you");
    expect(created.category).toBe("testing");

    // The item is a real registry record now — single source of truth.
    const viaRegistry = await app.inject({
      method: "GET",
      url: `/api/v1/registry/plugins/${created.id}`,
    });
    expect(viaRegistry.statusCode).toBe(200);
    expect(viaRegistry.json<{ manifest: { name: string } }>().manifest.name).toBe("Probe Plugin");

    const list = await app.inject({ method: "GET", url: "/api/marketplace?q=probe" });
    const hits = list.json<{ items: MpView[] }>().items;
    expect(hits.some((i) => i.id === created.id)).toBe(true);
  });
});

describe("registry publishes surface in the marketplace (single owner)", () => {
  it("a plugin published via /api/v1/registry/plugins shows up in /api/marketplace", async () => {
    const manifest = {
      id: "com.nexus.probe",
      name: "Registry-First Plugin",
      version: "1.0.0",
      entry: "./dist/plugin.js",
      capabilities: ["llm.inference"],
      description: "published through the registry wire contract",
      author: "probe",
    };
    const pub = await app.inject({
      method: "POST",
      url: "/api/v1/registry/plugins",
      payload: { manifest },
    });
    expect(pub.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/api/marketplace?q=registry-first" });
    const items = list.json<{ items: MpView[] }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("com.nexus.probe");
    expect(items[0]!.author).toBe("probe");
    // No UI extras yet → sensible defaults.
    expect(items[0]!.category).toBe("other");
    expect(items[0]!.price).toBe("free");
  });
});

// ── Per-user star/install identity ────────────────────────────────────────────
// With auth configured (NEXUS_JWT_SECRET), stars/installs are keyed on the
// JWT `sub` (request.nexusUserId) — not the shared "anon" bucket. The anon
// bucket remains only the dev-bypass fallback (no auth configured), which is
// what the describes above exercise.

const JWT_SECRET = "marketplace-test-secret";
const USER_A = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const USER_B = "11111111-2222-3333-4444-555555555555";

function makeJwt(payload: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function tokenFor(userId: string): string {
  return makeJwt(
    { sub: userId, role: "admin", tier: "pro", exp: Math.floor(Date.now() / 1000) + 3600 },
    JWT_SECRET,
  );
}

describe("marketplace per-user star/install identity (auth configured)", () => {
  beforeEach(async () => {
    delete process.env.NEXUS_API_KEY;
    process.env.NEXUS_JWT_SECRET = JWT_SECRET;
    app = await buildServer();
    await app.ready();
  });

  afterEach(() => {
    // Outer afterEach closes the app; just restore the no-auth dev-bypass env
    // so the anonymous describes above keep their contract.
    delete process.env.NEXUS_JWT_SECRET;
    delete process.env.NEXUS_API_KEY;
  });

  it("requires a token once auth is configured", async () => {
    const res = await app.inject({ method: "GET", url: "/api/marketplace/me" });
    expect(res.statusCode).toBe(401);
  });

  it("stars and installs are per-user, never shared", async () => {
    const asA = (method: "POST" | "DELETE", url: string) =>
      app.inject({ method, url, headers: { authorization: `Bearer ${tokenFor(USER_A)}` } });

    const star = await asA("POST", "/api/marketplace/mp_1/star");
    expect(star.json<{ stars: number }>().stars).toBe(1);
    await asA("POST", "/api/marketplace/mp_1/install");

    // User A sees their own star/install.
    const detailA = await app.inject({
      method: "GET",
      url: "/api/marketplace/mp_1",
      headers: { authorization: `Bearer ${tokenFor(USER_A)}` },
    });
    expect(detailA.json<{ item: MpView }>().item.starred).toBe(true);
    expect(detailA.json<{ item: MpView }>().item.installed).toBe(true);
    expect(detailA.json<{ item: MpView }>().item.stars).toBe(1);

    // User B sees the global star count but none of A's identity.
    const detailB = await app.inject({
      method: "GET",
      url: "/api/marketplace/mp_1",
      headers: { authorization: `Bearer ${tokenFor(USER_B)}` },
    });
    const itemB = detailB.json<{ item: MpView }>().item;
    expect(itemB.starred).toBe(false);
    expect(itemB.installed).toBe(false);
    expect(itemB.stars).toBe(1);

    // Leave no residue for later tests (stores are module-level).
    await asA("DELETE", "/api/marketplace/mp_1/star");
    await asA("DELETE", "/api/marketplace/mp_1/install");
  });

  it("GET /marketplace/me is actor-scoped", async () => {
    const auth = (userId: string) => ({ authorization: `Bearer ${tokenFor(userId)}` });

    await app.inject({ method: "POST", url: "/api/marketplace/mp_1/star", headers: auth(USER_A) });
    await app.inject({ method: "POST", url: "/api/marketplace/mp_2/install", headers: auth(USER_A) });
    await app.inject({ method: "POST", url: "/api/marketplace/mp_3/star", headers: auth(USER_B) });

    const meA = await app.inject({ method: "GET", url: "/api/marketplace/me", headers: auth(USER_A) });
    expect(meA.json<{ installed: string[]; starred: string[] }>()).toEqual({
      installed: ["mp_2"],
      starred: ["mp_1"],
    });

    const meB = await app.inject({ method: "GET", url: "/api/marketplace/me", headers: auth(USER_B) });
    expect(meB.json<{ installed: string[]; starred: string[] }>()).toEqual({
      installed: [],
      starred: ["mp_3"],
    });

    // Leave no residue for later tests (stores are module-level).
    await app.inject({ method: "DELETE", url: "/api/marketplace/mp_1/star", headers: auth(USER_A) });
    await app.inject({ method: "DELETE", url: "/api/marketplace/mp_2/install", headers: auth(USER_A) });
    await app.inject({ method: "DELETE", url: "/api/marketplace/mp_3/star", headers: auth(USER_B) });
  });

  it("unstar only removes the caller's own star", async () => {
    const auth = (userId: string) => ({ authorization: `Bearer ${tokenFor(userId)}` });

    await app.inject({ method: "POST", url: "/api/marketplace/mp_1/star", headers: auth(USER_A) });
    const starB = await app.inject({
      method: "POST",
      url: "/api/marketplace/mp_1/star",
      headers: auth(USER_B),
    });
    expect(starB.json<{ stars: number }>().stars).toBe(2);

    const unstarA = await app.inject({
      method: "DELETE",
      url: "/api/marketplace/mp_1/star",
      headers: auth(USER_A),
    });
    expect(unstarA.json<{ stars: number }>().stars).toBe(1);

    // B's star survived A's unstar.
    const detailB = await app.inject({
      method: "GET",
      url: "/api/marketplace/mp_1",
      headers: auth(USER_B),
    });
    expect(detailB.json<{ item: MpView }>().item.starred).toBe(true);

    // Leave no residue for later tests (stores are module-level).
    await app.inject({ method: "DELETE", url: "/api/marketplace/mp_1/star", headers: auth(USER_B) });
  });

  it("uninstall only removes the caller's own install", async () => {
    const auth = (userId: string) => ({ authorization: `Bearer ${tokenFor(userId)}` });

    await app.inject({ method: "POST", url: "/api/marketplace/mp_1/install", headers: auth(USER_A) });
    await app.inject({ method: "POST", url: "/api/marketplace/mp_1/install", headers: auth(USER_B) });
    await app.inject({ method: "DELETE", url: "/api/marketplace/mp_1/install", headers: auth(USER_A) });

    const detailA = await app.inject({
      method: "GET",
      url: "/api/marketplace/mp_1",
      headers: auth(USER_A),
    });
    expect(detailA.json<{ item: MpView }>().item.installed).toBe(false);

    const detailB = await app.inject({
      method: "GET",
      url: "/api/marketplace/mp_1",
      headers: auth(USER_B),
    });
    expect(detailB.json<{ item: MpView }>().item.installed).toBe(true);

    // Leave no residue for later tests (stores are module-level).
    await app.inject({ method: "DELETE", url: "/api/marketplace/mp_1/install", headers: auth(USER_B) });
  });

  it("double-unstar is idempotent: count never drops below the store's true value", async () => {
    const auth = (userId: string) => ({ authorization: `Bearer ${tokenFor(userId)}` });

    await app.inject({ method: "POST", url: "/api/marketplace/mp_1/star", headers: auth(USER_A) });
    await app.inject({ method: "POST", url: "/api/marketplace/mp_1/star", headers: auth(USER_B) });

    const first = await app.inject({
      method: "DELETE",
      url: "/api/marketplace/mp_1/star",
      headers: auth(USER_A),
    });
    expect(first.json<{ stars: number }>().stars).toBe(1);

    // Regression: the second unstar used to report max(0, N-1) = 0 while the
    // store still held B's star. The reported count must equal the store's
    // true post-operation count (1), and B's star must survive.
    const second = await app.inject({
      method: "DELETE",
      url: "/api/marketplace/mp_1/star",
      headers: auth(USER_A),
    });
    expect(second.json<{ stars: number }>().stars).toBe(1);

    const detail = await app.inject({
      method: "GET",
      url: "/api/marketplace/mp_1",
      headers: auth(USER_B),
    });
    expect(detail.json<{ item: MpView }>().item.starred).toBe(true);
    expect(detail.json<{ item: MpView }>().item.stars).toBe(1);

    // Leave no residue for later tests (stores are module-level).
    await app.inject({ method: "DELETE", url: "/api/marketplace/mp_1/star", headers: auth(USER_B) });
  });

  it("non-owner unstar leaves the count unchanged", async () => {
    const auth = (userId: string) => ({ authorization: `Bearer ${tokenFor(userId)}` });

    await app.inject({ method: "POST", url: "/api/marketplace/mp_1/star", headers: auth(USER_A) });

    // B never starred — unstarring must report the true count (1), not 0.
    const unstarB = await app.inject({
      method: "DELETE",
      url: "/api/marketplace/mp_1/star",
      headers: auth(USER_B),
    });
    expect(unstarB.json<{ stars: number }>().stars).toBe(1);

    const detail = await app.inject({
      method: "GET",
      url: "/api/marketplace/mp_1",
      headers: auth(USER_A),
    });
    expect(detail.json<{ item: MpView }>().item.starred).toBe(true);
    expect(detail.json<{ item: MpView }>().item.stars).toBe(1);

    // Leave no residue for later tests (stores are module-level).
    await app.inject({ method: "DELETE", url: "/api/marketplace/mp_1/star", headers: auth(USER_A) });
  });
});