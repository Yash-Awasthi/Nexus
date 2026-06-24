# Future of NEXUS — Roadmap & Contribution Areas

This document captures what NEXUS could grow into, where contributions are most
needed, and how to scale the platform for real-world deployment. It is the single
forward-looking roadmap; completed work is summarised under **Recently shipped** for
context and then dropped.

_Last refreshed: 2026-06-22 (branch `claudecode`)._

---

## Recently shipped

These were open roadmap items now landed — kept here only as a changelog anchor:

- ✅ **User accounts / auth wiring** — email+password login wired end-to-end; the
  UI captures the JWT and attaches it to API calls (`authFetch`). A latent bug where
  user JWTs could never authenticate (middleware never received `jwtSecret`) is fixed.
- ✅ **Per-user BYOK key management** — provider keys are AES-256-GCM encrypted at
  rest in Postgres (`user_provider_credentials`), resolved **server-side only** with a
  strict policy (no env fallback on user LLM paths). New `/provider-keys` page to
  add/rotate/delete; all client-side plaintext keys removed from `localStorage`.
- ✅ **Conductor → runtime consolidation** — the duplicate `@nexus/conductor` package
  was deleted and its single consumer migrated to `@nexus/runtime`.
- ✅ **`pnpm dev:api` / `pnpm dev:ui`** — single-service dev scripts.
- ✅ **Crypto dedup** — AES-256-GCM primitives shared via `secret-crypto.ts`
  (`encryptWithKey`/`decryptWithKey`) instead of being copied across mfa/connectors.
- ✅ **Four LLM providers** — xAI/Grok, Together, Perplexity, Cohere drivers + full
  BYOK wiring (111 driver tests).
- ✅ **Scaffolds + devcontainer** — `pnpm scaffold:adapter` / `scaffold:driver`
  generators and a `.devcontainer/` for zero-setup Codespaces.

---

## Next up — flagship: Nexus Drive (per-user 512 MB sandboxed CLI)

A persistent, per-user 512 MB quota-capped workspace that runs our CLI (or an
allowlisted user-chosen CLI) in an isolated microVM, with shell + git scoped to
`/workspace`. **Design is locked** (`.claude/NEXUS_DRIVE_SANDBOX.md`); the build is
the next major effort. It is deliberately the one item that cannot be finished in a
quick pass — it needs a host with KVM and an isolation spike — so it is scoped here in
phases rather than rushed.

**Locked decisions (recap):** Firecracker microVM isolation (gVisor / Docker as
fallbacks); filesystem-level 512 MB quota (loopback ext4 / XFS project quota) with a
~90% soft-warn + brief grace then hard block; 30-day idle reclaim; user supplies their
own LLM key via a `.env` inside `/workspace` (NOT Nexus BYOK injection); persistent
volume + ephemeral compute.

**Phased build:**

- [ ] **Phase 0 — Isolation spike (throwaway).** Validate Firecracker + a 512 MB FS
      quota end-to-end on the target host; confirm KVM availability. Fall back to
      gVisor or Docker-with-limits if Firecracker is impractical. Decision gate before
      any production code.
- [ ] **Phase 1 — Storage + schema.** `drive_workspaces` table (userId, volumePath,
      quotaBytes, `lastActiveAt`, state). Per-user 512 MB volume provisioning +
      teardown; FS-level quota enforcement (tamper-proof, not app-level).
- [ ] **Phase 2 — Sandbox runtime package.** New `packages/sandbox` (or extend
      `@nexus/code-repl`): spin up an ephemeral microVM bound to the user's volume with
      CPU/RAM/PID/wall-clock caps and policy-gated egress.
- [ ] **Phase 3 — API + worker.** `/api/v1/drive/*` (create / exec / upload / ls /
      quota) behind `requireAuthWithTier`; a BullMQ job type in `apps/worker` for
      lifecycle (provision, idle-reclaim, quota sweep).
- [ ] **Phase 4 — UI.** Terminal + drive-management panel; `.env.example` seeded into
      fresh workspaces; quota meter with the soft-warn UX.
- [ ] **Phase 5 — Hardening.** Egress allowlist, secret-hygiene (never log `.env`),
      30-day idle warning + reclaim, abuse/runaway limits.

---

## Feature roadmap

### Near-term (good first contributions)

- [x] **Streaming Council responses** — `POST /council/deliberate/stream` (SSE) emits each
      model's vote as it lands then a final `done` event; engine/service take an optional
      `onVote` callback. UI client helper `streamCouncilDeliberation()` in `lib/api.ts`.
      (Backend verified with mocked transport — 3 new engine tests; UI page rewire to use
      it is a follow-up, since the current flow is electron-bridged.)
- [x] **Reconcile `language-models` page with BYOK** — the Language Models page
      (`apps/ui/app/routes/language-models.tsx`) now reads and writes the encrypted
      `/api/user/provider-keys` store via `authFetch`, so it shares one source of truth
      for keys with the `/provider-keys` page. Keys are write-only in the UI (the form
      never preloads the masked value; an empty key on edit keeps the stored one).
      Schema extended (migration `0008_provider_credentials_metadata`) with nullable
      `encrypted_key` + `base_url` + `models` columns so local/self-hosted connections
      (ollama, custom base URLs) and per-connection metadata persist. Backend POST does a
      metadata-only edit when no new key is supplied (carries over the existing
      key/prefix/hash).
- [ ] **Prompt versioning UI** — backend has `prompt_versions` table + routes; add a
      version-history drawer to the Prompts page.
- [ ] **Build task dependencies** — `parent_id` exists in `build_tasks`; add DAG
      rendering on the Build page.
- [ ] **MCP server registry** — UI to add/remove MCP servers (currently config-hardcoded).

### Medium-term

- [ ] **Voice interface** — wire `packages/voice/` TTS/STT to a push-to-talk UI with
      streaming transcription.
- [ ] **Image generation** — surface `packages/image-gen/` adapters as a Sandbox tab.
- [ ] **Knowledge graph UI** — visualise `packages/knowledge-graph/` (Leiden clustering,
      multi-hop BFS) with React Flow or D3.
- [ ] **Prediction markets dashboard** — build a markets page over the
      Polymarket/Kalshi/Metaculus backends in `packages/prediction-market/`.
- [ ] **Gauntlet UI** — a competitive model-benchmark page over `packages/gauntlet/`.
- [ ] **RLHF feedback loop** — thumbs up/down on council responses feeding
      `packages/rlhf-pipeline/`.
- [ ] **Eval runner UI** — run `packages/evals/` suites and view results.

### Long-term / ambitious

- [ ] **Multi-tenant SaaS** — org-level isolation, per-org quotas, Stripe billing.
- [ ] **Plugin marketplace** — publish custom adapters via `packages/plugin-sdk/` to a
      hosted registry.
- [ ] **Fine-tuning pipeline** — end-to-end SFT from conversation history using
      `packages/sft-tagger/` + `packages/corpus-builder/`.
- [ ] **Agentic browser** — a full browser-use agent over `packages/stealth-browser/`.
- [ ] **Mobile app** — React Native wrapper with push notifications on task completion.
- [ ] **Custom LLM driver framework** — document + simplify the `IProvider` interface so
      adding a provider doesn't require touching `packages/llm-drivers/` internals.

---

## New LLM providers to add

Each driver extends `OpenAICompatibleDriver` in `packages/llm-drivers/` (~12 lines for
OpenAI-compatible providers; use `pnpm scaffold:driver <name>` to start):

- [x] `xai` (Grok) — shipped
- [x] `together` (Together AI) — shipped
- [x] `perplexity` — shipped
- [x] `cohere` (via OpenAI-compat endpoint) — shipped
- [ ] `aws-bedrock` — enterprise Anthropic/Meta access (needs AWS SigV4 — custom driver)
- [ ] `azure-openai` — required for many enterprise customers (custom base URL + api-version)

---

## Domain feed sources to add

`packages/domain-feeds/` has 16 domains today. Additional sources:

- **Legislative tracking** — congressional bills, EU directives
- **Scientific preprints** — arXiv, bioRxiv
- **Earnings & SEC filings** — EDGAR, 8-K
- **Social signals** — Reddit, HN (rate-limited, respectful)
- **Dark web monitoring** — Tor-accessible sources (careful legal review required)
- **Supply chain** — shipping AIS data, port congestion

---

## Developer experience & code health

- [x] **Pay down UI lint debt** — the large route files (`chat.tsx`, `god-mode.tsx`,
      `settings.tsx`, `setup.tsx`, `root.tsx`, `language-models.tsx`) had ~155 `no-unsafe-*`
      / unused-import errors from untyped `fetch`/`JSON.parse` results. Typed the responses + dropped dead imports; all six now lint clean and commit through lint-staged normally.
- [x] `pnpm scaffold:driver <name>` — scaffold a new LLM driver
- [x] `pnpm scaffold:adapter <name>` — scaffold a new adapter package
- [x] `pnpm scaffold:feed <name>` — scaffold a new domain feed (appends a
      `FeedAdapter` subclass to domain-feeds; prints the registry-wiring reminder)
- [x] Pre-built Docker images on GHCR — `docker.yml` publishes api/worker/ingest/**ui**
      to GHCR on push to main + tags (built-in `GITHUB_TOKEN`, SBOM + provenance)
- [x] GitHub Codespaces devcontainer for zero-setup development (`.devcontainer/`)
- [ ] Improve test coverage toward 80%+ across core packages

---

## Hosting & infrastructure (reference)

### Current (free tier)

- API: Render (free — sleeps after 15 min idle, cold start ~30s)
- UI: Vercel (free)
- DB: Neon PostgreSQL (free — 512 MB storage, connection limits)
- KV: in-memory fallback (no Redis persistence)

### Recommended upgrades

| Layer        | Free → Paid                | What you unlock                                     |
| ------------ | -------------------------- | --------------------------------------------------- |
| **API**      | Render Starter ($7/mo)     | Always-on, no cold starts, persistent disk          |
| **API**      | Render Standard ($25/mo)   | 2 GB RAM, 1 CPU — concurrent agent workloads        |
| **DB**       | Neon Pro ($19/mo)          | More compute, larger storage, dev/staging branching |
| **DB**       | Supabase Pro ($25/mo)      | Managed pgvector, edge functions, built-in auth     |
| **KV/Queue** | Upstash Redis ($10/mo)     | Persistent BullMQ queues, multi-worker              |
| **UI**       | Vercel Pro ($20/mo)        | Analytics, higher bandwidth, team features          |
| **Sandbox**  | VPS with Docker ($6–15/mo) | Full DockerReplExecutor (and Nexus Drive host)      |

### Cloud deployment options

- **Railway** — one-click deploy; managed Postgres + Redis. Good starting point.
- **Fly.io** — fits the Fastify API; global edge, persistent volumes (~$5/mo small).
- **AWS ECS / GCP Cloud Run** — containerized, auto-scaling; see `infra/terraform/`.
- **Kubernetes** — full `infra/helm/nexus/` chart for GKE/EKS/bare-metal.

### Scaling notes

- **Connection pooling** — at >10 concurrent requests use PgBouncer or the Neon
  `-pooler` URL in `DATABASE_URL`.
- **Worker scaling** — run multiple `apps/worker` instances; tune `WORKER_CONCURRENCY`;
  split noisy domain-feed workers from task workers.
- **pgvector at scale** — tune `ivfflat.probes`; migrate to HNSW when available;
  partition memory tables past ~1M rows.
- **LLM cost control** — enable the `llm-cache` package; per-session token budgets;
  wire Prometheus cost metrics to alerting.
- **Ingest service** — run `services/ingest/` as its own container with a Celery pool
  and dead-letter queues for failed feed jobs.

---

## Contributing

See `CONTRIBUTING.md` for code standards, branch strategy, and the PR template.
Highest-leverage areas right now:

1. **Nexus Drive Phase 0 spike** — the flagship; unblocks the biggest feature.
2. New LLM driver adapters (each ~150 lines, well-tested pattern).
3. UI pages for existing backend features (Gauntlet, Knowledge Graph, Evals).
4. Paying down UI lint debt and raising test coverage for `packages/council/`,
   `packages/memory/`, and `packages/runtime/`.
