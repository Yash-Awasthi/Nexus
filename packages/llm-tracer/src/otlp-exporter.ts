// SPDX-License-Identifier: Apache-2.0
/**
 * OTLP/HTTP (JSON) trace exporter for {@link Span}s.
 *
 * Closes the observability gap against the Jaeger / Tempo / OpenTelemetry
 * Collector repos in the absorption ledger: @nexus/llm-tracer produced spans
 * in memory only — nothing shipped them to a backend. Jaeger (OTLP receiver),
 * Grafana Tempo and an OpenTelemetry Collector all accept OTLP/HTTP, and the
 * JSON encoding needs no protobuf dependency, so this module exports Nexus
 * spans as an OTLP/JSON `POST /v1/traces` payload via an injectable fetch.
 *
 * Mapping notes (documented, lossy by necessity):
 *   • Nexus trace/span ids are human-readable (`trace-...`, `sp-...`), not
 *     W3C 16-byte hex. They are hashed deterministically into 32-hex traceIds
 *     and 16-hex spanIds so backends accept them; the same Nexus id always
 *     maps to the same OTLP id.
 *   • Nexus kinds (root/internal/tool/llm) map onto OTLP span kinds: llm → 3
 *     (CLIENT, per OTel GenAI conventions: an external model call), everything
 *     else → 1 (INTERNAL).
 *   • Status ok/error/unset map to OTLP codes 1/2/0 (error carries the message).
 *   • ms epoch timestamps are converted to unix-nano (uint64, decimal string).
 */

import type { Span, SpanKind, SpanStatus } from "./index.js";

// ── Deterministic id derivation ───────────────────────────────────────────────

const HEX = "0123456789abcdef";

/** Deterministic hex digest of `input` with exactly `length` chars (FNV mixing). */
function hashToHex(input: string, length: number): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    a ^= input.charCodeAt(i);
    a = Math.imul(a, 0x01000193) >>> 0;
    b ^= input.charCodeAt(input.length - 1 - i);
    b = Math.imul(b, 0x01000193) >>> 0;
  }
  let out = "";
  let x = a >>> 0;
  let y = b >>> 0;
  while (out.length < length) {
    x = (Math.imul(x ^ y, 0x85ebca6b) >>> 0) ^ (x >>> 13);
    y = (Math.imul(y ^ x, 0xc2b2ae35) >>> 0) ^ (y >>> 16);
    out += (HEX[x & 0xf] ?? "") + (HEX[y & 0xf] ?? "");
  }
  return out.slice(0, length);
}

// ── OTLP mapping tables ───────────────────────────────────────────────────────

/** OTLP SpanKind enum values. */
const SPAN_KIND_CODE: Record<SpanKind, number> = { root: 1, internal: 1, tool: 1, llm: 3 };

const STATUS_CODE: Record<SpanStatus, number> = { unset: 0, ok: 1, error: 2 };

// ── OTLP/JSON payload types (the subset we emit) ──────────────────────────────

interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
}

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpKeyValue[];
  status?: { code: number; message?: string };
  events?: { timeUnixNano: string; name: string; attributes?: OtlpKeyValue[] }[];
}

export interface OtlpJsonPayload {
  resourceSpans: {
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: { scope: { name: string; version?: string }; spans: OtlpSpan[] }[];
  }[];
}

// ── Attribute / value conversion ──────────────────────────────────────────────

function anyValue(value: string | number | boolean): OtlpAnyValue {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: value };
}

function keyValues(
  attributes: Record<string, string | number | boolean | undefined>,
): OtlpKeyValue[] {
  const out: OtlpKeyValue[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) out.push({ key, value: anyValue(value) });
  }
  return out;
}

function toNano(epochMs: number): string {
  return String(BigInt(Math.round(epochMs)) * 1_000_000n);
}

// ── Span → OTLP ───────────────────────────────────────────────────────────────

/** Convert one Nexus span into the OTLP/JSON span object. */
export function spanToOtlpSpan(span: Span): OtlpSpan {
  const endMs = span.endTimeMs ?? span.startTimeMs + (span.durationMs ?? 0);
  const otlp: OtlpSpan = {
    traceId: hashToHex(span.context.traceId, 32),
    spanId: hashToHex(span.context.spanId, 16),
    name: span.name,
    kind: SPAN_KIND_CODE[span.kind] ?? 1,
    startTimeUnixNano: toNano(span.startTimeMs),
    endTimeUnixNano: toNano(Math.max(endMs, span.startTimeMs)),
    attributes: keyValues(span.attributes),
  };
  if (span.context.parentSpanId) {
    otlp.parentSpanId = hashToHex(span.context.parentSpanId, 16);
  }
  const code = STATUS_CODE[span.status] ?? 0;
  if (span.status === "error") {
    otlp.status = { code, message: span.error ?? "error" };
  } else if (code !== 0) {
    otlp.status = { code };
  }
  if (span.events.length > 0) {
    otlp.events = span.events.map((e) => ({
      timeUnixNano: toNano(e.timestampMs),
      name: e.name,
      ...(e.attributes ? { attributes: keyValues(e.attributes) } : {}),
    }));
  }
  return otlp;
}

// ── Payload assembly ──────────────────────────────────────────────────────────

/** Build the full OTLP/JSON traces payload object for a batch of spans. */
export function buildOtlpPayload(spans: Span[], serviceName = "nexus"): OtlpJsonPayload {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
        scopeSpans: [
          {
            scope: { name: "@nexus/llm-tracer", version: "0.1.0" },
            spans: spans.map(spanToOtlpSpan),
          },
        ],
      },
    ],
  };
}

/** Serialize the OTLP/JSON traces payload. */
export function buildOtlpJsonPayload(spans: Span[], serviceName = "nexus"): string {
  return JSON.stringify(buildOtlpPayload(spans, serviceName));
}

// ── HTTP export ───────────────────────────────────────────────────────────────

export interface OtlpExportResponse {
  ok: boolean;
  status: number;
  text: string;
}

/** Minimal injectable fetch surface (mirrors globalThis.fetch). */
export type OtlpFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface OtlpExporterOptions {
  /** OTLP/HTTP traces endpoint (default http://localhost:4318/v1/traces). */
  endpoint?: string;
  /** Extra request headers (e.g. authorization). Content-Type is always set. */
  headers?: Record<string, string>;
  /** Service name recorded on the resource (default "nexus"). */
  serviceName?: string;
  /** Injectable fetch for tests (default globalThis.fetch). */
  fetch?: OtlpFetchFn;
}

const DEFAULT_ENDPOINT = "http://localhost:4318/v1/traces";

/**
 * Export spans to an OTLP/HTTP (JSON) receiver — OpenTelemetry Collector,
 * Jaeger with the OTLP receiver, or Grafana Tempo.
 */
export async function exportSpansOtlp(
  spans: Span[],
  opts: OtlpExporterOptions = {},
): Promise<OtlpExportResponse> {
  if (spans.length === 0) return { ok: true, status: 0, text: "no spans" };
  const body = buildOtlpJsonPayload(spans, opts.serviceName ?? "nexus");
  const doFetch: OtlpFetchFn =
    opts.fetch ?? ((globalThis as { fetch?: OtlpFetchFn }).fetch as OtlpFetchFn);
  const res = await doFetch(opts.endpoint ?? DEFAULT_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
    body,
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}
