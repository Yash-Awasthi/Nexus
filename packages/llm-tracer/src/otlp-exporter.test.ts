// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  Tracer,
  type Span,
  type OtlpJsonPayload,
  spanToOtlpSpan,
  buildOtlpPayload,
  exportSpansOtlp,
} from "./index.js";

const mkSpan = (over: Partial<Span> = {}): Span => ({
  context: { traceId: "trace-abc-1", spanId: "sp-1", parentSpanId: "sp-0" },
  name: "llm.call",
  kind: "llm",
  startTimeMs: 1_700_000_000_000,
  endTimeMs: 1_700_000_001_500,
  durationMs: 1500,
  status: "ok",
  attributes: { "gen_ai.model": "claude-sonnet-4-5", latency: 1.5 },
  events: [{ name: "tokens", timestampMs: 1_700_000_000_100, attributes: { count: 12 } }],
  ...over,
});

describe("spanToOtlpSpan", () => {
  it("hashes nexus ids into W3C-width hex deterministically", () => {
    const otlp = spanToOtlpSpan(mkSpan());
    expect(otlp.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(otlp.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(otlp.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
    expect(spanToOtlpSpan(mkSpan()).traceId).toBe(otlp.traceId);
  });

  it("maps kind/status/timestamps/attributes", () => {
    const otlp = spanToOtlpSpan(mkSpan());
    expect(otlp.kind).toBe(3); // llm -> CLIENT
    expect(otlp.status).toEqual({ code: 1 });
    expect(otlp.startTimeUnixNano).toBe("1700000000000000000");
    expect(otlp.endTimeUnixNano).toBe("1700000001500000000");
    const attrs = Object.fromEntries(
      (otlp.attributes ?? []).map((a) => [a.key, JSON.stringify(a.value)]),
    );
    expect(attrs["gen_ai.model"]).toBe('{"stringValue":"claude-sonnet-4-5"}');
    expect(attrs["latency"]).toBe('{"doubleValue":1.5}');
  });

  it("maps error status to code 2 with a message", () => {
    const otlp = spanToOtlpSpan(mkSpan({ status: "error", error: "boom" }));
    expect(otlp.status).toEqual({ code: 2, message: "boom" });
  });

  it("skips parent when absent and emits events", () => {
    const otlp = spanToOtlpSpan(
      mkSpan({ context: { traceId: "t", spanId: "s" }, events: [] }),
    );
    expect(otlp.parentSpanId).toBeUndefined();
  });
});

describe("exportSpansOtlp", () => {
  it("POSTs an OTLP/JSON payload with a service resource", async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetchFn = async (
      url: string,
      init: { method: string; headers: Record<string, string>; body: string },
    ) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const tracer = new Tracer({ serviceName: "my-service" });
    const span = tracer.startSpan("llm.call", "llm");
    span.end();

    const res = await exportSpansOtlp(tracer.getSpans(), {
      endpoint: "http://collector:4318/v1/traces",
      serviceName: "my-service",
      fetch: fetchFn,
    });
    expect(res.ok).toBe(true);
    expect(calls[0]?.url).toBe("http://collector:4318/v1/traces");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    const payload = JSON.parse(calls[0]?.body ?? "{}") as OtlpJsonPayload;
    const resourceAttr = payload.resourceSpans[0]?.resource.attributes ?? [];
    expect(resourceAttr).toContainEqual({ key: "service.name", value: { stringValue: "my-service" } });
    const emitted = payload.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
    expect(emitted.length).toBe(1);
    expect(emitted[0]?.name).toBe("llm.call");
  });

  it("returns early for empty span batches", async () => {
    const res = await exportSpansOtlp([], { fetch: async () => ({ ok: true, status: 200, text: async () => "" }) });
    expect(res.status).toBe(0);
  });

  it("carries the error message on failed exports", async () => {
    const res = await exportSpansOtlp([mkSpan()], {
      fetch: async () => ({ ok: false, status: 503, text: async () => "unavailable" }),
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(res.text).toBe("unavailable");
  });
});
