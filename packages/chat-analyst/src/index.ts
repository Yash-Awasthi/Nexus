// SPDX-License-Identifier: Apache-2.0
/**
 * chat-analyst — Streaming SSE analyst edge function.
 *
 * Context assembly → domain-focused system prompt → streaming SSE →
 * in-app action events (open_panel, set_view) → geo context → rate-limit.
 *
 * Provides:
 *   • AnalystEventType   — typed SSE event names
 *   • AnalystEvent       — typed SSE payload union
 *   • InAppAction        — open_panel | set_view | navigate | highlight
 *   • DomainSystemPrompt — per-domain focused system prompts
 *   • ContextAssembler   — builds context from messages + geo + domain data
 *   • RateLimiter        — per-session token bucket
 *   • StreamingAnalyst   — orchestrates streaming lifecycle
 *   • AnalystSession     — session wrapper with state
 *   • AnalystSessionManager — named session registry
 */

// ── Analyst event types ───────────────────────────────────────────────────────

export type AnalystEventType =
  | "stream_start"
  | "stream_chunk"
  | "stream_end"
  | "in_app_action"
  | "error"
  | "rate_limited";

/** In app action type type alias. */
export type InAppActionType = "open_panel" | "set_view" | "navigate" | "highlight";

/** In app action interface definition. */
export interface InAppAction {
  action: InAppActionType;
  target?: string;
  params?: Record<string, unknown>;
}

/** Stream start event interface definition. */
export interface StreamStartEvent {
  type: "stream_start";
  sessionId: string;
  domain: string;
  timestamp: string;
}

/** Stream chunk event interface definition. */
export interface StreamChunkEvent {
  type: "stream_chunk";
  sessionId: string;
  chunk: string;
  index: number;
}

/** Stream end event interface definition. */
export interface StreamEndEvent {
  type: "stream_end";
  sessionId: string;
  totalTokens: number;
  durationMs: number;
}

/** In app action event interface definition. */
export interface InAppActionEvent {
  type: "in_app_action";
  sessionId: string;
  action: InAppAction;
}

/** Error event interface definition. */
export interface ErrorEvent {
  type: "error";
  sessionId: string;
  code: string;
  message: string;
}

/** Rate limited event interface definition. */
export interface RateLimitedEvent {
  type: "rate_limited";
  sessionId: string;
  retryAfterMs: number;
}

/** Analyst event type alias. */
export type AnalystEvent =
  | StreamStartEvent
  | StreamChunkEvent
  | StreamEndEvent
  | InAppActionEvent
  | ErrorEvent
  | RateLimitedEvent;

// ── Domain system prompts ─────────────────────────────────────────────────────

export type AnalystDomain =
  | "aviation"
  | "climate"
  | "conflict"
  | "economic"
  | "cyber"
  | "health"
  | "maritime"
  | "geopolitical"
  | "general";

/** Domain system prompt. */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class DomainSystemPrompt {
  private static readonly PROMPTS: Record<AnalystDomain, string> = {
    aviation:
      "You are an aviation intelligence analyst. Focus on flight safety, airspace incidents, NOTAM analysis, and civil aviation trends. Provide structured analysis with risk assessments.",
    climate:
      "You are a climate intelligence analyst. Focus on extreme weather events, climate patterns, environmental risks, and their geopolitical implications. Reference meteorological data when available.",
    conflict:
      "You are a conflict intelligence analyst. Provide objective assessment of military operations, territorial changes, humanitarian impacts, and escalation risks. Maintain analytical neutrality.",
    economic:
      "You are an economic intelligence analyst. Focus on market indicators, supply chain disruptions, sanctions impacts, currency movements, and macroeconomic trends.",
    cyber:
      "You are a cybersecurity intelligence analyst. Analyze threat actor activity, vulnerability trends, incident attribution, and defensive recommendations. Use MITRE ATT&CK framework terminology.",
    health:
      "You are a global health intelligence analyst. Monitor disease outbreaks, health system stress indicators, pharmaceutical supply chains, and public health policy impacts.",
    maritime:
      "You are a maritime intelligence analyst. Track shipping lane disruptions, piracy incidents, port congestion, and maritime security events.",
    geopolitical:
      "You are a geopolitical intelligence analyst. Provide analysis of state actor behavior, alliance dynamics, sanctions regimes, and regional stability assessments.",
    general:
      "You are an intelligence analyst with broad expertise. Provide clear, objective analysis backed by available evidence. Structure your response with key findings, supporting evidence, and confidence levels.",
  };

  static get(domain: AnalystDomain): string {
    return this.PROMPTS[domain] ?? this.PROMPTS.general;
  }

  static list(): AnalystDomain[] {
    return Object.keys(this.PROMPTS) as AnalystDomain[];
  }
}

// ── GeoContext ────────────────────────────────────────────────────────────────

export interface GeoContext {
  countryCode?: string;
  locale?: string;
  timezone?: string;
  region?: string;
}

// ── ContextAssembler ──────────────────────────────────────────────────────────

export interface ContextMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Assembled context interface definition. */
export interface AssembledContext {
  systemPrompt: string;
  messages: ContextMessage[];
  tokenEstimate: number;
}

/** Context assembler. */
export class ContextAssembler {
  private maxHistoryMessages: number;

  constructor(maxHistoryMessages = 10) {
    this.maxHistoryMessages = maxHistoryMessages;
  }

  assemble(
    domain: AnalystDomain,
    messages: ContextMessage[],
    domainData?: Record<string, unknown>,
    geo?: GeoContext,
  ): AssembledContext {
    let systemPrompt = DomainSystemPrompt.get(domain);

    // Inject geo context if available
    if (geo?.region) {
      systemPrompt += ` You are addressing a user in the ${geo.region} region.`;
    }
    if (geo?.timezone) {
      systemPrompt += ` Local timezone: ${geo.timezone}.`;
    }

    // Inject domain data summary if available
    if (domainData && Object.keys(domainData).length > 0) {
      const summary = Object.entries(domainData)
        .slice(0, 5)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join("; ");
      systemPrompt += `\n\nCurrent domain context: ${summary}`;
    }

    const trimmed = messages.slice(-this.maxHistoryMessages);
    const tokenEstimate = Math.ceil(
      (systemPrompt.length + trimmed.reduce((s, m) => s + m.content.length, 0)) / 4,
    );

    return { systemPrompt, messages: trimmed, tokenEstimate };
  }
}

// ── RateLimiter ───────────────────────────────────────────────────────────────

export interface RateLimiterOptions {
  requestsPerMinute: number;
  windowMs?: number;
}

/** Rate limiter. */
export class RateLimiter {
  private windows = new Map<string, number[]>();
  private requestsPerMinute: number;
  private windowMs: number;

  constructor(opts: RateLimiterOptions) {
    this.requestsPerMinute = opts.requestsPerMinute;
    this.windowMs = opts.windowMs ?? 60_000;
  }

  /** Returns { allowed, retryAfterMs }. */
  check(sessionId: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const timestamps = (this.windows.get(sessionId) ?? []).filter((t) => t > windowStart);

    if (timestamps.length >= this.requestsPerMinute) {
      const oldest = timestamps[0]!;
      const retryAfterMs = oldest + this.windowMs - now;
      return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs) };
    }

    timestamps.push(now);
    this.windows.set(sessionId, timestamps);
    return { allowed: true, retryAfterMs: 0 };
  }

  reset(sessionId: string): void {
    this.windows.delete(sessionId);
  }
  clear(): void {
    this.windows.clear();
  }
}

// ── StreamingLlmFn ────────────────────────────────────────────────────────────

export type StreamingLlmFn = (
  systemPrompt: string,
  messages: ContextMessage[],
) => AsyncIterable<string>;

// ── InAppActionExtractor ──────────────────────────────────────────────────────

/**
 * Extracts in-app action directives from streamed text.
 * Syntax: [ACTION:type target param=val param2=val2]
 */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class InAppActionExtractor {
  static extract(text: string): InAppAction[] {
    if (text.length > 100_000) return [];
    const actions: InAppAction[] = [];
    const regex = /\[ACTION:(\w+)(?:\s+([^\s\]]+))?([^\]]*)\]/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const [, actionType, target, paramsStr] = match;
      const params: Record<string, string> = {};
      if (paramsStr) {
        for (const pair of paramsStr.trim().split(/\s+/)) {
          const [k, v] = pair.split("=");
          if (k && v) params[k] = v;
        }
      }
      actions.push({
        action: (actionType ?? "open_panel") as InAppActionType,
        ...(target ? { target } : {}),
        ...(Object.keys(params).length > 0 ? { params } : {}),
      });
    }
    return actions;
  }

  static strip(text: string): string {
    return text
      .replace(/\[ACTION:[^\]]+\]/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
}

// ── StreamingAnalyst ──────────────────────────────────────────────────────────

export interface StreamingAnalystOptions {
  llm: StreamingLlmFn;
  rateLimiter?: RateLimiter;
  assembler?: ContextAssembler;
}

/** Streaming analyst. */
export class StreamingAnalyst {
  private llm: StreamingLlmFn;
  private rateLimiter?: RateLimiter;
  private assembler: ContextAssembler;

  constructor(opts: StreamingAnalystOptions) {
    this.llm = opts.llm;
    this.rateLimiter = opts.rateLimiter;
    this.assembler = opts.assembler ?? new ContextAssembler();
  }

  async *stream(
    sessionId: string,
    domain: AnalystDomain,
    messages: ContextMessage[],
    opts: { domainData?: Record<string, unknown>; geo?: GeoContext } = {},
  ): AsyncIterable<AnalystEvent> {
    // Rate limit check
    if (this.rateLimiter) {
      const { allowed, retryAfterMs } = this.rateLimiter.check(sessionId);
      if (!allowed) {
        yield { type: "rate_limited", sessionId, retryAfterMs };
        return;
      }
    }

    const ctx = this.assembler.assemble(domain, messages, opts.domainData, opts.geo);
    const t0 = Date.now();
    let totalTokens = ctx.tokenEstimate;
    let index = 0;

    yield { type: "stream_start", sessionId, domain, timestamp: new Date().toISOString() };

    try {
      for await (const chunk of this.llm(ctx.systemPrompt, ctx.messages)) {
        // Extract and emit any in-app actions embedded in chunk
        const actions = InAppActionExtractor.extract(chunk);
        for (const action of actions) {
          yield { type: "in_app_action", sessionId, action };
        }

        const cleanChunk = InAppActionExtractor.strip(chunk);
        if (cleanChunk) {
          yield { type: "stream_chunk", sessionId, chunk: cleanChunk, index: index++ };
          totalTokens += Math.ceil(cleanChunk.length / 4);
        }
      }

      yield { type: "stream_end", sessionId, totalTokens, durationMs: Date.now() - t0 };
    } catch (err) {
      yield {
        type: "error",
        sessionId,
        code: "stream_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ── AnalystSession ────────────────────────────────────────────────────────────

let _aSeq = 0;

/** Analyst session. */
export class AnalystSession {
  readonly id: string;
  readonly domain: AnalystDomain;
  private history: ContextMessage[] = [];
  private analyst: StreamingAnalyst;
  readonly createdAt: string;

  constructor(domain: AnalystDomain, analyst: StreamingAnalyst) {
    this.id = `analyst-${++_aSeq}`;
    this.domain = domain;
    this.analyst = analyst;
    this.createdAt = new Date().toISOString();
  }

  addMessage(role: ContextMessage["role"], content: string): void {
    this.history.push({ role, content });
  }

  getHistory(): ContextMessage[] {
    return [...this.history];
  }

  async *ask(
    userMessage: string,
    opts: { domainData?: Record<string, unknown>; geo?: GeoContext } = {},
  ): AsyncIterable<AnalystEvent> {
    this.addMessage("user", userMessage);
    const chunks: string[] = [];

    for await (const event of this.analyst.stream(this.id, this.domain, this.history, opts)) {
      if (event.type === "stream_chunk") chunks.push(event.chunk);
      yield event;
    }

    if (chunks.length > 0) {
      this.addMessage("assistant", chunks.join(""));
    }
  }
}

// ── AnalystSessionManager ─────────────────────────────────────────────────────

export class AnalystSessionManager {
  private sessions = new Map<string, AnalystSession>();
  private analyst: StreamingAnalyst;

  constructor(analyst: StreamingAnalyst) {
    this.analyst = analyst;
  }

  create(domain: AnalystDomain): AnalystSession {
    const session = new AnalystSession(domain, this.analyst);
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): AnalystSession | undefined {
    return this.sessions.get(id);
  }
  has(id: string): boolean {
    return this.sessions.has(id);
  }
  destroy(id: string): boolean {
    return this.sessions.delete(id);
  }
  list(): AnalystSession[] {
    return [...this.sessions.values()];
  }
  count(): number {
    return this.sessions.size;
  }
}
