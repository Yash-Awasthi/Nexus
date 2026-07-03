// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for SignalProcessor polling lifecycle (start / stop / scheduleNext).
 * Uses vi.useFakeTimers so no real I/O is performed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  SignalProcessor,
  MemoryEventSource,
  MemorySignalSink,
  type RawEvent,
} from "../src/processor.js";
import { SignalClassifier } from "../src/classifier.js";

function makeEvent(overrides?: Partial<RawEvent>): RawEvent {
  return {
    id: crypto.randomUUID(),
    source: "github",
    eventType: "pr.opened",
    payload: { title: "Add feature" },
    createdAt: new Date(),
    ...overrides,
  };
}

function buildProcessor(pollIntervalMs = 100) {
  const source = new MemoryEventSource();
  const sink = new MemorySignalSink();
  const classifier = new SignalClassifier();
  const processor = new SignalProcessor({
    eventSource: source,
    signalSink: sink,
    classifier,
    pollIntervalMs,
    batchSize: 5,
  });
  return { source, sink, processor };
}

// ── Polling lifecycle ─────────────────────────────────────────────────────────

describe("SignalProcessor — start / stop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("start() triggers a poll after pollIntervalMs", async () => {
    const { source, sink, processor } = buildProcessor(50);
    source.seed(makeEvent());

    processor.start();
    await vi.advanceTimersByTimeAsync(60);
    processor.stop();

    expect(sink.signals.length).toBeGreaterThan(0);
  });

  it("start() is idempotent — calling twice does not double-poll", async () => {
    const { source, sink, processor } = buildProcessor(50);
    source.seed(makeEvent());

    processor.start();
    processor.start(); // second call should be a no-op
    await vi.advanceTimersByTimeAsync(60);
    processor.stop();

    // At most one signal written — event is consumed after the first poll
    expect(sink.signals.length).toBeLessThanOrEqual(1);
  });

  it("stop() prevents further polling", async () => {
    const { source, sink, processor } = buildProcessor(50);

    processor.start();
    processor.stop();

    source.seed(makeEvent());
    await vi.advanceTimersByTimeAsync(200);

    // No polls ran after stop
    expect(sink.signals.length).toBe(0);
  });

  it("stop() clears the internal timer", async () => {
    const { processor } = buildProcessor(50);
    processor.start();
    processor.stop();
    // Advance well past the interval — should not throw or fire
    await vi.advanceTimersByTimeAsync(300);
  });

  it("polling continues across multiple intervals", async () => {
    const { source, sink, processor } = buildProcessor(50);
    // Push an event that will be consumed on the first tick, then another
    source.seed(makeEvent({ eventType: "issue.opened" }));

    processor.start();
    await vi.advanceTimersByTimeAsync(60); // first poll consumes the event
    source.seed(makeEvent({ eventType: "pr.merged" })); // add another
    await vi.advanceTimersByTimeAsync(60); // second poll should consume it
    processor.stop();

    expect(sink.signals.length).toBeGreaterThanOrEqual(2);
  });
});

// ── processOnce ───────────────────────────────────────────────────────────────

describe("SignalProcessor.processOnce()", () => {
  it("processes available events and returns a result", async () => {
    const { source, processor } = buildProcessor();
    source.seed(makeEvent());
    const result = await processor.processOnce();
    expect(result.processed).toBeGreaterThan(0);
  });

  it("returns skipped count when batch is not full", async () => {
    const { source, processor } = buildProcessor();
    source.seed(makeEvent());
    const result = await processor.processOnce();
    // batchSize=5, only 1 event → 4 skipped
    expect(result.skipped).toBe(4);
  });

  it("returns zero processed when source is empty", async () => {
    const { processor } = buildProcessor();
    const result = await processor.processOnce();
    expect(result.processed).toBe(0);
  });

  it("signals array contains classified results", async () => {
    const { source, processor } = buildProcessor();
    source.seed(makeEvent({ source: "github", eventType: "pr.opened" }));
    const result = await processor.processOnce();
    expect(result.signals.length).toBeGreaterThan(0);
  });
});
