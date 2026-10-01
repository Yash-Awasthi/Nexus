// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks (hoisted before imports) ─────────────────────────────────────

const { mockLookupApiKey, mockQuotaCheck, mockRecordUsage } = vi.hoisted(() => {
  const mockLookupApiKey = vi.fn();
  const mockQuotaCheck = vi.fn();
  const mockRecordUsage = vi.fn();
  return { mockLookupApiKey, mockQuotaCheck, mockRecordUsage };
});

vi.mock("../src/api-keys.js", () => ({
  lookupApiKey: mockLookupApiKey,
}));

vi.mock("../src/quota.js", () => ({
  QuotaChecker: vi.fn(() => ({
    check: mockQuotaCheck,
    recordUsage: mockRecordUsage,
  })),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import { billingPreHandler } from "../src/middleware.js";
import type { ApiKey } from "@nexus/db/schema";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FAKE_KEY: ApiKey = {
  id: "key-1",
  keyHash: "hash",
  keyPrefix: "nxk_test",
  name: "Test",
  ownerId: "user-1",
  plan: "free",
  monthlyQuota: 100,
  rpmLimit: null,
  createdAt: new Date(),
  revokedAt: null,
};

const makeRequest = (authHeader?: string, url = "/api/v1/test") =>
  ({
    headers: { authorization: authHeader ?? "" },
    url,
    log: { error: vi.fn() },
    billingKey: undefined as ApiKey | undefined,
  }) as unknown as Parameters<typeof billingPreHandler>[0];

const makeReply = () => {
  const r = { code: vi.fn(), send: vi.fn() };
  r.code.mockReturnValue(r);
  r.send.mockResolvedValue(undefined);
  return r as unknown as Parameters<typeof billingPreHandler>[1];
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("billingPreHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordUsage.mockResolvedValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns 401 when Authorization header is absent", async () => {
    const req = makeRequest();
    const reply = makeReply();
    await billingPreHandler(req, reply);
    expect(reply.code as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(401);
  });

  it("returns 401 when Authorization header has no Bearer token", async () => {
    const req = makeRequest("Basic abc123");
    const reply = makeReply();
    await billingPreHandler(req, reply);
    expect(reply.code as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(401);
  });

  it("returns 401 when API key is not found or revoked", async () => {
    mockLookupApiKey.mockResolvedValueOnce(undefined);
    const req = makeRequest("Bearer nxk_invalid");
    const reply = makeReply();
    await billingPreHandler(req, reply);
    expect(reply.code as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(401);
  });

  it("returns 429 with RPM message when rpm_limit_exceeded", async () => {
    mockLookupApiKey.mockResolvedValueOnce(FAKE_KEY);
    mockQuotaCheck.mockResolvedValueOnce({ allowed: false, reason: "rpm_limit_exceeded" });
    const req = makeRequest("Bearer nxk_valid");
    const reply = makeReply();
    await billingPreHandler(req, reply);
    expect(reply.code as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(429);
    const sent = (
      (reply.send as ReturnType<typeof vi.fn>).mock.calls[0] as [{ message: string }]
    )[0];
    expect(sent.message).toContain("Rate limit");
  });

  it("returns 429 with monthly message and usage when monthly_quota_exceeded", async () => {
    mockLookupApiKey.mockResolvedValueOnce(FAKE_KEY);
    mockQuotaCheck.mockResolvedValueOnce({
      allowed: false,
      reason: "monthly_quota_exceeded",
      monthlyUsage: 100,
      monthlyRemaining: 0,
    });
    const req = makeRequest("Bearer nxk_valid");
    const reply = makeReply();
    await billingPreHandler(req, reply);
    expect(reply.code as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(429);
    const sent = (
      (reply.send as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { monthlyUsage: number; monthlyRemaining: number },
      ]
    )[0];
    expect(sent.monthlyUsage).toBe(100);
    expect(sent.monthlyRemaining).toBe(0);
  });

  it("attaches billingKey to request and fires recordUsage on success", async () => {
    mockLookupApiKey.mockResolvedValueOnce(FAKE_KEY);
    mockQuotaCheck.mockResolvedValueOnce({ allowed: true });
    const req = makeRequest("Bearer nxk_valid");
    const reply = makeReply();
    await billingPreHandler(req, reply);
    expect(req.billingKey).toMatchObject({ id: "key-1" });
    // recordUsage is fire-and-forget — flush microtask queue
    await Promise.resolve();
    expect(mockRecordUsage).toHaveBeenCalledWith("key-1", "/api/v1/test");
  });

  it("logs an error when recordUsage promise rejects (fire-and-forget error path)", async () => {
    mockLookupApiKey.mockResolvedValueOnce(FAKE_KEY);
    mockQuotaCheck.mockResolvedValueOnce({ allowed: true });
    mockRecordUsage.mockRejectedValueOnce(new Error("DB down"));
    const req = makeRequest("Bearer nxk_valid");
    const reply = makeReply();
    await billingPreHandler(req, reply);
    // Drain microtask queue so the .catch() handler fires
    await new Promise((r) => setTimeout(r, 0));
    expect(req.log.error as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });
});
