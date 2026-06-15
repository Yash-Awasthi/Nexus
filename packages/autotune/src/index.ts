// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/autotune — AutoTune engine.
 *
 * Analyzes conversation context BEFORE generation and selects optimal
 * sampling parameters (temperature, top_p, top_k, penalties) in a single
 * pre-call.  An EMA feedback loop learns from user ratings over time.
 *
 * Architecture
 * ────────────
 *   computeAutoTuneParams()  — detect context, blend profile, apply EMA.
 *   detectContext()          — pattern-match current + history messages.
 *   EmaStore                 — injectable interface for persisting learned
 *                              per-context adjustments.
 *   InMemoryEmaStore         — default in-process EMA store for dev/tests.
 *   updateEma()              — record a rating (1–5) and update EMA delta.
 *
 * Context types: code | creative | analytical | conversational | chaotic
 * Tunes:         temperature, top_p, top_k, frequency_penalty,
 *                presence_penalty, repetition_penalty
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ContextType = "code" | "creative" | "analytical" | "conversational" | "chaotic";

/** Auto tune params interface definition. */
export interface AutoTuneParams {
  temperature: number;
  top_p: number;
  top_k: number;
  frequency_penalty: number;
  presence_penalty: number;
  repetition_penalty: number;
}

/** Context score interface definition. */
export interface ContextScore {
  type: ContextType;
  score: number;
  percentage: number;
}

/** Auto tune result interface definition. */
export interface AutoTuneResult {
  params: AutoTuneParams;
  detectedContext: ContextType;
  confidence: number;
  reasoning: string;
  contextScores: ContextScore[];
}

// ── Context detection patterns ────────────────────────────────────────────────

const CONTEXT_PATTERNS: Record<ContextType, RegExp[]> = {
  code: [
    /\b(code|function|class|variable|bug|error|debug|compile|syntax|api|endpoint|regex|algorithm|refactor|typescript|javascript|python|rust|html|css|sql|json|xml|import|export|return|async|await|promise|interface|type|const|let|var)\b/i,
    /```[\s\S]*```/,
    /\b(fix|implement|write|create|build|deploy|test|unit test|lint|npm|pip|cargo|git)\b.*\b(code|function|app|service|component|module)\b/i,
    /[{}();=><]/,
  ],
  creative: [
    /\b(write|story|poem|creative|imagine|fiction|narrative|character|plot|scene|dialogue|metaphor|lyrics|song|artistic|fantasy|dream|inspire|prose|verse|haiku)\b/i,
    /\b(describe|paint|envision|portray|illustrate|craft)\b.*\b(world|scene|character|feeling|emotion|atmosphere)\b/i,
    /\b(roleplay|role-play|pretend|act as|you are a)\b/i,
    /\b(brainstorm|ideate|come up with|think of|generate ideas)\b/i,
  ],
  analytical: [
    /\b(analyze|analysis|compare|contrast|evaluate|assess|examine|investigate|research|study|review|critique|breakdown|data|statistics|metrics|benchmark|measure)\b/i,
    /\b(pros and cons|advantages|disadvantages|trade-?offs|implications|consequences)\b/i,
    /\b(why|how does|what causes|explain|elaborate|clarify|define|summarize|overview)\b/i,
    /\b(report|document|technical|specification|architecture|diagram|whitepaper)\b/i,
  ],
  conversational: [
    /\b(hey|hi|hello|sup|what's up|how are you|thanks|thank you|cool|nice|awesome|great|lol|haha)\b/i,
    /\b(chat|talk|tell me about|what do you think|opinion|feel|believe)\b/i,
    /^.{0,30}$/,
  ],
  chaotic: [
    /\b(chaos|random|wild|crazy|absurd|surreal|glitch|corrupt|destroy|unleash|madness|void|entropy)\b/i,
    /(!{3,}|\?{3,}|\.{4,})/,
    /\b(gl1tch|h4ck|pwn|1337|l33t)\b/i,
  ],
};

// ── Context-to-params profiles ────────────────────────────────────────────────

const CONTEXT_PROFILES: Record<ContextType, AutoTuneParams> = {
  code: {
    temperature: 0.15,
    top_p: 0.8,
    top_k: 25,
    frequency_penalty: 0.2,
    presence_penalty: 0.0,
    repetition_penalty: 1.05,
  },
  creative: {
    temperature: 1.15,
    top_p: 0.95,
    top_k: 85,
    frequency_penalty: 0.5,
    presence_penalty: 0.7,
    repetition_penalty: 1.2,
  },
  analytical: {
    temperature: 0.4,
    top_p: 0.88,
    top_k: 40,
    frequency_penalty: 0.2,
    presence_penalty: 0.15,
    repetition_penalty: 1.08,
  },
  conversational: {
    temperature: 0.75,
    top_p: 0.9,
    top_k: 50,
    frequency_penalty: 0.1,
    presence_penalty: 0.1,
    repetition_penalty: 1.0,
  },
  chaotic: {
    temperature: 1.7,
    top_p: 0.99,
    top_k: 100,
    frequency_penalty: 0.8,
    presence_penalty: 0.9,
    repetition_penalty: 1.3,
  },
};

const BALANCED: AutoTuneParams = {
  temperature: 0.7,
  top_p: 0.9,
  top_k: 50,
  frequency_penalty: 0.1,
  presence_penalty: 0.1,
  repetition_penalty: 1.0,
};

// ── EMA store ─────────────────────────────────────────────────────────────────

/**
 * Learned parameter delta for a context type.
 * `samples` tracks how many ratings have been recorded.
 */
export interface LearnedDelta {
  temperature: number;
  top_p: number;
  frequency_penalty: number;
  presence_penalty: number;
  samples: number;
}

/** Injectable store for persisting EMA feedback. */
export interface EmaStore {
  get(context: ContextType): Promise<LearnedDelta | undefined>;
  set(context: ContextType, delta: LearnedDelta): Promise<void>;
}

/** In memory ema store. */
export class InMemoryEmaStore implements EmaStore {
  private readonly data = new Map<ContextType, LearnedDelta>();

  async get(context: ContextType): Promise<LearnedDelta | undefined> {
    return this.data.get(context);
  }

  async set(context: ContextType, delta: LearnedDelta): Promise<void> {
    this.data.set(context, delta);
  }
}

// EMA smoothing factor — 0.2 = slow learner, 0.5 = fast learner
const EMA_ALPHA = 0.2;
const RATING_NEUTRAL = 3; // rating = 3 → no adjustment

/**
 * Record a user rating (1–5) for a completed generation in the given context.
 * Updates the EMA deltas so future calls to computeAutoTuneParams() adjust accordingly.
 *
 * rating < 3 → too boring / too constrained → nudge temp + creativity up
 * rating > 3 → just right or better      → nudge temp + creativity down (was too wild)
 */
export async function updateEma(
  context: ContextType,
  rating: number,
  store: EmaStore,
): Promise<LearnedDelta> {
  const clamped = Math.max(1, Math.min(5, rating));
  const deviation = clamped - RATING_NEUTRAL; // -2 to +2
  // Positive deviation = user liked it = current params are good → shrink delta toward 0
  // Negative deviation = user disliked it = need more temperature
  const tempAdjust = (-deviation / 2) * 0.05; // max ±0.05 per rating

  const prev = (await store.get(context)) ?? {
    temperature: 0,
    top_p: 0,
    frequency_penalty: 0,
    presence_penalty: 0,
    samples: 0,
  };

  const updated: LearnedDelta = {
    temperature: prev.temperature * (1 - EMA_ALPHA) + tempAdjust * EMA_ALPHA,
    top_p: prev.top_p * (1 - EMA_ALPHA) + (tempAdjust * 0.5) * EMA_ALPHA,
    frequency_penalty: prev.frequency_penalty,
    presence_penalty: prev.presence_penalty,
    samples: prev.samples + 1,
  };

  await store.set(context, updated);
  return updated;
}

// ── Context detection ─────────────────────────────────────────────────────────

export interface DetectionResult {
  type: ContextType;
  confidence: number;
  scores: ContextScore[];
}

/** Detect context. */
export function detectContext(
  message: string,
  history: ReadonlyArray<{ role: string; content: string }> = [],
): DetectionResult {
  const raw: Record<ContextType, number> = {
    code: 0,
    creative: 0,
    analytical: 0,
    conversational: 0,
    chaotic: 0,
  };

  for (const [ctx, patterns] of Object.entries(CONTEXT_PATTERNS) as [ContextType, RegExp[]][]) {
    for (const p of patterns) {
      if (p.test(message)) raw[ctx] += 3;
    }
  }

  const recent = history.slice(-4);
  for (const m of recent) {
    for (const [ctx, patterns] of Object.entries(CONTEXT_PATTERNS) as [ContextType, RegExp[]][]) {
      for (const p of patterns) {
        if (p.test(m.content)) raw[ctx] += 1;
      }
    }
  }

  const entries = Object.entries(raw) as [ContextType, number][];
  const total = entries.reduce((s, [, v]) => s + v, 0);

  if (total === 0) {
    return {
      type: "conversational",
      confidence: 0.5,
      scores: entries.map(([type]) => ({ type, score: 0, percentage: 0 })),
    };
  }

  const scores: ContextScore[] = entries
    .map(([type, score]) => ({
      type,
      score,
      percentage: Math.round((score / total) * 100),
    }))
    .sort((a, b) => b.score - a.score);

  const best = scores[0]!;

  return {
    type: best.type,
    confidence: Math.min(best.score / total, 1.0),
    scores,
  };
}

// ── Parameter helpers ─────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

function applyBounds(p: AutoTuneParams): AutoTuneParams {
  return {
    temperature: clamp(p.temperature, 0.0, 2.0),
    top_p: clamp(p.top_p, 0.0, 1.0),
    top_k: clamp(Math.round(p.top_k), 1, 100),
    frequency_penalty: clamp(p.frequency_penalty, -2.0, 2.0),
    presence_penalty: clamp(p.presence_penalty, -2.0, 2.0),
    repetition_penalty: clamp(p.repetition_penalty, 0.0, 2.0),
  };
}

function blendParams(a: AutoTuneParams, b: AutoTuneParams, w: number): AutoTuneParams {
  const bw = clamp(w, 0, 1);
  const aw = 1 - bw;
  return {
    temperature: a.temperature * aw + b.temperature * bw,
    top_p: a.top_p * aw + b.top_p * bw,
    top_k: Math.round(a.top_k * aw + b.top_k * bw),
    frequency_penalty: a.frequency_penalty * aw + b.frequency_penalty * bw,
    presence_penalty: a.presence_penalty * aw + b.presence_penalty * bw,
    repetition_penalty: a.repetition_penalty * aw + b.repetition_penalty * bw,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ComputeOptions {
  message: string;
  history?: ReadonlyArray<{ role: string; content: string }>;
  overrides?: Partial<AutoTuneParams>;
  /** If provided, apply EMA learned adjustments. */
  learnedDelta?: LearnedDelta;
}

/**
 * Compute optimal sampling parameters for the given conversation context.
 * Pure function — all I/O (EMA store reads) must be resolved before calling.
 */
export function computeAutoTuneParams(opts: ComputeOptions): AutoTuneResult {
  const { message, history = [], overrides, learnedDelta } = opts;

  const detection = detectContext(message, history);
  const { type, confidence, scores } = detection;

  // Blend with balanced if low confidence
  let params: AutoTuneParams =
    confidence < 0.6
      ? blendParams(CONTEXT_PROFILES[type], BALANCED, 1 - confidence)
      : { ...CONTEXT_PROFILES[type] };

  // Conversation length penalty
  const convLen = history.length;
  if (convLen > 10) {
    const boost = Math.min((convLen - 10) * 0.01, 0.15);
    params = { ...params, repetition_penalty: params.repetition_penalty + boost };
  }

  // Apply EMA learned adjustments
  if (learnedDelta && learnedDelta.samples >= 3) {
    params = {
      ...params,
      temperature: params.temperature + learnedDelta.temperature,
      top_p: params.top_p + learnedDelta.top_p,
    };
  }

  // User overrides take absolute precedence
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (v !== undefined) {
        (params as Record<string, number>)[k] = v;
      }
    }
  }

  const finalParams = applyBounds(params);

  const reasoning =
    `Detected: ${type} (${Math.round(confidence * 100)}% confidence)` +
    (convLen > 10 ? ` | Long conversation: +repetition_penalty` : "") +
    (learnedDelta && learnedDelta.samples >= 3
      ? ` | EMA (${learnedDelta.samples} samples)`
      : "");

  return { params: finalParams, detectedContext: type, confidence, reasoning, contextScores: scores };
}

/** Convenience label map. */
export const CONTEXT_LABELS: Record<ContextType, string> = {
  code: "CODE",
  creative: "CREATIVE",
  analytical: "ANALYTICAL",
  conversational: "CHAT",
  chaotic: "CHAOS",
};
