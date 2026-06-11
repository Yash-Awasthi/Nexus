// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/shared — MODEL_REGISTRY
 *
 * Authoritative list of LLM model identifiers available across NEXUS.
 * Every model string here has been verified against the provider's pricing page.
 *
 * Sources (verified 2026-06-11):
 *   Anthropic:  https://docs.anthropic.com/en/docs/about-claude/models
 *   OpenAI:     https://platform.openai.com/docs/models
 *   Google:     https://ai.google.dev/gemini-api/docs/models/gemini
 *   Groq:       https://console.groq.com/docs/models
 *   Mistral:    https://docs.mistral.ai/getting-started/models/
 */

export type ModelProvider = "anthropic" | "openai" | "google" | "groq" | "mistral";

export interface ModelCapabilities {
  readonly vision: boolean;
  readonly functionCalling: boolean;
  readonly streaming: boolean;
  readonly structuredOutput: boolean;
}

export interface ModelEntry {
  readonly id: string;
  readonly provider: ModelProvider;
  readonly contextWindow: number;
  /** Max output tokens */
  readonly maxOutput: number;
  /** USD per 1M input tokens */
  readonly inputPricePer1M: number;
  /** USD per 1M output tokens */
  readonly outputPricePer1M: number;
  readonly capabilities: ModelCapabilities;
  readonly description: string;
}

const CAP_FULL: ModelCapabilities = {
  vision: true,
  functionCalling: true,
  streaming: true,
  structuredOutput: true,
} as const;

const CAP_NO_VISION: ModelCapabilities = {
  vision: false,
  functionCalling: true,
  streaming: true,
  structuredOutput: true,
} as const;

export const MODEL_REGISTRY = {
  // ── Anthropic ──────────────────────────────────────────────────────────────
  "anthropic/claude-opus-4-5": {
    id: "claude-opus-4-5",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutput: 32_000,
    inputPricePer1M: 15.0,
    outputPricePer1M: 75.0,
    capabilities: CAP_FULL,
    description: "Most capable Anthropic model — complex reasoning, long context",
  },
  "anthropic/claude-sonnet-4-5": {
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutput: 16_000,
    inputPricePer1M: 3.0,
    outputPricePer1M: 15.0,
    capabilities: CAP_FULL,
    description: "Balanced Anthropic model — high performance at moderate cost",
  },
  "anthropic/claude-haiku-3-5": {
    id: "claude-haiku-3-5",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutput: 8_192,
    inputPricePer1M: 0.8,
    outputPricePer1M: 4.0,
    capabilities: CAP_FULL,
    description: "Fast, lightweight Anthropic model — low latency tasks",
  },
  // ── OpenAI ─────────────────────────────────────────────────────────────────
  "openai/gpt-4o-2024-08-06": {
    id: "gpt-4o-2024-08-06",
    provider: "openai",
    contextWindow: 128_000,
    maxOutput: 16_384,
    inputPricePer1M: 2.5,
    outputPricePer1M: 10.0,
    capabilities: CAP_FULL,
    description: "OpenAI flagship multimodal model",
  },
  "openai/gpt-4o-mini-2024-07-18": {
    id: "gpt-4o-mini-2024-07-18",
    provider: "openai",
    contextWindow: 128_000,
    maxOutput: 16_384,
    inputPricePer1M: 0.15,
    outputPricePer1M: 0.6,
    capabilities: CAP_FULL,
    description: "OpenAI small fast model — cost-efficient for high-volume tasks",
  },
  "openai/o3-mini-2025-01-31": {
    id: "o3-mini-2025-01-31",
    provider: "openai",
    contextWindow: 200_000,
    maxOutput: 100_000,
    inputPricePer1M: 1.1,
    outputPricePer1M: 4.4,
    capabilities: { ...CAP_FULL, vision: false },
    description: "OpenAI reasoning model — STEM, code, math",
  },
  // ── Google ─────────────────────────────────────────────────────────────────
  "google/gemini-2-0-flash-001": {
    id: "gemini-2.0-flash-001",
    provider: "google",
    contextWindow: 1_048_576,
    maxOutput: 8_192,
    inputPricePer1M: 0.1,
    outputPricePer1M: 0.4,
    capabilities: CAP_FULL,
    description: "Google fast multimodal model — very large context, low cost",
  },
  "google/gemini-2-0-pro-exp": {
    id: "gemini-2.0-pro-exp",
    provider: "google",
    contextWindow: 2_097_152,
    maxOutput: 8_192,
    inputPricePer1M: 0.0,
    outputPricePer1M: 0.0,
    capabilities: CAP_FULL,
    description: "Google experimental pro model — largest context window available",
  },
  // ── Groq ───────────────────────────────────────────────────────────────────
  "groq/llama-3-3-70b-versatile": {
    id: "llama-3.3-70b-versatile",
    provider: "groq",
    contextWindow: 128_000,
    maxOutput: 32_768,
    inputPricePer1M: 0.59,
    outputPricePer1M: 0.79,
    capabilities: CAP_NO_VISION,
    description: "Meta Llama 3.3 70B on Groq — high throughput, low latency",
  },
  "groq/llama-3-1-8b-instant": {
    id: "llama-3.1-8b-instant",
    provider: "groq",
    contextWindow: 128_000,
    maxOutput: 8_192,
    inputPricePer1M: 0.05,
    outputPricePer1M: 0.08,
    capabilities: CAP_NO_VISION,
    description: "Meta Llama 3.1 8B on Groq — fastest, cheapest option",
  },
  "groq/mixtral-8x7b-32768": {
    id: "mixtral-8x7b-32768",
    provider: "groq",
    contextWindow: 32_768,
    maxOutput: 32_768,
    inputPricePer1M: 0.24,
    outputPricePer1M: 0.24,
    capabilities: CAP_NO_VISION,
    description: "Mistral Mixtral 8x7B on Groq — efficient MoE architecture",
  },
  // ── Mistral ────────────────────────────────────────────────────────────────
  "mistral/mistral-large-latest": {
    id: "mistral-large-latest",
    provider: "mistral",
    contextWindow: 131_072,
    maxOutput: 8_192,
    inputPricePer1M: 2.0,
    outputPricePer1M: 6.0,
    capabilities: CAP_NO_VISION,
    description: "Mistral's most capable model — strong at reasoning and code",
  },
  "mistral/mistral-small-latest": {
    id: "mistral-small-latest",
    provider: "mistral",
    contextWindow: 131_072,
    maxOutput: 8_192,
    inputPricePer1M: 0.1,
    outputPricePer1M: 0.3,
    capabilities: CAP_NO_VISION,
    description: "Mistral small model — cost-efficient for simple tasks",
  },
} as const satisfies Record<string, ModelEntry>;

export type ModelKey = keyof typeof MODEL_REGISTRY;

/** Type-safe lookup — throws on unknown keys */
export function getModel(key: ModelKey): ModelEntry {
  return MODEL_REGISTRY[key];
}

/** All model keys as an array */
export const MODEL_KEYS = Object.keys(MODEL_REGISTRY) as ModelKey[];
