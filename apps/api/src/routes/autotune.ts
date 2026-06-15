// SPDX-License-Identifier: Apache-2.0
/**
 * AutoTune routes — pre-generation sampling parameter optimisation + EMA feedback loop.
 *
 * POST /autotune/compute   — detect context and compute optimal LLM sampling params
 * POST /autotune/rate      — record a user rating (1–5) to update EMA deltas
 * GET  /autotune/detect    — detect context type for a message without computing params
 *
 * EMA persistence
 * ───────────────
 *   DATABASE_URL set → pg-backed store (ratings survive restarts)
 *   Otherwise        → InMemoryEmaStore (per-process, resets on restart)
 *
 * EMA deltas are per-context-type (code/creative/analytical/conversational/chaotic).
 * After ≥3 ratings the learned delta is applied to future compute() calls.
 */

import {
  InMemoryEmaStore,
  computeAutoTuneParams,
  detectContext,
  updateEma,
  CONTEXT_LABELS,
  type ContextType,
  type EmaStore,
  type LearnedDelta,
} from "@nexus/autotune";
import pg from "pg";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Pg-backed EmaStore ────────────────────────────────────────────────────────

let _pool: pg.Pool | null = null;
function getPool(): pg.Pool | null {
  if (!process.env.DATABASE_URL) return null;
  if (!_pool) _pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  return _pool;
}

async function ensureEmaSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS autotune_ema (
      context          TEXT PRIMARY KEY,
      temperature      DOUBLE PRECISION NOT NULL DEFAULT 0,
      top_p            DOUBLE PRECISION NOT NULL DEFAULT 0,
      frequency_penalty DOUBLE PRECISION NOT NULL DEFAULT 0,
      presence_penalty DOUBLE PRECISION NOT NULL DEFAULT 0,
      samples          INT NOT NULL DEFAULT 0,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

class PgEmaStore implements EmaStore {
  constructor(private pool: pg.Pool) {}

  async get(context: ContextType): Promise<LearnedDelta | undefined> {
    try {
      await ensureEmaSchema(this.pool);
      const { rows } = await this.pool.query(
        `SELECT temperature, top_p, frequency_penalty, presence_penalty, samples
           FROM autotune_ema WHERE context = $1`,
        [context],
      );
      if (rows.length === 0) return undefined;
      const r = rows[0] as Record<string, number>;
      return {
        temperature:       r["temperature"] ?? 0,
        top_p:             r["top_p"] ?? 0,
        frequency_penalty: r["frequency_penalty"] ?? 0,
        presence_penalty:  r["presence_penalty"] ?? 0,
        samples:           r["samples"] ?? 0,
      };
    } catch {
      return undefined;
    }
  }

  async set(context: ContextType, delta: LearnedDelta): Promise<void> {
    try {
      await ensureEmaSchema(this.pool);
      await this.pool.query(
        `INSERT INTO autotune_ema (context, temperature, top_p, frequency_penalty, presence_penalty, samples, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (context) DO UPDATE SET
           temperature = EXCLUDED.temperature,
           top_p = EXCLUDED.top_p,
           frequency_penalty = EXCLUDED.frequency_penalty,
           presence_penalty = EXCLUDED.presence_penalty,
           samples = EXCLUDED.samples,
           updated_at = now()`,
        [context, delta.temperature, delta.top_p, delta.frequency_penalty, delta.presence_penalty, delta.samples],
      );
    } catch {
      // silently ignore — EMA is best-effort
    }
  }
}

// ── Singleton EMA store ───────────────────────────────────────────────────────

let _emaStore: EmaStore | null = null;
function getEmaStore(): EmaStore {
  if (!_emaStore) {
    const pool = getPool();
    _emaStore = pool ? new PgEmaStore(pool) : new InMemoryEmaStore();
  }
  return _emaStore;
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function autotuneRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /autotune/compute
   *
   * Detect the conversation context and compute optimal sampling parameters.
   * Returns temperature, top_p, top_k, penalties — ready to pass to an LLM call.
   *
   * Body:
   *   message    — the current user message (required)
   *   history    — recent conversation turns [{ role, content }] (optional)
   *   overrides  — explicit param overrides (take absolute precedence)
   */
  app.post<{
    Body: {
      message: string;
      history?: Array<{ role: string; content: string }>;
      overrides?: Record<string, number>;
    };
  }>("/autotune/compute", { preHandler: requireAuth }, async (request, reply) => {
    const { message, history = [], overrides } = request.body;

    if (!message) return reply.code(400).send({ error: "message is required" });

    const store = getEmaStore();
    const detection = detectContext(message, history);
    const learnedDelta = await store.get(detection.type);

    const result = computeAutoTuneParams({
      message,
      history,
      overrides,
      learnedDelta,
    });

    return reply.send({
      params:          result.params,
      detectedContext: result.detectedContext,
      contextLabel:    CONTEXT_LABELS[result.detectedContext],
      confidence:      result.confidence,
      reasoning:       result.reasoning,
      contextScores:   result.contextScores,
      emaSamples:      learnedDelta?.samples ?? 0,
    });
  });

  /**
   * POST /autotune/rate
   *
   * Record a user rating (1–5) for a completed generation in the given context.
   * Updates EMA deltas so future compute() calls adjust accordingly.
   *
   * Body:
   *   context    — "code" | "creative" | "analytical" | "conversational" | "chaotic"
   *   rating     — integer 1–5 (3 = neutral, 1 = too bad, 5 = too good/constrained)
   *   message    — optional: re-detect context if context not provided
   */
  app.post<{
    Body: {
      context?: ContextType;
      rating: number;
      message?: string;
    };
  }>("/autotune/rate", { preHandler: requireAuth }, async (request, reply) => {
    const { rating, message } = request.body;
    let { context } = request.body;

    if (!rating || rating < 1 || rating > 5) {
      return reply.code(400).send({ error: "rating must be an integer 1–5" });
    }

    if (!context) {
      if (!message) return reply.code(400).send({ error: "context or message is required" });
      const detection = detectContext(message, []);
      context = detection.type;
    }

    const store = getEmaStore();
    const updated = await updateEma(context, rating, store);

    return reply.send({
      context,
      contextLabel: CONTEXT_LABELS[context],
      rating,
      emaDelta:     updated,
    });
  });

  /**
   * GET /autotune/detect?message=<text>
   *
   * Detect the context type for a message without computing sampling params.
   * Useful for UI context indicators.
   */
  app.get<{
    Querystring: { message: string };
  }>("/autotune/detect", { preHandler: requireAuth }, async (request, reply) => {
    const { message } = request.query;
    if (!message) return reply.code(400).send({ error: "message query param is required" });

    const result = detectContext(message, []);
    return reply.send({
      detectedContext: result.type,
      contextLabel:    CONTEXT_LABELS[result.type],
      confidence:      result.confidence,
      scores:          result.scores,
    });
  });
}
