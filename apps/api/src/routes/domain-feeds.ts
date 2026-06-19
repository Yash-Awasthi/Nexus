// SPDX-License-Identifier: Apache-2.0
/**
 * Domain feed routes — structured data feeds per domain (weather, markets, etc.)
 *
 * GET  /api/v1/domain-feeds             — list available feed domains
 * GET  /api/v1/domain-feeds/:domain     — get latest entries for a domain
 * POST /api/v1/domain-feeds/:domain     — push a new feed entry
 * DELETE /api/v1/domain-feeds/:domain/entries/:id — remove entry
 *
 * Feed polling is driven by BullMQ repeatable jobs in apps/worker (not setInterval
 * here).  This eliminates N-pod duplication and the no-recovery-on-restart problem.
 *
 * Worker job: "feeds:refresh" → handleFeedsRefreshJob (async-handlers.ts)
 *   { domains: ["weather"] }  every 5 min   — OPENWEATHER_API_KEY
 *   { domains: ["crypto"]  }  every 1 min   — no key required (CoinGecko free)
 *   { domains: ["news"]    }  every 10 min  — NEWS_API_KEY
 */

import { randomUUID } from "crypto";

import {
  createDefaultRegistry,
  DeltaEngine,
  SweepOrchestrator,
  TelegramAlerter,
} from "@nexus/domain-feeds";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Intelligence sweep singletons (process-scoped) ────────────────────────────

const _intelRegistry = createDefaultRegistry();
const _sweepOrchestrator = new SweepOrchestrator(_intelRegistry, 20);
const _deltaEngine = new DeltaEngine();

let _telegramAlerter: TelegramAlerter | null = null;
if (process.env["TELEGRAM_BOT_TOKEN"] && process.env["TELEGRAM_CHAT_ID"]) {
  _telegramAlerter = new TelegramAlerter({
    botToken: process.env["TELEGRAM_BOT_TOKEN"],
    chatId: process.env["TELEGRAM_CHAT_ID"],
    commandHandler: async (cmd) => {
      if (cmd === "/status") {
        const last = _sweepOrchestrator.lastSweep();
        if (!last) return "No sweep data yet. Run /sweep first.";
        return `✅ ${last.meta.sourcesOk} up / ❌ ${last.meta.sourcesDown} down — ${last.meta.totalEvents} events — ${last.timestamp}`;
      }
      if (cmd === "/sweep") {
        const result = await _sweepOrchestrator.sweep();
        return `Sweep complete: ${result.meta.totalEvents} events from ${result.meta.sourcesOk} sources in ${result.meta.sweepMs}ms`;
      }
      if (cmd === "/brief") {
        const last = _sweepOrchestrator.lastSweep();
        if (!last) return "No sweep data yet.";
        const lines = last.domains.map((d) => `• ${d.domain}: ${d.totalCount} events`);
        return `Intelligence brief — ${last.timestamp}\n${lines.join("\n")}`;
      }
      return null;
    },
  });
}

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

type FeedDomain = (typeof SUPPORTED_DOMAINS)[number];

const feedStore = new Map<FeedDomain, FeedEntry[]>(SUPPORTED_DOMAINS.map((d) => [d, []]));

function getEntries(domain: FeedDomain): FeedEntry[] {
  return feedStore.get(domain) ?? [];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function domainFeedsRoutes(app: FastifyInstance): Promise<void> {
  // Polling removed — driven by BullMQ repeatable jobs (bootstrapRepeatableJobs
  // in apps/worker/src/index.ts).  POST /domain-feeds/:domain can still be used
  // to push entries manually from the worker or external webhooks.

  /** GET /domain-feeds — list domains + entry counts */
  app.get(
    "/domain-feeds",
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
      const domains = SUPPORTED_DOMAINS.map((d) => ({
        domain: d,
        count: getEntries(d).length,
        latest: getEntries(d).at(-1)?.createdAt ?? null,
      }));
      return reply.send({ domains });
    },
  );

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

  // ── Intelligence feed routes (live API adapters) ──────────────────────────

  /** POST /domain-feeds/intel/sweep — run a full parallel sweep of all real adapters */
  app.post("/domain-feeds/intel/sweep", { preHandler: requireAuth }, async (_req, reply) => {
    const result = await _sweepOrchestrator.sweep();

    // Compute delta and push Telegram alerts if configured
    const history = _sweepOrchestrator.sweepHistory();
    if (history.length >= 2 && _telegramAlerter) {
      const delta = _deltaEngine.compute(history[0]!, history[1]!);
      if (delta.summary.totalChanges > 0) {
        _telegramAlerter.sendDelta(delta).catch(() => {});
      }
    }

    return reply.send({
      timestamp: result.timestamp,
      sourcesOk: result.meta.sourcesOk,
      sourcesDown: result.meta.sourcesDown,
      totalEvents: result.meta.totalEvents,
      sweepMs: result.meta.sweepMs,
      health: result.health,
    });
  });

  /** GET /domain-feeds/intel/status — last sweep health summary */
  app.get("/domain-feeds/intel/status", { preHandler: requireAuth }, async (_req, reply) => {
    const last = _sweepOrchestrator.lastSweep();
    if (!last)
      return reply
        .code(404)
        .send({ error: "No sweep has run yet. POST /domain-feeds/intel/sweep first." });
    return reply.send({
      timestamp: last.timestamp,
      sourcesOk: last.meta.sourcesOk,
      sourcesDown: last.meta.sourcesDown,
      totalEvents: last.meta.totalEvents,
      sweepMs: last.meta.sweepMs,
      health: last.health,
    });
  });

  /** GET /domain-feeds/intel/:domain — events from last sweep for a specific domain */
  app.get<{ Params: { domain: string }; Querystring: { limit?: string } }>(
    "/domain-feeds/intel/:domain",
    { preHandler: requireAuth },
    async (request, reply) => {
      const last = _sweepOrchestrator.lastSweep();
      if (!last) return reply.code(404).send({ error: "No sweep data yet." });

      const page = last.domains.find((d) => d.domain === request.params.domain);
      if (!page) {
        return reply.code(404).send({
          error: `Domain "${request.params.domain}" not in last sweep. Available: ${last.domains.map((d) => d.domain).join(", ")}`,
        });
      }

      const limit = Math.min(parseInt(request.query.limit ?? "50"), 200);
      return reply.send({ ...page, events: page.events.slice(0, limit) });
    },
  );

  /** GET /domain-feeds/intel/brief — compact text summary of last sweep */
  app.get("/domain-feeds/intel/brief", { preHandler: requireAuth }, async (_req, reply) => {
    const last = _sweepOrchestrator.lastSweep();
    if (!last) return reply.code(404).send({ error: "No sweep data yet." });

    const history = _sweepOrchestrator.sweepHistory();
    const delta = history.length >= 2 ? _deltaEngine.compute(history[0]!, history[1]!) : null;

    const domainSummary = last.domains.map((d) => ({
      domain: d.domain,
      count: d.totalCount,
      topEvent: d.events[0]?.summary ?? null,
      topSeverity: d.events[0]?.severity ?? null,
    }));

    return reply.send({
      timestamp: last.timestamp,
      meta: last.meta,
      domains: domainSummary,
      delta: delta
        ? {
            direction: delta.summary.direction,
            totalChanges: delta.summary.totalChanges,
            criticalChanges: delta.summary.criticalChanges,
            topSignals: [
              ...delta.signals.new.slice(0, 3),
              ...delta.signals.escalated.filter((s) => s.severity === "critical").slice(0, 3),
            ],
          }
        : null,
    });
  });

  /** DELETE /domain-feeds/:domain/entries/:id */
  app.delete<{ Params: { domain: string; id: string } }>(
    "/domain-feeds/:domain/entries/:id",
    {
      schema: {
        response: { 200: { type: "object", additionalProperties: true }, 204: { type: "null" } },
      },
      preHandler: requireAuth,
    },
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
