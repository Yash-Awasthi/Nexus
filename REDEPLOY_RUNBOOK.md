# REDEPLOY_RUNBOOK.md — Nexus fast redeploy runbook

> For interviews/demos. Trials deplete → use this to rebuild the live stack fast.
> Repo: `https://github.com/Yash-Awasthi/Nexus` · Branch: **`main`** · ~5 services, all free-tier.
>
> For the general environment-variable reference and other deployment options
> (Docker Compose, Kubernetes, Terraform), see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
> This file only covers the concrete step-by-step rebuild of the specific live stack above.

---

## ARCHITECTURE (what runs where)

```
Browser → Vercel (static React SPA)
            │  /api/* proxied →
            ▼
          Railway (Fastify API, Docker — service nexus-api)
            ├── Neon (Postgres)
            ├── Redis Cloud (BullMQ queue)
            ├── Browserbase (headless chromium, browser-agent)
            └── Groq/Gemini/Mistral/OpenRouter (LLMs)
          Railway (BullMQ worker — service nexus-worker)
            └── same Neon + Redis Cloud
```

| Service  | Provider                       | Free tier              | What                                       |
| -------- | ------------------------------ | ---------------------- | ------------------------------------------ |
| Frontend | **Vercel**                     | hobby (perm free)      | React SPA + /api proxy → Railway           |
| API      | **Railway**                    | trial credit           | Fastify, all routes (service `nexus-api`)  |
| Worker   | **Railway**                    | trial credit           | BullMQ async jobs (service `nexus-worker`) |
| DB       | **Neon**                       | free 0.5GB             | Postgres + pgvector                        |
| Queue    | **Redis Cloud**                | free 30MB              | BullMQ (raw TCP — Upstash REST won't work) |
| Browser  | **Browserbase**                | trial                  | browser-agent CDP                          |
| LLMs     | Groq/Gemini/Mistral/OpenRouter | free                   | council, agent, chat                       |

**Live URLs (current):**

- Frontend: Vercel project (see Vercel dashboard)
- API: `https://nexus-api-production-f80f.up.railway.app`
- Railway project: `airy-respect` (id `e05008a2-b2fc-4d18-b94c-138e19a86c3b`)

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

### 4. Railway (API + worker) — Docker services

1. https://railway.app → New Project → Deploy from repo `Yash-Awasthi/Nexus` (grant access).
   Railway auto-creates two services from the repo.
2. Service `nexus-api`:
   - Branch: **main**
   - Builder: **Dockerfile**, path `apps/api/Dockerfile`, root context `.`
   - Health check: `/health`
3. Service `nexus-worker`:
   - Builder: **Dockerfile**, path `apps/worker/Dockerfile`, root context `.`
4. **Shared variables** (project → Variables) — set ALL below (§ENV VARS) once; both services inherit.
5. Deploy. Build ~5min (compiles pkgs via topo build). Wait `Active`.
6. Verify: `curl https://<your-api>.up.railway.app/health` → 200. `curl .../api/v1/drive/status` → 401 (auth-gated = new code).

### 5. Vercel (frontend)

1. https://vercel.com → import repo `Yash-Awasthi/Nexus`, branch **main**
2. `vercel.json` auto-configures: build `pnpm --filter @nexus/ui build`, output `apps/ui/build/client`, proxies `/api/*` → Railway.
3. **Edit `vercel.json` rewrites** → point to YOUR Railway API URL (currently `nexus-api-production-f80f.up.railway.app`).
4. Deploy.

### 6. Worker (BullMQ) — async jobs (agent.run, council, feeds, drive-exec)

The `nexus-worker` Railway service (step 4) runs this. It shares the project's shared
variables — no separate config beyond the Dockerfile path `apps/worker/Dockerfile`.
Verify log: `worker.ready` + `job.completed`.

**Local alternative** (no worker service):

```bash
cd /home/yash/Nexus
pnpm --filter "@nexus/worker..." build       # first time only
node --env-file=.env apps/worker/dist/index.js
```

Browser-agent + chat + auth work WITHOUT worker (run sync in API). Worker only for queued async jobs.

---

## ENV VARS (set as Railway shared variables — both services inherit)

**Critical (app crashes without):**

```
DATABASE_URL=<neon-pooler-url>
REDIS_URL=<redis-cloud redis://...>
NEXUS_API_KEY=<64-hex>            # openssl rand -hex 32
NEXUS_JWT_SECRET=<64-hex>         # MUST be NEXUS_JWT_SECRET (not JWT_SECRET)
NEXUS_SECRETS_KEY=<64-hex>        # encrypts BYOK keys at rest
NEXUS_AUDIT_KEY=<64-hex>
NODE_ENV=production
PORT=3000                         # Railway sets $PORT automatically; app reads it
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

## GOTCHAS (bugs already fixed on main — don't reintroduce)

1. **Build order**: Dockerfiles use `pnpm --filter "@nexus/api..." build` (topo). Don't hand-order — `runtime` needs `agent-runtime` built first.
2. **scrypt**: auth needs `maxmem` set (32768 N exceeds OpenSSL default) — already in auth-users.ts.
3. **ESM**: runtime/bootstrap.ts uses `import.meta.url` not `require.main` (ESM pkg).
4. **Redis**: BullMQ needs raw TCP `redis://` — Upstash REST fails (ECONNRESET/EHOSTUNREACH).
5. **video-transcript**: unused pkg, removed from API deps. Don't re-add to Dockerfile.
6. Redis Cloud free = only free raw-TCP option (Upstash REST + Render internal Redis both fail for BullMQ).

---

## VERIFY DEPLOY (smoke test)

```bash
B=https://<your-api>.up.railway.app
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

## SERVICE IDS (for CLI/API ops — regenerate when redeploying)

- Railway project: `airy-respect` id `e05008a2-b2fc-4d18-b94c-138e19a86c3b` (services `nexus-api`, `nexus-worker`)
- Railway API: GraphQL `https://backboard.railway.app/graphql/v2`, mutation `variableUpsert` (needs an account/project token with write scope)
- Vercel project (current): `prj_zwkcmZqDohI5GsKI7YziUtGJj5xF`, repoId `1266057168`

---

## FAST REDEPLOY CHECKLIST (interview day)

- [ ] Neon DB up + migrated
- [ ] Redis Cloud DB up, `redis://` URL ready
- [ ] Browserbase key valid
- [ ] Railway shared vars set, `nexus-api` Active, /health 200
- [ ] Vercel: rewrites point to Railway URL, deployed
- [ ] `nexus-worker` Active (Dockerfile path `apps/worker/Dockerfile`) — only if demoing async jobs
- [ ] Smoke test passes (register + browser-agent)
