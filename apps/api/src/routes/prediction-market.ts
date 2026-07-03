// SPDX-License-Identifier: Apache-2.0
/**
 * Prediction-market routes — Polymarket price relay with tiered CDN caching.
 *
 * GET  /api/v1/prediction-markets              — list markets (category/ids/limit)
 * GET  /api/v1/prediction-markets/:id          — single market by condition ID
 * POST /api/v1/prediction-markets/refresh/:id  — force-refresh a market from upstream
 * GET  /api/v1/prediction-markets/cache/status — cache size + tier info
 *
 * Real backend (PolymarketHttpBackend) is used when POLYMARKET_ENABLED=true.
 * Falls back to MockMarketBackend otherwise so the API stays functional without
 * any external dependency.
 */

import {
  PredictionMarketService,
  PolymarketHttpBackend,
  MockMarketBackend,
  CACHE_TIERS,
  type MarketQuery,
} from "@nexus/prediction-market";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Service singleton ─────────────────────────────────────────────────────────

let _svc: PredictionMarketService | null = null;

function getSvc(): PredictionMarketService {
  if (!_svc) {
    const useReal = process.env.POLYMARKET_ENABLED === "true";
    const backend = useReal
      ? new PolymarketHttpBackend({
          baseUrl: process.env.POLYMARKET_BASE_URL ?? "https://clob.polymarket.com",
        })
      : new MockMarketBackend();

    _svc = new PredictionMarketService({
      backend,
      apiKeys: process.env.PREDICTION_MARKET_API_KEYS?.split(",").filter(Boolean),
      requestsPerMinute: parseInt(process.env.PREDICTION_MARKET_RPM ?? "60", 10),
      cacheTier: (process.env.PREDICTION_MARKET_CACHE_TIER as "hot" | "warm" | "cold") ?? "warm",
    });
  }
  return _svc;
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function predictionMarketRoutes(app: FastifyInstance): Promise<void> {
  /** GET /prediction-markets — list markets */
  app.get<{
    Querystring: { category?: string; ids?: string; limit?: string };
  }>("/prediction-markets", { preHandler: requireAuth }, async (request, reply) => {
    const apiKey = request.headers["x-api-key"] as string | undefined;
    const query: MarketQuery = {};
    if (request.query.category) query.category = request.query.category;
    if (request.query.ids) query.ids = request.query.ids.split(",").map((s) => s.trim());
    if (request.query.limit) query.limit = Math.min(parseInt(request.query.limit, 10), 100);

    const result = await getSvc().getMarkets(query, apiKey);

    if (result.unauthorized) return reply.code(401).send({ error: "Invalid or missing API key" });
    if (result.rateLimited) return reply.code(429).send({ error: "Rate limit exceeded" });
    if (result.error) return reply.code(502).send({ error: result.error });

    return reply.send(result.data);
  });

  /** GET /prediction-markets/:id — single market */
  app.get<{ Params: { id: string } }>(
    "/prediction-markets/:id",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const apiKey = request.headers["x-api-key"] as string | undefined;
      const result = await getSvc().getMarket(request.params.id, apiKey);

      if (result.unauthorized) return reply.code(401).send({ error: "Invalid or missing API key" });
      if (result.rateLimited) return reply.code(429).send({ error: "Rate limit exceeded" });
      if (result.error) return reply.code(502).send({ error: result.error });
      if (!result.data) return reply.code(404).send({ error: "Market not found" });

      return reply.send(result.data);
    },
  );

  /** POST /prediction-markets/refresh/:id — force-refresh from upstream */
  app.post<{ Params: { id: string } }>(
    "/prediction-markets/refresh/:id",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const apiKey = request.headers["x-api-key"] as string | undefined;
      const svc = getSvc();

      // Invalidate cache then fetch fresh
      svc.getClient().getCache().invalidate(`market:${request.params.id}`);
      const result = await svc.getMarket(request.params.id, apiKey);

      if (result.unauthorized) return reply.code(401).send({ error: "Invalid or missing API key" });
      if (result.rateLimited) return reply.code(429).send({ error: "Rate limit exceeded" });
      if (result.error) return reply.code(502).send({ error: result.error });
      if (!result.data) return reply.code(404).send({ error: "Market not found" });

      return reply.send({ refreshed: true, market: result.data });
    },
  );

  /** GET /prediction-markets/cache/status */
  app.get(
    "/prediction-markets/cache/status",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_req, reply) => {
      const cache = getSvc().getClient().getCache();
      return reply.send({
        size: cache.size(),
        tiers: CACHE_TIERS,
        backend: process.env.POLYMARKET_ENABLED === "true" ? "polymarket-http" : "mock",
      });
    },
  );
}
