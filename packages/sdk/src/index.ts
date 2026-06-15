// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/sdk — Public SDK for integrating with the Nexus multi-agent platform.
 *
 * Provides:
 *   • NexusClient        — main entry point; sends messages, manages sessions
 *   • ChatSession        — stateful chat session with history
 *   • ToolDefinition     — define custom tools the agent can invoke
 *   • WebhookValidator   — verify Nexus webhook signatures (HMAC-SHA256)
 *   • NexusError         — typed error class
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NexusClientConfig {
  apiKey: string;
  baseUrl?: string;    // default: https://api.nexus.dev
  timeout?: number;    // ms; default: 30_000
  defaultModel?: string;
  version?: string;    // API version; default: "v1"
}

/** Send message options interface definition. */
export interface SendMessageOptions {
  sessionId?: string;
  model?: string;
  tools?: ToolDefinition[];
  systemPrompt?: string;
  maxTokens?: number;
  stream?: boolean;
}

/** Nexus message interface definition. */
export interface NexusMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Send message result interface definition. */
export interface SendMessageResult {
  id: string;
  content: string;
  model: string;
  sessionId: string;
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
}

/** Tool definition interface definition. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description?: string; required?: boolean }>;
}

/** Session info interface definition. */
export interface SessionInfo {
  sessionId: string;
  model: string;
  createdAt: string;
  messageCount: number;
  metadata?: Record<string, unknown>;
}

// ── NexusError ─────────────────────────────────────────────────────────────────

export class NexusError extends Error {
  constructor(
    public readonly code:
      | "AUTH_ERROR"
      | "RATE_LIMIT"
      | "NOT_FOUND"
      | "TIMEOUT"
      | "INVALID_REQUEST"
      | "SERVER_ERROR",
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "NexusError";
  }
}

// ── HttpTransport (injectable for testing) ────────────────────────────────────

export interface HttpTransport {
  post(url: string, body: unknown, headers: Record<string, string>): Promise<unknown>;
  get(url: string, headers: Record<string, string>): Promise<unknown>;
}

/** Mock http transport. */
export class MockHttpTransport implements HttpTransport {
  readonly requests: Array<{ method: "POST" | "GET"; url: string; body?: unknown }> = [];
  private handlers = new Map<string, () => unknown>();

  onPost(urlSuffix: string, response: () => unknown): this {
    this.handlers.set("POST:" + urlSuffix, response);
    return this;
  }

  async post(url: string, body: unknown, _headers: Record<string, string>): Promise<unknown> {
    this.requests.push({ method: "POST", url, body });
    for (const [key, handler] of this.handlers) {
      if (key.startsWith("POST:") && url.endsWith(key.slice(5))) return handler();
    }
    return {};
  }

  async get(url: string, _headers: Record<string, string>): Promise<unknown> {
    this.requests.push({ method: "GET", url });
    return {};
  }
}

// ── NexusClient ───────────────────────────────────────────────────────────────

export class NexusClient {
  private config: Required<NexusClientConfig>;
  private transport: HttpTransport;

  constructor(config: NexusClientConfig, transport?: HttpTransport) {
    this.config = {
      apiKey:       config.apiKey,
      baseUrl:      config.baseUrl ?? "https://api.nexus.dev",
      timeout:      config.timeout ?? 30_000,
      defaultModel: config.defaultModel ?? "claude-3-5-sonnet-20241022",
      version:      config.version ?? "v1",
    };
    this.transport = transport ?? this.makeDefaultTransport();
  }

  private makeDefaultTransport(): HttpTransport {
    return {
      post: async (url, body, headers) => {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.timeout),
        });
        if (!resp.ok) this.handleHttpError(resp.status);
        return resp.json();
      },
      get: async (url, headers) => {
        const resp = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(this.config.timeout),
        });
        if (!resp.ok) this.handleHttpError(resp.status);
        return resp.json();
      },
    };
  }

  private handleHttpError(status: number): never {
    if (status === 401) throw new NexusError("AUTH_ERROR", "Unauthorized", status);
    if (status === 429) throw new NexusError("RATE_LIMIT", "Rate limit exceeded", status);
    if (status === 404) throw new NexusError("NOT_FOUND", "Resource not found", status);
    throw new NexusError("SERVER_ERROR", `HTTP ${status}`, status);
  }

  private headers(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.config.apiKey}`,
      "X-Nexus-Version": this.config.version,
    };
  }

  private url(path: string): string {
    return `${this.config.baseUrl}/${this.config.version}${path}`;
  }

  async sendMessage(
    message: string,
    opts: SendMessageOptions = {},
  ): Promise<SendMessageResult> {
    const t0 = Date.now();
    const body = {
      message,
      model:         opts.model ?? this.config.defaultModel,
      session_id:    opts.sessionId,
      tools:         opts.tools,
      system_prompt: opts.systemPrompt,
      max_tokens:    opts.maxTokens,
    };
    const raw = await this.transport.post(this.url("/chat"), body, this.headers()) as Partial<SendMessageResult & { duration_ms?: number }>;
    return {
      id:         (raw as { id?: string }).id ?? "unknown",
      content:    (raw as { content?: string }).content ?? "",
      model:      (raw as { model?: string }).model ?? opts.model ?? this.config.defaultModel,
      sessionId:  (raw as { sessionId?: string; session_id?: string }).sessionId ?? (raw as { session_id?: string }).session_id ?? opts.sessionId ?? "",
      usage:      (raw as { usage?: { inputTokens: number; outputTokens: number } }).usage ?? { inputTokens: 0, outputTokens: 0 },
      durationMs: Date.now() - t0,
    };
  }

  createSession(model?: string): ChatSession {
    return new ChatSession(this, model ?? this.config.defaultModel);
  }

  get apiKey(): string { return this.config.apiKey; }
  get baseUrl(): string { return this.config.baseUrl; }
  get defaultModel(): string { return this.config.defaultModel; }
}

// ── ChatSession ───────────────────────────────────────────────────────────────

export class ChatSession {
  private _messages: NexusMessage[] = [];
  readonly sessionId: string;

  constructor(
    private client: NexusClient,
    public model: string,
  ) {
    this.sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  get messages(): NexusMessage[] { return [...this._messages]; }
  get messageCount(): number { return this._messages.length; }

  async send(message: string, opts: Omit<SendMessageOptions, "sessionId"> = {}): Promise<SendMessageResult> {
    this._messages.push({ role: "user", content: message });
    const result = await this.client.sendMessage(message, {
      ...opts,
      sessionId: this.sessionId,
      model: opts.model ?? this.model,
    });
    this._messages.push({ role: "assistant", content: result.content });
    return result;
  }

  setSystemPrompt(prompt: string): this {
    // Remove any previous system message
    const idx = this._messages.findIndex((m) => m.role === "system");
    if (idx !== -1) this._messages.splice(idx, 1);
    this._messages.unshift({ role: "system", content: prompt });
    return this;
  }

  clear(): this {
    this._messages = [];
    return this;
  }
}

// ── WebhookValidator ──────────────────────────────────────────────────────────

export interface WebhookValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate a Nexus webhook signature.
 * Nexus signs the raw body with HMAC-SHA256 using your webhook secret.
 * Header: X-Nexus-Signature: sha256=<hex>
 */
export async function validateWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): Promise<WebhookValidationResult> {
  if (!signatureHeader.startsWith("sha256=")) {
    return { valid: false, reason: "Signature header must start with sha256=" };
  }
  const sigHex = signatureHeader.slice(7);

  try {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const msgData = encoder.encode(rawBody);

    const cryptoKey = await crypto.subtle.importKey(
      "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
    const expectedHex = Array.from(new Uint8Array(sigBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return expectedHex === sigHex
      ? { valid: true }
      : { valid: false, reason: "Signature mismatch" };
  } catch {
    return { valid: false, reason: "Crypto operation failed" };
  }
}

// ── Version ───────────────────────────────────────────────────────────────────

export const SDK_VERSION = "0.1.0";
