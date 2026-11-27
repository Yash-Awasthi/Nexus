<!-- verified: 8065a84 2026-11-25 -->

# Capacity: measured, with the machine and the command

Every number on this page came from `scripts/load-probe.ts` on the machine named below. Where a number was not
measured it says so, because a capacity model assembled from plausible-looking figures is worse than none — it gets
quoted.

## 1. How the numbers were taken

```bash
LOG_LEVEL=warn PROBE_DURATION_MS=4000 PROBE_LEVELS=1,8,32,64 node scripts/load-probe.ts
```

The probe boots the real API in-process (`buildServer()`), migrates, listens on `127.0.0.1:4287` and drives two
routes with N concurrent keep-alive clients for four seconds each:

- `GET /health` — no database, no auth: the cost of the HTTP stack alone.
- `GET /health/ready` — runs the dependency probes including a `select 1`: the cost of the stack plus one query.

**What it is not:** the client is in the loop (undici on the same machine), the database is embedded pglite with a
single writer, and the network is Windows loopback. Treat the throughput as a **floor** for a real deployment and
the shape — which resource saturates first — as the useful part.

### Machine

|           |                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------- |
| CPU       | 20 logical cores (x64)                                                                             |
| Node      | v26.8.1                                                                                            |
| OS        | win32 x64                                                                                          |
| Replicas  | **1** (one process, one event loop)                                                                |
| Database  | pglite, single writer (`pglite://:memory:`)                                                        |
| Log level | `warn` (the default `info` roughly halves the cheap-route numbers: pino writes a line per request) |

## 2. Measured throughput

One run, four seconds per cell, zero errors throughout:

| Route           | Concurrency | RPS  | p50 ms | p95 ms | p99 ms |
| --------------- | ----------- | ---- | ------ | ------ | ------ |
| `/health`       | 1           | 68   | 15.6   | 16.7   | 17.0   |
| `/health`       | 8           | 2381 | 3.0    | 5.8    | 8.3    |
| `/health`       | 32          | 2941 | 9.7    | 16.4   | 19.7   |
| `/health`       | 64          | 2879 | 21.5   | 32.3   | 40.0   |
| `/health/ready` | 8           | 2525 | 2.8    | 5.1    | 6.9    |
| `/health/ready` | 32          | 2726 | 11.4   | 17.9   | 21.7   |
| `/health/ready` | 64          | 2570 | 25.0   | 35.1   | 38.2   |

Two honesty notes, because both are easy to misread:

- **The 68 RPS at concurrency 1 is the client, not the server.** One client measures its own round-trip overhead
  (~15 ms on Windows loopback) and never queues anything. The server's own cost shows up at 8+ concurrency, where
  p50 falls to 3 ms.
- **Run-to-run variance is ±25%.** Across three runs the 32-client plateau landed between 2 008 and 3 389 RPS. The
  model below uses **~2 500 RPS per replica** as the working number, not the best run.

## 3. The limits, in the order they break

| #   | Limit                                 | Value                                                           | Where it comes from                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **One event loop**                    | ~2 500 RPS of cheap routes per replica                          | measured above; latency climbs steadily from 32 → 64 clients without throughput growing, which is the signature of a saturated loop and not of a saturated database                                                                                                                                                                    |
| 2   | **Postgres connections per replica**  | **10**                                                          | `lib/pg-pool.ts` creates one pool per connection string with no `max`, so the driver default applies. Every replica opens its own 10.                                                                                                                                                                                                  |
| 3   | **Database sessions across replicas** | **10 × replicas**                                               | Postgres `max_connections` is 100 by default (Neon: 100 for the pooled endpoint). **The 11th replica is refused** unless a pooler sits in front: 10 replicas × 10 = 100.                                                                                                                                                               |
| 4   | **Redis round-trips**                 | 1 connection per process, 2–4 commands per KV read              | `lib/shared-kv.ts` is a single client; the durable stores do a read-modify-write per key. Not measured locally (no Redis in the probe), so this row is arithmetic, not a benchmark.                                                                                                                                                    |
| 5   | **Memory per replica**                | bounded by the stores, not by traffic                           | request traces keep the newest 1 000, the cost log 10 000 entries (`RETENTION`, `MAX_COST_ENTRIES`). A soak of 200 turns shows heap growth under 12 MB (`tests/runtime/soak.test.ts`).                                                                                                                                                 |
| 6   | **Boot cost per replica added**       | 6.9–7.3 s to `/health` 200 on a quiet machine (fastest of five) | the `api-boot-budget` gate boots the server five times on every push, enforces the **fastest** against the 15 000 ms budget and prints all five, because one sample on a busy machine read 7.3 / 9.7 / 11.5 / 20.7 s for the same commit. Scaling out pays this cost once per replica, and a rolling deploy pays it per replica again. |

**The number that breaks first is the database connection budget, not throughput.** One replica handles far more
requests than a small deployment will send it; the thing that stops scale-out at eleven replicas is
`10 connections × 11 > 100`. That is why the first scaling step in `docs/runbook.md` §5 is a pooler and not more
replicas.

## 4. What this model does not cover

- **Real Postgres and real Redis latency.** The probe's database has no network hop. On a managed instance each
  query costs 1–3 ms more, which moves every DB-bound route's ceiling down by roughly that factor.
- **LLM spend and provider latency.** A chat request's wall time is dominated by the model, not by this process;
  capacity here is about how many requests can be _in flight_, not how long an answer takes.
- **Worker throughput.** `apps/worker` has its own boot budget and queue concurrency; it scales on queue depth
  (`docs/runbook.md` §5), not on RPS.

## 5. Re-measuring

Run the probe on the machine that matters (a CI runner, or a staging box) and update this page in the same pull
request, with the date. Two runs, not one: if the two disagree by more than 20%, report the slower.
