// SPDX-License-Identifier: Apache-2.0
/**
 * A load probe you can run on your own machine, so the capacity numbers in `docs/CAPACITY.md` have a date and a
 * command instead of a memory.
 *
 *   node scripts/load-probe.ts                 # 1, 8 and 32 concurrent clients, 5 s each
 *   node --cpu-prof scripts/load-probe.ts      # same, with a profile (what is actually burning the time)
 *
 * Two routes, deliberately: `/health` never touches the database and `/health/ready` runs a `select 1` plus the
 * dependency probes, so the difference between them is what the database costs per request. The server runs
 * in-process against embedded Postgres on a fixed port, which is why the numbers are a **floor**: pglite serialises
 * every query in one writer, so a real Postgres will beat it. What the probe can honestly tell you is the shape —
 * which resource runs out first as concurrency rises.
 */
import { performance } from "node:perf_hooks";

process.env.DATABASE_URL = process.env.PROBE_DATABASE_URL ?? "pglite://:memory:load-probe";
process.env.NEXUS_JWT_SECRET = "load-probe-secret";

const PORT = Number(process.env.PROBE_PORT ?? 4287);
const DURATION_MS = Number(process.env.PROBE_DURATION_MS ?? 5_000);
const LEVELS = (process.env.PROBE_LEVELS ?? "1,8,32").split(",").map(Number);

const { migrateEmbedded } = await import("../apps/api/src/lib/migrate-embedded.ts");
const { closePgPools, getPgPool } = await import("../apps/api/src/lib/pg-pool.ts");
const { buildServer } = await import("../apps/api/src/server.ts");

await migrateEmbedded(getPgPool(process.env.DATABASE_URL)!);
const app = await buildServer();
await app.listen({ port: PORT, host: "127.0.0.1" });

const base = `http://127.0.0.1:${PORT}`;

/** One client: keep asking the same route until the deadline, recording each round-trip in ms. */
async function client(path: string, deadline: number, latencies: number[]): Promise<number> {
  let done = 0;
  while (performance.now() < deadline) {
    const started = performance.now();
    const response = await fetch(`${base}${path}`, { headers: { connection: "keep-alive" } });
    await response.arrayBuffer();
    latencies.push(performance.now() - started);
    done += 1;
  }
  return done;
}

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

const rows: string[] = [];
rows.push("| Route | Concurrency | Requests | RPS | p50 ms | p95 ms | p99 ms | Errors |");
rows.push("| --- | --- | --- | --- | --- | --- | --- | --- |");

for (const path of ["/health", "/health/ready"]) {
  for (const level of LEVELS) {
    const latencies: number[] = [];
    let errors = 0;
    const deadline = performance.now() + DURATION_MS;

    // Warm the route once so connection setup is not counted as a latency sample.
    await fetch(`${base}${path}`).then((r) => r.arrayBuffer());

    const counts = await Promise.all(
      Array.from({ length: level }, () =>
        client(path, deadline, latencies).catch(() => {
          errors += 1;
          return 0;
        }),
      ),
    );
    const total = counts.reduce((sum, n) => sum + n, 0);
    const elapsed = DURATION_MS / 1000;
    rows.push(
      `| \`${path}\` | ${level} | ${total} | ${(total / elapsed).toFixed(0)} | ${percentile(latencies, 50).toFixed(1)} | ${percentile(latencies, 95).toFixed(1)} | ${percentile(latencies, 99).toFixed(1)} | ${errors} |`,
    );
  }
}

const pool = getPgPool(process.env.DATABASE_URL) as unknown as { options?: { max?: number } };
console.log(rows.join("\n"));
console.log("");
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpus: (await import("node:os")).cpus().length,
      database: process.env.DATABASE_URL.startsWith("pglite")
        ? "pglite (single writer, a floor)"
        : "postgres",
      poolMax: pool?.options?.max ?? "driver default (10 for node-postgres)",
      durationMs: DURATION_MS,
      levels: LEVELS,
    },
    null,
    2,
  ),
);

await app.close();
await closePgPools();
process.exit(0);
