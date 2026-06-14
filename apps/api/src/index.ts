// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/api — entrypoint
 */

import { buildServer } from "./server.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

// ── Startup validation ────────────────────────────────────────────────────────
// Run before the Fastify instance starts. Hard-fails on missing auth key so the
// process crashes loudly instead of silently rejecting every authenticated request.
// DB / Redis failures are warnings — routes degrade to in-memory fallbacks.

async function validateStartup(): Promise<void> {
  // ── Required env vars ────────────────────────────────────────────────────
  if (!process.env.NEXUS_API_KEY) {
    console.error(
      "[startup] FATAL: NEXUS_API_KEY is not set — " +
        "all authenticated routes will reject. Set this env var and restart.",
    );
    process.exit(1);
  }

  // ── Database ping ────────────────────────────────────────────────────────
  if (process.env.DATABASE_URL) {
    try {
      const { Pool } = await import("pg");
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 5_000,
        max: 1,
      });
      await pool.query("SELECT 1");
      await pool.end();
      console.info("[startup] ✓ Database reachable");
    } catch (err) {
      console.warn(
        `[startup] ⚠ DATABASE_URL set but DB unreachable: ${(err as Error).message} ` +
          "— routes will fall back to in-memory stores",
      );
    }
  } else {
    console.warn(
      "[startup] ⚠ DATABASE_URL not set — all persistence is in-memory only; " +
        "data will not survive restart",
    );
  }

  // ── Redis ping ───────────────────────────────────────────────────────────
  if (process.env.REDIS_URL) {
    try {
      // Dynamic import keeps ioredis out of the module graph when not needed
      const ioredis = await import("ioredis");
      const Redis = ioredis.default ?? ioredis;
      const redis = new (Redis as unknown as new (url: string, opts: Record<string, unknown>) => {
        connect(): Promise<void>;
        ping(): Promise<void>;
        quit(): Promise<void>;
      })(process.env.REDIS_URL, {
        lazyConnect: true,
        connectTimeout: 5_000,
        maxRetriesPerRequest: 0,
        enableReadyCheck: false,
      });
      await redis.connect();
      await redis.ping();
      await redis.quit();
      console.info("[startup] ✓ Redis reachable");
    } catch (err) {
      console.warn(
        `[startup] ⚠ REDIS_URL set but Redis unreachable: ${(err as Error).message} ` +
          "— task queue will use in-memory fallback",
      );
    }
  } else {
    console.warn("[startup] ⚠ REDIS_URL not set — async task queue is unavailable");
  }
}

async function main(): Promise<void> {
  await validateStartup();

  const app = await buildServer();

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`@nexus/api listening on ${HOST}:${PORT}`);
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

main();
