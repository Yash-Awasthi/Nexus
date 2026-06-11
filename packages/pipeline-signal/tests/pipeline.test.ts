// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SignalClassifier } from "../src/classifier.js";
import {
  SignalProcessor,
  MemoryEventSource,
  MemorySignalSink,
  type RawEvent,
} from "../src/processor.js";

function makeEvent(overrides?: Partial<RawEvent>): RawEvent {
  return {
    id: crypto.randomUUID(),
    source: "github",
    eventType: "pr.opened",
    payload: { title: "Add feature X", number: 42 },
    createdAt: new Date(),
    ...overrides,
  };
}

// ── SignalClassifier ──────────────────────────────────────────────────────────

describe("SignalClassifier", () => {
  const clf = new SignalClassifier();

  it("classifies github PR as code.review-required", () => {
    const r = clf.classify({ source: "github", eventType: "pr.opened", payload: { title: "Fix bug" } });
    expect(r.signalType).toBe("code.review-required");
    expect(r.tags).toContain("github");
  });

  it("marks github security alerts as critical", () => {
    const r = clf.classify({ source: "github", eventType: "vulnerability_alert", payload: {} });
    expect(r.priority).toBe("critical");
    expect(r.signalType).toBe("security.vulnerability-detected");
  });

  it("classifies action-required gmail as high priority", () => {
    const r = clf.classify({
      source: "gmail",
      eventType: "email.received",
      payload: { subject: "Action Required: approve invoice" },
    });
    expect(r.priority).toBe("high");
    expect(r.signalType).toBe("email.action-required");
  });

  it("classifies regular gmail as low priority email.received", () => {
    const r = clf.classify({
      source: "gmail",
      eventType: "email.received",
      payload: { subject: "Weekly newsletter", from: "news@example.com" },
    });
    expect(r.signalType).toBe("email.received");
    expect(r.priority).toBe("low");
  });

  it("falls back to general.event for unknown source", () => {
    const r = clf.classify({ source: "unknown-service", eventType: "some.event", payload: {} });
    expect(r.signalType).toBe("general.event");
    expect(r.priority).toBe("medium");
  });

  it("custom rules run before built-ins", () => {
    const custom = new SignalClassifier();
    custom.registerRule({
      name: "custom.override",
      matches: (i) => i.source === "github",
      classify: () => ({ signalType: "custom.type", priority: "low", summary: "custom", tags: [] }),
    });
    const r = custom.classify({ source: "github", eventType: "pr.opened", payload: {} });
    expect(r.signalType).toBe("custom.type");
  });

  it("classifies linear issues", () => {
    const r = clf.classify({ source: "linear", eventType: "issue.assigned", payload: { title: "Fix login bug" } });
    expect(r.signalType).toBe("task.assigned");
  });
});

// ── SignalProcessor ───────────────────────────────────────────────────────────

describe("SignalProcessor", () => {
  let source: MemoryEventSource;
  let sink: MemorySignalSink;
  let processor: SignalProcessor;

  beforeEach(() => {
    source = new MemoryEventSource();
    sink = new MemorySignalSink();
    processor = new SignalProcessor({ eventSource: source, signalSink: sink });
  });

  it("returns zero counts when no events queued", async () => {
    const result = await processor.processOnce();
    expect(result.processed).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.signals).toHaveLength(0);
  });

  it("processes a single event into a signal", async () => {
    source.seed(makeEvent());
    const result = await processor.processOnce();
    expect(result.processed).toBe(1);
    expect(sink.signals).toHaveLength(1);
  });

  it("marks event as processed after creating signal", async () => {
    const event = makeEvent();
    source.seed(event);
    await processor.processOnce();
    expect(source.getEvent(event.id)?.processed).toBe(true);
  });

  it("does not reprocess already-processed events", async () => {
    source.seed(makeEvent());
    await processor.processOnce();
    await processor.processOnce();
    expect(sink.signals).toHaveLength(1); // still 1, not 2
  });

  it("links signal to its source event id", async () => {
    const event = makeEvent();
    source.seed(event);
    await processor.processOnce();
    expect(sink.signals[0]?.sourceEventIds).toContain(event.id);
  });

  it("processes multiple events in one batch", async () => {
    for (let i = 0; i < 5; i++) source.seed(makeEvent({ id: crypto.randomUUID() }));
    const result = await processor.processOnce();
    expect(result.processed).toBe(5);
    expect(sink.signals).toHaveLength(5);
  });

  it("publishes nexus.signals.created event for each signal", async () => {
    const bus = { publish: vi.fn().mockResolvedValue(undefined) };
    const proc = new SignalProcessor({ eventSource: source, signalSink: sink, eventBus: bus });
    source.seed(makeEvent());
    await proc.processOnce();
    expect(bus.publish).toHaveBeenCalledWith("nexus.signals.created", expect.objectContaining({
      signal_type: expect.any(String),
    }));
  });

  it("continues processing remaining events when one fails", async () => {
    const badSink: typeof sink = {
      signals: [],
      create: vi.fn()
        .mockRejectedValueOnce(new Error("DB error"))
        .mockImplementation(sink.create.bind(sink)),
    };
    const errors: string[] = [];
    const proc = new SignalProcessor({
      eventSource: source,
      signalSink: badSink,
      onError: (e) => errors.push(e.message),
    });

    source.seed(makeEvent({ id: "bad-event" }));
    source.seed(makeEvent({ id: "good-event" }));

    const result = await proc.processOnce();
    expect(result.errors).toBe(1);
    expect(result.processed).toBe(1);
    expect(errors).toContain("DB error");
  });
});
