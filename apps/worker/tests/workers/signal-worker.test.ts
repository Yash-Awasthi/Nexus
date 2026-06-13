// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoist mocks ───────────────────────────────────────────────────────────────

const { mockSelect, mockUpdate, mockInsert } = vi.hoisted(() => {
  // select chain: .from().where().orderBy().limit() → resolves to []
  const mockLimit = vi.fn().mockResolvedValue([]);
  const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
  const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));

  // update chain: .set().where() → resolves
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));

  // insert chain: .values() → resolves
  const mockInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockInsert = vi.fn(() => ({ values: mockInsertValues }));

  return { mockSelect, mockUpdate, mockInsert };
});

vi.mock("@nexus/db", () => ({
  db: { select: mockSelect, update: mockUpdate, insert: mockInsert },
}));

vi.mock("@nexus/db/schema", () => ({
  ingestedEvents: { processedAt: "processedAt", createdAt: "createdAt", id: "id" },
  signals: {},
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

import { DrizzleEventSource, DrizzleSignalSink } from "../../src/workers/drizzle-adapters.js";

describe("DrizzleEventSource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getUnprocessed — queries DB and returns empty array when no rows", async () => {
    const source = new DrizzleEventSource();
    const result = await source.getUnprocessed(10);
    expect(result).toEqual([]);
    expect(mockSelect).toHaveBeenCalledOnce();
  });

  it("getUnprocessed — maps DB rows to RawEvent shape", async () => {
    // Rig a row response
    const now = new Date();
    const row = {
      id: "ev-1",
      source: "github",
      eventType: "pr.opened",
      payload: { title: "Fix bug" },
      metadata: null,
      createdAt: now,
      processedAt: null,
      idempotencyKey: null,
    };
    // Drill into the mock chain to make .limit() resolve with our row
    const mockLimit = vi.fn().mockResolvedValue([row]);
    const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
    const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
    const mockFrom = vi.fn(() => ({ where: mockWhere }));
    mockSelect.mockReturnValueOnce({ from: mockFrom });

    const source = new DrizzleEventSource();
    const result = await source.getUnprocessed(10);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "ev-1",
      source: "github",
      eventType: "pr.opened",
      payload: { title: "Fix bug" },
      createdAt: now,
    });
    // null metadata should not appear as a key
    expect("metadata" in (result[0] ?? {})).toBe(false);
  });

  it("markProcessed — calls db.update with the event id", async () => {
    const source = new DrizzleEventSource();
    await source.markProcessed("ev-1");
    expect(mockUpdate).toHaveBeenCalledOnce();
  });
});

describe("DrizzleSignalSink", () => {
  beforeEach(() => vi.clearAllMocks());

  it("create — inserts a signal and returns it with generated id + createdAt", async () => {
    const sink = new DrizzleSignalSink();
    const created = await sink.create({
      signalType: "code.review-required",
      sourceEventIds: ["ev-1"],
      summary: "PR opened",
      priority: "medium",
      metadata: { tags: ["github"] },
    });

    expect(mockInsert).toHaveBeenCalledOnce();
    expect(created.id).toBeTruthy();
    expect(created.signalType).toBe("code.review-required");
    expect(created.priority).toBe("medium");
    expect(created.createdAt).toBeInstanceOf(Date);
  });

  it("create — passes null metadata when not provided", async () => {
    const sink = new DrizzleSignalSink();
    // Capture what was inserted
    let insertedValues: Record<string, unknown> | undefined;
    const mockInsertValues = vi.fn().mockImplementation((v: Record<string, unknown>) => {
      insertedValues = v;
      return Promise.resolve(undefined);
    });
    mockInsert.mockReturnValueOnce({ values: mockInsertValues });

    await sink.create({
      signalType: "general.event",
      sourceEventIds: [],
      summary: "Something happened",
      priority: "low",
    });

    expect(insertedValues?.metadata).toBeNull();
  });
});

describe("SignalWorker integration", () => {
  it("starts and stops without throwing", async () => {
    const { SignalWorker } = await import("../../src/workers/signal-worker.js");
    const worker = new SignalWorker();
    worker.start();
    worker.start(); // idempotent
    worker.stop();
    // No assertions needed — just verifying no runtime errors
  });
});
