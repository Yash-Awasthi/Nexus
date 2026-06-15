// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/gateway — Model Gateway
 *
 * Exposes an Anthropic Messages API-compatible interface and routes requests
 * to any OpenAI-compatible backend (Groq, local Ollama, OpenAI, etc.).
 *
 * Features
 * --------
 *  • Model alias table  — "nexus/smart", "nexus/fast", claude-* names all resolve
 *  • Provider registry  — per-provider base URLs and env-key names
 *  • Format translation — Anthropic ↔ OpenAI chat/completions
 *  • Streaming          — pass-through SSE when stream:true (chunked fetch)
 *  • Override header    — x-nexus-provider: groq|openai|local overrides routing
 *
 * Usage (library)
 * ---------------
 *   import { routeMessage, type GatewayConfig } from "@nexus/gateway";
 *
 *   const response = await routeMessage(anthropicRequest, {
 *     providers: { groq: { apiKey: process.env.GROQ_API_KEY! } },
 *   });
 */

import { randomUUID } from "crypto";

// ── Public types ──────────────────────────────────────────────────────────────

export type ContentBlockType = "text";

/** Text block interface definition. */
export interface TextBlock {
  type: "text";
  text: string;
}

/** Content block type alias. */
export type ContentBlock = TextBlock;

/** Anthropic message interface definition. */
export interface AnthropicMessage {
  role: "user" | "assistant";
  /** String shorthand OR structured content blocks */
  content: string | ContentBlock[];
}

/** Anthropic request interface definition. */
export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  /** Optional system prompt (Anthropic top-level field) */
  system?: string;
  max_tokens?: number;
  temperature?: number;
  /** When true, caller handles SSE stream — routeMessage returns a Response */
  stream?: boolean;
  metadata?: { user_id?: string };
}

/** Anthropic usage interface definition. */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

/** Anthropic response interface definition. */
export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

/** Provider config interface definition. */
export interface ProviderConfig {
  /** API key for this provider */
  apiKey: string;
  /** Override base URL (e.g. point at a local Ollama instance) */
  baseUrl?: string;
}

/** Gateway config interface definition. */
export interface GatewayConfig {
  providers: {
    groq?: ProviderConfig;
    openai?: ProviderConfig;
    local?: ProviderConfig;
    [name: string]: ProviderConfig | undefined;
  };
  /**
   * Additional model aliases merged with the built-in table.
   * Key: model name sent by the client.
   * Value: { provider, model } to use.
   */
  extraAliases?: Record<string, ModelTarget>;
}

/** Model target interface definition. */
export interface ModelTarget {
  provider: string;
  model: string;
}

/** Gateway error interface definition. */
export interface GatewayError extends Error {
  code: "MODEL_NOT_FOUND" | "PROVIDER_NOT_CONFIGURED" | "UPSTREAM_ERROR" | "UNSUPPORTED_CONTENT";
  statusCode: number;
  upstream?: { status: number; body: string };
}

// ── Internal OpenAI types ─────────────────────────────────────────────────────

interface OAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OAIRequest {
  model: string;
  messages: OAIMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

interface OAIChoice {
  message: { role: string; content: string | null };
  finish_reason: string | null;
}

interface OAIResponse {
  id: string;
  choices: OAIChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

// ── Model alias table ─────────────────────────────────────────────────────────

const GROQ_SMART = "llama-3.3-70b-versatile";
const GROQ_FAST = "llama-3.1-8b-instant";

/** Built-in aliases. Client model names → { provider, backendModel } */
export const BUILTIN_ALIASES: Record<string, ModelTarget> = {
  // Nexus shorthand
  "nexus/smart": { provider: "groq", model: GROQ_SMART },
  "nexus/planner": { provider: "groq", model: GROQ_SMART },
  "nexus/fast": { provider: "groq", model: GROQ_FAST },
  "nexus/eval": { provider: "groq", model: GROQ_FAST },
  // Claude passthrough aliases (remap to Groq equivalents by default)
  "claude-3-5-sonnet-20241022": { provider: "groq", model: GROQ_SMART },
  "claude-3-5-haiku-20241022": { provider: "groq", model: GROQ_FAST },
  "claude-3-haiku-20240307": { provider: "groq", model: GROQ_FAST },
  "claude-3-opus-20240229": { provider: "groq", model: GROQ_SMART },
};

/** Built-in provider base URLs */
const DEFAULT_BASE_URLS: Record<string, string> = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  local: "http://localhost:11434/v1/chat/completions",
};

// ── GatewayError factory ──────────────────────────────────────────────────────

function makeGatewayError(
  message: string,
  code: GatewayError["code"],
  statusCode: number,
  upstream?: { status: number; body: string },
): GatewayError {
  const err = new Error(message) as GatewayError;
  err.code = code;
  err.statusCode = statusCode;
  err.upstream = upstream;
  return err;
}

// ── Model resolution ──────────────────────────────────────────────────────────

export function resolveModel(
  clientModel: string,
  config: GatewayConfig,
  overrideProvider?: string,
): ModelTarget {
  const aliases: Record<string, ModelTarget> = {
    ...BUILTIN_ALIASES,
    ...(config.extraAliases ?? {}),
  };

  // Prefer alias lookup first
  const aliased = aliases[clientModel];

  if (aliased) {
    // If caller overrides the provider, keep the resolved model but swap provider
    return overrideProvider ? { provider: overrideProvider, model: aliased.model } : aliased;
  }

  // If the model name looks like a llama/mistral/gemma style name, pass through to override or groq
  const provider = overrideProvider ?? "groq";
  return { provider, model: clientModel };
}

// ── Format translation ────────────────────────────────────────────────────────

/** Flatten Anthropic content (string | block[]) to a plain string */
function flattenContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Anthropic Messages request → OpenAI chat/completions request */
export function toOpenAIRequest(req: AnthropicRequest, resolvedModel: string): OAIRequest {
  const messages: OAIMessage[] = [];

  // Anthropic's top-level `system` field → OAI system message prepended
  if (req.system) {
    messages.push({ role: "system", content: req.system });
  }

  for (const msg of req.messages) {
    messages.push({ role: msg.role, content: flattenContent(msg.content) });
  }

  return {
    model: resolvedModel,
    messages,
    ...(req.max_tokens !== undefined && { max_tokens: req.max_tokens }),
    ...(req.temperature !== undefined && { temperature: req.temperature }),
    ...(req.stream && { stream: true }),
  };
}

/** Map OAI finish_reason → Anthropic stop_reason */
function mapStopReason(reason: string | null): AnthropicResponse["stop_reason"] {
  if (reason === "stop") return "end_turn";
  if (reason === "length") return "max_tokens";
  if (reason === "content_filter") return "stop_sequence";
  return null;
}

/** OpenAI chat/completions response → Anthropic Messages response */
export function toAnthropicResponse(
  oaiRes: OAIResponse,
  originalModel: string,
): AnthropicResponse {
  const choice = oaiRes.choices[0];
  const text = choice?.message.content ?? "";

  return {
    id: `msg_${oaiRes.id}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: originalModel,
    stop_reason: mapStopReason(choice?.finish_reason ?? null),
    stop_sequence: null,
    usage: {
      input_tokens: oaiRes.usage?.prompt_tokens ?? 0,
      output_tokens: oaiRes.usage?.completion_tokens ?? 0,
    },
  };
}

// ── Core routing function ─────────────────────────────────────────────────────

/**
 * Route an Anthropic-format request to the appropriate upstream provider.
 *
 * @param req           Anthropic Messages API request body
 * @param config        Gateway configuration (provider keys, extra aliases)
 * @param overrideProvider  Optional provider name from x-nexus-provider header
 * @param fetchFn       Injectable fetch (defaults to global fetch; pass mock in tests)
 */
export async function routeMessage(
  req: AnthropicRequest,
  config: GatewayConfig,
  overrideProvider?: string,
  fetchFn: typeof fetch = fetch,
): Promise<AnthropicResponse> {
  const target = resolveModel(req.model, config, overrideProvider);
  const providerCfg = config.providers[target.provider];

  if (!providerCfg) {
    throw makeGatewayError(
      `Provider "${target.provider}" is not configured`,
      "PROVIDER_NOT_CONFIGURED",
      502,
    );
  }

  const baseUrl = providerCfg.baseUrl ?? DEFAULT_BASE_URLS[target.provider];
  if (!baseUrl) {
    throw makeGatewayError(
      `No base URL known for provider "${target.provider}"`,
      "PROVIDER_NOT_CONFIGURED",
      502,
    );
  }

  const oaiBody = toOpenAIRequest(req, target.model);

  const upstreamRes = await fetchFn(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${providerCfg.apiKey}`,
    },
    body: JSON.stringify(oaiBody),
  });

  if (!upstreamRes.ok) {
    const body = await upstreamRes.text();
    throw makeGatewayError(
      `Upstream error from ${target.provider}: ${upstreamRes.status}`,
      "UPSTREAM_ERROR",
      upstreamRes.status >= 500 ? 502 : upstreamRes.status,
      { status: upstreamRes.status, body },
    );
  }

  const oaiData = (await upstreamRes.json()) as OAIResponse;

  // Ensure id field is present (some providers may omit it)
  if (!oaiData.id) oaiData.id = randomUUID();

  return toAnthropicResponse(oaiData, req.model);
}

// ── Re-exports for route wiring ───────────────────────────────────────────────

export { DEFAULT_BASE_URLS, GROQ_SMART, GROQ_FAST };
