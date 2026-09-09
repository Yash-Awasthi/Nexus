// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/worker — entrypoint
 *
 * Starts:
 *  1. Three BullMQ workers (nexus-high / medium / low)
 *  2. SignalWorker         — DB polling fallback for unprocessed events
 *  3. SignalNotifyListener — Postgres LISTEN/NOTIFY hot path (Phase 2)
 *                            Enqueues council.deliberate jobs for qualifying
 *                            signals immediately on INSERT, gated by
 *                            COUNCIL_MIN_PRIORITY (default: high).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Queue, type ConnectionOptions } from "bullmq";

import type * as OrchestrationStoreModuleNs from "./handlers/orchestration-store.js";

// ── .env loader (zero-dependency — mirrors apps/api/src/index.ts) ──────────
// Parses KEY=VALUE from the monorepo-root .env so `pnpm --filter @nexus/worker
// dev` works without manually exporting variables. Already-set env vars win.
(function loadEnvFile() {
  let text: string;
  try {
    text = readFileSync(resolve(process.cwd(), "../../.env"), "utf8");
  } catch {
    try {
      text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    } catch {
      return; // no .env — rely on real env vars
    }
  }
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!;
    if (!/^["']/.test(val)) {
      val = val.replace(/\s+#.*$/, "");
    } else {
      val = val.slice(1, val.length - 1);
    }
    if (process.env[key] === undefined) process.env[key] = val.trim();
  }
})();

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// Parse redis URL into BullMQ ConnectionOptions
function parseRedisUrl(url: string): {
  host: string;
  port: number;
  password?: string;
  db?: number;
} {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: parseInt(u.port || "6379", 10),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.pathname && u.pathname !== "/" ? { db: parseInt(u.pathname.slice(1), 10) } : {}),
  };
}

/**
 * Register BullMQ repeatable jobs so polling survives worker restarts and
 * runs on exactly one pod at a time (BullMQ's repeat lock ensures this).
 *
 * jobId is a stable key — BullMQ upserts by jobId so re-running bootstrap
 * after a restart is idempotent (no duplicate repeatable jobs accumulate).
 *
 * Intervals:
 *   weather      — every 5 min  (OPENWEATHER_API_KEY required, else noop in handler)
 *   crypto       — every 1 min  (CoinGecko free tier, no key required)
 *   news         — every 10 min (NEWS_API_KEY required, else noop in handler)
 *   feeds:rss    — every 15 min (RSS_FEED_URLS required, else noop in handler)
 *   port-congestion — every 6 h (keyless IMF PortWatch; Telegram alert on critical)
 */
async function bootstrapRepeatableJobs(connection: ConnectionOptions): Promise<void> {
  if (!process.env.REDIS_URL) return;
  const medium = new Queue("nexus-medium", { connection });
  try {
    await medium.add(
      "feeds:refresh",
      { domains: ["weather"] },
      { repeat: { every: 300_000 }, jobId: "nexus:repeat:feeds:weather" },
    );
    await medium.add(
      "feeds:refresh",
      { domains: ["crypto"] },
      { repeat: { every: 60_000 }, jobId: "nexus:repeat:feeds:crypto" },
    );
    await medium.add(
      "feeds:refresh",
      { domains: ["news"] },
      { repeat: { every: 600_000 }, jobId: "nexus:repeat:feeds:news" },
    );
    await medium.add(
      "feeds:refresh:rss",
      {},
      { repeat: { every: 900_000 }, jobId: "nexus:repeat:feeds:rss" },
    );
    // §16.1 — port-congestion: the IMF PortWatch service refreshes weekly, so
    // a 6-hour poll is ample; alerts fire on critical chokepoint closures.
    await medium.add(
      "feeds:refresh:port-congestion",
      { alertOn: ["critical"] },
      { repeat: { every: 21_600_000 }, jobId: "nexus:repeat:feeds:port-congestion" },
    );
    console.log(
      JSON.stringify({ level: "info", event: "worker.repeatable-jobs-bootstrapped", jobs: 5 }),
    );
  } catch (err) {
    // Non-fatal: if Redis is unreachable at startup, the worker will still
    // serve existing jobs; repeatable jobs will be registered on next boot.
    console.warn(
      JSON.stringify({ level: "warn", event: "worker.repeatable-jobs-failed", error: String(err) }),
    );
  } finally {
    await medium.close();
  }
}

/**
 * Recover in-flight orchestration runs after a restart (§6.1): reload every
 * non-terminal `orchestration_runs` row and re-enqueue its job from the stored
 * payload. Non-fatal — a DB/Redis hiccup here must not block worker startup.
 */
type OrchestrationStoreModule = typeof OrchestrationStoreModuleNs;

async function recoverOrchestrationRuns(
  connection: ConnectionOptions,
  deps: Pick<
    OrchestrationStoreModule,
    "reenqueueOrchestrationRuns" | "DrizzleOrchestrationRunStore"
  >,
): Promise<void> {
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) return;
  const high = new Queue("nexus-high", { connection });
  try {
    const requeued = await deps.reenqueueOrchestrationRuns(
      new deps.DrizzleOrchestrationRunStore(),
      async (jobName, payload) => {
        await high.add(jobName, payload);
      },
    );
    if (requeued.length > 0) {
      console.log(
        JSON.stringify({
          level: "info",
          event: "worker.orchestration-runs-recovered",
          count: requeued.length,
        }),
      );
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "worker.orchestration-recovery-failed",
        error: String(err),
      }),
    );
  } finally {
    await high.close();
  }
}

async function main(): Promise<void> {
  console.log(JSON.stringify({ level: "info", event: "worker.starting", redis: REDIS_URL }));

  // Heavy modules are imported dynamically (after the .env loader above) so
  // @nexus/db sees DATABASE_URL at module-eval time — mirrors apps/api entry.
  const [
    { DrizzleOrchestrationRunStore, reenqueueOrchestrationRuns },
    { SignalNotifyListener },
    { SignalWorker },
    { createTaskWorkers },
  ] = await Promise.all([
    import("./handlers/orchestration-store.js"),
    import("./workers/signal-notify-listener.js"),
    import("./workers/signal-worker.js"),
    import("./workers/task-worker.js"),
  ]);

  const connection = parseRedisUrl(REDIS_URL);

  // Bootstrap repeatable feed-poll jobs (idempotent — safe to call on every boot)
  await bootstrapRepeatableJobs(connection);

  // Recover orchestration runs interrupted by a previous restart (§6.1)
  await recoverOrchestrationRuns(connection, {
    reenqueueOrchestrationRuns,
    DrizzleOrchestrationRunStore,
  });

  // Start BullMQ queue workers
  const workers = createTaskWorkers(connection);
  console.log(
    JSON.stringify({ level: "info", event: "worker.queues-started", count: workers.length }),
  );

  // Start DB-polling signal worker (fallback / catch-up path)
  const signalWorker = new SignalWorker();
  signalWorker.start();

  // Start Postgres LISTEN/NOTIFY listener (hot path — Phase 2)
  const notifyListener = new SignalNotifyListener(connection);
  if (process.env.DATABASE_URL) {
    await notifyListener.start();
  } else {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "signal-notify-listener.skipped",
        reason: "DATABASE_URL not set",
      }),
    );
  }

  // Graceful shutdown
  async function shutdown(signal: string): Promise<void> {
    console.log(JSON.stringify({ level: "info", event: "worker.shutdown", signal }));
    signalWorker.stop();
    await notifyListener.stop();
    await Promise.all(workers.map((w) => w.close()));
    console.log(JSON.stringify({ level: "info", event: "worker.stopped" }));
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  console.log(JSON.stringify({ level: "info", event: "worker.ready" }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
