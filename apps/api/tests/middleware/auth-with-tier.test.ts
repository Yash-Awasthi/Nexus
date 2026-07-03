// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";

import { requireAuthWithTier, getTierFromRequest } from "../../src/middleware/auth.js";

// Nexus is free/open: there is no paid tier. Every authenticated caller resolves
// to the highest access level ("enterprise") so no feature is ever gated. These
// tests pin that contract and the identity resolution that still matters.

// ── JWT helpers ───────────────────────────────────────────────────────────────

function makeJwt(payload: object, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
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

describe("getTierFromRequest (free/open — always highest tier)", () => {
  afterEach(() => {
    delete process.env.NEXUS_JWT_SECRET;
    delete process.env.NEXUS_API_KEY;
  });

  it("returns the open tier with no auth header", () => {
    expect(getTierFromRequest(makeRequest())).toBe("enterprise");
  });

  it("returns the open tier regardless of the JWT tier claim", () => {
    process.env.NEXUS_JWT_SECRET = SECRET;
    const token = makeJwt({ sub: "user1", tier: "pro" }, SECRET);
    expect(getTierFromRequest(makeRequest(`Bearer ${token}`))).toBe("enterprise");
  });

  it("returns the open tier even for an unsigned/garbage token", () => {
    expect(getTierFromRequest(makeRequest("Bearer not-a-jwt"))).toBe("enterprise");
  });
});

describe("requireAuthWithTier", () => {
  afterEach(() => {
    delete process.env.NEXUS_JWT_SECRET;
    delete process.env.NEXUS_API_KEY;
    delete process.env.DATABASE_URL;
  });

  it("attaches the open tier in dev mode (no NEXUS_API_KEY)", async () => {
    delete process.env.NEXUS_API_KEY;
    const req = makeRequest();
    const reply = makeReply();
    await requireAuthWithTier(req, reply);
    expect(reply._sent).toBe(false);
    expect((req as { nexusTier: string }).nexusTier).toBe("enterprise");
  });

  it("returns 401 when NEXUS_API_KEY set and token missing", async () => {
    process.env.NEXUS_API_KEY = "secret";
    const req = makeRequest(undefined);
    const reply = makeReply();
    await requireAuthWithTier(req, reply);
    expect(reply._code).toBe(401);
    expect(reply._sent).toBe(true);
  });

  it("resolves nexusUserId from a valid JWT and attaches the open tier", async () => {
    process.env.NEXUS_JWT_SECRET = SECRET;
    delete process.env.NEXUS_API_KEY;
    const token = makeJwt(
      { sub: "u5", role: "admin", tier: "pro", exp: Math.floor(Date.now() / 1000) + 3600 },
      SECRET,
    );
    const req = makeRequest(`Bearer ${token}`);
    const reply = makeReply();
    await requireAuthWithTier(req, reply);
    expect(reply._sent).toBe(false);
    expect((req as { nexusTier: string }).nexusTier).toBe("enterprise");
    expect((req as { nexusUserId: string }).nexusUserId).toBe("u5");
  });

  it("attaches the open tier when no JWT secret and no DATABASE_URL", async () => {
    delete process.env.NEXUS_JWT_SECRET;
    delete process.env.DATABASE_URL;
    delete process.env.NEXUS_API_KEY;
    const req = makeRequest("Bearer any-token");
    const reply = makeReply();
    await requireAuthWithTier(req, reply);
    expect((req as { nexusTier: string }).nexusTier).toBe("enterprise");
  });
});
