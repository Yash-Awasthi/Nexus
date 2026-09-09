// SPDX-License-Identifier: Apache-2.0
/**
 * System diagnostics route — `/api/v1/system/diagnostics`
 *
 * A single consolidated operability endpoint that reports the health of every
 * backend dependency, the LLM provider landscape, the route surface, and
 * runtime metadata. Designed for operators and the dashboard's status page.
 *
 *   GET /api/v1/system/diagnostics
 *
 * Response shape:
 *   {
 *     "status": "ok" | "degraded" | "down",
 *     "uptime": { "seconds": 12345, "startedAt": "..." },
 *     "runtime": { "node": "v24.x", "platform": "linux", "arch": "x64", "rssMb": 42 },
 *     "checks": {
 *       "database": { "ok": true, "latencyMs": 3 },
 *       "redis":    { "ok": false, "message": "ENOTFOUND" },
 *       "kv":       { "ok": true, "latencyMs": 1 }
 *     },
 *     "llmProviders": [
 *       { "provider": "anthropic", "configured": true },
 *       { "provider": "groq",       "configured": true },
 *       ...
 *     ],
 *     "routes": { "totalFiles": 68, "registeredPrefixes": [...] },
 *     "env": { "nodeEnv": "development", "logLevel": "info" },
 *     "timestamp": "..."
 *   }
 *
 * Auth: requires a valid bearer token (same as all /api/v1 routes).
 */

import { db } from "@nexus/db";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { getSharedKV } from "../lib/shared-kv.js";

// Capture process start time once at module load.
const STARTED_AT = new Date();

/** Known LLM provider env-var names — `configured` is true when set + non-empty. */
const LLM_PROVIDER_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  groq: "GROQ_API_KEY",
  gemini: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  cohere: "COHERE_API_KEY",
  together: "TOGETHER_API_KEY",
  xai: "XAI_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
};

/** Route prefixes registered in server.ts — keeps the diagnostics self-contained. */
const REGISTERED_PREFIXES = ["/api/v1", "/api", "/health", "/api/v1/gs"];

interface CheckResult {
  ok: boolean;
  latencyMs?: number;
  message?: string;
}

async function checkDatabase(): Promise<CheckResult> {
  const start = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, message: (e as Error).message };
  }
}

async function checkRedis(): Promise<CheckResult> {
  const start = Date.now();
  const url = process.env.REDIS_URL;
  if (!url) return { ok: false, message: "REDIS_URL not set" };
  try {
    const ioredis = await import("ioredis");
    type DiagRedis = {
      ping(): Promise<string>;
      quit(): Promise<unknown>;
      disconnect(): void;
      connect(): Promise<unknown>;
      on(event: "error", cb: (err: unknown) => void): void;
    };
    const Redis = (ioredis.default ?? ioredis) as unknown as new (
      url: string,
      opts: Record<string, unknown>,
    ) => DiagRedis;
    const client = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 2_000,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy: () => null,
    });
    client.on("error", () => {});
    try {
      await client.connect();
      await client.ping();
      return { ok: true, latencyMs: Date.now() - start };
    } finally {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    }
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, message: (e as Error).message };
  }
}

async function checkKV(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const kv = getSharedKV();
    const probeKey = "diagnostics:probe";
    await kv.set(probeKey, Date.now(), 5000);
    const v = await kv.get<number>(probeKey);
    return v === undefined
      ? { ok: false, message: "kv round-trip returned nothing" }
      : { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, message: (e as Error).message };
  }
}

function llmProviders(): { provider: string; configured: boolean }[] {
  return Object.entries(LLM_PROVIDER_ENV).map(([provider, envVar]) => ({
    provider,
    configured: Boolean(process.env[envVar] && process.env[envVar]!.trim()),
  }));
}

export async function diagnosticsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/system/diagnostics", async (_req, reply) => {
    reply.header("Cache-Control", "no-cache, no-store");

    const [database, redis, kv] = await Promise.all([checkDatabase(), checkRedis(), checkKV()]);

    const checks = { database, redis, kv };
    // Status: "down" only if DB is down (critical). Redis/KV degraded is non-fatal.
    const status = !database.ok ? "down" : !redis.ok || !kv.ok ? "degraded" : "ok";

    const uptimeSeconds = Math.round((Date.now() - STARTED_AT.getTime()) / 1000);
    const providers = llmProviders();
    const configuredProviders = providers.filter((p) => p.configured).length;

    const mem = process.memoryUsage();

    return reply.code(status === "down" ? 503 : 200).send({
      status,
      uptime: {
        seconds: uptimeSeconds,
        startedAt: STARTED_AT.toISOString(),
      },
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      },
      checks,
      llmProviders: providers,
      llmSummary: {
        configured: configuredProviders,
        total: providers.length,
      },
      routes: {
        registeredPrefixes: REGISTERED_PREFIXES,
      },
      env: {
        nodeEnv: process.env.NODE_ENV ?? "development",
        logLevel: process.env.LOG_LEVEL ?? "info",
        port: process.env.PORT ?? "3000",
        host: process.env.HOST ?? "0.0.0.0",
      },
      timestamp: new Date().toISOString(),
    });
  });
}
