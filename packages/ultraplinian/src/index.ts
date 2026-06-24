// SPDX-License-Identifier: Apache-2.0
// Ultraplinian — multi-model race engine via OpenRouter.
// Races N models in parallel, scores responses, returns ranked results.

export interface ModelResult {
  model: string;
  content: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface RaceCallbacks {
  onResult?: (result: ModelResult) => void;
  onError?: (model: string, error: unknown) => void;
}

export interface UltraplinianMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

// Well-known OpenRouter model aliases grouped by speed/quality tier.
export const ULTRAPLINIAN_MODELS: readonly string[] = [
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "openai/gpt-3.5-turbo",
  "anthropic/claude-3-5-sonnet",
  "anthropic/claude-3-haiku",
  "google/gemini-flash-1.5",
  "google/gemini-pro-1.5",
  "meta-llama/llama-3.1-8b-instruct",
  "meta-llama/llama-3.1-70b-instruct",
  "mistralai/mistral-nemo",
  "mistralai/mixtral-8x7b-instruct",
  "deepseek/deepseek-chat",
  "qwen/qwen-2.5-72b-instruct",
  "cohere/command-r-plus",
  "nvidia/llama-3.1-nemotron-70b-instruct",
];

const TIER_MODELS: Record<string, string[]> = {
  fast: [
    "openai/gpt-4o-mini",
    "google/gemini-flash-1.5",
    "anthropic/claude-3-haiku",
    "meta-llama/llama-3.1-8b-instruct",
    "mistralai/mistral-nemo",
  ],
  balanced: [
    "openai/gpt-4o",
    "anthropic/claude-3-5-sonnet",
    "google/gemini-pro-1.5",
    "meta-llama/llama-3.1-70b-instruct",
    "mistralai/mixtral-8x7b-instruct",
    "deepseek/deepseek-chat",
  ],
  quality: [
    "openai/gpt-4o",
    "anthropic/claude-3-5-sonnet",
    "google/gemini-pro-1.5",
    "qwen/qwen-2.5-72b-instruct",
    "cohere/command-r-plus",
    "nvidia/llama-3.1-nemotron-70b-instruct",
    "deepseek/deepseek-chat",
  ],
};

export function getModelsForTier(tier: string): string[] {
  return TIER_MODELS[tier] ?? TIER_MODELS["balanced"]!;
}

async function callOpenRouter(
  model: string,
  messages: UltraplinianMessage[],
  apiKey: string | undefined,
  opts: Record<string, unknown>,
): Promise<{ content: string; durationMs: number }> {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
  const start = Date.now();
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://nexus.app",
      "X-Title": "Nexus Ultraplinian",
    },
    body: JSON.stringify({ model, messages, ...opts, stream: false }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`OpenRouter ${resp.status}: ${text}`);
  }
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? "";
  return { content, durationMs: Date.now() - start };
}

/**
 * Race multiple models in parallel. Fires callbacks as each model resolves/rejects.
 * Returns all results after all settled.
 */
export async function raceModels(
  models: string[],
  messages: UltraplinianMessage[],
  apiKey: string | undefined,
  opts: Record<string, unknown>,
  callbacks: RaceCallbacks = {},
): Promise<ModelResult[]> {
  const promises = models.map(async (model): Promise<ModelResult> => {
    try {
      const { content, durationMs } = await callOpenRouter(model, messages, apiKey, opts);
      const result: ModelResult = { model, content, success: true, durationMs };
      callbacks.onResult?.(result);
      return result;
    } catch (err) {
      const result: ModelResult = {
        model,
        content: "",
        success: false,
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
      callbacks.onError?.(model, err);
      callbacks.onResult?.(result);
      return result;
    }
  });
  return Promise.all(promises);
}

/**
 * Score a response against the original question.
 * Returns a quality score 0–1 based on heuristics:
 * length adequacy, question-word coverage, refusal detection.
 */
export function scoreResponse(content: string, question: string): number {
  if (!content || content.trim().length === 0) return 0;

  // Refusal detection
  const refusalPhrases = [
    "i cannot",
    "i can't",
    "i'm unable",
    "i am unable",
    "i won't",
    "i will not",
    "as an ai",
    "i don't have the ability",
  ];
  const lower = content.toLowerCase();
  if (refusalPhrases.some((p) => lower.includes(p))) return 0.05;

  // Length score: penalise very short or extremely long responses
  const words = content.trim().split(/\s+/).length;
  const lengthScore = words < 10 ? words / 10 : words > 2000 ? 0.7 : 1.0;

  // Coverage: fraction of significant question words present in response
  const qWords = question
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const coverage =
    qWords.length > 0 ? qWords.filter((w) => lower.includes(w)).length / qWords.length : 0.5;

  // Structure bonus: headers, lists, code blocks suggest organized answer
  const structureBonus = /^#+\s|\n[-*]\s|```/.test(content) ? 0.1 : 0;

  const raw = lengthScore * 0.4 + coverage * 0.5 + structureBonus;
  return Math.max(0, Math.min(1, raw));
}

/**
 * UltraplinianRunner — stateful runner that caches registry config
 * and exposes a `run()` method for single-shot races.
 */
export class UltraplinianRunner {
  private apiKey: string | undefined;

  constructor(opts: { apiKey?: string }) {
    this.apiKey = opts.apiKey;
  }

  async run(
    models: string[],
    messages: UltraplinianMessage[],
    opts: Record<string, unknown> = {},
    callbacks: RaceCallbacks = {},
  ): Promise<ModelResult[]> {
    return raceModels(models, messages, this.apiKey, opts, callbacks);
  }
}
