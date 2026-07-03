// SPDX-License-Identifier: Apache-2.0
import { db } from "@nexus/db";
import { HealthAggregator } from "@nexus/telemetry";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { getSharedKV } from "../lib/shared-kv.js";

// ── Readiness probes ────────────────────────────────────────────────────────────
// Built once and reused. DB is critical (failure → "down" → 503); the shared KV /
// Redis layer is non-critical (failure → "degraded" → still 200 so the pod keeps
// serving cached/in-memory paths).

let _aggregator: HealthAggregator | null = null;

function getAggregator(): HealthAggregator {
  if (_aggregator) return _aggregator;
  const agg = new HealthAggregator();

  agg.register(
    "db",
    async () => {
      await db.execute(sql`SELECT 1`);
      return { ok: true };
    },
    { critical: true, timeoutMs: 3000 },
  );

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

  _aggregator = agg;
  return agg;
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async (_req, reply) => {
    // Health liveness: must always reflect current state — no caching.
    reply.header("Cache-Control", "no-cache");
    return reply.code(200).send({
      status: "ok",
      version: process.env.npm_package_version ?? "0.1.0",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/health/ready", async (_req, reply) => {
    // Readiness check must not be cached — K8s kubelet polls this.
    reply.header("Cache-Control", "no-cache, no-store");

    const health = await getAggregator().check();
    // "ready" / "degraded" still serve traffic (200); only "down" (a critical
    // dependency failed) takes the pod out of rotation (503).
    const httpStatus = health.status === "down" ? 503 : 200;

    return reply.code(httpStatus).send({
      status: health.status,
      checks: health.checks,
      messages: health.messages,
      latencies: health.latencies,
      durationMs: health.durationMs,
    });
  });
}
