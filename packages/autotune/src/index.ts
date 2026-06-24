// SPDX-License-Identifier: Apache-2.0
// AutoTune — EMA-based adaptive LLM sampling parameter optimisation.

export type ContextType = "code" | "creative" | "analytical" | "conversational" | "chaotic";

export const CONTEXT_LABELS: Record<ContextType, string> = {
  code: "Code / Technical",
  creative: "Creative Writing",
  analytical: "Analysis / Reasoning",
  conversational: "Conversational",
  chaotic: "Chaotic / Experimental",
};

export interface EmaDelta {
  temperature: number;
  top_p: number;
  frequency_penalty: number;
  presence_penalty: number;
  samples: number;
}

export interface EmaStore {
  get(context: ContextType): Promise<EmaDelta | undefined>;
  set(context: ContextType, delta: EmaDelta): Promise<void>;
}

export class InMemoryEmaStore implements EmaStore {
  private store = new Map<ContextType, EmaDelta>();
  async get(context: ContextType): Promise<EmaDelta | undefined> {
    return this.store.get(context);
  }
  async set(context: ContextType, delta: EmaDelta): Promise<void> {
    this.store.set(context, delta);
  }
}

export interface DetectionResult {
  type: ContextType;
  confidence: number;
  scores: Record<ContextType, number>;
}

const CODE_PATTERNS = /```|function |=>|const |import |class |def |var |let /i;
const CREATIVE_PATTERNS = /story|poem|write|imagine|fiction|narrative|character/i;
const ANALYTICAL_PATTERNS = /analyze|compare|explain|why|how does|what is|evaluate/i;
const CHAOTIC_PATTERNS = /wtf|!!!|random|chaos|wild|crazy|insane/i;

export function detectContext(
  message: string,
  _history: Array<{ role: string; content: string }>,
): DetectionResult {
  const scores: Record<ContextType, number> = {
    code: CODE_PATTERNS.test(message) ? 0.8 : 0.1,
    creative: CREATIVE_PATTERNS.test(message) ? 0.7 : 0.1,
    analytical: ANALYTICAL_PATTERNS.test(message) ? 0.6 : 0.2,
    conversational: 0.3,
    chaotic: CHAOTIC_PATTERNS.test(message) ? 0.9 : 0.05,
  };
  const sorted = (Object.entries(scores) as [ContextType, number][]).sort((a, b) => b[1] - a[1]);
  const [type, confidence] = sorted[0]!;
  return { type, confidence, scores };
}

const BASE_PARAMS: Record<
  ContextType,
  {
    temperature: number;
    top_p: number;
    frequency_penalty: number;
    presence_penalty: number;
    top_k: number;
  }
> = {
  code: { temperature: 0.2, top_p: 0.9, frequency_penalty: 0.0, presence_penalty: 0.0, top_k: 40 },
  creative: {
    temperature: 0.9,
    top_p: 0.95,
    frequency_penalty: 0.3,
    presence_penalty: 0.2,
    top_k: 80,
  },
  analytical: {
    temperature: 0.4,
    top_p: 0.9,
    frequency_penalty: 0.1,
    presence_penalty: 0.1,
    top_k: 50,
  },
  conversational: {
    temperature: 0.7,
    top_p: 0.9,
    frequency_penalty: 0.2,
    presence_penalty: 0.1,
    top_k: 60,
  },
  chaotic: {
    temperature: 1.2,
    top_p: 1.0,
    frequency_penalty: 0.5,
    presence_penalty: 0.4,
    top_k: 100,
  },
};

export function computeAutoTuneParams(opts: {
  message: string;
  history?: Array<{ role: string; content: string }>;
  overrides?: Record<string, number>;
  learnedDelta?: EmaDelta;
}): {
  params: Record<string, number>;
  detectedContext: ContextType;
  confidence: number;
  reasoning: string;
  contextScores: Record<ContextType, number>;
} {
  const { message, history = [], overrides, learnedDelta } = opts;
  const detection = detectContext(message, history);
  const base = { ...BASE_PARAMS[detection.type] };

  if (learnedDelta && learnedDelta.samples >= 3) {
    base.temperature = Math.max(0, Math.min(2, base.temperature + learnedDelta.temperature));
    base.top_p = Math.max(0, Math.min(1, base.top_p + learnedDelta.top_p));
    base.frequency_penalty = Math.max(
      -2,
      Math.min(2, base.frequency_penalty + learnedDelta.frequency_penalty),
    );
    base.presence_penalty = Math.max(
      -2,
      Math.min(2, base.presence_penalty + learnedDelta.presence_penalty),
    );
  }

  const params = { ...base, ...(overrides ?? {}) };
  return {
    params,
    detectedContext: detection.type,
    confidence: detection.confidence,
    reasoning: `Context detected as '${detection.type}' (confidence ${(detection.confidence * 100).toFixed(0)}%).`,
    contextScores: detection.scores,
  };
}

const EMA_ALPHA = 0.3;
const RATING_DELTAS: Record<number, number> = { 1: -0.15, 2: -0.07, 3: 0, 4: 0.07, 5: 0.15 };

export async function updateEma(
  context: ContextType,
  rating: number,
  store: EmaStore,
): Promise<EmaDelta> {
  const existing = (await store.get(context)) ?? {
    temperature: 0,
    top_p: 0,
    frequency_penalty: 0,
    presence_penalty: 0,
    samples: 0,
  };
  const delta = RATING_DELTAS[rating] ?? 0;
  const updated: EmaDelta = {
    temperature: existing.temperature * (1 - EMA_ALPHA) + delta * EMA_ALPHA,
    top_p: existing.top_p * (1 - EMA_ALPHA) + delta * 0.5 * EMA_ALPHA,
    frequency_penalty: existing.frequency_penalty * (1 - EMA_ALPHA) + delta * 0.3 * EMA_ALPHA,
    presence_penalty: existing.presence_penalty * (1 - EMA_ALPHA) + delta * 0.3 * EMA_ALPHA,
    samples: existing.samples + 1,
  };
  await store.set(context, updated);
  return updated;
}
