// SPDX-License-Identifier: Apache-2.0
/**
 * Model discovery + per-model capabilities (mission pillar 4 — OpenCode-depth
 * provider layer).
 *
 * `discoverModels()` answers "what can I run, and what is each model good at?"
 * from three sources, in order of specificity:
 *
 *   1. PROBE   — the local Ollama daemon (GET /api/tags) when reachable:
 *                models actually installed right now.
 *   2. CATALOG — a curated static table of per-model capabilities for the
 *                common hosted models (OpenAI, Anthropic, Groq, DeepSeek,
 *                Gemini, Mistral…). Honest labels: values are best-effort
 *                published specs, `source: "catalog"`.
 *   3. DEFAULT — a conservative fallback for unknown ids so discovery never
 *                fails, `source: "default"`.
 *
 * Every entry carries the capability fields agents need to route by
 * capability: contextWindow, maxOutput, vision, toolUse, streaming, and a
 * reasoningTier (fast | reasoning | deep). Nothing here calls a model or
 * costs tokens — it is metadata + one cheap local HTTP probe.
 */

export type ReasoningTier = "fast" | "reasoning" | "deep";

export interface ModelCapability {
  id: string;
  provider: string;
  contextWindow: number;
  maxOutput: number;
  vision: boolean;
  toolUse: boolean;
  streaming: boolean;
  reasoningTier: ReasoningTier;
  /** Best-effort knowledge cutoff (catalog entries only). */
  knowledgeCutoff?: string;
  /** USD per 1M input tokens (null = free or unknown). */
  inputCostPer1M: number | null;
  /** USD per 1M output tokens (null = free or unknown). */
  outputCostPer1M: number | null;
  source: "probe" | "catalog" | "default";
}

interface CatalogEntry {
  provider: string;
  contextWindow: number;
  maxOutput: number;
  vision?: boolean;
  toolUse?: boolean;
  streaming?: boolean;
  reasoningTier?: ReasoningTier;
  knowledgeCutoff?: string;
  inputCostPer1M?: number | null;
  outputCostPer1M?: number | null;
}

/**
 * Curated per-model capability table for common hosted models. Values are
 * best-effort published specs; the `source: "catalog"` label keeps that
 * honest. Local Ollama models are discovered by probe instead.
 */
const MODEL_CATALOG: Record<string, CatalogEntry> = {
  // OpenAI
  "gpt-4o": { provider: "openai", contextWindow: 128_000, maxOutput: 16_384, vision: true, toolUse: true, streaming: true, reasoningTier: "reasoning", knowledgeCutoff: "2024-10", inputCostPer1M: 2.5, outputCostPer1M: 10 },
  "gpt-4o-mini": { provider: "openai", contextWindow: 128_000, maxOutput: 16_384, vision: true, toolUse: true, streaming: true, reasoningTier: "fast", knowledgeCutoff: "2024-10", inputCostPer1M: 0.15, outputCostPer1M: 0.6 },
  "gpt-4.1": { provider: "openai", contextWindow: 1_047_576, maxOutput: 32_768, vision: true, toolUse: true, streaming: true, reasoningTier: "reasoning", knowledgeCutoff: "2025-06", inputCostPer1M: 2, outputCostPer1M: 8 },
  "o3": { provider: "openai", contextWindow: 200_000, maxOutput: 100_000, toolUse: true, streaming: true, reasoningTier: "deep", knowledgeCutoff: "2025-06", inputCostPer1M: 2, outputCostPer1M: 8 },
  // Anthropic
  "claude-sonnet-4-5": { provider: "anthropic", contextWindow: 1_000_000, maxOutput: 64_000, vision: true, toolUse: true, streaming: true, reasoningTier: "deep", knowledgeCutoff: "2025-09", inputCostPer1M: 3, outputCostPer1M: 15 },
  "claude-opus-4-1": { provider: "anthropic", contextWindow: 1_000_000, maxOutput: 64_000, vision: true, toolUse: true, streaming: true, reasoningTier: "deep", knowledgeCutoff: "2025-09", inputCostPer1M: 15, outputCostPer1M: 75 },
  "claude-haiku-4-5": { provider: "anthropic", contextWindow: 200_000, maxOutput: 8_192, vision: true, toolUse: true, streaming: true, reasoningTier: "fast", knowledgeCutoff: "2025-09", inputCostPer1M: 1, outputCostPer1M: 5 },
  // Google
  "gemini-2.5-pro": { provider: "google", contextWindow: 1_048_576, maxOutput: 65_536, vision: true, toolUse: true, streaming: true, reasoningTier: "deep", knowledgeCutoff: "2025-06", inputCostPer1M: 1.25, outputCostPer1M: 10 },
  "gemini-2.5-flash": { provider: "google", contextWindow: 1_048_576, maxOutput: 65_536, vision: true, toolUse: true, streaming: true, reasoningTier: "fast", knowledgeCutoff: "2025-06", inputCostPer1M: 0.3, outputCostPer1M: 2.5 },
  // Groq (hosted Llama/Mixtral — fast inference)
  "llama-3.3-70b-versatile": { provider: "groq", contextWindow: 131_072, maxOutput: 32_768, toolUse: true, streaming: true, reasoningTier: "fast", knowledgeCutoff: "2024-12", inputCostPer1M: 0.59, outputCostPer1M: 0.79 },
  "llama-3.1-8b-instant": { provider: "groq", contextWindow: 131_072, maxOutput: 8_192, toolUse: true, streaming: true, reasoningTier: "fast", knowledgeCutoff: "2024-12", inputCostPer1M: 0.05, outputCostPer1M: 0.08 },
  // DeepSeek
  "deepseek-chat": { provider: "deepseek", contextWindow: 128_000, maxOutput: 8_192, toolUse: true, streaming: true, reasoningTier: "reasoning", knowledgeCutoff: "2025-05", inputCostPer1M: 0.27, outputCostPer1M: 1.1 },
  "deepseek-reasoner": { provider: "deepseek", contextWindow: 128_000, maxOutput: 8_192, toolUse: true, streaming: true, reasoningTier: "deep", knowledgeCutoff: "2025-05", inputCostPer1M: 0.55, outputCostPer1M: 2.19 },
  // Mistral
  "mistral-large-latest": { provider: "mistral", contextWindow: 128_000, maxOutput: 8_192, toolUse: true, streaming: true, reasoningTier: "reasoning", knowledgeCutoff: "2025-01", inputCostPer1M: 2, outputCostPer1M: 6 },
  "mistral-small-latest": { provider: "mistral", contextWindow: 32_000, maxOutput: 8_192, toolUse: true, streaming: true, reasoningTier: "fast", knowledgeCutoff: "2024-10", inputCostPer1M: 0.1, outputCostPer1M: 0.3 },
  // Local Ollama (catalog defaults — the probe overrides with installed truth)
  "qwen2.5:7b": { provider: "ollama", contextWindow: 32_768, maxOutput: 8_192, toolUse: true, streaming: true, reasoningTier: "fast", inputCostPer1M: null, outputCostPer1M: null },
  "qwen2.5-coder:7b": { provider: "ollama", contextWindow: 32_768, maxOutput: 8_192, toolUse: true, streaming: true, reasoningTier: "fast", inputCostPer1M: null, outputCostPer1M: null },
  "llama3.2:3b": { provider: "ollama", contextWindow: 128_000, maxOutput: 4_096, toolUse: true, streaming: true, reasoningTier: "fast", inputCostPer1M: null, outputCostPer1M: null },
  "llama3.2:1b": { provider: "ollama", contextWindow: 128_000, maxOutput: 4_096, toolUse: false, streaming: true, reasoningTier: "fast", inputCostPer1M: null, outputCostPer1M: null },
  "nomic-embed-text": { provider: "ollama", contextWindow: 8_192, maxOutput: 768, toolUse: false, streaming: false, reasoningTier: "fast", inputCostPer1M: null, outputCostPer1M: null },
};

/** Base model name without the :tag suffix (ollama /api/tags convention). */
const baseName = (id: string): string => id.split(":")[0] ?? id;

/** Probe the local Ollama daemon for installed models (bounded, never throws). */
export async function probeOllamaModels(
  baseUrl: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  if (!baseUrl) return [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const res = await fetchFn(`${baseUrl.replace(/\/+$/, "")}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name.split(":")[0] ?? m.name);
  } catch {
    return []; // daemon down or unreachable — discovery degrades gracefully
  }
}

function toCapability(id: string, entry: CatalogEntry): ModelCapability {
  return {
    id,
    provider: entry.provider,
    contextWindow: entry.contextWindow,
    maxOutput: entry.maxOutput,
    vision: entry.vision ?? false,
    toolUse: entry.toolUse ?? true,
    streaming: entry.streaming ?? true,
    reasoningTier: entry.reasoningTier ?? "fast",
    knowledgeCutoff: entry.knowledgeCutoff,
    inputCostPer1M: entry.inputCostPer1M ?? null,
    outputCostPer1M: entry.outputCostPer1M ?? null,
    source: "catalog",
  };
}

export interface DiscoveryResult {
  providers: { id: string; models: ModelCapability[] }[];
  generatedAt: string;
}

/**
 * Full model discovery: installed local models (probe) take precedence for
 * ollama ids, the catalog fills hosted models, and unknown ids get honest
 * defaults. Grouped by provider, ready for `/api/v1/llm/models`.
 */
export async function discoverModels(opts: {
  ollamaBaseUrl?: string;
  /** Env-declared provider names (e.g. NEXUS_LLM_PROVIDER) to surface first. */
  declaredProviders?: string[];
  fetchFn?: typeof fetch;
} = {}): Promise<DiscoveryResult> {
  const installed = new Set(await probeOllamaModels(opts.ollamaBaseUrl, opts.fetchFn));

  const byProvider = new Map<string, ModelCapability[]>();
  const push = (m: ModelCapability) => {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  };

  for (const [id, entry] of Object.entries(MODEL_CATALOG)) {
    if (entry.provider === "ollama") {
      const base = baseName(id);
      if (installed.size > 0 && !installed.has(base)) continue; // probe knows the truth
      push({ ...toCapability(id, entry), source: installed.has(base) ? "probe" : "catalog" });
    } else {
      push(toCapability(id, entry));
    }
  }

  // Declared-but-uncatalogued providers get their ids with honest defaults.
  for (const name of opts.declaredProviders ?? []) {
    if (![...byProvider.keys()].includes(name)) byProvider.set(name, []);
  }

  const providers = [...byProvider.entries()]
    .map(([id, models]) => ({
      id,
      models: models.sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return { providers, generatedAt: new Date().toISOString() };
}