// SPDX-License-Identifier: Apache-2.0
/**
 * llm-drivers — Concrete HTTP adapters for 15 LLM providers.
 *
 * All drivers share a common LlmDriver interface. Each driver handles:
 *   • Auth header injection
 *   • Request body shaping (each provider has a different schema)
 *   • Response parsing + token usage extraction
 *   • Real streaming delta emission (SSE / NDJSON)
 *   • Error mapping → LlmError with typed codes
 *
 * Transport is injectable for testing (MockTransport).
 * When no transport is injected (_useDefaultTransport = true) real SSE/NDJSON
 * streaming is activated via native fetch ReadableStream.  When MockTransport
 * is injected (_useDefaultTransport = false) stream() falls back to the
 * complete()-based single-delta path so existing tests pass unchanged.
 */

// ── Core types ─────────────────────────────────────────────────────────────────

export type LlmRole = "user" | "assistant" | "system";

/** Llm message interface definition. */
export interface LlmMessage {
  role: LlmRole;
  content: string;
}

/** Llm request options interface definition. */
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

/** Llm usage interface definition. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Llm response interface definition. */
export interface LlmResponse {
  id: string;
  content: string;
  model: string;
  usage: LlmUsage;
  finishReason: "stop" | "length" | "tool_calls" | "error" | "unknown";
  durationMs: number;
}

/** Stream delta interface definition. */
export interface StreamDelta {
  delta: string;
  done: boolean;
  usage?: LlmUsage;
}

/** Stream handler type alias. */
export type StreamHandler = (delta: StreamDelta) => void | Promise<void>;

/** Llm driver interface definition. */
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

/** Llm error. */
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

/** Mock transport. */
export class MockTransport implements HttpTransport {
  readonly calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
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
  /** True when no transport was injected — enables real SSE/NDJSON streaming. */
  protected _useDefaultTransport: boolean;

  constructor(transport?: HttpTransport) {
    this._useDefaultTransport = transport === undefined;
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

  /**
   * Async generator that streams SSE lines from a POST request.
   * Yields the raw payload of each "data: <payload>" line (skipping "[DONE]").
   * Uses native fetch ReadableStream — only call when _useDefaultTransport is true.
   */
  protected async *sseLines(
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): AsyncGenerator<string> {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw mapHttpError(resp.status, this.provider);
    if (!resp.body) return;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const { done, value } = await reader.read();
        if (done) break;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const payload = line.slice(6).trim();
            if (payload && payload !== "[DONE]") yield payload;
          }
        }
      }
      // Flush remaining buffer
      if (buffer.startsWith("data: ")) {
        const payload = buffer.slice(6).trim();
        if (payload && payload !== "[DONE]") yield payload;
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Async generator that streams NDJSON lines from a POST request.
   * Yields each non-empty line (raw JSON string).
   * Uses native fetch ReadableStream — only call when _useDefaultTransport is true.
   */
  protected async *ndjsonLines(
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): AsyncGenerator<string> {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw mapHttpError(resp.status, this.provider);
    if (!resp.body) return;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const { done, value } = await reader.read();
        if (done) break;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) yield line.trim();
        }
      }
      if (buffer.trim()) yield buffer.trim();
    } finally {
      reader.releaseLock();
    }
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  abstract complete(opts: LlmRequestOptions): Promise<LlmResponse>;

  async stream(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
    // Default: call complete and emit as single delta (used by test path)
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

interface ApiKeyConfig {
  apiKey: string;
}
interface BaseUrlConfig {
  baseUrl?: string;
}
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
    const raw = (await this.transport.post(`${this.baseUrl}/v1/messages`, body, {
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    })) as Record<string, unknown>;

    const content = (raw["content"] as { text: string }[])?.[0]?.text ?? "";
    const usage = raw["usage"] as { input_tokens?: number; output_tokens?: number } | undefined;
    const inputTokens =
      usage?.input_tokens ?? estimateTokens(messages.map((m) => m.content).join(" "));
    const outputTokens = usage?.output_tokens ?? estimateTokens(content);
    return this.makeResponse(
      (raw["id"] as string) ?? "anth-resp",
      content,
      opts.model ?? this.model,
      this.makeUsage(inputTokens, outputTokens),
      Date.now() - t0,
    );
  }

  override async stream(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
    if (!this._useDefaultTransport) return super.stream(opts, handler);

    const t0 = Date.now();
    const systemMsg = opts.systemPrompt ?? opts.messages.find((m) => m.role === "system")?.content;
    const messages = opts.messages.filter((m) => m.role !== "system");
    const body = {
      model: opts.model ?? this.model,
      max_tokens: opts.maxTokens ?? 4096,
      messages,
      stream: true,
      ...(systemMsg ? { system: systemMsg } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };

    let content = "";
    let msgId = `anth-stream-${Date.now()}`;
    let responseModel = opts.model ?? this.model;
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const line of this.sseLines(`${this.baseUrl}/v1/messages`, body, {
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    })) {
      let event: Record<string, unknown>;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        event = JSON.parse(line);
      } catch {
        continue;
      }

      const type = event["type"] as string | undefined;
      if (type === "message_start") {
        const msg = event["message"] as Record<string, unknown> | undefined;
        if (msg?.["id"]) msgId = msg["id"] as string;
        if (msg?.["model"]) responseModel = msg["model"] as string;
        const u = msg?.["usage"] as Record<string, number> | undefined;
        if (u?.["input_tokens"]) inputTokens = u["input_tokens"];
      } else if (type === "content_block_delta") {
        const delta = ((event["delta"] as Record<string, unknown>)?.["text"] as string) ?? "";
        if (delta) {
          content += delta;
          await handler({ delta, done: false });
        }
      } else if (type === "message_delta") {
        const u = event["usage"] as Record<string, number> | undefined;
        if (u?.["output_tokens"]) outputTokens = u["output_tokens"];
      }
    }

    const usageObj = this.makeUsage(
      inputTokens || estimateTokens(messages.map((m) => m.content).join(" ")),
      outputTokens || estimateTokens(content),
    );
    await handler({ delta: "", done: true, usage: usageObj });
    return this.makeResponse(msgId, content, responseModel, usageObj, Date.now() - t0);
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
    const raw = (await this.transport.post(`${this.baseUrl}/chat/completions`, body, {
      Authorization: `Bearer ${this.apiKey}`,
    })) as Record<string, unknown>;

    const choice = (
      raw["choices"] as { message: { content: string }; finish_reason: string }[]
    )?.[0];
    const content = choice?.message?.content ?? "";
    const usage = raw["usage"] as
      | { prompt_tokens?: number; completion_tokens?: number }
      | undefined;
    const inputTokens =
      usage?.prompt_tokens ?? estimateTokens(messages.map((m) => m.content).join(" "));
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

  override async stream(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
    if (!this._useDefaultTransport) return super.stream(opts, handler);

    const t0 = Date.now();
    const messages = opts.systemPrompt
      ? [{ role: "system", content: opts.systemPrompt }, ...opts.messages]
      : opts.messages;
    const body: Record<string, unknown> = {
      model: opts.model ?? this.model,
      messages,
      stream: true,
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.stop ? { stop: opts.stop } : {}),
    };

    let content = "";
    let id = `${this.provider}-stream-${Date.now()}`;
    let finishReason: LlmResponse["finishReason"] = "stop";
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const line of this.sseLines(`${this.baseUrl}/chat/completions`, body, {
      Authorization: `Bearer ${this.apiKey}`,
    })) {
      let event: Record<string, unknown>;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        event = JSON.parse(line);
      } catch {
        continue;
      }

      const eventId = event["id"] as string | undefined;
      if (eventId) id = eventId;

      const choices = event["choices"] as
        | {
            delta?: { content?: string };
            finish_reason?: string;
          }[]
        | undefined;

      const delta = choices?.[0]?.delta?.content ?? "";
      if (delta) {
        content += delta;
        await handler({ delta, done: false });
      }

      const fr = choices?.[0]?.finish_reason;
      if (fr) finishReason = fr as LlmResponse["finishReason"];

      const usage = event["usage"] as
        | { prompt_tokens?: number; completion_tokens?: number }
        | undefined;
      if (usage?.prompt_tokens) promptTokens = usage.prompt_tokens;
      if (usage?.completion_tokens) completionTokens = usage.completion_tokens;
    }

    const usageObj = this.makeUsage(
      promptTokens || estimateTokens(messages.map((m) => m.content).join(" ")),
      completionTokens || estimateTokens(content),
    );
    await handler({ delta: "", done: true, usage: usageObj });
    return this.makeResponse(
      id,
      content,
      opts.model ?? this.model,
      usageObj,
      Date.now() - t0,
      finishReason,
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

  constructor(
    config: FullConfig & { model?: string; siteName?: string },
    transport?: HttpTransport,
  ) {
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
    const raw = (await this.transport.post(
      `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`,
      body,
      {},
    )) as Record<string, unknown>;

    const candidate = (
      raw["candidates"] as {
        content: { parts: { text: string }[] };
        finishReason?: string;
      }[]
    )?.[0];
    const content = candidate?.content?.parts?.[0]?.text ?? "";
    const usage = raw["usageMetadata"] as
      | { promptTokenCount?: number; candidatesTokenCount?: number }
      | undefined;
    const inputTokens =
      usage?.promptTokenCount ??
      estimateTokens(contents.map((c) => c.parts[0]?.text ?? "").join(" "));
    const outputTokens = usage?.candidatesTokenCount ?? estimateTokens(content);
    return this.makeResponse(
      `gemini-${Date.now()}`,
      content,
      model,
      this.makeUsage(inputTokens, outputTokens),
      Date.now() - t0,
    );
  }

  override async stream(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
    if (!this._useDefaultTransport) return super.stream(opts, handler);

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

    let content = "";
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const line of this.sseLines(
      `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse&key=${this.apiKey}`,
      body,
      {},
    )) {
      let event: Record<string, unknown>;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        event = JSON.parse(line);
      } catch {
        continue;
      }

      const candidates = event["candidates"] as
        | {
            content: { parts: { text: string }[] };
          }[]
        | undefined;
      const text = candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      if (text) {
        content += text;
        await handler({ delta: text, done: false });
      }

      const usage = event["usageMetadata"] as
        | {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
          }
        | undefined;
      if (usage?.promptTokenCount) inputTokens = usage.promptTokenCount;
      if (usage?.candidatesTokenCount) outputTokens = usage.candidatesTokenCount;
    }

    const usageObj = this.makeUsage(
      inputTokens || estimateTokens(contents.map((c) => c.parts[0]?.text ?? "").join(" ")),
      outputTokens || estimateTokens(content),
    );
    await handler({ delta: "", done: true, usage: usageObj });
    return this.makeResponse(`gemini-${Date.now()}`, content, model, usageObj, Date.now() - t0);
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
    const raw = (await this.transport.post(`${this.baseUrl}/api/chat`, body, {})) as Record<
      string,
      unknown
    >;
    const message = raw["message"] as { content?: string } | undefined;
    const content = message?.content ?? "";
    const usage = this.makeUsage(
      estimateTokens(opts.messages.map((m) => m.content).join(" ")),
      estimateTokens(content),
    );
    return this.makeResponse(`ollama-${Date.now()}`, content, model, usage, Date.now() - t0);
  }

  override async stream(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
    if (!this._useDefaultTransport) return super.stream(opts, handler);

    const t0 = Date.now();
    const model = opts.model ?? this.model;
    const body = {
      model,
      messages: opts.messages,
      stream: true,
      ...(opts.maxTokens !== undefined ? { options: { num_predict: opts.maxTokens } } : {}),
    };

    let content = "";
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const line of this.ndjsonLines(`${this.baseUrl}/api/chat`, body, {})) {
      let chunk: Record<string, unknown>;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        chunk = JSON.parse(line);
      } catch {
        continue;
      }

      const msg = chunk["message"] as { content?: string } | undefined;
      const delta = msg?.content ?? "";
      if (delta) {
        content += delta;
        await handler({ delta, done: false });
      }

      if (chunk["done"] === true) {
        promptTokens = (chunk["prompt_eval_count"] as number | undefined) ?? 0;
        completionTokens = (chunk["eval_count"] as number | undefined) ?? 0;
        break;
      }
    }

    const usageObj = this.makeUsage(
      promptTokens || estimateTokens(opts.messages.map((m) => m.content).join(" ")),
      completionTokens || estimateTokens(content),
    );
    await handler({ delta: "", done: true, usage: usageObj });
    return this.makeResponse(`ollama-${Date.now()}`, content, model, usageObj, Date.now() - t0);
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
  | "anthropic"
  | "groq"
  | "deepseek"
  | "mistral"
  | "openrouter"
  | "gemini"
  | "ollama"
  | "lmstudio"
  | "llamacpp"
  | "fireworks"
  | "nvidia_nim"
  | "cerebras"
  | "kimi"
  | "codestral";

/** Driver registration interface definition. */
export interface DriverRegistration {
  provider: ProviderName;
  driver: LlmDriver;
}

/** Driver registry. */
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

// ── Local model driver interface ───────────────────────────────────────────────
// Ported from lyogavin/airllm: air_llm/airllm/airllm_base.py AirLLMBaseModel
// Pattern: layer-wise inference on consumer hardware — loads one transformer
// layer at a time, runs a forward pass, frees GPU memory before the next layer.
// AirLLM is PyTorch/CUDA-only; these are the TypeScript interface definitions
// that let @nexus/llm-drivers describe, register, and route to local models
// (Ollama, llama.cpp, GGUF servers) as first-class provider targets.

/**
 * Weight precision / compression for a locally-loaded model.
 * Maps to airllm's `compression` parameter (None / "4bit" / "8bit").
 */
export type LocalModelPrecision =
  | "fp16"   // Full 16-bit (default, no compression)
  | "fp32"   // 32-bit (high accuracy, 2× memory vs fp16)
  | "int8"   // 8-bit quantization (≈2× speedup, small accuracy loss)
  | "int4";  // 4-bit quantization (≈4× speedup, moderate accuracy loss)

/**
 * Strategy for splitting model weights across memory tiers.
 * Ported from airllm's layer-shard concept.
 */
export type LayerShardStrategy =
  | "none"        // Load entire model into memory at once
  | "layer"       // Layer-by-layer: load one layer, infer, unload (airllm default)
  | "pipeline";   // Pipeline-parallel across multiple devices

/** Configuration for a locally-hosted model provider. */
export interface LocalModelConfig {
  /** Model identifier — HuggingFace repo id or local file path. */
  modelId: string;
  /** HTTP base URL of the local inference server (Ollama, llama.cpp, etc.). */
  serverUrl: string;
  /** Compute device hint passed to the server. Default "auto". */
  device?: "cpu" | "cuda" | "mps" | "auto";
  /** Weight precision. Default "fp16". */
  precision?: LocalModelPrecision;
  /** Layer shard strategy. Default "none" (full load). */
  shardStrategy?: LayerShardStrategy;
  /** Maximum sequence length supported by this deployment. Default 4096. */
  maxSeqLen?: number;
  /** Optional HuggingFace token for gated models. */
  hfToken?: string;
}

/** Metadata returned when a local model is introspected. */
export interface LocalModelManifest {
  modelId: string;
  serverUrl: string;
  /** Whether the model server is currently reachable. */
  healthy: boolean;
  /** Model architecture family (e.g. "llama", "mistral", "qwen"). */
  architecture?: string;
  precision: LocalModelPrecision;
  maxSeqLen: number;
  contextWindow: number;
  /** Total parameter count in billions, if reported by the server. */
  parametersBillions?: number;
  /** ISO-8601 timestamp of last health check. */
  lastCheckedAt: string;
}

/** Probe a local model server and return its manifest. */
export async function probeLocalModel(
  config: LocalModelConfig,
  fetchFn: typeof fetch = fetch
): Promise<LocalModelManifest> {
  const baseUrl = config.serverUrl.replace(/\/$/, "");
  const now = new Date().toISOString();
  try {
    const res = await fetchFn(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Ollama returns { models: [{ name, details: { family, parameter_size } }] }
    const data = (await res.json()) as { models?: Array<{ name: string; details?: { family?: string; parameter_size?: string } }> };
    const match = (data.models ?? []).find(
      (m) => m.name === config.modelId || m.name.startsWith(config.modelId.split(":")[0] ?? "")
    );
    const paramStr = match?.details?.parameter_size ?? "";
    const paramsBillions = parseFloat(paramStr.replace(/[bB].*/, "")) || undefined;
    return {
      modelId: config.modelId,
      serverUrl: config.serverUrl,
      healthy: true,
      architecture: match?.details?.family,
      precision: config.precision ?? "fp16",
      maxSeqLen: config.maxSeqLen ?? 4096,
      contextWindow: config.maxSeqLen ?? 4096,
      parametersBillions: paramsBillions,
      lastCheckedAt: now,
    };
  } catch {
    return {
      modelId: config.modelId,
      serverUrl: config.serverUrl,
      healthy: false,
      precision: config.precision ?? "fp16",
      maxSeqLen: config.maxSeqLen ?? 4096,
      contextWindow: config.maxSeqLen ?? 4096,
      lastCheckedAt: now,
    };
  }
}
