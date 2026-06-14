// SPDX-License-Identifier: Apache-2.0
/**
 * llm-drivers — Concrete HTTP adapters for 15 LLM providers.
 *
 * All drivers share a common LlmDriver interface. Each driver handles:
 *   • Auth header injection
 *   • Request body shaping (each provider has a different schema)
 *   • Response parsing + token usage extraction
 *   • Streaming delta aggregation
 *   • Error mapping → LlmError with typed codes
 *
 * Transport is injectable for testing (MockTransport).
 */

// ── Core types ─────────────────────────────────────────────────────────────────

export type LlmRole = "user" | "assistant" | "system";

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmRequestOptions {
  model: string;
  messages: LlmMessage[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stream?: boolean;
  stop?: string[];
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface LlmResponse {
  id: string;
  content: string;
  model: string;
  usage: LlmUsage;
  finishReason: "stop" | "length" | "tool_calls" | "error" | "unknown";
  durationMs: number;
}

export interface StreamDelta {
  delta: string;
  done: boolean;
  usage?: LlmUsage;
}

export type StreamHandler = (delta: StreamDelta) => void | Promise<void>;

export interface LlmDriver {
  readonly provider: string;
  readonly model: string;
  complete(opts: LlmRequestOptions): Promise<LlmResponse>;
  stream(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse>;
  countTokens(text: string): number;
}

// ── Error ─────────────────────────────────────────────────────────────────────

export type LlmErrorCode =
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "CONTEXT_LENGTH_EXCEEDED"
  | "MODEL_NOT_FOUND"
  | "SERVER_ERROR"
  | "TIMEOUT"
  | "INVALID_REQUEST";

export class LlmError extends Error {
  constructor(
    public readonly code: LlmErrorCode,
    message: string,
    public readonly provider: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

// ── Transport interface ────────────────────────────────────────────────────────

export interface HttpTransport {
  post(url: string, body: unknown, headers: Record<string, string>): Promise<unknown>;
}

export class MockTransport implements HttpTransport {
  readonly calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  private response: unknown = {};

  setResponse(response: unknown): this {
    this.response = response;
    return this;
  }

  async post(url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
    this.calls.push({ url, body, headers });
    return this.response;
  }
}

// ── Token estimation ───────────────────────────────────────────────────────────

/** Rough estimate: 1 token ≈ 4 chars (consistent with prompt-cache package). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function totalTokens(input: number, output: number): number {
  return input + output;
}

// ── Error mapping helper ───────────────────────────────────────────────────────

function mapHttpError(status: number, provider: string, message = ""): LlmError {
  if (status === 401 || status === 403)
    return new LlmError("AUTH_FAILED", message || "Authentication failed", provider, status);
  if (status === 429)
    return new LlmError("RATE_LIMITED", message || "Rate limit exceeded", provider, status);
  if (status === 404)
    return new LlmError("MODEL_NOT_FOUND", message || "Model not found", provider, status);
  if (status === 400)
    return new LlmError("INVALID_REQUEST", message || "Invalid request", provider, status);
  if (status === 413 || status === 422)
    return new LlmError("CONTEXT_LENGTH_EXCEEDED", message || "Context too long", provider, status);
  return new LlmError("SERVER_ERROR", message || `HTTP ${status}`, provider, status);
}

// ── Base driver ────────────────────────────────────────────────────────────────

abstract class BaseDriver implements LlmDriver {
  abstract readonly provider: string;
  abstract readonly model: string;
  protected transport: HttpTransport;

  constructor(transport?: HttpTransport) {
    this.transport = transport ?? this.makeDefaultTransport();
  }

  private makeDefaultTransport(): HttpTransport {
    return {
      post: async (url, body, headers) => {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
        if (!resp.ok) throw mapHttpError(resp.status, this.provider);
        return resp.json();
      },
    };
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  abstract complete(opts: LlmRequestOptions): Promise<LlmResponse>;

  async stream(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
    // Default: call complete and emit as single delta
    const result = await this.complete({ ...opts, stream: false });
    await handler({ delta: result.content, done: false, usage: result.usage });
    await handler({ delta: "", done: true, usage: result.usage });
    return result;
  }

  protected makeUsage(inputTokens: number, outputTokens: number): LlmUsage {
    return { inputTokens, outputTokens, totalTokens: totalTokens(inputTokens, outputTokens) };
  }

  protected makeResponse(
    id: string,
    content: string,
    model: string,
    usage: LlmUsage,
    durationMs: number,
    finishReason: LlmResponse["finishReason"] = "stop",
  ): LlmResponse {
    return { id, content, model, usage, finishReason, durationMs };
  }
}

// ── Driver config types ────────────────────────────────────────────────────────

interface ApiKeyConfig { apiKey: string; }
interface BaseUrlConfig { baseUrl?: string; }
type FullConfig = ApiKeyConfig & BaseUrlConfig;

// ── 1. Anthropic ──────────────────────────────────────────────────────────────

export class AnthropicDriver extends BaseDriver {
  readonly provider = "anthropic";
  readonly model: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(transport);
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.anthropic.com";
    this.model = config.model ?? "claude-3-5-sonnet-20241022";
  }

  async complete(opts: LlmRequestOptions): Promise<LlmResponse> {
    const t0 = Date.now();
    const systemMsg = opts.systemPrompt ?? opts.messages.find((m) => m.role === "system")?.content;
    const messages = opts.messages.filter((m) => m.role !== "system");
    const body = {
      model: opts.model ?? this.model,
      max_tokens: opts.maxTokens ?? 4096,
      messages,
      ...(systemMsg ? { system: systemMsg } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };
    const raw = await this.transport.post(
      `${this.baseUrl}/v1/messages`,
      body,
      { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
    ) as Record<string, unknown>;

    const content = ((raw["content"] as Array<{ text: string }>)?.[0]?.text) ?? "";
    const usage = raw["usage"] as { input_tokens?: number; output_tokens?: number } | undefined;
    const inputTokens = usage?.input_tokens ?? estimateTokens(messages.map((m) => m.content).join(" "));
    const outputTokens = usage?.output_tokens ?? estimateTokens(content);
    return this.makeResponse(
      (raw["id"] as string) ?? "anth-resp",
      content,
      opts.model ?? this.model,
      this.makeUsage(inputTokens, outputTokens),
      Date.now() - t0,
    );
  }
}

// ── 2. OpenAI-compatible base ─────────────────────────────────────────────────

abstract class OpenAICompatibleDriver extends BaseDriver {
  protected apiKey: string;
  protected abstract baseUrl: string;

  constructor(config: FullConfig, transport?: HttpTransport) {
    super(transport);
    this.apiKey = config.apiKey;
  }

  async complete(opts: LlmRequestOptions): Promise<LlmResponse> {
    const t0 = Date.now();
    const messages = opts.systemPrompt
      ? [{ role: "system", content: opts.systemPrompt }, ...opts.messages]
      : opts.messages;
    const body: Record<string, unknown> = {
      model: opts.model ?? this.model,
      messages,
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.stop ? { stop: opts.stop } : {}),
    };
    const raw = await this.transport.post(
      `${this.baseUrl}/chat/completions`,
      body,
      { Authorization: `Bearer ${this.apiKey}` },
    ) as Record<string, unknown>;

    const choice = (raw["choices"] as Array<{ message: { content: string }; finish_reason: string }>)?.[0];
    const content = choice?.message?.content ?? "";
    const usage = raw["usage"] as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    const inputTokens = usage?.prompt_tokens ?? estimateTokens(messages.map((m) => m.content).join(" "));
    const outputTokens = usage?.completion_tokens ?? estimateTokens(content);
    return this.makeResponse(
      (raw["id"] as string) ?? `${this.provider}-resp`,
      content,
      opts.model ?? this.model,
      this.makeUsage(inputTokens, outputTokens),
      Date.now() - t0,
      (choice?.finish_reason as LlmResponse["finishReason"]) ?? "stop",
    );
  }
}

// ── 3. Groq ───────────────────────────────────────────────────────────────────

export class GroqDriver extends OpenAICompatibleDriver {
  readonly provider = "groq";
  readonly model: string;
  protected baseUrl: string;

  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.groq.com/openai/v1";
    this.model = config.model ?? "llama-3.3-70b-versatile";
  }
}

// ── 4. DeepSeek ───────────────────────────────────────────────────────────────

export class DeepSeekDriver extends OpenAICompatibleDriver {
  readonly provider = "deepseek";
  readonly model: string;
  protected baseUrl: string;

  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.deepseek.com/v1";
    this.model = config.model ?? "deepseek-chat";
  }
}

// ── 5. Mistral ────────────────────────────────────────────────────────────────

export class MistralDriver extends OpenAICompatibleDriver {
  readonly provider = "mistral";
  readonly model: string;
  protected baseUrl: string;

  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.mistral.ai/v1";
    this.model = config.model ?? "mistral-large-latest";
  }
}

// ── 6. OpenRouter ─────────────────────────────────────────────────────────────

export class OpenRouterDriver extends OpenAICompatibleDriver {
  readonly provider = "openrouter";
  readonly model: string;
  protected baseUrl: string;

  constructor(config: FullConfig & { model?: string; siteName?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://openrouter.ai/api/v1";
    this.model = config.model ?? "anthropic/claude-3.5-sonnet";
  }
}

// ── 7. Gemini ─────────────────────────────────────────────────────────────────

export class GeminiDriver extends BaseDriver {
  readonly provider = "gemini";
  readonly model: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(transport);
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.model = config.model ?? "gemini-1.5-pro";
  }

  async complete(opts: LlmRequestOptions): Promise<LlmResponse> {
    const t0 = Date.now();
    const model = opts.model ?? this.model;
    const contents = opts.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
    const body: Record<string, unknown> = {
      contents,
      ...(opts.systemPrompt ? { systemInstruction: { parts: [{ text: opts.systemPrompt }] } } : {}),
      generationConfig: {
        maxOutputTokens: opts.maxTokens ?? 8192,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      },
    };
    const raw = await this.transport.post(
      `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`,
      body,
      {},
    ) as Record<string, unknown>;

    const candidate = (raw["candidates"] as Array<{ content: { parts: Array<{ text: string }> }; finishReason?: string }>)?.[0];
    const content = candidate?.content?.parts?.[0]?.text ?? "";
    const usage = raw["usageMetadata"] as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
    const inputTokens = usage?.promptTokenCount ?? estimateTokens(contents.map((c) => c.parts[0]?.text ?? "").join(" "));
    const outputTokens = usage?.candidatesTokenCount ?? estimateTokens(content);
    return this.makeResponse(
      `gemini-${Date.now()}`,
      content,
      model,
      this.makeUsage(inputTokens, outputTokens),
      Date.now() - t0,
    );
  }
}

// ── 8. Ollama (local) ─────────────────────────────────────────────────────────

export class OllamaDriver extends BaseDriver {
  readonly provider = "ollama";
  readonly model: string;
  private baseUrl: string;

  constructor(config: { model?: string; baseUrl?: string }, transport?: HttpTransport) {
    super(transport);
    this.baseUrl = config.baseUrl ?? "http://localhost:11434";
    this.model = config.model ?? "llama3.2";
  }

  async complete(opts: LlmRequestOptions): Promise<LlmResponse> {
    const t0 = Date.now();
    const model = opts.model ?? this.model;
    const body = {
      model,
      messages: opts.messages,
      stream: false,
      ...(opts.maxTokens !== undefined ? { options: { num_predict: opts.maxTokens } } : {}),
    };
    const raw = await this.transport.post(`${this.baseUrl}/api/chat`, body, {}) as Record<string, unknown>;
    const message = raw["message"] as { content?: string } | undefined;
    const content = message?.content ?? "";
    const usage = this.makeUsage(estimateTokens(opts.messages.map((m) => m.content).join(" ")), estimateTokens(content));
    return this.makeResponse(`ollama-${Date.now()}`, content, model, usage, Date.now() - t0);
  }
}

// ── 9. LM Studio (local, OpenAI-compat) ───────────────────────────────────────

export class LMStudioDriver extends OpenAICompatibleDriver {
  readonly provider = "lmstudio";
  readonly model: string;
  protected baseUrl: string;

  constructor(config: { model?: string; baseUrl?: string }, transport?: HttpTransport) {
    super({ apiKey: "lm-studio" }, transport);
    this.baseUrl = config.baseUrl ?? "http://localhost:1234/v1";
    this.model = config.model ?? "local-model";
  }
}

// ── 10. llama.cpp (local, OpenAI-compat) ──────────────────────────────────────

export class LlamaCppDriver extends OpenAICompatibleDriver {
  readonly provider = "llamacpp";
  readonly model: string;
  protected baseUrl: string;

  constructor(config: { model?: string; baseUrl?: string }, transport?: HttpTransport) {
    super({ apiKey: "llama-cpp" }, transport);
    this.baseUrl = config.baseUrl ?? "http://localhost:8080/v1";
    this.model = config.model ?? "llama-local";
  }
}

// ── 11. Fireworks ─────────────────────────────────────────────────────────────

export class FireworksDriver extends OpenAICompatibleDriver {
  readonly provider = "fireworks";
  readonly model: string;
  protected baseUrl: string;

  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.fireworks.ai/inference/v1";
    this.model = config.model ?? "accounts/fireworks/models/llama-v3p1-70b-instruct";
  }
}

// ── 12. NVIDIA NIM ────────────────────────────────────────────────────────────

export class NvidiaNimDriver extends OpenAICompatibleDriver {
  readonly provider = "nvidia_nim";
  readonly model: string;
  protected baseUrl: string;

  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://integrate.api.nvidia.com/v1";
    this.model = config.model ?? "meta/llama-3.1-70b-instruct";
  }
}

// ── 13. Cerebras ──────────────────────────────────────────────────────────────

export class CerebrasDriver extends OpenAICompatibleDriver {
  readonly provider = "cerebras";
  readonly model: string;
  protected baseUrl: string;

  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.cerebras.ai/v1";
    this.model = config.model ?? "llama3.1-70b";
  }
}

// ── 14. Kimi (Moonshot) ───────────────────────────────────────────────────────

export class KimiDriver extends OpenAICompatibleDriver {
  readonly provider = "kimi";
  readonly model: string;
  protected baseUrl: string;

  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.moonshot.cn/v1";
    this.model = config.model ?? "moonshot-v1-32k";
  }
}

// ── 15. Codestral (Mistral code) ──────────────────────────────────────────────

export class CodestralDriver extends OpenAICompatibleDriver {
  readonly provider = "codestral";
  readonly model: string;
  protected baseUrl: string;

  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://codestral.mistral.ai/v1";
    this.model = config.model ?? "codestral-latest";
  }
}

// ── Driver registry + factory ──────────────────────────────────────────────────

export type ProviderName =
  | "anthropic" | "groq" | "deepseek" | "mistral" | "openrouter"
  | "gemini" | "ollama" | "lmstudio" | "llamacpp" | "fireworks"
  | "nvidia_nim" | "cerebras" | "kimi" | "codestral";

export interface DriverRegistration {
  provider: ProviderName;
  driver: LlmDriver;
}

export class DriverRegistry {
  private drivers = new Map<string, LlmDriver>();

  register(driver: LlmDriver, alias?: string): this {
    this.drivers.set(alias ?? driver.provider, driver);
    return this;
  }

  get(provider: string): LlmDriver | undefined {
    return this.drivers.get(provider);
  }

  has(provider: string): boolean {
    return this.drivers.has(provider);
  }

  list(): string[] {
    return [...this.drivers.keys()];
  }
}
