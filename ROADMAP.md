<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS — Roadmap

Forward-only execution spec. Every item is concrete and fork-free — no "decide A or B" is left to
the executor; open decisions are either resolved below or listed under **Blocked** / **Not
scheduled**. Facts (paths, package names, what already shipped) are current as of **2026-07-02** —
**do not re-audit the codebase to confirm them; act on them.** Read the git log only if an item
looks already-done.

> **Nexus is free/open** — no paid tier, no payment provider. "billing"/"quota" below = BYOK
> spend-guards on the user's own keys, never charging for Nexus. SaaS/Stripe items are struck.

---

## Execution protocol (read once, then follow)

**How to work**

- **Inline only. No workflows, no subagents, no parallel fan-out.** Do every item yourself with
  Read / Edit / Bash in the main loop. (Subagent bursts trip the 5-hour spend cap and stall.)
- **One item per commit.** Scope to a single package: `pnpm --filter @nexus/<pkg> typecheck` and
  the item's tests. Never whole-repo unless the item is explicitly cross-cutting.
- Follow **Order of work** below. Do items top-to-bottom; skip only a `Blocked`/`Gate` item until
  its precondition is met, and move to the next.
- Build against mocks (`MockTransport`, injectable `TokenHttp`/`fetchFn`). **Any live outbound
  call (provider key, OAuth token exchange, MCP `/test`) is `Gate` — do not run it without
  explicit user go.**

**Checkpoint = commit** (auto-commit is pre-approved for roadmap items)

1. Item's package `typecheck` + tests green → commit immediately.
2. Conventional Commit, scoped, reference the section:
   `feat(api): wire AccountPool into gateway dispatch (§4.1)`.
3. Author = `Yash-Awasthi <yashawasthi12032006@gmail.com>`. **No `Co-Authored-By` trailer** — add it
   (`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`) **only** for CI fixes /
   error corrections.
4. **Branch off `main`. Never push. Never open a PR.**
5. Stage explicit paths — **never `git add -A`**. **Never stage** `.claude/settings.json` or
   `.directory`.
6. After committing, update PROGRESS.md (see format below), then start the next item.

**Build/test rules (save yourself the retries)**

- `pnpm --filter @nexus/<pkg> test` may print "No test files found" — run
  `pnpm exec vitest run <path>` from repo root instead.
- `apps/api` route tests are excluded from the root include: `cd apps/api && pnpm exec vitest run
  tests/routes/<f>.test.ts` (or `pnpm --filter @nexus/api test`).
- `apps/api` + `apps/worker` consume built `dist`. After editing a package's `src`, run
  `pnpm --filter @nexus/<pkg> build` before the app typecheck sees it.
- `turbo` is not on PATH — always `pnpm --filter`.
- Migrations: `packages/db/migrations/`, **next free number `0013`** (a duplicate `0010` exists).
  Hand-write the SQL + a schema file in `packages/db/src/schema/` + its index export.
  `drizzle-schema.ts` is the stale drizzle-kit bundle — do not mirror it.
- New env var → add to `.env.example` with a comment. SPDX `Apache-2.0` header on every new file
  (`pnpm check:headers`). Secrets/tokens never logged.

---

## PROGRESS.md format (the resume file this pairs with — gitignored, overwrite freely)

Keep PROGRESS.md to this shape; rewrite it on each checkpoint. Compact by design.

```markdown
# NEXUS — Progress (resume state; gitignored)
Branch: <feat/...> (off main; committed, never pushed)
Updated: <YYYY-MM-DD>

## Now
<the single item in progress + exactly where you stopped>

## Next (ordered item IDs from ROADMAP "Order of work")
1. <id> <title>
2. ...

## Shipped this session (newest first)
- <hash> <id> — <one line: what + key file>

## Blocked / needs user go
- <item id> — <what external action or decision is required>

## Gotchas (carry forward — only non-obvious ones)
- <build/test quirk that bit you>
```

---

## Order of work

Near-term, in priority order (then continue in section order):

1. **§4.1** wire `AccountPool` into dispatch — activates already-written pool + vault + routes.
2. **§8.1** Drive isolation spike (decision gate for all of §8).
3. **§5.1** usage-analytics UI (last piece of the metering loop).
4. **§9.1 → §9.2** extend pinned-fetch to remaining sinks, then clear CodeQL alerts.
5. Then §2 → §3 → rest of §4 → §6 → §7 → rest of §8 → rest of §9 → §10 → §11 → §12 → §13, with
   §14/§15 as long-horizon tracks.

Item legend: **Files** = touch these · **Do** = the change · **Done** = acceptance check ·
**Gate** = needs explicit user go (live call / external action).

---

## 1. LLM provider breadth

Baseline: `@nexus/llm-drivers` = ~48 native drivers + `nexus/omni` sidecar; `provider-registry`
has the models.dev importer (`modelsDevToDefinitions`/`registerFromModelsDev`/`fetchModelsDev`).

- **1.1 ERNIE tool-calling.** Files: `packages/llm-drivers/src/index.ts` (`BaiduErnieDriver`). Do:
  map `functions` request/response (currently text-only). Done: tool round-trip passes with `MockTransport`.
- **1.2 Dify SSE + threading.** Files: `packages/llm-drivers/src/index.ts` (`DifyDriver`). Do: add
  streaming + `conversation_id` threading (currently blocking-only). Done: streamed chunks + threaded follow-up in tests.
- **1.3 Aux provider gaps.** Files: `packages/{image-gen,voice,reranker,retrieval,search-orchestrator}/src`.
  Do: fill remaining providers per each package's adapter interface (image flux/stability/recraft/fal/comfyui;
  voice elevenlabs/deepgram/cartesia/assemblyai; embeddings voyage/jina/cohere; search exa/brave/serper).
  Done: each new provider has a unit test.
- **1.4 Custom-driver framework.** Files: `packages/llm-drivers/README.md` + a template driver. Do:
  document the `BaseDriver` seams (`chatCompletionsUrl`/`authHeaders`) so a new driver needs no core edits.
  Done: README + template compile as a standalone driver.
- **1.5 models.dev seed** *(fork resolved: DB-backed, no startup network)*. Files: new migration `0013`
  + `provider_models` schema + `apps/cli/src/index.ts`. Do: `nexus models seed [--file <path>]` imports via
  `registerFromModelsDev` and upserts to `provider_models`; registry loads from the table at boot.
  Done: seed populates the table; boot reads it; no network call at startup.

## 2. Format-translation matrix — `@nexus/llm-translate`

Baseline: canonical hub scaffolded (`CanonicalRequest`, `normalize`/`denormalize`/`translate`) but
only `openai`+`anthropic` formats, **unwired**. All files: `packages/llm-translate/src/index.ts`
unless noted.

- **2.1 Add formats.** Do: to/from-canonical for `gemini`, `vertex`, `responses`, `ollama` (N+N).
  Done: golden-file test per format (same logical request → exact wire bytes).
- **2.2 Format-agnostic concerns.** Do: tool-call mapping, thinking/reasoning, finish-reason, usage,
  modality, image across all formats. Done: covered by the golden files.
- **2.3 Streaming.** Do: chunk translation (SSE deltas, tool-call partials, thinking blocks). Done:
  streaming golden test passes.
- **2.4 Wire into gateway.** Files: `packages/gateway/src`, `apps/api/src/routes/gateway.ts`. Do:
  replace the bespoke Anthropic↔OpenAI translate. Done: existing gateway tests pass unchanged.

## 3. Token compression — `@nexus/llm-compress`

Baseline: TOON encoder + lossless filters + `compressAuto` + tool-name→filter router; wired into
the agent hot-path and the gateway proxy (opt-in `x-nexus-compress`).

- **3.1 Heavy lossy mode** *(fork resolved: opt-in, off by default)*. Files:
  `packages/llm-compress/src/index.ts` + `package.json`. Do: gate behind `NEXUS_LLMLINGUA=1`, lazy
  `import('@atjsh/llmlingua-2')`, list it in `optionalDependencies` (not installed by default);
  document the 57 MB–2.2 GB model download. Done: gated path unit-tested with the import mocked;
  default path untouched.

## 4. Provider OAuth + accounts — `@nexus/llm-oauth`, `@nexus/llm-accounts`

Baseline: framework + AES-256-GCM vault + dedup refresh + Google Vertex provider; `oauth_credentials`
(mig `0012`) + `OAuthTokenStore` + drizzle adapter (`apps/api/src/lib/oauth-token-store.ts`); the
`/llm-oauth/*` login/callback/revoke routes (`apps/api/src/routes/llm-oauth.ts`); `AccountPool`
(tier-ladder `pick()` + health/cooldown/circuit-breaker). Sanctioned third-party OAuth only.

- **4.1 Wire `AccountPool` into dispatch.** Files: `apps/api/src/routes/gateway.ts` + driver dispatch.
  Do: call `AccountPool.pick()`, then resolve creds via `store.resolveFresh(userId, provider)` →
  `toDriverCredentials()` → driver. Done: dispatch picks a healthy account; cooldown/breaker exercised
  in a unit test; OAuth creds resolve to the vertex driver.
- **4.2 More OAuth providers.** Files: `packages/llm-oauth/src/providers.ts`. Do: add `azure-openai` /
  `github-models` **only** when a documented third-party auth path exists; else keep `supported:false`
  with a TODO reason. Done: catalog matches reality; nothing half-built.
- **4.3 OAuth live E2E** *(Gate)*. Do: unit-test `completeLogin`/`refresh`/`revoke` with mocked
  `TokenHttp`. Live run needs the operator's registered OAuth app + redirect URI (external, one-time) —
  do not attempt without user go. Never log token-exchange bodies.

## 5. BYOK spend-guard & usage metering — `@nexus/billing`

Baseline: cost model + `BillingLedger` + priced `usage_events` (mig `0010`) + `api_keys.monthly_cost_cap_usd`;
gateway path is metered (`_resolveBillingKey` → `check(estimateMaxCost)` → `recordUsage`).

- **5.1 Usage-analytics UI.** Files: new `apps/ui/app/routes/usage.tsx` + a read API over `usage_events`.
  Do: render month-to-date cost + per-model/day token & cost split. Done: page shows the breakdown against the cap.

## 6. Multi-agent orchestration — `@nexus/agent-orchestrator`

Baseline: worktree fan-out → score → winner-merge (merge OFF) + `orchestration.run` handler
(`apps/worker/src/handlers/orchestration-handler.ts`).

- **6.1 Persist state.** Files: migration `0013+` (`orchestration_runs`) + the handler. Do: store
  run/candidates/scores/status; resume on worker restart. Done: a run survives a simulated restart.
- **6.2 Compare/merge UI.** Files: new `apps/ui` route. Do: diff per candidate; manual or scored
  winner select; merge stays opt-in. Done: candidates diffed, winner selectable.
- **6.3 Checkpoint/resume + gate.** Do: durable checkpoints + evidence-first verification gate before
  merge. Done: resume-from-checkpoint test; merge blocked until the gate passes.

## 7. Coding-agent harness — `@nexus/agent-runtime`

Baseline: tool-use loop + full `RuntimeToolSet` bridges (fs/edit/run_command/mcp) + `agent.run` job +
worker→API SSE relay (`agent-events.ts` → Redis → `agent-events-bridge.ts`/`sse.ts`) + PTC
Worker-thread sandbox (`ptc-sandbox.ts`) + `nexus code` CLI.

- **7.1 Sessions/permissions/compaction.** Files: `packages/agent-runtime/src/index.ts`,
  `apps/worker/src/handlers/agent-handler.ts`. Do: two-tier permission gate (read auto-allow; mutating
  via `GovernanceEngine` on the event bus); context compactor (budget 200k, compact @80%, hard @95%,
  keep last 10 turns, images flat ~1.6k); session persist/resume by `SessionStatus`. Done: gate blocks
  an unapproved mutating tool; compactor trims at threshold; session resumes.
- **7.2 Full PTC wiring.** Files: `packages/agent-runtime/src/{ptc-sandbox,index}.ts`. Do: bridge the
  tool layer to the sandbox child over local RPC; only stdout returns to context. Done: a PTC script
  calls a tool via RPC and only stdout re-enters context.
- **7.3 Forked learning loop.** Do: propose `MEMORY.md` / skill updates off a warm cache/digest. Done:
  emits a diff proposal; applies nothing without approval.
- **7.4 CLI `--local`** *(Gate)*. Files: `apps/cli/src/index.ts`. Do: in-process agent loop over the
  `RuntimeToolSet`. Needs a live provider key — gated.

> g0dm0d3 is AGPL — ideas only, clean-room, never copy source.

## 8. Nexus Drive — per-user sandboxed CLI + storage (flagship)

**Spec (locked, do not re-decide):** Firecracker microVM primary; fallback order gVisor → Docker-limits.
FS-level 512 MB quota (loopback ext4 or XFS project quota) at `/workspace`; soft-warn ~90% (~460 MB) +
bounded grace, then hard-block. 30-day idle reclaim (warn first; track `lastActiveAt`). User supplies
their own LLM key via `.env` in `/workspace` (NOT BYOK injection); seed `.env.example`; never log it;
exclude from backups/exports. Persistent volume + ephemeral compute; per-sandbox CPU/RAM/PID/wall-clock
caps; egress policy-gated.
Baseline: `@nexus/sandbox` (`child_process` + Docker runner w/ cpu/mem/PID caps) + `/drive/*` routes
(`apps/api/src/routes/drive.ts`: status+quota, exec, ls, upload w/ 413, delete) behind auth + rate
limits, **app-level** 512 MB cap.

- **8.1 Isolation spike** *(Gate — do FIRST in §8; decision gate for the rest).* Do: boot a Firecracker
  microVM + prove FS-level 512 MB quota end-to-end on the dev host (`/dev/kvm` present). Throwaway; record
  outcome in PROGRESS. If Firecracker fails documented KVM/jailer checks → gVisor systrap; Docker-limits is
  the interim. No production isolation code until it passes.
- **8.2 FS-level quota.** Files: `apps/api/src/routes/drive.ts` + sandbox mount. Do: replace app-level
  accounting with loopback-ext4/XFS-project quota. Done: a write past 512 MB hard-fails at the FS layer.
- **8.3 Schema.** Files: migration `0013+`, `drive_workspaces` (userId, volumePath, quotaBytes,
  lastActiveAt, state). Done: provision/teardown persists a row.
- **8.4 Lifecycle worker.** Files: new `apps/worker` handler. Do: BullMQ job for provision + 30-day
  idle-reclaim cron (warn first) + quota sweep; Prometheus metrics; backup/export endpoint. Done: reclaim
  + sweep run on schedule.
- **8.5 UI.** Files: `apps/ui/app/routes/sandbox.tsx`. Do: terminal + drive panel; seed `.env.example`
  into fresh workspaces; quota meter with soft-warn. Done: file ops + quota meter work.
- **8.6 Hardening.** Do: clear the drive/sandbox CodeQL alerts in `.cleanup-alerts.txt` (path-injection,
  command-injection, http-to-file, insecure-temp, missing-rate-limiting); egress allowlist (deny by
  default); never log `.env`; runaway limits. Done: those alerts cleared; egress denied by default.

## 9. Security hardening

Baseline: SSRF filter + resolve-then-pin (`packages/runtime/src/security-utils.ts`:
`isSafeUrl`/`safeLookup`/`makeSafeLookup`) + `apps/api/src/lib/pinned-fetch.ts` (used by MCP `/test`) +
identity-keyed per-user rate limiting.

- **9.1 Extend pinned-fetch.** Do: route the remaining outbound native-`fetch` sinks through
  `pinned-fetch.ts`. Done: an outbound call to a host that resolves to a private IP is rejected.
- **9.2 Clear CodeQL alerts.** Files: per `.cleanup-alerts.txt` (drive/sandbox injection, api-bridge
  reflected-XSS, weak password hash in `crypto-utils.ts`, path-injection, missing rate-limiting). Done:
  the alert list is empty.
- **9.3 Rate-limit remaining route groups.** Done: each authenticated group buckets by identity.
- **9.4 Docker sandbox hardening.** Files: `packages/sandbox/src/index.ts` (Docker runner). Do: seccomp
  profile + read-only rootfs + user-namespace remapping. Done: container runs with all three.
- **9.5 apps/api baseline.** Do: output sanitize + prompt-injection guard. Done: guard rejects a known
  injection payload in a test.

## 10. UI surfaces over existing backends

Baseline: backends complete; `@xyflow/react` installed.

- **10.1 Prompt version drawer.** Files: `apps/ui/app/routes/prompts.tsx` (backend + mig `0009` exist).
  Do: list versions, view read-only, restore = new version. Done: restore creates a new version.
- **10.2 Build-task DAG.** Files: `apps/ui/app/routes/build.tsx`. Do: Board↔Graph toggle, render
  `parentId` edges with `@xyflow/react`, reuse `TaskDetailPanel`; orphan `parentId` → root (log). Done:
  graph renders parent→child edges.
- **10.3 MCP servers UI.** Files: new `apps/ui/app/routes/mcp-servers.tsx` modeled on `provider-keys.tsx`
  over `mcp_servers` CRUD + `/test`. Done: CRUD + test-connection work.
- **10.4 Workflow picker polish.** Files: `apps/ui/app/routes/workflows.tsx` + `@lobehub/icons` (new dep).
  Do: provider/model icons; feed models.dev metadata into the picker. Done: icons render.
- **10.5 Medium-term pages** (each its own item; backends already mature): voice (`voice.tsx`), image-gen
  Sandbox tab, knowledge-graph viz, prediction-markets dashboard, gauntlet benchmark, RLHF thumbs →
  `rlhf-pipeline`, eval-runner UI.

## 11. Memory upgrade — `packages/memory` (library-only)

- **11.1** Files: `packages/memory/src/index.ts`. Do: entity linking + temporal reasoning + multi-signal
  fusion (BM25+vector+entity, single-pass) à la mem0; self-editing typed blocks (human/persona/scratch)
  à la letta. Done: fusion retrieval + typed-block edit unit-tested.

## 12. MCP breadth + A2A (last / optional)

- **12.1** Cherry-pick missing MCP tools (sandboxed, no unscoped capability).
- **12.2** A2A JSON-RPC-over-SSE (authn'd, no impersonation).
- **12.3** Optional `mcp-compressor` to shrink tool manifests 60–95%.

## 13. Domain feeds — `@nexus/domain-feeds`

Baseline: ~26 adapters live (`packages/domain-feeds/src/index.ts`).

- **13.1 Port-congestion source.** Do: verify a live keyless source, then add the adapter. Done: adapter + test.
- **13.2 AIS vessel-name enrichment.** Files: `MaritimeFeed`. Do: enrich via Digitraffic `/vessels`. Done:
  names attached to incidents.
- **13.3 Dark-web sources** *(Gate — legal review before any code).*

## 14. Production multi-tenant hardening (mostly external infra; scaffolding in `infra/`)

Each done when its infra is provisioned + configured (many are Blocked, see table): DB (PgBouncer,
read replicas, PITR, encryption at rest); Auth (RS256 JWT multi-service, OAuth device flow for CLI,
session revocation + audit, brute-force backoff); Observability (OTel tracing, SLO dashboards,
alerting, per-tenant cost attribution); Infra (K8s HPA `infra/k8s`, multi-AZ PG/Redis, CDN, edge
DDoS); Compliance (SOC2, GDPR residency + deletion, no-LLM-data-logged); Coverage (tests → 80%+
across `council`, `memory`, `runtime`).

## 15. Long-term / ambitious

~~Multi-tenant SaaS / Stripe~~ (struck). Plugin marketplace (`plugin-sdk` → hosted registry,
Deno-isolate sandbox), federation (cross-instance delegation, federated council, CRDT KG sync,
OIDC/SAML), fine-tuning pipeline (SFT via `sft-tagger` + `corpus-builder`), agentic browser
(`stealth-browser`), desktop (Electron + offline worker), mobile (React Native + push).

---

## Blocked on external infra (not solvable in code)

| Task                      | Blocker                                                       |
| ------------------------- | ------------------------------------------------------------ |
| Firecracker microVM spike | ~~KVM host~~ — `/dev/kvm` present on dev host; doable locally |
| gVisor fallback testing   | Linux host with `runsc`                                      |
| Docker sandbox e2e        | Docker daemon on the worker host                             |
| Redis cluster rate-limit  | Upstash / managed Redis                                      |
| PgBouncer pooling         | DB admin                                                     |
| K8s HPA deploy            | K8s cluster (chart in `infra/k8s/`)                          |
| Grafana dashboards        | Grafana instance (configs in `infra/grafana/`)               |
| Provider OAuth app reg    | Google/GitHub dev consoles for client IDs                    |

## Not scheduled (revisit only if the blocker clears)

- **GCF encoder** (§3) — no defined spec/acronym; nothing to build until one exists.
- **Bailian native `/api/v1` envelope** (§1) — only needed for Qwen-only extras; OpenAI-compatible
  mode covers current use.

## Reference note

`nexus/omni` can front any self-hosted OpenAI-compatible router to inherit a large provider catalog
with zero native driver work. Fine for dev/self-host; for production prefer native ports (§1–§3) over
shipping the sidecar as a silent hard dependency.
