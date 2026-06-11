<!-- SPDX-License-Identifier: Apache-2.0 -->
# NEXUS Chaos Engineering Scenarios

Run these scenarios quarterly (or before major releases) to validate resilience.

**Tooling:** [Chaos Toolkit](https://chaostoolkit.org/) + Docker Compose override  
**Prerequisite:** Full stack running via `docker compose up`

---

## Scenario 1: API pod crash and recovery

**Hypothesis:** When the `nexus-api` container crashes, it restarts within 30 seconds and serves requests normally.

**Actions:**
1. Stop the `nexus-api` container
2. Wait 30 seconds
3. Send 10 health-check requests

**Expected:** All 10 requests succeed after the restart window.

```bash
docker compose kill nexus-api
sleep 5
docker compose up -d nexus-api
sleep 25
for i in $(seq 1 10); do
  curl -sf http://localhost:3000/health && echo OK || echo FAIL
done
# PASS: 10x OK
```

---

## Scenario 2: Redis failure — queue resilience

**Hypothesis:** When Redis goes down, in-flight jobs are not lost; the SignalWorker DB-polling fallback picks them up on Redis recovery.

**Actions:**
1. Ingest 20 events (all go to DB + Redis)
2. Kill Redis
3. Ingest 5 more events (DB only — Redis publish fails gracefully)
4. Wait 30 seconds
5. Restart Redis
6. Verify all 25 events are processed (Signal rows created)

```bash
# Ingest 20 events
for i in $(seq 1 20); do
  curl -s -X POST http://localhost:8000/ingest/events \
    -H "Authorization: Bearer $NEXUS_INGEST_API_KEY" \
    -d "{\"source\":\"chaos\",\"event_type\":\"test\",\"payload\":{\"n\":$i}}"
done

# Kill Redis
docker compose kill redis
sleep 5

# 5 more (DB-only path)
for i in $(seq 21 25); do
  curl -s -X POST http://localhost:8000/ingest/events \
    -H "Authorization: Bearer $NEXUS_INGEST_API_KEY" \
    -d "{\"source\":\"chaos\",\"event_type\":\"test\",\"payload\":{\"n\":$i}}"
done

# Restart Redis — SignalWorker will drain the unprocessed DB rows
docker compose up -d redis
sleep 30

# Check: all 25 should have processed_at set
psql $DATABASE_URL -c "SELECT count(*) FROM ingested_events WHERE source='chaos' AND processed_at IS NOT NULL;"
# PASS: count=25
```

---

## Scenario 3: Postgres connection exhaustion

**Hypothesis:** When Postgres is overloaded with connections, the API returns 503 gracefully (not crash).

**Actions:**
1. Open 200 idle connections to Postgres (max_connections typically 100)
2. Send 10 API requests
3. Expect: either 503 with clear error, or requests succeed via pool wait

```bash
# Exhaust connections (requires psql + pgbench installed)
pgbench -c 200 -j 10 -T 60 $DATABASE_URL &
PGBENCH_PID=$!

sleep 5
for i in $(seq 1 10); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $NEXUS_API_KEY" \
    http://localhost:3000/api/v1/runtime/tasks?limit=1)
  echo "Request $i: $STATUS"
done

kill $PGBENCH_PID
# PASS: requests return 200 or 503, never 500 (crash); process stays alive
```

---

## Scenario 4: Malicious job in BullMQ DLQ

**Hypothesis:** A poisoned job (prototype pollution payload) does not crash the worker or affect subsequent jobs.

**Actions:**
1. Push a crafted job directly to Redis queue
2. Observe worker processes 5 normal jobs immediately after
3. Verify no prototype pollution occurred

```bash
# Push poisoned job
redis-cli HSET "bull:nexus-medium:poison-001" \
  id poison-001 \
  name "ingest:event" \
  data '{"__proto__":{"isAdmin":true},"eventId":"","source":"","eventType":"","payload":{}}'  \
  opts '{"attempts":1}' timestamp "$(date +%s)000" delay 0 attempts 0 priority 0
redis-cli LPUSH "bull:nexus-medium:wait" "poison-001"

# Push 5 normal jobs immediately after
for i in $(seq 1 5); do
  redis-cli HSET "bull:nexus-medium:normal-$i" \
    id "normal-$i" name "ingest:event" \
    data "{\"eventId\":\"$i\",\"source\":\"chaos\",\"eventType\":\"test.chaos\",\"payload\":{}}" \
    opts '{"attempts":3}' timestamp "$(date +%s)000" delay 0 attempts 0 priority 0
  redis-cli LPUSH "bull:nexus-medium:wait" "normal-$i"
done

sleep 10
# Worker log should show poison-001 failed cleanly (not crashing), then 5 normal completions
docker compose logs nexus-worker --tail 20 | grep -E "job.completed|job.failed"
# PASS: 5x job.completed for normal-*; 1x job.failed for poison-001; process alive
```

---

## Running all scenarios

```bash
# Ensure clean state first
docker compose down --volumes && docker compose up -d
pnpm --filter @nexus/db drizzle:migrate

# Run each scenario sequentially (allow 5 min between)
bash infra/chaos/scenario-1-api-crash.sh
bash infra/chaos/scenario-2-redis-failure.sh
bash infra/chaos/scenario-3-db-exhaustion.sh
bash infra/chaos/scenario-4-dlq-poison.sh
```

Document results in `docs/chaos-results-vX.Y.Z.md`.
