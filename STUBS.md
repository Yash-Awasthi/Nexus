# STUBS.md — Wiring Backlog

All stubs in Nexus, organized by type and priority. This file is the master tracker for incomplete work — things that exist as scaffolding, return placeholder data, or are gated behind missing config. Wire these to complete the platform.

---

## Category A — Previously enterprise-gated routes (all now wired)

All 402 stubs replaced with real in-memory implementations. No paywalls.

| Route                                                     | Status  | Notes                                                                                          |
| --------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `GET/POST/DELETE /sso/config`                             | ✓ Wired | In-memory IdP config store; auto-seeds from NEXUS*SAML*_/NEXUS*OIDC*_ env vars                 |
| `GET /sso/providers`                                      | ✓ Wired | Lists enabled IdPs + OAuth providers; returns loginUrl per provider                            |
| `POST /sso/login`                                         | ✓ Wired | Returns loginUrl for given providerId; proxies to `/auth/saml/login` or `/auth/oidc/authorize` |
| `GET /tenants`                                            | ✓ Wired | Returns current workspace as single tenant; multi-tenant isolation deferred                    |
| `GET/POST/PATCH /whitelabel/config`                       | ✓ Wired | In-memory branding config; seeds from NEXUS_PRODUCT_NAME / NEXUS_LOGO_URL                      |
| `GET/POST/PATCH /data-residency/config`                   | ✓ Wired | In-memory data policy config (region, retentionDays, gdprEnabled, dataClassification)          |
| `GET/POST /workspaces`                                    | ✓ Wired | Returns default workspace; POST creates new                                                    |
| `GET /mfa/status`, `POST /mfa/enable`, `POST /mfa/verify` | ✓ Wired | Alias redirects to real `/auth/totp/*` routes                                                  |
| `GET/POST /scim/Users`, `GET /scim/Groups`                | ✓ Wired | Alias redirects to real `/scim/v2/*` routes                                                    |

---

## Category B — API-key-gated routes (BYOK-enabled)

These degrade gracefully when no key is configured. All three key sources are checked in order.

| Route                      | Gate order                                                 | Notes                                                    |
| -------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| `POST /fine-tune/initiate` | `OPENAI_API_KEY` → `x-openai-key` header → stored BYOK key | OpenAI Files API + fine_tuning/jobs; 503 if no key found |
| `POST /tts`                | `OPENAI_API_KEY` → `x-openai-key` header → stored BYOK key | OpenAI TTS-1; `{audio:null}` if no key found             |

**To activate:** Set `OPENAI_API_KEY` env var, pass `x-openai-key` header per-request, or store key via `POST /user/provider-keys`.

> Billing is free + BYOK. Users store provider keys (OpenAI / Anthropic / Groq / Replicate / Stability) via `POST /user/provider-keys` — AES-256-GCM encrypted at rest.

---

## Category C — Route prefixes (api-bridge.ts)

All 24 route prefixes previously tracked here are now resolved.

| Prefix                  | Status  | Notes                                                                                                                                   |
| ----------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `blind-council`         | ✓ Wired | `POST /blind-council/deliberate` via `@nexus/council` CouncilService; voterId anonymised                                                |
| `browser-agent`         | ✓ Wired | `POST /navigate`, `POST /scrape`, `POST /screenshot`; PatchrightDriver / MockBrowserDriver fallback                                     |
| `build`                 | ✓ Wired | `POST /build/run` via DockerReplExecutor; MockReplExecutor fallback                                                                     |
| `code-agent`            | ✓ Wired | `POST /execute`, `POST/GET /sessions`, `POST /sessions/:id/execute`, `DELETE /sessions/:id`                                             |
| `cross-memory`          | ✓ Wired | `POST /cross-memory/search` + `/merge` via MemoryManager                                                                                |
| `echo-chamber`          | ✓ Wired | `POST /echo-chamber/detect`; LLM judge scores sycophancy 0–1                                                                            |
| `fallback-chains`       | ✓ Wired | `POST /fallback-chains/run` via `@nexus/gateway` runFallbackChain                                                                       |
| `image-transformations` | ✓ Wired | `@nexus/image-transformations` package; resize/crop/convert/watermark/metadata; passthrough when sharp not installed                    |
| `marketplace`           | ✓ Wired | `POST/GET /marketplace/adapters`, `POST /marketplace/execute/:name`; `@nexus/plugin-sdk` AdapterRegistry                                |
| `member-evolution`      | ✓ Wired | `POST /member-evolution/score` (EMA α=0.3), `GET /member-evolution`, `GET /member-evolution/:id`                                        |
| `prompt-filter`         | ✓ Wired | `POST /prompt-filter/scan` + `/perturb` via `@nexus/redteam` detectTriggers + applyParseltongue                                         |
| `reactions`             | ✓ Wired | `POST/GET/DELETE /reactions`; PersistentStore-backed                                                                                    |
| `skill-selection`       | ✓ Wired | `POST /skill-selection/summon`, `GET /archetypes`, `GET /categories`                                                                    |
| `sop`                   | ✓ Wired | Full CRUD + `POST /sop/search`; versioned updates                                                                                       |
| `specialisation`        | ✓ Wired | `POST/GET/DELETE /specialisation`; in-memory AgentDefinition registry                                                                   |
| `symbolic`              | ✓ Wired | `POST /symbolic/ingest`, `POST /nodes/query`, `POST /edges/query`, `GET /symbolic/stats`                                                |
| `system`                | ✓ Wired | `GET /system/health` (uptime/memory/node), `GET /system/metrics` (cost log)                                                             |
| `task-routing`          | ✓ Wired | `POST /task-routing/assign` via `@nexus/supervisor` assignTasks; 4 strategies                                                           |
| `token-conservation`    | ✓ Wired | CRUD + `/check`, `/consume`, `/reset` via `@nexus/token-budget` MemoryTokenBudget                                                       |
| `verbosity`             | ✓ Wired | CRUD + `/transform` via `@nexus/stm` STMPipeline (HedgeReducer + DirectnessOptimizer)                                                   |
| `verifiable`            | ✓ Wired | `POST /verifiable/emit` writes HMAC-chained entry to audit log                                                                          |
| `video`                 | ✓ Wired | `POST /video/search` via `@nexus/video-search` VideoSearchEngine; YouTube backend when `YOUTUBE_API_KEY` set, MockVideoBackend fallback |

_STUB_PREFIXES array in api-bridge.ts is empty — zero live stubs._

---

## Category E — Route files

| File                                  | Status  | Notes                                                                                                                                                         |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/routes/oauth.ts`        | ✓ Wired | Google + GitHub OAuth upsert → users table; issues access+refresh token pair; emailVerified=true                                                              |
| `apps/api/src/routes/oidc.ts`         | ✓ Wired | Generic OIDC SSO; RS256/ES256 JWKS; 5-min discovery cache; kid-based auto-refresh                                                                             |
| `apps/api/src/routes/saml.ts`         | ✓ Wired | SAML 2.0 SP-initiated; zero external deps; node:crypto RS256; 501 unless NEXUS_SAML_ENABLED=true                                                              |
| `apps/api/src/routes/chat-analyst.ts` | ✓ Wired | 5 routes; GroqDriver→OpenRouterDriver→stub fallback; KV-backed cross-pod sessions; SSE stream + heartbeat                                                     |
| `apps/api/src/routes/scraping-mcp.ts` | ✓ Wired | StealthBrowserScrapingBackend when patchright available; MockScrapingBackend fallback; 9 routes via ScrapingMcpServer                                         |
| `apps/api/src/routes/image-gen.ts`    | ✓ Wired | Separate route file; `OpenAIImageProvider` / `ReplicateProvider` / `NullImageProvider`; `/image-gen/generate`, `/models`, `/history` all behind `requireAuth` |

---

## Category F — Packages with incomplete implementations

| Package                    | Status  | What's needed                                                                                                                    |
| -------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `@nexus/knowledge-graph`   | ✓ Wired | `GET /kg/communities`; LLM-backed entity+relationship extraction via `@nexus/nlp-utils` (Groq/Claude fallback to null extractor) |
| `@nexus/connectors`        | ✓ Wired | All 7 connectors wired: GitHub, Slack, Linear, Notion, Bitbucket, Jira, Groq/Tavily/Neon always-on                               |
| `@nexus/image-gen`         | ✓ Wired | `OpenAIImageProvider` / `ReplicateProvider` / `NullImageProvider` via image-gen.ts route                                         |
| `@nexus/lens`              | ✓ Wired | `POST /conversation-analysis/analyze`, `GET /conversation-analysis/:id`, `GET /conversation-analysis`                            |
| `@nexus/nlp-utils`         | ✓ Wired | `POST /nlp/chunk`, `/nlp/language`, `/nlp/keywords`, `/nlp/entities`, `/nlp/relationships`; also feeds KG ingestion              |
| `@nexus/posthog-analytics` | ✓ Wired | Live in `server.ts` — PostHog in prod (`POSTHOG_API_KEY`), InMemory in dev; fire-and-forget on API mutations                     |
| `@nexus/i18n`              | ✓ Wired | `GET /i18n/locale`, `/i18n/translate`, `/i18n/catalog/:locale`; EN + HI built-in; POST to add more locales                       |
| `@nexus/geoip`             | ✓ Wired | `GET /geoip/resolve`, `/geoip/me`, `POST /geoip/batch`; ip-api.com backend, private-IP stub, TTL cache                           |
| `@nexus/mail-ingest`       | ✓ Wired | `POST /mail-ingest/start`, `/stop`, `/poll`; real IMAP via imapflow (optional dep) when IMAP_HOST set                            |

---

_Last updated: 2026-06-18 (session 5). Update this file when stubs are wired._
