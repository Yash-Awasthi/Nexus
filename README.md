<!-- SPDX-License-Identifier: Apache-2.0 -->

<div align="center">

<img src="apps/docs-site/static/img/nexus-logo.svg" alt="NEXUS" width="96" />

# NEXUS

**Multi-agent AI orchestration — from a single prompt to a self-coordinating swarm.**

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
  <a href="docs/FEATURES.md"><strong>Features</strong></a> ·
  <a href="docs/ARCHITECTURE.md"><strong>Architecture</strong></a> ·
  <a href="docs/"><strong>Docs</strong></a> ·
  <a href="https://github.com/Yash-Awasthi/Nexus/issues"><strong>Issues</strong></a>
</p>

</div>

---

## What is NEXUS?

NEXUS asks **many AI models the same question at once**, lets them deliberate, and
returns one synthesised answer — with long-term memory, sandboxed code execution, and
document ingestion behind it, all driven from a React dashboard.

It's **bring-your-own-key (BYOK)**: connect your own LLM API keys and nothing leaves your
deployment.

Under the hood it's a 110-package TypeScript monorepo (pnpm + Turbo): a Fastify API, a
React Router 7 UI, BullMQ workers, and ~100 focused `@nexus/*` packages. New here? Start
below, then skim [docs/FEATURES.md](docs/FEATURES.md).

---

## Quick Start

You need **Docker**. For the hot-reload dev setup you also need **Node 20+** and **pnpm 9+**.

### Option A — Docker (simplest, no Node required)

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
curl http://localhost:3000/api/v1/health   # verify
```

### Option B — Local dev (hot reload)

```bash
git clone https://github.com/Yash-Awasthi/Nexus.git
cd Nexus

pnpm install
docker compose up -d postgres redis     # just the infra

cp .env.example .env                     # set NEXUS_API_KEY + one LLM key
pnpm db:migrate
pnpm dev                                 # API :3001 · UI :5173 · worker
```

Run a single service with `pnpm dev:api` or `pnpm dev:ui`.

First run not going to plan? See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

---

## What can you do with it?

- **Ask a council** — pose a question and watch N models answer in parallel, then get a
  single voted/synthesised verdict.
- **Run agents** — multi-step tool-using agents (and swarms) that plan, execute, and loop.
- **Give it memory** — store and recall facts with vector + graph retrieval across sessions.
- **Race models** — the Gauntlet pits dozens of models against each other and scores them.
- **Bring your own keys** — add provider keys on the Provider Keys page; they're encrypted
  at rest and only ever used server-side.

A full capability list and SDK snippets are in [docs/FEATURES.md](docs/FEATURES.md).

---

## Documentation

| Doc                                                | What's in it                                               |
| -------------------------------------------------- | ---------------------------------------------------------- |
| [docs/FEATURES.md](docs/FEATURES.md)               | Full capability reference, core concepts, SDK usage        |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)       | System diagram, repository layout, toolchain, ADR index    |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)           | Env vars, Render+Vercel, Docker, Kubernetes, observability |
| [docs/TESTING.md](docs/TESTING.md)                 | Unit, e2e, a11y, load (k6), and chaos testing              |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common setup and dev-server fixes                          |
| [docs/runbook.md](docs/runbook.md)                 | Day-2 operations: scaling, incidents, backup/DR            |
| [FUTURE_CONTRIBUTION.md](FUTURE_CONTRIBUTION.md)   | Roadmap and where to contribute                            |
| [CONTRIBUTING.md](CONTRIBUTING.md)                 | Code standards, branch strategy, PR template               |

The full docs site (Docusaurus) lives in `apps/docs-site/`.

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

Contributions welcome — bug fixes, new LLM driver adapters, domain feed sources, or docs.
Fork, branch, make changes with tests, run `pnpm typecheck && pnpm test && pnpm lint`, and
open a PR. See [CONTRIBUTING.md](CONTRIBUTING.md).

Security: code execution is sandboxed (`--network none`, `--read-only`, 256 MB cap), the
audit log is HMAC-SHA256 chained (tamper-evident), and all secrets come from the
environment. Threat model: [docs/security/threat-model.md](docs/security/threat-model.md).
Report vulnerabilities privately via GitHub Security Advisories.

---

## License

[Apache 2.0](LICENSE) — free to use, modify, and distribute. Attribution appreciated.

<div align="center">
  <sub>Built by <a href="https://github.com/Yash-Awasthi">Yash Awasthi</a> · Apache 2.0</sub>
</div>
