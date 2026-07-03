// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/gauntlet — ULTRAPLINIAN engine.
 *
 * Races N commercial models in parallel via OpenRouter, scores each response
 * on substance / directness / completeness, and returns the winner with full
 * provenance metadata.
 *
 * Architecture
 * ────────────
 *   UltraplinianRunner   — stateless entry-point; injectable fetch for tests.
 *   raceModels()         — early-exit race: fires all queries, resolves after
 *                          minResults succeed + gracePeriod, or hardTimeout.
 *   scoreResponse()      — pure scoring function; no I/O.
 *   SpeedTier            — additive model tiers: fast → standard → smart → power → ultra.
 *   ULTRAPLINIAN_MODELS  — curated model lists per tier.
 *
 * Usage
 * ─────
 * ```ts
 * const runner = new UltraplinianRunner({ apiKey: process.env.OPENROUTER_KEY! });
 * const result = await runner.race({
 *   tier: "fast",
 *   messages: [{ role: "user", content: "Explain monads in one sentence" }],
 * });
 * console.log(result.winner.content, result.winner.model, result.winner.score);
 * ```
 */

// ── Injectable fetch ──────────────────────────────────────────────────────────

export type FetchFn = typeof fetch;

// ── Errors ────────────────────────────────────────────────────────────────────

export class UltraplinianError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "UltraplinianError";
  }
}

// ── Message types ─────────────────────────────────────────────────────────────

export type MessageRole = "system" | "user" | "assistant";

/** Ultraplinian message interface definition. */
export interface UltraplinianMessage {
  role: MessageRole;
  content: string;
}

// ── Sampling params ───────────────────────────────────────────────────────────

export interface SamplingParams {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
}

// ── Model result ──────────────────────────────────────────────────────────────

export interface ModelResult {
  model: string;
  content: string;
  durationMs: number;
  success: boolean;
  error?: string;
  score: number;
}

// ── Speed tiers ───────────────────────────────────────────────────────────────

export type SpeedTier = "fast" | "standard" | "smart" | "power" | "ultra";

/** Ultraplinian models. */
export const ULTRAPLINIAN_MODELS: Record<SpeedTier, readonly string[]> = {
  fast: [
    "google/gemini-2.5-flash",
    "deepseek/deepseek-chat",
    "perplexity/sonar",
    "meta-llama/llama-3.1-8b-instruct",
    "moonshotai/kimi-k2.5",
    "x-ai/grok-code-fast-1",
    "xiaomi/mimo-v2-flash",
    "openai/gpt-oss-20b",
    "stepfun/step-3.5-flash",
    "google/gemini-3.1-flash-lite",
    "mistralai/mistral-small-3.2-24b-instruct",
    "nvidia/nemotron-3-nano-30b-a3b",
  ],
  standard: [
    "anthropic/claude-3.5-sonnet",
    "meta-llama/llama-4-scout",
    "deepseek/deepseek-v3.2",
    "openai/gpt-4o",
    "google/gemini-2.5-pro",
    "anthropic/claude-sonnet-4",
    "anthropic/claude-sonnet-4.6",
    "mistralai/mixtral-8x22b-instruct",
    "meta-llama/llama-3.3-70b-instruct",
    "qwen/qwen-2.5-72b-instruct",
    "nousresearch/hermes-4-70b",
    "mistralai/mistral-medium-3.1",
  ],
  smart: [
    "openai/gpt-5",
    "openai/gpt-5.3-chat",
    "qwen/qwen3.5-plus-02-15",
    "openai/gpt-5.2",
    "google/gemini-3-pro-preview",
    "anthropic/claude-opus-4.6",
    "openai/gpt-oss-120b",
    "deepseek/deepseek-r1",
    "meta-llama/llama-3.1-405b-instruct",
    "nousresearch/hermes-4-405b",
    "nvidia/nemotron-3-super-120b-a12b",
  ],
  power: [
    "x-ai/grok-4",
    "openai/gpt-5.4",
    "meta-llama/llama-4-maverick",
    "qwen/qwen3-235b-a22b",
    "qwen/qwen3-coder",
    "minimax/minimax-m2.5",
    "mistralai/mistral-large-2512",
    "google/gemini-3.1-pro-preview",
    "moonshotai/kimi-k2",
    "xiaomi/mimo-v2-pro",
  ],
  ultra: [
    "x-ai/grok-4-fast",
    "x-ai/grok-4.1-fast",
    "anthropic/claude-opus-4",
    "qwen/qwen-2.5-coder-32b-instruct",
    "qwen/qwq-32b",
    "mistralai/codestral-2508",
    "mistralai/devstral-medium",
  ],
};

/**
 * Return the cumulative model list for a tier (additive: fast ⊆ standard ⊆ …).
 */
export function getModelsForTier(tier: SpeedTier): string[] {
  const order: SpeedTier[] = ["fast", "standard", "smart", "power", "ultra"];
  const idx = order.indexOf(tier);
  const models: string[] = [];
  for (let i = 0; i <= idx; i++) {
    const t = order[i];
    if (t !== undefined) models.push(...ULTRAPLINIAN_MODELS[t]);
  }
  return models;
}

// ── Pre-compiled scoring patterns ─────────────────────────────────────────────

const REFUSAL_PATTERNS: RegExp[] = [
  /I cannot|I can't|I'm unable to/i,
  /I apologize|I'm sorry, but/i,
  /As an AI|As a language model/i,
  /I must decline|I have to refuse/i,
  /It would be inappropriate/i,
  /I'm not comfortable/i,
  /Instead, I can/i,
  /It's important to note/i,
];

const PREAMBLE_PATTERNS: RegExp[] = [
  /^(Sure|Of course|Certainly|Absolutely|Great question)/i,
  /^I'd be happy to help/i,
  /^Let me help you/i,
  /^Thanks for asking/i,
];

const HEADER_RE = /^#{1,3}\s/gm;
const LIST_RE = /^[\s]*[-*•]\s/gm;
const CODE_BLOCK_RE = /```/g;

/**
 * Score a model response 0–100 on substance, directness, completeness.
 */
export function scoreResponse(content: string, userQuery: string): number {
  if (!content || content.length < 10) return 0;

  let score = 0;

  // Length — substance proxy (0–25)
  score += Math.min(content.length / 40, 25);

  // Structure — headers / lists / code blocks (0–20)
  const headers = (content.match(HEADER_RE) ?? []).length;
  const listItems = (content.match(LIST_RE) ?? []).length;
  const codeBlocks = (content.match(CODE_BLOCK_RE) ?? []).length / 2;
  score += Math.min(headers * 3 + listItems * 1.5 + codeBlocks * 5, 20);

  // Anti-refusal (0–25)
  const refusalCount = REFUSAL_PATTERNS.filter((p) => p.test(content)).length;
  score += Math.max(25 - refusalCount * 8, 0);

  // Directness — penalise preambles (0–15)
  const trimmed = content.trim();
  const hasPreamble = PREAMBLE_PATTERNS.some((p) => p.test(trimmed));
  score += hasPreamble ? 8 : 15;

  // Relevance (0–15)
  const queryWords = userQuery
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const contentLower = content.toLowerCase();
  const matchedWords = queryWords.filter((w) => contentLower.includes(w));
  const relevance = queryWords.length > 0 ? matchedWords.length / queryWords.length : 0.5;
  score += relevance * 15;

  return Math.round(Math.min(score, 100));
}

// ── Query a single model ──────────────────────────────────────────────────────

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Query model. */
export async function queryModel(
  model: string,
  messages: UltraplinianMessage[],
  apiKey: string,
  params: SamplingParams,
  signal?: AbortSignal,
  fetchFn: FetchFn = fetch,
): Promise<ModelResult> {
  const startTime = Date.now();
  try {
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.max_tokens ?? 4096,
    };
    if (params.top_p !== undefined) body["top_p"] = params.top_p;
    if (params.top_k !== undefined) body["top_k"] = params.top_k;
    if (params.frequency_penalty !== undefined)
      body["frequency_penalty"] = params.frequency_penalty;
    if (params.presence_penalty !== undefined) body["presence_penalty"] = params.presence_penalty;
    if (params.repetition_penalty !== undefined)
      body["repetition_penalty"] = params.repetition_penalty;

    const res = await fetchFn(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://nexus.ai",
        "X-Title": "nexus-gauntlet",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const msg =
        (err["error"] as Record<string, unknown> | undefined)?.["message"] ?? `HTTP ${res.status}`;
      throw new Error(String(msg));
    }

    const data = (await res.json()) as Record<string, unknown>;
    const choices = data["choices"] as Record<string, unknown>[] | undefined;
    const msg = choices?.[0]?.["message"] as Record<string, unknown> | undefined;
    const content = String(msg?.["content"] ?? "");

    if (!content) throw new Error("Empty response");

    return { model, content, durationMs: Date.now() - startTime, success: true, score: 0 };
  } catch (err) {
    return {
      model,
      content: "",
      durationMs: Date.now() - startTime,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      score: 0,
    };
  }
}

// ── Race config ───────────────────────────────────────────────────────────────

export interface RaceConfig {
  /** Minimum successful responses before grace period starts (default: 3) */
  minResults?: number;
  /** Milliseconds to wait after minResults collected (default: 3000) */
  gracePeriod?: number;
  /** Hard timeout for entire race in ms (default: 45000) */
  hardTimeout?: number;
  /** Called when each model finishes. */
  onResult?: (result: ModelResult) => void;
}

// ── Core race function ────────────────────────────────────────────────────────

/**
 * Race N models in parallel with early-exit strategy.
 *
 * 1. Fire all queries simultaneously (staggered in waves to avoid rate limits).
 * 2. Once `minResults` succeed, start `gracePeriod` timer.
 * 3. When grace period ends (or all done), resolve with collected results.
 * 4. `hardTimeout` aborts remaining requests.
 */
export function raceModels(
  models: string[],
  messages: UltraplinianMessage[],
  apiKey: string,
  params: SamplingParams,
  config: RaceConfig = {},
  fetchFn: FetchFn = fetch,
): Promise<ModelResult[]> {
  const minResults = config.minResults ?? 3;
  const gracePeriod = config.gracePeriod ?? 3000;
  const hardTimeout = config.hardTimeout ?? 45_000;
  const WAVE_SIZE = 12;
  const WAVE_DELAY_MS = 150;

  return new Promise((resolve) => {
    const results: ModelResult[] = [];
    let successCount = 0;
    let settled = 0;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;
    const controller = new AbortController();

    const finish = () => {
      if (resolved) return;
      resolved = true;
      controller.abort();
      if (graceTimer) clearTimeout(graceTimer);
      clearTimeout(hardTimer);
      resolve(results);
    };

    const hardTimer = setTimeout(finish, hardTimeout);

    const launchModel = (model: string) => {
      queryModel(model, messages, apiKey, params, controller.signal, fetchFn).then((result) => {
        if (resolved) return;
        results.push(result);
        settled++;
        if (result.success) successCount++;
        config.onResult?.(result);
        if (successCount >= minResults && !graceTimer) {
          graceTimer = setTimeout(finish, gracePeriod);
        }
        // eslint-disable-next-line promise/always-return
        if (settled === models.length) finish();
      });
    };

    for (let i = 0; i < models.length; i++) {
      const waveDelay = Math.floor(i / WAVE_SIZE) * WAVE_DELAY_MS;
      if (waveDelay === 0) {
        launchModel(models[i] ?? "");
      } else {
        setTimeout(() => {
          if (!resolved) launchModel(models[i] ?? "");
        }, waveDelay);
      }
    }

    if (models.length === 0) finish();
  });
}

// ── Full race result ──────────────────────────────────────────────────────────

export interface UltraplinianResult {
  /** The winning model result (highest score). */
  winner: ModelResult;
  /** All results collected during the race. */
  all: ModelResult[];
  /** How many models were queried. */
  modelsQueried: number;
  /** How many models succeeded. */
  modelsSucceeded: number;
  /** Total race wall-clock time in ms. */
  totalDurationMs: number;
}

// ── Runner config ─────────────────────────────────────────────────────────────

export interface UltraplinianRunnerConfig {
  apiKey: string;
  fetchFn?: FetchFn;
  raceConfig?: RaceConfig;
}

/** Race request interface definition. */
export interface RaceRequest {
  tier: SpeedTier;
  messages: UltraplinianMessage[];
  params?: SamplingParams;
  /** Override the model list entirely (bypasses tier). */
  models?: string[];
}

// ── UltraplinianRunner ────────────────────────────────────────────────────────

export class UltraplinianRunner {
  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;
  private readonly raceConfig: RaceConfig;

  constructor(config: UltraplinianRunnerConfig) {
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetchFn ?? fetch;
    this.raceConfig = config.raceConfig ?? {};
  }

  async race(req: RaceRequest): Promise<UltraplinianResult> {
    const models = req.models ?? getModelsForTier(req.tier);
    if (models.length === 0) {
      throw new UltraplinianError("No models for tier", "NO_MODELS", { tier: req.tier });
    }

    const start = Date.now();
    const rawResults = await raceModels(
      models,
      req.messages,
      this.apiKey,
      req.params ?? {},
      this.raceConfig,
      this.fetchFn,
    );

    // Extract user query for scoring (last user message)
    const userQuery = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";

    // Score all successful results
    const scored = rawResults.map((r) => ({
      ...r,
      score: r.success ? scoreResponse(r.content, userQuery) : 0,
    }));

    const succeeded = scored.filter((r) => r.success);

    if (succeeded.length === 0) {
      throw new UltraplinianError("All models failed", "ALL_FAILED", {
        models: models.length,
        errors: rawResults.map((r) => r.error),
      });
    }

    // Pick winner — highest score, ties broken by fastest duration
    const winner = succeeded.reduce((best, cur) => {
      if (cur.score > best.score) return cur;
      if (cur.score === best.score && cur.durationMs < best.durationMs) return cur;
      return best;
    });

    return {
      winner,
      all: scored,
      modelsQueried: models.length,
      modelsSucceeded: succeeded.length,
      totalDurationMs: Date.now() - start,
    };
  }
}
