// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/llm-utils — Secondary LLM flows.
 *
 * Three cheap-model operations that sit in front of expensive routing:
 *
 *   classify(text, labels, llm?)  → { label, confidence }
 *   summarize(text, opts?, llm?)  → string
 *   extract(text, schema, llm?)   → T
 *
 * All three accept an optional `LlmClient` — the injectable core abstraction.
 * When omitted, they fall back to `createLanguageModel({ provider: "groq",
 * model: "llama-3.1-8b-instant" })` which is fast and cheap.
 *
 * `createLanguageModel` itself accepts an injectable `fetch` so the HTTP layer
 * can be swapped out in tests without global mocking.
 *
 * Consumers:
 *   • Gateway    — classify before alias selection
 *   • KG (gap 4) — extract for entity/relationship extraction
 *   • Bots (12)  — classify for slash-command intent routing
 *   • Agents (9) — summarize for context pruning before memory writes
 */

// ── Errors ────────────────────────────────────────────────────────────────────

export class LlmUtilsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LlmUtilsError";
  }
}

// ── LlmClient contract ────────────────────────────────────────────────────────

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCallOptions {
  /** Sampling temperature. Default varies per operation (0.0–0.2). */
  temperature?: number;
  /** Maximum tokens in the completion. */
  maxTokens?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  content: string;
  model: string;
  usage?: LlmUsage;
}

/**
 * Minimal async function contract for an LLM call.
 * Any provider (Groq, OpenAI, local) can satisfy this type.
 */
export type LlmClient = (
  messages: LlmMessage[],
  opts?: LlmCallOptions,
) => Promise<LlmResponse>;

// ── createLanguageModel ───────────────────────────────────────────────────────

export interface LanguageModelOptions {
  /** Inference provider. Default: "groq". */
  provider?: "groq" | "openai";
  /** Model identifier. Defaults to provider default (llama-3.1-8b-instant / gpt-4o-mini). */
  model?: string;
  /** API key. Falls back to GROQ_API_KEY / OPENAI_API_KEY env vars. */
  apiKey?: string;
  /** Override API base URL (useful for proxies / local deployments). */
  baseUrl?: string;
  /**
   * Injectable fetch implementation. Defaults to globalThis.fetch.
   * Pass a vi.fn() mock in tests to avoid real HTTP calls.
   */
  fetch?: typeof globalThis.fetch;
}

interface ProviderDefaults {
  readonly baseUrl: string;
  readonly model: string;
  readonly envKey: string;
}

const PROVIDER_DEFAULTS: Record<"groq" | "openai", ProviderDefaults> = {
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.1-8b-instant",
    envKey: "GROQ_API_KEY",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    envKey: "OPENAI_API_KEY",
  },
};

interface OpenAiChatResponse {
  choices: Array<{ message: { content: string | null } }>;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/**
 * Build an LlmClient backed by any OpenAI-compatible chat completions endpoint.
 *
 * Always targets the cheap fast model for the chosen provider unless `model`
 * is overridden. Intended for classify / summarize / extract — never for
 * high-stakes reasoning (use nexus/smart via the gateway for that).
 *
 * @example
 * ```ts
 * const llm = createLanguageModel({ provider: "groq" });
 * const res = await llm([{ role: "user", content: "hello" }]);
 * ```
 */
export function createLanguageModel(opts: LanguageModelOptions = {}): LlmClient {
  const provider = opts.provider ?? "groq";
  const defaults = PROVIDER_DEFAULTS[provider];
  const baseUrl = (opts.baseUrl ?? defaults.baseUrl).replace(/\/$/, "");
  const model = opts.model ?? defaults.model;
  const apiKey = opts.apiKey ?? process.env[defaults.envKey] ?? "";
  const fetcher = opts.fetch ?? globalThis.fetch;

  return async (messages: LlmMessage[], callOpts: LlmCallOptions = {}): Promise<LlmResponse> => {
    const url = `${baseUrl}/chat/completions`;

    let response: Response;
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: callOpts.temperature ?? 0.1,
          max_tokens: callOpts.maxTokens ?? 512,
        }),
      });
    } catch (err) {
      throw new LlmUtilsError(
        `Network error calling LLM API: ${String(err)}`,
        "NETWORK_ERROR",
        { url },
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "(unreadable body)");
      throw new LlmUtilsError(
        `LLM API returned HTTP ${response.status}: ${text.slice(0, 200)}`,
        "LLM_API_ERROR",
        { status: response.status, url },
      );
    }

    const data = (await response.json()) as OpenAiChatResponse;
    const content = data.choices[0]?.message?.content ?? "";

    return {
      content,
      model: data.model,
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
          }
        : undefined,
    };
  };
}

// ── Null / test implementations ───────────────────────────────────────────────

/**
 * Null LLM client — always returns an empty response.
 * Useful for tests that don't exercise the LLM path.
 */
export const nullLlmClient: LlmClient = async (): Promise<LlmResponse> => ({
  content: "",
  model: "null",
});

// ── JSON parsing helper ───────────────────────────────────────────────────────

/**
 * Parse a JSON string from an LLM response, stripping markdown code fences if
 * the model wrapped its answer.  Throws `LlmUtilsError` with code
 * `JSON_PARSE_ERROR` when the content is not valid JSON.
 */
export function parseJsonResponse<T>(content: string): T {
  let cleaned = content.trim();

  // Strip ```json … ``` or ``` … ``` wrappers
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "")
      .trim();
  }

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new LlmUtilsError(
      `Failed to parse LLM JSON response: ${content.slice(0, 120)}`,
      "JSON_PARSE_ERROR",
      { rawContent: content },
    );
  }
}

// ── Default client (lazy singleton) ──────────────────────────────────────────

let _default: LlmClient | undefined;

/** @internal — used by classify/summarize/extract when no llm arg is provided */
export function _getDefaultClient(): LlmClient {
  if (!_default) {
    _default = createLanguageModel({ provider: "groq", model: "llama-3.1-8b-instant" });
  }
  return _default;
}

/** Override the module-level default LlmClient (useful for integration tests). */
export function setDefaultLlmClient(client: LlmClient): void {
  _default = client;
}

/** Reset the module-level default to the built-in Groq client. */
export function resetDefaultLlmClient(): void {
  _default = undefined;
}

// ── classify ──────────────────────────────────────────────────────────────────

export interface ClassifyResult<L extends string = string> {
  /** The matched label (always one of the provided labels). */
  label: L;
  /** Model's self-reported confidence, clamped to [0, 1]. */
  confidence: number;
}

export interface ClassifyOptions {
  /** Override the system prompt. Must still instruct the model to return JSON. */
  systemPrompt?: string;
}

/**
 * Classify `text` into one of the provided `labels` using a cheap fast model.
 *
 * The model returns `{ "label": "...", "confidence": 0.0-1.0 }`.  Label
 * matching is case-insensitive so models that titlecase the output still match.
 *
 * @throws {LlmUtilsError} INVALID_LABELS — labels array is empty.
 * @throws {LlmUtilsError} INVALID_LABEL_RESPONSE — model returned an unknown label.
 * @throws {LlmUtilsError} JSON_PARSE_ERROR — model output was not valid JSON.
 *
 * @example
 * ```ts
 * const { label } = await classify("Book a meeting", ["calendar", "email", "search"]);
 * // label === "calendar"
 * ```
 */
export async function classify<L extends string>(
  text: string,
  labels: readonly L[],
  llm?: LlmClient,
  opts?: ClassifyOptions,
): Promise<ClassifyResult<L>> {
  if (labels.length === 0) {
    throw new LlmUtilsError("labels array must not be empty", "INVALID_LABELS");
  }

  const client = llm ?? _getDefaultClient();
  const labelList = labels.join(", ");

  const systemPrompt =
    opts?.systemPrompt ??
    `You are a precise text classifier. Classify the user's text into exactly one of these categories: ${labelList}.\n` +
      `Respond with valid JSON only — no explanation, no markdown — in this exact shape:\n` +
      `{"label": "<category>", "confidence": <0.0 to 1.0>}`;

  const response = await client(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
    { temperature: 0.0, maxTokens: 64 },
  );

  const parsed = parseJsonResponse<{ label: string; confidence: number }>(response.content);

  // Exact match first, then case-insensitive
  const exactMatch = labels.find((l) => l === parsed.label);
  if (exactMatch !== undefined) {
    return { label: exactMatch, confidence: clampConfidence(parsed.confidence) };
  }

  const ciMatch = labels.find((l) => l.toLowerCase() === parsed.label.toLowerCase());
  if (ciMatch !== undefined) {
    return { label: ciMatch, confidence: clampConfidence(parsed.confidence) };
  }

  throw new LlmUtilsError(
    `LLM returned unknown label "${parsed.label}". Expected one of: ${labelList}`,
    "INVALID_LABEL_RESPONSE",
    { returnedLabel: parsed.label, validLabels: labels },
  );
}

function clampConfidence(raw: unknown): number {
  const n = typeof raw === "number" ? raw : 0.5;
  return Math.min(1, Math.max(0, n));
}

// ── summarize ─────────────────────────────────────────────────────────────────

export interface SummarizeOptions {
  /** Maximum number of sentences in the summary. Default: 3. */
  maxSentences?: number;
  /** Max tokens to allocate for the summary completion. Default: 256. */
  maxOutputTokens?: number;
  /** Override the system prompt. */
  systemPrompt?: string;
}

/**
 * Summarize `text` in at most `maxSentences` sentences using a cheap fast model.
 *
 * Returns an empty string immediately for blank input without calling the LLM.
 *
 * @example
 * ```ts
 * const summary = await summarize(longDocument, { maxSentences: 2 });
 * ```
 */
export async function summarize(
  text: string,
  opts?: SummarizeOptions,
  llm?: LlmClient,
): Promise<string> {
  if (text.trim().length === 0) return "";

  const client = llm ?? _getDefaultClient();
  const maxSentences = opts?.maxSentences ?? 3;

  const systemPrompt =
    opts?.systemPrompt ??
    `Summarize the user's text in at most ${maxSentences} concise sentence${maxSentences === 1 ? "" : "s"}. ` +
      `Return only the summary — no preamble, no commentary.`;

  const response = await client(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
    { temperature: 0.2, maxTokens: opts?.maxOutputTokens ?? 256 },
  );

  return response.content.trim();
}

// ── extract ───────────────────────────────────────────────────────────────────

export type FieldType = "string" | "number" | "boolean" | "string[]" | "number[]";

// ── Runtime schema validation ─────────────────────────────────────────────────

export interface ExtractViolation {
  field: string;
  expected: FieldType;
  /** JavaScript typeof / "array" / "undefined" describing what arrived */
  got: string;
  reason: "missing" | "wrong_type";
}

function _checkFieldType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case "string":   return typeof value === "string";
    case "number":   return typeof value === "number";
    case "boolean":  return typeof value === "boolean";
    case "string[]": return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "number[]": return Array.isArray(value) && value.every((v) => typeof v === "number");
  }
}

/**
 * Validate a parsed extract result against the original schema.
 * Throws `LlmUtilsError` with code `SCHEMA_VALIDATION_ERROR` when:
 *   - A required field is absent (undefined or null)
 *   - A present field has the wrong JavaScript type
 * Optional fields (required: false) that are absent are silently accepted.
 * @internal exported for testing
 */
export function validateExtractResult<S extends ExtractSchema>(
  raw: Record<string, unknown>,
  schema: S,
): void {
  const violations: ExtractViolation[] = [];

  for (const [field, def] of Object.entries(schema)) {
    const value = raw[field];
    const isRequired = def.required !== false;

    if (value === undefined || value === null) {
      if (isRequired) {
        violations.push({ field, expected: def.type, got: "undefined", reason: "missing" });
      }
      continue; // optional missing field: skip type check
    }

    if (!_checkFieldType(value, def.type)) {
      const got = Array.isArray(value) ? "array" : typeof value;
      violations.push({ field, expected: def.type, got, reason: "wrong_type" });
    }
  }

  if (violations.length > 0) {
    const desc = violations
      .map((v) =>
        v.reason === "missing"
          ? `"${v.field}" is required but missing`
          : `"${v.field}" expected ${v.expected} but got ${v.got}`,
      )
      .join("; ");
    throw new LlmUtilsError(
      `Extract schema validation failed: ${desc}`,
      "SCHEMA_VALIDATION_ERROR",
      { violations },
    );
  }
}

export interface FieldSchema {
  /** Expected JavaScript type of the field value. */
  type: FieldType;
  /** Human-readable description sent to the model. */
  description?: string;
  /** Whether the field is required. Default: true. */
  required?: boolean;
}

export type ExtractSchema = Record<string, FieldSchema>;

type ResolveType<T extends FieldType> = T extends "string"
  ? string
  : T extends "number"
    ? number
    : T extends "boolean"
      ? boolean
      : T extends "string[]"
        ? string[]
        : T extends "number[]"
          ? number[]
          : unknown;

/** Map a schema definition to its inferred TypeScript output type. */
export type ExtractResult<S extends ExtractSchema> = {
  [K in keyof S]: ResolveType<S[K]["type"]>;
};

/**
 * Extract structured fields from `text` using a cheap fast model.
 *
 * The model is shown a list of fields with their types and descriptions and
 * instructed to return a flat JSON object.  The caller receives a typed result
 * mapped from the schema definition.
 *
 * @throws {LlmUtilsError} EMPTY_SCHEMA — schema has no fields.
 * @throws {LlmUtilsError} JSON_PARSE_ERROR — model output was not valid JSON.
 * @throws {LlmUtilsError} SCHEMA_VALIDATION_ERROR — required field missing or wrong type in model output.
 *
 * @example
 * ```ts
 * const result = await extract(email, {
 *   sender: { type: "string", description: "email address of sender" },
 *   subject: { type: "string", description: "email subject line" },
 *   urgent:  { type: "boolean", description: "true if marked urgent" },
 * });
 * // result.sender, result.subject, result.urgent are typed
 * ```
 */
export async function extract<S extends ExtractSchema>(
  text: string,
  schema: S,
  llm?: LlmClient,
): Promise<ExtractResult<S>> {
  const fields = Object.keys(schema);
  if (fields.length === 0) {
    throw new LlmUtilsError("schema must define at least one field", "EMPTY_SCHEMA");
  }

  const client = llm ?? _getDefaultClient();

  const fieldLines = Object.entries(schema)
    .map(([key, def]) => {
      const req = def.required === false ? "optional" : "required";
      const desc = def.description ? ` — ${def.description}` : "";
      return `  "${key}": ${def.type} (${req})${desc}`;
    })
    .join("\n");

  const systemPrompt =
    `Extract the following fields from the user's text and return them as a single valid JSON object.\n` +
    `Do not include markdown fences or extra commentary — only JSON.\n\n` +
    `Fields:\n${fieldLines}`;

  const response = await client(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
    { temperature: 0.0, maxTokens: 512 },
  );

  const raw = parseJsonResponse<Record<string, unknown>>(response.content);
  validateExtractResult(raw, schema);
  return raw as ExtractResult<S>;
}

// ── Re-export convenience ─────────────────────────────────────────────────────

export { PROVIDER_DEFAULTS };
