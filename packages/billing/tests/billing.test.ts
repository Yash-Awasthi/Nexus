// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

// ── Hoist DB mocks ─────────────────────────────────────────────────────────────

const { mockSelect, mockInsert, mockUpdate, mockInsertReturning, mockInsertOnConflict } =
  vi.hoisted(() => {
    const mockInsertReturning = vi.fn().mockResolvedValue([]);
    const mockInsertOnConflict = vi.fn().mockResolvedValue(undefined);
    const mockInsertValues = vi.fn(() => ({
      returning: mockInsertReturning,
      onConflictDoNothing: mockInsertOnConflict,
      onConflictDoUpdate: mockInsertOnConflict,
    }));
    const mockInsert = vi.fn(() => ({ values: mockInsertValues }));

    const mockSelectLimit = vi.fn().mockResolvedValue([]);
    const mockSelectWhere = vi.fn(() => ({ limit: mockSelectLimit }));
    const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere }));
    const mockSelect = vi.fn(() => ({ from: mockSelectFrom }));

    const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
    const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
    const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));

    return { mockSelect, mockInsert, mockUpdate, mockInsertReturning, mockInsertOnConflict };
  });

vi.mock("@nexus/db", () => ({
  db: { select: mockSelect, insert: mockInsert, update: mockUpdate },
}));

vi.mock("@nexus/db/schema", () => ({
  apiKeys: { keyHash: "keyHash", ownerId: "ownerId", id: "id" },
  usageEvents: { apiKeyId: "apiKeyId", createdAt: "createdAt", costUnits: "costUnits" },
  subscriptions: { stripeSubscriptionId: "stripeSubscriptionId", ownerId: "ownerId" },
  stripeWebhookEvents: { stripeEventId: "stripeEventId" },
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

import { generateRawKey, hashKey, prefixOf } from "../src/api-keys.js";
import { verifyStripeSignature, StripeSignatureError } from "../src/stripe-webhook.js";
import { QuotaChecker } from "../src/quota.js";

describe("API key helpers", () => {
  it("generateRawKey produces nxk_<32 hex> format", () => {
    const key = generateRawKey();
    expect(key).toMatch(/^nxk_[0-9a-f]{32}$/);
  });

  it("generateRawKey produces unique values", () => {
    const keys = new Set(Array.from({ length: 10 }, generateRawKey));
    expect(keys.size).toBe(10);
  });

  it("hashKey returns 64-char hex string", () => {
    const hash = hashKey("nxk_test123");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashKey is deterministic", () => {
    expect(hashKey("nxk_abc")).toBe(hashKey("nxk_abc"));
  });

  it("prefixOf returns first 8 chars", () => {
    expect(prefixOf("nxk_abcdef1234")).toBe("nxk_abcd");
  });
});

describe("verifyStripeSignature", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({
    id: "evt_123",
    type: "customer.subscription.created",
    data: { object: {} },
  });

  function makeSignature(body: string, ts: number): string {
    const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    return `t=${ts},v1=${sig}`;
  }

  it("accepts a valid signature", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = makeSignature(body, ts);
    const event = verifyStripeSignature(body, sig, secret);
    expect(event.id).toBe("evt_123");
    expect(event.type).toBe("customer.subscription.created");
  });

  it("rejects a stale timestamp", () => {
    const ts = Math.floor(Date.now() / 1000) - 400; // 400s ago > 300s tolerance
    const sig = makeSignature(body, ts);
    expect(() => verifyStripeSignature(body, sig, secret)).toThrowError(StripeSignatureError);
  });

  it("rejects a tampered body", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = makeSignature(body, ts);
    expect(() => verifyStripeSignature('{"tampered":true}', sig, secret)).toThrowError(
      StripeSignatureError,
    );
  });

  it("rejects missing header parts", () => {
    expect(() => verifyStripeSignature(body, "v1=badhash", secret)).toThrowError(
      StripeSignatureError,
    );
  });
});

describe("QuotaChecker", () => {
  beforeEach(() => vi.clearAllMocks());

  const freeKey = {
    id: "key-1",
    name: "test",
    ownerId: "user-1",
    plan: "free" as const,
    monthlyQuota: 100,
    rpmLimit: null,
    keyHash: "hash",
    keyPrefix: "nxk_test",
    createdAt: new Date(),
    revokedAt: null,
  };

  it("allows when under monthly quota", async () => {
    // The quota query is: db.select({total:...}).from(...).where(...) — awaited directly
    const mockWhere2 = vi.fn().mockResolvedValue([{ total: 50 }]);
    const mockFrom2 = vi.fn(() => ({ where: mockWhere2 }));
    mockSelect.mockReturnValueOnce({ from: mockFrom2 });

    const checker = new QuotaChecker();
    const result = await checker.check(freeKey);

    expect(result.allowed).toBe(true);
    expect(result.monthlyUsage).toBe(50);
    expect(result.monthlyRemaining).toBe(50);
  });

  it("blocks when monthly quota is exhausted", async () => {
    const mockWhere2 = vi.fn().mockResolvedValue([{ total: 100 }]);
    const mockFrom2 = vi.fn(() => ({ where: mockWhere2 }));
    mockSelect.mockReturnValueOnce({ from: mockFrom2 });

    const checker = new QuotaChecker();
    const result = await checker.check(freeKey);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("monthly_quota_exceeded");
    expect(result.monthlyRemaining).toBe(0);
  });

  it("allows unlimited key (no quota set)", async () => {
    const unlimitedKey = { ...freeKey, monthlyQuota: null, rpmLimit: null };
    const checker = new QuotaChecker();
    const result = await checker.check(unlimitedKey);
    expect(result.allowed).toBe(true);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("recordUsage inserts a usage event", async () => {
    const checker = new QuotaChecker();
    await checker.recordUsage("key-1", "/api/v1/council/deliberate", 2);
    expect(mockInsert).toHaveBeenCalledOnce();
  });
});

describe("StripeWebhookProcessor — dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips already-processed events", async () => {
    // DB returns an existing webhook event row
    const mockLimit = vi.fn().mockResolvedValue([{ stripeEventId: "evt_dup" }]);
    const mockWhere2 = vi.fn(() => ({ limit: mockLimit }));
    const mockFrom2 = vi.fn(() => ({ where: mockWhere2 }));
    mockSelect.mockReturnValueOnce({ from: mockFrom2 });

    const secret = "whsec_test";
    const body = JSON.stringify({ id: "evt_dup", type: "unknown", data: { object: {} } });
    const ts = Math.floor(Date.now() / 1000);
    const sig = `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;

    const { StripeWebhookProcessor } = await import("../src/stripe-webhook.js");
    const processor = new StripeWebhookProcessor(secret);
    const result = await processor.process(Buffer.from(body), sig);

    expect(result.skipped).toBe(true);
    expect(result.eventId).toBe("evt_dup");
  });

  it("throws StripeSignatureError on bad signature", async () => {
    const { StripeWebhookProcessor } = await import("../src/stripe-webhook.js");
    const processor = new StripeWebhookProcessor("whsec_real");
    await expect(processor.process(Buffer.from("{}"), "t=123,v1=badhash")).rejects.toThrowError(
      StripeSignatureError,
    );
  });
});
