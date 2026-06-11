# Workspace

Autonomous 18-agent workspace for Yash Awasthi — built on Claude claude-opus-4-6 with adaptive thinking.

## Architecture

```
packages/
  core/           — AgentBase, MessageBus, StateStore, Logger, ToolRegistry
  integrations/   — 14 provider clients (Slack, GitHub, Linear, Neon, Supabase,
                    Groq, Tavily, Cloudflare, Vercel, Doppler, BetterStack,
                    Gmail, Google Calendar, Google Drive)
  orchestrator/   — AgentRegistry, TaskRouter, Orchestrator
  agents/
    researcher    — Web research via Tavily
    coder         — Code generation, review, debug, refactor
    github        — Issues, PRs, workflows
    slack         — Messages, channels, threads
    linear        — Issues, cycles, projects
    deploy        — Vercel + Cloudflare deployments
    database      — Neon + Supabase queries and migrations
    secrets       — Doppler secret management
    email         — Gmail send, reply, search, archive
    calendar      — Google Calendar events + scheduling
    drive         — Google Drive files + sharing
    content       — Content drafting, editing, publishing
    analyst       — Data analysis + Groq fast inference
    monitor       — Better Stack uptime + incident tracking
    scheduler     — Cron tasks + reminders (Neon-backed)
    memory        — Long-term memory store (Neon-backed)
    orchestrator  — LLM-based task decomposition + routing
    yash          — Personal assistant — full routing authority
apps/
  dashboard/      — (planned) Web UI
db/
  migrations/     — 5 SQL migrations for Neon Postgres
  migrate.ts      — Transactional migration runner
```

## Setup

```bash
# Install dependencies
pnpm install

# Copy and fill environment variables
cp .env.example .env

# Run DB migrations
pnpm db:migrate

# Build all packages
pnpm build
```

## Environment Variables

See `.env.example` for all required variables. Key ones:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key |
| `DATABASE_URL` | Neon Postgres connection string |
| `SLACK_BOT_TOKEN` | Slack Bot OAuth token |
| `GITHUB_TOKEN` | GitHub PAT |
| `LINEAR_API_KEY` | Linear API key |
| `GROQ_API_KEY` | Groq API key |
| `TAVILY_API_KEY` | Tavily search API key |
| `DOPPLER_TOKEN` | Doppler service token |
| `BETTERSTACK_API_KEY` | Better Stack API key |
| `CLOUDFLARE_API_KEY` | Cloudflare global API key |
| `VERCEL_TOKEN` | Vercel API token |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Google OAuth refresh token |

## Tech Stack

- **Runtime**: Node.js 22, TypeScript 5.5 (ESM)
- **Monorepo**: pnpm workspaces + Turborepo
- **AI**: Anthropic Claude claude-opus-4-6 with adaptive thinking
- **Database**: Neon Postgres (pg pool)
- **CI**: GitHub Actions (Node 22 + pnpm 9)
