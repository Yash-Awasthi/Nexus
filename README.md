<!-- SPDX-License-Identifier: Apache-2.0 -->

<div align="center">

<img src="apps/docs-site/static/img/nexus-logo.svg" alt="NEXUS" width="96" />

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
  <a href="docs/FEATURES.md"><strong>Features</strong></a> ·
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

---

## Quick Start

You need **Docker**. For the hot-reload dev setup you also need **Node 20+** and **pnpm 9+**.

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

Setup not going to plan? See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

---

## What you can do with it

- Send one question to several models in parallel and combine their answers (council).
- Run multi-step, tool-using agents.
- Store and recall information across sessions with vector and graph retrieval.
- Compare models against the same prompts.
- Add your own provider keys on the Provider Keys page — encrypted at rest, used
  server-side only.

The capability reference and SDK snippets are in [docs/FEATURES.md](docs/FEATURES.md).

---

## Documentation

| Doc                                                | What's in it                                          |
| -------------------------------------------------- | ----------------------------------------------------- |
| [docs/FEATURES.md](docs/FEATURES.md)               | Capability reference, core concepts, SDK usage        |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)       | System diagram, repository layout, toolchain, ADRs    |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)           | Environment variables, Docker, hosting, observability |
| [docs/TESTING.md](docs/TESTING.md)                 | Unit, e2e, accessibility, and load testing            |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common setup and dev-server fixes                     |
| [docs/runbook.md](docs/runbook.md)                 | Operations: scaling, incidents, backup/restore        |
| [CONTRIBUTING.md](CONTRIBUTING.md)                 | Code standards, branch strategy, PR template          |

The docs site (Docusaurus) lives in `apps/docs-site/`.

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
