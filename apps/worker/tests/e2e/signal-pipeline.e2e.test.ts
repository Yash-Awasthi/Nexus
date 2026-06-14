// SPDX-License-Identifier: Apache-2.0
/**
 * E2E — Signal Pipeline
 *
 * Tests the full ingest → classify → signal flow using a real Postgres database.
 * Requires DATABASE_URL to point to a live (or CI service container) Postgres
 * instance with the Nexus schema already applied.
 *
 * Skips automatically when DATABASE_URL is absent so unit test runs are unaffected.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

// Skip entire suite in environments without a live DB
const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("E2E: Signal pipeline (live Postgres)", () => {
  // Dynamic imports so the DB client is only initialised when DATABASE_URL exists
  let db: Awaited<ReturnType<typeof import("@nexus/db")>>["db"];
  let ingestedEvents: Awaited<ReturnType<typeof import("@nexus/db/schema")>>["ingestedEvents"];
  let signals: Awaited<ReturnType<typeof import("@nexus/db/schema")>>["signals"];
  let DrizzleEventSource: (typeof import("../../src/workers/drizzle-adapters.js"))["DrizzleEventSource"];
  let DrizzleSignalSink: (typeof import("../../src/workers/drizzle-adapters.js"))["DrizzleSignalSink"];
  let SignalProcessor: (typeof import("@nexus/pipeline-signal"))["SignalProcessor"];
  let eq: (typeof import("drizzle-orm"))["eq"];

  const insertedEventIds: string[] = [];
  const insertedSignalIds: string[] = [];

  beforeAll(async () => {
    ({ db } = await import("@nexus/db"));
    ({ ingestedEvents, signals } = await import("@nexus/db/schema"));
    ({ DrizzleEventSource, DrizzleSignalSink } =
      await import("../../src/workers/drizzle-adapters.js"));
    ({ SignalProcessor } = await import("@nexus/pipeline-signal"));
    ({ eq } = await import("drizzle-orm"));
  });

  afterAll(async () => {
    // Clean up test rows so the DB stays tidy between runs
    for (const id of insertedSignalIds) {
      await db
        .delete(signals)
        .where(eq(signals.id, id))
        .catch(() => undefined);
    }
    for (const id of insertedEventIds) {
      await db
        .delete(ingestedEvents)
        .where(eq(ingestedEvents.id, id))
        .catch(() => undefined);
    }
  });

  it("inserts an ingested_event and reads it back via DrizzleEventSource", async () => {
    const id = randomUUID();
    insertedEventIds.push(id);

    await db.insert(ingestedEvents).values({
      id,
      source: "github",
      eventType: "pr.opened",
      payload: { title: "E2E test PR" },
    });

    const source = new DrizzleEventSource();
    const unprocessed = await source.getUnprocessed(100);
    const found = unprocessed.find((e) => e.id === id);

    expect(found).toBeDefined();
    expect(found?.source).toBe("github");
    expect(found?.eventType).toBe("pr.opened");
  });

  it("full pipeline: event → SignalProcessor → signal created in DB", async () => {
    const eventId = randomUUID();
    insertedEventIds.push(eventId);

    // Insert a raw event
    await db.insert(ingestedEvents).values({
      id: eventId,
      source: "github",
      eventType: "pr.review_requested",
      payload: { title: "E2E review requested", pr_number: 99 },
    });

    const source = new DrizzleEventSource();
    const sink = new DrizzleSignalSink();

    const processor = new SignalProcessor({
      eventSource: source,
      signalSink: sink,
      batchSize: 50,
    });

    const result = await processor.processOnce();

    // At least one event was processed (our event)
    expect(result.processed).toBeGreaterThanOrEqual(1);
    expect(result.errors).toBe(0);

    // The signal we created should appear in the result
    const ourSignal = result.signals.find((s) => s.sourceEventIds.includes(eventId));
    expect(ourSignal).toBeDefined();
    expect(ourSignal?.signalType).toBe("code.review-required");
    expect(ourSignal?.priority).toBe("high");

    // Track for cleanup
    for (const s of result.signals) {
      insertedSignalIds.push(s.id);
    }

    // The event should now be marked as processed
    const rows = await db.select().from(ingestedEvents).where(eq(ingestedEvents.id, eventId));
    expect(rows[0]?.processedAt).not.toBeNull();
  });

  it("DrizzleSignalSink.create persists a signal row", async () => {
    const sink = new DrizzleSignalSink();
    const created = await sink.create({
      signalType: "email.action-required",
      sourceEventIds: [],
      summary: "E2E sink test",
      priority: "high",
      metadata: { tags: ["e2e"] },
    });

    insertedSignalIds.push(created.id);

    // Verify it's actually in the DB
    const rows = await db.select().from(signals).where(eq(signals.id, created.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.signalType).toBe("email.action-required");
    expect(rows[0]?.priority).toBe("high");
  });
});
