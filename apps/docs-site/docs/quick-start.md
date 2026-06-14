---
id: quick-start
title: Quick Start
sidebar_position: 2
---

# Quick Start

Get the full NEXUS stack running locally in under 5 minutes.

## Prerequisites

| Tool    | Version | Install                                           |
| ------- | ------- | ------------------------------------------------- |
| Docker  | 25+     | [docker.com](https://docs.docker.com/get-docker/) |
| Node.js | 20 LTS  | `nvm install 20`                                  |
| pnpm    | 9       | `npm i -g pnpm@9`                                 |
| Python  | 3.11    | `pyenv install 3.11`                              |

## 1. Clone and configure

```bash
git clone https://github.com/Yash-Awasthi/Nexus.git
cd Nexus
cp .env.example .env
```

Open `.env` and set the required values:

```bash
NEXUS_API_KEY=your-local-dev-key
NEXUS_AUDIT_KEY=any-32-char-secret
GROQ_API_KEY=gsk_...          # from console.groq.com
NEXUS_INGEST_API_KEY=local-ingest-key
```

## 2. Start infrastructure

```bash
docker compose up -d postgres redis
```

## 3. Install dependencies and migrate

```bash
pnpm install
pnpm db:migrate
```

## 4. Start all services

```bash
pnpm dev
```

This starts in parallel:

- `nexus-api` → http://localhost:3000
- `nexus-worker` → background process
- `nexus-web` → http://localhost:5173
- `nexus-ingest` → http://localhost:8000

## 5. Verify

```bash
curl http://localhost:3000/health
# {"status":"ok","version":"0.1.0"}

curl http://localhost:3000/health/ready
# {"status":"ready","checks":{"db":"ok"}}
```

## 6. Try it with the CLI

```bash
# Check health
nexus health

# Ingest an event
nexus ingest event \
  --source github \
  --type pr.opened \
  --payload '{"repo":"acme/api","pr":1,"title":"feat: add auth"}' \
  --priority medium

# Run a council deliberation
nexus council deliberate \
  --title "Should we deploy this PR to production?" \
  --budget 0.10
```

## 7. Open the dashboard

Navigate to http://localhost:5173 to see the NEXUS dashboard.

## What's next?

- [Architecture](./architecture) — understand the system design
- [Plugin Author Guide](./plugin-author-guide) — add your own adapter
- [CLI Reference](./cli-reference) — all CLI commands
- [API Reference](./api-reference) — REST API docs
