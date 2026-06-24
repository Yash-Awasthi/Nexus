// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/api — entrypoint
 *
 * Startup order (optimised for Render free-tier 0.1 vCPU):
 *  1. Raw Node http server binds immediately on PORT → health checks pass at once.
 *  2. server.ts (+ 50+ route files) is loaded via dynamic import — slow on low CPU.
 *  3. Early server closes; Fastify takes the port.
 *
 * This keeps Render's 30-second health-check window from expiring before the
 * full server is ready.
 */

import { createServer } from "node:http";

const PORT = parseInt(process.env.PORT ?? "10000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

// ── Global error traps ────────────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error("[fatal] Uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] Unhandled rejection:", reason);
  process.exit(1);
});

// ── Startup validation ────────────────────────────────────────────────────────

/** Known dev/sample placeholder values that must never reach production. */
const INSECURE_DEFAULTS = new Set([
  "dev",
  "change-me",
  "changeme",
  "your-nexus-api-key",
  "your-api-key",
  "secret",
  "test",
  "nexus-dev-key",
]);

/**
 * Validate required secrets at startup. NEXUS_API_KEY is always required. In
 * production we additionally reject insecure placeholder / too-short keys and
 * warn when recommended secrets (JWT_SECRET, AUDIT_LOG_KEY) are missing, so a
 * misconfigured deploy fails fast instead of silently running insecurely.
 */
function validateSecrets(): void {
  const apiKey = process.env.NEXUS_API_KEY;
  if (!apiKey) {
    console.error("[startup] FATAL: NEXUS_API_KEY is not set.");
    process.exit(1);
  }

  const isProd = process.env.NODE_ENV === "production";
  if (isProd) {
    if (INSECURE_DEFAULTS.has(apiKey.toLowerCase()) || apiKey.length < 16) {
      console.error(
        "[startup] FATAL: NEXUS_API_KEY is a placeholder or too short (<16 chars) for production.",
      );
      process.exit(1);
    }
    for (const name of ["JWT_SECRET", "AUDIT_LOG_KEY"]) {
      const val = process.env[name];
      if (!val) {
        console.warn(`[startup] ⚠ ${name} is not set — strongly recommended in production.`);
      } else if (INSECURE_DEFAULTS.has(val.toLowerCase()) || val.length < 16) {
        console.error(`[startup] FATAL: ${name} is a placeholder or too short for production.`);
        process.exit(1);
      }
    }
  }
}

// Handle graceful shutdown
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

async function main(): Promise<void> {
  console.log("[startup] nexus-api starting...");
  console.log(`[startup] NODE_ENV=${process.env.NODE_ENV} PORT=${PORT} HOST=${HOST}`);

  validateSecrets();
  console.log("[startup] secrets validated ✓");

  // ── Step 1: Early health server ─────────────────────────────────────────────
  // Bind the port immediately so Render's health check gets 200 right away,
  // before the heavy Fastify + route module graph finishes loading.
  console.log("[startup] binding early health server...");
  const earlyServer = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        version: process.env.npm_package_version ?? "0.1.0",
        timestamp: new Date().toISOString(),
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    earlyServer.listen(PORT, HOST, () => {
      console.log(`[startup] early health server up on ${HOST}:${PORT}`);
      resolve();
    });
    earlyServer.on("error", (err) => {
      console.error("[startup] early server error:", err);
      reject(err);
    });
  });

  // ── Step 2: Load full Fastify server (slow on low-CPU) ──────────────────────
  console.log("[startup] loading server modules (may take a moment on low-CPU)...");
  const { buildServer } = await import("./server.js");

  console.log("[startup] building Fastify server...");
  const app = await buildServer();
  console.log("[startup] Fastify server built.");

  // ── Step 3: Hand off port from early server to Fastify ──────────────────────
  console.log("[startup] closing early server, handing off port to Fastify...");
  await new Promise<void>((resolve) => earlyServer.close(() => resolve()));

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`@nexus/api listening on ${HOST}:${PORT}`);
  } catch (err) {
    console.error("[startup] FATAL: app.listen() failed:", err);
    process.exit(1);
  }

  // ── Step 4: Non-blocking connection probes ───────────────────────────────────
  if (process.env.DATABASE_URL) {
    import("pg")
      .then(({ Pool }) => {
        const pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          connectionTimeoutMillis: 5_000,
          max: 1,
        });
        return pool.query("SELECT 1").then(() => pool.end());
      })
      .then(() => console.info("[startup] ✓ Database reachable"))
      .catch((err: unknown) =>
        console.warn(`[startup] ⚠ DB ping failed: ${(err as Error).message}`),
      );
  }

  if (process.env.REDIS_URL) {
    console.info("[startup] Redis URL set — using in-memory KV fallback until first request");
  }
}

main().catch((err) => {
  console.error("[fatal] main() threw:", err);
  process.exit(1);
});
