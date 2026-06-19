// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/api — entrypoint
 */

import { buildServer } from "./server.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

// ── Startup validation ────────────────────────────────────────────────────────
// Hard-fails only on missing auth key. DB / Redis pings run in the background
// AFTER the server is already listening so Render's health check passes fast.

function validateApiKey(): void {
  if (!process.env.NEXUS_API_KEY) {
    console.error(
      "[startup] FATAL: NEXUS_API_KEY is not set — " +
        "all authenticated routes will reject. Set this env var and restart.",
    );
    process.exit(1);
  }
}

async function pingConnections(): Promise<void> {
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
      const ioredis = await import("ioredis");
      const Redis = ioredis.default ?? ioredis;
      const redis = new (Redis as unknown as new (
        url: string,
        opts: Record<string, unknown>,
      ) => {
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
  // Fail fast on missing required env var (synchronous, no I/O)
  validateApiKey();

  const app = await buildServer();

  try {
    // Start listening FIRST so Render's health check passes immediately.
    // DB / Redis pings run in the background — failures are warnings only.
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`@nexus/api listening on ${HOST}:${PORT}`);
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }

  // Non-blocking connection probes — logged but never crash the server
  pingConnections().catch((err) =>
    console.warn("[startup] connection probe error:", err),
  );
}

// Handle graceful shutdown
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

main();
