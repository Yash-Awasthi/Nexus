// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/worker — entrypoint
 *
 * Starts:
 *  1. Three BullMQ workers (nexus-high / medium / low)
 *  2. SignalWorker — DB polling fallback for unprocessed events
 */

import { createTaskWorkers } from "./workers/task-worker.js";
import { SignalWorker } from "./workers/signal-worker.js";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

// Parse redis URL into BullMQ ConnectionOptions
function parseRedisUrl(url: string): { host: string; port: number; password?: string; db?: number } {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: parseInt(u.port || "6379", 10),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.pathname && u.pathname !== "/" ? { db: parseInt(u.pathname.slice(1), 10) } : {}),
  };
}

async function main(): Promise<void> {
  console.log(JSON.stringify({ level: "info", event: "worker.starting", redis: REDIS_URL }));

  const connection = parseRedisUrl(REDIS_URL);

  // Start BullMQ queue workers
  const workers = createTaskWorkers(connection);
  console.log(JSON.stringify({ level: "info", event: "worker.queues-started", count: workers.length }));

  // Start DB-polling signal worker
  const signalWorker = new SignalWorker();
  signalWorker.start();

  // Graceful shutdown
  async function shutdown(signal: string): Promise<void> {
    console.log(JSON.stringify({ level: "info", event: "worker.shutdown", signal }));
    signalWorker.stop();

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
