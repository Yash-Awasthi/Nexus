// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoist DB mocks ─────────────────────────────────────────────────────────────

const { mockInsertValues, mockSelectWhere } = vi.hoisted(() => ({
  mockInsertValues: vi.fn().mockResolvedValue(undefined),
  mockSelectWhere: vi.fn().mockResolvedValue([{ total: 0 }]),
}));

vi.mock("@nexus/db", () => ({
  db: {
    insert: vi.fn(() => ({ values: mockInsertValues })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: mockSelectWhere })) })),
  },
}));

vi.mock("@nexus/db/schema", () => ({
  usageEvents: {
    apiKeyId: "apiKeyId",
    createdAt: "createdAt",
    costUnits: "costUnits",
    costUsd: "costUsd",
  },
}));

vi.mock("drizzle-orm", () => ({ sql: vi.fn(() => "sql-expr") }));

// cost.js is NOT mocked — real BillingLedger / computeCost / QuotaExceededError.

import { QuotaChecker } from "../src/quota.js";

const baseKey = {
  id: "key-cost",
  name: "cost-test",
  ownerId: "user-1",
  plan: "pro" as const,
  monthlyQuota: null,
  rpmLimit: null,
  monthlyCostCapUsd: null as number | null,
  keyHash: "hash",
  keyPrefix: "nxk_test",
  createdAt: new Date(),
  revokedAt: null,
};

describe("QuotaChecker — BYOK USD spend cap (ledger pre-call gate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectWhere.mockResolvedValue([{ total: 0 }]);
  });

  it("skips the cap check when no cap is set", async () => {
    const checker = new QuotaChecker();
    const result = await checker.check({ ...baseKey, monthlyCostCapUsd: null });
    expect(result.allowed).toBe(true);
  });

  it("blocks when month-to-date spend is at/over the cap", async () => {
    mockSelectWhere.mockResolvedValueOnce([{ total: 10 }]);
    const checker = new QuotaChecker();
    const result = await checker.check({ ...baseKey, monthlyCostCapUsd: 5 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("monthly_cost_cap_exceeded");
    expect(result.monthlyCostUsd).toBe(10);
    expect(result.monthlyCostCapUsd).toBe(5);
  });

  it("allows when month-to-date spend is under the cap and no estimate given", async () => {
    mockSelectWhere.mockResolvedValueOnce([{ total: 1 }]);
    const checker = new QuotaChecker();
    const result = await checker.check({ ...baseKey, monthlyCostCapUsd: 5 });
    expect(result.allowed).toBe(true);
  });

  it("blocks when the estimate would push spend over the cap", async () => {
    mockSelectWhere.mockResolvedValueOnce([{ total: 4 }]);
    const checker = new QuotaChecker();
    const result = await checker.check({ ...baseKey, monthlyCostCapUsd: 5 }, 2);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("monthly_cost_cap_exceeded");
  });

  it("allows when the estimate still fits under the cap", async () => {
    mockSelectWhere.mockResolvedValueOnce([{ total: 1 }]);
    const checker = new QuotaChecker();
    const result = await checker.check({ ...baseKey, monthlyCostCapUsd: 5 }, 2);
    expect(result.allowed).toBe(true);
  });
});

describe("QuotaChecker — recordUsage token breakdown", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists the token breakdown + model", async () => {
    const checker = new QuotaChecker();
    await checker.recordUsage("key-1", "/api/v1/gateway", {
      model: "some-unknown-model",
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 },
    });
    const row = mockInsertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(row).toMatchObject({
      apiKeyId: "key-1",
      endpoint: "/api/v1/gateway",
      model: "some-unknown-model",
      promptTokens: 100,
      completionTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      costUnits: 1,
    });
    expect(typeof row.costUsd).toBe("number");
  });

  it("uses an explicit costUsd when supplied", async () => {
    const checker = new QuotaChecker();
    await checker.recordUsage("key-1", "/x", { costUsd: 0.42, usage: { inputTokens: 1 } });
    const row = mockInsertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.costUsd).toBe(0.42);
  });

  it("keeps the legacy numeric costUnits signature working", async () => {
    const checker = new QuotaChecker();
    await checker.recordUsage("key-1", "/legacy", 3);
    const row = mockInsertValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(row).toMatchObject({ costUnits: 3, promptTokens: 0, completionTokens: 0, costUsd: 0 });
  });
});
