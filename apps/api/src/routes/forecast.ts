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
} from "@nexus/domain-forecast";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Singleton ForecastService ─────────────────────────────────────────────────

const gateway = process.env.OWM_API_KEY
  ? createProductionGateway()
  : createDefaultGateway();

const cache   = new ForecastCache(60 * 60 * 1000); // 60 min TTL
const service = new ForecastService({ gateway, cache });

// In-memory history list (LRU-capped at 200 per domain)
const historyStore = new Map<ForecastDomain, import("@nexus/domain-forecast").ForecastResult[]>();
const HISTORY_CAP = 200;

function appendHistory(domain: ForecastDomain, result: import("@nexus/domain-forecast").ForecastResult): void {
  const arr = historyStore.get(domain) ?? [];
  arr.unshift(result);
  if (arr.length > HISTORY_CAP) arr.length = HISTORY_CAP;
  historyStore.set(domain, arr);
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

    // Record in history
    if (response.result) appendHistory(domain, response.result);

    return reply.send({
      domain,
      horizon,
      requestId:   response.requestId,
      cached:      response.requestId === "cached",
      durationMs:  response.durationMs,
      result:      response.result,
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
    const history = (historyStore.get(domain) ?? []).slice(0, limit);

    return reply.send({ domain, history, total: history.length });
  });
}
