// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/multi-reviewer — Multi-model code reviewer.
 *
 * Dispatches a code review request to N model variants simultaneously,
 * aggregates review scores, surfaces disagreements, and produces a final
 * consensus review.  Replaces single-model review in agent code loops.
 *
 * Architecture
 * ────────────
 *   MultiReviewer       — stateless; injectable fetch.
 *   ReviewModel         — named model entry with weight.
 *   ModelReview         — per-model structured review output.
 *   AggregatedReview    — consensus score + disagreements + final verdict.
 *   parseReview()       — extract structured data from free-text LLM output.
 *
 * Review dimensions
 * ─────────────────
 *   correctness (0–10)   — does the code do what it claims?
 *   readability (0–10)   — naming, structure, comments
 *   security    (0–10)   — obvious vulnerabilities / input validation
 *   performance (0–10)   — obvious inefficiencies
 *   overall     (0–10)   — weighted summary
 *
 * Usage
 * ─────
 * ```ts
 * const reviewer = new MultiReviewer({ apiKey: process.env.OPENROUTER_KEY! });
 * const result = await reviewer.review({ code, language: "typescript", context: "auth middleware" });
 * console.log(result.consensus.overallScore, result.disagreements);
 * ```
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type FetchFn = typeof fetch;

/** Review model interface definition. */
export interface ReviewModel {
  id: string;
  name: string;
  /** Weight when computing consensus (default: 1.0) */
  weight?: number;
}

/** Default review models. */
export const DEFAULT_REVIEW_MODELS: readonly ReviewModel[] = [
  { id: "deepseek/deepseek-v3.2", name: "DeepSeek-V3.2" },
  { id: "openai/gpt-5.3-chat", name: "GPT-5" },
  { id: "moonshotai/kimi-k2", name: "Kimi-K2" },
  { id: "xiaomi/mimo-v2-flash", name: "MiMo-V2-Flash" },
  { id: "anthropic/claude-sonnet-4.6", name: "Claude-Sonnet-4.6" },
];

/** Review scores interface definition. */
export interface ReviewScores {
  correctness: number;
  readability: number;
  security: number;
  performance: number;
  overall: number;
}

/** Review issue interface definition. */
export interface ReviewIssue {
  severity: "critical" | "major" | "minor" | "suggestion";
  description: string;
  line?: number;
}

/** Model review interface definition. */
export interface ModelReview {
  modelId: string;
  modelName: string;
  scores: ReviewScores;
  issues: ReviewIssue[];
  summary: string;
  rawContent: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

/** Disagreement interface definition. */
export interface Disagreement {
  dimension: keyof ReviewScores;
  minScore: number;
  maxScore: number;
  spread: number;
  /** Models on each side */
  lowModels: string[];
  highModels: string[];
}

/** Aggregated review interface definition. */
export interface AggregatedReview {
  consensus: ReviewScores;
  disagreements: Disagreement[];
  criticalIssues: ReviewIssue[];
  allIssues: ReviewIssue[];
  modelReviews: ModelReview[];
  finalVerdict: "approved" | "needs-changes" | "rejected";
  summary: string;
  durationMs: number;
}

// ── Review request ────────────────────────────────────────────────────────────

export interface ReviewRequest {
  code: string;
  language?: string;
  context?: string;
  /** If provided, only check these dimensions. */
  focus?: Array<keyof ReviewScores>;
}

// ── System prompt ─────────────────────────────────────────────────────────────

const REVIEW_SYSTEM_PROMPT = `You are an expert code reviewer. Review the provided code and respond in this EXACT JSON format:

{
  "scores": {
    "correctness": <0-10>,
    "readability": <0-10>,
    "security": <0-10>,
    "performance": <0-10>,
    "overall": <0-10>
  },
  "issues": [
    {"severity": "critical|major|minor|suggestion", "description": "...", "line": <optional line number>}
  ],
  "summary": "One sentence verdict"
}

Score meanings: 0=unusable, 5=acceptable, 8=good, 10=excellent.
Be objective, specific, and actionable. Focus on real problems, not style preferences.`;

function buildReviewPrompt(req: ReviewRequest): string {
  const lang = req.language ?? "unknown";
  const ctx = req.context ? `\nContext: ${req.context}` : "";
  return `Language: ${lang}${ctx}\n\n\`\`\`${lang}\n${req.code}\n\`\`\``;
}

// ── Parse LLM output ──────────────────────────────────────────────────────────

const JSON_BLOCK_RE = /```(?:json)?\s*([\s\S]*?)```/;

function parseReview(raw: string, modelId: string, modelName: string, durationMs: number): ModelReview {
  const defaultScores: ReviewScores = { correctness: 5, readability: 5, security: 5, performance: 5, overall: 5 };

  try {
    const jsonStr = JSON_BLOCK_RE.exec(raw)?.[1] ?? raw;
    const parsed = JSON.parse(jsonStr.trim()) as Record<string, unknown>;

    const rawScores = (parsed["scores"] ?? {}) as Record<string, unknown>;
    const scores: ReviewScores = {
      correctness: clampScore(rawScores["correctness"]),
      readability: clampScore(rawScores["readability"]),
      security: clampScore(rawScores["security"]),
      performance: clampScore(rawScores["performance"]),
      overall: clampScore(rawScores["overall"]),
    };

    const rawIssues = Array.isArray(parsed["issues"]) ? parsed["issues"] as unknown[] : [];
    const issues: ReviewIssue[] = rawIssues
      .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
      .map((i) => ({
        severity: validateSeverity(String(i["severity"] ?? "minor")),
        description: String(i["description"] ?? ""),
        line: typeof i["line"] === "number" ? i["line"] : undefined,
      }));

    return {
      modelId, modelName, scores, issues,
      summary: String(parsed["summary"] ?? ""),
      rawContent: raw, durationMs, success: true,
    };
  } catch {
    return {
      modelId, modelName, scores: defaultScores, issues: [],
      summary: "Failed to parse review", rawContent: raw, durationMs, success: false,
      error: "JSON parse error",
    };
  }
}

function clampScore(v: unknown): number {
  const n = Number(v);
  if (isNaN(n)) return 5;
  return Math.round(Math.min(Math.max(n, 0), 10));
}

function validateSeverity(s: string): ReviewIssue["severity"] {
  if (s === "critical" || s === "major" || s === "minor" || s === "suggestion") return s;
  return "minor";
}

// ── Query one model ───────────────────────────────────────────────────────────

const OR_URL = "https://openrouter.ai/api/v1/chat/completions";

async function queryReviewModel(
  model: ReviewModel,
  prompt: string,
  apiKey: string,
  fetchFn: FetchFn,
): Promise<ModelReview> {
  const t0 = Date.now();
  try {
    const body = {
      model: model.id,
      messages: [
        { role: "system", content: REVIEW_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.1, // low temp for consistent analysis
      max_tokens: 2048,
    };

    const res = await fetchFn(OR_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://nexus.ai",
        "X-Title": "nexus-multi-reviewer",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    const choices = data["choices"] as Array<Record<string, unknown>> | undefined;
    const content = String((choices?.[0]?.["message"] as Record<string, unknown> | undefined)?.["content"] ?? "");
    if (!content) throw new Error("Empty response");

    return parseReview(content, model.id, model.name, Date.now() - t0);
  } catch (err) {
    const defaultScores: ReviewScores = { correctness: 5, readability: 5, security: 5, performance: 5, overall: 5 };
    return {
      modelId: model.id, modelName: model.name,
      scores: defaultScores, issues: [], summary: "",
      rawContent: "", durationMs: Date.now() - t0, success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Aggregation ───────────────────────────────────────────────────────────────

const DISAGREE_THRESHOLD = 3; // spread >= 3 → flag as disagreement

function aggregateReviews(reviews: ModelReview[]): Pick<AggregatedReview, "consensus" | "disagreements"> {
  const successful = reviews.filter((r) => r.success);
  if (successful.length === 0) {
    return {
      consensus: { correctness: 0, readability: 0, security: 0, performance: 0, overall: 0 },
      disagreements: [],
    };
  }

  const dimensions: Array<keyof ReviewScores> = ["correctness", "readability", "security", "performance", "overall"];
  const consensus = {} as ReviewScores;
  const disagreements: Disagreement[] = [];

  for (const dim of dimensions) {
    const scores = successful.map((r) => ({ model: r.modelName, score: r.scores[dim] }));
    const values = scores.map((s) => s.score);
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    consensus[dim] = Math.round(avg * 10) / 10;

    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = max - min;

    if (spread >= DISAGREE_THRESHOLD) {
      const mid = (min + max) / 2;
      disagreements.push({
        dimension: dim,
        minScore: min,
        maxScore: max,
        spread,
        lowModels: scores.filter((s) => s.score <= mid).map((s) => s.model),
        highModels: scores.filter((s) => s.score > mid).map((s) => s.model),
      });
    }
  }

  return { consensus, disagreements };
}

function buildVerdict(consensus: ReviewScores, criticalCount: number): AggregatedReview["finalVerdict"] {
  if (criticalCount > 0 || consensus.overall < 4) return "rejected";
  if (consensus.overall < 7) return "needs-changes";
  return "approved";
}

// ── MultiReviewer ─────────────────────────────────────────────────────────────

export interface MultiReviewerConfig {
  apiKey: string;
  models?: ReadonlyArray<ReviewModel>;
  fetchFn?: FetchFn;
  /** Timeout per model in ms (default: 30000) */
  modelTimeout?: number;
}

/** Multi reviewer. */
export class MultiReviewer {
  private readonly apiKey: string;
  private readonly models: ReadonlyArray<ReviewModel>;
  private readonly fetchFn: FetchFn;
  private readonly modelTimeout: number;

  constructor(config: MultiReviewerConfig) {
    this.apiKey = config.apiKey;
    this.models = config.models ?? DEFAULT_REVIEW_MODELS;
    this.fetchFn = config.fetchFn ?? fetch;
    this.modelTimeout = config.modelTimeout ?? 30_000;
  }

  async review(req: ReviewRequest): Promise<AggregatedReview> {
    const t0 = Date.now();
    const prompt = buildReviewPrompt(req);

    // Fire all models in parallel with individual timeouts
    const pending = this.models.map((model) =>
      withTimeout(
        queryReviewModel(model, prompt, this.apiKey, this.fetchFn),
        this.modelTimeout,
        model,
      ),
    );

    const modelReviews = await Promise.all(pending);

    const { consensus, disagreements } = aggregateReviews(modelReviews);

    const allIssues: ReviewIssue[] = modelReviews.flatMap((r) => r.issues);
    const criticalIssues = allIssues.filter((i) => i.severity === "critical");

    const verdict = buildVerdict(consensus, criticalIssues.length);

    const summaryParts = modelReviews
      .filter((r) => r.success && r.summary)
      .map((r) => `[${r.modelName}] ${r.summary}`);

    return {
      consensus,
      disagreements,
      criticalIssues,
      allIssues,
      modelReviews,
      finalVerdict: verdict,
      summary: summaryParts.join(" | "),
      durationMs: Date.now() - t0,
    };
  }
}

async function withTimeout(
  p: Promise<ModelReview>,
  ms: number,
  model: ReviewModel,
): Promise<ModelReview> {
  return Promise.race([
    p,
    new Promise<ModelReview>((resolve) =>
      setTimeout(() => resolve({
        modelId: model.id, modelName: model.name,
        scores: { correctness: 5, readability: 5, security: 5, performance: 5, overall: 5 },
        issues: [], summary: "", rawContent: "",
        durationMs: ms, success: false, error: "Timeout",
      }), ms),
    ),
  ]);
}
