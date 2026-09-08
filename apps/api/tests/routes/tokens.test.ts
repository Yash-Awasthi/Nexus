// SPDX-License-Identifier: Apache-2.0
/**
 * API tokens surface route tests — the §16.7 extraction of /tokens from
 * api-bridge.ts into routes/tokens.ts.
 *
 * Contract: the raw `nxk_` value is returned only at creation time; listing
 * exposes prefix + scopes but never the token or its hash.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

interface TokenView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

describe("POST /api/tokens", () => {
  it("returns the raw token once, with a usable prefix and scopes", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tokens",
      payload: { name: "ci-token", scopes: ["memory.read", "council"] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; name: string; token: string; prefix: string; scopes: string[] }>();
    expect(body.name).toBe("ci-token");
    expect(body.token.startsWith("nxk_")).toBe(true);
    expect(body.prefix).toBe(body.token.slice(0, 10));
    expect(body.scopes).toEqual(["memory.read", "council"]);
    // The raw token is NOT stored — listing only carries the prefix.
    expect(body.token).not.toContain("hash");
  });

  it("defaults scopes to all when omitted", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tokens",
      payload: { name: "scopeless" },
    });
    expect(res.json<{ scopes: string[] }>().scopes).toEqual(["*"]);
  });
});

describe("GET /api/tokens", () => {
  it("lists tokens with prefix and scopes, never the raw value or hash", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tokens",
      payload: { name: "list-me" },
    });
    const id = created.json<{ id: string }>().id;

    const res = await app.inject({ method: "GET", url: "/api/tokens" });
    expect(res.statusCode).toBe(200);
    const tokens = res.json<{ tokens: TokenView[] }>().tokens;
    const mine = tokens.find((t) => t.id === id);
    expect(mine).toBeDefined();
    expect(mine!.name).toBe("list-me");
    expect(mine!.prefix).toMatch(/^nxk_/);
    expect(mine!.lastUsedAt).toBeNull();
    // No raw token / no hash on the wire — listing carries prefix + scopes only.
    expect(Object.keys(mine!)).not.toContain("token");
    expect(Object.keys(mine!)).not.toContain("hash");
  });
});

describe("DELETE /api/tokens/:id", () => {
  it("deletes an existing token (204) and removes it from the listing", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tokens",
      payload: { name: "delete-me" },
    });
    const id = created.json<{ id: string }>().id;

    const del = await app.inject({ method: "DELETE", url: `/api/tokens/${id}` });
    expect(del.statusCode).toBe(204);

    const res = await app.inject({ method: "GET", url: "/api/tokens" });
    expect(res.json<{ tokens: TokenView[] }>().tokens.some((t) => t.id === id)).toBe(false);
  });

  it("returns 404 for an unknown token id", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/tokens/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Token not found" });
  });
});