// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Tracer,
  NoopTracer,
  ActiveSpan,
  traceFlow,
  startLlmSpan,
  startToolSpan,
  recordLlmCompletion,
  enableTracing,
  disableTracing,
  getTracer,
  setTracer,
  type SpanContext,
} from "../src/index.js";

// ── Tracer ────────────────────────────────────────────────────────────────────

describe("Tracer", () => {
  let tracer: Tracer;

  beforeEach(() => {
    tracer = new Tracer({ enabled: true });
  });

  it("starts a span with correct fields", () => {
    const span = tracer.startSpan("test.op", "internal");
    expect(span.name).toBe("test.op");
    expect(span.context.traceId).toBeTruthy();
    expect(span.context.spanId).toBeTruthy();
    expect(span.isEnded).toBe(false);
  });

  it("ends a span and records timing", () => {
    const active = tracer.startSpan("test.op");
    const ended = active.end();
    expect(ended.status).toBe("ok");
    expect(ended.endTimeMs).toBeDefined();
    expect(ended.durationMs).toBeGreaterThanOrEqual(0);
    expect(active.isEnded).toBe(true);
  });

  it("records span in store after end", () => {
    const active = tracer.startSpan("my.span", "llm");
    active.end();
    expect(tracer.spanCount()).toBe(1);
    expect(tracer.getSpans()[0]!.name).toBe("my.span");
  });

  it("getSpansByName filters correctly", () => {
    tracer.startSpan("a.op").end();
    tracer.startSpan("b.op").end();
    tracer.startSpan("a.op").end();
    expect(tracer.getSpansByName("a.op")).toHaveLength(2);
    expect(tracer.getSpansByName("b.op")).toHaveLength(1);
  });

  it("getSpansByKind filters by kind", () => {
    tracer.startSpan("llm.call", "llm").end();
    tracer.startSpan("tool.call", "tool").end();
    tracer.startSpan("internal.op", "internal").end();
    expect(tracer.getSpansByKind("llm")).toHaveLength(1);
    expect(tracer.getSpansByKind("tool")).toHaveLength(1);
  });

  it("parent-child spans share traceId", () => {
    const root = tracer.startSpan("root", "root");
    const child = tracer.startSpan("child", "llm", root.context);
    expect(child.context.traceId).toBe(root.context.traceId);
    expect(child.context.parentSpanId).toBe(root.context.spanId);
    root.end();
    child.end();
  });

  it("getTrace returns all spans for a traceId", () => {
    const root = tracer.startSpan("root", "root");
    tracer.startSpan("c1", "llm", root.context).end();
    tracer.startSpan("c2", "tool", root.context).end();
    root.end();
    const trace = tracer.getTrace(root.context.traceId);
    expect(trace).toHaveLength(3);
  });

  it("clearSpans empties the store", () => {
    tracer.startSpan("x").end();
    tracer.clearSpans();
    expect(tracer.spanCount()).toBe(0);
  });

  it("end is idempotent — second call is no-op", () => {
    const active = tracer.startSpan("x");
    const s1 = active.end({ status: "ok" });
    const s2 = active.end({ status: "error" });
    // second call returns same object without re-ending
    expect(tracer.spanCount()).toBe(1);
    expect(s1.status).toBe("ok");
  });

  it("setAttribute / setAttributes work before end", () => {
    const active = tracer.startSpan("x");
    active.setAttribute("k1", "v1").setAttributes({ k2: 42, k3: true });
    const span = active.end();
    expect(span.attributes["k1"]).toBe("v1");
    expect(span.attributes["k2"]).toBe(42);
    expect(span.attributes["k3"]).toBe(true);
  });

  it("addEvent records event with timestamp", () => {
    const active = tracer.startSpan("x");
    active.addEvent("my.event", { detail: "abc" });
    const span = active.end();
    expect(span.events).toHaveLength(1);
    expect(span.events[0]!.name).toBe("my.event");
    expect(span.events[0]!.timestampMs).toBeGreaterThan(0);
  });

  it("end with error sets status=error and records message", () => {
    const active = tracer.startSpan("x");
    const span = active.end({ error: new Error("something broke") });
    expect(span.status).toBe("error");
    expect(span.error).toBe("something broke");
  });

  it("end with error string works too", () => {
    const active = tracer.startSpan("x");
    const span = active.end({ error: "plain string error" });
    expect(span.error).toBe("plain string error");
  });

  it("snapshot returns a copy without ending span", () => {
    const active = tracer.startSpan("x");
    active.setAttribute("k", "v");
    const snap = active.snapshot();
    expect(snap.attributes["k"]).toBe("v");
    expect(active.isEnded).toBe(false);
  });

  it("respects maxSpans cap", () => {
    const t = new Tracer({ maxSpans: 3 });
    for (let i = 0; i < 10; i++) t.startSpan(`s${i}`).end();
    expect(t.spanCount()).toBe(3);
  });
});

// ── NoopTracer ────────────────────────────────────────────────────────────────

describe("NoopTracer", () => {
  const noop = new NoopTracer();

  it("enabled is false", () => {
    expect(noop.enabled).toBe(false);
  });

  it("startSpan returns an ActiveSpan-like object", () => {
    const span = noop.startSpan("anything", "llm");
    expect(span).toBeDefined();
    const ended = span.end();
    expect(ended).toBeDefined();
  });

  it("setAttribute / addEvent are no-ops (no throw)", () => {
    const span = noop.startSpan("x");
    expect(() => span.setAttribute("k", "v")).not.toThrow();
    expect(() => span.addEvent("e")).not.toThrow();
    span.end();
  });

  it("getSpans returns empty array", () => {
    noop.startSpan("x").end();
    expect(noop.getSpans()).toHaveLength(0);
  });
});

// ── traceFlow ─────────────────────────────────────────────────────────────────

describe("traceFlow", () => {
  it("wraps async fn in a root span", async () => {
    const tracer = new Tracer();
    const { result, span } = await traceFlow(
      "my.flow",
      async (s) => {
        s.setAttribute("step", 1);
        return 42;
      },
      tracer,
    );
    expect(result).toBe(42);
    expect(span.kind).toBe("root");
    expect(span.status).toBe("ok");
    expect(span.durationMs).toBeGreaterThanOrEqual(0);
    expect(tracer.spanCount()).toBe(1);
  });

  it("marks span error when fn throws", async () => {
    const tracer = new Tracer();
    await expect(
      traceFlow(
        "bad.flow",
        async () => {
          throw new Error("boom");
        },
        tracer,
      ),
    ).rejects.toThrow("boom");
    expect(tracer.getSpans()[0]!.status).toBe("error");
    expect(tracer.getSpans()[0]!.error).toBe("boom");
  });

  it("passes active span so children can reference traceId", async () => {
    const tracer = new Tracer();
    let childCtx: SpanContext | undefined;
    await traceFlow(
      "root.flow",
      async (rootSpan) => {
        const child = tracer.startSpan("child", "llm", rootSpan.context);
        childCtx = child.context;
        child.end();
      },
      tracer,
    );
    expect(childCtx?.traceId).toBe(tracer.getSpans()[0]!.context.traceId);
  });
});

// ── startLlmSpan ──────────────────────────────────────────────────────────────

describe("startLlmSpan", () => {
  it("creates an llm-kind span with model/provider attrs", () => {
    const tracer = new Tracer();
    const span = startLlmSpan({ model: "gpt-4o", provider: "openai", promptTokens: 100 }, tracer);
    span.end();
    const recorded = tracer.getSpans()[0]!;
    expect(recorded.kind).toBe("llm");
    expect(recorded.name).toBe("llm.openai.gpt-4o");
    expect(recorded.attributes["llm.model"]).toBe("gpt-4o");
    expect(recorded.attributes["llm.provider"]).toBe("openai");
    expect(recorded.attributes["llm.prompt_tokens"]).toBe(100);
  });

  it("attaches to parent context when provided", () => {
    const tracer = new Tracer();
    const root = tracer.startSpan("root", "root");
    const llm = startLlmSpan({ model: "m", provider: "p", parentContext: root.context }, tracer);
    llm.end();
    root.end();
    const spans = tracer.getTrace(root.context.traceId);
    expect(spans).toHaveLength(2);
  });

  it("recordLlmCompletion adds tokens and event", () => {
    const tracer = new Tracer();
    const span = startLlmSpan({ model: "m", provider: "p" }, tracer);
    recordLlmCompletion(span, 150, 250);
    const ended = span.end();
    expect(ended.attributes["llm.completion_tokens"]).toBe(150);
    expect(ended.attributes["llm.total_tokens"]).toBe(250);
    expect(ended.events.some((e) => e.name === "llm.completion_received")).toBe(true);
  });
});

// ── startToolSpan ─────────────────────────────────────────────────────────────

describe("startToolSpan", () => {
  it("creates a tool-kind span", () => {
    const tracer = new Tracer();
    const span = startToolSpan({ toolName: "search", input: { query: "test" } }, tracer);
    span.end();
    const recorded = tracer.getSpans()[0]!;
    expect(recorded.kind).toBe("tool");
    expect(recorded.name).toBe("tool.search");
    expect(recorded.attributes["tool.name"]).toBe("search");
    expect(recorded.attributes["tool.input_json"]).toContain("query");
  });

  it("works without input", () => {
    const tracer = new Tracer();
    const span = startToolSpan({ toolName: "noop" }, tracer);
    expect(() => span.end()).not.toThrow();
  });
});

// ── Global tracer API ─────────────────────────────────────────────────────────

describe("Global tracer", () => {
  afterEach(() => {
    disableTracing();
  });

  it("starts as NoopTracer (disabled)", () => {
    disableTracing();
    expect(getTracer().enabled).toBe(false);
  });

  it("enableTracing sets a live Tracer", () => {
    const t = enableTracing({ serviceName: "test-svc" });
    expect(getTracer().enabled).toBe(true);
    expect(getTracer()).toBe(t);
  });

  it("disableTracing restores noop", () => {
    enableTracing();
    disableTracing();
    expect(getTracer().enabled).toBe(false);
  });

  it("setTracer allows custom tracer", () => {
    const custom = new Tracer();
    setTracer(custom);
    expect(getTracer()).toBe(custom);
  });

  it("startLlmSpan uses global tracer when none passed", () => {
    const t = enableTracing();
    const span = startLlmSpan({ model: "m", provider: "p" });
    span.end();
    expect(t.spanCount()).toBe(1);
  });
});
