<!-- SPDX-License-Identifier: Apache-2.0 -->

# EXAMINE — Codebase research for the ROADMAP rewrite

> Ground-truth survey of the codebase gathered before rewriting ROADMAP.md for a
> **low-effort inline executor** (Opus/Sonnet at low reasoning effort — no subagents, no
> parallelism, no workflows). Every claim below was verified against source/git, not the
> roadmap. **Do not re-audit these facts; act on them.**

---

## 0. Executor constraints (how the rewritten roadmap must read)

- Executor works **inline only**: one item at a time, one item per commit, checkpoint-commit
  cadence per ROADMAP's Execution protocol (standing commit approval for roadmap items only).
- Each item must carry: exact file paths, exported symbol names to touch, the pattern to
  mirror (existing file:symbol), exact test command, and a mechanical "Done" check.
- Commit rules: author `Yash-Awasthi <yashawasthi12032006@gmail.com>` (author = committer),
  no `Co-Authored-By` trailer except CI/bug fixes, branch off `main`, never push/PR unasked,
  stage explicit paths (never `git add -A`), never stage `.claude/settings.json` / `.directory`.
- Any **live outbound call** (provider key, OAuth token exchange, MCP /test) is a Gate — stop
  and ask the user.

## 0.1 Build/test gotchas (repeat verbatim in the roadmap)

- `turbo` not on PATH — use `pnpm build` / `pnpm --filter @nexus/<pkg> <script>`.
- If vitest says "No test files found": run `pnpm exec vitest run <path>` from the package dir.
- `apps/api` route tests run under `cd apps/api` (its own vitest config).
- `apps/api` / `apps/worker` consume built `dist` — after editing a package's `src`, run that
  package's `build` before an app typecheck sees the change.
- Migrations: next free number is **`0013`** (a duplicate `0010` exists — do not reuse).
- New env vars → add to `.env.example`.
- Every new source file needs the SPDX header (`pnpm check:headers` verifies).
- Current branch: `feat/provider-breadth-compress-billing`. PROGRESS.md (gitignored) is the
  Now/Next/Shipped resume pointer.

---

## §1 LLM drivers — `packages/llm-drivers/src/index.ts` (~2276 lines, ~48 drivers)

**Architecture:**

- `LlmDriver` interface; `BaseDriver` (SSE via `sseLines`, NDJSON via `ndjsonLines`,
  `_useDefaultTransport` flag); `OpenAICompatibleDriver` with override seams
  `chatCompletionsUrl()` and `authHeaders()`.
- Transports: `HttpTransport` (real), `MockTransport` with `setResponses([...])` queue —
  **all driver tests mirror this mock pattern**.
- `DriverRegistry` maps provider id → driver; `probeLocalModel` for local runtimes.

**Drivers present:** Anthropic, Groq, DeepSeek, Mistral, OpenRouter, Gemini, Ollama, LMStudio,
LlamaCpp, Fireworks, NvidiaNim, Cerebras, Kimi, Codestral, Xai, Together, Perplexity, Cohere,
~15 one-liner OpenAI-compat subclasses, Azure, Cloudflare, Xinference, Replicate,
**BaiduErnieDriver** (tool-calling functions↔function_call translation **shipped**),
**AlibabaBailianDriver**, **DifyDriver** (blocking-only — no SSE, no threading),
Bedrock (SigV4), Vertex.

**STALE roadmap state (verified in git):**

- §1.1 ERNIE tool-calling — **already shipped** (commit `9f64238`).
- Bailian + Dify base drivers — **already shipped** (commit `a4e278d`).
- Remaining §1 work: **Dify SSE streaming + conversation threading** only (enhancement to
  the existing `DifyDriver`).

## §2 Format translation — `packages/llm-translate/src/index.ts` (303 lines)

- Hub-and-spoke canonical form: `CanonicalRequest`, `normalize` / `denormalize` / `translate`.
- `Format = "openai" | "anthropic"` only; extension point = `NORMALIZERS` / `DENORMALIZERS` maps.
- §2.1: add `gemini`, `vertex`, `responses` (OpenAI Responses API), `ollama` formats — each is
  a normalizer+denormalizer pair added to the two maps + `Format` union.

## §3 Compression — `packages/llm-compress/src/index.ts` (400 lines)

- `encodeStructured` (TOON/json), filters (`stripAnsi`, `trimTrailing`, `collapseBlankLines`,
  `dedupConsecutive`), `smartTruncate`, `compress` / `compressAuto` / `compressForTool`,
  `TOOL_PROFILES` router, `INJECTORS`.
- §3.1: LLMLingua integration must be **gated behind `NEXUS_LLMLINGUA=1`** and declared in
  `optionalDependencies` (keep core dependency-light).

## §4 OAuth + accounts + gateway wiring

**`packages/llm-oauth/src/`:**

- `types.ts`: `OAuthTokens`, `AuthProvider`, `Vault`, `TokenHttp`.
- `providers.ts`: `GoogleVertexAuthProvider`, `FetchTokenHttp`, `DESCRIPTORS`
  (google-vertex `supported:true`; azure-openai / github-models stubs `supported:false`).
- `store.ts`: `OAuthTokenStore`, `SealedTokenStore` port. `refresh.ts`: `TokenRefresher`
  (dedups concurrent refreshes). `registry.ts`: `AuthProviderRegistry`, `registryFromEnv`.
- Vault: `AesGcmVault`; PKCE implemented.

**`packages/llm-accounts/src/index.ts`** (300 lines):

- `AccountPool`: `pick(provider, opts)`, `recordSuccess` / `recordFailure` / `recordUsage`,
  `health()`. Strategies: tier-ladder (sub→cheap→free), weighted, power-of-2, quota-aware,
  round-robin. Cooldown + circuit-breaker + quota built in. Injectable `now`/`random` —
  fully deterministic, no network. Test-friendly.

**`apps/api/src/routes/gateway.ts`** (1091 lines) — **target of §4.1:**

- `buildDriverRegistry()` reads env keys per provider; `resolveAlias()`; `DRIVER_ALIASES`.
- POST `/gateway/messages`: streaming + non-streaming, `ThinkTagParser`, prompt cache,
  billing flow `_resolveBillingKey` → `_quota.check(estimateMaxCost)` → `recordUsage`.
- GET `/gateway/models`; POST `/gateway/race`; tools routes; cost-report.
- §4.1 = wire `AccountPool.pick()` + `store.resolveFresh()` → `toDriverCredentials()` →
  driver, inside the dispatch path.

**`apps/api/src/routes/llm-oauth.ts`** (195 lines): `/llm-oauth/*`
(providers/start/callback/revoke); `makeLlmOauthRoutes(deps)` with injectable
`getRegistry`/`makeStore`; PendingAuth in KV keyed by CSRF state (TTL 600 s, delete-on-read);
server-derived `callbackUri`.

**`apps/api/src/lib/oauth-token-store.ts`** (91 lines): `DrizzleSealedTokenStore`,
`createOAuthTokenStore()` — uses `NEXUS_OAUTH_VAULT_KEY`, returns null → routes 503 if unset.

**Blocked:** §4.3 OAuth live E2E needs a registered OAuth app (external Gate).

## §5 Billing — `packages/billing/src/`

- `cost.ts`: `computeCost`, `estimateMaxCost`, `BillingLedger` (reserve/settle),
  `QuotaExceededError`.
- `quota.ts`: `QuotaChecker.check` / `recordUsage` / `monthToDateCostUsd`.
- `api-keys.ts`: `nxk_` keys, SHA-256 hash, `lookupApiKey`. Plus `middleware.ts`, `index.ts`.
- DB: `usage_events` table; `api_keys.monthly_cost_cap_usd` column.
- Related: `packages/provider-registry/src/index.ts` (395 lines) — `ProviderRegistry`,
  `globalRegistry`, `BUILTIN_MODELS`, `ModelDefinition`; models.dev importer
  (`modelsDevToDefinitions`, `registerFromModelsDev`; `fetchModelsDev` is a **live network
  call** → Gate; `MODELS_DEV_API_URL`).

## §6 Orchestration persistence

- `packages/agent-orchestrator/src/index.ts` (167 lines): `orchestrate()`
  (fan-out → score → merge; merge defaults true in opts but the handler forces false),
  `scoreByConfidence`, `GitWorktreeManager`.
- `apps/worker/src/handlers/orchestration-handler.ts` (112 lines): `handleOrchestrationJob`,
  merge default FALSE, runner = `handleAgentRunJob`, scorer = `handleCouncilJob`.
- §6.1 = persist runs to a new `orchestration_runs` table (migration `0013`).

## §7 Agent runtime — `packages/agent-runtime/src/index.ts` (2227 lines)

- `RuntimeToolSet`; `classifyTool` / `AUTO_ALLOWED_TOOLS` / `ActionTier`; `PermissionGate`;
  `AgentRuntime`, `ToolAgentRuntime`.
- Compaction: `DEFAULT_TOKEN_BUDGET=200_000`, `COMPACTION_THRESHOLD=0.8`,
  `RECENT_TURNS_TO_KEEP=10`, `IMAGE_TOKEN_COST=1_600`; `compactMessages`,
  `estimateContextTokens`.
- §7.1 = wire permission gate + compactor + session persistence together.
- **Blocked:** §7.4 CLI `--local` needs a live key (Gate).

## §8–§9 Security

**§9.1 SSRF** — `apps/api/src/lib/pinned-fetch.ts` (90 lines): `createPinnedFetch(lookup)`,
`pinnedFetch`, `safeLookup` — socket pinned to the validated DNS answer (anti-rebinding).
Remaining work: route the remaining native `fetch` sinks in apps/api through it.

**§9.2 CodeQL** — `.cleanup-alerts.txt` (48 alerts):

- path-injection / command-injection: `drive.ts`, sandbox.
- reflected-XSS: `api-bridge.ts:9097`.
- insufficient-password-hash: `crypto-utils.ts:11`.
- missing-rate-limiting: many lines in `sse.ts`, `drive.ts`, `api-bridge.ts`.
- http-to-file / insecure-temp: `drive.ts:317`.
- unvalidated-dynamic-method-call: `provider-keys.ts:103`.
- xss-through-dom: `scrape.tsx:318`.

**Drive** — `apps/api/src/routes/drive.ts` (362 lines): `/drive/*`, `safeResolve` path guard,
app-level `QUOTA_BYTES = 512MB`, Docker exec fallback. Most CodeQL alerts live here.

**§9.4 Sandbox** — `packages/sandbox/src/index.ts` (442 lines): `executeCode`,
`defaultRunner`, `buildSafeEnv`, `buildDockerArgs` (already: `--network=none`,
`--cap-drop=ALL`, `--pids-limit`, `no-new-privileges`, memory/cpu caps), `createDockerRunner`.
Remaining: seccomp profile + read-only rootfs + userns remapping. Firecracker/gVisor = not
scheduled (external infra).

## §10+ Aux packages (export maps)

- `packages/image-gen`: `OpenAIImageProvider`, `ReplicateProvider`.
- `packages/voice`: Groq transcribe, ElevenLabs synth.
- `packages/reranker`: BM25.
- `packages/retrieval`: retrieval core.
- `packages/search-orchestrator`: Chroma / PgFullText / Hybrid / SearxNG strategies.
- **Blocked:** §13.3 dark-web needs legal review (external).

## Order of work (current, per ROADMAP)

§4.1 → §8.1 → §5.1 → §9.1 → §9.2 → then §2 → §3 → rest.
Blocked-on-external: §4.3, §7.4, §13.3.

---

# Round 2 findings (2026-07-02, deeper pass — §6–§13 + DB/UI mechanics)

## DB migration mechanics (CRITICAL gotcha)

- `pnpm db:migrate` = `drizzle-kit migrate` (`packages/db/package.json`), config
  `packages/db/drizzle.config.ts`: `out: "./migrations"`, tracking table
  `nexus_drizzle_migrations`.
- drizzle-kit applies ONLY what's listed in `packages/db/migrations/meta/_journal.json`
  (entries: `idx`, `version:"7"`, `when`, `tag` = filename minus `.sql`, `breakpoints:true`).
- **Journal ends at idx 11 = `0011_agent_sessions`.** Both `0010_usage_token_breakdown.sql`
  and `0012_oauth_credentials.sql` are **missing from the journal** → `db:migrate` silently
  skips them. Latent gap; fix by appending journal entries when next touching migrations.
- Recipe for a new migration therefore has **4 steps**: SQL file + schema file + index export
  - journal entry (idx = last+1).
- Migrations present: `0000`–`0012` with duplicate `0010` (`0010_mcp_servers.sql` +
  `0010_usage_token_breakdown.sql`). Schema files in `packages/db/src/schema/` (17 files,
  `export * from "./<name>.js"` in `index.ts`); `oauth-credentials.ts` +
  `0012_oauth_credentials.sql` are the best pattern to mirror (SPDX header, `-- Migration
00NN:` + `-- Run after` comment lines, quoted snake_case columns, doc comments on pgTable).

## Test-file map (verified)

`packages/<pkg>/tests/<pkg>.test.ts` for: llm-drivers, llm-translate, llm-compress,
llm-accounts, provider-registry, sandbox, domain-feeds. Extras: llm-oauth `store.test.ts`;
billing `{api-keys-crud,billing,cost,middleware,quota-cost,quota-rpm}.test.ts`;
agent-orchestrator `orchestrator.test.ts`; agent-runtime
`{agent-runtime,fs-tools,mcp-tools,ptc}.test.ts`; memory `{memory,pg-vector-store}.test.ts`.
apps/api: `apps/api/tests/routes/*.test.ts` (gateway, gateway-fuzz, drive, llm-oauth,
mcp-servers.ssrf, provider-keys, sse-tenant, …) — run with `cd apps/api && pnpm exec vitest run`.

## §5 billing surface (predates round 1 write-up)

- `apps/api/src/routes/billing.ts` (340 lines): `/billing/plan`, `/billing/current-period`,
  `/billing/keys` (GET/POST/DELETE `/billing/keys/:id`), `/billing/quota`,
  `/billing/usage/:tenantId`. Already aggregates `usageEvents` with drizzle `sql` sums
  (`coalesce(sum(cost_units),0)` filtered by `createdAt >= periodStart`).
- UI `costs.tsx` (513 lines) exists, fetches `/api/costs/{dashboard,breakdown,limits,
efficiency,per-provider,pricing,organization}` in parallel — the dashboard-page mirror.
- No `usage.tsx` in UI. Rate-limit helpers in `apps/api/src/server.ts`:
  `makeRateLimitPreHandler` / `makeUserRateLimitPreHandler` (billing group: 20/60 s).

## §7 agent-runtime precise anchors (`packages/agent-runtime/src/`)

- Files: `index.ts` 2227, `fs-tools.ts` 438, `mcp-tools.ts` 92, `ptc-sandbox.ts` 408 lines.
- `ActionTier` (:255), `AUTO_ALLOWED_TOOLS` (:261), `classifyTool` (:279) — read-only names
  auto-allow. **`PermissionGate` is a callback type (:321)**, accepted as option
  `permissionGate?` (:973), consumed via `tierFor()` (:1073, `tool.tier ?? classifyTool`).
- `estimateContextTokens` (:856) and `compactMessages` (:890) **already exist as functions**
  — §7.1 wires them into the run loop, doesn't write them.
- `SessionStatus` union (:1470) + factory (:1479): active/closed/crashed/reloaded/compacted/
  rateLimited/error. `AgentSessionState` (:1920), `AgentRunOutput`, `SkillFrontmatter`/
  `SkillDefinition` (SKILL.md loader) nearby.
- `ptc-sandbox.ts` exports: `PtcSandboxOptions` (:25), `runInWorkerThread` (:157),
  `runToolScript` (:276).
- `apps/worker/src/handlers/agent-handler.ts` (592 lines): `AgentRunPayload` (:56),
  **already reads/upserts `agentSessions`** (`messages` column, select :127, insert
  w/ onConflict target :145–:157), `handleAgentRunJob` (:298).
- `GovernanceEngine` lives in `packages/governance/src/index.ts` (re-referenced from
  `packages/runtime`).

## §8 worker-side Drive surface (changes §8.4 scope)

- `apps/worker/src/handlers/drive-handler.ts` (107 lines): `handleDriveExecJob` — exec jobs
  only, dispatched by the API after auth + quota pre-checks.
- `apps/worker/src/handlers/workspace-manager.ts` (554 lines): `WorkspaceManager` class,
  `runScriptBounded`, `stopProcess`, TOML `NexusSettings` (`parseNexusSettings`/
  `loadNexusSettings`), `SCRIPT_TIMEOUT_MS = 5 min`. §8.4 lifecycle worker should extend
  these two, not start fresh.
- Full handler list: agent-events, agent-handler, agent-mcp, agent-review, agent-tools,
  async-handlers, council-handler, drive-handler, ingest-handler, orchestration-handler,
  workspace-manager.

## §9 sink inventory + alert nuance

- `packages/runtime/src/security-utils.ts` (268 lines) exports: `isPrivateAddress`,
  `isSafeUrl`, `ResolvedAddress`, `AllAddressResolver`, `SafeLookup`, `makeSafeLookup`,
  `safeLookup`, `assertHostResolvesSafely`, `assertSafeUrl`, `isSafeSandboxPath`.
- Files in `apps/api/src` calling native `fetch(` (non-test): routes — geoip, obs-providers,
  mail-ingest, bots, libertas, oidc, llm-oauth, researcher, connectors, oauth, gateway,
  api-bridge; lib — sentry-reporter, cf-adapter, rate-limiter, shared-kv. Only
  `routes/mcp-servers.ts` uses `pinnedFetch` today. §9.1 = audit this list; convert the
  user-influenced-URL ones (api-bridge, connectors, researcher, bots, obs-providers,
  mail-ingest first); fixed-endpoint provider calls (llm-oauth token URL, gateway driver
  URLs) are lower risk.
- `apps/api/src/routes/api-bridge.ts` is a **9346-line monolith** (bridge routes; hosts the
  prompts + build-tasks endpoints, reflected-XSS alert at :9097).
- `apps/api/src/lib/crypto-utils.ts`: `sha256hex` (:17) is **documented token-only**
  ("never for low-entropy passwords; passwords use scrypt — see `hashPassword` in
  `routes/auth-users.ts`"). The CodeQL insufficient-password-hash alert at :11 is likely a
  false positive → dismiss/suppress with justification, don't rewrite.

## §10 shipped-state corrections (STALE roadmap items)

- **§10.1 prompt version drawer — SHIPPED.** `prompts.tsx` (657 lines) has the versions
  drawer; restore creates a new version via POST `/api/prompts/:id/versions` (:229–:259).
  API lives in `api-bridge.ts`: `/prompts` GET :9032 / POST :9053 / `/prompts/:id`
  PUT :9080 + DELETE :9137 / `/prompts/:id/versions` POST :9100.
- **§10.2 build-task DAG — SHIPPED.** `apps/ui/app/components/build-graph.tsx` exists
  (`@xyflow/react`, layered layout, orphan `parentId` → treated as roots + surfaced via an
  `orphans` banner). `build.tsx` (806) imports `BuildGraph` (:27), Board↔Graph toggle (:686),
  renders it (:743); `TaskDetailPanel` defined in-file (:343). Build-tasks API in
  `api-bridge.ts` :8889–:8999 (`/build/tasks` + steal/claim/release/submit/status).
- §10.3 open: no `mcp-servers.tsx`; API `apps/api/src/routes/mcp-servers.ts` (324 lines,
  CRUD + `/test` which already uses `pinnedFetch` — mock it in UI tests).
- §10.4 open: `@lobehub/icons` not in `apps/ui/package.json`; no icon usage in
  `workflows.tsx` (864).
- §10.5: no `voice.tsx`; `scrape.tsx` exists (DOM-XSS alert :318).
- UI registration: `apps/ui/app/routes.ts` (`route("path", "routes/file.tsx")`, layout
  blocks; `costs` at :90, `provider-keys` at :83).

## §11–§13 anchors

- memory (`packages/memory/src/index.ts`, 2272 lines): `MemoryManager` (:615), `IMemoryStore`
  (:89) impls `InMemoryStore` (:265) / `PgVectorStore` (:342) / `TurboQuantStore` (:780);
  `IEmbedder` (:78) impls `GroqEmbedder` (:171) / `FixedEmbedder` (:240 — deterministic, use
  in tests); `cosineSimilarity` (:727) / `normalize` (:736); stream KV types (:970+).
- domain-feeds (`packages/domain-feeds/src/index.ts`, 3327 lines): abstract `FeedAdapter<T>`
  (:328); adapters Aviation :365, Climate :410, Conflict :514, Economic :607, Displacement
  :666, Cyber :706, Health :774, Imagery :831, Seismology :845, Wildfire :907, **Maritime
  :1025**, Market :1107, Sanctions :1204, Radiation :1258, TechNews :1829, Reddit :1891,
  Preprints :1962, Arxiv :2036, Edgar :2105, Legislative :2173, EurLex :2272; `FeedCache`
  :1313, `FeedRegistry` :1368 (registration block :2344); standalone fetchers RssFeedAdapter
  :2421, SecEdgarFeed :2573, WorldBankFeed :2786, UnhcrDisplacementFeed :2844,
  NgaNavWarningFeed :2916, `FeedProviderRegistry` :3049.
- §12: `packages/mcp-client/src/index.ts` (336 lines): `McpClient` (:219),
  `McpHttpTransport` (:145), `McpTransport` (:140), typed tool/resource defs, injectable
  `FetchFn`, `McpClientError`. **No A2A package exists** — §12.2 is greenfield.

## Fully surveyed — nothing left blocking the roadmap

DB + UI patterns, §6–§13 all covered. Line numbers above are as of 2026-07-02 — treat as
region hints, anchor by symbol name.
