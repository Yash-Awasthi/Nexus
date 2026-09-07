// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import {
  NexusOtelTracer,
  encodeTraceparent,
  parseTraceparent,
} from "../src/tracing/otel-tracer.js";

describe("traceparent helpers", () => {
  it("encodes a valid W3C traceparent", () => {
    const header = encodeTraceparent({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: 1,
    });
    expect(header).toBe(`00-${"a".repeat(32)}-${"b".repeat(16)}-01`);
  });

  it("parses a valid header and rejects malformed ones", () => {
    const valid = parseTraceparent(`00-${"a".repeat(32)}-${"b".repeat(16)}-00`);
    expect(valid).toEqual({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: 0,
    });
    expect(parseTraceparent("00-abc")).toBeUndefined();
    expect(parseTraceparent("01-abc-def-01")).toBeUndefined();
    expect(parseTraceparent(`01-${"a".repeat(32)}-${"b".repeat(16)}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${"c".repeat(31)}-${"b".repeat(16)}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${"a".repeat(32)}-${"c".repeat(15)}-01`)).toBeUndefined();
  });
});

describe("NexusOtelTracer", () => {
  it("records spans with parent-child trace ids", async () => {
    const tracer = new NexusOtelTracer({ serviceName: "svc" });
    await tracer.init();
    const root = tracer.startSpan("root", undefined, { count: 1 });
    const child = tracer.startSpan("child", root.spanId);
    tracer.endSpan(child.spanId, { processed: 2 });
    tracer.endSpan(root.spanId, { status: "ok" });

    const spans = tracer.getSpans();
    expect(spans).toHaveLength(2);
    const childSpan = tracer.getNexusSpans().find((s) => s.spanId === child.spanId)!;
    expect(childSpan.parentId).toBe(root.spanId);
    expect(childSpan.traceId).toBe(tracer.getNexusSpans()[0].traceId);
    expect(childSpan.status).toBe("ok");
    expect(childSpan.attributes).toMatchObject({ processed: 2, "service.name": "svc" });
    expect(childSpan.endTime).toBeDefined();
    expect(tracer.currentTraceparent()).toBeUndefined(); // stack empty after end
  });

  it("supports error marking, events, and attributes", () => {
    const tracer = new NexusOtelTracer({});
    const span = tracer.startSpan("op", undefined, {});
    tracer.addEvent(span.spanId, "task.queued", { queue: "high" });
    tracer.setAttribute(span.spanId, "attempt", 3);
    tracer.errorSpan(span.spanId, new Error("boom"));
    const stored = tracer.getNexusSpans()[0];
    expect(stored.status).toBe("error");
    expect(stored.statusMessage).toBe("boom");
    expect(stored.attributes.attempt).toBe(3);
    expect(stored.events[0].name).toBe("task.queued");
    expect(stored.metadata?.error).toBe("boom");
    // errorSpan removes from the context stack
    expect(tracer.currentTraceparent()).toBeUndefined();
  });

  it("propagates W3C context via inject/extract", () => {
    const tracer = new NexusOtelTracer({});
    const span = tracer.startSpan("http");
    const headers = tracer.injectHeaders(span.spanId)!;
    expect(headers.traceparent).toContain(`00-`);
    expect(headers.traceparent.split("-")).toHaveLength(4);
    expect(tracer.extractContext({ traceparent: headers.traceparent })).toEqual({
      traceId: expect.any(String),
      spanId: span.spanId,
      traceFlags: 1,
    });
    expect(tracer.extractContext({})).toBeUndefined();
    expect(tracer.injectHeaders("missing")).toBeUndefined();
  });

  it("returns a non-sampled noop span when sampling is off", () => {
    const tracer = new NexusOtelTracer({ sampleRate: 0 });
    const span = tracer.startSpan("expensive");
    expect(span.spanId).toBe("noop");
    tracer.endSpan("noop"); // must be a no-op
    expect(tracer.getSpans()).toHaveLength(0);
    expect(tracer.getNexusSpans()).toHaveLength(0);
  });

  it("ignores unknown spans and clears state", () => {
    const tracer = new NexusOtelTracer({});
    tracer.endSpan("ghost");
    tracer.errorSpan("ghost", "x");
    tracer.addEvent("ghost", "e");
    tracer.setAttribute("ghost", "k", 1);
    const span = tracer.startSpan("only");
    expect(tracer.getSpans()).toHaveLength(1);
    tracer.clear();
    expect(tracer.getSpans()).toHaveLength(0);
    expect(tracer.currentTraceparent()).toBeUndefined();
    void span;
  });

  it("reuses the parent trace id for children of the same root", () => {
    const tracer = new NexusOtelTracer({});
    const a = tracer.startSpan("a");
    const b = tracer.startSpan("b", a.spanId);
    const c = tracer.startSpan("c", b.spanId);
    const ids = tracer.getNexusSpans().map((s) => s.traceId);
    expect(new Set(ids).size).toBe(1);
    void c;
  });

  it("shutdown is safe without an OTel SDK", async () => {
    const tracer = new NexusOtelTracer({});
    await tracer.init();
    await expect(tracer.shutdown()).resolves.toBeUndefined();
  });
});
