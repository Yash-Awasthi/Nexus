// SPDX-License-Identifier: Apache-2.0
const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
const KEY = (import.meta.env.VITE_API_KEY as string | undefined) ?? "";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (KEY) headers.Authorization = `Bearer ${KEY}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Gateway / Chat types ──────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  id: string;
  content: { type: "text"; text: string }[];
  model: string;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

// ── Memory types ──────────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  content: string;
  category?: string;
  tags?: string[];
  confidence?: number;
  createdAt: string;
}

// ── Wiki types ────────────────────────────────────────────────────────────────

export interface WikiArticle {
  id: string;
  title: string;
  content: string;
  tags: string[];
  updatedAt: string;
  version: number;
}

// ── Corpus types ──────────────────────────────────────────────────────────────

export type SampleTag = "preferred" | "rejected" | "neutral" | "flagged";
export type DataTier = "free" | "pro" | "enterprise";

// ── API surface ───────────────────────────────────────────────────────────────

export const api = {
  get: <T>(path: string) => request<T>("GET", `/api/v1${path}`),
  post: <T>(path: string, b: unknown) => request<T>("POST", `/api/v1${path}`, b),
  patch: <T>(path: string, b: unknown) => request<T>("PATCH", `/api/v1${path}`, b),
  delete: <T>(path: string) => request<T>("DELETE", `/api/v1${path}`),
  health: () => request<{ status: string; timestamp: string }>("GET", "/health"),

  // ── Gateway ──────────────────────────────────────────────────────────────

  /** Send messages via the Model Gateway (Anthropic-format proxy). */
  chat: async (
    messages: ChatMessage[],
    model = "nexus/smart",
    system?: string,
  ): Promise<ChatResponse> =>
    request<ChatResponse>("POST", "/api/v1/gateway/messages", {
      model,
      messages,
      max_tokens: 2048,
      ...(system && { system }),
    }),

  /**
   * Send messages with real-time SSE token streaming.
   *
   * Opens a fetch ReadableStream to POST /gateway/messages with stream:true.
   * Parses Anthropic-format SSE events; calls onDelta() for each text token
   * as it arrives so the UI can render incrementally.
   * Resolves with a full ChatResponse once the stream closes.
   */
  chatStream: async (
    messages: ChatMessage[],
    model = "nexus/smart",
    system?: string,
    onDelta?: (delta: string) => void,
  ): Promise<ChatResponse> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (KEY) headers.Authorization = `Bearer ${KEY}`;

    const res = await fetch(`${BASE}/api/v1/gateway/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 2048,
        stream: true,
        ...(system && { system }),
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status}: ${text}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let lineBuf = "";
    let fullText = "";
    let responseId = `stream-${Date.now()}`;
    let responseModel = model;
    let outputTokens = 0;
    let done = false;

    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;

      lineBuf += decoder.decode(chunk.value, { stream: true });
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") {
          done = true;
          break;
        }

        try {
          const event = JSON.parse(raw) as Record<string, unknown>;
          const evType = event.type as string;

          if (evType === "message_start") {
            const msg = event.message as Record<string, unknown>;
            if (msg.id) responseId = msg.id as string;
            if (msg.model) responseModel = msg.model as string;
          } else if (evType === "content_block_delta") {
            const delta = event.delta as Record<string, unknown>;
            if (delta.type === "text_delta" && typeof delta.text === "string") {
              fullText += delta.text as string;
              onDelta?.(delta.text as string);
            }
          } else if (evType === "message_delta") {
            const usage = event.usage as Record<string, unknown> | undefined;
            if (typeof usage?.output_tokens === "number") {
              outputTokens = usage.output_tokens as number;
            }
          }
        } catch {
          /* malformed JSON event — skip and continue */
        }
      }
    }

    return {
      id: responseId,
      content: [{ type: "text", text: fullText }],
      model: responseModel,
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: outputTokens },
    };
  },

  /** List available gateway model aliases + configured providers. */
  gatewayModels: () =>
    request<{
      models: { id: string; provider: string; backend_model: string; available: boolean }[];
      providers: string[];
    }>("GET", "/api/v1/gateway/models"),

  // ── Context pack ─────────────────────────────────────────────────────────

  contextPack: (opts?: {
    agent_role?: string;
    memory_query?: string;
    extra_context?: string;
    max_tokens?: number;
  }) =>
    request<{
      system_prompt: string;
      total_token_estimate: number;
      assembled_at: string;
      was_trimmed: boolean;
    }>("POST", "/api/v1/context-pack", opts ?? {}),

  // ── STM ──────────────────────────────────────────────────────────────────

  stmModules: () =>
    request<{ modules: { id: string; description: string }[]; total: number }>(
      "GET",
      "/api/v1/stm/modules",
    ),

  stmTransform: (text: string, moduleIds?: string[], maxChars?: number) =>
    request<{
      original: string;
      transformed: string;
      modules: unknown[];
      truncated: boolean;
      charCount: number;
    }>("POST", "/api/v1/stm/transform", { text, moduleIds, maxChars }),

  stmTransformPartial: (text: string, moduleIds?: string[], maxChars?: number) =>
    request<{
      original: string;
      transformed: string;
      modules: unknown[];
      truncated: boolean;
      charCount: number;
    }>("POST", "/api/v1/stm/transform/partial", { text, moduleIds, maxChars }),

  // ── Chat suggestions ─────────────────────────────────────────────────────

  chatSuggestions: (lastMessage?: string, limit = 3) =>
    request<{ suggestions: string[]; total: number }>("POST", "/api/v1/chat-suggestions", {
      last_message: lastMessage,
      limit,
    }),

  chatSuggestionTopics: (limit = 6) =>
    request<{ topics: string[]; total: number }>(
      "GET",
      `/api/v1/chat-suggestions/topics?limit=${limit}`,
    ),

  // ── Wiki ─────────────────────────────────────────────────────────────────

  wikiArticles: () =>
    request<{ articles: WikiArticle[]; total: number }>("GET", "/api/v1/wiki/articles"),

  wikiArticle: (id: string) => request<WikiArticle>("GET", `/api/v1/wiki/articles/${id}`),

  wikiSearch: (q: string, limit = 10) =>
    request<{ articles: WikiArticle[]; total: number }>(
      "GET",
      `/api/v1/wiki/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),

  wikiUpdate: (document: { id: string; content: string; source?: string }, dryRun = false) =>
    request<{ articleId: string | null; created: boolean; updated: boolean; dryRun: boolean }>(
      "POST",
      "/api/v1/wiki/update",
      { document, dryRun },
    ),

  wikiDeleteArticle: (id: string) => request<undefined>("DELETE", `/api/v1/wiki/articles/${id}`),

  wikiReindex: () =>
    request<{ terms: number; articles: number }>("POST", "/api/v1/wiki/reindex", {}),

  // ── Domain feeds ─────────────────────────────────────────────────────────

  domainFeeds: () =>
    request<{ domains: { domain: string; count: number; latest: string | null }[] }>(
      "GET",
      "/api/v1/domain-feeds",
    ),

  domainFeed: (domain: string, limit = 50) =>
    request<{ domain: string; entries: unknown[]; total: number }>(
      "GET",
      `/api/v1/domain-feeds/${domain}?limit=${limit}`,
    ),

  domainFeedPush: (domain: string, payload: Record<string, unknown>, source?: string) =>
    request<{ id: string; domain: string; createdAt: string }>(
      "POST",
      `/api/v1/domain-feeds/${domain}`,
      { payload, source },
    ),

  // ── Corpus builder ───────────────────────────────────────────────────────

  corpusBatches: (limit?: number) =>
    request<{ batches: unknown[]; total: number }>(
      "GET",
      `/api/v1/corpus/batches${limit ? `?limit=${limit}` : ""}`,
    ),

  corpusBatch: (id: string) => request<unknown>("GET", `/api/v1/corpus/batches/${id}`),

  corpusAddSample: (sample: {
    prompt: string;
    completion: string;
    tag?: SampleTag;
    model?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }) => request<unknown>("POST", "/api/v1/corpus/samples", sample),

  corpusQuery: (filter: {
    tier?: DataTier;
    tags?: SampleTag[];
    fromDate?: string;
    toDate?: string;
    model?: string;
    limit?: number;
  }) => request<{ samples: unknown[]; total: number }>("POST", "/api/v1/corpus/query", filter),

  corpusFlush: (name?: string) =>
    request<{ batchId: string; repoId: string; sampleCount: number; success: boolean }>(
      "POST",
      "/api/v1/corpus/flush",
      { name },
    ),

  corpusPending: () => request<{ pending: number }>("GET", "/api/v1/corpus/pending"),

  // ── Observation providers / Memory ────────────────────────────────────────

  /** Fetch observations as MemoryEntry[] (powers MemoryTimeline). */
  obsMemories: (opts?: { limit?: number; category?: string }) => {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.category) params.set("category", opts.category);
    const qs = params.toString();
    return request<{ memories: MemoryEntry[]; total: number }>(
      "GET",
      `/api/v1/obs/memories${qs ? `?${qs}` : ""}`,
    );
  },

  obsGenerate: (
    sessionId: string,
    events: { role: string; content: string }[],
    opts?: { category?: string; tags?: string[] },
  ) =>
    request<{ observation: unknown | null; result: unknown }>("POST", "/api/v1/obs/generate", {
      sessionId,
      events,
      ...opts,
    }),

  obsStore: (
    content: string,
    opts?: { category?: string; tags?: string[]; confidence?: number; sessionId?: string },
  ) => request<MemoryEntry>("POST", "/api/v1/obs/store", { content, ...opts }),

  obsDelete: (id: string) => request<undefined>("DELETE", `/api/v1/obs/${id}`),

  obsProviders: () =>
    request<{ providers: { name: string; model: string }[] }>("GET", "/api/v1/obs/providers"),

  // ── Knowledge Graph ───────────────────────────────────────────────────────

  kgNodes: (opts?: { type?: string; limit?: number; minConfidence?: number }) => {
    const p = new URLSearchParams();
    if (opts?.type) p.set("type", opts.type);
    if (opts?.limit) p.set("limit", String(opts.limit));
    if (opts?.minConfidence) p.set("minConfidence", String(opts.minConfidence));
    return request<{ nodes: unknown[]; edges: unknown[]; totalNodes: number; totalEdges: number }>(
      "GET",
      `/api/v1/knowledge-graph/nodes${p.toString() ? `?${p}` : ""}`,
    );
  },

  kgSearch: (q: string, k = 20) =>
    request<{ nodes: unknown[]; edges: unknown[]; totalNodes: number; totalEdges: number }>(
      "GET",
      `/api/v1/knowledge-graph/search?q=${encodeURIComponent(q)}&k=${k}`,
    ),

  kgNode: (id: string) => request<unknown>("GET", `/api/v1/knowledge-graph/nodes/${id}`),

  kgRelated: (id: string, direction?: "outbound" | "inbound" | "both") =>
    request<{ node: unknown; neighbors: unknown[] }>(
      "GET",
      `/api/v1/knowledge-graph/nodes/${id}/related${direction ? `?direction=${direction}` : ""}`,
    ),

  kgIngest: (text: string, source?: string) =>
    request<{ nodesAdded: number; nodesMerged: number; edgesAdded: number; edgesMerged: number }>(
      "POST",
      "/api/v1/knowledge-graph/ingest",
      { text, source },
    ),

  kgStats: () =>
    request<{ nodes: number; edges: number; nodesByType: Record<string, number> }>(
      "GET",
      "/api/v1/knowledge-graph/stats",
    ),

  kgDeleteNode: (id: string) => request<undefined>("DELETE", `/api/v1/knowledge-graph/nodes/${id}`),

  // ── Image Gen ─────────────────────────────────────────────────────────────

  imageGenerate: (opts: {
    prompt: string;
    negativePrompt?: string;
    model?: string;
    size?: string;
    n?: number;
    style?: "vivid" | "natural";
  }) =>
    request<{
      images: {
        id: string;
        url: string;
        prompt: string;
        model: string;
        size: string;
        createdAt: string;
      }[];
      latencyMs: number;
    }>("POST", "/api/v1/image-gen/generate", opts),

  imageModels: () =>
    request<{ models: { id: string; label: string; provider: string; available: boolean }[] }>(
      "GET",
      "/api/v1/image-gen/models",
    ),

  imageHistory: (limit = 20) =>
    request<{ images: unknown[]; total: number }>(
      "GET",
      `/api/v1/image-gen/history?limit=${limit}`,
    ),

  // ── Voice ─────────────────────────────────────────────────────────────────

  voiceChat: (text: string, voice?: string) =>
    request<{ text: string; latencyMs: number }>("POST", "/api/v1/voice/chat", { text, voice }),

  voiceTranscribe: (audioBase64: string, format = "wav", sampleRate = 16000) =>
    request<{ transcript: string; latencyMs: number }>("POST", "/api/v1/voice/transcribe", {
      audio: audioBase64,
      format,
      sampleRate,
    }),

  voiceVoices: () =>
    request<{ voices: { id: string; label: string; provider: string }[] }>(
      "GET",
      "/api/v1/voice/voices",
    ),

  voiceProviders: () =>
    request<{ transcribe: unknown; synthesize: unknown }>("GET", "/api/v1/voice/providers"),

  // ── Billing ───────────────────────────────────────────────────────────────

  billingPlan: () =>
    request<{
      plan: {
        name: string;
        price: number;
        tier: string;
        features: string[];
        tokensPerMonth: number;
      };
    }>("GET", "/api/v1/billing/plan"),

  billingPeriod: () =>
    request<{
      period: {
        startDate: string;
        endDate: string;
        tokensUsed: number;
        tokensLimit: number;
        requestsCount: number;
      };
    }>("GET", "/api/v1/billing/current-period"),

  billingKeys: () => request<{ keys: unknown[] }>("GET", "/api/v1/billing/keys"),

  billingCreateKey: (name: string, scopes?: string[]) =>
    request<{ id: string; name: string; rawKey: string; keyPrefix: string; createdAt: number }>(
      "POST",
      "/api/v1/billing/keys",
      { name, scopes },
    ),

  billingRevokeKey: (id: string) => request<undefined>("DELETE", `/api/v1/billing/keys/${id}`),

  /** Create a Stripe Checkout session — caller must redirect to returned url. */
  billingCheckout: (
    plan: "pro" | "enterprise",
    opts?: { successUrl?: string; cancelUrl?: string },
  ) =>
    request<{ sessionId: string; url: string }>("POST", "/api/v1/billing/checkout", {
      plan,
      ...opts,
    }),

  /** Create a Stripe Customer Portal session — caller must redirect to returned url. */
  billingPortal: (returnUrl?: string) =>
    request<{ url: string }>("POST", "/api/v1/billing/portal", { returnUrl }),

  billingQuota: () =>
    request<{ allowed: boolean; reason?: string; tokensRemaining?: number }>(
      "GET",
      "/api/v1/billing/quota",
    ),

  // ── Admin ─────────────────────────────────────────────────────────────────

  adminRoutes: () =>
    request<{
      routes: { alias: string; model: string; provider: string; overridden: boolean }[];
      total: number;
    }>("GET", "/api/v1/admin/routes"),

  adminStats: (alias?: string) =>
    request<{
      stats: {
        alias: string;
        requests: number;
        totalTokens: number;
        errors: number;
        avgLatencyMs: number;
      }[];
    }>("GET", `/api/v1/admin/stats${alias ? `?alias=${encodeURIComponent(alias)}` : ""}`),

  adminSettings: () =>
    request<{
      settings: {
        tracing: boolean;
        logLevel: string;
        rateLimitRpm: number;
        maxTokens: number;
        defaultModel: string;
      };
    }>("GET", "/api/v1/admin/settings"),

  adminUpdateSettings: (patch: Record<string, unknown>) =>
    request<{ settings: unknown }>("POST", "/api/v1/admin/settings", patch),

  adminAddRoute: (alias: string, model: string, provider: string) =>
    request<{ alias: string; model: string; provider: string }>("POST", "/api/v1/admin/routes", {
      alias,
      model,
      provider,
    }),

  adminOverrideAlias: (alias: string, model: string) =>
    request<{ alias: string; overrideModel: string }>(
      "POST",
      `/api/v1/admin/routes/${encodeURIComponent(alias)}/override`,
      { model },
    ),

  // ── Feature Flags ─────────────────────────────────────────────────────────

  featureFlags: () =>
    request<{
      flags: {
        key: string;
        value: boolean | string | number;
        default: unknown;
        type: string;
        description?: string;
        overridden: boolean;
      }[];
      total: number;
    }>("GET", "/api/v1/feature-flags"),

  featureFlagSet: (key: string, value: boolean | string | number) =>
    request<{ key: string; value: unknown; overridden: boolean }>(
      "PATCH",
      `/api/v1/feature-flags/${encodeURIComponent(key)}`,
      { value },
    ),

  featureFlagReset: (key: string) =>
    request<undefined>("DELETE", `/api/v1/feature-flags/${encodeURIComponent(key)}`),

  // ── Connectors ────────────────────────────────────────────────────────────

  connectors: () =>
    request<{
      connectors: {
        id: string;
        name: string;
        type: string;
        status: string;
        enabled: boolean;
        error?: string;
      }[];
      total: number;
    }>("GET", "/api/v1/connectors"),

  connectorToggle: (id: string, enabled: boolean) =>
    request<unknown>("PATCH", `/api/v1/connectors/${id}`, { enabled }),

  connectorConnect: (id?: string) =>
    request<unknown>("POST", "/api/v1/connectors/connect", id ? { id } : {}),

  connectorHealth: (id: string) =>
    request<{ ok: boolean; latencyMs: number; error?: string }>(
      "POST",
      `/api/v1/connectors/${id}/health`,
      {},
    ),

  connectorReconnect: (id: string) =>
    request<{ ok: boolean; error?: string }>("POST", `/api/v1/connectors/${id}/reconnect`, {}),

  // ── Council ───────────────────────────────────────────────────────────────

  /** Paginated list of verdicts (newest first). */
  councilVerdicts: (limit = 20, offset = 0) =>
    request<{ verdicts: unknown[]; limit: number; offset: number }>(
      "GET",
      `/api/v1/council/verdicts?limit=${limit}&offset=${offset}`,
    ),

  /** Single verdict by ID. */
  councilVerdict: (verdictId: string) =>
    request<unknown>("GET", `/api/v1/council/verdicts/${verdictId}`),

  /** Transcript for a verdict. */
  councilTranscript: (verdictId: string) =>
    request<unknown>("GET", `/api/v1/council/transcripts/${verdictId}`),

  /** Trigger deliberation for an existing signal by ID. */
  councilTrigger: (signalId: string, budgetUsd?: number, timeoutMs?: number) =>
    request<{ ok: boolean; result: unknown }>("POST", "/api/v1/council/trigger", {
      signalId,
      budgetUsd,
      timeoutMs,
    }),
};
