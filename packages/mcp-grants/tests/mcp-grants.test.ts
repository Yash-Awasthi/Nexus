// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  GrantIssuer,
  GrantVerifier,
  GrantStore,
  GrantError,
  makeGrantSystem,
  defaultHmac,
  type HmacFn,
  type GrantPayload,
} from "../src/index.js";

const SECRET = "super-secret-key-32-chars-abcdef";

// Deterministic HMAC for tests (pure, no side effects)
const mockHmac: HmacFn = (key, data) => `sig:${key.slice(0, 4)}:${data.slice(0, 8)}`;

// ── defaultHmac ───────────────────────────────────────────────────────────────

describe("defaultHmac", () => {
  it("returns a hex string", () => {
    const sig = defaultHmac("key", "data");
    expect(typeof sig).toBe("string");
    expect(/^[0-9a-f]+$/.test(sig)).toBe(true);
  });

  it("is deterministic", () => {
    expect(defaultHmac("k", "d")).toBe(defaultHmac("k", "d"));
  });

  it("changes when data changes", () => {
    expect(defaultHmac("k", "a")).not.toBe(defaultHmac("k", "b"));
  });

  it("changes when key changes", () => {
    expect(defaultHmac("k1", "d")).not.toBe(defaultHmac("k2", "d"));
  });
});

// ── GrantIssuer ───────────────────────────────────────────────────────────────

describe("GrantIssuer", () => {
  let issuer: GrantIssuer;

  beforeEach(() => {
    issuer = new GrantIssuer(SECRET, mockHmac);
  });

  it("issue returns a GrantToken with raw and payload", () => {
    const token = issuer.issue({ sub: "agent:1", tools: ["search"] });
    expect(typeof token.raw).toBe("string");
    expect(token.payload.sub).toBe("agent:1");
  });

  it("raw token contains two dot-separated parts", () => {
    const token = issuer.issue({ sub: "a", tools: ["*"] });
    const parts = token.raw.split(".");
    expect(parts).toHaveLength(2);
  });

  it("payload includes jti, iss, iat, exp", () => {
    const token = issuer.issue({ sub: "a", tools: ["x"] });
    const p = token.payload;
    expect(typeof p.jti).toBe("string");
    expect(p.iss).toBe("nexus");
    expect(typeof p.iat).toBe("number");
    expect(typeof p.exp).toBe("number");
  });

  it("exp = iat + ttlMs (default 5 min)", () => {
    const token = issuer.issue({ sub: "a", tools: ["x"] });
    const { iat, exp } = token.payload;
    expect(exp - iat).toBeCloseTo(5 * 60 * 1000, -2);
  });

  it("custom ttlMs is respected", () => {
    const token = issuer.issue({ sub: "a", tools: ["x"], ttlMs: 1000 });
    expect(token.payload.exp - token.payload.iat).toBeCloseTo(1000, -1);
  });

  it("custom jti is used when provided", () => {
    const token = issuer.issue({ sub: "a", tools: ["x"], jti: "my-jti" });
    expect(token.payload.jti).toBe("my-jti");
  });

  it("metadata is included in payload", () => {
    const token = issuer.issue({ sub: "a", tools: ["x"], metadata: { env: "prod" } });
    expect(token.payload.metadata?.env).toBe("prod");
  });

  it("throws MALFORMED for empty sub", () => {
    expect(() => issuer.issue({ sub: "  ", tools: ["x"] })).toThrow(GrantError);
    try {
      issuer.issue({ sub: "", tools: ["x"] });
    } catch (e) {
      expect((e as GrantError).code).toBe("MALFORMED");
    }
  });

  it("throws MALFORMED for empty tools array", () => {
    expect(() => issuer.issue({ sub: "a", tools: [] })).toThrow(GrantError);
  });

  it("wildcard tools allowed", () => {
    const token = issuer.issue({ sub: "a", tools: ["*"] });
    expect(token.payload.tools).toContain("*");
  });

  it("each issue generates a unique jti by default", () => {
    const t1 = issuer.issue({ sub: "a", tools: ["x"] });
    const t2 = issuer.issue({ sub: "a", tools: ["x"] });
    expect(t1.payload.jti).not.toBe(t2.payload.jti);
  });
});

// ── GrantVerifier ─────────────────────────────────────────────────────────────

describe("GrantVerifier", () => {
  let issuer: GrantIssuer;
  let verifier: GrantVerifier;

  beforeEach(() => {
    issuer = new GrantIssuer(SECRET, defaultHmac);
    verifier = new GrantVerifier(SECRET, defaultHmac);
  });

  it("verifies a freshly issued token", () => {
    const token = issuer.issue({ sub: "a", tools: ["search"] });
    const result = verifier.verify(token.raw);
    expect(result.valid).toBe(true);
    expect(result.payload?.sub).toBe("a");
  });

  it("returns INVALID_SIGNATURE for tampered token", () => {
    const token = issuer.issue({ sub: "a", tools: ["x"] });
    const tampered = token.raw.slice(0, -4) + "XXXX";
    const result = verifier.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.code).toBe("INVALID_SIGNATURE");
  });

  it("returns MALFORMED for token without a dot", () => {
    const result = verifier.verify("no-dots-here");
    expect(result.valid).toBe(false);
    expect(result.code).toBe("MALFORMED");
  });

  it("returns EXPIRED for expired token", () => {
    const token = issuer.issue({ sub: "a", tools: ["x"], ttlMs: 1000 });
    const futureNow = token.payload.exp + 1;
    const result = verifier.verify(token.raw, { nowMs: futureNow });
    expect(result.valid).toBe(false);
    expect(result.code).toBe("EXPIRED");
  });

  it("returns SCOPE_DENIED when requiredTool not in token", () => {
    const token = issuer.issue({ sub: "a", tools: ["search"] });
    const result = verifier.verify(token.raw, { requiredTool: "code-exec" });
    expect(result.valid).toBe(false);
    expect(result.code).toBe("SCOPE_DENIED");
  });

  it("wildcard '*' satisfies any requiredTool", () => {
    const token = issuer.issue({ sub: "a", tools: ["*"] });
    const result = verifier.verify(token.raw, { requiredTool: "any-tool" });
    expect(result.valid).toBe(true);
  });

  it("specific tool in list satisfies requiredTool check", () => {
    const token = issuer.issue({ sub: "a", tools: ["search", "code-exec"] });
    const result = verifier.verify(token.raw, { requiredTool: "code-exec" });
    expect(result.valid).toBe(true);
  });

  it("verifier with wrong secret returns INVALID_SIGNATURE", () => {
    const wrongVerifier = new GrantVerifier("wrong-secret", defaultHmac);
    const token = issuer.issue({ sub: "a", tools: ["x"] });
    const result = wrongVerifier.verify(token.raw);
    expect(result.valid).toBe(false);
    expect(result.code).toBe("INVALID_SIGNATURE");
  });

  it("expired token result still includes payload", () => {
    const token = issuer.issue({ sub: "a", tools: ["x"], ttlMs: 1000 });
    const result = verifier.verify(token.raw, { nowMs: token.payload.exp + 100 });
    expect(result.payload).toBeDefined();
  });
});

// ── GrantStore ────────────────────────────────────────────────────────────────

describe("GrantStore", () => {
  let store: GrantStore;

  beforeEach(() => {
    const sys = makeGrantSystem(SECRET);
    store = sys.store;
  });

  it("issue adds token to store", () => {
    store.issue({ sub: "a", tools: ["x"] });
    expect(store.size()).toBe(1);
  });

  it("list returns all issued tokens", () => {
    store.issue({ sub: "a", tools: ["x"] });
    store.issue({ sub: "b", tools: ["y"] });
    expect(store.list()).toHaveLength(2);
  });

  it("verify returns valid for non-revoked token", () => {
    const token = store.issue({ sub: "a", tools: ["x"] });
    const result = store.verify(token.raw);
    expect(result.valid).toBe(true);
  });

  it("revoke + verify returns REVOKED", () => {
    const token = store.issue({ sub: "a", tools: ["x"] });
    store.revoke(token.payload.jti);
    const result = store.verify(token.raw);
    expect(result.valid).toBe(false);
    expect(result.code).toBe("REVOKED");
  });

  it("isRevoked returns false for non-revoked jti", () => {
    const token = store.issue({ sub: "a", tools: ["x"] });
    expect(store.isRevoked(token.payload.jti)).toBe(false);
  });

  it("isRevoked returns true after revoke", () => {
    const token = store.issue({ sub: "a", tools: ["x"] });
    store.revoke(token.payload.jti);
    expect(store.isRevoked(token.payload.jti)).toBe(true);
  });

  it("revoke returns false for unknown jti", () => {
    expect(store.revoke("unknown-jti")).toBe(false);
  });

  it("verify with requiredTool works through store", () => {
    const token = store.issue({ sub: "a", tools: ["search"] });
    const result = store.verify(token.raw, { requiredTool: "code-exec" });
    expect(result.code).toBe("SCOPE_DENIED");
  });
});

// ── makeGrantSystem ───────────────────────────────────────────────────────────

describe("makeGrantSystem", () => {
  it("returns issuer, verifier, store", () => {
    const sys = makeGrantSystem(SECRET);
    expect(sys.issuer).toBeInstanceOf(GrantIssuer);
    expect(sys.verifier).toBeInstanceOf(GrantVerifier);
    expect(sys.store).toBeInstanceOf(GrantStore);
  });

  it("end-to-end issue → verify round trip", () => {
    const { issuer, verifier } = makeGrantSystem(SECRET);
    const token = issuer.issue({ sub: "agent:1", tools: ["search", "exec"] });
    const result = verifier.verify(token.raw, { requiredTool: "search" });
    expect(result.valid).toBe(true);
    expect(result.payload?.sub).toBe("agent:1");
  });

  it("custom issuer label is included in payload", () => {
    const { issuer } = makeGrantSystem(SECRET, { issuer: "my-org" });
    const token = issuer.issue({ sub: "a", tools: ["x"] });
    expect(token.payload.iss).toBe("my-org");
  });
});

// ── GrantError ────────────────────────────────────────────────────────────────

describe("GrantError", () => {
  it("has correct name, code, and message", () => {
    const e = new GrantError("token expired", "EXPIRED");
    expect(e.name).toBe("GrantError");
    expect(e.code).toBe("EXPIRED");
    expect(e instanceof Error).toBe(true);
  });
});
