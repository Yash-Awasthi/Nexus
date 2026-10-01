// SPDX-License-Identifier: Apache-2.0
/**
 * Prediction-market routes — Polymarket price relay with tiered CDN caching.
 *
 * GET  /api/v1/prediction-markets              — list markets (category/ids/limit)
 * GET  /api/v1/prediction-markets/:id          — single market by condition ID
 * POST /api/v1/prediction-markets/refresh/:id  — force-refresh a market from upstream
 * GET  /api/v1/prediction-markets/cache/status — cache size + tier info
 * GET  /api/v1/prediction-markets/:id/book     — live order book of one outcome (Polymarket)
 * POST /api/v1/prediction-markets/:id/forecast — models forecast the market; consensus vs price
 *
 * `?source=` picks Polymarket (default; needs POLYMARKET_ENABLED=true), Kalshi (public reads)
 * or Metaculus (needs METACULUS_TOKEN). An unconfigured source answers 503 and names the setting.
 */

import type { LlmRole } from "@nexus/llm-drivers";
import {
  PredictionMarketService,
  SwarmConsensus,
  avgPriceForQuantity,
  bookMidpoint,
  bookSpread,
  fetchPolymarketBook,
  PolymarketHttpBackend,
  KalshiHttpBackend,
  MetaculusHttpBackend,
  CACHE_TIERS,
  type MarketQuery,
} from "@nexus/prediction-market";
import type { FastifyInstance } from "fastify";

import { buildUserDriverRegistry } from "../lib/provider-keys.js";
import { requireAuth } from "../middleware/auth.js";

interface ForecastMember {
  label?: string;
  provider: string;
  model: string;
}

/** "PROBABILITY: 62%" → 0.62; null when the reply names no probability. */
function parseProbability(text: string): number | null {
  const m = /probability\W*(\d{1,3}(?:\.\d+)?)\s*%/i.exec(text);
  const n = m ? Number(m[1]) : NaN;
  return n >= 0 && n <= 100 ? n / 100 : null;
}

// ── Services, one per source ──────────────────────────────────────────────────

type Source = "polymarket" | "kalshi" | "metaculus";
const SOURCES: Source[] = ["polymarket", "kalshi", "metaculus"];

/** Why a source cannot answer here, or null when it can. Checked per request (env may change). */
function sourceOff(source: Source): string | null {
  if (source === "polymarket" && process.env.POLYMARKET_ENABLED !== "true")
    return "Prediction markets are off: set POLYMARKET_ENABLED=true to read Polymarket.";
  if (source === "metaculus" && !process.env.METACULUS_TOKEN)
    return "Metaculus needs an API token: set METACULUS_TOKEN.";
  return null;
}

const _svcs = new Map<Source, PredictionMarketService>();

function getSvc(source: Source = "polymarket"): PredictionMarketService {
  let svc = _svcs.get(source);
  if (!svc) {
    const backend =
      source === "kalshi"
        ? new KalshiHttpBackend()
        : source === "metaculus"
          ? new MetaculusHttpBackend()
          : new PolymarketHttpBackend({
              baseUrl: process.env.POLYMARKET_BASE_URL ?? "https://clob.polymarket.com",
            });
    svc = new PredictionMarketService({
      backend,
      apiKeys: process.env.PREDICTION_MARKET_API_KEYS?.split(",").filter(Boolean),
      requestsPerMinute: parseInt(process.env.PREDICTION_MARKET_RPM ?? "60", 10),
      cacheTier: (process.env.PREDICTION_MARKET_CACHE_TIER as "hot" | "warm" | "cold") ?? "warm",
    });
    _svcs.set(source, svc);
  }
  return svc;
}

/** The requested source, or a reply already sent (400 unknown, 503 unconfigured). */
function pickSource(
  raw: string | undefined,
  reply: { code(n: number): { send(b: unknown): unknown } },
): Source | null {
  const source = (raw ?? "polymarket") as Source;
  if (!SOURCES.includes(source)) {
    reply.code(400).send({ error: `source must be one of: ${SOURCES.join(", ")}` });
    return null;
  }
  const off = sourceOff(source);
  if (off) {
    reply.code(503).send({ error: off });
    return null;
  }
  return source;
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function predictionMarketRoutes(app: FastifyInstance): Promise<void> {
  /** GET /prediction-markets — list markets */
  app.get<{
    Querystring: { category?: string; ids?: string; limit?: string; source?: string };
  }>("/prediction-markets", { preHandler: requireAuth }, async (request, reply) => {
    const source = pickSource(request.query.source, reply);
    if (!source) return reply;
    const apiKey = request.headers["x-api-key"] as string | undefined;
    const query: MarketQuery = {};
    if (request.query.category) query.category = request.query.category;
    if (request.query.ids) query.ids = request.query.ids.split(",").map((s) => s.trim());
    if (request.query.limit) query.limit = Math.min(parseInt(request.query.limit, 10), 100);

    const result = await getSvc(source).getMarkets(query, apiKey);

    if (result.unauthorized) return reply.code(401).send({ error: "Invalid or missing API key" });
    if (result.rateLimited) return reply.code(429).send({ error: "Rate limit exceeded" });
    if (result.error) return reply.code(502).send({ error: result.error });

    return reply.send(result.data);
  });

  /** GET /prediction-markets/:id — single market */
  app.get<{ Params: { id: string }; Querystring: { source?: string } }>(
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
      const source = pickSource(request.query.source, reply);
      if (!source) return reply;
      const apiKey = request.headers["x-api-key"] as string | undefined;
      const result = await getSvc(source).getMarket(request.params.id, apiKey);

      if (result.unauthorized) return reply.code(401).send({ error: "Invalid or missing API key" });
      if (result.rateLimited) return reply.code(429).send({ error: "Rate limit exceeded" });
      if (result.error) return reply.code(502).send({ error: result.error });
      if (!result.data) return reply.code(404).send({ error: "Market not found" });

      return reply.send(result.data);
    },
  );

  /** POST /prediction-markets/refresh/:id — force-refresh from upstream */
  app.post<{ Params: { id: string }; Querystring: { source?: string } }>(
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
      const source = pickSource(request.query.source, reply);
      if (!source) return reply;
      const apiKey = request.headers["x-api-key"] as string | undefined;
      const svc = getSvc(source);

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

  app.get<{ Params: { id: string }; Querystring: { outcome?: string } }>(
    "/prediction-markets/:id/book",
    { preHandler: requireAuth },
    async (request, reply) => {
      const source = pickSource("polymarket", reply);
      if (!source) return reply;
      const market = await getSvc(source).getMarket(request.params.id);
      if (market.error) return reply.code(502).send({ error: market.error });
      const outcome =
        market.data?.outcomes.find((o) => o.id === request.query.outcome) ??
        market.data?.outcomes[0];
      if (!outcome) return reply.code(404).send({ error: "Market not found" });
      try {
        const book = await fetchPolymarketBook(outcome.id);
        return reply.send({
          outcome,
          bids: book.bids.slice(0, 10),
          asks: book.asks.slice(0, 10),
          midpoint: bookMidpoint(book) ?? null,
          spread: bookSpread(book) ?? null,
          // What 100 shares would cost to buy, or fetch to sell, walking the book.
          fill100: {
            buy: avgPriceForQuantity(book, "BUY", 100),
            sell: avgPriceForQuantity(book, "SELL", 100),
          },
        });
      } catch (err) {
        return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post<{
    Params: { id: string };
    Querystring: { source?: string };
    Body: { members?: ForecastMember[] };
  }>("/prediction-markets/:id/forecast", { preHandler: requireAuth }, async (request, reply) => {
    const members = (request.body?.members ?? []).slice(0, 6);
    if (members.length === 0 || members.some((m) => !m.provider || !m.model))
      return reply.code(400).send({ error: "members: one to six { provider, model }" });
    const source = pickSource(request.query.source, reply);
    if (!source) return reply;
    const result = await getSvc(source).getMarket(request.params.id);
    if (result.error) return reply.code(502).send({ error: result.error });
    const market = result.data;
    if (!market) return reply.code(404).send({ error: "Market not found" });
    const yes = market.outcomes.find((o) => /^yes$/i.test(o.label)) ?? market.outcomes[0];
    const marketYes = yes?.probability ?? 0.5;

    const prompt =
      `Prediction market: "${market.question}"\n` +
      `Current prices: ${market.outcomes.map((o) => `${o.label} ${Math.round(o.price * 100)}%`).join(", ")}` +
      `${market.resolveAt ? `; resolves ${market.resolveAt}` : ""}.\n` +
      `Estimate the probability that it resolves ${yes?.label ?? "Yes"}. Think independently of the price. ` +
      "Reply exactly:\nPROBABILITY: <0-100>%\nREASON: <one sentence>";
    const { registry } = await buildUserDriverRegistry(
      request.nexusUserId,
      members.map((m) => m.provider),
    );
    const predictions = await Promise.all(
      members.map(async (m, i) => {
        const label = m.label ?? m.model;
        const driver = registry.get(m.provider);
        if (!driver) return { label, value: null, reasoning: `No key for ${m.provider}.` };
        try {
          const res = await driver.complete({
            model: m.model,
            messages: [{ role: "user" as LlmRole, content: prompt }],
            maxTokens: 1200,
            temperature: 0.3,
          });
          const reason = /reason\W*(\w[\s\S]*)/i.exec(res.content)?.[1]?.trim();
          return {
            label,
            predictorId: `m${i}`,
            value: parseProbability(res.content),
            reasoning: (reason || res.content.trim() || "No reply.").slice(0, 300),
          };
        } catch (err) {
          return {
            label,
            value: null,
            reasoning: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    const counted = predictions.flatMap((p) =>
      p.value === null || !("predictorId" in p)
        ? []
        : [{ predictorId: p.predictorId!, value: p.value, confidence: 1 }],
    );
    if (counted.length === 0)
      return reply.send({ market, marketYes, consensus: null, edge: null, predictions });
    const swarm = new SwarmConsensus().aggregate(counted);
    return reply.send({
      market,
      marketYes,
      consensus: swarm.consensus,
      mean: swarm.mean,
      spread: swarm.spread,
      edge: Math.round((swarm.consensus - marketYes) * 10000) / 10000,
      predictions,
    });
  });

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
        sources: Object.fromEntries(SOURCES.map((src) => [src, sourceOff(src) ?? "on"])),
      });
    },
  );
}
