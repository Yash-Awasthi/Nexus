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
| `blind-council` | `/blind-council/*` | Multi-provider deliberation without knowing which model responds — wire to `CouncilService` with identity hidden |
| `browser-agent` | `/browser-agent/*` | ✓ Wired — `POST /navigate` (HTML + title), `POST /scrape` (text + links via JS eval), `POST /screenshot` (base64 PNG). PatchrightDriver when available, MockBrowserDriver fallback. |
| `build` | `/build/*` | ✓ Wired — `POST /build/run` via DockerReplExecutor; MockReplExecutor fallback. |
| `code-agent` | `/code-agent/*` | ✓ Wired — `POST /execute` (one-shot), `POST /sessions` (create kernel), `GET /sessions` (list), `POST /sessions/:id/execute` (stateful), `DELETE /sessions/:id` (destroy). Docker-backed, mock fallback. |
| `cross-memory` | `/cross-memory/*` | Cross-session memory merging — wire to `MemoryGraph` + user ACL lookup |
| `echo-chamber` | `/echo-chamber/*` | Agreement bias detection — wire LLM scorer to flag yes-man responses |
| `fallback-chains` | `/fallback-chains/*` | Wire to `@nexus/gateway` `FallbackChain` — define ordered provider fallback sequences |
| `image-transformations` | `/image-transformations/*` | Wire to image manipulation library (sharp/jimp) or OpenAI image edit API |
| `marketplace` | `/marketplace/*` | Plugin/adapter marketplace — wire to `@nexus/plugin-sdk` registry |
| `member-evolution` | `/member-evolution/*` | Council member persona evolution over time — wire to memory + scoring |
| `prompt-filter` | `/prompt-filter/*` | Wire to `@nexus/redteam` — input filtering and perturbation detection |
| `reactions` | `/reactions/*` | Message reaction system — simple association store, wire to gateway log |
| `skill-selection` | `/skill-selection/*` | Wire to council archetype SUMMONS map + `AgentDefinition.toolNames` |
| `sop` | `/sop/*` | Standard operating procedures — wire to document store + retrieval |
| `specialisation` | `/specialisation/*` | Agent specialisation profiles — wire to `AgentDefinition` + `AgentPersona` |
| `symbolic` | `/symbolic/*` | Symbolic reasoning engine — wire to knowledge-graph entity/relation system |
| `system` | `/system/*` | System health/config endpoints — wire to actual runtime metrics |
| `task-routing` | `/task-routing/*` | Wire to `@nexus/supervisor` `OmaSchedulingStrategy` |
| `token-conservation` | `/token-conservation/*` | CRUD storage wired ✓; action routes `/check`, `/consume`, `/reset` wired to `@nexus/token-budget` MemoryTokenBudget ✓ |
| `verbosity` | `/verbosity/*` | CRUD storage wired ✓; `/transform` action wired to `@nexus/stm` STMPipeline (HedgeReducer + DirectnessOptimizer) ✓ |
| `verifiable` | `/verifiable/*` | Verifiable pipeline audit — wire to `@nexus/telemetry` HMAC audit log |
| `video` | `/video/*` | Wire to video extraction/transcript pipeline |

**Wire priority:** `code-agent` and `browser-agent` are highest value. `token-conservation` and `verbosity` are trivially wireable (packages already exist).

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
| `apps/api/src/routes/oauth.ts` | ✓ Wired | Google + GitHub OAuth upsert → users table; issues proper access+refresh token pair; emailVerified=true for OAuth users. Generic OIDC (Okta/Azure) still pending. |
| `apps/api/src/routes/chat-analyst.ts` | Partial | Verify all analyst route handlers are fully wired |
| `apps/api/src/routes/image-gen.ts` | Deterministic placeholder fallback | Fallback is fine for dev; ensure primary path (DALL-E/Stability) is exercised in staging |
| `apps/api/src/routes/scraping-mcp.ts` | MCP tool wiring | Verify `@nexus/scraping-mcp` adapter integration is live end-to-end |

---

## Category F — Packages with known incomplete implementations

These packages compile and have correct interfaces but their implementations are partial or use no-op defaults.

| Package | Stub | What's needed |
|---|---|---|
| `@nexus/knowledge-graph` | Community detection not wired to graph analysis | Implement Leiden clustering over `MemoryGraph` edges |
| `@nexus/reranker` | `PassThroughReranker` is the default | Wire a real reranker (Cohere rerank API or cross-encoder) |
| `@nexus/session-summarizer` | Summary prompt uses `{count}` placeholder | Verify LLM caller is wired; test against real conversation history |
| `@nexus/llm-router` | `NullProvider` is fallback | Ensure cost+latency-aware routing actually fires against real providers in production |
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

*Last updated: 2026-06-18 (session 3). Update this file when stubs are wired — move entries to the relevant ADR or close them.*
