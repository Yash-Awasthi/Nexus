# Nexus — Wiring & Plumbing TODO

_Runbook for finishing the local (no-paid-API) wiring. Every task states: files, steps, **expected final result**, a **verify** command, and a **regression guard** so it cannot break already-working features._

Path: `docs/WIRING_TODO.md`

---

## 0. Golden rules (read first)

1. **Never add a route that already exists.** The boot crash (`FST_ERR_DUPLICATED_ROUTE`) came from adding `/archetypes` when it already existed at `api-bridge.ts:9258`. **Before adding any `app.get/post("/x")`, grep first:**
   ```bash
   grep -n '"/x"' apps/api/src/routes/*.ts
   ```
2. **Local-only.** No cloud keys required. LLM = Ollama (`qwen2.5:7b`), embeddings = Ollama (`nomic-embed-text`, 768-dim). Don't reintroduce OpenAI/Groq calls in a default path.
3. **After every change, run the SMOKE TEST (section 9). It must stay all-green.** That is the "did I break working stuff" check.
4. **One API instance only.** Zombie processes cause `EADDRINUSE` + stale code. Kill cleanly:
   ```bash
   pkill -9 -f index.ts; pkill -9 -f tsx; sleep 3
   nohup bash scripts/dev-local.sh api > /tmp/napi.log 2>&1 & disown
   ```
5. If you edit a `packages/*` file, **rebuild that package** (`pnpm --filter @nexus/<pkg> build`) — the API imports built `dist`, not `src`.

---

## 1. Baseline — WORKING, do not regress

Verified live. These must keep passing after any change:

| Feature | Endpoint | Expected |
|---|---|---|
| Boot | `GET /health` | `200` |
| Register/Login | `POST /api/v1/auth/register`,`/login` | `201`/`200` + JWT |
| Memory write | `POST /api/memory/entries` `{content}` | `201` + entry with 768-dim `embedding` |
| Memory list | `GET /api/memory/entries` | `total` grows |
| Local LLM | `POST /api/reasoning/run` `{question}` | `{reasoning:"42"}` |
| Sandbox JS | `POST /api/sandbox/execute` `{language:"javascript",code}` | `output:"42"` |
| Gauntlet guard | `POST /api/gauntlet/stream` `{}` | `400` AND server stays up (`health=200`) |

---

## 2. TASK — Memory recall-by-query returns 0

- **Symptom:** `GET /api/memory/entries?query=...` → `{entries:[],total:0}` even though `list` shows the rows.
- **Cause:** semantic search min-score cutoff (or recall path) too strict; write/embed/persist already work.
- **Files:** `apps/api/src/routes/api-bridge.ts` (`GET /memory/entries` → `mem.recall`), `packages/memory/src/index.ts` (`MemoryManager.recall`, `PgVectorStore.search`).
- **Steps:** find the `minScore`/threshold in `recall()`/`search()`; lower or make it env-tunable (`NEXUS_MEMORY_MIN_SCORE`, default e.g. `0.1`). Confirm the query embedding uses the same embedder (Ollama 768) as writes.
- **Expected result:** `?query=favorite color` returns the "teal" entry with a `score`.
- **Verify:**
  ```bash
  curl -s "$API/api/memory/entries?query=favorite%20color&limit=3" -H "$AUTH" | python3 -m json.tool
  ```
- **Regression guard:** memory **write** + **list** must still pass (section 9). Do not change the embedder or the `vector(768)` column.

---

## 3. TASK — Verify/repair the "path mismatch" endpoints (LIVE, not by grep)

Audit flagged these as 404-at-UI-path. **archetypes was a FALSE positive (already worked)** — trust the live probe, not static grep.

For EACH endpoint below: (a) probe it live, (b) if truly 404, find where the handler really lives, (c) **repoint the UI fetch** (preferred) OR add a NON-duplicate alias.

| UI calls | Check / likely real path |
|---|---|
| `POST /api/reasoning/run` | ✅ already works (local) |
| `POST /api/drift/optimize` | real routes are `/drift/compute,rate,detect` (`routes/drift.ts`) |
| `POST /api/evaluate` | handler at `api-bridge.ts:1952` — confirm mount/prefix |
| `POST /api/codegen/generate,iterate` | `api-bridge.ts:7258+` — confirm method/prefix |
| `POST /api/craft/generate` | `api-bridge.ts:2312+` — confirm |
| `GET /api/v1/agents` | real sub-paths `/agents/librarian/query`, `/agents/file/*` (`routes/agents.ts`) |
| `POST /api/fallback-chains/test` | `/test` not registered — add executor or repoint |

- **Steps per endpoint:**
  1. Probe: `curl -s -o /dev/null -w "%{http_code}\n" -X POST "$API/<path>" -H "$AUTH" -H 'Content-Type: application/json' -d '{}'` (use GET for GETs). `404` = mismatch; `400/200/500` = exists.
  2. If UI path differs from real path → edit the UI fetch in `apps/ui/app/routes/<page>.tsx` to the real path. **Do not add a duplicate backend route.**
  3. If genuinely missing → add the route, after grepping to confirm it's not already declared.
- **Expected result:** UI page loads data / action returns non-404. LLM-backed ones return content via Ollama.
- **Regression guard:** before adding any route, run `grep -n '"/<path>"' apps/api/src/routes/*.ts` — if it exists, DON'T add (repoint UI instead). Re-run smoke test; boot must stay green (a dup = boot crash).

---

## 4. TASK — Confirm all LLM features run on local Ollama

Now that `OllamaDriver` rewrites cloud model strings → local model, these should work without per-handler edits. **Verify, don't assume.**

- **Endpoints:** `POST /api/honesty/sycophancy-check`, `/api/hallucination/score`, `/api/echo-chamber/detect`, `/api/negation/detect`, `/api/moderation/check`, `/api/extraction/run`, `/api/v1/council/deliberate`.
- **Steps:** probe each with a minimal valid body; expect `200` + content. Council uses `COUNCIL_MODEL` (`.env`) — if it errors, set council to a local alias or ensure it goes through the default driver.
- **Expected result:** each returns a real LLM answer sourced from Ollama (watch `/tmp/napi.log` — provider should be `ollama`, no `MODEL_NOT_FOUND`).
- **Regression guard:** `reasoning/run` (baseline) must still return `42`. Moderation may use OpenAI moderation if a key is set — keep its heuristic fallback for no-key.

---

## 5. TASK — Sandbox non-JS (Piston is dead)

- **Symptom:** Python/Go/etc → `"Public Piston API is now whitelist only"`.
- **Options (pick one):**
  - **A (recommended, local):** run Piston in Docker, set `PISTON_URL=http://localhost:2000/api/v2` in `.env`. Handler already prefers `PISTON_URL` when not `emkc.org`.
  - **B:** Pyodide (in-process Python via WASM) for Python only.
- **Files:** `apps/api/src/routes/api-bridge.ts` (`/sandbox/execute`, `/sandbox/status`).
- **Expected result:** `POST /sandbox/execute {language:"python",code:"print(2**10)"}` → `output:"1024"`. `/sandbox/status` reports non-JS available only when a real runner is configured.
- **Regression guard:** JS execution path unchanged — `console.log(6*7)` still `42`.

---

## 6. TASK — Stub endpoints (decide: wire or hide)

Return 200 with fake/seed data (from `FEATURE_AUDIT.md`): `task-routing/*`, `specialisation/detect`, `semantic-cache/*`, `leaderboard` (fictional numbers), `admin/users`, `admin/audit-logs`, `feedback/*`, `voice/chat`, `video/transcript`, `analytics/overview`, `costs/limits`, `connectors sync-jobs`, `research/related-questions`.

- **Steps:** per feature, either wire to real data/LLM OR remove the nav item so the product stops advertising it.
- **Expected result:** no page shows convincingly-fake data.
- **Regression guard:** these are isolated handlers — changing one must not touch shared helpers (`getMemory`, `getDefaultDriver`, `getRegistry`). Smoke test after each.

---

## 7. TASK — Global error handler (finish stability)

- **Done:** `index.ts` `unhandledRejection` logs instead of exiting; gauntlet null-check.
- **Left:** add a Fastify `app.setErrorHandler(...)` in `server.ts` that returns `500 {error}` instead of letting a throw bubble. Add `process.on("uncaughtException", log)` too.
- **Expected result:** any handler throw → clean `500` JSON, server stays up.
- **Verify:** hit a few endpoints with garbage bodies; `health=200` after each.
- **Regression guard:** valid requests still return their normal codes (not masked as 500).

---

## 8. TASK — Sync `FEATURE_AUDIT.md`

- Mark: archetypes = **was never broken** (audit error); Gauntlet = FIXED (crash-guard); Memory = **working locally** (write/list/embed; recall pending §2); Local LLM = FIXED; Sandbox non-JS = still blocked (§5).
- **Expected result:** doc matches reality.
- **Regression guard:** docs only — no code impact.

---

## 9. SMOKE TEST — run after EVERY change (must stay all-green)

Copy-paste. All lines must print `PASS`. This is the "did I break working stuff" gate.

```bash
API=http://localhost:3000
bash -c '
set -u; API=http://localhost:3000
E="smoke+$(date +%s)@x.io"; P="LocalDev12345!"
T=$(curl -s -X POST $API/api/v1/auth/register -H "Content-Type: application/json" -d "{\"email\":\"$E\",\"password\":\"$P\"}" | python3 -c "import sys,json;print(json.load(sys.stdin).get(\"accessToken\",\"\"))")
A="Authorization: Bearer $T"
chk(){ [ "$1" = "$2" ] && echo "PASS $3" || echo "FAIL $3 (got $1 want $2)"; }
chk "$(curl -s -o /dev/null -w %{http_code} $API/health)" 200 "health"
chk "$([ -n "$T" ] && echo ok)" ok "auth-token"
chk "$(curl -s -o /dev/null -w %{http_code} -X POST $API/api/memory/entries -H "$A" -H "Content-Type: application/json" -d "{\"content\":\"smoke test note\"}")" 201 "memory-write"
chk "$(curl -s -X POST $API/api/reasoning/run -H "$A" -H "Content-Type: application/json" -d "{\"question\":\"What is 17+25? number only.\"}" | grep -c 42)" 1 "local-llm"
chk "$(curl -s -X POST $API/api/sandbox/execute -H "$A" -H "Content-Type: application/json" -d "{\"language\":\"javascript\",\"code\":\"console.log(6*7)\"}" | grep -c 42)" 1 "sandbox-js"
curl -s -o /dev/null --max-time 15 -X POST $API/api/gauntlet/stream -H "$A" -H "Content-Type: application/json" -d "{}"
chk "$(curl -s -o /dev/null -w %{http_code} $API/health)" 200 "server-survives-badreq"
'
```

**Rule:** if any line is `FAIL`, stop and fix before continuing — you regressed a working feature.

---

## Status (2026-07-04)

- §2 memory recall — ✅ **DONE** (works; earlier 0 was a stale-embedding test artifact).
- §3 path mismatches — ✅ **MOOT** (all false positives; endpoints return 200/201. `/api/v1/agents` not UI-called).
- §4 LLM on Ollama — ✅ **VERIFIED** (0 MODEL_NOT_FOUND). Minor: `hallucination/score` JSON-parse fallback + weak `negation/detect` = qwen output-format quality, not wiring.
- §7 global error handler — ✅ **DONE** (already present: `setErrorHandler` + unhandledRejection logs-not-crashes).
- §5 sandbox — ✅ **JS + Python local** (Python via Pyodide/WASM, no Docker, no cost; `print(2**10)`→`1024`). Go/Rust/Ruby/R/bash still need a local Piston (`PISTON_URL`).
- §6 stubs — ✅ **DONE 2026-07-04.** Earlier de-stubbed: `task-routing/classify`, `specialisation/detect`, `voice/chat`, `research/related-questions`. This pass wired the rest to real local data:
  - `analytics/overview`→`gatewayLog.stats()`; `semantic-cache`→Ollama-embedding cosine (+`/semantic-cache/store`); `admin/users`→`users` table; `admin/audit-logs`→`audit_log` table (+ fixed `audit-emitter` non-tx fallback for neon-http); `feedback`→`_feedbackStore`+reactions (+`POST /feedback`); `connectors sync-jobs`→PersistentStore; `costs/limits`→env+`_costLog`; `echo-chamber/inject-dissent`+`cross-memory/context`→real LLM; `echo-chamber/config` persists; `member-evolution/recompute,apply`+`negation/inject`→real stored state; `token-conservation/status`→active-budget count.
  - Labeled (kept visible, inherently external): `leaderboard` (`measured:false`+disclaimer, UI note); `video/transcript` (honest 503, needs `YOUTUBE_API_KEY`).
  - Verified: smoke all-PASS + per-endpoint curl. No fake data on any page.
- Also shipped: `parseJsonResponse` hardened (extracts JSON from qwen prose → hallucination/negation now parse), embedder warm-up on boot (fixes cold-recall miss).
- §8 audit doc — ✅ **SYNCED** (`FEATURE_AUDIT.md` has the 2026-07-04 update).

### Known caveat
- Memory recall can return 0 on a **cold** embed right after restart (Ollama warm-up). Warm calls are reliable. If it matters, add a warm-up embed on boot or a 1× retry in `recall()`.

### Remaining
1. §6 stubs — wire or hide fake-data endpoints (list in `FEATURE_AUDIT.md`).
2. §5b other langs (Go/Rust/…) — only if needed: run local Piston, set `PISTON_URL`.
3. Optional quality: tighten LLM JSON prompts (hallucination/negation) so qwen returns parseable output.
