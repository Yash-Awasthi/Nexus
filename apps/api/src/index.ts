// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/api — entrypoint
 */

import { buildServer } from "./server.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

// ── Global error traps ────────────────────────────────────────────────────────
// Log every unhandled error loudly so it appears in Render's runtime logs.
process.on("uncaughtException", (err) => {
  console.error("[fatal] Uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] Unhandled rejection:", reason);
  process.exit(1);
});

// ── Startup validation ────────────────────────────────────────────────────────
function validateApiKey(): void {
  if (!process.env.NEXUS_API_KEY) {
    console.error("[startup] FATAL: NEXUS_API_KEY is not set.");
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
      console.warn(`[startup] ⚠ DB ping failed: ${(err as Error).message}`);
    }
  }

  // ── Redis ping — skip to avoid ioredis error events crashing Alpine ──────
  // ioredis emits error events asynchronously after quit() on TLS connections.
  // On Alpine musl these can escape the try/catch and kill the process.
  // Redis is non-critical (falls back to in-memory KVStore) so skip the ping.
  if (process.env.REDIS_URL) {
    console.info("[startup] Redis URL set — using in-memory KV fallback until first request");
  }
}

async function main(): Promise<void> {
  console.log("[startup] nexus-api starting...");
  console.log(`[startup] NODE_ENV=${process.env.NODE_ENV} PORT=${PORT} HOST=${HOST}`);

  validateApiKey();
  console.log("[startup] NEXUS_API_KEY ✓");

  console.log("[startup] building server...");
  const app = await buildServer();
  console.log("[startup] server built, starting listener...");

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`@nexus/api listening on ${HOST}:${PORT}`);
  } catch (err) {
    console.error("[startup] FATAL: app.listen() failed:", err);
    process.exit(1);
  }

  // Non-blocking connection probes (after health check is reachable)
  pingConnections().catch((err) =>
    console.warn("[startup] connection probe error:", err),
  );
}

// Handle graceful shutdown
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

main().catch((err) => {
  console.error("[fatal] main() threw:", err);
  process.exit(1);
});
