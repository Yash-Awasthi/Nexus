<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS — Work Progress

Resume context for in-flight roadmap work. Pairs with [ROADMAP.md](ROADMAP.md)
(open work) — this file tracks what's **done / partial / deferred** in the current
push, plus how to verify and what's next.

## Branch

- **Branch:** `feat/provider-breadth-compress-billing` (off `main`)
- **State:** committed, **not pushed, no PR**. Working tree clean (only untracked
  `.claude/settings.json`, `.directory` left alone — not ours).
- Per repo rule: never commit to `main`; branch first. Conventional Commits.

## Commits (9, newest first)

```
54ef404 feat(domain-feeds): add Reddit social feed
7d0240b feat(domain-feeds): add Hacker News tech-news feed
d641978 feat(llm-drivers): add Replicate driver (synchronous predictions)
c1aa388 feat(runtime): harden SSRF guard in isSafeUrl
67c3efb feat: make Nexus free and open — remove paywall + Stripe
c83d0c2 feat(billing): USD cost model + reservation ledger
2a4f9e9 feat(provider-registry): models.dev metadata importer
cdc7a33 feat(llm-compress): auto-detect dispatcher + system-prompt injectors
e2e3646 feat(llm-drivers): add 7 providers + OpenAI-compat base seam
```

## Done

### §1 LLM provider breadth — `@nexus/llm-drivers` (+ api BYOK, .env.example)

- Added 9 drivers: **Doubao/Volcengine, BytePlus, Hunyuan, Spark (iFlytek HTTP),
  Azure OpenAI, Cloudflare Workers AI, Xinference, Replicate, Baidu ERNIE**.
- Added a base-class seam to `OpenAICompatibleDriver`: `chatCompletionsUrl()` +
  `authHeaders()` hooks (Azure needs deployment-path + `api-key` header +
  `api-version` query). Zero behaviour change for the 30 existing Bearer drivers.
- Replicate uses synchronous `Prefer: wait` (one POST, no GET poll — fits the
  POST-only `HttpTransport` + MockTransport).
- **Baidu ERNIE** (`BaiduErnieDriver`): client-creds OAuth → cached `access_token`,
  then chat POST (2 POSTs, both via transport). ERNIE wire format (top-level
  `system`, `result` reply, in-body `error_code`→typed `LlmError`, 110/111 clears
  token). Tool-calling not mapped yet (text only; §2 matrix upgrade path noted).
  Needed `MockTransport.setResponses([token, chat])` queue — **added** (ordered
  responses, drains to `setResponse` fallback).
- Each driver wired into `apps/api/src/lib/provider-keys.ts` BYOK factory
  (Azure/Cloudflare/ERNIE use composite JSON-blob creds like bedrock/vertex —
  ERNIE: `{clientId, clientSecret}`; Xinference is local, omitted) + `.env.example`.
- **Tests:** 263 in `packages/llm-drivers/tests/llm-drivers.test.ts`.

### §5 cost model + billing lifecycle — `@nexus/billing/src/cost.ts` (NEW)

- `computeCost()` — USD breakdown (input/output/cache-read/cache-write) from
  `provider-registry`; unknown model → zero + `unknownModel:true`, never throws.
- `estimateMaxCost()` — worst-case (full maxOutput) for safe reservations.
- `BillingLedger` — estimate→reserve→settle; `reserve()` checks cap **before** the
  call (no silent overspend), `settle()` returns overage/refund delta, `release()`
  cancels; ledgers compose for token<user<account hierarchy.
- `QuotaExceededError` — typed, scoped. Added `@nexus/provider-registry` dep.
- **Tests:** 14 in `packages/billing/tests/cost.test.ts`.

### §9 SSRF hardening — `@nexus/runtime/src/security-utils.ts`

- Rewrote `isSafeUrl`: parses host as IP, blocks full private/reserved set
  (added 172.16/12, 100.64/10 CGNAT, all 169.254/16, 0/8, multicast/reserved) +
  smuggled encodings (decimal/hex/octal/short IPv4, IPv6 ULA fc00::/7, link-local
  fe80::/10, unspecified, IPv4-mapped). Added `assertSafeUrl()` (throwing).
- All 4 existing callers (sandbox, scraping, browser, resource-enforcer) inherit it.
- **Tests:** 45 in `packages/runtime/tests/security-utils.test.ts` (226 pkg-wide).

### §13 domain feeds — `@nexus/domain-feeds`

- **TechNewsFeed** (Hacker News via Algolia search JSON, no key) + `TechNewsEvent`.
- **RedditFeed** (public subreddit listing JSON, no key) + `RedditEvent`.
- **PreprintsFeed** (bioRxiv/medRxiv `details` JSON API, no key) + `PreprintEvent`.
  `server`/`from`/`to`/`category` opts; published-DOI→severity (NA = unpublished →
  low); doi+version id; mock fallback.
- All three registered in `createDefaultRegistry`, virality→severity, filters, mock
  fallback. **Tests:** 54 in `packages/domain-feeds/tests/domain-feeds.test.ts`.

### "Free & open to all" — de-paywall (commit 67c3efb)

- **Tiers neutralized** (`apps/api/src/middleware/auth.ts`): `getTierFromRequest` /
  `requireAuthWithTier` always resolve to top access (`OPEN_TIER`) → every
  tier-gate passes. `nexusUserId` identity preserved. Removed tier-derivation /
  JWT-tier / in-process tier cache.
- **Firehose opened** (`apps/api/src/routes/sse.ts`): dropped the enterprise-only
  403s on tasks/signals/verdicts/agent streams; per-session ownership checks kept.
- **Stripe ripped out**: deleted `packages/billing/src/stripe-webhook.ts` + test +
  exports; removed checkout/portal/webhook/subscription/cancel endpoints from
  `apps/api/src/routes/billing.ts`; collapsed `PLANS` to one open/unlimited plan.
  Kept API-key CRUD, quota meter, BYOK cost model.

### §3 token compression — `@nexus/llm-compress` (+ agent-runtime/worker/api wiring)

- `compressAuto()` + `detectTraits()` (ansi/trailing-ws/blank-runs/repeat-runs →
  matched lossless filters). `injectSystemPrompt()` + `INJECTORS` (terse-output,
  yagni-minimal-code), opt-in/default-off/idempotent.
- **Wired into the agent hot-path:** `ToolAgentRuntime` already compresses
  tool-result text (lossless default) before it re-enters history via
  `compressToolOutput` + `onToolCompress`. Now plumbed end-to-end:
  - `apps/api` `/agent/run` reads the **`x-nexus-compress`** header
    (`parseCompressHeader`: off/false/0/none/no→`false`; lossless/on/true/1/yes→
    `"lossless"`; else default) → `LaunchAgentInput.compressToolOutput` →
    `agent.run` payload.
  - `apps/worker` agent-handler passes `compressToolOutput` into the runtime and
    emits an **`agent.tool_compress`** SSE/log event per pass (tool, savedTokens,
    applied) — measured saving, no silent black box. New `tool_compress`
    `AgentEventType` in `@nexus/sse`.
  - `PresetName`/`StructuredFormat` re-exported from `@nexus/agent-runtime` so
    api/worker type the field without a direct llm-compress dep.
- **Tests:** 30 in llm-compress; +4 `parseCompressHeader` in
  `apps/api/tests/lib/agent-queue.test.ts`.

### §1 models.dev seeding — `@nexus/provider-registry` (partial, see below)

- `modelsDevToDefinitions()` (per-MTok→per-token; modality→vision, tool_call→
  functionCalling, cache_read→promptCaching), `registerFromModelsDev()` (curated
  builtins win unless overwrite), `fetchModelsDev()` (gated network, not invoked).
  Extended `ModelDefinition` with cache costs / modalities / cutoff / releaseDate.
- **Tests:** 27 in `packages/provider-registry/tests/provider-registry.test.ts`.

## Partial / follow-ups

- **§3 compression:** library + **agent hot-path wiring done** (`x-nexus-compress`
  header → runtime → `agent.tool_compress` telemetry). Still open: the raw
  **gateway** proxy path (`apps/api/routes/gateway.ts`) doesn't compress
  tool/message bodies (only the agent runtime does); tool-name→filter router on
  top of `compressAuto`; GCF encoder (spec ambiguous — don't invent); llmlingua-2
  lossy (gated 2GB model dep).
- **§1 models.dev:** importer done; **not auto-seeded** into `globalRegistry`
  (left manual to avoid a startup network call). Consider a CLI/admin seed cmd.
- **§5 billing:** cost model done; **not persisted** (no `usage_events` token
  columns) and **not wired** into gateway/middleware pre-call. No usage-analytics
  UI route yet.
- **De-paywall leftovers (intentional, low-risk):**
  - Dormant Stripe DB columns kept (`subscriptions`, `stripe_webhook_events`,
    `users.stripe_customer_id`) — dropping = prod Neon migration; they gate
    nothing. Drop later if wanted (write migration, flag for review).
  - Tier-gate package + `requireAuthWithTier` name kept (inert) rather than
    deleted, to avoid destabilising 8+ routes that also use it for identity.
  - Stripe **tool adapter** (`packages/adapters/stripe`) kept — it's an
    agent-driven feature (manage a user's *own* Stripe), not a Nexus paywall.

## Deferred (real work, not quick wins)

- **§1 remaining non-OpenAI drivers:** dify (app-scoped), alibailian. (baidu-ernie
  **shipped** — see §1 Done.)
- **§13 scientific preprints:** bioRxiv **shipped** (`PreprintsFeed`). arXiv still
  deferred — Atom XML; existing `RssFeedAdapter` parses `<item>`/`<entry>` but its
  `http` returns text while `FeedAdapter.http` returns JSON (impedance). EDGAR/most
  legislative are XML too — same impedance to resolve before those land.
- §6 orchestration persistence, §7 coding-agent tools into RuntimeToolSet,
  §10 UI pages, §11 memory upgrade — bigger, touch DB/hot-path/UI.

## Verify (per package, fast)

```
pnpm exec vitest run packages/llm-drivers/tests/llm-drivers.test.ts      # 263
pnpm exec vitest run packages/billing/tests/                              # 43
pnpm exec vitest run packages/runtime/tests/security-utils.test.ts       # 45
pnpm exec vitest run packages/domain-feeds/tests/domain-feeds.test.ts    # 54
pnpm exec vitest run packages/llm-compress/tests/llm-compress.test.ts    # 30
pnpm exec vitest run packages/provider-registry/tests/provider-registry.test.ts  # 27
pnpm --filter @nexus/api typecheck
```

Note: edits to a package's `src` require `pnpm --filter <pkg> build` before
`apps/api typecheck` picks them up (api consumes built `dist`).

## Next up (suggested order)

1. Persist §5 cost breakdown + pre-call ledger check in middleware.
2. **dify** / **alibailian** drivers (§1) — both app/workspace-scoped auth.
3. Tool-name→filter router on `compressAuto` (git diff/grep/ls/build) (§3).
