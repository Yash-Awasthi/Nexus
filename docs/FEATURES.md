<!-- SPDX-License-Identifier: Apache-2.0 -->

# NEXUS — Features & Core Concepts

A capability-by-capability reference. For how the pieces fit together see
[ARCHITECTURE.md](ARCHITECTURE.md); for running it see the
[README](../README.md#quick-start).

## What's inside

| Capability               | How it works                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-model council      | Models run in parallel via `Promise.allSettled`; unanimous, majority, or weighted voting. Archetypes come from a durable per-user registry (`apps/api/src/lib/archetype-store.ts`), seeded from `packages/council/src/archetypes.ts`.                                                                                                                                                                                                                      |
| LLM drivers              | Adapters for Anthropic, OpenAI, Groq, Gemini, DeepSeek, Mistral, OpenRouter, Ollama, and others, with SSE streaming. Reading text into the knowledge graph is two calls per chunk, so `NEXUS_EXTRACT_MODEL` can name a cheaper provider/model for it.                                                                                                                                                                                                      |
| Provider failover        | Error classifier groups failures into retryable categories and falls back across a configured chain; a saved connection that lists several models tries each before the next provider.                                                                                                                                                                                                                                                                     |
| Sandboxed code execution | Piston for several languages; a Docker REPL for Python/R/Julia with `--network none`, a memory cap, and a read-only filesystem.                                                                                                                                                                                                                                                                                                                            |
| Long-term memory         | pgvector with an HNSW index and a BFS-traversable relation graph; hybrid BM25 + RRF retrieval; TTL and per-tenant ACL.                                                                                                                                                                                                                                                                                                                                     |
| Knowledge graph          | Entity and relation graph with clustering, multi-hop traversal, and several search modes. A knowledge base is read into it in the background (`POST /api/kb/:id/graph`, optionally keeping only some entity types), and the graph page draws it in 3D. An entity or a relationship can be deleted (`DELETE /api/kg/nodes/:id`, `DELETE /api/kg/edges/:id`); the delete is kept as a tombstone that a sync passes to peers, so it does not come back.       |
| Search                   | One query across your knowledge bases, knowledge graph and the web (`POST /api/search`, the Search page). Each source is numbered, and an answer cites the ones it used.                                                                                                                                                                                                                                                                                   |
| Chat history search      | The Deliberations sidebar searches titles and everything said in them (`GET /api/threads?q=`); a match inside a conversation shows the passage around it.                                                                                                                                                                                                                                                                                                  |
| Privacy guard            | Before a message is sent, the Privacy & Safety settings warn about or remove personal details (emails, phone and card numbers, SSNs) and secrets (API keys, tokens, private keys).                                                                                                                                                                                                                                                                         |
| Document pipeline        | Knowledge-base uploads extract text (PDF, DOCX, HTML, images by OCR), chunk and embed it; `POST /api/v1/doc-pipeline/ingest` runs the same stages and returns the chunks without keeping them.                                                                                                                                                                                                                                                             |
| Orchestration            | `PlanningEngine` turns a goal into a plan and `TaskExecutor` runs each step with retry, backoff and a circuit breaker.                                                                                                                                                                                                                                                                                                                                     |
| Cost tracking            | Per-call token accounting exposed as Prometheus metrics, with a configurable price table.                                                                                                                                                                                                                                                                                                                                                                  |
| Gauntlet                 | Runs models against the same prompt in waves and scores each response.                                                                                                                                                                                                                                                                                                                                                                                     |
| Red-team engine          | Input perturbation with configurable attack profiles, over the API only.                                                                                                                                                                                                                                                                                                                                                                                   |
| RAG                      | chunk → embed → retrieve → rerank, with sub-query decomposition and hybrid scoring.                                                                                                                                                                                                                                                                                                                                                                        |
| RLHF + eval              | An SFT auto-tagger and a corpus builder over the API. Answers rated in chat land in the RLHF page.                                                                                                                                                                                                                                                                                                                                                         |
| MCP support              | JSON-RPC 2.0 over HTTP, batch invocation, and OpenAPI-to-MCP generation.                                                                                                                                                                                                                                                                                                                                                                                   |
| Observability            | OpenTelemetry (OTLP) traces, Prometheus metrics, Grafana dashboards, and HMAC-SHA256-chained audit logs.                                                                                                                                                                                                                                                                                                                                                   |
| Auth + BYOK              | API key plus JWT (HS256 or RS256 via `NEXUS_JWT_ALG`); OAuth/OIDC/SAML SSO (enterprise SSO links to existing accounts only unless `NEXUS_SSO_AUTO_PROVISION=1` **and** the domain is in `NEXUS_SSO_ALLOWED_DOMAINS`); login throttle with exponential backoff (§14.3); per-session and per-user token revocation; self-service GDPR erasure (`DELETE /users/:id/data`, §14.4); per-user LLM keys encrypted at rest (AES-256-GCM) and resolved server-side. |

## HTTP API surface

The capabilities above are implemented as the `@nexus/*` packages and are exercised
directly (SDK + tests). They are exposed over HTTP through two layers:

- **`/api/v1/*`** — production, DB-backed endpoints: auth, council, memory, connectors,
  billing, feature-flags, projects, orchestration, scraping, MCP and more. These are what the dashboard's core flows use.
- **`/api/*`** — a broad compatibility bridge covering the wider feature catalogue
  (analytics, moderation, standard answers and more). It is backed by an in-memory store
  for demonstration; treat its data as synthetic until a `/api/v1` handler exists.

New endpoints graduate from the bridge to `/api/v1` as they are wired to Postgres.

**Do not read maturity off the prefix.** Several surfaces were extracted out of the bridge
into their own `routes/*.ts` file while still mounted under `/api` — `/api/skills`,
`/api/workflows`, `/api/kb`, `/api/archetypes` and others are durable despite the missing
version segment, and `/api/sandbox` and `/api/connectors` are dedicated handlers whose state
is still process memory.

The authoritative answer is in the spec. `GET /openapi.json` is generated from the live
route table — roughly 515 paths and 650 operations — and tags every operation `durable`,
`dedicated-volatile`, or `bridge`. The committed `openapi.yaml` is the same document; CI
fails if it drifts from the routes. Regenerate it with `pnpm openapi:generate`.

## Embedding Nexus in another site

Any page can ask your knowledge bases through the widget the server hosts:

```html
<script src="https://your-nexus/widget.js" defer></script>
<nexus-widget token="nxk_..." kbs="kb-id" heading="Ask us"></nexus-widget>
```

Mint the token on the API Tokens page with only the **search** scope: visitors can read it from
the page, and such a token reaches `POST /api/search` and nothing else. `web` and `graph`
attributes add those sources, `mode="inline"` draws an open panel instead of a floating button,
and `api` points at another Nexus origin. When `ALLOWED_ORIGINS` is set, add the host site to it.

The same widget runs in the browser extension in `apps/extension` (load it unpacked from
`chrome://extensions`). It asks for the Nexus address and a search token once, gets host access
to that one server, and puts text selected on the current tab into the question box.

## Core concepts

**Agent runtime** — a multi-step tool loop. Agents plan, call tools, observe results, and
loop until done or a step limit is reached.

**Council** — runs models in parallel with `Promise.allSettled`, so one model failing does
not break the vote. Archetypes (The Architect, The Contrarian, Devil's Advocate, and so on)
live in a per-user registry behind `/api/archetypes`; the built-ins are seeded rows and a
user's own archetypes sit beside them, each carrying the model and temperature it votes on.
Both council paths resolve their members from that registry: `/api/v1/council` for the
single-round vote, and `POST /api/chat/stream` for the streamed multi-round debate.

**Runtime (orchestration)** — `PlanningEngine` turns a goal into a plan,
`GovernanceEngine` applies constraints, and `TaskExecutor` runs each step with retry,
backoff, and a circuit breaker. All in `@nexus/runtime`.

**Memory** — pgvector stores embeddings; `MemoryGraph` builds a relation graph traversed
with a depth-decayed score; retrieval combines BM25 and RRF. Per-tenant ACL applies.

**Context management** — `MicroCompactor` compacts on a turn or token threshold and keeps
the most recent turns; `LlmCompactor` handles compaction under repeated failures.

**Signal pipeline** — ingest → classify → typed `Signal` rows, with a PostgreSQL
`LISTEN/NOTIFY` path for low-latency consumers.

**Observability** — each request carries an OpenTelemetry trace; audit events are
HMAC-SHA256 chained (tamper-evident); metrics are exposed for Prometheus.

**BYOK keys** — users add their own provider keys on the Provider Keys page. They are
AES-256-GCM encrypted in Postgres and decrypted only server-side to make that user's own
LLM calls; they are never returned to the client.

**Auth hardening (§14)** — access tokens are signed HS256 (shared secret) or RS256
(asymmetric key pair via `NEXUS_JWT_ALG` + `NEXUS_JWT_PRIVATE_KEY`/`NEXUS_JWT_PUBLIC_KEY`,
verified alg-pinned so a downstream service can validate without the signing secret).
Failed logins lock the `email|ip` key with exponential backoff (429 after the threshold),
and every verified JWT is checked against a revocation registry — per-`jti` (log out one
session) or per-subject cutoff (log out everywhere, e.g. after a password change). Users
can erase their own data with `DELETE /api/v1/users/:id/data` — a content-free audit line
(user id + per-table row counts, never LLM/prompt data) records the cascade.

## SDK usage

```typescript
import { AgentRuntime } from "@nexus/agent-runtime";
import { Council } from "@nexus/council";
import { GroqDriver } from "@nexus/llm-drivers";

// Single agent
const agent = new AgentRuntime({ driver: new GroqDriver() });
const result = await agent.run({ task: "Summarise the attached PDF." });

// Multi-model council vote
const council = new Council({
  members: [
    { driver: new GroqDriver(), weight: 1 },
    { driver: new AnthropicDriver(), weight: 2 },
  ],
  mode: "weighted",
});
const { consensus, votes } = await council.deliberate("Should we refactor auth?");

// Memory
import { MemoryManager, InMemoryStore, createBestEmbedder } from "@nexus/memory";
const memory = new MemoryManager({ store: new InMemoryStore(), embedder: createBestEmbedder() });
await memory.remember("Project deadline is June 30", { userId: "u1" });
const hits = await memory.recall("deadline", 5, { userId: "u1" });
```
