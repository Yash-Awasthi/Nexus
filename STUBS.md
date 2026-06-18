# STUBS.md — Wiring Backlog

All stubs in Nexus, organized by type and priority. This file is the master tracker for incomplete work — things that exist as scaffolding, return placeholder data, or are gated behind missing config. Wire these to complete the platform.

---

## Category A — Enterprise stubs (intentional, 402)

These return `402 Payment Required` by design. They represent features that need enterprise infrastructure (SSO provider, billing, identity management) before they can be wired. Not bugs — deliberate placeholders.

| Route | File | What's needed to wire |
|---|---|---|
| `GET/POST /sso/config` | api-bridge.ts | SAML provider config — SAML 2.0 assertion handling still pending |
| `GET /sso/providers` | api-bridge.ts | SSO provider registry UI |
| `POST /sso/login` | api-bridge.ts | SAML 2.0 assertion handler (generic OIDC wired separately) |
| `GET /tenants` | api-bridge.ts | Multi-tenant list with data isolation layer |
| `GET /data-residency/config` | api-bridge.ts | Data residency policy per tenant |
| `GET /whitelabel/config` | api-bridge.ts | Branding config store (logo, colors, domain) |

**Wire when:** Enterprise plan + identity provider integration.

> **Wired (2026-06-18, sessions 2–3):**
> - User auth: register, login, refresh, logout, me, PATCH me
> - Password reset: `POST /auth/forgot-password`, `POST /auth/reset-password`
> - Session management: `GET /auth/sessions`, `DELETE /auth/sessions/:id`
> - Email verification: `POST /auth/send-verification`, `POST /auth/verify-email`
> - TOTP MFA: setup, verify, validate, disable (RFC 6238, AES-256-GCM secrets at rest)
> - SCIM 2.0 (RFC 7644): Users CRUD + Groups mapped to workspaces; full filter + PATCH ops
> - Workspaces: CRUD + RBAC (owner/admin/member/viewer) + invitation flow
> - Admin: user list/get/patch/suspend/restore/force-logout/hard-delete
> - OAuth: Google + GitHub upsert → users table + token pair
> - Audit log: HMAC-SHA256 chained; wired to register/login/MFA/password-reset/workspace-create/email-verified
> - Rate limiting: login (10/15min), register (5/hr), forgot-password (3/hr), send-verification (5/hr)
>
> - Generic OIDC SSO: `GET /auth/oidc/authorize`, `GET /auth/oidc/callback`; RS256/ES256 JWKS verification; Okta/Azure AD/Keycloak/Auth0; 501 until env vars set
>
> **Remaining Category A stubs:** SAML 2.0 assertion handler, data-residency policy, white-label branding, multi-tenant isolation layer.

---

## Category B — API-key-gated stubs (intentional, 501)

These return `501 Not Implemented` or degrade gracefully when a required API key is absent. They are fully designed — just need the env var set.

| Route | File | Gate | Notes |
|---|---|---|---|
| `POST /fine-tune` (start job) | api-bridge.ts | `OPENAI_API_KEY` | Uses OpenAI Files API + fine_tuning/jobs; already wired, just gated |
| `POST /tts` | api-bridge.ts | `OPENAI_API_KEY` | OpenAI TTS-1; returns `{audio: null}` when key missing |
| `POST /billing/subscribe` | api-bridge.ts | Stripe keys | Returns 501 until Stripe keys configured |
| `GET /billing/plans` | api-bridge.ts | Stripe keys | Returns static plan list but checkout is 501 |
| `POST /oauth/google/callback` | oauth.ts | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Returns 501 without Google OAuth app credentials |
| `GET /oauth/google` | oauth.ts | `GOOGLE_CLIENT_ID` | Redirect URL only works with credentials |
| `POST /oauth/github/callback` | oauth.ts | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Returns 501 without GitHub OAuth app credentials |
| `GET /oauth/github` | oauth.ts | `GITHUB_CLIENT_ID` | Redirect URL only works with credentials |

**Wire when:** Set the relevant env var. No code changes needed for TTS/fine-tune — they're already implemented.

---

## Category C — CRUD scaffolds (PersistentStore-backed, need real logic)

These 21 routes have full CRUD (GET list, GET by id, POST, PUT, PATCH, DELETE) backed by `PersistentStore` in `api-bridge.ts`. They store and retrieve data correctly but have no real business logic — no LLM calls, no validation, no side effects beyond storage.

| Prefix | Route pattern | What real wiring looks like |
|---|---|---|
| `blind-council` | `/blind-council/*` | ✓ Wired — `POST /blind-council/deliberate` via `@nexus/council` `CouncilService`; model identity stripped from votes (voterId anonymised) |
| `browser-agent` | `/browser-agent/*` | ✓ Wired — `POST /navigate` (HTML + title), `POST /scrape` (text + links via JS eval), `POST /screenshot` (base64 PNG). PatchrightDriver when available, MockBrowserDriver fallback. |
| `build` | `/build/*` | ✓ Wired — `POST /build/run` via DockerReplExecutor; MockReplExecutor fallback. |
| `code-agent` | `/code-agent/*` | ✓ Wired — `POST /execute` (one-shot), `POST /sessions` (create kernel), `GET /sessions` (list), `POST /sessions/:id/execute` (stateful), `DELETE /sessions/:id` (destroy). Docker-backed, mock fallback. |
| `cross-memory` | `/cross-memory/*` | ✓ Wired — `POST /cross-memory/search` (semantic search across sessions via MemoryManager), `POST /cross-memory/merge` (store cross-session synthesis entry) |
| `echo-chamber` | `/echo-chamber/*` | ✓ Wired — `POST /echo-chamber/detect` (LLM judge scores sycophancy 0–1; flags unconditional agreement, flattery, position-reversal, hedging) |
| `fallback-chains` | `/fallback-chains/*` | ✓ Wired — `POST /fallback-chains/run` via `@nexus/gateway` `runFallbackChain`; tries each model in order, returns first success + fallback error log |
| `image-transformations` | `/image-transformations/*` | Deferred — needs `sharp`/`jimp`/Cloudinary; no `@nexus/image-transformations` package. Removed from STUB_PREFIXES loop. |
| `marketplace` | `/marketplace/*` | ✓ Wired — `POST /marketplace/adapters` (register `AdapterDefinition`), `GET /marketplace/adapters` (list), `POST /marketplace/execute/:name` (run adapter); `@nexus/plugin-sdk` `AdapterRegistry` |
| `member-evolution` | `/member-evolution/*` | ✓ Wired — `POST /member-evolution/score` (EMA α=0.3 trait scoring), `GET /member-evolution` (all archetypes), `GET /member-evolution/:id` (single archetype state) |
| `prompt-filter` | `/prompt-filter/*` | ✓ Wired — `POST /prompt-filter/scan` (trigger detection via `@nexus/redteam` `detectTriggers`), `POST /prompt-filter/perturb` (adversarial obfuscation via `applyParseltongue`) |
| `reactions` | `/reactions/*` | ✓ Wired — `POST /reactions` (add emoji reaction), `GET /reactions?messageId=` (list), `DELETE /reactions/:id` (remove); PersistentStore-backed |
| `skill-selection` | `/skill-selection/*` | ✓ Wired — `POST /skill-selection/summon` (get archetypes for task category), `GET /archetypes` (list all), `GET /categories` (list SUMMONS map) |
| `sop` | `/sop/*` | ✓ Wired — `POST /sop` (create), `GET /sop` (list), `GET /sop/:id` (full content), `PATCH /sop/:id` (versioned update), `POST /sop/search` (keyword + tag filter) |
| `specialisation` | `/specialisation/*` | ✓ Wired — `POST /specialisation` (register AgentDefinition), `GET /specialisation` (list), `GET /specialisation/:id`, `DELETE /specialisation/:id`; in-memory registry |
| `symbolic` | `/symbolic/*` | ✓ Wired — `POST /symbolic/ingest` (entity+relation extraction), `POST /nodes/query` + `POST /edges/query` (KGStore filter), `GET /symbolic/stats` |
| `system` | `/system/*` | ✓ Wired — `GET /system/health` (uptime, memory, node version), `GET /system/metrics` (cost log summary) |
| `task-routing` | `/task-routing/*` | ✓ Wired — `POST /task-routing/assign` via `@nexus/supervisor` `assignTasks`; round-robin/least-busy/capability-match/dependency-first strategies |
| `token-conservation` | `/token-conservation/*` | ✓ Wired — CRUD storage + action routes `/check`, `/consume`, `/reset` wired to `@nexus/token-budget` MemoryTokenBudget |
| `verbosity` | `/verbosity/*` | ✓ Wired — CRUD storage + `/transform` action wired to `@nexus/stm` STMPipeline (HedgeReducer + DirectnessOptimizer) |
| `verifiable` | `/verifiable/*` | ✓ Wired — `POST /verifiable/emit` writes HMAC-chained entry to audit log via `audit-emitter.ts` |
| `video` | `/video/*` | ✓ Wired — `POST /video/search` (LLM-intent extraction + ranking via `@nexus/video-search` `VideoSearchEngine`; GroqDriver model fn, MockVideoBackend); `GET /video/cache/status` |

*All Category C prefixes wired or intentionally deferred. `image-transformations` is the only remaining unimplemented prefix — needs an external image-processing package.*

---

## Category D — Functional stubs (real backing, incomplete behaviour)

These routes respond correctly but with stubbed or no-op behaviour despite having the infrastructure to do more.

| Route | File | Current behaviour | Real behaviour needed |
|---|---|---|---|

---

## Category E — Route files with placeholder logic

Full route files where the implementation is a skeleton or uses deterministic placeholder data.

| File | Current state | What needs wiring |
|---|---|---|
| `apps/api/src/routes/oauth.ts` | ✓ Wired | Google + GitHub OAuth upsert → users table; issues proper access+refresh token pair; emailVerified=true for OAuth users. |
| `apps/api/src/routes/oidc.ts` | ✓ Wired | Generic OIDC SSO (Okta/Azure AD/Keycloak/Auth0); RS256/ES256 via node:crypto JWKS; 5-min discovery cache; kid-based auto-refresh. |
| `apps/api/src/routes/chat-analyst.ts` | ✓ Verified | All 5 routes fully wired: GroqDriver→OpenRouterDriver→stub fallback; KV-backed cross-pod session persistence; SSE stream with heartbeat; rate limiting via AnalystRateLimiter. |
| `apps/api/src/routes/image-gen.ts` | Deterministic placeholder fallback | Fallback is fine for dev; ensure primary path (DALL-E/Stability) is exercised in staging |
| `apps/api/src/routes/scraping-mcp.ts` | ✓ Verified | Auto-wires StealthBrowserScrapingBackend when patchright available; falls back to MockScrapingBackend. All 9 routes wired to `ScrapingMcpServer.call()`. |

---

## Category F — Packages with known incomplete implementations

These packages compile and have correct interfaces but their implementations are partial or use no-op defaults.

| Package | Stub | What's needed |
|---|---|---|
| `@nexus/knowledge-graph` | Community detection not wired to graph analysis | Implement Leiden clustering over `MemoryGraph` edges |
| `@nexus/reranker` | ✓ Verified — `BM25Reranker` is production-ready (TF-IDF/BM25, zero deps); `NullReranker` is test-only no-op; `FunctionReranker` injectable scoring fn. | — |
| `@nexus/session-summarizer` | ✓ Verified — `LLMSessionSummarizer` wired to injectable `LLMProvider`; `{count}` placeholder correctly replaced at runtime; `AutoCompressor` with configurable token budget trigger. | — |
| `@nexus/llm-router` | ✓ Verified — `ClaudeProvider`, `GroqProvider`, `OpenAIProvider` all wired; routing strategies: first/round-robin/least-latency (EMA); fallback chains on transient errors; `NullProvider` is test-only. | — |
| `@nexus/connectors` | `NullConnector` is the default | Wire real connector implementations for each integration |
| `@nexus/image-gen` | `NullImageProvider` returns placeholder images | Ensure DALL-E/Stability provider is wired when API keys present |
| `@nexus/i18n` | Stub translations | Add real locale strings when UI goes multilingual |
| `@nexus/geoip` | Stub IP lookup | Wire to MaxMind GeoIP2 or ip-api.com |
| `@nexus/posthog-analytics` | No-op events | Wire real PostHog project key when analytics is needed |
| `@nexus/lens` | Minimal scaffold | Evaluate if this is still needed; wire or remove |
| `@nexus/nlp-utils` | Basic stubs | Wire NLTK/spaCy patterns if NLP utilities are needed |
| `@nexus/mail-ingest` | Stub mail handler | Wire IMAP connector from `@nexus/adapter-gmail` or IMAP source |

---

## Wiring priority order

1. **(Trivially wireable — packages exist, just connect)**

2. **(High value, packages exist, moderate effort)**
   - `code-agent` → `AgentRuntime` + `DockerReplExecutor`
   - `browser-agent` → `@nexus/stealth-browser` PatchrightDriver

3. **(New infrastructure required)**
   - OAuth (Google + GitHub) — needs OAuth app credentials + session store
   - Billing — needs Stripe integration
   - SSO / SCIM / MFA — needs identity provider setup

4. **(Evaluate before wiring — may not be needed)**
   - `blind-council`, `echo-chamber`, `member-evolution` — advanced council features
   - `@nexus/lens`, `@nexus/nlp-utils` — assess if still in scope
   - `libertas.ts` — depends on whether Libertas model deployment is planned

---

*Last updated: 2026-06-18 (session 4). Update this file when stubs are wired — move entries to the relevant ADR or close them.*
