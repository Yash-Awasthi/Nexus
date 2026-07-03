// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  HoldbackBuffer,
  ToolJsonRepair,
  ContinuationSuffix,
  RetryStrategy,
  StreamRetryHandler,
  EmittedSseTracker,
  StreamRecoveryOrchestrator,
  DEFAULT_RETRY_STRATEGY,
  DEFAULT_CONTINUATION_SUFFIXES,
} from "../src/index.js";

// ── HoldbackBuffer ─────────────────────────────────────────────────────────

describe("HoldbackBuffer", () => {
  it("drain returns nothing before holdMs", () => {
    const buf = new HoldbackBuffer({ holdMs: 60_000 });
    buf.push("a");
    expect(buf.drain()).toHaveLength(0);
  });

  it("drain returns items past holdMs", () => {
    const buf = new HoldbackBuffer({ holdMs: 0 });
    buf.push("a");
    buf.push("b");
    const items = buf.drain();
    expect(items).toEqual(["a", "b"]);
  });

  it("flush returns all items immediately", () => {
    const buf = new HoldbackBuffer({ holdMs: 60_000 });
    buf.push("x");
    buf.push("y");
    expect(buf.flush()).toEqual(["x", "y"]);
    expect(buf.size()).toBe(0);
  });

  it("size reflects queued items", () => {
    const buf = new HoldbackBuffer({ holdMs: 60_000 });
    buf.push("a");
    buf.push("b");
    expect(buf.size()).toBe(2);
    buf.flush();
    expect(buf.size()).toBe(0);
  });

  it("setHoldMs updates delay", () => {
    const buf = new HoldbackBuffer({ holdMs: 60_000 });
    buf.setHoldMs(0);
    buf.push("now");
    expect(buf.drain()).toEqual(["now"]);
  });

  it("partial drain leaves items not yet ready", () => {
    const buf = new HoldbackBuffer({ holdMs: 60_000 });
    buf.push("early");
    // Simulate: push another item, then drain with a fake "now" that's past for the first
    const early = buf["queue"][0]!;
    early.heldAt = Date.now() - 70_000; // make it look old
    buf.push("recent");
    const drained = buf.drain();
    expect(drained).toContain("early");
    expect(drained).not.toContain("recent");
  });
});

// ── ToolJsonRepair ─────────────────────────────────────────────────────────

describe("ToolJsonRepair", () => {
  const repair = new ToolJsonRepair();

  it("valid JSON returns unchanged", () => {
    const r = repair.repair('{"a":1}');
    expect(r.wasRepaired).toBe(false);
    expect(r.repaired).toBe('{"a":1}');
  });

  it("repairs missing closing brace", () => {
    const r = repair.repair('{"name":"test"');
    expect(r.wasRepaired).toBe(true);
    expect(() => JSON.parse(r.repaired)).not.toThrow();
  });

  it("repairs missing closing bracket", () => {
    const r = repair.repair("[1,2,3");
    expect(r.wasRepaired).toBe(true);
    expect(() => JSON.parse(r.repaired)).not.toThrow();
  });

  it("repairs nested structure", () => {
    const r = repair.repair('{"data":{"items":[1,2');
    expect(r.wasRepaired).toBe(true);
    expect(() => JSON.parse(r.repaired)).not.toThrow();
  });

  it("repairs unclosed string", () => {
    const r = repair.repair('{"name":"hello');
    expect(r.wasRepaired).toBe(true);
    const parsed = JSON.parse(r.repaired);
    expect(parsed.name).toBe("hello");
  });

  it("valid nested object not repaired", () => {
    const r = repair.repair('{"a":{"b":1}}');
    expect(r.wasRepaired).toBe(false);
  });
});

// ── ContinuationSuffix ─────────────────────────────────────────────────────

describe("ContinuationSuffix", () => {
  const cs = new ContinuationSuffix();

  it("inject appends suffix for plain mode", () => {
    const result = cs.inject("partial", "plain");
    expect(result).toBe("partial" + DEFAULT_CONTINUATION_SUFFIXES["plain"]);
  });

  it("inject appends suffix for markdown mode", () => {
    const result = cs.inject("text", "markdown");
    expect(result).toContain("text");
    expect(result).toContain("continuing");
  });

  it("getSuffix returns suffix for mode", () => {
    expect(cs.getSuffix("plain")).toBe(DEFAULT_CONTINUATION_SUFFIXES["plain"]);
  });

  it("falls back to plain for unknown mode", () => {
    expect(cs.inject("text", "unknown")).toContain(DEFAULT_CONTINUATION_SUFFIXES["plain"]!);
  });

  it("custom suffixes are used", () => {
    const custom = new ContinuationSuffix({ plain: "... [truncated]" });
    expect(custom.inject("text", "plain")).toBe("text... [truncated]");
  });
});

// ── RetryStrategy ──────────────────────────────────────────────────────────

describe("RetryStrategy", () => {
  it("delayFor increases with attempt", () => {
    const s = new RetryStrategy({ maxAttempts: 5, initialDelayMs: 100 });
    expect(s.delayFor(1)).toBeGreaterThan(s.delayFor(0));
    expect(s.delayFor(2)).toBeGreaterThan(s.delayFor(1));
  });

  it("delay is capped at maxDelayMs", () => {
    const s = new RetryStrategy({ maxAttempts: 10, initialDelayMs: 1000, maxDelayMs: 2000 });
    expect(s.delayFor(10)).toBeLessThanOrEqual(2000);
  });

  it("shouldRetry is false at maxAttempts", () => {
    const s = new RetryStrategy({ maxAttempts: 3, initialDelayMs: 10 });
    expect(s.shouldRetry(0)).toBe(true);
    expect(s.shouldRetry(2)).toBe(true);
    expect(s.shouldRetry(3)).toBe(false);
  });

  it("DEFAULT_RETRY_STRATEGY has 5 max attempts", () => {
    expect(DEFAULT_RETRY_STRATEGY.maxAttempts).toBe(5);
  });
});

// ── StreamRetryHandler ─────────────────────────────────────────────────────

describe("StreamRetryHandler", () => {
  async function* success(): AsyncIterable<string> {
    yield "a";
    yield "b";
  }

  async function* failOnce(callCount: { n: number }): AsyncIterable<string> {
    callCount.n++;
    if (callCount.n < 2) throw new Error("fail");
    yield "ok";
  }

  async function* alwaysFails(): AsyncIterable<string> {
    throw new Error("always fails");
  }

  const noop = async () => {};

  it("collects values from successful stream", async () => {
    const handler = new StreamRetryHandler<string>();
    const result = await handler.collect(() => success(), noop);
    expect(result.succeeded).toBe(true);
    expect(result.values).toEqual(["a", "b"]);
  });

  it("retries on failure and succeeds", async () => {
    const handler = new StreamRetryHandler<string>(
      new RetryStrategy({ maxAttempts: 3, initialDelayMs: 0 }),
    );
    const call = { n: 0 };
    const result = await handler.collect(() => failOnce(call), noop);
    expect(result.succeeded).toBe(true);
    expect(result.attempts).toBeGreaterThan(1);
  });

  it("returns failed result after maxAttempts", async () => {
    const handler = new StreamRetryHandler<string>(
      new RetryStrategy({ maxAttempts: 2, initialDelayMs: 0 }),
    );
    const result = await handler.collect(() => alwaysFails(), noop);
    expect(result.succeeded).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ── EmittedSseTracker ──────────────────────────────────────────────────────

describe("EmittedSseTracker", () => {
  it("open and hasOpen works", () => {
    const tracker = new EmittedSseTracker();
    tracker.open({ id: "blk-1", type: "block", openedAt: Date.now() });
    expect(tracker.hasOpen("blk-1")).toBe(true);
  });

  it("close removes block and records event", () => {
    const tracker = new EmittedSseTracker();
    tracker.open({ id: "blk-1", type: "block", openedAt: Date.now() });
    tracker.close("blk-1", "end");
    expect(tracker.hasOpen("blk-1")).toBe(false);
    expect(tracker.closeEvents).toHaveLength(1);
    expect(tracker.closeEvents[0]!.reason).toBe("end");
  });

  it("closeAll closes all open blocks", () => {
    const tracker = new EmittedSseTracker();
    tracker.open({ id: "a", type: "block", openedAt: Date.now() });
    tracker.open({ id: "b", type: "updateBlock", openedAt: Date.now() });
    const events = tracker.closeAll("error");
    expect(events).toHaveLength(2);
    expect(tracker.openCount()).toBe(0);
  });

  it("closeAll with reason=error marks events correctly", () => {
    const tracker = new EmittedSseTracker();
    tracker.open({ id: "x", type: "researchComplete", openedAt: Date.now() });
    const events = tracker.closeAll("error");
    expect(events[0]!.reason).toBe("error");
  });

  it("close on unknown id is no-op", () => {
    const tracker = new EmittedSseTracker();
    expect(() => tracker.close("nonexistent", "end")).not.toThrow();
  });

  it("clear resets all state", () => {
    const tracker = new EmittedSseTracker();
    tracker.open({ id: "a", type: "block", openedAt: Date.now() });
    tracker.close("a", "end");
    tracker.clear();
    expect(tracker.openCount()).toBe(0);
    expect(tracker.closeEvents).toHaveLength(0);
  });

  it("getOpen returns all open blocks", () => {
    const tracker = new EmittedSseTracker();
    tracker.open({ id: "a", type: "block", openedAt: 0 });
    tracker.open({ id: "b", type: "block", openedAt: 0 });
    expect(tracker.getOpen()).toHaveLength(2);
  });
});

// ── StreamRecoveryOrchestrator ─────────────────────────────────────────────

describe("StreamRecoveryOrchestrator", () => {
  it("creates all sub-components", () => {
    const orc = new StreamRecoveryOrchestrator();
    expect(orc.holdback).toBeDefined();
    expect(orc.jsonRepair).toBeDefined();
    expect(orc.continuation).toBeDefined();
    expect(orc.retryHandler).toBeDefined();
    expect(orc.sseTracker).toBeDefined();
  });

  it("handleError closes open blocks and injects continuation", () => {
    const orc = new StreamRecoveryOrchestrator();
    orc.sseTracker.open({ id: "b1", type: "block", openedAt: Date.now() });
    orc.sseTracker.open({ id: "b2", type: "block", openedAt: Date.now() });
    const { text, closedBlocks } = orc.handleError("partial text", "plain");
    expect(closedBlocks).toHaveLength(2);
    expect(text).toContain("partial text");
    expect(text.length).toBeGreaterThan("partial text".length);
  });

  it("handleError with no open blocks returns text + continuation", () => {
    const orc = new StreamRecoveryOrchestrator();
    const { text, closedBlocks } = orc.handleError("some text");
    expect(closedBlocks).toHaveLength(0);
    expect(text).toContain("some text");
  });
});
