// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/provider-registry — AI provider catalog with free-tier budget tracking.
 *
 * Inspired by OmniRoute's provider registry that catalogs 352+ providers,
 * 150+ free tiers, and computes ~1.51B free tokens/mo across 38 pool keys.
 *
 * Features:
 *   • Provider catalog with model lists, pricing, and rate limits
 *   • Free-tier budget computation with pool deduplication
 *   • Cost tracking per provider/account
 *   • Token compression estimation
 *   • Provider health scoring
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ProviderTier = "free" | "budget" | "standard" | "premium";

export interface ProviderModel {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  /** Cost per 1M input tokens (USD) — null if free */
  inputCost: number | null;
  /** Cost per 1M output tokens (USD) — null if free */
  outputCost: number | null;
  /** Whether model supports vision */
  vision?: boolean;
  /** Whether model supports tool use */
  toolUse?: boolean;
  /** Whether model supports streaming */
  streaming?: boolean;
}

export interface FreeTierPool {
  /** Pool identifier (e.g. "anthropic-claude-free", "groq-free") */
  poolId: string;
  /** Provider name */
  provider: string;
  /** Monthly token budget (null = unlimited permanently free) */
  monthlyTokens: number | null;
  /** Rate limit: requests per minute */
  rpm: number;
  /** Rate limit: tokens per minute */
  tpm: number;
  /** Whether this pool requires signup credits (first-month bonus) */
  signupBonus?: number;
  /** Terms risk: "safe" | "caution" | "avoid" */
  termsRisk: "safe" | "caution" | "avoid";
  /** Last verified date */
  lastVerified: string;
}

export interface ProviderEntry {
  id: string;
  name: string;
  baseUrl: string;
  authType: "bearer" | "api-key" | "oauth" | "none";
  models: ProviderModel[];
  freeTier?: FreeTierPool;
  /** Monthly spend limit (null = unlimited) */
  monthlySpendLimit: number | null;
  /** Current month spend in USD */
  currentSpend: number;
  /** Current month tokens used */
  currentTokens: number;
  /** Health score 0-100 */
  healthScore: number;
  /** Last health check */
  lastHealthCheck: string;
  /** Supported capabilities */
  capabilities: {
    chat: boolean;
    embeddings: boolean;
    imageGeneration: boolean;
    audioTranscription: boolean;
    webSearch: boolean;
    codeExecution: boolean;
  };
}

export interface BudgetSummary {
  totalMonthlyTokens: number;
  freePoolCount: number;
  cautionPoolCount: number;
  avoidPoolCount: number;
  /** Unique pool IDs after deduplication */
  deduplicatedPools: number;
  /** Estimated total cost if all free tiers exhausted at standard pricing */
  estimatedCostIfPaid: number;
  /** Provider breakdown */
  byProvider: Record<string, { tokens: number; pools: number }>;
}

export interface CompressionResult {
  originalTokens: number;
  compressedTokens: number;
  ratio: number;
  savingsPercent: number;
  strategy: string;
}

// ── Provider Registry ────────────────────────────────────────────────────────

export class ProviderRegistry {
  private providers = new Map<string, ProviderEntry>();
  private freePools = new Map<string, FreeTierPool>();
  private usage: Map<string, { tokens: number; cost: number; timestamp: number }[]> = new Map();

  // ── Registration ───────────────────────────────────────────────────────────

  register(provider: ProviderEntry): this {
    this.providers.set(provider.id, provider);
    if (provider.freeTier) {
      this.freePools.set(provider.freeTier.poolId, provider.freeTier);
    }
    return this;
  }

  unregister(id: string): this {
    const provider = this.providers.get(id);
    if (provider?.freeTier) {
      this.freePools.delete(provider.freeTier.poolId);
    }
    this.providers.delete(id);
    return this;
  }

  get(id: string): ProviderEntry | undefined {
    return this.providers.get(id);
  }

  list(): ProviderEntry[] {
    return Array.from(this.providers.values());
  }

  listFree(): ProviderEntry[] {
    return this.list().filter((p) => p.freeTier && p.freeTier.monthlyTokens !== null);
  }

  listPermanentlyFree(): ProviderEntry[] {
    return this.list().filter((p) => p.freeTier && p.freeTier.monthlyTokens === null);
  }

  // ── Budget Tracking ────────────────────────────────────────────────────────

  computeBudget(): BudgetSummary {
    const deduped = new Map<string, FreeTierPool>();
    let totalTokens = 0;
    let cautionCount = 0;
    let avoidCount = 0;
    const byProvider: Record<string, { tokens: number; pools: number }> = {};

    for (const pool of this.freePools.values()) {
      // Deduplicate by pool ID
      if (deduped.has(pool.poolId)) continue;
      deduped.set(pool.poolId, pool);

      if (pool.monthlyTokens !== null) {
        totalTokens += pool.monthlyTokens;
      }

      if (pool.termsRisk === "caution") cautionCount++;
      if (pool.termsRisk === "avoid") avoidCount++;

      const existing = byProvider[pool.provider];
      if (existing) {
        existing.tokens += pool.monthlyTokens ?? 0;
        existing.pools++;
      } else {
        byProvider[pool.provider] = { tokens: pool.monthlyTokens ?? 0, pools: 1 };
      }
    }

    // Estimate cost if paid at standard pricing
    let estimatedCost = 0;
    for (const provider of this.providers.values()) {
      for (const model of provider.models) {
        if (model.inputCost !== null) {
          estimatedCost += (totalTokens / 1_000_000) * model.inputCost * 0.7;
        }
      }
    }

    return {
      totalMonthlyTokens: totalTokens,
      freePoolCount: deduped.size - cautionCount - avoidCount,
      cautionPoolCount: cautionCount,
      avoidPoolCount: avoidCount,
      deduplicatedPools: deduped.size,
      estimatedCostIfPaid: estimatedCost,
      byProvider,
    };
  }

  // ── Cost Tracking ──────────────────────────────────────────────────────────

  trackUsage(providerId: string, tokens: number, cost: number): void {
    if (!this.usage.has(providerId)) {
      this.usage.set(providerId, []);
    }
    this.usage.get(providerId)!.push({ tokens, cost, timestamp: Date.now() });
  }

  getMonthlyUsage(providerId: string): { tokens: number; cost: number } {
    const now = Date.now();
    const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
    const entries = this.usage.get(providerId) ?? [];
    const monthly = entries.filter((e) => e.timestamp > monthAgo);
    return {
      tokens: monthly.reduce((sum, e) => sum + e.tokens, 0),
      cost: monthly.reduce((sum, e) => sum + e.cost, 0),
    };
  }

  // ── Token Compression ──────────────────────────────────────────────────────

  /**
   * Estimate token compression savings using RTK + Caveman-style stacked compression.
   * Returns compression results for different strategies.
   */
  estimateCompression(promptTokens: number, completionTokens: number): CompressionResult[] {
    const total = promptTokens + completionTokens;
    return [
      // Strategy 1: System prompt deduplication
      {
        originalTokens: total,
        compressedTokens: Math.round(total * 0.85),
        ratio: 0.85,
        savingsPercent: 15,
        strategy: "system-dedup",
      },
      // Strategy 2: Conversation summarization
      {
        originalTokens: total,
        compressedTokens: Math.round(total * 0.7),
        ratio: 0.7,
        savingsPercent: 30,
        strategy: "conversation-summarize",
      },
      // Strategy 3: Stacked compression (system + conversation + output)
      {
        originalTokens: total,
        compressedTokens: Math.round(total * 0.11),
        ratio: 0.11,
        savingsPercent: 89,
        strategy: "stacked-full",
      },
    ];
  }

  // ── Health Scoring ─────────────────────────────────────────────────────────

  updateHealth(providerId: string, score: number): void {
    const provider = this.providers.get(providerId);
    if (provider) {
      provider.healthScore = Math.max(0, Math.min(100, score));
      provider.lastHealthCheck = new Date().toISOString();
    }
  }

  getHealthiestFree(): ProviderEntry | undefined {
    return this.listFree()
      .filter((p) => p.freeTier && p.freeTier.termsRisk !== "avoid")
      .sort((a, b) => b.healthScore - a.healthScore)[0];
  }

  // ── Model Discovery ────────────────────────────────────────────────────────

  findModel(modelId: string): { provider: ProviderEntry; model: ProviderModel } | undefined {
    for (const provider of this.providers.values()) {
      const model = provider.models.find((m) => m.id === modelId);
      if (model) return { provider, model };
    }
    return undefined;
  }

  findCheapest(
    modelPattern?: string,
  ): { provider: ProviderEntry; model: ProviderModel } | undefined {
    let cheapest: { provider: ProviderEntry; model: ProviderModel } | undefined;
    let lowestCost = Infinity;

    for (const provider of this.providers.values()) {
      for (const model of provider.models) {
        if (modelPattern !== undefined && !model.id.includes(modelPattern)) continue;
        const cost = model.inputCost ?? 0;
        if (cost < lowestCost) {
          lowestCost = cost;
          cheapest = { provider, model };
        }
      }
    }

    return cheapest;
  }

  findFree(modelPattern: string): { provider: ProviderEntry; model: ProviderModel }[] {
    const results: { provider: ProviderEntry; model: ProviderModel }[] = [];
    for (const provider of this.listFree()) {
      for (const model of provider.models) {
        if (!model.id.includes(modelPattern)) continue;
        if (model.inputCost === null || model.inputCost === 0) {
          results.push({ provider, model });
        }
      }
    }
    return results;
  }

  // ── Flattened-model view ───────────────────────────────────────────────────
  // The provider-centric API keys everything off ProviderEntry.models. These
  // methods surface the same data keyed by flat "provider/model" ids — the
  // shape the models.dev importer (§1.5) and quick lookups want.

  /** True when any registered provider exposes `modelId`. */
  has(modelId: string): boolean {
    return this.findModel(modelId) !== undefined;
  }

  /** All (provider, model) pairs across every registered provider. */
  allModels(): { provider: ProviderEntry; model: ProviderModel }[] {
    const results: { provider: ProviderEntry; model: ProviderModel }[] = [];
    for (const provider of this.providers.values()) {
      for (const model of provider.models) {
        results.push({ provider, model });
      }
    }
    return results;
  }

  /** Registered provider ids (insertion order). */
  providerIds(): string[] {
    return this.list().map((p) => p.id);
  }

  /** One model by flat id, tagged with its owning provider. */
  getModel(modelId: string): ModelDefinition | undefined {
    const hit = this.findModel(modelId);
    return hit ? { ...hit.model, provider: hit.provider.id } : undefined;
  }

  /** All models as flattened ModelDefinitions, optionally filtered. */
  listModels(filter: RegistryFilter = {}): ModelDefinition[] {
    return this.allModels()
      .map(({ provider, model }) => ({ ...model, provider: provider.id }))
      .filter((m) => {
        if (filter.provider !== undefined && m.provider !== filter.provider) return false;
        if (filter.capability !== undefined && !modelSupportsCapability(m, filter.capability))
          return false;
        if (
          filter.maxCostPerOutputToken !== undefined &&
          (m.outputCost ?? 0) > filter.maxCostPerOutputToken
        )
          return false;
        if (filter.minContextWindow !== undefined && m.contextWindow < filter.minContextWindow)
          return false;
        return true;
      });
  }

  /** True when the model advertises the capability (vision/functionCalling/streaming). */
  supportsCapability(modelId: string, capability: string): boolean {
    const m = this.getModel(modelId);
    return m !== undefined && modelSupportsCapability(m, capability);
  }

  /**
   * Price a request in USD: tokens × per-1M-token rate. Unknown models cost 0
   * (metering must never lose a completed call — mirrors billing's computeCost).
   */
  estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
    const m = this.getModel(modelId);
    if (!m) return 0;
    const inRate = m.inputCost != null ? m.inputCost / 1_000_000 : 0;
    const outRate = m.outputCost != null ? m.outputCost / 1_000_000 : 0;
    return inputTokens * inRate + outputTokens * outRate;
  }

  /** The cheapest model overall (free = $0 output rate). */
  findCheapestModel(): { provider: ProviderEntry; model: ProviderModel } | undefined {
    let cheapest: { provider: ProviderEntry; model: ProviderModel } | undefined;
    let lowestCost = Infinity;
    for (const hit of this.allModels()) {
      const cost = hit.model.outputCost ?? 0;
      if (cost < lowestCost) {
        lowestCost = cost;
        cheapest = hit;
      }
    }
    return cheapest;
  }

  /** The model with the largest context window. */
  findLargestContext(): { provider: ProviderEntry; model: ProviderModel } | undefined {
    let largest: { provider: ProviderEntry; model: ProviderModel } | undefined;
    for (const hit of this.allModels()) {
      if (!largest || hit.model.contextWindow > largest.model.contextWindow) largest = hit;
    }
    return largest;
  }

  // ── Bulk Registration Helpers ──────────────────────────────────────────────

  /**
   * Register the major free-tier providers with their current free tiers.
   * Based on OmniRoute's catalog of ~1.51B free tokens/mo.
   */
  registerDefaults(): this {
    const now = new Date().toISOString();

    this.register({
      id: "openrouter-free",
      name: "OpenRouter (Free Tier)",
      baseUrl: "https://openrouter.ai/api/v1",
      authType: "bearer",
      models: [
        {
          id: "google/gemini-2.5-flash",
          name: "Gemini 2.5 Flash",
          contextWindow: 1_048_576,
          maxOutput: 65_536,
          inputCost: null,
          outputCost: null,
          vision: true,
          toolUse: true,
          streaming: true,
        },
        {
          id: "google/gemma-3-12b-it:free",
          name: "Gemma 3 12B",
          contextWindow: 131_072,
          maxOutput: 8_192,
          inputCost: null,
          outputCost: null,
          toolUse: true,
          streaming: true,
        },
        {
          id: "deepseek/deepseek-chat-v3-0324:free",
          name: "DeepSeek V3",
          contextWindow: 163_840,
          maxOutput: 163_840,
          inputCost: null,
          outputCost: null,
          toolUse: true,
          streaming: true,
        },
        {
          id: "meta-llama/llama-4-maverick:free",
          name: "Llama 4 Maverick",
          contextWindow: 1_048_576,
          maxOutput: 32_768,
          inputCost: null,
          outputCost: null,
          vision: true,
          toolUse: true,
          streaming: true,
        },
      ],
      freeTier: {
        poolId: "openrouter-free",
        provider: "openrouter",
        monthlyTokens: 1_000_000_000,
        rpm: 20,
        tpm: 200_000,
        termsRisk: "safe",
        lastVerified: now,
      },
      monthlySpendLimit: null,
      currentSpend: 0,
      currentTokens: 0,
      healthScore: 95,
      lastHealthCheck: now,
      capabilities: {
        chat: true,
        embeddings: false,
        imageGeneration: false,
        audioTranscription: false,
        webSearch: true,
        codeExecution: false,
      },
    });

    this.register({
      id: "groq-free",
      name: "Groq (Free Tier)",
      baseUrl: "https://api.groq.com/openai/v1",
      authType: "bearer",
      models: [
        {
          id: "llama-3.3-70b-versatile",
          name: "Llama 3.3 70B",
          contextWindow: 131_072,
          maxOutput: 32_768,
          inputCost: null,
          outputCost: null,
          toolUse: true,
          streaming: true,
        },
        {
          id: "llama-3.1-8b-instant",
          name: "Llama 3.1 8B",
          contextWindow: 131_072,
          maxOutput: 8_192,
          inputCost: null,
          outputCost: null,
          toolUse: true,
          streaming: true,
        },
        {
          id: "gemma2-9b-it",
          name: "Gemma 2 9B",
          contextWindow: 8_192,
          maxOutput: 8_192,
          inputCost: null,
          outputCost: null,
          streaming: true,
        },
      ],
      freeTier: {
        poolId: "groq-free",
        provider: "groq",
        monthlyTokens: 50_000_000,
        rpm: 30,
        tpm: 131_072,
        termsRisk: "safe",
        lastVerified: now,
      },
      monthlySpendLimit: null,
      currentSpend: 0,
      currentTokens: 0,
      healthScore: 98,
      lastHealthCheck: now,
      capabilities: {
        chat: true,
        embeddings: false,
        imageGeneration: false,
        audioTranscription: false,
        webSearch: false,
        codeExecution: false,
      },
    });

    this.register({
      id: "google-ai-studio",
      name: "Google AI Studio",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      authType: "api-key",
      models: [
        {
          id: "gemini-2.5-flash",
          name: "Gemini 2.5 Flash",
          contextWindow: 1_048_576,
          maxOutput: 65_536,
          inputCost: null,
          outputCost: null,
          vision: true,
          toolUse: true,
          streaming: true,
        },
        {
          id: "gemini-2.0-flash",
          name: "Gemini 2.0 Flash",
          contextWindow: 1_048_576,
          maxOutput: 8_192,
          inputCost: null,
          outputCost: null,
          vision: true,
          toolUse: true,
          streaming: true,
        },
        {
          id: "gemma-3-27b-it",
          name: "Gemma 3 27B",
          contextWindow: 131_072,
          maxOutput: 8_192,
          inputCost: null,
          outputCost: null,
          toolUse: true,
          streaming: true,
        },
      ],
      freeTier: {
        poolId: "google-ai-studio-free",
        provider: "google",
        monthlyTokens: 60_000_000,
        rpm: 15,
        tpm: 1_000_000,
        termsRisk: "safe",
        lastVerified: now,
      },
      monthlySpendLimit: null,
      currentSpend: 0,
      currentTokens: 0,
      healthScore: 96,
      lastHealthCheck: now,
      capabilities: {
        chat: true,
        embeddings: true,
        imageGeneration: true,
        audioTranscription: true,
        webSearch: true,
        codeExecution: true,
      },
    });

    this.register({
      id: "mistral-free",
      name: "Mistral AI (Free Tier)",
      baseUrl: "https://api.mistral.ai/v1",
      authType: "bearer",
      models: [
        {
          id: "mistral-small-latest",
          name: "Mistral Small",
          contextWindow: 32_768,
          maxOutput: 8_192,
          inputCost: null,
          outputCost: null,
          toolUse: true,
          streaming: true,
        },
        {
          id: "open-mistral-nemo",
          name: "Mistral Nemo",
          contextWindow: 128_000,
          maxOutput: 8_192,
          inputCost: null,
          outputCost: null,
          toolUse: true,
          streaming: true,
        },
      ],
      freeTier: {
        poolId: "mistral-free",
        provider: "mistral",
        monthlyTokens: 1_000_000_000,
        rpm: 30,
        tpm: 1_000_000,
        termsRisk: "safe",
        lastVerified: now,
      },
      monthlySpendLimit: null,
      currentSpend: 0,
      currentTokens: 0,
      healthScore: 90,
      lastHealthCheck: now,
      capabilities: {
        chat: true,
        embeddings: false,
        imageGeneration: false,
        audioTranscription: false,
        webSearch: false,
        codeExecution: false,
      },
    });

    this.register({
      id: "novita-free",
      name: "Novita AI (Free Tier)",
      baseUrl: "https://api.novita.ai/v3/openai",
      authType: "bearer",
      models: [
        {
          id: "meta-llama/llama-3.3-70b-instruct",
          name: "Llama 3.3 70B",
          contextWindow: 131_072,
          maxOutput: 16_384,
          inputCost: null,
          outputCost: null,
          toolUse: true,
          streaming: true,
        },
      ],
      freeTier: {
        poolId: "novita-free",
        provider: "novita",
        monthlyTokens: 100_000_000,
        rpm: 20,
        tpm: 500_000,
        termsRisk: "caution",
        lastVerified: now,
      },
      monthlySpendLimit: null,
      currentSpend: 0,
      currentTokens: 0,
      healthScore: 85,
      lastHealthCheck: now,
      capabilities: {
        chat: true,
        embeddings: false,
        imageGeneration: false,
        audioTranscription: false,
        webSearch: false,
        codeExecution: false,
      },
    });

    this.register({
      id: "anthropic",
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      authType: "api-key",
      models: [
        {
          id: "claude-opus-4-5",
          name: "Claude Opus 4.5",
          contextWindow: 200_000,
          maxOutput: 32_000,
          inputCost: 15,
          outputCost: 75,
          vision: true,
          toolUse: true,
          streaming: true,
        },
        {
          id: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          contextWindow: 200_000,
          maxOutput: 16_000,
          inputCost: 3,
          outputCost: 15,
          vision: true,
          toolUse: true,
          streaming: true,
        },
        {
          id: "claude-haiku-4-5",
          name: "Claude Haiku 4.5",
          contextWindow: 200_000,
          maxOutput: 8_192,
          inputCost: 0.8,
          outputCost: 4,
          vision: true,
          toolUse: true,
          streaming: true,
        },
      ],
      monthlySpendLimit: null,
      currentSpend: 0,
      currentTokens: 0,
      healthScore: 99,
      lastHealthCheck: now,
      capabilities: {
        chat: true,
        embeddings: false,
        imageGeneration: false,
        audioTranscription: false,
        webSearch: false,
        codeExecution: false,
      },
    });

    this.register({
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      authType: "bearer",
      models: [
        {
          id: "gpt-4o",
          name: "GPT-4o",
          contextWindow: 128_000,
          maxOutput: 16_384,
          inputCost: 2.5,
          outputCost: 10,
          vision: true,
          toolUse: true,
          streaming: true,
        },
        {
          id: "gpt-4o-mini",
          name: "GPT-4o Mini",
          contextWindow: 128_000,
          maxOutput: 16_384,
          inputCost: 0.15,
          outputCost: 0.6,
          vision: true,
          toolUse: true,
          streaming: true,
        },
        {
          id: "o1-preview",
          name: "o1 Preview",
          contextWindow: 128_000,
          maxOutput: 32_768,
          inputCost: 15,
          outputCost: 60,
          toolUse: true,
          streaming: true,
        },
      ],
      monthlySpendLimit: null,
      currentSpend: 0,
      currentTokens: 0,
      healthScore: 97,
      lastHealthCheck: now,
      capabilities: {
        chat: true,
        embeddings: true,
        imageGeneration: true,
        audioTranscription: true,
        webSearch: true,
        codeExecution: true,
      },
    });

    return this;
  }
}

export default ProviderRegistry;

// ── Backward compatibility aliases (deprecated) ──────────────────────────────
// The old API used globalRegistry + ModelDefinition. These aliases ensure
// existing code keeps working while we migrate to the new ProviderEntry API.

/**
 * A ProviderModel flattened to carry its owning provider id — the shape the
 * models.dev importer (§1.5) and the registry's flattened-model view use.
 */
export interface ModelDefinition extends ProviderModel {
  provider: string;
  /** Optional rich capability flags (models.dev importer / DB rows). */
  capabilities?: Record<string, boolean>;
  /** Knowledge cutoff date (models.dev `knowledge`), when published. */
  knowledgeCutoff?: string;
  /** Release date (models.dev `release_date`), when published. */
  releaseDate?: string;
}

/** Capability check with legacy fallbacks for the curated ProviderModel flags. */
export function modelSupportsCapability(m: ModelDefinition, capability: string): boolean {
  const caps = m.capabilities;
  if (caps && capability in caps) return caps[capability] === true;
  if (capability === "vision") return m.vision === true;
  if (capability === "functionCalling") return m.toolUse === true;
  if (capability === "streaming") return m.streaming !== false;
  return false;
}

/** @deprecated Use ProviderEntry.capabilities instead */
export interface ProviderCapabilities {
  vision: boolean;
  functionCalling: boolean;
  streaming: boolean;
  promptCaching: boolean;
  jsonMode: boolean;
  systemPrompt: boolean;
}

/** @deprecated Use ProviderEntry.rateLimits instead */
export interface ProviderRateLimits {
  requestsPerMinute: number;
  tokensPerMinute: number;
  tokensPerDay: number;
}

/**
 * Shared singleton registry. Curated defaults register lazily on first access
 * — the module must never require network or DB at import time (ROADMAP §1.5:
 * boot hydrates from the table, zero startup network). BUILTIN_MODELS fills
 * alongside it; explicit registrations (e.g. the §1.5 "seeded" entry) still
 * work — only the default catalogue itself is registered once.
 */
/**
 * Curated builtin catalogue — a flattened snapshot of the shared registry's
 * defaults, filled at module init below.
 */
export const BUILTIN_MODELS: ModelDefinition[] = [];

/**
 * Shared singleton registry with the curated defaults pre-registered. Static
 * data only — no network, no DB at import time (ROADMAP §1.5: boot hydrates
 * from the provider_models table, zero startup network). Explicit
 * registrations (e.g. the §1.5 "seeded" entry) work as usual.
 */
export const globalRegistry: ProviderRegistry = new ProviderRegistry().registerDefaults();
for (const { provider, model } of globalRegistry.allModels()) {
  BUILTIN_MODELS.push({ ...model, provider: provider.id });
}

/** @deprecated No longer needed — models are built into the registry */
export const MODELS_DEV_API_URL = "https://models.dev/api.json";

/** One model inside the models.dev catalogue (subset of fields we consume). */
export interface ModelsDevModel {
  id?: string;
  name?: string;
  attachment?: boolean;
  tool_call?: boolean;
  knowledge?: string;
  release_date?: string;
  status?: string;
  modalities?: { input?: string[]; output?: string[] } | null;
  cost?: {
    input?: number | null;
    output?: number | null;
    cache_read?: number | null;
    cache_write?: number | null;
  } | null;
  limit?: { context?: number; output?: number } | null;
}

/** models.dev catalogue: provider id → provider record with nested models. */
export type ModelsDevCatalogue = Record<
  string,
  { id?: string; name?: string; models?: Record<string, ModelsDevModel> } | undefined
>;

/**
 * Convert a models.dev catalogue into flattened ModelDefinitions:
 * ids namespaced `provider/model`; per-million pricing stays per-1M-token USD
 * (null = free); capabilities derived from modalities/tool_call. Deprecated
 * models are kept flagged — registerFromModelsDev skips them.
 */
export function modelsDevToDefinitions(catalogue: ModelsDevCatalogue): ModelDefinition[] {
  const defs: ModelDefinition[] = [];
  for (const [providerKey, provider] of Object.entries(catalogue ?? {})) {
    for (const [modelKey, raw] of Object.entries(provider?.models ?? {})) {
      if (!raw) continue;
      const input = raw.modalities?.input ?? ["text"];
      const caps: Record<string, boolean> = {
        vision: input.includes("image"),
        functionCalling: raw.tool_call === true,
        streaming: true,
        promptCaching: raw.cost?.cache_read != null,
        jsonMode: true,
        systemPrompt: true,
        deprecated: raw.status === "deprecated",
      };
      defs.push({
        id: `${providerKey}/${modelKey}`,
        provider: providerKey,
        name: raw.name ?? modelKey,
        contextWindow: raw.limit?.context ?? 0,
        maxOutput: raw.limit?.output ?? 0,
        inputCost: raw.cost?.input ?? null,
        outputCost: raw.cost?.output ?? null,
        vision: caps.vision,
        toolUse: caps.functionCalling,
        streaming: true,
        capabilities: caps,
        knowledgeCutoff: raw.knowledge,
        releaseDate: raw.release_date,
      });
    }
  }
  return defs;
}

/**
 * Fetch the models.dev catalogue. Injectable fetch (tests pass a fake); throws
 * on non-ok responses so callers decide fail-open vs fail-closed.
 */
export async function fetchModelsDev(fetchFn: typeof fetch = fetch): Promise<ModelsDevCatalogue> {
  const res = await fetchFn(MODELS_DEV_API_URL);
  if (!res.ok) throw new Error(`models.dev fetch failed: HTTP ${res.status}`);
  return (await res.json()) as ModelsDevCatalogue;
}

/** Options for registerFromModelsDev. */
export interface RegisterFromModelsDevOptions {
  /** Overwrite curated entries with catalogue data (default: keep curated). */
  overwrite?: boolean;
}

/**
 * Register a models.dev catalogue into a registry: one synthetic provider
 * entry per catalogue provider (mirrors the "seeded" grouping of
 * registerFromProviderModelRows). Skips deprecated models; by default keeps
 * curated entries already present. Returns the number of models added.
 */
export function registerFromModelsDev(
  registry: ProviderRegistry,
  catalogue?: ModelsDevCatalogue,
  opts: RegisterFromModelsDevOptions = {},
): number {
  if (!catalogue) return 0; // live fetch stays a Gate (ROADMAP §1.5)
  const defs = modelsDevToDefinitions(catalogue).filter((d) => !d.capabilities?.deprecated);
  const now = new Date().toISOString();
  const byProvider = new Map<string, ProviderModel[]>();
  let added = 0;
  for (const def of defs) {
    if (!opts.overwrite && registry.has(def.id)) continue;
    const models = byProvider.get(def.provider) ?? [];
    models.push({
      id: def.id,
      name: def.name,
      contextWindow: def.contextWindow,
      maxOutput: def.maxOutput,
      inputCost: def.inputCost,
      outputCost: def.outputCost,
      vision: def.vision,
      toolUse: def.toolUse,
      streaming: def.streaming,
    });
    byProvider.set(def.provider, models);
    added++;
  }
  for (const [providerId, models] of byProvider) {
    const existing = registry.get(providerId);
    if (existing) {
      const known = new Set(existing.models.map((m) => m.id));
      for (const m of models) {
        if (known.has(m.id)) {
          // overwrite: true must actually replace the curated entry, not skip it
          if (opts.overwrite) {
            const idx = existing.models.findIndex((cur) => cur.id === m.id);
            existing.models[idx] = m;
          }
          continue;
        }
        existing.models.push(m);
      }
    } else {
      registry.register({
        id: providerId,
        name: catalogue[providerId]?.name ?? providerId,
        baseUrl: "",
        authType: "none",
        models,
        monthlySpendLimit: null,
        currentSpend: 0,
        currentTokens: 0,
        healthScore: 100,
        lastHealthCheck: now,
        capabilities: {
          chat: true,
          embeddings: false,
          imageGeneration: false,
          audioTranscription: false,
          webSearch: false,
          codeExecution: false,
        },
      });
    }
  }
  return added;
}

/**
 * Filter over the flattened model view. `maxCostPerOutputToken` is USD per
 * 1M output tokens (matching ProviderModel.outputCost).
 */
export interface RegistryFilter {
  capability?: string;
  maxCost?: number;
  maxCostPerOutputToken?: number;
  minContextWindow?: number;
  provider?: string;
}

// ── §1.5 models.dev seed — DB round-trip helpers ─────────────────────────────
// The provider_models table (packages/db migration 0014) stores one row per
// model; `nexus models seed` writes rows and the API boot path reads them into
// a ProviderRegistry — both via these helpers. No network is involved at
// either end: the catalogue comes from a fixture or a file (live fetch is a
// Gate), and boot reads the table only.

/** Row shape as persisted in provider_models (structural — avoids a hard dep on @nexus/db). */
export interface ProviderModelRowLike {
  id: string;
  provider: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  costPerInputToken: number | null;
  costPerOutputToken: number | null;
  costPerCacheReadToken?: number | null;
  costPerCacheWriteToken?: number | null;
  inputModalities?: string[] | null;
  outputModalities?: string[] | null;
  knowledgeCutoff?: string | null;
  releaseDate?: string | null;
  deprecated?: boolean | null;
  capabilities?: Record<string, boolean> | null;
  source?: string | null;
}

/**
 * Convert a provider_models row into the registry's model shape. Prices are
 * stored per-token in the DB and passed through as per-1M-token USD on
 * ProviderModel (inputCost/outputCost, null = free); capability flags come
 * from the stored record, falling back to modality/price derivation for
 * legacy rows.
 */
export function rowToModelDefinition(row: ProviderModelRowLike): ProviderModel {
  const inputModalities = row.inputModalities ?? ["text"];
  const caps = row.capabilities ?? {};
  return {
    id: row.id,
    name: row.name,
    contextWindow: row.contextWindow,
    maxOutput: row.maxOutputTokens,
    inputCost: row.costPerInputToken != null ? row.costPerInputToken * 1_000_000 : null,
    outputCost: row.costPerOutputToken != null ? row.costPerOutputToken * 1_000_000 : null,
    vision: caps.vision ?? inputModalities.includes("image"),
    toolUse: caps.functionCalling ?? false,
    streaming: caps.streaming ?? true,
  };
}

/**
 * Load provider_models rows into a registry. Skips deprecated rows (they stay
 * in the table for history but must not be routed to). Returns the number of
 * models registered.
 *
 * The registry's live surface is ProviderEntry-shaped (findModel/billing
 * pricing walk `provider.models`), so rows are grouped under one synthetic
 * "seeded" provider entry rather than registered as orphan models. `rows`
 * accepts the Drizzle select shape structurally, so this stays
 * dependency-free and unit-testable without a DB.
 */
export function registerFromProviderModelRows(
  registry: ProviderRegistry,
  rows: readonly ProviderModelRowLike[],
): number {
  const live = rows.filter((row) => row.deprecated !== true);
  if (live.length === 0) return 0;
  const now = new Date().toISOString();
  registry.register({
    id: "seeded",
    name: "Seeded from models.dev (§1.5)",
    baseUrl: "",
    authType: "none",
    models: live.map(rowToModelDefinition),
    monthlySpendLimit: null,
    currentSpend: 0,
    currentTokens: 0,
    healthScore: 100,
    lastHealthCheck: now,
    capabilities: {
      chat: true,
      embeddings: false,
      imageGeneration: false,
      audioTranscription: false,
      webSearch: false,
      codeExecution: false,
    },
  });
  return live.length;
}
