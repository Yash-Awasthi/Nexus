# DEPLOYMENT.md — Nexus redeploy runbook

> For interviews/demos. Trials deplete → use this to rebuild the live stack fast.
> Repo: `https://github.com/Yash-Awasthi/Nexus` · Branch: **`claudecode`** · ~5 services, all free-tier.

---

## ARCHITECTURE (what runs where)

```
Browser → Vercel (static React SPA)
            │  /api/* proxied →
            ▼
          Render (Fastify API, Docker)
            ├── Neon (Postgres)
            ├── Redis Cloud (BullMQ queue)
            ├── Browserbase (headless chromium, browser-agent)
            └── Groq/Gemini/Mistral/OpenRouter (LLMs)
          Worker (BullMQ, your laptop OR Render w/ card)
            └── same Neon + Redis Cloud
```

| Service  | Provider                       | Free tier              | What                                       |
| -------- | ------------------------------ | ---------------------- | ------------------------------------------ |
| Frontend | **Vercel**                     | hobby (perm free)      | React SPA + /api proxy → Render            |
| API      | **Render**                     | free web (sleeps idle) | Fastify, all routes                        |
| DB       | **Neon**                       | free 0.5GB             | Postgres + pgvector                        |
| Queue    | **Redis Cloud**                | free 30MB              | BullMQ (raw TCP — Upstash REST won't work) |
| Browser  | **Browserbase**                | trial                  | browser-agent CDP                          |
| LLMs     | Groq/Gemini/Mistral/OpenRouter | free                   | council, agent, chat                       |

**Live URLs (current):**

- Frontend: `https://nexus-api-three-kappa.vercel.app/chat`
- API: `https://nexus-api-8xr0.onrender.com`

---

## DEPLOY ORDER (dependencies first)

### 1. Neon (Postgres) — first, everything needs DB

1. https://neon.tech → new project → copy **pooler** connection string (`postgresql://...-pooler...?sslmode=require&channel_binding=require`)
2. Migrate:
   ```bash
   cd packages/db
   export DATABASE_URL="<neon-pooler-url>"
   pnpm run db:migrate
   ```

### 2. Redis Cloud — BullMQ queue (MUST be raw TCP, not REST)

1. https://redis.com/try-free → new free DB (30MB)
2. Config page → copy **public endpoint** `host:port` + **default password**
3. Build URL: `redis://default:<password>@<host>:<port>`
4. (optional) set eviction policy → `noeviction` in DB config (BullMQ prefers it; volatile-lru works w/ warning)
   - ⚠️ Upstash free = REST-only, **won't work** for BullMQ. Render Redis = internal-only. Redis Cloud = only free raw-TCP option.

### 3. Browserbase — browser-agent engine

1. https://browserbase.com → API key
2. `BROWSER_CDP_URL=wss://connect.browserbase.com?apiKey=<key>`
   - Alt: Steel.dev (`ste-...` key) — set BROWSER_CDP_URL to Steel wss.

### 4. Render (API) — Docker web service

1. https://dashboard.render.com → New → Web Service → connect repo `Yash-Awasthi/Nexus`
2. Settings:
   - Branch: **claudecode**
   - Runtime: **Docker**, Dockerfile path: `./apps/api/Dockerfile`, context: `.`
   - Health check: `/health`
   - Plan: Free
3. **Env vars** (Environment tab) — set ALL below (§ENV VARS).
4. Deploy. Build ~5min (compiles 75 pkgs via topo build). Wait `live`.
5. Verify: `curl https://<your-api>.onrender.com/health` → 200. `curl .../api/v1/drive/status` → 401 (auth-gated = new code).

### 5. Vercel (frontend)

1. https://vercel.com → import repo `Yash-Awasthi/Nexus`, branch **claudecode**
2. `vercel.json` auto-configures: build `pnpm --filter @nexus/ui build`, output `apps/ui/build/client`, proxies `/api/*` → Render.
3. **Edit `vercel.json` rewrites** → point to YOUR new Render URL (currently `nexus-api-8xr0.onrender.com`).
4. Deploy.

### 6. Worker (BullMQ) — async jobs (agent.run, council, feeds, drive-exec)

**Free path = run on laptop** (Render/Railway background workers need a card):

```bash
cd /home/yash/Nexus
pnpm --filter "@nexus/worker..." build       # first time only
node --env-file=.env apps/worker/dist/index.js
```

Keep terminal open. `.env` must have REDIS_URL (Redis Cloud) + DATABASE_URL (Neon) + keys.
Verify log: `worker.ready` + `job.completed`.

**With card** → Render: New → Background Worker → repo, branch claudecode, Dockerfile `./apps/worker/Dockerfile`, same env vars.

Browser-agent + chat + auth work WITHOUT worker (run sync in API). Worker only for queued async jobs.

---

## ENV VARS (set on Render API + worker .env)

**Critical (app crashes without):**

```
DATABASE_URL=<neon-pooler-url>
REDIS_URL=<redis-cloud redis://...>
NEXUS_API_KEY=<64-hex>            # openssl rand -hex 32
NEXUS_JWT_SECRET=<64-hex>         # MUST be NEXUS_JWT_SECRET (not JWT_SECRET)
NEXUS_SECRETS_KEY=<64-hex>        # encrypts BYOK keys at rest
NEXUS_AUDIT_KEY=<64-hex>
NODE_ENV=production
PORT=10000                        # Render API
HOST=0.0.0.0
```

**LLM / features:**

```
GROQ_API_KEY=<...>                # council + browser-agent loop (llama-3.3-70b)
ANTHROPIC_API_KEY=<...>
GEMINI_API_KEY=<...>
MISTRAL_API_KEY=<...>
OPENROUTER_API_KEY=<...>
DEEPSEEK_API_KEY=<...>
TAVILY_API_KEY=<...>             # deep-research
BROWSER_CDP_URL=<browserbase wss> # browser-agent
STRIPE_SECRET_KEY=<sk_test_...>   # billing (test mode)
```

**Generate the 4 NEXUS \*\_KEY/secrets:** `openssl rand -hex 32` (one each).

⚠️ **Env NAME gotcha:** code reads `NEXUS_JWT_SECRET`, `NEXUS_SECRETS_KEY` — NOT `JWT_SECRET`/`SCRYPT_SECRET`. Use exact NEXUS\_ names.

---

## GOTCHAS (bugs already fixed in claudecode — don't reintroduce)

1. **Build order**: Dockerfiles use `pnpm --filter "@nexus/api..." build` (topo). Don't hand-order — `runtime` needs `agent-runtime` built first.
2. **scrypt**: auth needs `maxmem` set (32768 N exceeds OpenSSL default) — already in auth-users.ts.
3. **ESM**: runtime/bootstrap.ts uses `import.meta.url` not `require.main` (ESM pkg).
4. **Redis**: BullMQ needs raw TCP `redis://` — Upstash REST fails (ECONNRESET/EHOSTUNREACH).
5. **video-transcript**: unused pkg, removed from API deps. Don't re-add to Dockerfile.
6. Render free: web services only (no background_worker without card).

---

## VERIFY DEPLOY (smoke test)

```bash
B=https://<your-api>.onrender.com
curl $B/health                                    # 200
# register → JWT
EM="t$(date +%s)@x.co"
TOK=$(curl -s -X POST $B/api/v1/auth/register -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EM\",\"password\":\"Test12345!\",\"name\":\"t\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
# browser-agent (needs Browserbase + worker not required, runs sync)
curl -s -X POST $B/api/browser-agent/tasks -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' \
  -d '{"task":"page heading?","startUrl":"https://example.com"}'
# expect: status completed, result "Example Domain", screenshot bytes
```

---

## API SERVICE IDS (for CLI/API ops — regenerate when redeploying)

- Render API svc (current): `srv-d8qijfm8bjmc738p8u90`, owner `tea-d7n6tk1o3t8c73eh0rh0`
- Vercel project (current): `prj_zwkcmZqDohI5GsKI7YziUtGJj5xF`, repoId `1266057168`
- Render env-var API: `PUT https://api.render.com/v1/services/<svc>/env-vars/<KEY>` body `{"value":"..."}`
- Render trigger deploy: `POST .../services/<svc>/deploys` body `{"clearCache":"clear"}`
- Render build logs: `GET https://api.render.com/v1/logs?ownerId=<owner>&resource=<svc>&type=build&limit=200&direction=backward`

---

## FAST REDEPLOY CHECKLIST (interview day)

- [ ] Neon DB up + migrated
- [ ] Redis Cloud DB up, `redis://` URL ready
- [ ] Browserbase key valid
- [ ] Render API: env vars set, deploy live, /health 200
- [ ] Vercel: rewrites point to Render URL, deployed
- [ ] Worker running (laptop terminal) — only if demoing async jobs
- [ ] Smoke test passes (register + browser-agent)
