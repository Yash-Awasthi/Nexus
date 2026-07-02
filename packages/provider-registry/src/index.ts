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
  // ── Optional extended metadata (populated by the models.dev importer) ──────────
  /** Cost per cache-read token in USD (prompt-cache hit), if the model supports it. */
  costPerCacheReadToken?: number;
  /** Cost per cache-write token in USD (prompt-cache store), if applicable. */
  costPerCacheWriteToken?: number;
  /** Accepted input modalities, e.g. ["text", "image", "audio"]. */
  inputModalities?: string[];
  /** Produced output modalities, e.g. ["text"]. */
  outputModalities?: string[];
  /** Training knowledge cutoff, ISO-ish (e.g. "2024-04"). */
  knowledgeCutoff?: string;
  /** Public release date, ISO (e.g. "2024-10-22"). */
  releaseDate?: string;
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
  vision: true,
  functionCalling: true,
  streaming: true,
  promptCaching: true,
  jsonMode: true,
  systemPrompt: true,
};

const NO_VISION: ProviderCapabilities = { ...ALL_CAPS, vision: false };
const NO_CACHE: ProviderCapabilities = { ...ALL_CAPS, promptCaching: false };

/** Builtin models. */
export const BUILTIN_MODELS: ModelDefinition[] = [
  // Anthropic
  {
    id: "anthropic/claude-3-5-sonnet-20241022",
    provider: "anthropic",
    name: "Claude 3.5 Sonnet",
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    costPerInputToken: 3e-6,
    costPerOutputToken: 15e-6,
    capabilities: ALL_CAPS,
    rateLimits: { requestsPerMinute: 50, tokensPerMinute: 80_000 },
  },
  {
    id: "anthropic/claude-3-5-haiku-20241022",
    provider: "anthropic",
    name: "Claude 3.5 Haiku",
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    costPerInputToken: 0.8e-6,
    costPerOutputToken: 4e-6,
    capabilities: ALL_CAPS,
    rateLimits: { requestsPerMinute: 50, tokensPerMinute: 100_000 },
  },
  {
    id: "anthropic/claude-3-opus-20240229",
    provider: "anthropic",
    name: "Claude 3 Opus",
    contextWindow: 200_000,
    maxOutputTokens: 4096,
    costPerInputToken: 15e-6,
    costPerOutputToken: 75e-6,
    capabilities: ALL_CAPS,
    rateLimits: { requestsPerMinute: 20, tokensPerMinute: 40_000 },
  },
  // OpenAI
  {
    id: "openai/gpt-4o",
    provider: "openai",
    name: "GPT-4o",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerInputToken: 2.5e-6,
    costPerOutputToken: 10e-6,
    capabilities: { ...ALL_CAPS, promptCaching: false },
    rateLimits: { requestsPerMinute: 500, tokensPerMinute: 300_000 },
  },
  {
    id: "openai/gpt-4o-mini",
    provider: "openai",
    name: "GPT-4o Mini",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerInputToken: 0.15e-6,
    costPerOutputToken: 0.6e-6,
    capabilities: NO_CACHE,
    rateLimits: { requestsPerMinute: 500, tokensPerMinute: 2_000_000 },
  },
  {
    id: "openai/o1",
    provider: "openai",
    name: "o1",
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    costPerInputToken: 15e-6,
    costPerOutputToken: 60e-6,
    capabilities: {
      vision: true,
      functionCalling: false,
      streaming: false,
      promptCaching: true,
      jsonMode: false,
      systemPrompt: false,
    },
  },
  // Google
  {
    id: "google/gemini-2.0-flash",
    provider: "google",
    name: "Gemini 2.0 Flash",
    contextWindow: 1_000_000,
    maxOutputTokens: 8192,
    costPerInputToken: 0.1e-6,
    costPerOutputToken: 0.4e-6,
    capabilities: { ...NO_CACHE, vision: true },
    rateLimits: { requestsPerMinute: 2000, tokensPerMinute: 4_000_000 },
  },
  {
    id: "google/gemini-1.5-pro",
    provider: "google",
    name: "Gemini 1.5 Pro",
    contextWindow: 2_000_000,
    maxOutputTokens: 8192,
    costPerInputToken: 1.25e-6,
    costPerOutputToken: 5e-6,
    capabilities: NO_CACHE,
    rateLimits: { requestsPerMinute: 1000, tokensPerMinute: 4_000_000 },
  },
  // Groq
  {
    id: "groq/llama-3.3-70b-versatile",
    provider: "groq",
    name: "Llama 3.3 70B",
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
    costPerInputToken: 0.59e-6,
    costPerOutputToken: 0.79e-6,
    capabilities: { ...NO_VISION, promptCaching: false },
    rateLimits: { requestsPerMinute: 30, tokensPerMinute: 6_000, tokensPerDay: 1_000_000 },
  },
  {
    id: "groq/llama-3.1-8b-instant",
    provider: "groq",
    name: "Llama 3.1 8B Instant",
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    costPerInputToken: 0.05e-6,
    costPerOutputToken: 0.08e-6,
    capabilities: { ...NO_VISION, promptCaching: false },
    rateLimits: { requestsPerMinute: 30, tokensPerMinute: 20_000, tokensPerDay: 1_000_000 },
  },
];

/** Default registry pre-seeded with all known models. */
export const globalRegistry = new ProviderRegistry();
for (const model of BUILTIN_MODELS) globalRegistry.register(model);

// ── models.dev importer ─────────────────────────────────────────────────────────
// models.dev publishes a community-maintained catalogue of every provider/model
// with pricing, context limits, modalities and knowledge cutoff. We map its JSON
// onto ModelDefinition so the registry can be seeded from a single source instead
// of hand-curating BUILTIN_MODELS. Pricing there is per MILLION tokens (USD); we
// divide to per-token to match ModelDefinition's convention.

/** Public catalogue endpoint. Fetching it is a live network call — gate it. */
export const MODELS_DEV_API_URL = "https://models.dev/api.json";

/** A single model entry as published by models.dev (only fields we consume). */
export interface ModelsDevModel {
  id?: string;
  name?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  knowledge?: string;
  release_date?: string;
  modalities?: { input?: string[]; output?: string[] };
  /** Per-million-token USD pricing. */
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; output?: number };
}

/** Top-level models.dev shape: provider-id → provider with a models map. */
export type ModelsDevCatalogue = Record<
  string,
  { id?: string; name?: string; models?: Record<string, ModelsDevModel> }
>;

const PER_MILLION = 1e6;

/** Map one models.dev model entry to a ModelDefinition. */
function modelsDevModelToDefinition(
  providerId: string,
  modelKey: string,
  m: ModelsDevModel,
): ModelDefinition {
  const inputModalities = m.modalities?.input ?? ["text"];
  const outputModalities = m.modalities?.output ?? ["text"];
  const hasCache = typeof m.cost?.cache_read === "number";
  const capabilities: ProviderCapabilities = {
    vision: inputModalities.includes("image"),
    functionCalling: m.tool_call ?? false,
    streaming: true, // models.dev doesn't track this; every served model streams.
    promptCaching: hasCache,
    jsonMode: m.tool_call ?? false, // best-effort proxy; models.dev has no json flag.
    systemPrompt: true,
  };
  return {
    id: `${providerId}/${modelKey}`,
    provider: providerId,
    name: m.name ?? modelKey,
    contextWindow: m.limit?.context ?? 0,
    maxOutputTokens: m.limit?.output ?? 0,
    costPerInputToken: (m.cost?.input ?? 0) / PER_MILLION,
    costPerOutputToken: (m.cost?.output ?? 0) / PER_MILLION,
    capabilities,
    ...(hasCache ? { costPerCacheReadToken: (m.cost!.cache_read ?? 0) / PER_MILLION } : {}),
    ...(typeof m.cost?.cache_write === "number"
      ? { costPerCacheWriteToken: m.cost.cache_write / PER_MILLION }
      : {}),
    inputModalities,
    outputModalities,
    ...(m.knowledge ? { knowledgeCutoff: m.knowledge } : {}),
    ...(m.release_date ? { releaseDate: m.release_date } : {}),
  };
}

/** Convert a full models.dev catalogue into ModelDefinitions (pure, no I/O). */
export function modelsDevToDefinitions(catalogue: ModelsDevCatalogue): ModelDefinition[] {
  const out: ModelDefinition[] = [];
  for (const [providerId, provider] of Object.entries(catalogue)) {
    for (const [modelKey, model] of Object.entries(provider.models ?? {})) {
      out.push(modelsDevModelToDefinition(providerId, modelKey, model));
    }
  }
  return out;
}

/**
 * Seed a registry from a models.dev catalogue. By default existing ids are kept
 * (curated BUILTIN_MODELS win); pass `{ overwrite: true }` to let models.dev data
 * replace them. Returns the count added/replaced.
 */
export function registerFromModelsDev(
  registry: ProviderRegistry,
  catalogue: ModelsDevCatalogue,
  opts: { overwrite?: boolean } = {},
): number {
  let n = 0;
  for (const def of modelsDevToDefinitions(catalogue)) {
    if (!opts.overwrite && registry.has(def.id)) continue;
    registry.register(def);
    n++;
  }
  return n;
}

/**
 * Fetch the live models.dev catalogue. THIS MAKES A NETWORK CALL — callers must
 * gate it behind explicit user intent (CLI flag / admin action), never run it on
 * a hot path. Inject `fetchFn` in tests.
 */
export async function fetchModelsDev(
  fetchFn: typeof fetch = fetch,
): Promise<ModelsDevCatalogue> {
  const res = await fetchFn(MODELS_DEV_API_URL);
  if (!res.ok) throw new Error(`models.dev fetch failed: HTTP ${res.status}`);
  return (await res.json()) as ModelsDevCatalogue;
}
