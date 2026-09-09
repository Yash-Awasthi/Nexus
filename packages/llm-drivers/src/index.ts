// SPDX-License-Identifier: Apache-2.0
/**
 * llm-drivers — Concrete HTTP adapters for 36 LLM providers.
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

import { createHash, createHmac } from "node:crypto";

// ── Core types ─────────────────────────────────────────────────────────────────

export type LlmRole = "user" | "assistant" | "system" | "tool";

/** A tool/function the model may call (JSON-Schema parameters). */
export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON Schema describing the tool's input arguments. */
  parameters: Record<string, unknown>;
}

/** A tool call emitted by the model. */
export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Llm message interface definition. */
export interface LlmMessage {
  role: LlmRole;
  content: string;
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: LlmToolCall[];
  /** Present on `role: "tool"` messages — links the result to its call. */
  toolCallId?: string;
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
  /** Tools advertised to the model for native tool-calling. */
  tools?: LlmToolDefinition[];
  /** Tool-choice policy (provider support varies). */
  toolChoice?: "auto" | "none" | "required";
  /**
   * Opaque server-side thread id (e.g. Dify `conversation_id`, §1.2). Pass it
   * back on the next request to continue the same provider-side conversation.
   */
  conversationId?: string;
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
  /** Tool calls the model requested this turn (native tool-calling). */
  toolCalls?: LlmToolCall[];
  /** Server-side thread id (e.g. Dify `conversation_id`, §1.2) — pass back to thread. */
  conversationId?: string;
}

/** Stream delta interface definition. */
export interface StreamDelta {
  delta: string;
  done: boolean;
  usage?: LlmUsage;
  /** On the final (done) delta: tool calls accumulated during the stream. */
  toolCalls?: LlmToolCall[];
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
  private queue: unknown[] | null = null;

  setResponse(response: unknown): this {
    this.response = response;
    this.queue = null;
    return this;
  }

  /**
   * Queue ordered responses for multi-POST drivers (e.g. OAuth token then chat).
   * Each `post` shifts the next item; once drained, falls back to `setResponse`.
   */
  setResponses(responses: unknown[]): this {
    this.queue = [...responses];
    return this;
  }

  async post(url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
    this.calls.push({ url, body, headers });
    if (this.queue && this.queue.length > 0) return this.queue.shift();
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

/**
 * Extract a human-readable message from a provider error body. The raw JSON
 * previously flowed verbatim into chat transcripts (playtest: the Anthropic
 * "credit balance too low" error rendered as a raw JSON blob in the member's
 * opinion). Recognized JSON shapes yield their embedded message; anything
 * else is truncated so at worst the user sees one short line, not a blob.
 */
function providerErrorDetail(body: string): string | undefined {
  const text = body.trim();
  if (!text) return undefined;
  let parsed: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== "object" || v === null) return text.slice(0, 200);
    parsed = v as Record<string, unknown>;
  } catch {
    return text.slice(0, 200);
  }
  const err = parsed["error"];
  const msg =
    (typeof err === "object" && err !== null
      ? (err as Record<string, unknown>)["message"]
      : err) ??
    parsed["message"] ??
    parsed["detail"];
  if (typeof msg === "string" && msg.trim()) return msg.trim();
  return undefined; // recognized JSON but no extractable message — drop the blob
}

function mapHttpError(status: number, provider: string, message = ""): LlmError {
  const detail = providerErrorDetail(message);
  if (status === 401 || status === 403)
    return new LlmError("AUTH_FAILED", detail || "Authentication failed", provider, status);
  if (status === 429)
    return new LlmError("RATE_LIMITED", detail || "Rate limit exceeded", provider, status);
  if (status === 404)
    return new LlmError("MODEL_NOT_FOUND", detail || "Model not found", provider, status);
  if (status === 400)
    return new LlmError("INVALID_REQUEST", detail || "Invalid request", provider, status);
  if (status === 413 || status === 422)
    return new LlmError("CONTEXT_LENGTH_EXCEEDED", detail || "Context too long", provider, status);
  return new LlmError("SERVER_ERROR", detail || `HTTP ${status}`, provider, status);
}

// ── Tool-calling translation helpers ────────────────────────────────────────────
//
// Drivers speak provider-specific wire formats; the loop speaks the
// provider-agnostic LlmMessage / LlmToolDefinition / LlmToolCall shapes above.
// These helpers translate in both directions so tool-calling works identically
// across providers.

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { raw: s };
  }
}

/** Provider-agnostic messages → OpenAI chat-completions format. */
function toOpenAIMessages(
  messages: LlmMessage[],
  systemPrompt?: string,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

/** Tool definitions → OpenAI `tools` array. */
function toOpenAITools(tools?: LlmToolDefinition[]): Record<string, unknown>[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Parse OpenAI `message.tool_calls` (non-streaming) → LlmToolCall[]. */
function parseOpenAIToolCalls(rawMessage: unknown): LlmToolCall[] {
  const arr = (
    rawMessage as
      | { tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }
      | undefined
  )?.tool_calls;
  if (!arr?.length) return [];
  return arr.map((tc, i) => ({
    id: tc.id ?? `call_${i}`,
    name: tc.function?.name ?? "",
    arguments: safeJsonParse(tc.function?.arguments ?? "{}"),
  }));
}

/** Provider-agnostic messages → Anthropic `{ system, messages }`. */
function toAnthropicMessages(messages: LlmMessage[]): {
  system?: string;
  messages: Record<string, unknown>[];
} {
  let system: string | undefined;
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      system = system ? `${system}\n\n${m.content}` : m.content;
    } else if (m.role === "tool") {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content }],
      });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      const blocks: Record<string, unknown>[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
      }
      out.push({ role: "assistant", content: blocks });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return { system, messages: out };
}

/** Tool definitions → Anthropic `tools` array. */
function toAnthropicTools(tools?: LlmToolDefinition[]): Record<string, unknown>[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

// ── Base driver ────────────────────────────────────────────────────────────────

/**
 * Base driver — real HTTP + SSE/NDJSON streaming, error mapping, and shared
 * response/usage helpers. Extend it directly for providers that are NOT
 * OpenAI-chat-completions-shaped (e.g. Anthropic, Gemini). For OpenAI-compatible
 * endpoints, extend {@link OpenAICompatibleDriver} instead. See
 * `packages/llm-drivers/README.md` for the add-a-driver recipe.
 */
export abstract class BaseDriver implements LlmDriver {
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
   * On non-2xx, includes the provider's own error body (e.g. Gemini's
   * INVALID_ARGUMENT details) in the thrown error.
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
    if (!resp.ok) {
      let detail = "";
      try {
        detail = (await resp.text()).slice(0, 500);
      } catch {
        /* best-effort */
      }
      throw mapHttpError(resp.status, this.provider, detail || undefined);
    }
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
    if (!resp.ok) {
      let detail = "";
      try {
        detail = (await resp.text()).slice(0, 500);
      } catch {
        /* best-effort */
      }
      throw mapHttpError(resp.status, this.provider, detail || undefined);
    }
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
    await handler({ delta: "", done: true, usage: result.usage, toolCalls: result.toolCalls });
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
    toolCalls?: LlmToolCall[],
  ): LlmResponse {
    return { id, content, model, usage, finishReason, durationMs, toolCalls };
  }
}

// ── Driver config types ────────────────────────────────────────────────────────

/** A driver needs at least an API key. */
export interface ApiKeyConfig {
  apiKey: string;
}
/** Optional override for self-hosted / proxy endpoints. */
export interface BaseUrlConfig {
  baseUrl?: string;
}
/** Standard driver config — API key + optional base URL override. */
export type FullConfig = ApiKeyConfig & BaseUrlConfig;

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
    this.model = config.model ?? "claude-sonnet-4-6";
  }

  async complete(opts: LlmRequestOptions): Promise<LlmResponse> {
    const t0 = Date.now();
    const { system: msgSystem, messages } = toAnthropicMessages(opts.messages);
    const systemMsg = opts.systemPrompt ?? msgSystem;
    const tools = toAnthropicTools(opts.tools);
    const body = {
      model: opts.model ?? this.model,
      max_tokens: opts.maxTokens ?? 4096,
      messages,
      ...(systemMsg ? { system: systemMsg } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(tools ? { tools } : {}),
    };
    const raw = (await this.transport.post(`${this.baseUrl}/v1/messages`, body, {
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    })) as Record<string, unknown>;

    const blocks = (raw["content"] as Record<string, unknown>[] | undefined) ?? [];
    let content = "";
    const toolCalls: LlmToolCall[] = [];
    for (const b of blocks) {
      if (b["type"] === "tool_use")
        toolCalls.push({
          id: (b["id"] as string) ?? `toolu_${toolCalls.length}`,
          name: (b["name"] as string) ?? "",
          arguments: (b["input"] as Record<string, unknown>) ?? {},
        });
      // Any block carrying text counts as text (covers {type:"text",text} and bare {text}).
      else if (typeof b["text"] === "string") content += b["text"] as string;
    }
    const usage = raw["usage"] as { input_tokens?: number; output_tokens?: number } | undefined;
    const inputTokens =
      usage?.input_tokens ?? estimateTokens(messages.map((m) => JSON.stringify(m)).join(" "));
    const outputTokens = usage?.output_tokens ?? estimateTokens(content);
    const stopReason = raw["stop_reason"] as string | undefined;
    return this.makeResponse(
      (raw["id"] as string) ?? "anth-resp",
      content,
      opts.model ?? this.model,
      this.makeUsage(inputTokens, outputTokens),
      Date.now() - t0,
      stopReason === "tool_use" || toolCalls.length ? "tool_calls" : "stop",
      toolCalls.length ? toolCalls : undefined,
    );
  }

  override async stream(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
    if (!this._useDefaultTransport) return super.stream(opts, handler);

    const t0 = Date.now();
    const { system: msgSystem, messages } = toAnthropicMessages(opts.messages);
    const systemMsg = opts.systemPrompt ?? msgSystem;
    const tools = toAnthropicTools(opts.tools);
    const body = {
      model: opts.model ?? this.model,
      max_tokens: opts.maxTokens ?? 4096,
      messages,
      stream: true,
      ...(systemMsg ? { system: systemMsg } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(tools ? { tools } : {}),
    };

    let content = "";
    let msgId = `anth-stream-${Date.now()}`;
    let responseModel = opts.model ?? this.model;
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | undefined;
    // Accumulate tool_use blocks by content-block index (input_json_delta is streamed).
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

    for await (const line of this.sseLines(`${this.baseUrl}/v1/messages`, body, {
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    })) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
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
      } else if (type === "content_block_start") {
        const idx = event["index"] as number;
        const block = event["content_block"] as Record<string, unknown> | undefined;
        if (block?.["type"] === "tool_use") {
          toolBlocks.set(idx, {
            id: (block["id"] as string) ?? `toolu_${idx}`,
            name: (block["name"] as string) ?? "",
            json: "",
          });
        }
      } else if (type === "content_block_delta") {
        const idx = event["index"] as number;
        const delta = event["delta"] as Record<string, unknown> | undefined;
        if (delta?.["type"] === "input_json_delta") {
          const block = toolBlocks.get(idx);
          if (block) block.json += (delta["partial_json"] as string) ?? "";
        } else {
          const text = (delta?.["text"] as string) ?? "";
          if (text) {
            content += text;
            await handler({ delta: text, done: false });
          }
        }
      } else if (type === "message_delta") {
        const d = event["delta"] as Record<string, unknown> | undefined;
        if (d?.["stop_reason"]) stopReason = d["stop_reason"] as string;
        const u = event["usage"] as Record<string, number> | undefined;
        if (u?.["output_tokens"]) outputTokens = u["output_tokens"];
      }
    }

    const toolCalls: LlmToolCall[] = [...toolBlocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, b]) => ({ id: b.id, name: b.name, arguments: safeJsonParse(b.json || "{}") }));

    const usageObj = this.makeUsage(
      inputTokens || estimateTokens(messages.map((m) => JSON.stringify(m)).join(" ")),
      outputTokens || estimateTokens(content),
    );
    await handler({
      delta: "",
      done: true,
      usage: usageObj,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    });
    return this.makeResponse(
      msgId,
      content,
      responseModel,
      usageObj,
      Date.now() - t0,
      stopReason === "tool_use" || toolCalls.length ? "tool_calls" : "stop",
      toolCalls.length ? toolCalls : undefined,
    );
  }
}

// ── 2. OpenAI-compatible base ─────────────────────────────────────────────────

/**
 * OpenAI-compatible base driver — implements `complete`/`stream` against a
 * chat-completions endpoint. Subclass it and set `provider`, `model`, and
 * `baseUrl`; override {@link chatCompletionsUrl} / {@link authHeaders} for
 * non-standard paths or auth schemes (e.g. Azure's `api-key` header). See
 * `packages/llm-drivers/README.md` for the add-a-driver recipe.
 */
export abstract class OpenAICompatibleDriver extends BaseDriver {
  protected apiKey: string;
  protected abstract baseUrl: string;

  constructor(config: FullConfig, transport?: HttpTransport) {
    super(transport);
    this.apiKey = config.apiKey;
  }

  /** Chat-completions endpoint URL. Override for non-standard paths (e.g. Azure). */
  protected chatCompletionsUrl(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  /** Auth + extra request headers. Override for non-Bearer schemes (e.g. Azure `api-key`). */
  protected authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  async complete(opts: LlmRequestOptions): Promise<LlmResponse> {
    const t0 = Date.now();
    const messages = toOpenAIMessages(opts.messages, opts.systemPrompt);
    const tools = toOpenAITools(opts.tools);
    const body: Record<string, unknown> = {
      model: opts.model ?? this.model,
      messages,
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.stop ? { stop: opts.stop } : {}),
      ...(tools ? { tools, ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}) } : {}),
    };
    const raw = (await this.transport.post(
      this.chatCompletionsUrl(),
      body,
      this.authHeaders(),
    )) as Record<string, unknown>;

    const choice = (
      raw["choices"] as { message: Record<string, unknown>; finish_reason: string }[]
    )?.[0];
    const content = (choice?.message?.["content"] as string) ?? "";
    const toolCalls = parseOpenAIToolCalls(choice?.message);
    const usage = raw["usage"] as
      { prompt_tokens?: number; completion_tokens?: number } | undefined;
    const inputTokens =
      usage?.prompt_tokens ?? estimateTokens(opts.messages.map((m) => m.content).join(" "));
    const outputTokens = usage?.completion_tokens ?? estimateTokens(content);
    return this.makeResponse(
      (raw["id"] as string) ?? `${this.provider}-resp`,
      content,
      opts.model ?? this.model,
      this.makeUsage(inputTokens, outputTokens),
      Date.now() - t0,
      (choice?.finish_reason as LlmResponse["finishReason"]) ??
        (toolCalls.length ? "tool_calls" : "stop"),
      toolCalls.length ? toolCalls : undefined,
    );
  }

  override async stream(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
    if (!this._useDefaultTransport) return super.stream(opts, handler);

    const t0 = Date.now();
    const messages = toOpenAIMessages(opts.messages, opts.systemPrompt);
    const tools = toOpenAITools(opts.tools);
    const body: Record<string, unknown> = {
      model: opts.model ?? this.model,
      messages,
      stream: true,
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.stop ? { stop: opts.stop } : {}),
      ...(tools ? { tools, ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}) } : {}),
    };

    let content = "";
    let id = `${this.provider}-stream-${Date.now()}`;
    let finishReason: LlmResponse["finishReason"] = "stop";
    let promptTokens = 0;
    let completionTokens = 0;
    // Accumulate streaming tool_calls by their delta index.
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();

    for await (const line of this.sseLines(this.chatCompletionsUrl(), body, this.authHeaders())) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const eventId = event["id"] as string | undefined;
      if (eventId) id = eventId;

      const choices = event["choices"] as
        | {
            delta?: {
              content?: string;
              tool_calls?: {
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }[];
            };
            finish_reason?: string;
          }[]
        | undefined;

      const choice0 = choices?.[0];
      const delta = choice0?.delta?.content ?? "";
      if (delta) {
        content += delta;
        await handler({ delta, done: false });
      }

      const tcDeltas = choice0?.delta?.tool_calls;
      if (tcDeltas?.length) {
        for (const tc of tcDeltas) {
          const idx = tc.index ?? 0;
          const acc = toolAcc.get(idx) ?? { id: "", name: "", args: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          toolAcc.set(idx, acc);
        }
      }

      const fr = choice0?.finish_reason;
      if (fr) finishReason = fr as LlmResponse["finishReason"];

      const usage = event["usage"] as
        { prompt_tokens?: number; completion_tokens?: number } | undefined;
      if (usage?.prompt_tokens) promptTokens = usage.prompt_tokens;
      if (usage?.completion_tokens) completionTokens = usage.completion_tokens;
    }

    const toolCalls: LlmToolCall[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, acc]) => ({
        id: acc.id || `call_${i}`,
        name: acc.name,
        arguments: safeJsonParse(acc.args || "{}"),
      }));

    const usageObj = this.makeUsage(
      promptTokens || estimateTokens(opts.messages.map((m) => m.content).join(" ")),
      completionTokens || estimateTokens(content),
    );
    await handler({
      delta: "",
      done: true,
      usage: usageObj,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    });
    return this.makeResponse(
      id,
      content,
      opts.model ?? this.model,
      usageObj,
      Date.now() - t0,
      toolCalls.length ? "tool_calls" : finishReason,
      toolCalls.length ? toolCalls : undefined,
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
    this.model = config.model ?? "openai/gpt-oss-120b";
  }
}

// ── 3b. OpenAI (official ChatGPT API) ─────────────────────────────────────────
// Missing driver: `openai` members (the default ChatGPT council member) could
// never resolve a driver — not in the env registry, not in the per-user BYOK
// registry, and not in the worker's agent executor. api.openai.com is a plain
// OpenAI-compatible chat-completions endpoint, so this is the same pattern as
// every other OpenAI-compatible driver above.

export class OpenAIDriver extends OpenAICompatibleDriver {
  readonly provider = "openai";
  readonly model: string;
  protected baseUrl: string;

  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
    // gpt-4o was retired from the API 2026-02-16; the GA replacements are the
    // gpt-5.6 family (sol = flagship / terra = fast / luna = nano).
    this.model = config.model ?? "gpt-5.6-sol";
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
    // deepseek-chat was retired; the live family is deepseek-v4-* (flash/reasoner).
    this.model = config.model ?? "deepseek-v4-flash";
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
    this.model = config.model ?? "anthropic/claude-sonnet-5";
  }
}

// ── 7. Gemini ─────────────────────────────────────────────────────────────────

export class GeminiDriver extends BaseDriver {
  readonly provider = "gemini";
  readonly model: string;
  private apiKey: string;
  private baseUrl: string;
  /** Gemini 3+ returns a `thoughtSignature` on functionCall parts and requires
   *  it to be echoed back in the next request (400 otherwise). Keyed by the
   *  call id we mint (`fc_<name>_<i>`), which the runtime preserves verbatim
   *  through tool-result round trips. */
  private thoughtSignatures = new Map<string, string>();
  /** API-issued call ids (`id` on functionCall parts) keyed the same way, so
   *  the exact id the API assigned can be echoed back on functionCall and
   *  functionResponse parts (Gemini 3+ call-id validation). */
  private callIds = new Map<string, string>();

  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(transport);
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.model = config.model ?? "gemini-3.6-flash";
  }

  /** Map runtime messages to Gemini `contents` (role + parts). Tool results
   *  become functionResponse parts; assistant tool calls become functionCall
   *  parts (echoing the captured thoughtSignature as a sibling part key). The
   *  id→name table lets a `role: "tool"` message (which only carries the call
   *  id) resolve the function name Gemini requires. */
  private toGeminiContents(
    messages: LlmMessage[],
  ): { role: string; parts: Record<string, unknown>[] }[] {
    const idToName = new Map<string, string>();
    const out: { role: string; parts: Record<string, unknown>[] }[] = [];
    for (const m of messages) {
      if (m.role === "system") continue;
      const parts: Record<string, unknown>[] = [];
      if (m.role === "tool") {
        const name = idToName.get(m.toolCallId ?? "") ?? "tool_result";
        // Gemini's functionResponse.response is a Struct — a bare string is
        // rejected with INVALID_ARGUMENT. Wrap non-object payloads.
        let response: unknown = m.content;
        try {
          response = JSON.parse(m.content) as unknown;
        } catch {
          response = { result: m.content };
        }
        if (typeof response !== "object" || response === null)
          response = { result: String(response) };
        const fr: Record<string, unknown> = { name, response };
        // Echo the API-issued call id back when we captured it (Gemini 3+
        // validates call ids across the round trip).
        const callId = this.callIds.get(m.toolCallId ?? "");
        if (callId) fr["id"] = callId;
        parts.push({ functionResponse: fr });
      } else if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          idToName.set(tc.id, tc.name);
          const part: Record<string, unknown> = {
            functionCall: {
              name: tc.name,
              args: tc.arguments,
              ...(this.callIds.get(tc.id) ? { id: this.callIds.get(tc.id) } : {}),
            },
          };
          const sig = this.thoughtSignatures.get(tc.id);
          if (sig) part["thoughtSignature"] = sig;
          parts.push(part);
        }
      }
      if (m.content) parts.push({ text: m.content });
      if (!parts.length) parts.push({ text: "" });
      out.push({ role: m.role === "assistant" ? "model" : "user", parts });
    }
    return out;
  }

  private toGeminiTools(tools: LlmToolDefinition[]): Record<string, unknown>[] {
    return [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }

  private parseFunctionCalls(
    parts: {
      functionCall?: { name?: string; args?: unknown; id?: string };
      thoughtSignature?: string;
    }[],
  ): LlmToolCall[] {
    const calls: LlmToolCall[] = [];
    parts?.forEach((p, i) => {
      if (p.functionCall?.name) {
        const id = `fc_${p.functionCall.name}_${i}`;
        if (p.thoughtSignature) this.thoughtSignatures.set(id, p.thoughtSignature);
        if (p.functionCall.id) this.callIds.set(id, p.functionCall.id);
        calls.push({
          id,
          name: p.functionCall.name,
          arguments:
            typeof p.functionCall.args === "object" && p.functionCall.args !== null
              ? (p.functionCall.args as Record<string, unknown>)
              : {},
        });
      }
    });
    return calls;
  }

  async complete(opts: LlmRequestOptions): Promise<LlmResponse> {
    const t0 = Date.now();
    const model = opts.model ?? this.model;
    const contents = this.toGeminiContents(opts.messages);
    const body: Record<string, unknown> = {
      contents,
      ...(opts.systemPrompt ? { systemInstruction: { parts: [{ text: opts.systemPrompt }] } } : {}),
      ...(opts.tools?.length ? { tools: this.toGeminiTools(opts.tools) } : {}),
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
        content: {
          parts: {
            text?: string;
            functionCall?: { name?: string; args?: unknown; id?: string };
            thoughtSignature?: string;
          }[];
        };
        finishReason?: string;
      }[]
    )?.[0];
    const parts = candidate?.content?.parts ?? [];
    const content = parts.map((p) => p.text ?? "").join("");
    const toolCalls = this.parseFunctionCalls(parts);
    const usage = raw["usageMetadata"] as
      { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
    const inputTokens =
      usage?.promptTokenCount ?? estimateTokens(contents.map((c) => JSON.stringify(c)).join(" "));
    const outputTokens = usage?.candidatesTokenCount ?? estimateTokens(content);
    const finishReason: LlmResponse["finishReason"] = toolCalls.length
      ? "tool_calls"
      : candidate?.finishReason === "MAX_TOKENS"
        ? "length"
        : "stop";
    return this.makeResponse(
      `gemini-${Date.now()}`,
      content,
      model,
      this.makeUsage(inputTokens, outputTokens),
      Date.now() - t0,
      finishReason,
      toolCalls.length ? toolCalls : undefined,
    );
  }

  override async stream(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
    if (!this._useDefaultTransport) return super.stream(opts, handler);

    const t0 = Date.now();
    const model = opts.model ?? this.model;
    const contents = this.toGeminiContents(opts.messages);
    const body: Record<string, unknown> = {
      contents,
      ...(opts.systemPrompt ? { systemInstruction: { parts: [{ text: opts.systemPrompt }] } } : {}),
      ...(opts.tools?.length ? { tools: this.toGeminiTools(opts.tools) } : {}),
      generationConfig: {
        maxOutputTokens: opts.maxTokens ?? 8192,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      },
    };

    let content = "";
    let inputTokens = 0;
    let outputTokens = 0;
    // Gemini streams a function call across several parts: the first carries
    // the call name, later parts carry the (cumulative) args object. Merge
    // into one entry per named call.
    const toolAcc: {
      name: string;
      args: Record<string, unknown>;
      sig?: string;
      apiId?: string;
    }[] = [];
    let curCall: {
      name: string;
      args: Record<string, unknown>;
      sig?: string;
      apiId?: string;
    } | null = null;

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
            content: {
              parts: {
                text?: string;
                functionCall?: { name?: string; args?: unknown; id?: string };
                thoughtSignature?: string;
              }[];
            };
            finishReason?: string;
          }[]
        | undefined;
      const parts = candidates?.[0]?.content?.parts;
      for (const p of parts ?? []) {
        if (p.text) {
          content += p.text;
          await handler({ delta: p.text, done: false });
        }
        if (p.functionCall) {
          if (p.functionCall.name) {
            if (curCall) toolAcc.push(curCall);
            curCall = {
              name: p.functionCall.name,
              args: {},
              ...(p.functionCall.id ? { apiId: p.functionCall.id } : {}),
            };
          }
          if (curCall && typeof p.functionCall.args === "object" && p.functionCall.args !== null) {
            curCall.args = {
              ...curCall.args,
              ...(p.functionCall.args as Record<string, unknown>),
            };
          }
          // The thought signature rides on the first functionCall part.
          if (p.thoughtSignature && curCall) curCall.sig = p.thoughtSignature;
          // So does the API-issued call id.
          if (p.functionCall.id && curCall) curCall.apiId = p.functionCall.id;
        }
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
    if (curCall) toolAcc.push(curCall);

    const toolCalls: LlmToolCall[] = toolAcc.map((tc, i) => {
      const id = `fc_${tc.name}_${i}`;
      if (tc.sig) this.thoughtSignatures.set(id, tc.sig);
      if (tc.apiId) this.callIds.set(id, tc.apiId);
      return { id, name: tc.name, arguments: tc.args };
    });
    const usageObj = this.makeUsage(
      inputTokens || estimateTokens(contents.map((c) => JSON.stringify(c)).join(" ")),
      outputTokens || estimateTokens(content),
    );
    await handler({
      delta: "",
      done: true,
      usage: usageObj,
      ...(toolCalls.length ? { toolCalls } : {}),
    });
    return this.makeResponse(
      `gemini-${Date.now()}`,
      content,
      model,
      usageObj,
      Date.now() - t0,
      toolCalls.length ? "tool_calls" : "stop",
      toolCalls.length ? toolCalls : undefined,
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
    // Ollama only knows local model tags (e.g. "qwen2.5:7b"). Callers across the
    // app hardcode cloud aliases like "anthropic/claude-3.5-sonnet"; route any
    // such "provider/model" string to this driver's configured local model.
    const model = opts.model && !opts.model.includes("/") ? opts.model : this.model;
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
    // Ollama only knows local model tags (e.g. "qwen2.5:7b"). Callers across the
    // app hardcode cloud aliases like "anthropic/claude-3.5-sonnet"; route any
    // such "provider/model" string to this driver's configured local model.
    const model = opts.model && !opts.model.includes("/") ? opts.model : this.model;
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
    this.model = config.model ?? "accounts/fireworks/models/llama-3.3-70b-instruct";
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
    // Small, low-cost reasoning model; verified live on integrate.api.nvidia.com.
    this.model = config.model ?? "nvidia/nvidia-nemotron-nano-9b-v2";
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
    this.model = config.model ?? "llama-3.3-70b";
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
    this.model = config.model ?? "kimi-k3";
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

// ── 16. xAI (Grok) ────────────────────────────────────────────────────────────

export class XaiDriver extends OpenAICompatibleDriver {
  readonly provider = "xai";
  readonly model: string;
  protected baseUrl: string;

  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.x.ai/v1";
    this.model = config.model ?? "grok-4.3";
  }
}

// ── 17. Together AI ───────────────────────────────────────────────────────────

export class TogetherDriver extends OpenAICompatibleDriver {
  readonly provider = "together";
  readonly model: string;
  protected baseUrl: string;

  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.together.xyz/v1";
    this.model = config.model ?? "meta-llama/Llama-3.3-70B-Instruct-Turbo";
  }
}

// ── 18. Perplexity ────────────────────────────────────────────────────────────

export class PerplexityDriver extends OpenAICompatibleDriver {
  readonly provider = "perplexity";
  readonly model: string;
  protected baseUrl: string;

  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.perplexity.ai";
    this.model = config.model ?? "sonar-pro";
  }
}

// ── 19. Cohere (OpenAI-compatibility endpoint) ────────────────────────────────

export class CohereDriver extends OpenAICompatibleDriver {
  readonly provider = "cohere";
  readonly model: string;
  protected baseUrl: string;

  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.cohere.ai/compatibility/v1";
    this.model = config.model ?? "command-a";
  }
}

// ── 20-34. Extra OpenAI-compatible providers (extended provider set) ───────────────
//
// All speak the standard /chat/completions schema with a Bearer key, so each is
// a one-liner subclass of OpenAICompatibleDriver — base URL + default model only.
// Providers needing non-OpenAI auth (Bedrock SigV4, Vertex GCP, Cloudflare path
// account-id, Baidu access-token) are intentionally NOT here — they need bespoke
// drivers and are tracked as Phase 2b follow-ups.

/** Zhipu GLM (open.bigmodel.cn). */
export class ZhipuDriver extends OpenAICompatibleDriver {
  readonly provider = "zhipu";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://open.bigmodel.cn/api/paas/v4";
    this.model = config.model ?? "glm-4-plus";
  }
}

/** Moonshot International (api.moonshot.ai — distinct from the .cn Kimi endpoint). */
export class MoonshotDriver extends OpenAICompatibleDriver {
  readonly provider = "moonshot";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.moonshot.ai/v1";
    this.model = config.model ?? "kimi-k3";
  }
}

/** 01.AI / Lingyiwanwu (Yi models). */
export class ZeroOneDriver extends OpenAICompatibleDriver {
  readonly provider = "zeroone";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.lingyiwanwu.com/v1";
    this.model = config.model ?? "yi-large";
  }
}

/** Baichuan. */
export class BaichuanDriver extends OpenAICompatibleDriver {
  readonly provider = "baichuan";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.baichuan-ai.com/v1";
    this.model = config.model ?? "Baichuan4-Turbo";
  }
}

/** MiniMax. */
export class MiniMaxDriver extends OpenAICompatibleDriver {
  readonly provider = "minimax";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.minimax.chat/v1";
    this.model = config.model ?? "abab6.5s-chat";
  }
}

/** StepFun. */
export class StepFunDriver extends OpenAICompatibleDriver {
  readonly provider = "stepfun";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.stepfun.com/v1";
    this.model = config.model ?? "step-1-8k";
  }
}

/** Novita AI. */
export class NovitaDriver extends OpenAICompatibleDriver {
  readonly provider = "novita";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.novita.ai/v3/openai";
    this.model = config.model ?? "meta-llama/llama-3.1-70b-instruct";
  }
}

/** SiliconFlow. */
export class SiliconFlowDriver extends OpenAICompatibleDriver {
  readonly provider = "siliconflow";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.siliconflow.cn/v1";
    this.model = config.model ?? "Qwen/Qwen2.5-72B-Instruct";
  }
}

/** Hyperbolic. */
export class HyperbolicDriver extends OpenAICompatibleDriver {
  readonly provider = "hyperbolic";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.hyperbolic.xyz/v1";
    this.model = config.model ?? "meta-llama/Meta-Llama-3.1-70B-Instruct";
  }
}

/** Chutes. */
export class ChutesDriver extends OpenAICompatibleDriver {
  readonly provider = "chutes";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://llm.chutes.ai/v1";
    this.model = config.model ?? "deepseek-ai/DeepSeek-V3";
  }
}

/** Nebius AI Studio. */
export class NebiusDriver extends OpenAICompatibleDriver {
  readonly provider = "nebius";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.studio.nebius.ai/v1";
    this.model = config.model ?? "meta-llama/Meta-Llama-3.1-70B-Instruct";
  }
}

/** Venice AI. */
export class VeniceDriver extends OpenAICompatibleDriver {
  readonly provider = "venice";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.venice.ai/api/v1";
    this.model = config.model ?? "llama-3.3-70b";
  }
}

/** Qwen / Alibaba DashScope (OpenAI-compatible mode). */
export class QwenDriver extends OpenAICompatibleDriver {
  readonly provider = "qwen";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";
    this.model = config.model ?? "qwen-max";
  }
}

/** 360 AI. */
export class Ai360Driver extends OpenAICompatibleDriver {
  readonly provider = "ai360";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.360.cn/v1";
    this.model = config.model ?? "360gpt2-pro";
  }
}

/** Vercel AI Gateway (meta-gateway; "creator/model" ids like OpenRouter). */
export class VercelAIGatewayDriver extends OpenAICompatibleDriver {
  readonly provider = "vercel_ai_gateway";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://ai-gateway.vercel.sh/v1";
    this.model = config.model ?? "openai/gpt-4o-mini";
  }
}

/** Doubao / Volcengine Ark (ByteDance, China region). */
export class DoubaoDriver extends OpenAICompatibleDriver {
  readonly provider = "doubao";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://ark.cn-beijing.volces.com/api/v3";
    this.model = config.model ?? "doubao-pro-32k";
  }
}

/** BytePlus ModelArk (Volcengine Ark, international region). */
export class BytePlusDriver extends OpenAICompatibleDriver {
  readonly provider = "byteplus";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://ark.ap-southeast.bytepluses.com/api/v3";
    this.model = config.model ?? "skylark-pro";
  }
}

/** Tencent Hunyuan (OpenAI-compatible endpoint). */
export class HunyuanDriver extends OpenAICompatibleDriver {
  readonly provider = "hunyuan";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://api.hunyuan.cloud.tencent.com/v1";
    this.model = config.model ?? "hunyuan-turbo";
  }
}

/** iFlytek Spark (HTTP OpenAI-compatible endpoint, not the signed WebSocket API). */
export class SparkDriver extends OpenAICompatibleDriver {
  readonly provider = "spark";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://spark-api-open.xf-yun.com/v1";
    this.model = config.model ?? "generalv3.5";
  }
}

/**
 * Azure OpenAI Service. Unlike the public OpenAI API, Azure routes by deployment
 * name in the path, pins an `api-version` query param, and authenticates with an
 * `api-key` header (not a Bearer token). Overrides the two base-class seams.
 */
export class AzureOpenAIDriver extends OpenAICompatibleDriver {
  readonly provider = "azure_openai";
  readonly model: string;
  protected baseUrl: string;
  private deployment: string;
  private apiVersion: string;
  private authMode: "api-key" | "aad";
  constructor(
    config: ApiKeyConfig & {
      /** Resource endpoint, e.g. https://my-resource.openai.azure.com */
      endpoint: string;
      /** Azure deployment name (routes the request; distinct from the model id). */
      deployment: string;
      /** API version, e.g. 2024-10-21. */
      apiVersion?: string;
      /**
       * Auth scheme. `api-key` (default) sends the resource key in the `api-key`
       * header. `aad` sends `apiKey` as a Microsoft Entra ID (Azure AD) bearer
       * token (`Authorization: Bearer …`) — this is what the @nexus/llm-oauth
       * Entra flow issues, so an OAuth-authed Azure account routes here unchanged.
       */
      authMode?: "api-key" | "aad";
      model?: string;
    },
    transport?: HttpTransport,
  ) {
    super(config, transport);
    this.baseUrl = config.endpoint.replace(/\/$/, "");
    this.deployment = config.deployment;
    this.apiVersion = config.apiVersion ?? "2024-10-21";
    this.authMode = config.authMode ?? "api-key";
    this.model = config.model ?? config.deployment;
  }
  protected override chatCompletionsUrl(): string {
    return `${this.baseUrl}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`;
  }
  protected override authHeaders(): Record<string, string> {
    return this.authMode === "aad"
      ? { Authorization: `Bearer ${this.apiKey}` }
      : { "api-key": this.apiKey };
  }
}

/** Cloudflare Workers AI (OpenAI-compatible gateway; needs the account id in the path). */
export class CloudflareWorkersAIDriver extends OpenAICompatibleDriver {
  readonly provider = "cloudflare";
  readonly model: string;
  protected baseUrl: string;
  constructor(
    config: ApiKeyConfig & { accountId: string; baseUrl?: string; model?: string },
    transport?: HttpTransport,
  ) {
    super(config, transport);
    this.baseUrl =
      config.baseUrl ?? `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/v1`;
    this.model = config.model ?? "@cf/meta/llama-3.1-8b-instruct";
  }
}

/** Xinference — self-hosted OpenAI-compatible inference server (default :9997). */
export class XinferenceDriver extends OpenAICompatibleDriver {
  readonly provider = "xinference";
  readonly model: string;
  protected baseUrl: string;
  constructor(
    config: { apiKey?: string; model?: string; baseUrl?: string },
    transport?: HttpTransport,
  ) {
    super({ apiKey: config.apiKey ?? "xinference" }, transport);
    this.baseUrl = config.baseUrl ?? "http://localhost:9997/v1";
    this.model = config.model ?? "qwen2.5-instruct";
  }
}

/**
 * Replicate. Replicate's native shape is "create a prediction, then poll until it
 * finishes" — but the modern API accepts a `Prefer: wait` header that blocks and
 * returns the completed prediction in a single response, so no poll loop (and no
 * GET) is needed. `model` is the version hash or `owner/name`; chat models take a
 * `prompt` + `system_prompt` and return `output` as an array of token chunks.
 */
export class ReplicateDriver extends BaseDriver {
  readonly provider = "replicate";
  readonly model: string;
  private apiKey: string;
  private baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(transport);
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.replicate.com/v1";
    this.model = config.model ?? "meta/meta-llama-3-8b-instruct";
  }

  async complete(opts: LlmRequestOptions): Promise<LlmResponse> {
    const t0 = Date.now();
    const model = opts.model ?? this.model;
    const prompt = opts.messages
      .map((m) => {
        const role = m.role === "assistant" ? "Assistant" : m.role === "system" ? "System" : "User";
        return `${role}: ${m.content}`;
      })
      .join("\n");
    const input: Record<string, unknown> = {
      prompt,
      ...(opts.systemPrompt ? { system_prompt: opts.systemPrompt } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };
    const raw = (await this.transport.post(
      `${this.baseUrl}/predictions`,
      { version: model, input },
      { Authorization: `Bearer ${this.apiKey}`, Prefer: "wait" },
    )) as Record<string, unknown>;

    const status = raw["status"] as string | undefined;
    if (status === "failed" || status === "canceled") {
      throw new LlmError(
        "SERVER_ERROR",
        `Replicate prediction ${status}: ${String(raw["error"] ?? "")}`,
        this.provider,
      );
    }
    // `output` is usually an array of streamed string chunks; sometimes one string.
    const out = raw["output"];
    const content = Array.isArray(out) ? out.join("") : typeof out === "string" ? out : "";
    const inputTokens = estimateTokens(prompt);
    const outputTokens = estimateTokens(content);
    return this.makeResponse(
      (raw["id"] as string) ?? "replicate-resp",
      content,
      model,
      this.makeUsage(inputTokens, outputTokens),
      Date.now() - t0,
      "stop",
    );
  }
}

/**
 * Baidu ERNIE (Wenxin / Qianfan classic API). Unlike the OpenAI-shaped drivers,
 * ERNIE needs a two-step flow: a client-credentials OAuth POST to mint a 30-day
 * `access_token`, then the chat POST with that token as a `?access_token=` query
 * param. Both calls go through the transport seam (so tests drive them with
 * `MockTransport.setResponses([token, chat])`). The token is cached until expiry.
 *
 * Wire format differs from OpenAI: the system prompt is a separate top-level
 * `system` field, messages carry only user/assistant turns, and the reply text is
 * `result` (errors arrive as `error_code`/`error_msg` inside a 200 body).
 *
 * Tool-calling: ERNIE `functions` (request) ↔ top-level `function_call` (response)
 * are mapped. ERNIE has no tool-call ids, so we use the function *name* as the
 * LlmToolCall id — that lets a later `role:"tool"` result round-trip back to an
 * ERNIE `role:"function"` message (which needs the name) without a lookup table.
 *
 * ponytail: ERNIE emits at most ONE function_call per turn (no parallel calls),
 * and `tool_choice` is left to the model (auto). Upgrade path: map explicit
 * tool_choice + parallel calls if a model variant ever supports them.
 */
export class BaiduErnieDriver extends BaseDriver {
  readonly provider = "baidu_ernie";
  readonly model: string;
  private clientId: string;
  private clientSecret: string;
  private baseUrl: string;
  private oauthUrl: string;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    config: {
      /** Baidu app API Key (a.k.a. client_id / AK). */
      clientId: string;
      /** Baidu app Secret Key (a.k.a. client_secret / SK). */
      clientSecret: string;
      model?: string;
      /** Chat endpoint base (the model id is appended as the final path segment). */
      baseUrl?: string;
      oauthUrl?: string;
    },
    transport?: HttpTransport,
  ) {
    super(transport);
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.model = config.model ?? "ernie-4.0-8k";
    this.baseUrl =
      config.baseUrl ?? "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat";
    this.oauthUrl = config.oauthUrl ?? "https://aip.baidubce.com/oauth/2.0/token";
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const url =
      `${this.oauthUrl}?grant_type=client_credentials` +
      `&client_id=${encodeURIComponent(this.clientId)}` +
      `&client_secret=${encodeURIComponent(this.clientSecret)}`;
    const raw = (await this.transport.post(url, {}, { "Content-Type": "application/json" })) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!raw.access_token) {
      throw new LlmError(
        "AUTH_FAILED",
        raw.error_description ?? raw.error ?? "ERNIE OAuth token request failed",
        this.provider,
        401,
      );
    }
    // Refresh a minute early; default ERNIE token lifetime is 30 days.
    this.token = {
      value: raw.access_token,
      expiresAt: Date.now() + (raw.expires_in ?? 2_592_000) * 1000 - 60_000,
    };
    return this.token.value;
  }

  async complete(opts: LlmRequestOptions): Promise<LlmResponse> {
    const t0 = Date.now();
    const token = await this.getToken();
    const model = opts.model ?? this.model;

    // ERNIE: system prompt is top-level; messages carry only user/assistant turns.
    let system = opts.systemPrompt;
    const messages: Record<string, unknown>[] = [];
    for (const m of opts.messages) {
      if (m.role === "system") {
        system = system ? `${system}\n\n${m.content}` : m.content;
      } else if (m.role === "assistant" && m.toolCalls?.length) {
        // ERNIE carries a single function_call on the assistant turn (id == name).
        const tc = m.toolCalls[0]!;
        messages.push({
          role: "assistant",
          content: m.content,
          function_call: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        });
      } else if (m.role === "tool") {
        // Tool result → ERNIE `function` role; toolCallId is the function name.
        messages.push({ role: "function", name: m.toolCallId ?? "", content: m.content });
      } else if (m.role === "assistant" || m.role === "user") {
        messages.push({ role: m.role, content: m.content });
      } else {
        messages.push({ role: "user", content: m.content });
      }
    }

    const functions = opts.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    const body: Record<string, unknown> = {
      messages,
      ...(system ? { system } : {}),
      ...(functions?.length ? { functions } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { max_output_tokens: opts.maxTokens } : {}),
      ...(opts.stop ? { stop: opts.stop } : {}),
    };

    const url = `${this.baseUrl}/${encodeURIComponent(model)}?access_token=${encodeURIComponent(token)}`;
    const raw = (await this.transport.post(url, body, { "Content-Type": "application/json" })) as {
      id?: string;
      result?: string;
      function_call?: { name?: string; arguments?: string; thoughts?: string };
      error_code?: number;
      error_msg?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    // ERNIE reports failures as error_code inside an HTTP 200 body.
    if (raw.error_code) {
      const msg = raw.error_msg ?? `ERNIE error ${raw.error_code}`;
      // 110/111 = invalid/expired token; 17/18/336501 = quota / rate.
      if (raw.error_code === 110 || raw.error_code === 111) {
        this.token = null; // force re-auth next call
        throw new LlmError("AUTH_FAILED", msg, this.provider, 401);
      }
      if (raw.error_code === 17 || raw.error_code === 18 || raw.error_code === 336501) {
        throw new LlmError("RATE_LIMITED", msg, this.provider, 429);
      }
      throw new LlmError("SERVER_ERROR", msg, this.provider);
    }

    const content = raw.result ?? "";

    // Parse a native function_call (ERNIE emits at most one). Arguments arrive as
    // a JSON string; tolerate malformed args by falling back to an empty object.
    let toolCalls: LlmToolCall[] | undefined;
    if (raw.function_call?.name) {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = raw.function_call.arguments
          ? (JSON.parse(raw.function_call.arguments) as Record<string, unknown>)
          : {};
      } catch {
        /* leave args empty on malformed JSON */
      }
      // id == name so a later tool-result message can name the ERNIE `function` turn.
      toolCalls = [
        { id: raw.function_call.name, name: raw.function_call.name, arguments: parsedArgs },
      ];
    }

    const inputTokens =
      raw.usage?.prompt_tokens ?? estimateTokens(opts.messages.map((m) => m.content).join(" "));
    const outputTokens = raw.usage?.completion_tokens ?? estimateTokens(content);
    return this.makeResponse(
      raw.id ?? `${this.provider}-resp`,
      content,
      model,
      this.makeUsage(inputTokens, outputTokens),
      Date.now() - t0,
      toolCalls?.length ? "tool_calls" : "stop",
      toolCalls,
    );
  }
}

/**
 * Alibaba Cloud Bailian / DashScope (Qwen family). Uses DashScope's
 * OpenAI-compatible endpoint (`/compatible-mode/v1`), so the standard
 * chat-completions request/response shape — including tools and streaming —
 * works with zero custom adapter. Default host is the international region; set
 * `baseUrl` to the mainland host (`https://dashscope.aliyuncs.com/...`) if needed.
 *
 * ponytail: compatible-mode covers chat + tool-calling + streaming. The ceiling
 * is Qwen-only extras (e.g. partial-output / enable_search) that only the native
 * `/api/v1/services/aigc/text-generation` envelope exposes; add that adapter only
 * if such a feature is actually required.
 */
export class AlibabaBailianDriver extends OpenAICompatibleDriver {
  readonly provider = "alibaba_bailian";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
    this.model = config.model ?? "qwen-plus";
  }
}

/**
 * Dify streaming SSE event (§1.2) — the event type rides inside the data
 * payload, not in an SSE `event:` line.
 */
interface DifyStreamEvent {
  event: string;
  answer?: string;
  id?: string;
  conversation_id?: string;
  metadata?: { usage?: { prompt_tokens?: number; completion_tokens?: number } };
  // error events
  status?: number;
  code?: string;
  message?: string;
}

/**
 * Dify — an app-scoped platform, NOT a raw model API. Each Dify "app" owns its
 * model, prompt, and tools server-side; the API key authenticates one app and the
 * caller sends a single `query` string, not a messages array + model.
 *
 * We map Nexus's chat shape onto chat-messages: the latest user turn becomes
 * `query`, and the system prompt + earlier turns are folded into the query as
 * plain context. Dify threads real multi-turn server-side via conversation_id
 * (§1.2): the response carries `conversationId`, and passing it back via
 * `opts.conversationId` sends `conversation_id` on the wire so the follow-up
 * continues the same Dify conversation. Blocking mode folds context into the
 * query; streaming mode (`stream()`, response_mode "streaming") parses Dify's
 * SSE — `event: message` deltas reassemble, `event: message_end` carries usage
 * + the conversation id, `event: error` maps to a typed LlmError. Native
 * tool-calls remain the Dify app's job. With an injected (mock) transport,
 * `stream()` falls back to the blocking single-delta path like every other
 * non-OpenAI-shaped driver.
 */
export class DifyDriver extends BaseDriver {
  readonly provider = "dify";
  /** Label only — the actual model is configured inside the Dify app. */
  readonly model: string;
  private apiKey: string;
  private baseUrl: string;
  private user: string;

  constructor(
    config: { apiKey: string; model?: string; baseUrl?: string; user?: string },
    transport?: HttpTransport,
  ) {
    super(transport);
    this.apiKey = config.apiKey;
    this.model = config.model ?? "dify-app";
    this.baseUrl = config.baseUrl ?? "https://api.dify.ai/v1";
    this.user = config.user ?? "nexus";
  }

  /** Latest user turn becomes `query`; system + prior turns fold in as context. */
  private buildQuery(opts: LlmRequestOptions): { fullQuery: string; query: string } {
    const history = opts.messages.filter((m) => m.role !== "system");
    const query = history.at(-1)?.content ?? "";
    const context: string[] = [];
    if (opts.systemPrompt) context.push(opts.systemPrompt);
    for (const m of history.slice(0, -1)) context.push(`${m.role}: ${m.content}`);
    const fullQuery = context.length ? `${context.join("\n")}\n\n${query}` : query;
    return { fullQuery, query };
  }

  async complete(opts: LlmRequestOptions): Promise<LlmResponse> {
    const t0 = Date.now();
    const { fullQuery } = this.buildQuery(opts);

    const body = {
      inputs: {},
      query: fullQuery,
      response_mode: "blocking",
      user: this.user,
      ...(opts.conversationId ? { conversation_id: opts.conversationId } : {}),
    };

    const raw = (await this.transport.post(`${this.baseUrl}/chat-messages`, body, {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    })) as {
      answer?: string;
      message_id?: string;
      conversation_id?: string;
      metadata?: { usage?: { prompt_tokens?: number; completion_tokens?: number } };
      // Dify error body
      code?: string;
      message?: string;
      status?: number;
    };

    // Dify can return an error envelope (sometimes with HTTP 200 via proxies).
    if (raw.code) {
      const msg = raw.message ?? raw.code;
      if (raw.status === 401 || raw.code === "unauthorized" || raw.code === "invalid_api_key") {
        throw new LlmError("AUTH_FAILED", msg, this.provider, 401);
      }
      if (raw.status === 429) throw new LlmError("RATE_LIMITED", msg, this.provider, 429);
      throw new LlmError("SERVER_ERROR", msg, this.provider, raw.status);
    }

    const content = raw.answer ?? "";
    const inputTokens = raw.metadata?.usage?.prompt_tokens ?? estimateTokens(fullQuery);
    const outputTokens = raw.metadata?.usage?.completion_tokens ?? estimateTokens(content);
    const resp = this.makeResponse(
      raw.message_id ?? `${this.provider}-resp`,
      content,
      this.model,
      this.makeUsage(inputTokens, outputTokens),
      Date.now() - t0,
      "stop",
    );
    if (raw.conversation_id) resp.conversationId = raw.conversation_id;
    return resp;
  }

  /**
   * Real SSE streaming (§1.2): `response_mode: "streaming"`, Dify events parsed
   * from the `data:` payloads — `message`/`agent_message` deltas reassemble,
   * `message_end` carries usage + conversation_id, `error` maps to LlmError,
   * `ping` and workflow events are skipped. With an injected transport (tests),
   * falls back to the blocking single-delta path.
   */
  override async stream(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
    if (!this._useDefaultTransport) return super.stream(opts, handler);

    const t0 = Date.now();
    const { fullQuery } = this.buildQuery(opts);
    const body = {
      inputs: {},
      query: fullQuery,
      response_mode: "streaming",
      user: this.user,
      ...(opts.conversationId ? { conversation_id: opts.conversationId } : {}),
    };

    let content = "";
    let conversationId = opts.conversationId;
    let messageId = `${this.provider}-stream-${Date.now()}`;
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const payload of this.sseLines(`${this.baseUrl}/chat-messages`, body, {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    })) {
      let event: DifyStreamEvent;
      try {
        event = JSON.parse(payload) as DifyStreamEvent;
      } catch {
        continue; // malformed payload — skip, keep the stream alive
      }
      switch (event.event) {
        case "message":
        case "agent_message": {
          if (event.answer) {
            content += event.answer;
            await handler({ delta: event.answer, done: false });
          }
          if (event.conversation_id) conversationId = event.conversation_id;
          if (event.id) messageId = event.id;
          break;
        }
        case "message_replace": {
          // Moderation replaced the whole answer — emit it as one delta.
          content = event.answer ?? "";
          await handler({ delta: content, done: false });
          break;
        }
        case "message_end": {
          if (event.conversation_id) conversationId = event.conversation_id;
          if (event.metadata?.usage?.prompt_tokens)
            promptTokens = event.metadata.usage.prompt_tokens;
          if (event.metadata?.usage?.completion_tokens)
            completionTokens = event.metadata.usage.completion_tokens;
          break;
        }
        case "error": {
          const msg = event.message ?? event.code ?? "dify stream error";
          if (
            event.status === 401 ||
            event.code === "unauthorized" ||
            event.code === "invalid_api_key"
          ) {
            throw new LlmError("AUTH_FAILED", msg, this.provider, 401);
          }
          if (event.status === 429) throw new LlmError("RATE_LIMITED", msg, this.provider, 429);
          throw new LlmError("SERVER_ERROR", msg, this.provider, event.status);
        }
        default:
          break; // ping keepalive + workflow/tts events — not part of the answer
      }
    }

    const usageObj = this.makeUsage(
      promptTokens || estimateTokens(fullQuery),
      completionTokens || estimateTokens(content),
    );
    await handler({ delta: "", done: true, usage: usageObj });
    const resp = this.makeResponse(
      messageId,
      content,
      this.model,
      usageObj,
      Date.now() - t0,
      "stop",
    );
    if (conversationId) resp.conversationId = conversationId;
    return resp;
  }
}

/**
 * Local sidecar router — any self-hosted OpenAI-compatible `/v1` endpoint.
 * Routes through it to inherit its provider catalog, fallback and compression
 * without writing a native driver per provider. baseUrl required (no public
 * default); apiKey is the sidecar's own key.
 */
export class LocalRouterDriver extends OpenAICompatibleDriver {
  readonly provider = "local-router";
  readonly model: string;
  protected baseUrl: string;
  constructor(config: FullConfig & { model?: string }, transport?: HttpTransport) {
    super(config, transport);
    this.baseUrl = config.baseUrl ?? "http://localhost:20128/v1";
    this.model = config.model ?? "auto";
  }
}

// ── 35. Amazon Bedrock (SigV4) ──────────────────────────────────────────────────
// Bedrock is NOT OpenAI-compatible: it uses the Converse API body shape and signs
// every request with AWS Signature V4. We implement SigV4 here with node:crypto
// (no aws-sdk dependency) and the Converse request/response format.

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

interface SigV4Input {
  method: string;
  host: string;
  path: string;
  query: string;
  service: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  payload: string;
  contentType: string;
  /** Request time. Injectable so the signing can be tested against AWS vectors. */
  now: Date;
}

/**
 * AWS Signature Version 4. Returns the `Authorization` header value plus the
 * `x-amz-date` it signed (the caller must send both, byte-identical).
 *
 * Verified offline against AWS's published GET ListUsers test vector — see
 * tests. Scope is intentionally narrow (no chunked payloads, no presigned URLs).
 */
function signV4(i: SigV4Input): { authorization: string; amzDate: string; securityToken?: string } {
  const amzDate = i.now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${i.region}/${i.service}/aws4_request`;

  const headers: Record<string, string> = {
    "content-type": i.contentType,
    host: i.host,
    "x-amz-date": amzDate,
  };
  if (i.sessionToken) headers["x-amz-security-token"] = i.sessionToken;
  const sortedKeys = Object.keys(headers).sort();
  const signedHeaders = sortedKeys.join(";");
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join("");

  const canonicalRequest = [
    i.method,
    i.path,
    i.query,
    canonicalHeaders,
    signedHeaders,
    sha256Hex(i.payload),
  ].join("\n");

  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${i.secretAccessKey}`, date);
  const kRegion = hmac(kDate, i.region);
  const kService = hmac(kRegion, i.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate,
    ...(i.sessionToken ? { securityToken: i.sessionToken } : {}),
  };
}

/** Exported for offline signature testing only. Not part of the public driver API. */
export const __sigV4ForTest = signV4;

export interface BedrockConfig {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
  model?: string;
}

/**
 * Amazon Bedrock via the Converse API.
 *
 * ponytail: text-only — tool calls and true token streaming are NOT wired (Bedrock
 * streaming uses a binary event-stream framing that would need its own decoder).
 * stream() falls back to BaseDriver's complete()-then-single-delta path. Upgrade
 * path when needed: add toolConfig to the Converse body + an event-stream parser.
 */
export class BedrockDriver extends BaseDriver {
  readonly provider = "bedrock";
  readonly model: string;
  private region: string;
  private creds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

  constructor(config: BedrockConfig, transport?: HttpTransport) {
    super(transport);
    this.region = config.region ?? "us-east-1";
    this.creds = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
    };
    this.model = config.model ?? "anthropic.claude-3-5-sonnet-20240620-v1:0";
  }

  async complete(opts: LlmRequestOptions): Promise<LlmResponse> {
    const t0 = Date.now();
    const modelId = opts.model ?? this.model;

    // Map our messages to the Converse shape: system is a separate field, the
    // rest become role + content blocks. Tool messages collapse to user text.
    let system: string | undefined;
    const messages: Record<string, unknown>[] = [];
    for (const m of opts.messages) {
      if (m.role === "system") {
        system = system ? `${system}\n\n${m.content}` : m.content;
      } else {
        const role = m.role === "assistant" ? "assistant" : "user";
        messages.push({ role, content: [{ text: m.content }] });
      }
    }
    if (opts.systemPrompt) system = opts.systemPrompt + (system ? `\n\n${system}` : "");

    const body: Record<string, unknown> = {
      messages,
      ...(system ? { system: [{ text: system }] } : {}),
      inferenceConfig: {
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.stop ? { stopSequences: opts.stop } : {}),
      },
    };

    const host = `bedrock-runtime.${this.region}.amazonaws.com`;
    const path = `/model/${encodeURIComponent(modelId)}/converse`;
    const payload = JSON.stringify(body);
    const sig = signV4({
      method: "POST",
      host,
      path,
      query: "",
      service: "bedrock",
      region: this.region,
      accessKeyId: this.creds.accessKeyId,
      secretAccessKey: this.creds.secretAccessKey,
      sessionToken: this.creds.sessionToken,
      payload,
      contentType: "application/json",
      now: new Date(),
    });

    const headers: Record<string, string> = {
      Authorization: sig.authorization,
      "X-Amz-Date": sig.amzDate,
    };
    if (sig.securityToken) headers["X-Amz-Security-Token"] = sig.securityToken;

    const raw = (await this.transport.post(`https://${host}${path}`, body, headers)) as Record<
      string,
      unknown
    >;

    const output = raw["output"] as { message?: { content?: { text?: string }[] } } | undefined;
    const content = output?.message?.content?.map((c) => c.text ?? "").join("") ?? "";
    const usage = raw["usage"] as { inputTokens?: number; outputTokens?: number } | undefined;
    const stopReason = raw["stopReason"] as string | undefined;
    return this.makeResponse(
      `bedrock-${t0}`,
      content,
      modelId,
      this.makeUsage(
        usage?.inputTokens ?? estimateTokens(opts.messages.map((m) => m.content).join(" ")),
        usage?.outputTokens ?? estimateTokens(content),
      ),
      Date.now() - t0,
      stopReason === "max_tokens" ? "length" : "stop",
    );
  }
}

// ── 36. Google Vertex AI (OpenAI-compatible endpoint) ────────────────────────────
// Vertex exposes an OpenAI-compatible chat/completions endpoint. Auth is a Google
// OAuth2 access token (Bearer). We treat that token as the BYOK "apiKey" — the
// caller mints it (gcloud / a service-account exchange) so we avoid pulling in
// google-auth-library. baseUrl is derived from the GCP project + region.

export interface VertexConfig {
  apiKey: string;
  project: string;
  region?: string;
  model?: string;
}

export class VertexDriver extends OpenAICompatibleDriver {
  readonly provider = "vertex";
  readonly model: string;
  protected baseUrl: string;

  constructor(config: VertexConfig, transport?: HttpTransport) {
    super(config, transport);
    const region = config.region ?? "us-central1";
    this.baseUrl = `https://${region}-aiplatform.googleapis.com/v1/projects/${config.project}/locations/${region}/endpoints/openapi`;
    this.model = config.model ?? "gemini-3.6-flash";
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
  | "codestral"
  | "xai"
  | "together"
  | "perplexity"
  | "cohere"
  | "zhipu"
  | "moonshot"
  | "zeroone"
  | "baichuan"
  | "minimax"
  | "stepfun"
  | "novita"
  | "siliconflow"
  | "hyperbolic"
  | "chutes"
  | "nebius"
  | "venice"
  | "qwen"
  | "ai360"
  | "vercel_ai_gateway"
  | "doubao"
  | "byteplus"
  | "hunyuan"
  | "spark"
  | "azure_openai"
  | "cloudflare"
  | "xinference"
  | "replicate"
  | "bedrock"
  | "vertex";

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
  | "fp16" // Full 16-bit (default, no compression)
  | "fp32" // 32-bit (high accuracy, 2× memory vs fp16)
  | "int8" // 8-bit quantization (≈2× speedup, small accuracy loss)
  | "int4"; // 4-bit quantization (≈4× speedup, moderate accuracy loss)

/**
 * Strategy for splitting model weights across memory tiers.
 * Ported from airllm's layer-shard concept.
 */
export type LayerShardStrategy =
  | "none" // Load entire model into memory at once
  | "layer" // Layer-by-layer: load one layer, infer, unload (airllm default)
  | "pipeline"; // Pipeline-parallel across multiple devices

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
  fetchFn: typeof fetch = fetch,
): Promise<LocalModelManifest> {
  const baseUrl = config.serverUrl.replace(/\/$/, "");
  const now = new Date().toISOString();
  try {
    const res = await fetchFn(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Ollama returns { models: [{ name, details: { family, parameter_size } }] }
    const data = (await res.json()) as {
      models?: { name: string; details?: { family?: string; parameter_size?: string } }[];
    };
    const match = (data.models ?? []).find(
      (m) => m.name === config.modelId || m.name.startsWith(config.modelId.split(":")[0] ?? ""),
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
