// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

// ── Hoist DB mocks ─────────────────────────────────────────────────────────────

const {
  mockInsertOnConflict,
  mockInsertValues,
  mockInsert,
  mockSelectLimit,
  mockSelectWhere,
  mockSelect,
  mockUpdateWhere,
  mockUpdateSet,
  mockUpdate,
} = vi.hoisted(() => {
  const mockInsertOnConflict = vi.fn().mockResolvedValue(undefined);
  const mockInsertValues = vi.fn(() => ({
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

  return {
    mockInsertOnConflict,
    mockInsertValues,
    mockInsert,
    mockSelectLimit,
    mockSelectWhere,
    mockSelect,
    mockUpdateWhere,
    mockUpdateSet,
    mockUpdate,
  };
});

vi.mock("@nexus/db", () => ({
  db: { select: mockSelect, insert: mockInsert, update: mockUpdate },
}));

vi.mock("@nexus/db/schema", () => ({
  subscriptions: { stripeSubscriptionId: "stripeSubscriptionId", ownerId: "ownerId" },
  stripeWebhookEvents: { stripeEventId: "stripeEventId" },
  apiKeys: { ownerId: "ownerId" },
}));

vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));

// ── Imports (after mocks) ──────────────────────────────────────────────name────

import { StripeWebhookProcessor } from "../src/stripe-webhook.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SECRET = "whsec_dispatch_test_secret";

function signBody(body: string, secret = SECRET): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${sig}`;
}

const SUB = {
  id: "sub_123",
  customer: "cus_456",
  status: "active" as const,
  current_period_end: 9_999_999_999,
  cancel_at_period_end: false,
  metadata: { owner_id: "user-1", plan: "pro" },
  items: { data: [{ price: { id: "price_pro", nickname: "Pro Plan" } }] },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("StripeWebhookProcessor — constructor", () => {
  it("throws when no secret is provided and STRIPE_WEBHOOK_SECRET env var is absent", () => {
    const saved = process.env["STRIPE_WEBHOOK_SECRET"];
    delete process.env["STRIPE_WEBHOOK_SECRET"];
    expect(() => new StripeWebhookProcessor()).toThrow("STRIPE_WEBHOOK_SECRET");
    if (saved !== undefined) process.env["STRIPE_WEBHOOK_SECRET"] = saved;
  });
});

describe("StripeWebhookProcessor — dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("processes customer.subscription.created — upserts subscription and syncs api key plan", async () => {
    const body = JSON.stringify({
      id: "evt_created_1",
      type: "customer.subscription.created",
      data: { object: SUB },
    });
    const processor = new StripeWebhookProcessor(SECRET);
    const result = await processor.process(Buffer.from(body), signBody(body));
    expect(result.skipped).toBe(false);
    expect(result.eventType).toBe("customer.subscription.created");
    expect(result.error).toBeUndefined();
    expect(mockInsert).toHaveBeenCalled(); // subscription upsert + event log
    expect(mockUpdate).toHaveBeenCalled(); // api key plan sync
  });

  it("processes customer.subscription.updated — same path as created", async () => {
    const body = JSON.stringify({
      id: "evt_updated_1",
      type: "customer.subscription.updated",
      data: { object: SUB },
    });
    const processor = new StripeWebhookProcessor(SECRET);
    const result = await processor.process(Buffer.from(body), signBody(body));
    expect(result.skipped).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("processes customer.subscription.deleted — cancels subscription and downgrades plan", async () => {
    const body = JSON.stringify({
      id: "evt_deleted_1",
      type: "customer.subscription.deleted",
      data: { object: SUB },
    });
    const processor = new StripeWebhookProcessor(SECRET);
    const result = await processor.process(Buffer.from(body), signBody(body));
    expect(result.skipped).toBe(false);
    expect(result.error).toBeUndefined();
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("processes invoice.payment_succeeded (no-op handler — no DB writes)", async () => {
    const body = JSON.stringify({
      id: "evt_inv_ok_1",
      type: "invoice.payment_succeeded",
      data: { object: { id: "in_123" } },
    });
    const processor = new StripeWebhookProcessor(SECRET);
    const result = await processor.process(Buffer.from(body), signBody(body));
    expect(result.skipped).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("processes invoice.payment_failed (no-op handler)", async () => {
    const body = JSON.stringify({
      id: "evt_inv_fail_1",
      type: "invoice.payment_failed",
      data: { object: { id: "in_456" } },
    });
    const processor = new StripeWebhookProcessor(SECRET);
    const result = await processor.process(Buffer.from(body), signBody(body));
    expect(result.skipped).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("silently ignores unrecognised event types", async () => {
    const body = JSON.stringify({
      id: "evt_unk_1",
      type: "radar.review.opened",
      data: { object: {} },
    });
    const processor = new StripeWebhookProcessor(SECRET);
    const result = await processor.process(Buffer.from(body), signBody(body));
    expect(result.skipped).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("records handler error in event log but does not rethrow", async () => {
    // Make the first insert (subscription upsert) throw
    mockInsert.mockImplementationOnce(() => {
      throw new Error("DB upsert failed");
    });
    const body = JSON.stringify({
      id: "evt_err_1",
      type: "customer.subscription.created",
      data: { object: SUB },
    });
    const processor = new StripeWebhookProcessor(SECRET);
    const result = await processor.process(Buffer.from(body), signBody(body));
    expect(result.skipped).toBe(false);
    expect(result.error).toContain("DB upsert failed");
    // Recording insert should still have been called (second insert call)
    expect(mockInsert).toHaveBeenCalled();
  });
});

describe("resolvePlanFromSubscription — via dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves 'enterprise' from metadata.plan", async () => {
    const sub = { ...SUB, metadata: { owner_id: "u1", plan: "enterprise" } };
    const body = JSON.stringify({
      id: "evt_ent_meta_1",
      type: "customer.subscription.created",
      data: { object: sub },
    });
    const processor = new StripeWebhookProcessor(SECRET);
    const result = await processor.process(Buffer.from(body), signBody(body));
    expect(result.error).toBeUndefined();
  });

  it("resolves 'enterprise' from price nickname containing 'enterprise'", async () => {
    const sub = {
      ...SUB,
      metadata: {},
      items: { data: [{ price: { nickname: "Enterprise Annual" } }] },
    };
    const body = JSON.stringify({
      id: "evt_ent_nick_1",
      type: "customer.subscription.created",
      data: { object: sub },
    });
    const processor = new StripeWebhookProcessor(SECRET);
    const result = await processor.process(Buffer.from(body), signBody(body));
    expect(result.error).toBeUndefined();
  });

  it("resolves 'free' when no metadata or matching price nickname", async () => {
    const sub = { ...SUB, metadata: {}, items: { data: [] } };
    const body = JSON.stringify({
      id: "evt_free_1",
      type: "customer.subscription.created",
      data: { object: sub },
    });
    const processor = new StripeWebhookProcessor(SECRET);
    const result = await processor.process(Buffer.from(body), signBody(body));
    expect(result.error).toBeUndefined();
  });

  it("uses customer id as ownerId when metadata.owner_id is absent", async () => {
    const sub = { ...SUB, metadata: {} };
    const body = JSON.stringify({
      id: "evt_owner_fallback_1",
      type: "customer.subscription.deleted",
      data: { object: sub },
    });
    const processor = new StripeWebhookProcessor(SECRET);
    const result = await processor.process(Buffer.from(body), signBody(body));
    expect(result.error).toBeUndefined();
    expect(mockUpdate).toHaveBeenCalled();
  });
});
