// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

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
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

import { generateRawKey, hashKey, prefixOf } from "../src/api-keys.js";
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
