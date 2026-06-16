// SPDX-License-Identifier: Apache-2.0
/**
 * Forecast routes — domain-specific forecast generation via @nexus/domain-forecast.
 *
 * GET  /api/v1/forecast/:domain            — generate (or return cached) forecast
 * GET  /api/v1/forecast/:domain/history    — list all cached forecasts for a domain
 *
 * Wiring:
 *   createProductionGateway() is used when OWM_API_KEY is set.
 *   createDefaultGateway()    is used otherwise (MockForecastHandler for all domains).
 *
 * Caching: 60-minute TTL in-process ForecastCache.
 */

import {
  createDefaultGateway,
  createProductionGateway,
  ForecastCache,
  ForecastService,
  type ForecastDomain,
  type ForecastHorizon,
  type ForecastResult,
} from "@nexus/domain-forecast";
import { MemoryKVStore } from "@nexus/kv";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

import { requireAuth } from "../middleware/auth.js";

// ── Singleton ForecastService ─────────────────────────────────────────────────

const gateway = process.env.OWM_API_KEY ? createProductionGateway() : createDefaultGateway();

const cache = new ForecastCache(60 * 60 * 1000); // 60 min TTL
const service = new ForecastService({ gateway, cache });

// ── Durable history (pg) — in-memory Map is warm L1 cache ────────────────────

let _pool: Pool | null = null;
let _schemaReady = false;

function getPool(): Pool | null {
  if (!process.env.DATABASE_URL) return null;
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

async function ensureSchema(pool: Pool): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forecast_runs (
      id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      domain      text        NOT NULL,
      horizon     text        NOT NULL,
      result      jsonb       NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS forecast_runs_domain_idx
      ON forecast_runs (domain);
    CREATE INDEX IF NOT EXISTS forecast_runs_created_at_idx
      ON forecast_runs (created_at DESC);
  `);
  _schemaReady = true;
}

// KV-backed L1 cache (MemoryKVStore; swap RedisKVStore via REDIS_URL + ioredis when needed)
// historyKv key: domain → ForecastResult[] (most-recent-first, capped at HISTORY_CAP)
const historyKv = new MemoryKVStore();
const HISTORY_CAP = 200;

async function updateMemory(domain: ForecastDomain, result: ForecastResult): Promise<void> {
  const arr = (await historyKv.get<ForecastResult[]>(domain)) ?? [];
  arr.unshift(result);
  if (arr.length > HISTORY_CAP) arr.length = HISTORY_CAP;
  await historyKv.set(domain, arr);
}

async function persistAndRecord(domain: ForecastDomain, result: ForecastResult): Promise<void> {
  await updateMemory(domain, result);
  const pool = getPool();
  if (!pool) return;
  // fire-and-forget — never blocks the response
  ensureSchema(pool)
    .then(() =>
      pool.query(`INSERT INTO forecast_runs (domain, horizon, result) VALUES ($1, $2, $3)`, [
        domain,
        result.horizon,
        JSON.stringify(result),
      ]),
    )
    .catch((e: Error) => console.warn("[forecast] DB persist failed:", e.message));
}

async function loadHistory(domain: ForecastDomain, limit: number): Promise<ForecastResult[]> {
  const pool = getPool();
  if (!pool) return ((await historyKv.get<ForecastResult[]>(domain)) ?? []).slice(0, limit);
  try {
    await ensureSchema(pool);
    const { rows } = await pool.query<{ result: ForecastResult }>(
      `SELECT result FROM forecast_runs
       WHERE domain = $1 ORDER BY created_at DESC LIMIT $2`,
      [domain, limit],
    );
    return rows.map((r) => r.result);
  } catch (e) {
    console.warn("[forecast] DB load failed:", (e as Error).message);
    return ((await historyKv.get<ForecastResult[]>(domain)) ?? []).slice(0, limit);
  }
}

const VALID_DOMAINS: ForecastDomain[] = ["risk", "market", "geo", "military"];
const VALID_HORIZONS: ForecastHorizon[] = ["24h", "7d", "30d", "90d", "1y"];

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function forecastRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /forecast/:domain?horizon=<h>&refresh=<bool>
   *
   * Generate a forecast for the given domain.  Results are cached for 60 min.
   *
   * Params:
   *   domain  — risk | market | geo | military
   * Query:
   *   horizon — 24h | 7d | 30d | 90d | 1y  (default: 24h)
   *   refresh — true to bypass cache and force re-generation
   */
  app.get<{
    Params: { domain: string };
    Querystring: { horizon?: string; refresh?: string };
  }>("/forecast/:domain", { preHandler: requireAuth }, async (request, reply) => {
    const domain = request.params.domain as ForecastDomain;
    if (!VALID_DOMAINS.includes(domain)) {
      return reply.code(400).send({
        error: `Invalid domain '${domain}'. Valid: ${VALID_DOMAINS.join(", ")}`,
      });
    }

    const horizon = (request.query.horizon ?? "24h") as ForecastHorizon;
    if (!VALID_HORIZONS.includes(horizon)) {
      return reply.code(400).send({
        error: `Invalid horizon '${horizon}'. Valid: ${VALID_HORIZONS.join(", ")}`,
      });
    }

    const forceRefresh = request.query.refresh === "true";

    const response = await service.forecast({ domain, horizon, forceRefresh });

    if (response.status === "error") {
      return reply.code(502).send({ error: response.error ?? "Forecast generation failed" });
    }

    // Record in history (fire-and-forget DB persist when DATABASE_URL set)
    if (response.result) await persistAndRecord(domain, response.result);

    return reply.send({
      domain,
      horizon,
      requestId: response.requestId,
      cached: response.requestId === "cached",
      durationMs: response.durationMs,
      result: response.result,
    });
  });

  /**
   * GET /forecast/:domain/history?limit=<n>
   *
   * Return the in-process history of generated forecasts for a domain.
   * Capped at 200 entries (most recent first).
   *
   * Query:
   *   limit — max entries to return (default: 20, max: 200)
   */
  app.get<{
    Params: { domain: string };
    Querystring: { limit?: string };
  }>("/forecast/:domain/history", { preHandler: requireAuth }, async (request, reply) => {
    const domain = request.params.domain as ForecastDomain;
    if (!VALID_DOMAINS.includes(domain)) {
      return reply.code(400).send({
        error: `Invalid domain '${domain}'. Valid: ${VALID_DOMAINS.join(", ")}`,
      });
    }

    const limit = Math.min(parseInt(request.query.limit ?? "20", 10) || 20, 200);
    const history = await loadHistory(domain, limit);

    reply.header("Cache-Control", "private, max-age=60, stale-while-revalidate=300");
    return reply.send({ domain, history, total: history.length });
  });
}
