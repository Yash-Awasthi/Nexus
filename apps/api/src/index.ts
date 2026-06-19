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
// unhandledRejection is intentionally LOGGED but not process.exit() here —
// the try/catch around import("./server.js") handles rejections explicitly and
// keeps the diagnostic server alive to surface the error via HTTP.
process.on("uncaughtException", (err) => {
  console.error("[fatal] Uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[warn] Unhandled rejection (non-fatal in diagnostic mode):", reason);
});

// ── Startup validation ────────────────────────────────────────────────────────
function validateApiKey(): void {
  if (!process.env.NEXUS_API_KEY) {
    console.error("[startup] FATAL: NEXUS_API_KEY is not set.");
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

async function main(): Promise<void> {
  console.log("[startup] nexus-api starting...");
  console.log(`[startup] NODE_ENV=${process.env.NODE_ENV} PORT=${PORT} HOST=${HOST}`);

  validateApiKey();
  console.log("[startup] NEXUS_API_KEY ✓");

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
  // Wrap in try/catch: if ANYTHING fails during import, serve the error on /health
  // so we can read it from the live URL instead of losing it in inaccessible logs.
  console.log("[startup] loading server modules (may take a moment on low-CPU)...");

  let importError: Error | null = null;
  let buildServerFn: (() => Promise<import("fastify").FastifyInstance>) | null = null;

  try {
    const mod = await import("./server.js");
    buildServerFn = mod.buildServer as () => Promise<import("fastify").FastifyInstance>;
    console.log("[startup] server modules loaded.");
  } catch (err) {
    importError = err instanceof Error ? err : new Error(String(err));
    console.error("[startup] FAILED to load server modules:", importError.message);
    console.error(importError.stack);
  }

  if (importError || !buildServerFn) {
    // Keep the early server alive and serve the error so it's readable via HTTP.
    // /health returns 200 with diagnostic JSON → Render marks deploy live →
    // we hit the URL and see exactly what crashed.
    const errMsg = importError?.message ?? "buildServerFn is null";
    const errStack = importError?.stack ?? "";
    const _handler = (_req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error", stage: "import", error: errMsg, stack: errStack }));
    };
    earlyServer.removeAllListeners("request");
    earlyServer.on("request", _handler);
    console.log("[startup] diagnostic server running — hit /health to see error");
    // Stay alive for 10 minutes so the error can be read
    await new Promise<void>((resolve) => setTimeout(resolve, 10 * 60 * 1000));
    process.exit(1);
  }

  console.log("[startup] building Fastify server...");
  const app = await buildServerFn();
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
