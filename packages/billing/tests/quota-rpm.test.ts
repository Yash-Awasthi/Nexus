// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoist DB mocks ─────────────────────────────────────────────────────────────

const { mockInsert, mockSelect } = vi.hoisted(() => {
  const mockInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockInsert = vi.fn(() => ({ values: mockInsertValues }));

  const mockSelectWhere = vi.fn().mockResolvedValue([{ total: 0 }]);
  const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere }));
  const mockSelect = vi.fn(() => ({ from: mockSelectFrom }));

  return { mockInsert, mockSelect };
});

vi.mock("@nexus/db", () => ({
  db: { select: mockSelect, insert: mockInsert },
}));

vi.mock("@nexus/db/schema", () => ({
  usageEvents: { apiKeyId: "apiKeyId", createdAt: "createdAt", costUnits: "costUnits" },
}));

vi.mock("drizzle-orm", () => ({
  sql: vi.fn(() => "sql-expr"),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import { QuotaChecker } from "../src/quota.js";

const rpmKey = {
  id: "key-rpm-BASE",
  name: "rpm-test",
  ownerId: "user-1",
  plan: "pro" as const,
  monthlyQuota: null,
  rpmLimit: 2, // max 2 per minute
  keyHash: "hash",
  keyPrefix: "nxk_test",
  createdAt: new Date(),
  revokedAt: null,
};

// ── QuotaChecker — RPM limit ───────────────────────────────────────────────────

describe("QuotaChecker — RPM enforcement", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows first request when within RPM limit", async () => {
    const checker = new QuotaChecker();
    const result = await checker.check({ ...rpmKey, id: "rpm-fresh-1" });
    expect(result.allowed).toBe(true);
  });

  it("blocks when RPM limit is fully exhausted", async () => {
    const checker = new QuotaChecker();
    const key = { ...rpmKey, id: "rpm-exhaust-unique" };
    // First two are within limit (limit = 2)
    await checker.check(key);
    await checker.check(key);
    // Third exceeds limit
    const result = await checker.check(key);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("rpm_limit_exceeded");
  });

  it("does not apply RPM check when rpmLimit is 0", async () => {
    const checker = new QuotaChecker();
    const result = await checker.check({ ...rpmKey, id: "rpm-zero-unique", rpmLimit: 0 });
    expect(result.allowed).toBe(true);
  });

  it("does not apply RPM check when rpmLimit is null", async () => {
    const checker = new QuotaChecker();
    const result = await checker.check({ ...rpmKey, id: "rpm-null-unique", rpmLimit: null });
    expect(result.allowed).toBe(true);
  });
});
