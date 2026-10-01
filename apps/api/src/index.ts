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

import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { closePgPools, getPgPool, isEmbeddedUrl } from "./lib/pg-pool.js";

// ── .env loader (zero-dependency) ───────────────────────────────────────────
// Parses a standard KEY=VALUE .env file at the monorepo root so `pnpm dev:api`
// works without manually exporting variables. The root is found by walking up
// from THIS MODULE's directory to the directory containing
// pnpm-workspace.yaml — NOT from process.cwd(), which depends on where the
// dev server was launched from (a restart from the wrong cwd silently loses
// REDIS_URL/DATABASE_URL and degrades the shared KV to in-memory). Values may
// be bare or quoted; inline # comments are stripped only from unquoted
// values. Already-set env vars win (we never overwrite). Safe for values
// containing & ? = etc., which break `source .env` under bash.
(function loadEnvFile() {
  // The desktop app hands its API every setting; a checkout's .env would point it at servers.
  if (process.env.NEXUS_DESKTOP === "1") return;
  let text: string | undefined;
  try {
    let dir = dirname(fileURLToPath(import.meta.url)); // .../apps/api/src
    for (let i = 0; i < 6; i++) {
      if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) {
        text = readFileSync(resolve(dir, ".env"), "utf8");
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through to cwd-based candidates */
  }
  if (text === undefined) {
    try {
      text = readFileSync(resolve(process.cwd(), "../../.env"), "utf8");
    } catch {
      try {
        text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
      } catch {
        return; // no .env — rely on real env vars
      }
    }
  }
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!;
    // Strip inline comment from unquoted values
    if (!/^["']/.test(val)) {
      val = val.replace(/\s+#.*$/, "");
    } else {
      // Remove surrounding quotes
      val = val.slice(1, val.length - 1);
    }
    if (process.env[key] === undefined) process.env[key] = val.trim();
  }
})();

// PORT=0 (or empty/garbage) must never reach listen() — port 0 makes the OS
// bind an ephemeral port and the whole stack comes up somewhere unreachable.
const parsedPort = Number.parseInt(process.env.PORT ?? "", 10);
const PORT = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 10000;
const HOST = process.env.HOST ?? "0.0.0.0";

console.log(
  `[startup] env after load: REDIS_URL=${process.env.REDIS_URL ? "set" : "UNSET"} ` +
    `DATABASE_URL=${process.env.DATABASE_URL ? "set" : "UNSET"} ` +
    `UPSTASH=${process.env.UPSTASH_REDIS_REST_URL ? "set" : "UNSET"}`,
);

// ── Global error traps ────────────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error("[fatal] Uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[warn] Unhandled rejection (logged — not fatal):", reason);
  // Log but do NOT crash — one bad request must never take down the entire API.
  // Fastify + async route handlers catch most rejections; any that slip through
  // are logged here and the connection is dropped gracefully.
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
 * warn when recommended secrets (NEXUS_JWT_SECRET, NEXUS_AUDIT_KEY) are missing, so a
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
    for (const name of ["NEXUS_JWT_SECRET", "NEXUS_AUDIT_KEY"]) {
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

// ── Graceful shutdown ───────────────────────────────────────────────────────
// The Fastify `app` instance is created inside main() but signal handlers need
// to reach it. We store it in a module-level ref so the shutdown sequence can
// call app.close() to drain in-flight requests, close DB pools, and unregister
// plugins — instead of hard-killing the process mid-request.
let _app: { close?: () => Promise<void>; log?: { info: (m: string) => void } } | null = null;
let _shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (_shuttingDown) return; // second Ctrl+C → hard exit
  _shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining connections...`);

  if (_app?.close) {
    try {
      await _app.close();
      console.log("[shutdown] Fastify server closed cleanly ✓");
    } catch (err) {
      console.error("[shutdown] Error during app.close():", err);
    }
  }

  // After the server stops accepting work. An embedded (pglite://) database
  // flushes to its data directory on close, so skipping this loses writes the
  // process already acknowledged.
  await closePgPools();

  console.log(`[shutdown] ${signal} handled, exiting.`);
  process.exit(0);
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

async function main(): Promise<void> {
  console.log("[startup] nexus-api starting...");
  console.log(`[startup] NODE_ENV=${process.env.NODE_ENV} PORT=${PORT} HOST=${HOST}`);

  validateSecrets();
  console.log("[startup] secrets validated ✓");

  // ── Step 1: Early health server ─────────────────────────────────────────────
  // Bind the port immediately so Render's health check gets 200 right away,
  // before the heavy Fastify + route module graph finishes loading.
  console.log("[startup] binding early health server...");
  // Liveness only: any other path would hand a client a health body where it expected the app.
  const earlyServer = createServer((req, res) => {
    const live = req.url === "/health";
    res.writeHead(live ? 200 : 503, {
      "Content-Type": "application/json",
      ...(live ? {} : { "Retry-After": "1" }),
    });
    res.end(
      JSON.stringify({
        status: live ? "ok" : "starting",
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

  // ── Step 1.5: Migrate the embedded database ─────────────────────────────────
  // A server database is migrated at deploy time by `drizzle-kit`; the
  // embedded one has no deploy step, so it is brought up to schema here,
  // before any route module opens a store against it. Not fatal: the rest of
  // the API works without the Drizzle-schema tables, only sign-in does not.
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl && isEmbeddedUrl(dbUrl)) {
    try {
      const { migrateEmbedded } = await import("./lib/migrate-embedded.js");
      const { applied, skipped } = await migrateEmbedded(getPgPool(dbUrl)!);
      console.log(
        `[startup] embedded database migrated: ${applied.length} applied` +
          (skipped.length ? `, skipped ${skipped.join(", ")} (extension unavailable)` : ""),
      );
    } catch (err) {
      console.error(
        `[startup] ✗ embedded migration failed — sign-in will not work: ${String(err)}`,
      );
    }
  }

  // ── Step 2: Load full Fastify server (slow on low-CPU) ──────────────────────
  console.log("[startup] loading server modules (may take a moment on low-CPU)...");
  const { buildServer } = await import("./server.js");

  console.log("[startup] building Fastify server...");
  const app = await buildServer();
  console.log("[startup] Fastify server built.");

  // ── Step 2.5: Await the memory embedder warm-up (bounded) ───────────────────
  // The Ollama embed model loads on first call; api-bridge started it during
  // route registration so the load overlaps server startup. Await it here —
  // bounded, fail-open — so the first real recall after a restart can never
  // race a cold model load. Health checks were already served by the early
  // server during this window, so the 30-second deploy window is unaffected.
  try {
    const { embedderWarmup } = await import("./routes/api-bridge.js");
    await Promise.race([
      embedderWarmup(),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
    console.log("[startup] memory embedder warm (or bound elapsed) ✓");
  } catch {
    console.warn("[startup] ⚠ embedder warm-up await failed — continuing (fail-open)");
  }

  // ── Step 2.6: Hydrate the model registry from provider_models (§1.5) ───────
  // DB read only — zero network at startup. The table is written offline by
  // `nexus models seed [--file <path>]`; with no DATABASE_URL or an empty
  // table the registry keeps its curated defaults (fail-open).
  try {
    const { loadProviderModelsIntoRegistry } = await import("./lib/models-seed.js");
    const seeded = await loadProviderModelsIntoRegistry();
    console.log(`[startup] provider_models loaded: ${seeded} model(s) ✓`);
  } catch {
    console.warn("[startup] ⚠ provider_models load failed — continuing (fail-open)");
  }

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

  // Wire the running app into the graceful-shutdown handler.
  _app = app;

  // ── Step 4: Non-blocking connection probes ───────────────────────────────────
  // Probe over the shared pool rather than a throwaway one: an embedded
  // (pglite://) database has no second connection to open, and a server one
  // gains nothing from a private handshake it immediately discards.
  const probePool = getPgPool();
  if (probePool) {
    probePool
      .query("SELECT 1")
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
