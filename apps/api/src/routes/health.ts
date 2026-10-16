// SPDX-License-Identifier: Apache-2.0
import { db } from "@nexus/db";
import { HealthAggregator, postgresProbe } from "@nexus/telemetry";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { costLogStore } from "../lib/cost-log.ts";
import { getLlmCacheStats } from "../lib/llm-cache-driver.ts";
import { getProviderSnapshot, getProviderStats } from "../lib/llm-failover.ts";
import { getSharedKV } from "../lib/shared-kv.ts";

// ── Readiness probes ────────────────────────────────────────────────────────────
// Built once and reused. DB is critical (failure → "down" → 503); the shared KV /
// Redis layer is non-critical (failure → "degraded" → still 200 so the pod keeps
// serving cached/in-memory paths).

let _aggregator: HealthAggregator | null = null;

function getAggregator(): HealthAggregator {
  if (_aggregator) return _aggregator;
  const agg = new HealthAggregator();

  agg.register("db", postgresProbe({ execute: (q) => db.execute(sql.raw(q)) }), {
    critical: true,
    timeoutMs: 3000,
  });

  agg.register(
    "kv",
    async () => {
      const kv = getSharedKV();
      const probeKey = "health:probe";
      await kv.set(probeKey, Date.now(), 5000);
      const v = await kv.get<number>(probeKey);
      return v === undefined
        ? { ok: false, message: "kv round-trip returned nothing" }
        : { ok: true };
    },
    { critical: false, timeoutMs: 2000 },
  );

  // Cost-log write-behind persistence health (non-critical). The store keeps
  // recording in memory even when KV flushes fail, so a silently failing flush
  // degrades the system back to in-memory — this probe flips "degraded" once
  // failures become consecutive, and the raw stats ride on every /health/ready
  // response so an operator always sees the flush age / pending tail.
  agg.register(
    "costlog_flush",
    async () => {
      const s = costLogStore.flushStats();
      return s.consecutiveFailures >= 3
        ? {
            ok: false,
            message: `${s.consecutiveFailures} consecutive KV flush failures — usage history may be lost on restart (${s.pendingEntries} entries pending)`,
          }
        : { ok: true };
    },
    { critical: false, timeoutMs: 1000 },
  );

  _aggregator = agg;
  return agg;
}

/** A healthy answer stands this long; the platform probes every few seconds. */
const READY_REUSE_MS = 30 * 60_000;
/** An unhealthy one is checked again soon. */
const UNREADY_REUSE_MS = 15_000;

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Probing Postgres and Redis on every probe would keep a free database awake
  // around the clock and spend a free Redis plan's monthly commands.
  let last: { at: number; code: number; body: Record<string, unknown> } | null = null;

  app.get("/health", async (_req, reply) => {
    // Health liveness: must always reflect current state — no caching.
    reply.header("Cache-Control", "no-cache");
    return reply.code(200).send({
      status: "ok",
      version: process.env.npm_package_version ?? "0.1.0",
      ...(process.env.RENDER_GIT_COMMIT
        ? { commit: process.env.RENDER_GIT_COMMIT.slice(0, 7) }
        : {}),
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/health/ready", async (_req, reply) => {
    // No proxy may cache it; reuse is decided below, per process.
    reply.header("Cache-Control", "no-cache, no-store");

    const reuse = last?.body.status === "ready" ? READY_REUSE_MS : UNREADY_REUSE_MS;
    if (last && Date.now() - last.at < reuse)
      return reply.code(last.code).send({ ...last.body, costLog: costLogStore.flushStats() });

    const health = await getAggregator().check();
    // "ready" / "degraded" still serve traffic (200); only "down" (a critical
    // dependency failed) takes the pod out of rotation (503).
    const httpStatus = health.status === "down" ? 503 : 200;

    const body = {
      status: health.status,
      checks: health.checks,
      messages: health.messages,
      latencies: health.latencies,
      durationMs: health.durationMs,
      // Cost-log write-behind durability, always visible (raw store stats).
      costLog: costLogStore.flushStats(),
      // LLM response cache health (hits/misses/skips/size).
      llmCache: await getLlmCacheStats(),
      // Live provider discovery + failover stats (sourced from the registry).
      llmProviders: {
        providers: getProviderSnapshot(),
        stats: getProviderStats(),
      },
    };
    last = { at: Date.now(), code: httpStatus, body };
    return reply.code(httpStatus).send(body);
  });
}
