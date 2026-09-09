<!-- SPDX-License-Identifier: Apache-2.0 -->

<div align="center">

<img src=".github/assets/nexus-logo.svg" alt="NEXUS" width="96" />

# NEXUS

Run, coordinate, and compare large language models from one place.

<p>
  <a href="https://github.com/Yash-Awasthi/Nexus/actions/workflows/test.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/Yash-Awasthi/Nexus/test.yml?branch=main&label=CI&logo=github&style=flat-square" alt="CI">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="License">
  </a>
  <img src="https://img.shields.io/badge/TypeScript-5.6-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node-20+-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/pnpm-9+-f69220?style=flat-square&logo=pnpm&logoColor=white" alt="pnpm">
</p>

<p>
  <a href="#quick-start"><strong>Quick Start</strong></a> ·
  <a href="#features"><strong>Features</strong></a> ·
  <a href="docs/ARCHITECTURE.md"><strong>Architecture</strong></a> ·
  <a href="docs/"><strong>Docs</strong></a> ·
  <a href="https://github.com/Yash-Awasthi/Nexus/issues"><strong>Issues</strong></a>
</p>

</div>

---

## What it is

NEXUS sends the same task to several language models, coordinates multi-step agents,
and keeps memory across sessions — behind a Fastify API, a React dashboard, and
background workers. It is bring-your-own-key: you provide your LLM provider keys and
they stay within your deployment.

It is a TypeScript monorepo (pnpm + Turbo): a handful of apps (`api`, `ui`, `worker`,
`cli`, ingest) and a set of focused `@nexus/*` packages for the runtime, council,
memory, retrieval, drivers, and the rest. This page is a starting point — the
[docs](docs/) and the source go further.

Auth is hardened by default: HS256 or RS256 JWTs (`NEXUS_JWT_ALG`), exponential-backoff
login throttling, per-session / per-user token revocation, and self-service GDPR
erasure (`DELETE /api/v1/users/:id/data`) — see [docs/FEATURES.md](docs/FEATURES.md).

---

## Quick Start

You need **Docker**. For the hot-reload dev setup you also need **Node 22+** and **pnpm 9+**.

### Option A — Docker

```bash
git clone https://github.com/Yash-Awasthi/Nexus.git
cd Nexus

cp .env.example .env
# Set NEXUS_API_KEY and at least one LLM key (e.g. GROQ_API_KEY).
# DATABASE_URL and REDIS_URL are pre-filled for the local stack.

docker compose up
```

| Service | URL                   |
| ------- | --------------------- |
| API     | http://localhost:3000 |
| UI      | http://localhost:4173 |

```bash
curl http://localhost:3000/health   # verify
```

### Option B — Local dev (hot reload)

```bash
git clone https://github.com/Yash-Awasthi/Nexus.git
cd Nexus

pnpm install
docker compose up -d postgres redis     # just the infra

cp .env.example .env                     # set NEXUS_API_KEY + one LLM key
pnpm db:migrate
pnpm dev                                 # API :3000 · UI :5173 · worker
```

Run a single service with `pnpm dev:api` or `pnpm dev:ui`.

Setup not going to plan? See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

### Runtime data layer

Two state backends, both optional in dev:

- **PostgreSQL** (`DATABASE_URL`) — relational data, vector memory, migrations via `pnpm db:migrate`.
- **Redis** (`REDIS_URL`) — BullMQ queues and the **shared KV** that makes research jobs, threads, notifications, and the usage/cost log durable across API restarts and pods.

If no Redis/Upstash is configured, the shared KV falls back to an in-process
memory store — fine for a quick dev spin-up, but **not** durable: data does not
survive an API restart and is not shared across pods. Production needs Redis
(or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`). See
[docs/OPS.md](docs/OPS.md) for the store TTLs, recovery semantics, and health
observability.

---

## Features

### Model intelligence

- **Council deliberation** — send one question to several models in parallel, then blind review, debate, and synthesize a verdict; run A/B model arenas for head-to-head comparison on the same prompts.
- **Multi-provider routing** — OpenAI, Anthropic, Groq, Gemini, Mistral, DeepSeek, Ollama, and more, with health-aware failover, live per-model capability discovery, and tiered response caching (LRU + shared KV, deterministic prompts only — cache hits cost $0 in the usage stats).
- **Bring your own keys** — per-user provider keys on the Provider Keys page, AES-256-GCM encrypted at rest and used server-side only.
- **Cost transparency** — per-model, per-user spend tracking with honest usage accounting.

### Agents & missions

- **Long-horizon missions** — plan → act → review → improve loops with skill execution, deterministic harness pre-execution, and a reviewer that rejects empty or dishonest work.
- **Structured dispatch contract** — every mission worker runs against OBJECTIVE / OUTPUT / TOOLS / BOUNDARIES, folded into the system prompt so the agent acts autonomously within concrete constraints.
- **Escalation-breaker guardrails** — a steer → constrain → stop ladder fed by loop, error-storm, token-velocity, and cost-cap detection; one level per tick, automatic recovery, `hardStop` opt-in, all tunable via `MISSION_BREAKER_*` env vars.
- **Agent-CLI terminal plane** (local installs) — spawn real PTY sessions for Codex, Claude Code, VS Code, OpenCode, and other installed CLIs; stream output over SSE, type into and resize sessions, kill on demand. Hard-gated to loopback so a hosted deployment never exposes process spawning.
- **Sandboxed code execution** — `--network none`, read-only filesystem, memory cap.

### Memory & knowledge

- **Vector + graph retrieval** — store and recall information across sessions; every research run and deliberation is captured as a zero-write-cost session graph.
- **Durable shared state** — research jobs, threads, notifications, and the usage log survive API restarts and span pods via the Redis-backed shared KV.

### Platform

- **Fastify API + React dashboard + BullMQ workers** in one pnpm/Turbo monorepo, with a versioned `/api/v1` surface and OpenAPI spec.
- **Hardened auth** — HS256/RS256 JWTs (alg-pinned), exponential-backoff login throttling, per-session token revocation, and self-service GDPR erasure.
- **Auditable & observable** — HMAC-SHA256-chained audit log, OpenTelemetry traces, health endpoints, Prometheus-ready metrics.
- **Deploy anywhere** — Docker Compose for the full stack, Helm charts for Kubernetes, or single-service deploys (Fly/Railway/Vercel recipes included).
- **Tested** — hermetic unit suites, e2e assertions against the real HTTP surface, and CI (lint + typecheck + tests) on every push.

## Deployment modes

Nexus runs in two modes that differ in what is reachable. The difference is
enforced by the code, not by convention:

| Capability                                                       | Local install (localhost)                                 | Hosted site (deployed API)                                    |
| ---------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| **API + cloud LLM drivers** (OpenAI, Groq, Anthropic, Gemini, …) | ✅                                                        | ✅                                                            |
| **User account login** (register / login / JWT / refresh)        | ✅                                                        | ✅                                                            |
| **Local inference / embeddings (Ollama)**                        | ✅ — `OLLAMA_BASE_URL` (default `http://localhost:11434`) | ⚠️ only if the server itself hosts Ollama                     |
| **Agent-CLI terminal plane** (Codex, Claude Code, VS Code, …)    | ✅ — `/api/local/pty/*`                                   | 🚫 — every route 403s for non-loopback callers (`local_only`) |
| **Missions / council / memory / graphs**                         | ✅                                                        | ✅                                                            |

**The local terminal plane** — the "office of agents" surface — spawns a
real PTY session for an installed CLI (`POST /api/local/pty`), streams its
output over SSE (`GET /api/local/pty/:id/stream`), and drives it with
`write` / `resize` / `DELETE`. It spawns processes on the machine the API runs
on, so it is hard-gated to loopback addresses (`127.*`, `::1`, `::ffff:127.*`)
— a non-loopback caller always gets `403 local_only`, and only explicit
`NEXUS_LOCAL_PTY_FORCE=1` (tests / remote debugging) opens it up.

`GET /api/local/status` reports the live deployment surface — whether this
request is loopback, whether the PTY plane is reachable, which agent CLIs are
installed, and whether the configured Ollama URL answers. On the hosted site
this route itself is the 403 — which _is_ the answer.

**Mission guardrails** are configured via `MISSION_BREAKER_*` env vars
(`MISSION_BREAKER_ENABLED`, `_HARD_STOP`, `_REPEATED_TOOL_LIMIT`,
`_ERROR_STORM_LIMIT`, `_TOKEN_VELOCITY_PER_MIN`, `_COST_CAP_USD`,
`_COST_CAP_TOKENS`). The breaker is on by default, caps at `constrained`
unless `MISSION_BREAKER_HARD_STOP=true`, and annotates any steered/stopped
mission record with its level and reason.

Auth is hardened by default: HS256 or RS256 JWTs (alg-pinned, one shared issuance path for password + OAuth/OIDC/SAML), exponential-backoff login throttling, per-session token revocation, and self-service GDPR erasure.

The capability reference and SDK snippets are in [docs/FEATURES.md](docs/FEATURES.md).

---

## Quality bar

- **623 tests** in the agent-runtime package alone (80%+ line coverage); hundreds more across API, council, memory, and drivers — unit suites are hermetic (no live services).
- **115 e2e assertions** in two suites exercised against the real HTTP surface, plus live proofs for auth (token rotation, lockout, revocation, erasure), rate limiting (atomic under 320 concurrent requests), and durability (restart-survival of every user-facing store).
- CI runs lint, typecheck, and tests on every push; audit log is HMAC-SHA256 chained.

---

## Documentation

| Doc                                                | What's in it                                            |
| -------------------------------------------------- | ------------------------------------------------------- |
| [docs/FEATURES.md](docs/FEATURES.md)               | Capability reference, core concepts, SDK usage          |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)       | System diagram, repository layout, toolchain, ADRs      |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)           | Environment variables, Docker, hosting, observability   |
| [docs/TESTING.md](docs/TESTING.md)                 | Unit, e2e, accessibility, and load testing              |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common setup and dev-server fixes                       |
| [docs/runbook.md](docs/runbook.md)                 | Operations: scaling, incidents, backup/restore          |
| [docs/OPS.md](docs/OPS.md)                         | Health payloads, SSE streams, durable stores, shutdown  |
| [docs/STATUS.md](docs/STATUS.md)                   | Live build status — what works, architecture invariants |
| [ROADMAP.md](ROADMAP.md)                           | Shipped work, external gates, future direction          |
| [CONTRIBUTING.md](CONTRIBUTING.md)                 | Code standards, branch strategy, PR template            |

---

## Common commands

```bash
pnpm dev          # All services in watch mode (or dev:api / dev:ui)
pnpm build        # Build everything
pnpm test         # Vitest suite (pnpm --filter <pkg> test for one package)
pnpm typecheck    # tsc --noEmit across all packages
pnpm lint         # ESLint + Prettier
pnpm db:migrate   # Apply Drizzle migrations
```

---

## Contributing & security

Contributions are welcome — bug fixes, new LLM driver adapters, feed sources, or docs.
Fork, branch, make your changes with tests, run `pnpm typecheck && pnpm test && pnpm lint`,
and open a PR. See [CONTRIBUTING.md](CONTRIBUTING.md).

Code execution runs in a sandbox (`--network none`, read-only filesystem, memory cap).
Audit log entries are HMAC-SHA256 chained, and secrets are read from the environment.
Report vulnerabilities privately via GitHub Security Advisories; see [SECURITY.md](SECURITY.md).

---

## License

[Apache 2.0](LICENSE).

<div align="center">
  <sub>Built by <a href="https://github.com/Yash-Awasthi">Yash Awasthi</a></sub>
</div>
