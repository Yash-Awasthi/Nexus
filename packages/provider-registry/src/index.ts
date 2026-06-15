// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/provider-registry — Runtime LLM provider + model metadata registry.
 *
 * Stores per-model metadata queryable at runtime:
 *   • Context window size + max output tokens
 *   • Capability flags (vision, function-calling, streaming, prompt caching, JSON mode)
 *   • Cost per input/output token (USD)
 *   • Rate limits (RPM, TPM, TPD)
 *
 * Usage
 * ─────
 * ```ts
 * import { globalRegistry } from "@nexus/provider-registry";
 *
 * const model = globalRegistry.get("anthropic/claude-3-5-sonnet");
 * const cost = globalRegistry.estimateCost("anthropic/claude-3-5-sonnet", 1000, 500);
 * const cheapest = globalRegistry.findCheapest({ capability: "vision" });
 * ```
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProviderCapabilities {
  vision: boolean;
  functionCalling: boolean;
  streaming: boolean;
  promptCaching: boolean;
  jsonMode: boolean;
  systemPrompt: boolean;
}

/** Provider rate limits interface definition. */
export interface ProviderRateLimits {
  requestsPerMinute: number;
  tokensPerMinute: number;
  tokensPerDay?: number;
}

/** Model definition interface definition. */
export interface ModelDefinition {
  /** Canonical model id, e.g. "anthropic/claude-3-5-sonnet-20241022" */
  id: string;
  /** Provider name, e.g. "anthropic" */
  provider: string;
  /** Human-readable name */
  name: string;
  /** Maximum context window in tokens */
  contextWindow: number;
  /** Maximum output tokens per request */
  maxOutputTokens: number;
  /** Cost per input token in USD (e.g. 0.000003 = $3/MTok) */
  costPerInputToken: number;
  /** Cost per output token in USD */
  costPerOutputToken: number;
  capabilities: ProviderCapabilities;
  rateLimits?: ProviderRateLimits;
  /** If true, model is end-of-life — warn on use */
  deprecated?: boolean;
}

/** Registry filter interface definition. */
export interface RegistryFilter {
  provider?: string;
  capability?: keyof ProviderCapabilities;
  maxCostPerOutputToken?: number;
  minContextWindow?: number;
}

// ── Registry ──────────────────────────────────────────────────────────────────

export class ProviderRegistry {
  private readonly models = new Map<string, ModelDefinition>();

  register(model: ModelDefinition): void {
    this.models.set(model.id, model);
  }

  get(id: string): ModelDefinition | undefined {
    return this.models.get(id);
  }

  has(id: string): boolean {
    return this.models.has(id);
  }

  list(filter?: RegistryFilter): ModelDefinition[] {
    let results = [...this.models.values()];
    if (!filter) return results;
    if (filter.provider) results = results.filter((m) => m.provider === filter.provider);
    if (filter.capability) results = results.filter((m) => m.capabilities[filter.capability!]);
    if (filter.maxCostPerOutputToken !== undefined)
      results = results.filter((m) => m.costPerOutputToken <= filter.maxCostPerOutputToken!);
    if (filter.minContextWindow !== undefined)
      results = results.filter((m) => m.contextWindow >= filter.minContextWindow!);
    return results;
  }

  /** Estimate total cost in USD for a request. */
  estimateCost(id: string, inputTokens: number, outputTokens: number): number {
    const model = this.models.get(id);
    if (!model) return 0;
    return model.costPerInputToken * inputTokens + model.costPerOutputToken * outputTokens;
  }

  supportsCapability(id: string, capability: keyof ProviderCapabilities): boolean {
    return this.models.get(id)?.capabilities[capability] ?? false;
  }

  findCheapest(filter?: RegistryFilter): ModelDefinition | undefined {
    const candidates = this.list(filter).filter((m) => !m.deprecated);
    if (candidates.length === 0) return undefined;
    return candidates.reduce((best, m) =>
      m.costPerOutputToken < best.costPerOutputToken ? m : best,
    );
  }

  findLargestContext(filter?: RegistryFilter): ModelDefinition | undefined {
    const candidates = this.list(filter).filter((m) => !m.deprecated);
    if (candidates.length === 0) return undefined;
    return candidates.reduce((best, m) => (m.contextWindow > best.contextWindow ? m : best));
  }

  providers(): string[] {
    return [...new Set([...this.models.values()].map((m) => m.provider))];
  }
}

// ── Built-in model catalogue ──────────────────────────────────────────────────

const ALL_CAPS: ProviderCapabilities = {
  vision: true, functionCalling: true, streaming: true,
  promptCaching: true, jsonMode: true, systemPrompt: true,
};

const NO_VISION: ProviderCapabilities = { ...ALL_CAPS, vision: false };
const NO_CACHE: ProviderCapabilities = { ...ALL_CAPS, promptCaching: false };

/** Builtin models. */
export const BUILTIN_MODELS: ModelDefinition[] = [
  // Anthropic
  {
    id: "anthropic/claude-3-5-sonnet-20241022", provider: "anthropic",
    name: "Claude 3.5 Sonnet", contextWindow: 200_000, maxOutputTokens: 8192,
    costPerInputToken: 3e-6, costPerOutputToken: 15e-6, capabilities: ALL_CAPS,
    rateLimits: { requestsPerMinute: 50, tokensPerMinute: 80_000 },
  },
  {
    id: "anthropic/claude-3-5-haiku-20241022", provider: "anthropic",
    name: "Claude 3.5 Haiku", contextWindow: 200_000, maxOutputTokens: 8192,
    costPerInputToken: 0.8e-6, costPerOutputToken: 4e-6, capabilities: ALL_CAPS,
    rateLimits: { requestsPerMinute: 50, tokensPerMinute: 100_000 },
  },
  {
    id: "anthropic/claude-3-opus-20240229", provider: "anthropic",
    name: "Claude 3 Opus", contextWindow: 200_000, maxOutputTokens: 4096,
    costPerInputToken: 15e-6, costPerOutputToken: 75e-6, capabilities: ALL_CAPS,
    rateLimits: { requestsPerMinute: 20, tokensPerMinute: 40_000 },
  },
  // OpenAI
  {
    id: "openai/gpt-4o", provider: "openai",
    name: "GPT-4o", contextWindow: 128_000, maxOutputTokens: 16_384,
    costPerInputToken: 2.5e-6, costPerOutputToken: 10e-6, capabilities: { ...ALL_CAPS, promptCaching: false },
    rateLimits: { requestsPerMinute: 500, tokensPerMinute: 300_000 },
  },
  {
    id: "openai/gpt-4o-mini", provider: "openai",
    name: "GPT-4o Mini", contextWindow: 128_000, maxOutputTokens: 16_384,
    costPerInputToken: 0.15e-6, costPerOutputToken: 0.6e-6, capabilities: NO_CACHE,
    rateLimits: { requestsPerMinute: 500, tokensPerMinute: 2_000_000 },
  },
  {
    id: "openai/o1", provider: "openai",
    name: "o1", contextWindow: 200_000, maxOutputTokens: 100_000,
    costPerInputToken: 15e-6, costPerOutputToken: 60e-6,
    capabilities: { vision: true, functionCalling: false, streaming: false, promptCaching: true, jsonMode: false, systemPrompt: false },
  },
  // Google
  {
    id: "google/gemini-2.0-flash", provider: "google",
    name: "Gemini 2.0 Flash", contextWindow: 1_000_000, maxOutputTokens: 8192,
    costPerInputToken: 0.1e-6, costPerOutputToken: 0.4e-6, capabilities: { ...NO_CACHE, vision: true },
    rateLimits: { requestsPerMinute: 2000, tokensPerMinute: 4_000_000 },
  },
  {
    id: "google/gemini-1.5-pro", provider: "google",
    name: "Gemini 1.5 Pro", contextWindow: 2_000_000, maxOutputTokens: 8192,
    costPerInputToken: 1.25e-6, costPerOutputToken: 5e-6, capabilities: NO_CACHE,
    rateLimits: { requestsPerMinute: 1000, tokensPerMinute: 4_000_000 },
  },
  // Groq
  {
    id: "groq/llama-3.3-70b-versatile", provider: "groq",
    name: "Llama 3.3 70B", contextWindow: 128_000, maxOutputTokens: 32_768,
    costPerInputToken: 0.59e-6, costPerOutputToken: 0.79e-6,
    capabilities: { ...NO_VISION, promptCaching: false },
    rateLimits: { requestsPerMinute: 30, tokensPerMinute: 6_000, tokensPerDay: 1_000_000 },
  },
  {
    id: "groq/llama-3.1-8b-instant", provider: "groq",
    name: "Llama 3.1 8B Instant", contextWindow: 128_000, maxOutputTokens: 8192,
    costPerInputToken: 0.05e-6, costPerOutputToken: 0.08e-6,
    capabilities: { ...NO_VISION, promptCaching: false },
    rateLimits: { requestsPerMinute: 30, tokensPerMinute: 20_000, tokensPerDay: 1_000_000 },
  },
];

/** Default registry pre-seeded with all known models. */
export const globalRegistry = new ProviderRegistry();
for (const model of BUILTIN_MODELS) globalRegistry.register(model);
