// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";

import {
  requireAuth,
  requireAuthWithTier,
  getTierFromRequest,
  requireUserId,
} from "../../src/middleware/auth.js";

// `pg` is imported dynamically inside the api_keys identity fallback, so the
// mock intercepts that import. It lets the fallback be exercised without a
// Postgres instance, and counts constructions so the pool can be asserted to
// be reused rather than rebuilt per request.
const h = vi.hoisted(() => ({
  query: vi.fn(),
  end: vi.fn(),
  constructed: 0,
}));

// Both shapes: `auth.ts` imports the default export, and @nexus/db's client
// takes the named one. A mock with only `default` satisfies the file under
// test and breaks the moment anything else in the import graph opens a pool.
vi.mock("pg", () => {
  class FakePool {
    query = h.query;
    end = h.end;
    on = () => this;
    constructor() {
      h.constructed += 1;
    }
  }
  return { default: { Pool: FakePool }, Pool: FakePool };
});

/** The digest the api_keys writers (pat-store, packages/billing) store. */
function writerDigest(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

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

describe("requireUserId", () => {
  afterEach(() => {
    delete process.env.NEXUS_API_KEY;
  });

  it("returns the identity when one resolved", async () => {
    const req = makeRequest();
    (req as { nexusUserId?: string }).nexusUserId = "u1";
    const reply = makeReply();
    expect(await requireUserId(req, reply)).toBe("u1");
    expect(reply._sent).toBe(false);
  });

  it("rejects a caller with no identity (master API key) and returns null", async () => {
    const req = makeRequest();
    const reply = makeReply();
    expect(await requireUserId(req, reply)).toBeNull();
    expect(reply._code).toBe(401);
    expect((reply._body as { code: string }).code).toBe("IDENTITY_REQUIRED");
  });
});

describe("_verifyHs256 expiry boundary (via requireAuthWithTier)", () => {
  afterEach(() => {
    delete process.env.NEXUS_JWT_SECRET;
    delete process.env.NEXUS_API_KEY;
    delete process.env.DATABASE_URL;
  });

  it("treats a token as expired at its exp second, not one second later", async () => {
    // @nexus/auth accepts a token while `exp < now`, so at exp === now the
    // request authenticates — and identity must still not resolve.
    process.env.NEXUS_JWT_SECRET = SECRET;
    delete process.env.NEXUS_API_KEY;
    delete process.env.DATABASE_URL;
    const nowSec = Math.floor(Date.now() / 1000);
    const token = makeJwt({ sub: "u9", role: "admin", iat: nowSec - 10, exp: nowSec }, SECRET);
    const req = makeRequest(`Bearer ${token}`);
    const reply = makeReply();
    await requireAuthWithTier(req, reply);

    expect(reply._sent).toBe(false);
    expect((req as { nexusUserId?: string }).nexusUserId).toBeUndefined();
  });

  it("still resolves identity for a token that has not expired", async () => {
    process.env.NEXUS_JWT_SECRET = SECRET;
    delete process.env.NEXUS_API_KEY;
    delete process.env.DATABASE_URL;
    const nowSec = Math.floor(Date.now() / 1000);
    const token = makeJwt(
      { sub: "u10", role: "admin", iat: nowSec - 10, exp: nowSec + 60 },
      SECRET,
    );
    const req = makeRequest(`Bearer ${token}`);
    await requireAuthWithTier(req, makeReply());

    expect((req as { nexusUserId?: string }).nexusUserId).toBe("u10");
  });
});

// The api_keys fallback is reached by every request that authenticates with the
// master NEXUS_API_KEY (the default deployment path), so its correctness and its
// cost both matter.
describe("requireAuthWithTier api_keys identity fallback", () => {
  const MASTER = "master-key-value";
  const DB_URL = "postgres://user:pw@localhost:5432/nexus";

  beforeEach(() => {
    h.query.mockReset();
    h.end.mockReset();
    process.env.NEXUS_API_KEY = MASTER;
    process.env.DATABASE_URL = DB_URL;
  });

  afterEach(() => {
    delete process.env.NEXUS_JWT_SECRET;
    delete process.env.NEXUS_API_KEY;
    delete process.env.DATABASE_URL;
  });

  it("looks the token up under the digest the writers store", async () => {
    h.query.mockResolvedValue({ rows: [{ user_id: "u-77" }] });
    const req = makeRequest(`Bearer ${MASTER}`);
    await requireAuthWithTier(req, makeReply());

    expect(h.query).toHaveBeenCalledTimes(1);
    const [, params] = h.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([writerDigest(MASTER)]);
    expect((req as { nexusUserId?: string }).nexusUserId).toBe("u-77");
  });

  it("never matches a token hashed the old way (HMAC keyed on DATABASE_URL)", async () => {
    h.query.mockResolvedValue({ rows: [{ user_id: "u-77" }] });
    const req = makeRequest(`Bearer ${MASTER}`);
    await requireAuthWithTier(req, makeReply());

    const [, params] = h.query.mock.calls[0] as [string, unknown[]];
    const legacy = createHmac("sha256", DB_URL).update(MASTER).digest("hex");
    expect(params[0]).not.toBe(legacy);
  });

  it("excludes expired rows, matching verifyPat's validity predicate", async () => {
    h.query.mockResolvedValue({ rows: [] });
    const req = makeRequest(`Bearer ${MASTER}`);
    await requireAuthWithTier(req, makeReply());

    const [sql] = h.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/revoked_at/);
    expect(sql).toMatch(/expires_at IS NULL OR expires_at > NOW\(\)/);
  });

  it("leaves identity undefined when no row matches", async () => {
    h.query.mockResolvedValue({ rows: [] });
    const req = makeRequest(`Bearer ${MASTER}`);
    await requireAuthWithTier(req, makeReply());

    expect((req as { nexusUserId?: string }).nexusUserId).toBeUndefined();
  });

  it("stays authenticated and does not throw when the DB is unreachable", async () => {
    h.query.mockRejectedValue(new Error("ECONNREFUSED"));
    const req = makeRequest(`Bearer ${MASTER}`);
    const reply = makeReply();
    await requireAuthWithTier(req, reply);

    expect(reply._sent).toBe(false);
    expect((req as { nexusTier: string }).nexusTier).toBe("enterprise");
    expect((req as { nexusUserId?: string }).nexusUserId).toBeUndefined();
  });

  it("reuses one connection pool instead of rebuilding it per request", async () => {
    h.query.mockResolvedValue({ rows: [] });
    await requireAuthWithTier(makeRequest(`Bearer ${MASTER}`), makeReply());
    const afterFirst = h.constructed;
    await requireAuthWithTier(makeRequest(`Bearer ${MASTER}`), makeReply());

    expect(h.constructed).toBe(afterFirst);
    expect(h.end).not.toHaveBeenCalled();
  });
});

describe("requireAuth", () => {
  afterEach(() => {
    delete process.env.NEXUS_JWT_SECRET;
  });

  it("resolves the caller's identity too, so owner-scoped routes never fall into the shared bucket", async () => {
    process.env.NEXUS_JWT_SECRET = SECRET;
    const now = Math.floor(Date.now() / 1000);
    const token = makeJwt({ sub: "user-own", role: "agent", iat: now, exp: now + 60 }, SECRET);
    const req = makeRequest(`Bearer ${token}`);
    const reply = makeReply();
    await requireAuth(req, reply);
    expect(reply._sent).toBe(false);
    expect((req as { nexusUserId?: string }).nexusUserId).toBe("user-own");
  });
});
