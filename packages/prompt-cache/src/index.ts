// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/prompt-cache — Prompt prefix caching utilities.
 *
 * Structures prompts so that shared system prefixes can be reused across
 * provider KV cache slots, reducing cost and latency on repeated calls.
 *
 * Architecture
 * ─────────────
 *   PromptStructure       — ordered segments: system prefix → dynamic context → user turn
 *   CacheController       — decides which segments get cache_control markers
 *   buildCachedPrompt()   — assemble Anthropic-format prompt with cache_control blocks
 *   buildOpenAIPrompt()   — assemble OpenAI-format prompt (system-role prefix)
 *   estimateCacheSavings() — estimate token savings from cache hits
 *   PromptHasher           — SHA-256-based hash of prefix for cache key generation
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type SegmentType = "system_prefix" | "context" | "instruction" | "user";

/** Prompt segment interface definition. */
export interface PromptSegment {
  type: SegmentType;
  text: string;
  /** If true, provider cache_control marker is attached to this segment. */
  cacheable?: boolean;
  /** Estimated token count for this segment. */
  tokenEstimate?: number;
}

/** Cached prompt config interface definition. */
export interface CachedPromptConfig {
  /** Fixed system prompt shared across many calls — best cache candidate. */
  systemPrefix: string;
  /** Dynamic retrieved context (docs, memory). Cacheable if stable per session. */
  context?: string;
  /** Per-request instruction. Usually not cached. */
  instruction?: string;
  /** The user's actual message. */
  userMessage: string;
  /** Provider-specific: include cache markers. Default true. */
  enableCacheControl?: boolean;
}

// Anthropic message types (minimal subset)
export interface AnthropicContentBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/** Anthropic message interface definition. */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[] | string;
}

/** Anthropic prompt interface definition. */
export interface AnthropicPrompt {
  system: AnthropicContentBlock[];
  messages: AnthropicMessage[];
}

// OpenAI message types
export interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ── buildCachedPrompt (Anthropic) ─────────────────────────────────────────────

/**
 * Build an Anthropic-format prompt with cache_control markers on the stable
 * system prefix, dramatically reducing cost on repeated calls with the same prefix.
 */
export function buildCachedPrompt(cfg: CachedPromptConfig): AnthropicPrompt {
  const { systemPrefix, context, instruction, userMessage, enableCacheControl = true } = cfg;
  const system: AnthropicContentBlock[] = [];

  // 1. Fixed system prefix — always cacheable
  system.push({
    type: "text",
    text: systemPrefix,
    ...(enableCacheControl ? { cache_control: { type: "ephemeral" } } : {}),
  });

  // 2. Dynamic context — cacheable if present (stable per session)
  if (context) {
    system.push({
      type: "text",
      text: context,
      ...(enableCacheControl ? { cache_control: { type: "ephemeral" } } : {}),
    });
  }

  // 3. Per-request instruction — not cached (changes per request)
  if (instruction) {
    system.push({ type: "text", text: instruction });
  }

  const messages: AnthropicMessage[] = [{ role: "user", content: userMessage }];

  return { system, messages };
}

// ── buildOpenAIPrompt ─────────────────────────────────────────────────────────

/**
 * Build an OpenAI-format message array where the system prefix comes first
 * (OpenAI's prompt caching automatically caches the longest common prefix).
 */
export function buildOpenAIPrompt(cfg: CachedPromptConfig): OpenAIMessage[] {
  const { systemPrefix, context, instruction, userMessage } = cfg;
  const systemParts: string[] = [systemPrefix];
  if (context) systemParts.push(context);
  if (instruction) systemParts.push(instruction);

  return [
    { role: "system", content: systemParts.join("\n\n") },
    { role: "user", content: userMessage },
  ];
}

// ── PromptSegment builder ─────────────────────────────────────────────────────

export function buildSegments(cfg: CachedPromptConfig): PromptSegment[] {
  const segs: PromptSegment[] = [
    { type: "system_prefix", text: cfg.systemPrefix, cacheable: true },
  ];
  if (cfg.context) segs.push({ type: "context", text: cfg.context, cacheable: true });
  if (cfg.instruction) segs.push({ type: "instruction", text: cfg.instruction, cacheable: false });
  segs.push({ type: "user", text: cfg.userMessage, cacheable: false });
  return segs;
}

// ── Token estimation ──────────────────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token (standard heuristic). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Cache savings estimate interface definition. */
export interface CacheSavingsEstimate {
  totalTokens: number;
  cacheableTokens: number;
  estimatedSavedTokens: number;
  /** Estimated savings at $3/MTok input (Sonnet pricing). */
  estimatedSavedUSD: number;
}

/**
 * Estimate potential token savings from prompt caching.
 * Assumes cache hit rate of 100% on cacheable segments after first call.
 */
export function estimateCacheSavings(
  cfg: CachedPromptConfig,
  callCount: number,
  costPerInputToken = 3e-6,
): CacheSavingsEstimate {
  const segs = buildSegments(cfg);
  const totalTokens = segs.reduce((s, seg) => s + estimateTokens(seg.text), 0);
  const cacheableTokens = segs
    .filter((s) => s.cacheable)
    .reduce((s, seg) => s + estimateTokens(seg.text), 0);

  // After first call, all subsequent calls save cacheableTokens each
  const estimatedSavedTokens = Math.max(0, callCount - 1) * cacheableTokens;
  const estimatedSavedUSD = estimatedSavedTokens * costPerInputToken;

  return { totalTokens, cacheableTokens, estimatedSavedTokens, estimatedSavedUSD };
}

// ── Cache key hashing ─────────────────────────────────────────────────────────

/** FNV-1a 32-bit hash — deterministic, fast, no crypto deps. */
function fnv1a(str: string): string {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Generate a deterministic cache key from the stable prefix segments. */
export function cacheKey(systemPrefix: string, context?: string): string {
  const combined = systemPrefix + (context ?? "");
  return `cache:${fnv1a(combined)}`;
}
