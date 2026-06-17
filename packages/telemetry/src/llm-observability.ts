// SPDX-License-Identifier: Apache-2.0
/**
 * LLM-specific observability layer for @nexus/telemetry.
 *
 * Extracted from langfuse/langfuse — packages/shared/src/server/otel/ +
 *   packages/shared/src/server/llm/internalTraceEvents.ts +
 *   worker/src/constants/default-model-prices.json +
 *   packages/shared/src/server/pricing-tiers/matcher.ts
 *
 * Attaches to @nexus/telemetry's existing ITraceSpan / ITraceRecorder without
 * replacing anything. Adds LLM-specific dimensions that OTel infra-level spans
 * cannot express:
 *   • Per-call token counts (input / output / cached_read / cached_creation)
 *   • USD cost per call (model name × price table)
 *   • Time-to-first-token (streaming latency)
 *   • Prompt version tracking (promptName / promptVersion / promptId)
 *   • Session grouping across an agent run
 *   • Observation type taxonomy (GENERATION | AGENT | TOOL | RETRIEVER | …)
 *
 * Zero new external dependencies — wires onto existing OTel span attribute map.
 *
 * Usage:
 *   // At call site in @nexus/llm-drivers or @nexus/gateway:
 *   const attrs = createLlmSpanAttributes({
 *     model: "claude-sonnet-4-5",
 *     provider: "anthropic",
 *     usage: { input: 1200, output: 340 },
 *   });
 *   span.setAttributes(attrs);
 *
 *   // To compute cost:
 *   const cost = computeTokenCost("claude-sonnet-4-5", { input: 1200, output: 340 });
 *   // → { inputCost: 0.00036, outputCost: 0.00051, totalCost: 0.00087, currency: "USD" }
 */

// ── Observation type taxonomy (langfuse ObservationType) ─────────────────────
//
// Ref: langfuse/packages/shared/src/domain/observations.ts ObservationType enum

/** Type of LLM observation span (what kind of operation is being traced) */
export type LlmObservationType =
  | "GENERATION"   // LLM completion call (input prompt → output tokens)
  | "AGENT"        // An autonomous agent turn (may contain child spans)
  | "TOOL"         // A tool call invocation (MCP tool, function call, etc.)
  | "RETRIEVER"    // A retrieval operation (vector search, BM25, graph query)
  | "EMBEDDING"    // An embedding generation call
  | "CHAIN"        // A sequence of operations forming a pipeline
  | "EVALUATOR"    // A quality evaluation step
  | "GUARDRAIL"    // A safety / guardrail check
  | "SPAN"         // Generic span (default for unknown types)
  | "EVENT";       // Point-in-time event (no duration)

/** Severity level for an LLM observation */
export type LlmObservationLevel = "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";

// ── Token usage ───────────────────────────────────────────────────────────────
//
// Ref: langfuse InternalTraceEventInput.usageDetails / usageDetails
// Keys match the provider-reported token count field names.

/** Per-call LLM token usage breakdown */
export interface LlmUsageDetails {
  /** Tokens in the prompt / input messages */
  input?: number;
  /** Tokens in the completion / output */
  output?: number;
  /** input + output (computed by computeTokenCost if absent) */
  total?: number;
  /** Tokens read from the prompt cache (Anthropic / OpenAI cache_read) */
  cached_read?: number;
  /** Tokens written to the prompt cache (Anthropic cache_creation) */
  cached_creation?: number;
  /** Reasoning tokens (OpenAI o-series / Anthropic extended thinking) */
  reasoning?: number;
  /** Any additional provider-specific token fields */
  [key: string]: number | undefined;
}

/** Per-call USD cost breakdown (mirrors usageDetails keys) */
export interface LlmCostDetails {
  /** USD cost for input tokens */
  input?: number;
  /** USD cost for output tokens */
  output?: number;
  /** USD cost for cache read tokens (usually ~50% of input price) */
  cached_read?: number;
  /** USD cost for cache creation tokens */
  cached_creation?: number;
  /** Total USD cost across all token types */
  total?: number;
  /** ISO-4217 currency code (always "USD" for now) */
  currency: "USD";
}

// ── Model price table (langfuse default-model-prices.json condensed) ──────────
//
// Ref: langfuse/worker/src/constants/default-model-prices.json
// Prices in USD per token. Only the most-used models included; the full table
// is 200+ entries. Use MODEL_PRICE_TABLE[modelName]?.input etc for lookup.
// Pattern matching (regex per model) is handled by resolveModelPrice().

/** USD per token price record */
export interface ModelPriceEntry {
  /** USD per input token */
  input: number;
  /** USD per output token */
  output: number;
  /** USD per cache-read input token (default: input * 0.5) */
  inputCachedRead?: number;
  /** USD per cache-creation input token (default: input * 1.25) */
  inputCachedCreation?: number;
  /** Human-readable provider name */
  provider: string;
}

/**
 * Compact USD-per-token price table for major models.
 * Extracted from langfuse/worker/src/constants/default-model-prices.json.
 *
 * Keys are lowercase model names as returned by provider APIs.
 * resolveModelPrice() does case-insensitive prefix/substring matching.
 */
export const MODEL_PRICE_TABLE: Record<string, ModelPriceEntry> = {
  // Anthropic
  "claude-opus-4-5":            { input: 0.000015,  output: 0.000075,  inputCachedRead: 0.0000015,  inputCachedCreation: 0.00001875, provider: "anthropic" },
  "claude-sonnet-4-5":          { input: 0.000003,  output: 0.000015,  inputCachedRead: 0.0000003,  inputCachedCreation: 0.00000375, provider: "anthropic" },
  "claude-haiku-3-5":           { input: 0.0000008, output: 0.000004,  inputCachedRead: 0.00000008, inputCachedCreation: 0.000001,   provider: "anthropic" },
  "claude-3-5-sonnet":          { input: 0.000003,  output: 0.000015,  inputCachedRead: 0.0000003,  inputCachedCreation: 0.00000375, provider: "anthropic" },
  "claude-3-5-haiku":           { input: 0.0000008, output: 0.000004,  inputCachedRead: 0.00000008, inputCachedCreation: 0.000001,   provider: "anthropic" },
  "claude-3-opus":              { input: 0.000015,  output: 0.000075,  inputCachedRead: 0.0000015,  inputCachedCreation: 0.00001875, provider: "anthropic" },
  // OpenAI
  "gpt-4o":                     { input: 0.0000025, output: 0.00001,   inputCachedRead: 0.00000125,                                  provider: "openai" },
  "gpt-4o-mini":                { input: 0.00000015,output: 0.0000006, inputCachedRead: 0.000000075,                                 provider: "openai" },
  "o3":                         { input: 0.00001,   output: 0.00004,   inputCachedRead: 0.0000025,                                   provider: "openai" },
  "o3-mini":                    { input: 0.0000011, output: 0.0000044, inputCachedRead: 0.00000055,                                  provider: "openai" },
  "gpt-4-turbo":                { input: 0.00001,   output: 0.00003,                                                                 provider: "openai" },
  "gpt-3.5-turbo":              { input: 0.0000005, output: 0.0000015,                                                               provider: "openai" },
  // Groq (very cheap — approximately)
  "llama-3.3-70b-versatile":    { input: 0.00000059,output: 0.00000079,                                                              provider: "groq" },
  "llama-3.1-8b-instant":       { input: 0.00000005,output: 0.00000008,                                                              provider: "groq" },
  "gemma2-9b-it":               { input: 0.0000002, output: 0.0000002,                                                               provider: "groq" },
  "mixtral-8x7b-32768":         { input: 0.00000024,output: 0.00000024,                                                              provider: "groq" },
  // Google Gemini
  "gemini-2.0-flash":           { input: 0.0000001, output: 0.0000004,                                                               provider: "google" },
  "gemini-1.5-pro":             { input: 0.00000125,output: 0.000005,                                                                provider: "google" },
  "gemini-1.5-flash":           { input: 0.000000075,output: 0.0000003,                                                              provider: "google" },
};

/**
 * Resolve model price entry by case-insensitive model name.
 * Tries exact match first, then prefix/substring matching.
 * Returns undefined if no match found.
 *
 * Ref: langfuse pricing-tiers/matcher.ts + model matchPattern regex approach
 */
export function resolveModelPrice(modelName: string): ModelPriceEntry | undefined {
  const lower = modelName.toLowerCase();

  // Exact match
  if (MODEL_PRICE_TABLE[lower]) return MODEL_PRICE_TABLE[lower];

  // Prefix match (longest prefix wins)
  let bestKey = "";
  for (const key of Object.keys(MODEL_PRICE_TABLE)) {
    if (lower.startsWith(key) || lower.includes(key)) {
      if (key.length > bestKey.length) bestKey = key;
    }
  }
  return bestKey ? MODEL_PRICE_TABLE[bestKey] : undefined;
}

/**
 * Compute USD cost for an LLM call given model name and token usage.
 *
 * Returns LlmCostDetails. All fields are undefined if the model is not in the
 * price table (caller should handle this gracefully — cost tracking is best-effort).
 *
 * Ref: langfuse pricing-tiers/matcher.ts evaluateCondition + price calculation
 */
export function computeTokenCost(
  modelName: string,
  usage: LlmUsageDetails,
): LlmCostDetails {
  const price = resolveModelPrice(modelName);

  if (!price) {
    return { currency: "USD" };
  }

  const inputCost = (usage.input ?? 0) * price.input;
  const outputCost = (usage.output ?? 0) * price.output;
  const cachedReadCost = usage.cached_read !== undefined
    ? usage.cached_read * (price.inputCachedRead ?? price.input * 0.5)
    : undefined;
  const cachedCreationCost = usage.cached_creation !== undefined
    ? usage.cached_creation * (price.inputCachedCreation ?? price.input * 1.25)
    : undefined;

  const total =
    inputCost +
    outputCost +
    (cachedReadCost ?? 0) +
    (cachedCreationCost ?? 0);

  return {
    input: inputCost,
    output: outputCost,
    cached_read: cachedReadCost,
    cached_creation: cachedCreationCost,
    total,
    currency: "USD",
  };
}

// ── LLM span attribute keys (langfuse OTel attribute names) ──────────────────
//
// Ref: langfuse/packages/shared/src/server/otel/attributes.ts
//   LangfuseOtelSpanAttributes enum — spans are attached to standard OTLP
//   span attribute maps so they flow through Jaeger/Tempo unchanged.

/** OTel span attribute key constants for LLM observations */
export const LLM_SPAN_ATTR = {
  // Observation identity
  OBSERVATION_TYPE:         "langfuse.observation.type",
  OBSERVATION_LEVEL:        "langfuse.observation.level",
  OBSERVATION_STATUS_MSG:   "langfuse.observation.status_message",
  // I/O
  OBSERVATION_INPUT:        "langfuse.observation.input",
  OBSERVATION_OUTPUT:       "langfuse.observation.output",
  OBSERVATION_METADATA:     "langfuse.observation.metadata",
  // Model + usage
  OBSERVATION_MODEL:        "langfuse.observation.model.name",
  OBSERVATION_MODEL_PARAMS: "langfuse.observation.model.parameters",
  OBSERVATION_USAGE:        "langfuse.observation.usage_details",
  OBSERVATION_COST:         "langfuse.observation.cost_details",
  OBSERVATION_TTFT:         "langfuse.observation.time_to_first_token_ms",
  // Prompt versioning
  PROMPT_NAME:              "langfuse.observation.prompt.name",
  PROMPT_VERSION:           "langfuse.observation.prompt.version",
  PROMPT_ID:                "langfuse.observation.prompt.id",
  // Session / trace grouping
  TRACE_SESSION_ID:         "session.id",
  TRACE_USER_ID:            "user.id",
  TRACE_NAME:               "langfuse.trace.name",
  // Environment
  ENVIRONMENT:              "langfuse.environment",
  RELEASE:                  "langfuse.release",
} as const;

// ── LLM span attributes payload ───────────────────────────────────────────────

/** Input payload for createLlmSpanAttributes() */
export interface LlmSpanInput {
  /** LLM model name (e.g. "claude-sonnet-4-5", "gpt-4o") */
  model: string;
  /** LLM provider (e.g. "anthropic", "openai", "groq") */
  provider?: string;
  /** Token usage breakdown */
  usage?: LlmUsageDetails;
  /** Pre-computed cost details (if available from provider response) */
  cost?: LlmCostDetails;
  /** Observation type (default: GENERATION) */
  type?: LlmObservationType;
  /** Observation severity (default: DEFAULT) */
  level?: LlmObservationLevel;
  /** Time to first token in milliseconds (streaming calls) */
  timeToFirstTokenMs?: number;
  /** Total latency in milliseconds */
  latencyMs?: number;
  /** Model parameters (temperature, max_tokens, etc.) */
  modelParameters?: Record<string, unknown>;
  /** Prompt name for version tracking */
  promptName?: string;
  /** Prompt version number */
  promptVersion?: number;
  /** Prompt ID from prompt registry */
  promptId?: string;
  /** Session ID for grouping spans across an agent run */
  sessionId?: string;
  /** User ID for multi-tenant attribution */
  userId?: string;
  /** Trace name (high-level operation name) */
  traceName?: string;
  /** Error message if this span represents a failure */
  statusMessage?: string;
}

/** OTel-compatible flat attribute map produced by createLlmSpanAttributes() */
export type LlmSpanAttributeMap = Record<string, string | number | boolean | undefined>;

/**
 * Create a flat OTel span attribute map for an LLM call.
 *
 * Attach to any OTel span via span.setAttributes(attrs). The attributes
 * flow through Jaeger/Tempo unchanged, and Langfuse-compatible collectors
 * understand them natively.
 *
 * Token cost is computed automatically from MODEL_PRICE_TABLE if `usage`
 * is provided and `cost` is not.
 *
 * Ref: langfuse OtelIngestionProcessor.ts createObservationEventParams
 *
 * @example
 * ```ts
 * const attrs = createLlmSpanAttributes({
 *   model: "claude-sonnet-4-5",
 *   usage: { input: 1200, output: 340 },
 *   promptName: "council-deliberation",
 *   promptVersion: 3,
 *   sessionId: agentRunId,
 * });
 * otelSpan.setAttributes(attrs);
 * ```
 */
export function createLlmSpanAttributes(input: LlmSpanInput): LlmSpanAttributeMap {
  const {
    model, provider, usage, type = "GENERATION", level = "DEFAULT",
    timeToFirstTokenMs, latencyMs, modelParameters, promptName,
    promptVersion, promptId, sessionId, userId, traceName, statusMessage,
  } = input;

  // Compute cost if not provided
  const cost: LlmCostDetails | undefined = input.cost ??
    (usage ? computeTokenCost(model, usage) : undefined);

  const attrs: LlmSpanAttributeMap = {
    [LLM_SPAN_ATTR.OBSERVATION_TYPE]:   type,
    [LLM_SPAN_ATTR.OBSERVATION_LEVEL]:  level,
    [LLM_SPAN_ATTR.OBSERVATION_MODEL]:  model,
  };

  if (provider)           attrs["llm.provider"] = provider;
  if (statusMessage)      attrs[LLM_SPAN_ATTR.OBSERVATION_STATUS_MSG] = statusMessage;
  if (timeToFirstTokenMs !== undefined) attrs[LLM_SPAN_ATTR.OBSERVATION_TTFT] = timeToFirstTokenMs;
  if (latencyMs !== undefined)          attrs["llm.latency_ms"] = latencyMs;
  if (promptName)         attrs[LLM_SPAN_ATTR.PROMPT_NAME] = promptName;
  if (promptVersion !== undefined) attrs[LLM_SPAN_ATTR.PROMPT_VERSION] = promptVersion;
  if (promptId)           attrs[LLM_SPAN_ATTR.PROMPT_ID] = promptId;
  if (sessionId)          attrs[LLM_SPAN_ATTR.TRACE_SESSION_ID] = sessionId;
  if (userId)             attrs[LLM_SPAN_ATTR.TRACE_USER_ID] = userId;
  if (traceName)          attrs[LLM_SPAN_ATTR.TRACE_NAME] = traceName;

  // Flatten usage details to individual attributes
  if (usage) {
    if (usage.input !== undefined)           attrs["llm.usage.input_tokens"] = usage.input;
    if (usage.output !== undefined)          attrs["llm.usage.output_tokens"] = usage.output;
    if (usage.total !== undefined)           attrs["llm.usage.total_tokens"] = usage.total;
    if (usage.cached_read !== undefined)     attrs["llm.usage.cached_read_tokens"] = usage.cached_read;
    if (usage.cached_creation !== undefined) attrs["llm.usage.cached_creation_tokens"] = usage.cached_creation;
    if (usage.reasoning !== undefined)       attrs["llm.usage.reasoning_tokens"] = usage.reasoning;
    // Serialise full map for Langfuse-compatible collectors
    attrs[LLM_SPAN_ATTR.OBSERVATION_USAGE] = JSON.stringify(usage);
  }

  // Flatten cost details
  if (cost) {
    if (cost.total !== undefined) attrs["llm.cost.total_usd"] = cost.total;
    if (cost.input !== undefined) attrs["llm.cost.input_usd"] = cost.input;
    if (cost.output !== undefined) attrs["llm.cost.output_usd"] = cost.output;
    attrs[LLM_SPAN_ATTR.OBSERVATION_COST] = JSON.stringify(cost);
  }

  // Model parameters (JSON-serialised)
  if (modelParameters && Object.keys(modelParameters).length > 0) {
    attrs[LLM_SPAN_ATTR.OBSERVATION_MODEL_PARAMS] = JSON.stringify(modelParameters);
  }

  return attrs;
}

// ── LlmGenerationRecord — durable record of a completed LLM call ──────────────
//
// Stored in the audit log / telemetry store for cost/usage reporting.
// Matches the shape of langfuse's ObservationSchema (generation type).

/** Complete record of one LLM generation call */
export interface LlmGenerationRecord {
  id: string;
  /** Parent OTel trace ID (W3C format) */
  traceId: string;
  /** Parent OTel span ID */
  parentSpanId?: string;
  type: "GENERATION";
  level: LlmObservationLevel;
  /** ISO-8601 start time */
  startTime: string;
  /** ISO-8601 end time */
  endTime: string;
  /** Milliseconds from request start to first output token (SSE streams) */
  timeToFirstTokenMs?: number;
  /** Total request latency in milliseconds */
  latencyMs: number;
  model: string;
  provider?: string;
  modelParameters?: Record<string, unknown>;
  usage: LlmUsageDetails;
  cost: LlmCostDetails;
  promptName?: string;
  promptVersion?: number;
  promptId?: string;
  sessionId?: string;
  userId?: string;
  /** Error message if the call failed */
  statusMessage?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Build a durable LlmGenerationRecord from span input + timing.
 * Use this at the end of every LLM provider call in @nexus/llm-drivers
 * and @nexus/gateway to produce a structured audit record.
 */
export function buildGenerationRecord(
  id: string,
  traceId: string,
  input: LlmSpanInput,
  timing: { startTime: Date; endTime: Date; timeToFirstTokenMs?: number },
): LlmGenerationRecord {
  const usage = input.usage ?? {};
  const cost = input.cost ?? (input.usage ? computeTokenCost(input.model, input.usage) : { currency: "USD" });
  const latencyMs = timing.endTime.getTime() - timing.startTime.getTime();

  return {
    id,
    traceId,
    type: "GENERATION",
    level: input.level ?? "DEFAULT",
    startTime: timing.startTime.toISOString(),
    endTime: timing.endTime.toISOString(),
    timeToFirstTokenMs: timing.timeToFirstTokenMs,
    latencyMs,
    model: input.model,
    provider: input.provider,
    modelParameters: input.modelParameters,
    usage,
    cost,
    promptName: input.promptName,
    promptVersion: input.promptVersion,
    promptId: input.promptId,
    sessionId: input.sessionId,
    userId: input.userId,
    statusMessage: input.statusMessage,
    metadata: input.provider ? { provider: input.provider } : undefined,
  };
}

// ── Session cost aggregation ──────────────────────────────────────────────────
//
// Answers "how much did this council deliberation / agent run cost?"
// Groups LlmGenerationRecord[] by sessionId and sums token counts + USD cost.

/** Cost and usage totals for a session or agent run */
export interface SessionCostSummary {
  sessionId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedReadTokens: number;
  totalCachedCreationTokens: number;
  totalReasoningTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  /** Number of LLM generation calls in this session */
  generationCount: number;
  /** Average latency across all calls */
  avgLatencyMs: number;
  /** Models used (unique list) */
  models: string[];
  /** Providers used (unique list) */
  providers: string[];
}

/**
 * Aggregate cost and usage totals across a set of LlmGenerationRecord.
 * Groups by sessionId (or uses "unknown" if absent).
 *
 * @example
 * ```ts
 * const records = agentRun.map(call => call.generationRecord);
 * const summaries = aggregateSessionCost(records);
 * console.log(`Run cost: $${summaries[0]?.totalCostUsd.toFixed(6)}`);
 * ```
 */
export function aggregateSessionCost(
  records: LlmGenerationRecord[],
): SessionCostSummary[] {
  const bySession = new Map<string, LlmGenerationRecord[]>();

  for (const r of records) {
    const key = r.sessionId ?? "unknown";
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key)!.push(r);
  }

  const summaries: SessionCostSummary[] = [];

  for (const [sessionId, sessionRecords] of bySession) {
    let totalInputTokens = 0,
      totalOutputTokens = 0,
      totalCachedReadTokens = 0,
      totalCachedCreationTokens = 0,
      totalReasoningTokens = 0,
      totalCostUsd = 0,
      totalLatencyMs = 0;

    const models = new Set<string>();
    const providers = new Set<string>();

    for (const r of sessionRecords) {
      totalInputTokens += r.usage.input ?? 0;
      totalOutputTokens += r.usage.output ?? 0;
      totalCachedReadTokens += r.usage.cached_read ?? 0;
      totalCachedCreationTokens += r.usage.cached_creation ?? 0;
      totalReasoningTokens += r.usage.reasoning ?? 0;
      totalCostUsd += r.cost.total ?? 0;
      totalLatencyMs += r.latencyMs;
      models.add(r.model);
      if (r.provider) providers.add(r.provider);
    }

    summaries.push({
      sessionId,
      totalInputTokens,
      totalOutputTokens,
      totalCachedReadTokens,
      totalCachedCreationTokens,
      totalReasoningTokens,
      totalTokens: totalInputTokens + totalOutputTokens + totalCachedReadTokens + totalCachedCreationTokens + totalReasoningTokens,
      totalCostUsd,
      generationCount: sessionRecords.length,
      avgLatencyMs: sessionRecords.length > 0 ? totalLatencyMs / sessionRecords.length : 0,
      models: Array.from(models),
      providers: Array.from(providers),
    });
  }

  return summaries;
}
