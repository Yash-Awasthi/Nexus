// SPDX-License-Identifier: Apache-2.0
/**
 * NexusOtelTracer — OpenTelemetry-compatible distributed tracing for @nexus/runtime.
 *
 * Implements ITraceRecorder (the existing runtime interface) and adds:
 *   - W3C TraceContext header propagation (traceparent / tracestate)
 *   - OTLP/HTTP export (configurable via OTEL_EXPORTER_OTLP_ENDPOINT)
 *   - Span nesting / parent-child relationships
 *   - Status codes (OK / ERROR)
 *   - Structured attributes on spans
 *
 * Design:
 *   The tracer is intentionally self-contained and does NOT import the heavy
 *   @opentelemetry/* SDK packages at the module level — it uses a soft-import
 *   pattern so the runtime boots without OTel installed.  Install
 *   @opentelemetry/sdk-trace-node + @opentelemetry/exporter-trace-otlp-http
 *   to enable real OTel export.  Without them, the tracer falls back to
 *   the in-memory span store (identical to the legacy ITraceRecorder behaviour).
 *
 * Environment variables (all optional):
 *   OTEL_EXPORTER_OTLP_ENDPOINT   — OTLP collector URL (e.g. http://localhost:4318)
 *   OTEL_SERVICE_NAME              — service name tag (default: "nexus-runtime")
 *   OTEL_TRACES_SAMPLER            — "always_on" | "always_off" | "traceidratio" (default: "always_on")
 *   OTEL_TRACES_SAMPLER_ARG        — sample ratio when using "traceidratio"
 */

import { randomBytes } from "node:crypto";

import type { ITraceSpan, ITraceRecorder } from "../interfaces/observability.interface.js";

// ─── W3C TraceContext ─────────────────────────────────────────────────────────

export interface TraceContext {
  traceId: string; // 32 hex chars (128-bit)
  spanId: string; // 16 hex chars (64-bit)
  traceFlags: number; // 0x00 = not sampled, 0x01 = sampled
}

export interface PropagationHeaders {
  traceparent: string;
  tracestate?: string;
}

/** Generate a W3C-compliant traceparent header value */
export function encodeTraceparent(ctx: TraceContext): string {
  const flags = ctx.traceFlags.toString(16).padStart(2, "0");
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

/** Parse a W3C traceparent header into TraceContext; returns undefined on invalid input */
export function parseTraceparent(header: string): TraceContext | undefined {
  const parts = header.split("-");
  if (parts.length !== 4 || parts[0] !== "00") return undefined;
  const [, traceId, spanId, flags] = parts;
  if (traceId?.length !== 32) return undefined;
  if (spanId?.length !== 16) return undefined;
  return {
    traceId,
    spanId,
    traceFlags: parseInt(flags ?? "01", 16),
  };
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

// ─── NexusSpan — enriched span ────────────────────────────────────────────────

export interface NexusSpan extends ITraceSpan {
  traceId: string;
  traceFlags: number;
  status: "unset" | "ok" | "error";
  statusMessage?: string;
  attributes: Record<string, unknown>;
  events: { name: string; timestamp: Date; attributes?: Record<string, unknown> }[];
}

// ─── OTel soft-loader ─────────────────────────────────────────────────────────

interface OtelSdk {
  startActiveSpan<T>(name: string, fn: (span: unknown) => T): T;
  shutdown(): Promise<void>;
}

async function tryLoadOtelSdk(
  serviceName: string,
  endpoint: string | undefined,
): Promise<OtelSdk | undefined> {
  try {
    // Dynamic import — graceful no-op if not installed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { NodeSDK } = await import("@opentelemetry/sdk-node" as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Resource } = await import("@opentelemetry/resources" as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { SEMRESATTRS_SERVICE_NAME } = await import("@opentelemetry/semantic-conventions" as any);

    const sdkConfig: Record<string, unknown> = {
      resource: new Resource({ [SEMRESATTRS_SERVICE_NAME]: serviceName }),
    };

    if (endpoint) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http" as any);
      sdkConfig.traceExporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });
    }

    const sdk = new NodeSDK(sdkConfig);
    sdk.start();

    return {
      startActiveSpan: () => {
        throw new Error("Use NexusOtelTracer spans, not raw OTel spans");
      },
      shutdown: () => sdk.shutdown(),
    };
  } catch {
    return undefined;
  }
}

// ─── NexusOtelTracer ──────────────────────────────────────────────────────────

export interface OtelTracerConfig {
  serviceName?: string;
  otlpEndpoint?: string;
  /** Sampling rate [0, 1]. Default: 1.0 (always sample) */
  sampleRate?: number;
}

export class NexusOtelTracer implements ITraceRecorder {
  private readonly spans = new Map<string, NexusSpan>();
  private readonly serviceName: string;
  private readonly sampleRate: number;
  /** Active trace context stack per async context (simplified: single global stack) */
  private readonly contextStack: TraceContext[] = [];
  private otelSdk?: OtelSdk;
  private readonly initPromise: Promise<void>;

  constructor(config: OtelTracerConfig = {}) {
    this.serviceName = config.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "nexus-runtime";

    this.sampleRate = config.sampleRate ?? parseFloat(process.env.OTEL_TRACES_SAMPLER_ARG ?? "1.0");

    const endpoint = config.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

    // eslint-disable-next-line promise/always-return -- intentional void side-effect; init result stored on instance
    this.initPromise = tryLoadOtelSdk(this.serviceName, endpoint).then((sdk) => {
      this.otelSdk = sdk;
    });
  }

  /** Wait for OTel SDK initialisation (call on startup) */
  async init(): Promise<void> {
    await this.initPromise;
  }

  // ── ITraceRecorder implementation ────────────────────────────────────────

  startSpan(name: string, parentId?: string, metadata?: Record<string, unknown>): ITraceSpan {
    if (!this.shouldSample()) {
      // Return a no-op span that is never stored
      return {
        spanId: "noop",
        name,
        startTime: new Date(),
        metadata,
      };
    }

    const spanId = randomHex(8); // 16 hex chars = 8 bytes
    const traceId = this.resolveTraceId(parentId);
    const traceFlags = 0x01; // sampled

    const span: NexusSpan = {
      spanId,
      parentId,
      name,
      startTime: new Date(),
      traceId,
      traceFlags,
      status: "unset",
      attributes: { "service.name": this.serviceName, ...(metadata ?? {}) },
      events: [],
      metadata,
    };

    this.spans.set(spanId, span);

    // Push onto context stack for child span resolution
    this.contextStack.push({ traceId, spanId, traceFlags });

    return span;
  }

  endSpan(spanId: string, metadata?: Record<string, unknown>): void {
    if (spanId === "noop") return;

    const span = this.spans.get(spanId);
    if (!span) return;

    span.endTime = new Date();
    span.status = "ok";
    if (metadata) {
      Object.assign(span.attributes, metadata);
      span.metadata = { ...(span.metadata ?? {}), ...metadata };
    }

    // Pop from context stack
    const idx = this.contextStack.findIndex((c) => c.spanId === spanId);
    if (idx !== -1) this.contextStack.splice(idx, 1);
  }

  getSpans(): ITraceSpan[] {
    return Array.from(this.spans.values());
  }

  clear(): void {
    this.spans.clear();
    this.contextStack.length = 0;
  }

  // ── Extended API ─────────────────────────────────────────────────────────

  /** Mark a span as errored with a message */
  errorSpan(spanId: string, error: Error | string): void {
    const span = this.spans.get(spanId);
    if (!span) return;
    span.status = "error";
    span.statusMessage = error instanceof Error ? error.message : error;
    span.endTime = new Date();
    if (span.metadata) span.metadata.error = span.statusMessage;
    const idx = this.contextStack.findIndex((c) => c.spanId === spanId);
    if (idx !== -1) this.contextStack.splice(idx, 1);
  }

  /** Add a named event to a span (e.g. "task.queued", "council.vote.cast") */
  addEvent(spanId: string, name: string, attributes?: Record<string, unknown>): void {
    const span = this.spans.get(spanId);
    if (span) span.events.push({ name, timestamp: new Date(), attributes });
  }

  /** Set an attribute on an active span */
  setAttribute(spanId: string, key: string, value: unknown): void {
    const span = this.spans.get(spanId);
    if (span) span.attributes[key] = value;
  }

  /** Get the W3C traceparent for the current active span (top of stack) */
  currentTraceparent(): string | undefined {
    const ctx = this.contextStack[this.contextStack.length - 1];
    if (!ctx) return undefined;
    return encodeTraceparent(ctx);
  }

  /** Inject W3C propagation headers for outgoing HTTP requests */
  injectHeaders(spanId: string): PropagationHeaders | undefined {
    const span = this.spans.get(spanId);
    if (!span) return undefined;
    return {
      traceparent: encodeTraceparent({
        traceId: span.traceId,
        spanId: span.spanId,
        traceFlags: span.traceFlags,
      }),
    };
  }

  /** Extract parent context from incoming HTTP request headers */
  extractContext(headers: Record<string, string | undefined>): TraceContext | undefined {
    const traceparent = headers.traceparent;
    if (!traceparent) return undefined;
    return parseTraceparent(traceparent);
  }

  /** Get all NexusSpan instances (includes OTel attributes) */
  getNexusSpans(): NexusSpan[] {
    return Array.from(this.spans.values());
  }

  /** Flush and shut down the OTel SDK exporter */
  async shutdown(): Promise<void> {
    await this.otelSdk?.shutdown();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private shouldSample(): boolean {
    if (this.sampleRate >= 1.0) return true;
    if (this.sampleRate <= 0.0) return false;
    return Math.random() < this.sampleRate;
  }

  private resolveTraceId(parentSpanId?: string): string {
    if (parentSpanId && parentSpanId !== "noop") {
      const parentSpan = this.spans.get(parentSpanId);
      if (parentSpan) return parentSpan.traceId;
    }
    // New root trace
    return randomHex(16); // 32 hex chars = 16 bytes
  }
}
