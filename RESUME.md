# RESUME — Nexus deploy + browser-agent work

> Last: 2026-06-23 | Branch: `claudecode`

## DEPLOY STATUS (2026-06-24)
- ✅ **API (Render)** LIVE. Now has REDIS_URL (Render Redis red-d8tlqoraml3c73bjfseg) + BROWSER_CDP_URL (Browserbase wss). stealth-browser: playwright-core client + connectOverCDP → browser-agent can drive hosted browser.
- ✅ **Frontend (Vercel)** READY.
- ⛔ **Worker** — Render free = web-services only; background_worker needs a CARD (any plan). Create blocked: `only web services allowed for plan` / `Payment information is required`. **Options: (a) add card to Render → background_worker, (b) run worker free elsewhere (Railway/Fly/local) with same REDIS_URL+DATABASE_URL.**

## ✅ WORKER WORKING (2026-06-24) — Redis Cloud
- Redis: **Redis Cloud free** (raw TCP, no card) `cat-tax-pipe-13535.db.redis.io:12561` — Upstash free was REST-only (no BullMQ TCP); Render Redis internal-only. Redis Cloud = only free raw-TCP path.
- API REDIS_URL + worker .env REDIS_URL both → Redis Cloud (shared queue).
- Worker runs LOCAL on laptop (free): `cd /home/yash/Nexus && node --env-file=.env apps/worker/dist/index.js`. Tested: worker.ready, repeatable jobs bootstrapped, job.completed (feeds:refresh). Queue e2e proven: API enqueue→Redis Cloud→worker consume→complete.
- Neon migrated (all tables). 
- Caveat: worker alive only while laptop terminal open. Eviction policy volatile-lru (BullMQ wants noeviction — change in Redis Cloud config, non-blocking warning).

## FULL STACK STATUS — ALL GREEN
API ✅ | Frontend ✅ | Auth ✅ | Browser-agent ✅ | Worker ✅ (local) | DB ✅ | Redis ✅


- **API (Render)** LIVE — Redis + Browserbase CDP + all NEXUS_* envs + provider keys set.
- **Frontend (Vercel)** LIVE.
- **Auth** register/login WORKS (scrypt maxmem fix + NEXUS_JWT_SECRET set). JWT issued.
- **Browser-agent E2E WORKS**: register→JWT→POST /browser-agent/tasks → Browserbase headless chromium navigates, Groq llama-3.3-70b drives loop, returns result + screenshot. Tested example.com → "Example Domain", 2 steps, 20KB screenshot. ✅
- Fixes this session (post-deploy): scrypt maxmem, env name mismatches, slice guards, groq model for agent loop, playwright-core CDP client.

## STILL TODO
- **Worker** still not deployed (Render free = no background_worker, needs card). BullMQ jobs (agent.run/council/feeds/drive-exec async) idle. Browser-agent runs SYNC in API request so works without worker. To enable: add card → create background_worker service (Dockerfile apps/worker, REDIS_URL=redis://red-d8tlqoraml3c73bjfseg:6379 + DATABASE_URL + keys), OR run worker on Railway/Fly free with Upstash redis:// URL.
- Browserbase free tier = limited sessions/min; may rate-limit under load. Steel key avail as alt (set BROWSER_CDP_URL to Steel wss).


- ✅ scrypt 500: `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` (N=32768 needs ~32MB > OpenSSL default maxmem). Added `maxmem=128MB` to hashPassword+verifyPassword (auth-users.ts).
- ✅ Render env NAME MISMATCH: code reads `NEXUS_*`, Render had old names (JWT_SECRET/HMAC_KEY/SCRYPT_SECRET). Set on Render: NEXUS_JWT_SECRET, NEXUS_AUDIT_KEY, NEXUS_INGEST_API_KEY + ANTHROPIC/TAVILY/GEMINI/MISTRAL/OPENROUTER/DEEPSEEK/STRIPE/UPSTASH (from local .env). REDIS_URL + BROWSER_CDP_URL also set.
- ⏳ Verify: register→JWT→browser-agent chain end-to-end after settle.


- Render Redis: `red-d8tlqoraml3c73bjfseg`, `redis://red-d8tlqoraml3c73bjfseg:6379` (internal — only reachable from Render services). Set on API.
- Upstash redis:// (TLS): `desired-robin-125867.upstash.io:6379` token gQAA... — usable from anywhere (worker if run off-Render). REST url also avail.
- Browserbase: `bb_live_9Me9S8k3nLzIV9QO5uBo1XQE1AQ` → BROWSER_CDP_URL `wss://connect.browserbase.com?apiKey=...` (may need projectId param — verify if browser-agent errors).
- Steel: `ste-x5s5pvOPZ...` (alt CDP provider).




Build failures were ALL stale Dockerfile/code, fixed in sequence:
1. ✅ stale `@nexus/conductor` COPY (deleted pkg) — removed
2. ✅ missing `bullmq` API dep — added
3. ✅ broken `@nexus/video-transcript` pkg (no build script + TS errors) — fixed then removed (unused)
4. ✅ **build order bug**: hand-ordered 75-pkg chain had `runtime` before `agent-runtime` (runtime imports it) → `Cannot find module @nexus/agent-runtime` on clean build. Replaced API+worker chains with topo build `pnpm --filter "@nexus/api..." build`. **Build now SUCCEEDS.**
5. ✅ **runtime crash**: `@nexus/runtime/bootstrap.ts` used CJS `require.main`+`__dirname` in ESM pkg → `ReferenceError: require is not defined` at API boot → exit 1 (update_failed). Fixed with `import.meta.url` guard + `fileURLToPath`.
6. ✅ worker Dockerfile: topo build + `pnpm deploy` pruner (was missing agent-runtime/sandbox dist).

Current deploy: `331f061` building — **VERIFY live**: `curl https://nexus-api-8xr0.onrender.com/api/v1/drive/status` = 200 (not 404 = new code live).

## DONE THIS SESSION
- Browser-agent server-side loop endpoints (api-bridge.ts): POST /browser-agent/tasks, GET/POST /sessions[/:id][/action]. LLM picks action→browser executes→screenshot.
- stealth-browser BROWSER_CDP_URL remote-CDP support.
- Web connectProvider honesty fixed (deliberate.ts): dropped dead-end window.open; isProviderConnected checks /api/user/provider-keys.

## TODO (resume here)
1. **Confirm 331f061 live** (drive/status=200). If update_failed again → fetch boot logs: `curl -H "Authorization: Bearer $RENDER_API_KEY" "https://api.render.com/v1/logs?ownerId=tea-d7n6tk1o3t8c73eh0rh0&resource=srv-d8qijfm8bjmc738p8u90&type=app&limit=80&direction=backward"` grep `[fatal]`.
2. **Browser-agent real engine**: patchright NOT on Render. Set `BROWSER_CDP_URL` to Browserbase/Steel (need their key — not provided) OR add patchright to Dockerfile (heavy, paid plan).
3. **Vercel frontend redeploy** (picks up bluff fixes + connectProvider): repoId 1266057168, ref claudecode.
4. **Worker NOT deployed** — only API up. Need separate Render service for worker (BullMQ) + Postgres + Redis for agent.run/council/drive/feeds. API-only now.
5. Render `AUDIT_LOG_KEY` unset (warn, non-fatal).

## KEYS / IDS
- Render API svc: `srv-d8qijfm8bjmc738p8u90`, owner `tea-d7n6tk1o3t8c73eh0rh0`, RENDER_API_KEY in .env. DATABASE_URL on Render = Neon ✓.
- Vercel: prj_zwkcmZqDohI5GsKI7YziUtGJj5xF, repoId 1266057168. URL nexus-api-three-kappa.vercel.app.
- API Docker: `apps/api/Dockerfile`, PORT 10000, proxied from Vercel /api/*.
- All tokens (Vercel/Render/CF/Supabase/Neon/Upstash/GitHub) in .env, gitignored.

