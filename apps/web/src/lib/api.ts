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

  /** List available gateway model aliases + configured providers. */
  gatewayModels: () =>
    request<{ models: { id: string; provider: string; backend_model: string; available: boolean }[]; providers: string[] }>(
      "GET",
      "/api/v1/gateway/models",
    ),

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
    request<{ original: string; transformed: string; modules: unknown[]; truncated: boolean; charCount: number }>(
      "POST",
      "/api/v1/stm/transform",
      { text, moduleIds, maxChars },
    ),

  stmTransformPartial: (text: string, moduleIds?: string[], maxChars?: number) =>
    request<{ original: string; transformed: string; modules: unknown[]; truncated: boolean; charCount: number }>(
      "POST",
      "/api/v1/stm/transform/partial",
      { text, moduleIds, maxChars },
    ),

  // ── Chat suggestions ─────────────────────────────────────────────────────

  chatSuggestions: (lastMessage?: string, limit = 3) =>
    request<{ suggestions: string[]; total: number }>(
      "POST",
      "/api/v1/chat-suggestions",
      { last_message: lastMessage, limit },
    ),

  chatSuggestionTopics: (limit = 6) =>
    request<{ topics: string[]; total: number }>(
      "GET",
      `/api/v1/chat-suggestions/topics?limit=${limit}`,
    ),

  // ── Wiki ─────────────────────────────────────────────────────────────────

  wikiArticles: () =>
    request<{ articles: WikiArticle[]; total: number }>("GET", "/api/v1/wiki/articles"),

  wikiArticle: (id: string) =>
    request<WikiArticle>("GET", `/api/v1/wiki/articles/${id}`),

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

  wikiDeleteArticle: (id: string) =>
    request<void>("DELETE", `/api/v1/wiki/articles/${id}`),

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

  corpusBatch: (id: string) =>
    request<unknown>("GET", `/api/v1/corpus/batches/${id}`),

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

  corpusPending: () =>
    request<{ pending: number }>("GET", "/api/v1/corpus/pending"),

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

  obsGenerate: (sessionId: string, events: { role: string; content: string }[], opts?: { category?: string; tags?: string[] }) =>
    request<{ observation: unknown | null; result: unknown }>(
      "POST",
      "/api/v1/obs/generate",
      { sessionId, events, ...opts },
    ),

  obsStore: (content: string, opts?: { category?: string; tags?: string[]; confidence?: number; sessionId?: string }) =>
    request<MemoryEntry>("POST", "/api/v1/obs/store", { content, ...opts }),

  obsDelete: (id: string) =>
    request<void>("DELETE", `/api/v1/obs/${id}`),

  obsProviders: () =>
    request<{ providers: { name: string; model: string }[] }>("GET", "/api/v1/obs/providers"),
};
