// SPDX-License-Identifier: Apache-2.0
/**
 * Domain feed routes — structured data feeds per domain (weather, markets, etc.)
 *
 * GET  /api/v1/domain-feeds             — list available feed domains
 * GET  /api/v1/domain-feeds/:domain     — get latest entries for a domain
 * POST /api/v1/domain-feeds/:domain     — push a new feed entry
 * DELETE /api/v1/domain-feeds/:domain/entries/:id — remove entry
 *
 * Real polling (activated by env vars):
 *   OPENWEATHER_API_KEY → polls OpenWeatherMap every 5 min → "weather" feed
 *   (no key needed)     → polls CoinGecko every 5 min      → "crypto" feed
 *   NEWS_API_KEY        → polls NewsAPI every 5 min         → "news" feed
 */

import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── In-memory feed store ──────────────────────────────────────────────────────

interface FeedEntry {
  id: string;
  domain: string;
  payload: Record<string, unknown>;
  source?: string;
  createdAt: string;
}

const SUPPORTED_DOMAINS = [
  "weather",
  "markets",
  "polymarket",
  "crypto",
  "news",
  "sports",
  "research",
] as const;

type FeedDomain = typeof SUPPORTED_DOMAINS[number];

const feedStore = new Map<FeedDomain, FeedEntry[]>(
  SUPPORTED_DOMAINS.map((d) => [d, []]),
);

function getEntries(domain: FeedDomain): FeedEntry[] {
  return feedStore.get(domain) ?? [];
}

function pushEntry(domain: FeedDomain, payload: Record<string, unknown>, source: string): void {
  const entries = feedStore.get(domain)!;
  entries.push({
    id: randomUUID(),
    domain,
    payload,
    source,
    createdAt: new Date().toISOString(),
  });
  // Cap at 500 entries per domain
  if (entries.length > 500) entries.splice(0, entries.length - 500);
}

// ── Real feed pollers ─────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function pollWeather(): Promise<void> {
  const key = process.env.OPENWEATHER_API_KEY;
  if (!key) return;
  const city = process.env.OPENWEATHER_CITY ?? "London";
  try {
    const resp = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${key}&units=metric`,
    );
    if (!resp.ok) return;
    const data = await resp.json() as Record<string, unknown>;
    pushEntry("weather", data, "openweathermap");
  } catch { /* best-effort */ }
}

async function pollCrypto(): Promise<void> {
  try {
    const resp = await fetch(
      "https://api.coingecko.com/api/v3/simple/price" +
      "?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true",
    );
    if (!resp.ok) return;
    const data = await resp.json() as Record<string, unknown>;
    pushEntry("crypto", data, "coingecko");
  } catch { /* best-effort — CoinGecko has rate limits on free tier */ }
}

async function pollNews(): Promise<void> {
  const key = process.env.NEWS_API_KEY;
  if (!key) return;
  try {
    const resp = await fetch(
      `https://newsapi.org/v2/top-headlines?language=en&pageSize=5&apiKey=${key}`,
    );
    if (!resp.ok) return;
    const data = await resp.json() as { articles?: Array<Record<string, unknown>> };
    for (const article of data.articles ?? []) {
      pushEntry("news", article, "newsapi");
    }
  } catch { /* best-effort */ }
}

// Guard against multiple plugin registrations starting duplicate pollers
let _pollersStarted = false;

function startPollers(): void {
  if (_pollersStarted) return;
  _pollersStarted = true;

  // Immediate first poll
  void pollWeather();
  void pollCrypto();
  void pollNews();

  // Recurring polls
  setInterval(() => { void pollWeather(); }, POLL_INTERVAL_MS);
  setInterval(() => { void pollCrypto(); }, POLL_INTERVAL_MS);
  setInterval(() => { void pollNews(); }, POLL_INTERVAL_MS);
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function domainFeedsRoutes(app: FastifyInstance): Promise<void> {
  // Start background pollers when the plugin registers
  startPollers();

  /** GET /domain-feeds — list domains + entry counts */
  app.get("/domain-feeds", { preHandler: requireAuth }, async (_req, reply) => {
    const domains = SUPPORTED_DOMAINS.map((d) => ({
      domain: d,
      count: getEntries(d).length,
      latest: getEntries(d).at(-1)?.createdAt ?? null,
    }));
    return reply.send({ domains });
  });

  /** GET /domain-feeds/:domain?limit=&since= */
  app.get<{
    Params: { domain: string };
    Querystring: { limit?: string; since?: string };
  }>("/domain-feeds/:domain", { preHandler: requireAuth }, async (request, reply) => {
    const domain = request.params.domain as FeedDomain;
    if (!SUPPORTED_DOMAINS.includes(domain)) {
      return reply.code(404).send({
        error: `Unknown domain "${domain}". Supported: ${SUPPORTED_DOMAINS.join(", ")}`,
      });
    }

    const limit = Math.min(parseInt(request.query.limit ?? "50"), 200);
    const since = request.query.since;

    let entries = getEntries(domain);
    if (since) entries = entries.filter((e) => e.createdAt >= since);
    entries = entries.slice(-limit).reverse(); // newest first

    return reply.send({ domain, entries, total: entries.length });
  });

  /** POST /domain-feeds/:domain — push entry */
  app.post<{
    Params: { domain: string };
    Body: { payload: Record<string, unknown>; source?: string };
  }>("/domain-feeds/:domain", { preHandler: requireAuth }, async (request, reply) => {
    const domain = request.params.domain as FeedDomain;
    if (!SUPPORTED_DOMAINS.includes(domain)) {
      return reply.code(404).send({ error: `Unknown domain "${domain}"` });
    }

    const entry: FeedEntry = {
      id: randomUUID(),
      domain,
      payload: request.body.payload,
      source: request.body.source,
      createdAt: new Date().toISOString(),
    };

    const entries = feedStore.get(domain)!;
    entries.push(entry);
    if (entries.length > 500) entries.splice(0, entries.length - 500);

    return reply.code(201).send(entry);
  });

  /** DELETE /domain-feeds/:domain/entries/:id */
  app.delete<{ Params: { domain: string; id: string } }>(
    "/domain-feeds/:domain/entries/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const domain = request.params.domain as FeedDomain;
      const entries = feedStore.get(domain);
      if (!entries) return reply.code(404).send({ error: "Domain not found" });

      const idx = entries.findIndex((e) => e.id === request.params.id);
      if (idx === -1) return reply.code(404).send({ error: "Entry not found" });
      entries.splice(idx, 1);

      return reply.code(204).send();
    },
  );
}
