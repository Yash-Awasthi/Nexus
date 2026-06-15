// SPDX-License-Identifier: Apache-2.0
/**
 * obs-providers — Observation generation providers.
 *
 * Specialized for summarizing conversation context into structured observations,
 * distinct from generic LLM chat completion drivers.
 *
 * Provides:
 *   • ObservationEvent     — session event fed into the observation prompt
 *   • ObservationResult    — generated observation or privacy-skip signal
 *   • ErrorClass           — auth_invalid | quota_exceeded | rate_limited | etc.
 *   • buildServerGenerationPrompt() — standard prompt builder
 *   • ObservationProvider  — base interface
 *   • ClaudeObservationProvider    — Claude-backed provider
 *   • GeminiObservationProvider    — Gemini-backed provider
 *   • OpenRouterObservationProvider — OpenRouter multi-model provider
 *   • MockObservationProvider      — injectable test double
 *   • ProviderRegistry             — named provider registry
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type EventRole = "user" | "assistant" | "system" | "tool";
/** Error class type alias. */
export type ErrorClass =
  | "auth_invalid"
  | "quota_exceeded"
  | "rate_limited"
  | "context_too_long"
  | "content_filtered"
  | "provider_error"
  | "timeout"
  | "unknown";

/** Observation event interface definition. */
export interface ObservationEvent {
  role: EventRole;
  content: string;
  timestamp?: string;
  isPrivate?: boolean;
}

/** Observation skip reason type alias. */
export type ObservationSkipReason = "all_events_private" | "no_content" | "filtered";

/** Observation result interface definition. */
export interface ObservationResult {
  observation: string | null;          // null = skip (see skipReason)
  skipReason?: ObservationSkipReason;
  skipXml?: string;                    // <skip_summary reason="…"/>
  provider: string;
  model: string;
  tokensUsed?: number;
  durationMs: number;
  error?: string;
  errorClass?: ErrorClass;
}

/** Generation request interface definition. */
export interface GenerationRequest {
  sessionId: string;
  events: ObservationEvent[];
  locale?: string;
  maxTokens?: number;
  context?: Record<string, unknown>;
}

// ── buildServerGenerationPrompt ───────────────────────────────────────────────

export const GENERATION_SYSTEM_PROMPT = `You are an observation synthesizer. Your task is to generate a concise, structured observation that summarizes the key information, intent, and outcomes of a conversation session.

Guidelines:
- Extract factual content only — no interpretation or judgment
- Be concise: 2–4 sentences maximum
- Focus on: user intent, key entities mentioned, decisions made, outcomes
- If all events are private or there is no substantive content, output: <skip_summary reason="all_events_private"/>
- Output observation text only — no preamble, no JSON`;

/** Build server generation prompt. */
export function buildServerGenerationPrompt(
  events: ObservationEvent[],
  sessionId: string,
  locale = "en-US",
): string {
  const publicEvents = events.filter((e) => !e.isPrivate);

  if (publicEvents.length === 0) {
    return `Session: ${sessionId}\nLocale: ${locale}\n\nAll events in this session are marked private. Output: <skip_summary reason="all_events_private"/>`;
  }

  const transcript = publicEvents
    .map((e) => `[${e.role.toUpperCase()}] ${e.content}`)
    .join("\n");

  return `Session: ${sessionId}\nLocale: ${locale}\n\nConversation transcript:\n${transcript}\n\nGenerate a concise observation:`;
}

// ── ObservationProvider interface ─────────────────────────────────────────────

export interface ObservationProvider {
  name: string;
  model: string;
  generate(request: GenerationRequest): Promise<ObservationResult>;
}

// ── Error classification ──────────────────────────────────────────────────────

export function classifyError(message: string): ErrorClass {
  const msg = message.toLowerCase();
  if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("api key")) return "auth_invalid";
  if (msg.includes("429") || msg.includes("rate limit")) return "rate_limited";
  if (msg.includes("quota") || msg.includes("billing") || msg.includes("credits")) return "quota_exceeded";
  if (msg.includes("context length") || msg.includes("too long") || msg.includes("token")) return "context_too_long";
  if (msg.includes("content") || msg.includes("filter") || msg.includes("policy")) return "content_filtered";
  if (msg.includes("timeout") || msg.includes("timed out")) return "timeout";
  return "unknown";
}

// ── parseSkipTag ──────────────────────────────────────────────────────────────

export function parseSkipTag(text: string): ObservationSkipReason | null {
  const match = text.match(/<skip_summary\s+reason="([^"]+)"\s*\/>/);
  if (!match) return null;
  const reason = match[1] as ObservationSkipReason;
  return reason;
}

// ── BaseObservationProvider ───────────────────────────────────────────────────

abstract class BaseObservationProvider implements ObservationProvider {
  abstract name: string;
  abstract model: string;

  protected abstract callLlm(prompt: string, systemPrompt: string, maxTokens: number): Promise<string>;

  async generate(request: GenerationRequest): Promise<ObservationResult> {
    const t0 = Date.now();
    const prompt = buildServerGenerationPrompt(request.events, request.sessionId, request.locale);
    const maxTokens = request.maxTokens ?? 256;

    try {
      const text = await this.callLlm(prompt, GENERATION_SYSTEM_PROMPT, maxTokens);
      const skipReason = parseSkipTag(text);

      if (skipReason) {
        return {
          observation: null,
          skipReason,
          skipXml: `<skip_summary reason="${skipReason}"/>`,
          provider: this.name,
          model: this.model,
          durationMs: Date.now() - t0,
        };
      }

      return {
        observation: text.trim(),
        provider: this.name,
        model: this.model,
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        observation: null,
        provider: this.name,
        model: this.model,
        durationMs: Date.now() - t0,
        error: message,
        errorClass: classifyError(message),
      };
    }
  }
}

// ── ClaudeObservationProvider ─────────────────────────────────────────────────

export type LlmCallFn = (prompt: string, systemPrompt: string, maxTokens: number) => Promise<string>;

/** Claude observation provider. */
export class ClaudeObservationProvider extends BaseObservationProvider {
  readonly name = "claude";
  model: string;
  private callFn: LlmCallFn;

  constructor(callFn: LlmCallFn, model = "claude-opus-4-5") {
    super();
    this.callFn = callFn;
    this.model = model;
  }

  protected callLlm(prompt: string, system: string, maxTokens: number): Promise<string> {
    return this.callFn(prompt, system, maxTokens);
  }
}

// ── GeminiObservationProvider ─────────────────────────────────────────────────

export class GeminiObservationProvider extends BaseObservationProvider {
  readonly name = "gemini";
  model: string;
  private callFn: LlmCallFn;

  constructor(callFn: LlmCallFn, model = "gemini-2.0-flash") {
    super();
    this.callFn = callFn;
    this.model = model;
  }

  protected callLlm(prompt: string, system: string, maxTokens: number): Promise<string> {
    return this.callFn(prompt, system, maxTokens);
  }
}

// ── OpenRouterObservationProvider ─────────────────────────────────────────────

export class OpenRouterObservationProvider extends BaseObservationProvider {
  readonly name = "openrouter";
  model: string;
  private callFn: LlmCallFn;

  constructor(callFn: LlmCallFn, model = "meta-llama/llama-3.1-70b-instruct") {
    super();
    this.callFn = callFn;
    this.model = model;
  }

  protected callLlm(prompt: string, system: string, maxTokens: number): Promise<string> {
    return this.callFn(prompt, system, maxTokens);
  }
}

// ── MockObservationProvider ───────────────────────────────────────────────────

export interface MockProviderBehavior {
  observation?: string;
  skipReason?: ObservationSkipReason;
  throws?: string;
  delayMs?: number;
}

/** Mock observation provider. */
export class MockObservationProvider implements ObservationProvider {
  readonly name: string;
  readonly model: string;
  private behavior: MockProviderBehavior;
  readonly calls: GenerationRequest[] = [];

  constructor(name = "mock", model = "mock-model", behavior: MockProviderBehavior = {}) {
    this.name = name;
    this.model = model;
    this.behavior = behavior;
  }

  setBehavior(b: MockProviderBehavior): void { this.behavior = b; }

  async generate(request: GenerationRequest): Promise<ObservationResult> {
    const t0 = Date.now();
    this.calls.push(request);
    if (this.behavior.delayMs) await new Promise((r) => setTimeout(r, this.behavior.delayMs));

    if (this.behavior.throws) {
      const msg = this.behavior.throws;
      return {
        observation: null,
        provider: this.name,
        model: this.model,
        durationMs: Date.now() - t0,
        error: msg,
        errorClass: classifyError(msg),
      };
    }

    if (this.behavior.skipReason) {
      return {
        observation: null,
        skipReason: this.behavior.skipReason,
        skipXml: `<skip_summary reason="${this.behavior.skipReason}"/>`,
        provider: this.name,
        model: this.model,
        durationMs: Date.now() - t0,
      };
    }

    return {
      observation: this.behavior.observation ?? "Mock observation.",
      provider: this.name,
      model: this.model,
      durationMs: Date.now() - t0,
    };
  }
}

// ── ProviderRegistry ──────────────────────────────────────────────────────────

export class ProviderRegistry {
  private providers = new Map<string, ObservationProvider>();

  register(provider: ObservationProvider): this {
    this.providers.set(provider.name, provider);
    return this;
  }

  get(name: string): ObservationProvider | undefined { return this.providers.get(name); }
  has(name: string): boolean { return this.providers.has(name); }
  list(): ObservationProvider[] { return [...this.providers.values()]; }
  names(): string[] { return [...this.providers.keys()]; }
  unregister(name: string): boolean { return this.providers.delete(name); }

  /** Generate with first available provider, falling back to next on error. */
  async generateWithFallback(request: GenerationRequest): Promise<ObservationResult> {
    for (const provider of this.providers.values()) {
      const result = await provider.generate(request);
      if (!result.errorClass) return result; // success or skip
    }
    return {
      observation: null,
      provider: "registry",
      model: "none",
      durationMs: 0,
      error: "All providers failed",
      errorClass: "provider_error",
    };
  }
}

// ── LlmObservationProvider ────────────────────────────────────────────────────
//
// LLM-backed provider that extracts structured observations from session events.
// Unlike ClaudeObservationProvider (single-sentence summary), this provider
// asks the LLM to return a JSON array of {type, subject, detail, confidence}
// observations — suitable for the knowledge-graph ingestion pipeline.
//
// Wire via NEXUS_OBSERVATION_DRIVER env var:
//   NEXUS_OBSERVATION_DRIVER=groq/llama-3.3-70b
//
// Falls back to empty observation (not an error) when the LLM returns
// unparseable JSON — ensuring the pipeline never hard-fails.

export interface StructuredObservation {
  type: string;       // e.g. "preference", "decision", "entity", "action"
  subject: string;    // what/who the observation is about
  detail: string;     // supporting sentence
  confidence: number; // 0–1
}

/** Llm observation provider options interface definition. */
export interface LlmObservationProviderOptions {
  /** Model identifier, e.g. "groq/llama-3.3-70b" or "claude/claude-opus-4-5". */
  model?: string;
  /** Max observations to extract per session (default: 5). */
  maxObservations?: number;
  /** Injectable LLM call function. */
  callFn: LlmCallFn;
}

const STRUCTURED_SYSTEM_PROMPT = `You are an observation extractor. Given conversation events, extract 1-5 structured observations.

Return ONLY a JSON array — no preamble, no markdown, no explanation.
Each item: { "type": string, "subject": string, "detail": string, "confidence": number }
Types: preference | decision | entity | action | fact
Confidence: 0.0–1.0

If there is no substantive content, return an empty array: []`;

/** Llm observation provider. */
export class LlmObservationProvider implements ObservationProvider {
  readonly name = "llm-structured";
  readonly model: string;
  private callFn: LlmCallFn;
  private maxObservations: number;

  constructor(opts: LlmObservationProviderOptions) {
    this.model = opts.model ?? process.env.NEXUS_OBSERVATION_DRIVER ?? "groq/llama-3.3-70b";
    this.callFn = opts.callFn;
    this.maxObservations = opts.maxObservations ?? 5;
  }

  async generate(request: GenerationRequest): Promise<ObservationResult> {
    const t0 = Date.now();
    const publicEvents = request.events.filter((e) => !e.isPrivate);

    if (publicEvents.length === 0) {
      return {
        observation: null,
        skipReason: "all_events_private",
        skipXml: `<skip_summary reason="all_events_private"/>`,
        provider: this.name,
        model: this.model,
        durationMs: Date.now() - t0,
      };
    }

    const transcript = publicEvents
      .map((e) => `[${e.role.toUpperCase()}] ${e.content}`)
      .join("\n");

    const prompt = `Session: ${request.sessionId}\n\nConversation:\n${transcript}\n\nExtract up to ${this.maxObservations} observations as a JSON array:`;

    try {
      const raw = await this.callFn(prompt, STRUCTURED_SYSTEM_PROMPT, 512);

      let observations: StructuredObservation[] = [];
      try {
        // Strip markdown code fences if present
        const cleaned = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
          observations = (parsed as StructuredObservation[]).slice(0, this.maxObservations);
        }
      } catch {
        // Unparseable JSON → treat as empty (not an error)
      }

      if (observations.length === 0) {
        return {
          observation: null,
          skipReason: "no_content",
          provider: this.name,
          model: this.model,
          durationMs: Date.now() - t0,
        };
      }

      // Serialise structured observations into the single `observation` string
      // (preserves ObservationResult contract; callers can JSON.parse this back)
      return {
        observation: JSON.stringify(observations),
        provider: this.name,
        model: this.model,
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        observation: null,
        provider: this.name,
        model: this.model,
        durationMs: Date.now() - t0,
        error: message,
        errorClass: classifyError(message),
      };
    }
  }
}
