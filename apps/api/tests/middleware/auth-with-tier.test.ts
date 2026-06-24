// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";

import { requireAuthWithTier, getTierFromRequest } from "../../src/middleware/auth.js";

// ── JWT helpers ───────────────────────────────────────────────────────────────

function makeJwt(payload: object, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function expiredJwt(secret: string): string {
  return makeJwt({ sub: "u1", tier: "pro", exp: Math.floor(Date.now() / 1000) - 60 }, secret);
}

// ── Request / Reply factories ─────────────────────────────────────────────────

function makeRequest(auth?: string): FastifyRequest {
  return {
    headers: { authorization: auth },
    socket: { remoteAddress: "127.0.0.1" },
    nexusTier: undefined as unknown,
    nexusUserId: undefined as unknown,
  } as unknown as FastifyRequest;
}

type MockReply = FastifyReply & { _code: number; _body: unknown; _sent: boolean };

function makeReply(): MockReply {
  const r = {
    _code: 0,
    _body: undefined as unknown,
    _sent: false,
    code(c: number) {
      r._code = c;
      return r as unknown as FastifyReply;
    },
    send(b: unknown) {
      r._body = b;
      r._sent = true;
      return r as unknown as FastifyReply;
    },
  } as unknown as MockReply;
  Object.defineProperty(r, "sent", { get: () => r._sent });
  return r;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const SECRET = "test-secret-1234";

describe("getTierFromRequest", () => {
  afterEach(() => {
    delete process.env.NEXUS_JWT_SECRET;
    delete process.env.NEXUS_API_KEY;
  });

  it("returns 'free' with no auth header", () => {
    const req = makeRequest();
    expect(getTierFromRequest(req)).toBe("free");
  });

  it("returns cached nexusTier when already set", () => {
    const req = makeRequest("Bearer dummy");
    (req as { nexusTier: string }).nexusTier = "enterprise";
    expect(getTierFromRequest(req)).toBe("enterprise");
  });

  it("extracts tier from valid HS256 JWT", () => {
    process.env.NEXUS_JWT_SECRET = SECRET;
    const token = makeJwt({ sub: "user1", tier: "pro" }, SECRET);
    const req = makeRequest(`Bearer ${token}`);
    expect(getTierFromRequest(req)).toBe("pro");
  });

  it("returns 'free' for expired JWT", () => {
    process.env.NEXUS_JWT_SECRET = SECRET;
    const req = makeRequest(`Bearer ${expiredJwt(SECRET)}`);
    expect(getTierFromRequest(req)).toBe("free");
  });

  it("returns 'free' for JWT with wrong secret", () => {
    process.env.NEXUS_JWT_SECRET = SECRET;
    const token = makeJwt({ sub: "u2", tier: "enterprise" }, "wrong-secret");
    const req = makeRequest(`Bearer ${token}`);
    expect(getTierFromRequest(req)).toBe("free");
  });

  it("coerces unknown tier value to 'free'", () => {
    process.env.NEXUS_JWT_SECRET = SECRET;
    const token = makeJwt({ sub: "u3", tier: "superadmin" }, SECRET);
    const req = makeRequest(`Bearer ${token}`);
    expect(getTierFromRequest(req)).toBe("free");
  });

  it("returns 'free' when JWT has no tier claim", () => {
    process.env.NEXUS_JWT_SECRET = SECRET;
    const token = makeJwt({ sub: "u4" }, SECRET);
    const req = makeRequest(`Bearer ${token}`);
    expect(getTierFromRequest(req)).toBe("free");
  });
});

describe("requireAuthWithTier", () => {
  afterEach(() => {
    delete process.env.NEXUS_JWT_SECRET;
    delete process.env.NEXUS_API_KEY;
    delete process.env.DATABASE_URL;
  });

  it("attaches tier=free in dev mode (no NEXUS_API_KEY)", async () => {
    delete process.env.NEXUS_API_KEY;
    const req = makeRequest();
    const reply = makeReply();
    await requireAuthWithTier(req, reply);
    expect(reply._sent).toBe(false);
    expect((req as { nexusTier: string }).nexusTier).toBe("free");
  });

  it("returns 401 when NEXUS_API_KEY set and token missing", async () => {
    process.env.NEXUS_API_KEY = "secret";
    const req = makeRequest(undefined);
    const reply = makeReply();
    await requireAuthWithTier(req, reply);
    expect(reply._code).toBe(401);
    expect(reply._sent).toBe(true);
  });

  it("extracts tier from valid JWT and attaches to request", async () => {
    process.env.NEXUS_JWT_SECRET = SECRET;
    // With a JWT secret configured, requireAuth validates the token (no dev bypass).
    delete process.env.NEXUS_API_KEY;
    const token = makeJwt(
      { sub: "u5", role: "admin", tier: "pro", exp: Math.floor(Date.now() / 1000) + 3600 },
      SECRET,
    );
    const req = makeRequest(`Bearer ${token}`);
    const reply = makeReply();
    await requireAuthWithTier(req, reply);
    expect(reply._sent).toBe(false);
    expect((req as { nexusTier: string }).nexusTier).toBe("pro");
    expect((req as { nexusUserId: string }).nexusUserId).toBe("u5");
  });

  it("falls back to 'free' when no JWT secret and no DATABASE_URL", async () => {
    delete process.env.NEXUS_JWT_SECRET;
    delete process.env.DATABASE_URL;
    delete process.env.NEXUS_API_KEY;
    const req = makeRequest("Bearer any-token");
    const reply = makeReply();
    await requireAuthWithTier(req, reply);
    expect((req as { nexusTier: string }).nexusTier).toBe("free");
  });
});
