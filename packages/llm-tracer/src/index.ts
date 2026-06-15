// SPDX-License-Identifier: Apache-2.0
/**
 * llm-tracer — Per-call span tracing seam for every LLM call and tool dispatch.
 *
 * Design:
 *   • When disabled (default) all entry points are zero-cost no-ops — no allocations.
 *   • When enabled, nested spans form a tree: root → llm-span → tool-span children.
 *   • Spans are immutable once ended; the Tracer collects them for export.
 *
 * Provides:
 *   • Span / SpanContext   — a single timed unit of work
 *   • Tracer               — span factory + in-memory span store
 *   • traceFlow            — wrap an async function in a root span
 *   • startLlmSpan         — start a child span for an LLM completion call
 *   • startToolSpan        — start a child span for a tool dispatch
 *   • NoopTracer           — zero-cost disabled tracer (implements same interface)
 *   • globalTracer()       — get / set the process-level tracer
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type SpanStatus = "ok" | "error" | "unset";
/** Span kind type alias. */
export type SpanKind = "root" | "llm" | "tool" | "internal";

/** Span attributes interface definition. */
export type SpanAttributes = Record<string, string | number | boolean | undefined>;

/** Span event interface definition. */
export interface SpanEvent {
  name: string;
  timestampMs: number;
  attributes?: SpanAttributes;
}

/** Span context interface definition. */
export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

/** Span interface definition. */
export interface Span {
  context: SpanContext;
  name: string;
  kind: SpanKind;
  startTimeMs: number;
  endTimeMs?: number;
  durationMs?: number;
  status: SpanStatus;
  attributes: SpanAttributes;
  events: SpanEvent[];
  error?: string;
}

/** End span options interface definition. */
export interface EndSpanOptions {
  status?: SpanStatus;
  error?: string | Error;
  attributes?: SpanAttributes;
}

// ── ID util ───────────────────────────────────────────────────────────────────

let _spanSeq = 0;
let _traceSeq = 0;

function generateId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(++_spanSeq).toString(36)}`;
}

function generateTraceId(): string {
  return `trace-${Date.now().toString(36)}-${(++_traceSeq).toString(36)}`;
}

// ── ActiveSpan ────────────────────────────────────────────────────────────────

/** Mutable handle returned when a span is started. */
export class ActiveSpan {
  private _span: Span;
  private _ended = false;
  private _onEnd: (span: Span) => void;

  constructor(span: Span, onEnd: (span: Span) => void) {
    this._span = span;
    this._onEnd = onEnd;
  }

  get context(): SpanContext {
    return this._span.context;
  }
  get name(): string {
    return this._span.name;
  }
  get isEnded(): boolean {
    return this._ended;
  }

  setAttribute(key: string, value: string | number | boolean): this {
    if (!this._ended) this._span.attributes[key] = value;
    return this;
  }

  setAttributes(attrs: SpanAttributes): this {
    if (!this._ended) Object.assign(this._span.attributes, attrs);
    return this;
  }

  addEvent(name: string, attributes?: SpanAttributes): this {
    if (!this._ended) {
      this._span.events.push({ name, timestampMs: Date.now(), attributes });
    }
    return this;
  }

  end(opts: EndSpanOptions = {}): Span {
    if (this._ended) return this._span;
    this._ended = true;
    const endTimeMs = Date.now();
    this._span.endTimeMs = endTimeMs;
    this._span.durationMs = endTimeMs - this._span.startTimeMs;
    this._span.status = opts.status ?? "ok";
    if (opts.error) {
      this._span.status = "error";
      this._span.error = opts.error instanceof Error ? opts.error.message : opts.error;
    }
    if (opts.attributes) Object.assign(this._span.attributes, opts.attributes);
    this._onEnd(this._span);
    return this._span;
  }

  snapshot(): Span {
    return {
      ...this._span,
      attributes: { ...this._span.attributes },
      events: [...this._span.events],
    };
  }
}

// ── Tracer ────────────────────────────────────────────────────────────────────

export interface TracerOptions {
  enabled?: boolean;
  maxSpans?: number;
  serviceName?: string;
}

/** I tracer interface definition. */
export interface ITracer {
  enabled: boolean;
  startSpan(name: string, kind: SpanKind, parentContext?: SpanContext): ActiveSpan;
  getSpans(): Span[];
  clearSpans(): void;
}

/** Tracer. */
export class Tracer implements ITracer {
  enabled: boolean;
  private spans: Span[] = [];
  private maxSpans: number;
  readonly serviceName: string;

  constructor(opts: TracerOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.maxSpans = opts.maxSpans ?? 10_000;
    this.serviceName = opts.serviceName ?? "nexus";
  }

  startSpan(name: string, kind: SpanKind = "internal", parentContext?: SpanContext): ActiveSpan {
    const traceId = parentContext?.traceId ?? generateTraceId();
    const spanId = generateId("sp");
    const span: Span = {
      context: { traceId, spanId, parentSpanId: parentContext?.spanId },
      name,
      kind,
      startTimeMs: Date.now(),
      status: "unset",
      attributes: {},
      events: [],
    };
    return new ActiveSpan(span, (s) => {
      if (this.spans.length < this.maxSpans) this.spans.push(s);
    });
  }

  getSpans(): Span[] {
    return [...this.spans];
  }

  getSpansByName(name: string): Span[] {
    return this.spans.filter((s) => s.name === name);
  }

  getSpansByKind(kind: SpanKind): Span[] {
    return this.spans.filter((s) => s.kind === kind);
  }

  getTrace(traceId: string): Span[] {
    return this.spans.filter((s) => s.context.traceId === traceId);
  }

  clearSpans(): void {
    this.spans = [];
  }

  spanCount(): number {
    return this.spans.length;
  }
}

// ── NoopTracer ────────────────────────────────────────────────────────────────

class NoopActiveSpan extends ActiveSpan {
  constructor() {
    super(
      {
        context: { traceId: "noop", spanId: "noop" },
        name: "noop",
        kind: "internal",
        startTimeMs: 0,
        status: "ok",
        attributes: {},
        events: [],
      },
      () => {},
    );
  }
  override setAttribute(): this {
    return this;
  }
  override setAttributes(): this {
    return this;
  }
  override addEvent(): this {
    return this;
  }
  override end(): Span {
    return {
      context: { traceId: "noop", spanId: "noop" },
      name: "noop",
      kind: "internal",
      startTimeMs: 0,
      endTimeMs: 0,
      durationMs: 0,
      status: "ok",
      attributes: {},
      events: [],
    };
  }
}

/** Noop tracer. */
export class NoopTracer implements ITracer {
  enabled = false;
  private static _noop = new NoopActiveSpan();

  startSpan(_name: string, _kind?: SpanKind, _parent?: SpanContext): ActiveSpan {
    return NoopTracer._noop;
  }
  getSpans(): Span[] {
    return [];
  }
  clearSpans(): void {}
}

// ── Global tracer ─────────────────────────────────────────────────────────────

let _global: ITracer = new NoopTracer();

/** Get tracer. */
export function getTracer(): ITracer {
  return _global;
}
/** Set tracer. */
export function setTracer(t: ITracer): void {
  _global = t;
}
/** Enable tracing. */
export function enableTracing(opts?: TracerOptions): Tracer {
  const t = new Tracer({ enabled: true, ...opts });
  _global = t;
  return t;
}
/** Disable tracing. */
export function disableTracing(): void {
  _global = new NoopTracer();
}

// ── High-level span helpers ───────────────────────────────────────────────────

/** Wrap an async function in a root span. Returns span + result. */
export async function traceFlow<T>(
  name: string,
  fn: (span: ActiveSpan) => Promise<T>,
  tracer: ITracer = _global,
): Promise<{ result: T; span: Span }> {
  const active = tracer.startSpan(name, "root");
  try {
    const result = await fn(active);
    const span = active.end({ status: "ok" });
    return { result, span };
  } catch (err) {
    const span = active.end({ status: "error", error: err instanceof Error ? err : String(err) });
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { _span: span });
  }
}

/** Llm span options interface definition. */
export interface LlmSpanOptions {
  model: string;
  provider: string;
  promptTokens?: number;
  maxTokens?: number;
  temperature?: number;
  parentContext?: SpanContext;
}

/** Start an LLM completion child span. */
export function startLlmSpan(opts: LlmSpanOptions, tracer: ITracer = _global): ActiveSpan {
  const span = tracer.startSpan(`llm.${opts.provider}.${opts.model}`, "llm", opts.parentContext);
  span.setAttributes({
    "llm.model": opts.model,
    "llm.provider": opts.provider,
    ...(opts.promptTokens !== undefined && { "llm.prompt_tokens": opts.promptTokens }),
    ...(opts.maxTokens !== undefined && { "llm.max_tokens": opts.maxTokens }),
    ...(opts.temperature !== undefined && { "llm.temperature": opts.temperature }),
  });
  return span;
}

/** Tool span options interface definition. */
export interface ToolSpanOptions {
  toolName: string;
  input?: Record<string, unknown>;
  parentContext?: SpanContext;
}

/** Start a tool dispatch child span. */
export function startToolSpan(opts: ToolSpanOptions, tracer: ITracer = _global): ActiveSpan {
  const span = tracer.startSpan(`tool.${opts.toolName}`, "tool", opts.parentContext);
  span.setAttribute("tool.name", opts.toolName);
  if (opts.input) {
    try {
      span.setAttribute("tool.input_json", JSON.stringify(opts.input).slice(0, 512));
    } catch { /* noop */ }
  }
  return span;
}

/** Record completion tokens on an already-started LLM span. */
export function recordLlmCompletion(
  span: ActiveSpan,
  completionTokens: number,
  totalTokens?: number,
): void {
  span.setAttribute("llm.completion_tokens", completionTokens);
  if (totalTokens !== undefined) span.setAttribute("llm.total_tokens", totalTokens);
  span.addEvent("llm.completion_received", { "llm.completion_tokens": completionTokens });
}
