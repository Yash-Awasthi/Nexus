// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/consortium — CONSORTIUM hive-mind synthesis engine.
 *
 * Extends the ULTRAPLINIAN racing pattern: instead of picking the single
 * winner, CONSORTIUM collects ALL N responses and feeds them to a strong
 * orchestrator model that distils ground truth.
 *
 * Architecture
 * ────────────
 *   collectAllResponses()   — query N models, wait for all (no early exit).
 *   synthesize()            — orchestrator model reads N responses, returns
 *                             one authoritative output.
 *   runConsortium()         — full pipeline: collect → score → synthesize.
 *   ConsortiumResult        — synthesis text + provenance metadata.
 *
 * Key difference from ULTRAPLINIAN:
 *   ULTRAPLINIAN picks the BEST single voice.
 *   CONSORTIUM distills GROUND TRUTH from the crowd.
 *
 * Self-contained: queryModel, scoreResponse, and the model tier list are
 * inlined so this package has zero runtime peer dependencies.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type FetchFn = typeof fetch;
export type MessageRole = "system" | "user" | "assistant";

export interface ConsortiumMessage {
  role: MessageRole;
  content: string;
}

export interface SamplingParams {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
}

export type SpeedTier = "fast" | "standard" | "smart" | "power" | "ultra";

// ── Models per tier (additive) ────────────────────────────────────────────────

const TIER_MODELS: Record<SpeedTier, readonly string[]> = {
  fast: [
    "google/gemini-2.5-flash", "deepseek/deepseek-chat", "perplexity/sonar",
    "meta-llama/llama-3.1-8b-instruct", "moonshotai/kimi-k2.5",
    "openai/gpt-oss-20b", "google/gemini-3.1-flash-lite",
    "mistralai/mistral-small-3.2-24b-instruct",
  ],
  standard: [
    "anthropic/claude-3.5-sonnet", "deepseek/deepseek-v3.2",
    "openai/gpt-4o", "google/gemini-2.5-pro", "anthropic/claude-sonnet-4.6",
    "mistralai/mixtral-8x22b-instruct", "meta-llama/llama-3.3-70b-instruct",
  ],
  smart: [
    "openai/gpt-5", "openai/gpt-5.3-chat", "google/gemini-3-pro-preview",
    "anthropic/claude-opus-4.6", "deepseek/deepseek-r1",
    "nousresearch/hermes-4-405b",
  ],
  power: [
    "x-ai/grok-4", "openai/gpt-5.4", "qwen/qwen3-235b-a22b",
    "google/gemini-3.1-pro-preview", "moonshotai/kimi-k2",
  ],
  ultra: [
    "x-ai/grok-4-fast", "anthropic/claude-opus-4",
    "qwen/qwq-32b", "mistralai/codestral-2508",
  ],
};

export function getModelsForTier(tier: SpeedTier): string[] {
  const order: SpeedTier[] = ["fast", "standard", "smart", "power", "ultra"];
  const idx = order.indexOf(tier);
  const out: string[] = [];
  for (let i = 0; i <= idx; i++) {
    const t = order[i];
    if (t !== undefined) out.push(...TIER_MODELS[t]);
  }
  return out;
}

// ── Scoring (inlined from ultraplinian) ──────────────────────────────────────

const REFUSAL_RE = [
  /I cannot|I can't|I'm unable to/i,
  /I apologize|I'm sorry, but/i,
  /As an AI|As a language model/i,
  /I must decline|I have to refuse/i,
];
const PREAMBLE_RE = [
  /^(Sure|Of course|Certainly|Absolutely)/i,
  /^I'd be happy to help/i,
];
const HEADER_RE = /^#{1,3}\s/gm;
const LIST_RE = /^[\s]*[-*•]\s/gm;
const CODE_RE = /```/g;

export function scoreResponse(content: string, userQuery: string): number {
  if (!content || content.length < 10) return 0;
  let score = Math.min(content.length / 40, 25);
  const headers = (content.match(HEADER_RE) ?? []).length;
  const lists = (content.match(LIST_RE) ?? []).length;
  const codeBlocks = (content.match(CODE_RE) ?? []).length / 2;
  score += Math.min(headers * 3 + lists * 1.5 + codeBlocks * 5, 20);
  const refusals = REFUSAL_RE.filter((p) => p.test(content)).length;
  score += Math.max(25 - refusals * 8, 0);
  score += PREAMBLE_RE.some((p) => p.test(content.trim())) ? 8 : 15;
  const words = userQuery.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const lower = content.toLowerCase();
  const matched = words.filter((w) => lower.includes(w));
  score += words.length > 0 ? (matched.length / words.length) * 15 : 7.5;
  return Math.round(Math.min(score, 100));
}

// ── Query a single model (inlined) ───────────────────────────────────────────

export interface ModelResult {
  model: string;
  content: string;
  durationMs: number;
  success: boolean;
  error?: string;
  score: number;
}

const OR_URL = "https://openrouter.ai/api/v1/chat/completions";

export async function queryModel(
  model: string,
  messages: ConsortiumMessage[],
  apiKey: string,
  params: SamplingParams,
  signal?: AbortSignal,
  fetchFn: FetchFn = fetch,
): Promise<ModelResult> {
  const t0 = Date.now();
  try {
    const body: Record<string, unknown> = {
      model, messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.max_tokens ?? 4096,
    };
    if (params.top_p !== undefined) body["top_p"] = params.top_p;
    if (params.frequency_penalty !== undefined) body["frequency_penalty"] = params.frequency_penalty;

    const res = await fetchFn(OR_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://nexus.ai",
        "X-Title": "nexus-consortium",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    const choices = data["choices"] as Array<Record<string, unknown>> | undefined;
    const content = String((choices?.[0]?.["message"] as Record<string, unknown> | undefined)?.["content"] ?? "");
    if (!content) throw new Error("Empty response");
    return { model, content, durationMs: Date.now() - t0, success: true, score: 0 };
  } catch (err) {
    return { model, content: "", durationMs: Date.now() - t0, success: false,
      error: err instanceof Error ? err.message : String(err), score: 0 };
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export const ORCHESTRATOR_MODELS = [
  "anthropic/claude-sonnet-4.6",
  "openai/gpt-5.3-chat",
  "google/gemini-3-pro-preview",
  "x-ai/grok-4",
  "anthropic/claude-opus-4.6",
] as const;

export type OrchestratorModel = (typeof ORCHESTRATOR_MODELS)[number] | (string & {});

export interface ConsortiumResponse {
  model: string;
  content: string;
  score: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface ConsortiumResult {
  synthesis: string;
  orchestratorModel: string;
  orchestratorDurationMs: number;
  responses: ConsortiumResponse[];
  collection: {
    modelsQueried: number;
    modelsSucceeded: number;
    totalDurationMs: number;
  };
}

const CONSORTIUM_SYSTEM_PROMPT =
  `You are the CONSORTIUM ORCHESTRATOR. Synthesise ground truth from multiple AI model responses into ONE authoritative answer. Be direct, specific, and comprehensive. No meta-commentary about the process — just write the definitive answer.`;

function buildOrchestrationPrompt(
  userQuery: string,
  responses: ConsortiumResponse[],
): string {
  const successful = responses.filter((r) => r.success && r.content).sort((a, b) => b.score - a.score);
  let p = `## ORIGINAL QUESTION\n\n${userQuery}\n\n## MODEL RESPONSES (${successful.length})\n\n`;
  successful.forEach((r, i) => {
    p += `---\n### Response ${i + 1} (Score: ${r.score}/100)\n\n${r.content}\n\n`;
  });
  p += `---\n\nSynthesise the above into one definitive response.`;
  return p;
}

// ── Collection ────────────────────────────────────────────────────────────────

export interface CollectionConfig {
  minResponses?: number;
  hardTimeout?: number;
  onModelResult?: (result: ModelResult, settled: number, total: number) => void;
}

export function collectAllResponses(
  models: string[],
  messages: ConsortiumMessage[],
  apiKey: string,
  params: SamplingParams,
  config: CollectionConfig = {},
  fetchFn: FetchFn = fetch,
): Promise<ModelResult[]> {
  const minResponses = config.minResponses ?? 3;
  const hardTimeout = config.hardTimeout ?? 60_000;

  return new Promise((resolve) => {
    const results: ModelResult[] = [];
    let successCount = 0;
    let settled = 0;
    let resolved = false;
    const controller = new AbortController();

    const finish = () => {
      if (resolved) return;
      resolved = true;
      controller.abort();
      clearTimeout(hardTimer);
      resolve(results);
    };

    const hardTimer = setTimeout(finish, hardTimeout);
    setTimeout(() => { if (!resolved && successCount >= minResponses) finish(); }, hardTimeout * 0.8);

    for (const model of models) {
      queryModel(model, messages, apiKey, params, controller.signal, fetchFn)
        .then((r) => {
          if (resolved) return;
          results.push(r);
          settled++;
          if (r.success) successCount++;
          config.onModelResult?.(r, settled, models.length);
          if (settled === models.length) finish();
        });
    }

    if (models.length === 0) finish();
  });
}

export async function synthesize(
  userQuery: string,
  responses: ConsortiumResponse[],
  apiKey: string,
  orchestratorModel: OrchestratorModel = ORCHESTRATOR_MODELS[0],
  maxTokens = 8192,
  fetchFn: FetchFn = fetch,
): Promise<{ synthesis: string; durationMs: number; model: string }> {
  const prompt = buildOrchestrationPrompt(userQuery, responses);
  const messages: ConsortiumMessage[] = [
    { role: "system", content: CONSORTIUM_SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];
  const result = await queryModel(orchestratorModel, messages, apiKey,
    { temperature: 0.3, max_tokens: maxTokens }, undefined, fetchFn);
  if (!result.success || !result.content) {
    throw new Error(`Orchestrator (${orchestratorModel}) failed: ${result.error ?? "empty"}`);
  }
  return { synthesis: result.content, durationMs: result.durationMs, model: orchestratorModel };
}

export interface ConsortiumPipelineConfig {
  tier: SpeedTier;
  orchestratorModel?: OrchestratorModel;
  maxTokens?: number;
  collectionConfig?: CollectionConfig;
}

export async function runConsortium(
  userQuery: string,
  messages: ConsortiumMessage[],
  apiKey: string,
  params: SamplingParams,
  config: ConsortiumPipelineConfig,
  fetchFn: FetchFn = fetch,
): Promise<ConsortiumResult> {
  const models = getModelsForTier(config.tier);
  const t0 = Date.now();

  const rawResults = await collectAllResponses(
    models, messages, apiKey, params,
    config.collectionConfig ?? {}, fetchFn,
  );

  const collectionDuration = Date.now() - t0;

  const scoredResponses: ConsortiumResponse[] = rawResults
    .map((r) => ({
      model: r.model,
      content: r.content,
      score: r.success ? scoreResponse(r.content, userQuery) : 0,
      durationMs: r.durationMs,
      success: r.success,
      error: r.error,
    }))
    .sort((a, b) => b.score - a.score);

  const successCount = scoredResponses.filter((r) => r.success).length;
  if (successCount === 0) throw new Error("All models failed during collection phase");

  const orch = await synthesize(
    userQuery, scoredResponses, apiKey,
    config.orchestratorModel, config.maxTokens ?? 8192, fetchFn,
  );

  return {
    synthesis: orch.synthesis,
    orchestratorModel: orch.model,
    orchestratorDurationMs: orch.durationMs,
    responses: scoredResponses,
    collection: { modelsQueried: models.length, modelsSucceeded: successCount, totalDurationMs: collectionDuration },
  };
}
