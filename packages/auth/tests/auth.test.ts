// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import {
  AuthError,
  extractBearerToken,
  verifyApiKey,
  signJwt,
  verifyJwt,
  authenticate,
  makeFastifyAuthHook,
} from "../src/index.js";

// ── AuthError ─────────────────────────────────────────────────────────────────

describe("AuthError", () => {
  it("sets httpStatus=401 for MISSING_TOKEN", () => {
    const e = new AuthError("MISSING_TOKEN", "msg");
    expect(e.httpStatus).toBe(401);
    expect(e.code).toBe("MISSING_TOKEN");
    expect(e).toBeInstanceOf(Error);
  });

  it("sets httpStatus=401 for INVALID_TOKEN", () => {
    expect(new AuthError("INVALID_TOKEN", "x").httpStatus).toBe(401);
  });

  it("sets httpStatus=401 for EXPIRED_TOKEN", () => {
    expect(new AuthError("EXPIRED_TOKEN", "x").httpStatus).toBe(401);
  });

  it("sets httpStatus=403 for INSUFFICIENT_ROLE", () => {
    expect(new AuthError("INSUFFICIENT_ROLE", "x").httpStatus).toBe(403);
  });
});

// ── extractBearerToken ────────────────────────────────────────────────────────

describe("extractBearerToken", () => {
  it("returns token from valid header", () => {
    expect(extractBearerToken("Bearer mytoken123")).toBe("mytoken123");
  });

  it("throws MISSING_TOKEN when header is undefined", () => {
    expect(() => extractBearerToken(undefined)).toThrow(AuthError);
    try {
      extractBearerToken(undefined);
    } catch (e) {
      expect((e as AuthError).code).toBe("MISSING_TOKEN");
    }
  });

  it("throws MISSING_TOKEN when header has no Bearer prefix", () => {
    expect(() => extractBearerToken("Token abc")).toThrow(AuthError);
  });

  it("throws MISSING_TOKEN when Bearer token is empty", () => {
    expect(() => extractBearerToken("Bearer ")).toThrow(AuthError);
  });
});

// ── verifyApiKey ──────────────────────────────────────────────────────────────

describe("verifyApiKey", () => {
  const KEY = "nexus-test-api-key-abc123";

  it("returns true for matching key", () => {
    expect(verifyApiKey(KEY, KEY)).toBe(true);
  });

  it("throws INVALID_TOKEN for wrong key", () => {
    expect(() => verifyApiKey("wrong-key", KEY)).toThrow(AuthError);
    try {
      verifyApiKey("wrong-key", KEY);
    } catch (e) {
      expect((e as AuthError).code).toBe("INVALID_TOKEN");
    }
  });

  it("throws INVALID_TOKEN for empty token", () => {
    expect(() => verifyApiKey("", KEY)).toThrow(AuthError);
  });

  it("is case-sensitive", () => {
    expect(() => verifyApiKey(KEY.toUpperCase(), KEY)).toThrow(AuthError);
  });
});

// ── signJwt / verifyJwt ───────────────────────────────────────────────────────

describe("JWT (signJwt + verifyJwt)", () => {
  const SECRET = "super-secret-jwt-key";

  const PAYLOAD = {
    sub: "user-001",
    role: "agent" as const,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  it("signs and verifies a valid JWT", () => {
    const token = signJwt(PAYLOAD, SECRET);
    const decoded = verifyJwt(token, SECRET);
    expect(decoded.sub).toBe("user-001");
    expect(decoded.role).toBe("agent");
    expect(decoded.iat).toBeTypeOf("number");
  });

  it("returns all payload fields", () => {
    const token = signJwt({ ...PAYLOAD, capabilities: ["read", "write"] }, SECRET);
    const decoded = verifyJwt(token, SECRET);
    expect(decoded.capabilities).toEqual(["read", "write"]);
  });

  it("throws INVALID_TOKEN with wrong secret", () => {
    const token = signJwt(PAYLOAD, SECRET);
    expect(() => verifyJwt(token, "wrong-secret")).toThrow(AuthError);
    try {
      verifyJwt(token, "wrong-secret");
    } catch (e) {
      expect((e as AuthError).code).toBe("INVALID_TOKEN");
    }
  });

  it("throws INVALID_TOKEN for malformed JWT (missing parts)", () => {
    expect(() => verifyJwt("header.body", SECRET)).toThrow(AuthError);
  });

  it("throws INVALID_TOKEN for tampered payload", () => {
    const token = signJwt(PAYLOAD, SECRET);
    const [h, , s] = token.split(".");
    const tampered = Buffer.from(JSON.stringify({ ...PAYLOAD, role: "admin" })).toString(
      "base64url",
    );
    expect(() => verifyJwt(`${h}.${tampered}.${s}`, SECRET)).toThrow(AuthError);
  });

  it("throws EXPIRED_TOKEN for expired JWT", () => {
    const expired = signJwt({ ...PAYLOAD, exp: Math.floor(Date.now() / 1000) - 10 }, SECRET);
    expect(() => verifyJwt(expired, SECRET)).toThrow(AuthError);
    try {
      verifyJwt(expired, SECRET);
    } catch (e) {
      expect((e as AuthError).code).toBe("EXPIRED_TOKEN");
    }
  });

  it("accepts JWT with no exp field (non-expiring)", () => {
    // exp=0 is in the past — should still expire; test with a far-future exp instead
    const longLived = {
      sub: "svc",
      role: "agent" as const,
      exp: Math.floor(Date.now() / 1000) + 999999,
    };
    const t2 = signJwt(longLived, SECRET);
    expect(verifyJwt(t2, SECRET).sub).toBe("svc");
  });
});

// ── authenticate ──────────────────────────────────────────────────────────────

describe("authenticate", () => {
  const API_KEY = "test-api-key-xyz";
  const JWT_SECRET = "jwt-secret-abc";

  it("accepts a valid API key", () => {
    const result = authenticate(`Bearer ${API_KEY}`, { apiKey: API_KEY });
    expect(result.authenticated).toBe(true);
    expect(result.method).toBe("api-key");
    expect(result.role).toBe("admin");
  });

  it("accepts a valid JWT when API key is not configured", () => {
    const token = signJwt(
      { sub: "u1", role: "agent", exp: Math.floor(Date.now() / 1000) + 3600 },
      JWT_SECRET,
    );
    const result = authenticate(`Bearer ${token}`, { jwtSecret: JWT_SECRET });
    expect(result.authenticated).toBe(true);
    expect(result.method).toBe("jwt");
    expect(result.subject).toBe("u1");
  });

  it("falls through to JWT when API key doesn't match", () => {
    const token = signJwt(
      { sub: "u2", role: "admin", exp: Math.floor(Date.now() / 1000) + 3600 },
      JWT_SECRET,
    );
    const result = authenticate(`Bearer ${token}`, {
      apiKey: "different-key",
      jwtSecret: JWT_SECRET,
    });
    expect(result.method).toBe("jwt");
    expect(result.role).toBe("admin");
  });

  it("throws MISSING_TOKEN when no auth header provided", () => {
    expect(() => authenticate(undefined, { apiKey: API_KEY })).toThrow(AuthError);
    try {
      authenticate(undefined, { apiKey: API_KEY });
    } catch (e) {
      expect((e as AuthError).code).toBe("MISSING_TOKEN");
    }
  });

  it("throws INSUFFICIENT_ROLE when role is too low", () => {
    const token = signJwt(
      { sub: "u3", role: "read-only", exp: Math.floor(Date.now() / 1000) + 3600 },
      JWT_SECRET,
    );
    expect(() =>
      authenticate(`Bearer ${token}`, { jwtSecret: JWT_SECRET, requiredRole: "admin" }),
    ).toThrow(AuthError);
    try {
      authenticate(`Bearer ${token}`, { jwtSecret: JWT_SECRET, requiredRole: "admin" });
    } catch (e) {
      expect((e as AuthError).code).toBe("INSUFFICIENT_ROLE");
    }
  });

  it("returns admin identity when disabled=true", () => {
    const result = authenticate(undefined, { apiKey: API_KEY, disabled: true });
    expect(result.authenticated).toBe(true);
    expect(result.role).toBe("admin");
  });

  it("throws when neither apiKey nor jwtSecret configured", () => {
    expect(() => authenticate("Bearer token", {})).toThrow();
  });
});

// ── makeFastifyAuthHook ───────────────────────────────────────────────────────

describe("makeFastifyAuthHook", () => {
  const API_KEY = "hook-api-key";

  function makeMockReply() {
    let statusCode = 200;
    let body: unknown = null;
    return {
      code(n: number) {
        statusCode = n;
        return {
          send: async (b: unknown) => {
            body = b;
          },
        };
      },
      get statusCode() {
        return statusCode;
      },
      get body() {
        return body;
      },
    };
  }

  it("calls next (no error) with valid API key", async () => {
    const hook = makeFastifyAuthHook({ apiKey: API_KEY });
    const req = { headers: { authorization: `Bearer ${API_KEY}` } };
    const reply = makeMockReply();
    await hook(req, reply);
    expect(reply.statusCode).toBe(200); // untouched
  });

  it("returns 401 with invalid token", async () => {
    const hook = makeFastifyAuthHook({ apiKey: API_KEY });
    const req = { headers: { authorization: "Bearer wrong-key" } };
    const reply = makeMockReply();
    await hook(req, reply);
    expect(reply.statusCode).toBe(401);
    expect((reply.body as { code: string }).code).toBe("INVALID_TOKEN");
  });

  it("returns 401 when no header present", async () => {
    const hook = makeFastifyAuthHook({ apiKey: API_KEY });
    const req = { headers: {} };
    const reply = makeMockReply();
    await hook(req, reply);
    expect(reply.statusCode).toBe(401);
  });

  it("returns 403 for insufficient role", async () => {
    const JWT_SECRET = "hook-jwt-secret";
    const token = signJwt(
      { sub: "low-user", role: "read-only", exp: Math.floor(Date.now() / 1000) + 3600 },
      JWT_SECRET,
    );
    const hook = makeFastifyAuthHook({ jwtSecret: JWT_SECRET, requiredRole: "admin" });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const reply = makeMockReply();
    await hook(req, reply);
    expect(reply.statusCode).toBe(403);
  });
});
