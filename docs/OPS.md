<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS — Operational reference (health, SSE, durable stores)

Short operational surface for the surfaces built and verified in the 2026-09-06
durability campaign: health endpoints with flush observability, the research SSE
stream, the shared-KV durable stores, and graceful shutdown. For general day-2
operations (logs, queues, DB, scaling, incidents) see
[runbook.md](runbook.md); for the current build state see
[STATUS.md](STATUS.md). Environment variables are documented in
[`.env.example`](../.env.example).

---

## 1. Health endpoints (root scope — no prefix, no auth)

Registered in `apps/api/src/routes/health.ts`, mounted at the Fastify **root**
(`/health`, `/health/ready` — **not** under `/api` or `/api/v1`). Both return
`Cache-Control: no-cache`.

### `GET /health` — liveness

```json
{ "status": "ok", "version": "0.1.0", "timestamp": "2026-09-06T…Z" }
```

Always 200 while the process serves.

### `GET /health/ready` — readiness

Runs all probes concurrently (each bounded by its own timeout) and returns:

```json
{
  "status": "ready | degraded | down",
  "checks": { "db": "ok", "kv": "ok", "costlog_flush": "ok" },
  "messages": {},
  "latencies": { "db": 1.2, "kv": 0.8, "costlog_flush": 0.01 },
  "durationMs": 3.1,
  "costLog": {
    "pendingEntries": 0,
    "dirty": false,
    "lastFlushAt": "2026-09-06T…Z",
    "lastFlushAgeMs": 4100,
    "consecutiveFailures": 0,
    "totalFlushes": 12,
    "totalFailures": 0
  }
}
```

Probes:

| Probe           | Critical | Fails when                                                  |
| --------------- | -------- | ----------------------------------------------------------- |
| `db`            | yes      | `SELECT 1` throws → status `down` → **HTTP 503**            |
| `kv`            | no       | shared-KV set/get round-trip fails → `degraded` (still 200) |
| `costlog_flush` | no       | `consecutiveFailures ≥ 3` (cost-log KV flushes failing)     |

Status mapping: all ok → `ready` (200); a non-critical probe fails → `degraded`
(200, pod stays in rotation); any critical probe fails → `down` (503).

The `costLog` block is the write-behind flush health for the cost log (see §4):
it rides **every** readiness response, so an operator always sees the pending
tail and the age of the last successful flush — not only when the probe trips.
A growing `pendingEntries` with climbing `consecutiveFailures` means persistence
has silently degraded to in-memory (reads still work; history would be lost on
restart).

---

## 2. SSE streams

| Stream                                        | Auth | Purpose                                                   |
| --------------------------------------------- | ---- | --------------------------------------------------------- |
| `GET /api/research/:id/stream` (bridge scope) | yes  | Deep-research run: phases, citations, report, done        |
| `GET /api/v1/sse/tasks` … `sse/verdicts` …    | yes  | Global event-bus fan-out (agent tasks, signals, verdicts) |

### Research run stream (`/api/research/:id/stream`)

Event framing is `data: <json>\n\n` per event, in this order for a successful run:

1. `phase_start` — `planning`
2. `phase_start` / `phase_done` — `researching` (per search cycle)
3. `phase_start` — `synthesis`; `citation` events as sources are emitted
4. `phase_done` — `synthesis`; `phase_start` — `complete`
5. `report` (full synthesis text) then `done` (`totalMs`)

Failures emit an `error` event and write the job record through to `error`.
The page never consumes `phase_start`'s sibling `phase_done` from a _replayed_
job: the durable record, not the live stream, is the source of truth for
history/deep links (see §4).

---

## 3. Shared KV — what backs the durable stores

All stores below persist to a single shared-KV abstraction (`getSharedKV()` in
`apps/api/src/lib/shared-kv.ts`). Backend priority:

1. Cloudflare Workers KV (when running on the CF edge)
2. **Redis** — `REDIS_URL` (same instance that backs BullMQ; cross-pod safe)
3. **Upstash REST** — `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
4. **In-process memory** — no Redis/Upstash configured (single pod only)

> The in-memory fallback is a **dev/CI convenience only**: data does not survive
> an API restart and is not shared across pods. Production requires Redis (or
> Upstash). Per-user stores remain isolated regardless of backend; the cost log
> is **workspace-global by design** (single-install semantics — see §4).

---

## 4. Durable stores

All are KV stores written through from route/emitter code with **write-through
on state transitions**. Key layout, TTL, and recovery semantics:

| Store (owner module)                             | Keys                                                               | TTL   | Semantics / recovery                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threads** (`lib/threads-store.ts`)             | `thread:list:{uid}`, `thread:item:{uid}:{id}`, per-thread messages | 365 d | Per-user. Id list is write-order authoritative; locked read-modify-write per key                                                                                                                                                                                                                                                                                                               |
| **Notifications** (`lib/notifications-store.ts`) | `notif:list:{uid}`, `notif:item:{uid}:{id}`                        | 30 d  | Per-user. Research completion/failure notifications link to `/deep-research?id=…`                                                                                                                                                                                                                                                                                                              |
| **Research jobs** (`lib/research-jobs.ts`)       | `research:list:{uid}`, `research:item:{uid}:{id}`                  | 90 d  | Per-user, 200 jobs/user cap. Milestones (`phase → startedAt/finishedAt/detail`) persisted at every phase transition. **Zombie recovery**: a job still `running` whose `updatedAt` is > 5 min old (engine is provably bounded to one ≤15 s search + one ≤90 s synthesis) is written through to `error` — "Interrupted before completion…" — on the next read, so no surface shows a phantom run |
| **Cost / usage log** (`lib/cost-log.ts`)         | `costlog:day:YYYY-MM-DD`                                           | 150 d | **Workspace-global** (matches the weekly digest's single-install semantics). In-memory array capped at 10 000 newest entries is the hot read path; a debounced batched flush (2 s trailing idle, 10 s max under load) write-behinds only the delta. `record()` is synchronous — zero hot-path KV latency                                                                                       |

Cost-log flush contract (operator-relevant):

- **Best-effort by design.** A KV error keeps entries in memory (reads stay
  correct) and the watermark does not advance, so the next flush retries the
  whole delta. A crash between flushes loses **at most the last few seconds** —
  never the whole history.
- **Graceful shutdown flushes the tail.** `SIGTERM`/`SIGINT` →
  `gracefulShutdown` in `apps/api/src/index.ts` → `app.close()` → the
  `onClose` hook in `server.ts` calls `costLogStore.close()` (bounded to 2 s so
  a KV hang cannot stall process exit). A clean deploy loses ~zero; an unclean
  kill (e.g. the `tsx watch` dev runner on Windows force-kills) stays within
  the documented few-seconds window.
- **Flush observability.** See the `costLog` block + `costlog_flush` probe in
  §1.
- Known residual: a flush straddling midnight whose _second_ day-write fails
  can double-count that flush's tail on retry — astronomically rare, accepted
  over data loss.

---

## 5. Quick references

- Store ownership + design notes: STATUS.md pass 4–9 sections.
- KV/queue infra and deployment: `docs/DEPLOYMENT.md`, `docs/runbook.md`.
- Test tiers that exercise these surfaces: `docs/TESTING.md`.
- Local env: `cp .env.example .env` (see §3 for the KV backend variables).
