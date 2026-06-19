# SPDX-License-Identifier: Apache-2.0
# @nexus/api — multi-stage Docker build
# Build: docker build -t nexus-api -f apps/api/Dockerfile .
# Run:   docker run -p 3000:3000 --env-file .env nexus-api

# ─── Stage 1: deps ────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@9.14.4 --no-fund --no-audit

# Copy workspace manifests (needed for pnpm workspaces)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY turbo.json ./

# Copy all package.json files (needed for pnpm to resolve workspace deps)
COPY packages/auth/package.json ./packages/auth/
COPY packages/shared/package.json ./packages/shared/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/db/package.json ./packages/db/
COPY packages/governance/package.json ./packages/governance/
COPY packages/memory/package.json ./packages/memory/
COPY packages/sft-tagger/package.json ./packages/sft-tagger/
COPY packages/runtime/package.json ./packages/runtime/
COPY packages/council/package.json ./packages/council/
COPY packages/telemetry/package.json ./packages/telemetry/
COPY packages/adaptive-scraper/package.json ./packages/adaptive-scraper/
COPY packages/researcher/package.json ./packages/researcher/
COPY packages/image-gen/package.json ./packages/image-gen/
COPY packages/knowledge-graph/package.json ./packages/knowledge-graph/
COPY packages/llm-drivers/package.json ./packages/llm-drivers/
COPY packages/drift/package.json ./packages/drift/
COPY packages/redteam/package.json ./packages/redteam/
COPY packages/gauntlet/package.json ./packages/gauntlet/
COPY packages/conductor/package.json ./packages/conductor/
COPY packages/kv/package.json ./packages/kv/
COPY packages/tier-gate/package.json ./packages/tier-gate/
COPY packages/admin-gateway/package.json ./packages/admin-gateway/
COPY packages/agents/package.json ./packages/agents/
COPY packages/hooks/package.json ./packages/hooks/
COPY packages/alerts/package.json ./packages/alerts/
COPY packages/gateway/package.json ./packages/gateway/
COPY packages/plugin-sdk/package.json ./packages/plugin-sdk/
COPY packages/token-budget/package.json ./packages/token-budget/
COPY packages/billing/package.json ./packages/billing/
COPY packages/bots/package.json ./packages/bots/
COPY packages/connectors/package.json ./packages/connectors/
COPY packages/context-pack/package.json ./packages/context-pack/
COPY packages/context-pruner/package.json ./packages/context-pruner/
COPY packages/doc-pipeline/package.json ./packages/doc-pipeline/
COPY packages/evals/package.json ./packages/evals/
COPY packages/feature-flags/package.json ./packages/feature-flags/
COPY packages/gateway-log/package.json ./packages/gateway-log/
COPY packages/lens/package.json ./packages/lens/
COPY packages/llm-router/package.json ./packages/llm-router/
COPY packages/mail-ingest/package.json ./packages/mail-ingest/
COPY packages/nlp-utils/package.json ./packages/nlp-utils/
COPY packages/reranker/package.json ./packages/reranker/
COPY packages/retrieval/package.json ./packages/retrieval/
COPY packages/run-cost/package.json ./packages/run-cost/
COPY packages/sse/package.json ./packages/sse/
COPY packages/voice/package.json ./packages/voice/
COPY packages/domain-feeds/package.json ./packages/domain-feeds/
COPY packages/obs-providers/package.json ./packages/obs-providers/
COPY packages/wiki-updater/package.json ./packages/wiki-updater/
COPY packages/image-transformations/package.json ./packages/image-transformations/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/brief-engine/package.json ./packages/brief-engine/
COPY packages/chat-analyst/package.json ./packages/chat-analyst/
COPY packages/code-repl/package.json ./packages/code-repl/
COPY packages/domain-forecast/package.json ./packages/domain-forecast/
COPY packages/geoip/package.json ./packages/geoip/
COPY packages/hf-research/package.json ./packages/hf-research/
COPY packages/i18n/package.json ./packages/i18n/
COPY packages/llm-tracer/package.json ./packages/llm-tracer/
COPY packages/posthog-analytics/package.json ./packages/posthog-analytics/
COPY packages/prediction-market/package.json ./packages/prediction-market/
COPY packages/rlhf-pipeline/package.json ./packages/rlhf-pipeline/
COPY packages/scenario-planner/package.json ./packages/scenario-planner/
COPY packages/scraping-mcp/package.json ./packages/scraping-mcp/
COPY packages/session-sync/package.json ./packages/session-sync/
COPY packages/stealth-browser/package.json ./packages/stealth-browser/
COPY packages/stm/package.json ./packages/stm/
COPY packages/stream-recovery/package.json ./packages/stream-recovery/
COPY packages/supervisor/package.json ./packages/supervisor/
COPY packages/think-parser/package.json ./packages/think-parser/
COPY packages/tool-registry/package.json ./packages/tool-registry/
COPY packages/video-search/package.json ./packages/video-search/
COPY packages/wiki/package.json ./packages/wiki/
COPY packages/autotune/package.json ./packages/autotune/
COPY packages/parseltongue/package.json ./packages/parseltongue/
COPY packages/ragtime/package.json ./packages/ragtime/
COPY packages/ultraplinian/package.json ./packages/ultraplinian/
COPY apps/api/package.json ./apps/api/

RUN pnpm install --frozen-lockfile --filter @nexus/api --filter @nexus/auth \
    --filter @nexus/shared --filter @nexus/contracts --filter @nexus/db \
    --filter @nexus/governance --filter @nexus/memory \
    --filter @nexus/drift --filter @nexus/redteam --filter @nexus/sft-tagger \
    --filter @nexus/runtime --filter @nexus/council --filter @nexus/telemetry \
    --filter @nexus/adaptive-scraper --filter @nexus/researcher \
    --filter @nexus/image-gen --filter @nexus/knowledge-graph \
    --filter @nexus/llm-drivers --filter @nexus/gauntlet --filter @nexus/conductor \
    --filter @nexus/kv --filter @nexus/tier-gate --filter @nexus/admin-gateway \
    --filter @nexus/agents --filter @nexus/hooks --filter @nexus/alerts \
    --filter @nexus/gateway --filter @nexus/plugin-sdk --filter @nexus/token-budget \
    --filter @nexus/billing --filter @nexus/bots --filter @nexus/connectors \
    --filter @nexus/context-pack --filter @nexus/context-pruner \
    --filter @nexus/doc-pipeline --filter @nexus/evals \
    --filter @nexus/feature-flags --filter @nexus/gateway-log \
    --filter @nexus/lens --filter @nexus/llm-router --filter @nexus/mail-ingest \
    --filter @nexus/nlp-utils --filter @nexus/reranker --filter @nexus/retrieval \
    --filter @nexus/run-cost --filter @nexus/sse --filter @nexus/voice \
    --filter @nexus/domain-feeds --filter @nexus/obs-providers --filter @nexus/wiki-updater \
    --filter @nexus/image-transformations \
    --filter @nexus/llm-tracer --filter @nexus/posthog-analytics --filter @nexus/stm \
    --filter @nexus/agent-runtime --filter @nexus/brief-engine --filter @nexus/chat-analyst \
    --filter @nexus/code-repl --filter @nexus/domain-forecast --filter @nexus/geoip \
    --filter @nexus/hf-research --filter @nexus/i18n --filter @nexus/prediction-market \
    --filter @nexus/rlhf-pipeline --filter @nexus/scenario-planner --filter @nexus/scraping-mcp \
    --filter @nexus/session-sync --filter @nexus/stealth-browser --filter @nexus/stream-recovery \
    --filter @nexus/supervisor --filter @nexus/think-parser --filter @nexus/tool-registry \
    --filter @nexus/video-search --filter @nexus/wiki \
    --filter @nexus/autotune --filter @nexus/parseltongue --filter @nexus/ragtime \
    --filter @nexus/ultraplinian

# ─── Stage 2: development — hot-reload via tsx (no compiled dist needed) ─────
FROM deps AS development
WORKDIR /app

# Install devDependencies (tsx + TypeScript compiler)
RUN pnpm install --frozen-lockfile \
    --filter @nexus/api --filter @nexus/auth \
    --filter @nexus/shared --filter @nexus/contracts --filter @nexus/db \
    --filter @nexus/governance --filter @nexus/memory \
    --filter @nexus/drift --filter @nexus/redteam --filter @nexus/sft-tagger \
    --filter @nexus/runtime --filter @nexus/council --filter @nexus/telemetry \
    --filter @nexus/adaptive-scraper --filter @nexus/researcher \
    --filter @nexus/image-gen --filter @nexus/knowledge-graph \
    --filter @nexus/llm-drivers --filter @nexus/gauntlet --filter @nexus/conductor \
    --filter @nexus/kv --filter @nexus/tier-gate --filter @nexus/admin-gateway \
    --filter @nexus/agents --filter @nexus/hooks --filter @nexus/alerts \
    --filter @nexus/gateway --filter @nexus/plugin-sdk --filter @nexus/token-budget \
    --filter @nexus/billing --filter @nexus/bots --filter @nexus/connectors \
    --filter @nexus/context-pack --filter @nexus/context-pruner \
    --filter @nexus/doc-pipeline --filter @nexus/evals \
    --filter @nexus/feature-flags --filter @nexus/gateway-log \
    --filter @nexus/lens --filter @nexus/llm-router --filter @nexus/mail-ingest \
    --filter @nexus/nlp-utils --filter @nexus/reranker --filter @nexus/retrieval \
    --filter @nexus/run-cost --filter @nexus/sse --filter @nexus/voice \
    --filter @nexus/domain-feeds --filter @nexus/obs-providers --filter @nexus/wiki-updater \
    --filter @nexus/image-transformations \
    --filter @nexus/llm-tracer --filter @nexus/posthog-analytics --filter @nexus/stm \
    --filter @nexus/agent-runtime --filter @nexus/brief-engine --filter @nexus/chat-analyst \
    --filter @nexus/code-repl --filter @nexus/domain-forecast --filter @nexus/geoip \
    --filter @nexus/hf-research --filter @nexus/i18n --filter @nexus/prediction-market \
    --filter @nexus/rlhf-pipeline --filter @nexus/scenario-planner --filter @nexus/scraping-mcp \
    --filter @nexus/session-sync --filter @nexus/stealth-browser --filter @nexus/stream-recovery \
    --filter @nexus/supervisor --filter @nexus/think-parser --filter @nexus/tool-registry \
    --filter @nexus/video-search --filter @nexus/wiki \
    --filter @nexus/autotune --filter @nexus/parseltongue --filter @nexus/ragtime \
    --filter @nexus/ultraplinian

# Source is bind-mounted at runtime — no COPY here
ENV NODE_ENV=development
EXPOSE 3000 9229
CMD ["node", "--inspect=0.0.0.0:9229", \
     "--import", "tsx/esm", \
     "--watch", "apps/api/src/index.ts"]

# ─── Stage 3: builder ────────────────────────────────────────────────────────
FROM deps AS builder
WORKDIR /app

COPY packages/ ./packages/
COPY apps/api/ ./apps/api/
COPY tsconfig.base.json ./

RUN pnpm --filter @nexus/shared build && \
    pnpm --filter @nexus/contracts build && \
    pnpm --filter @nexus/db build && \
    pnpm --filter @nexus/telemetry build && \
    pnpm --filter @nexus/governance build && \
    pnpm --filter @nexus/memory build && \
    pnpm --filter @nexus/drift build && \
    pnpm --filter @nexus/redteam build && \
    pnpm --filter @nexus/sft-tagger build && \
    pnpm --filter @nexus/runtime build && \
    pnpm --filter @nexus/council build && \
    pnpm --filter @nexus/auth build && \
    pnpm --filter @nexus/adaptive-scraper build && \
    pnpm --filter @nexus/researcher build && \
    pnpm --filter @nexus/image-gen build && \
    pnpm --filter @nexus/knowledge-graph build && \
    pnpm --filter @nexus/llm-drivers build && \
    pnpm --filter @nexus/gauntlet build && \
    pnpm --filter @nexus/conductor build && \
    pnpm --filter @nexus/kv build && \
    pnpm --filter @nexus/tier-gate build && \
    pnpm --filter @nexus/admin-gateway build && \
    pnpm --filter @nexus/agents build && \
    pnpm --filter @nexus/hooks build && \
    pnpm --filter @nexus/alerts build && \
    pnpm --filter @nexus/gateway build && \
    pnpm --filter @nexus/plugin-sdk build && \
    pnpm --filter @nexus/token-budget build && \
    pnpm --filter @nexus/billing build && \
    pnpm --filter @nexus/bots build && \
    pnpm --filter @nexus/connectors build && \
    pnpm --filter @nexus/context-pack build && \
    pnpm --filter @nexus/context-pruner build && \
    pnpm --filter @nexus/doc-pipeline build && \
    pnpm --filter @nexus/evals build && \
    pnpm --filter @nexus/feature-flags build && \
    pnpm --filter @nexus/gateway-log build && \
    pnpm --filter @nexus/lens build && \
    pnpm --filter @nexus/llm-router build && \
    pnpm --filter @nexus/mail-ingest build && \
    pnpm --filter @nexus/nlp-utils build && \
    pnpm --filter @nexus/reranker build && \
    pnpm --filter @nexus/retrieval build && \
    pnpm --filter @nexus/run-cost build && \
    pnpm --filter @nexus/sse build && \
    pnpm --filter @nexus/voice build && \
    pnpm --filter @nexus/domain-feeds build && \
    pnpm --filter @nexus/obs-providers build && \
    pnpm --filter @nexus/wiki-updater build && \
    pnpm --filter @nexus/image-transformations build && \
    pnpm --filter @nexus/llm-tracer build && \
    pnpm --filter @nexus/posthog-analytics build && \
    pnpm --filter @nexus/stm build && \
    pnpm --filter @nexus/agent-runtime build && \
    pnpm --filter @nexus/brief-engine build && \
    pnpm --filter @nexus/chat-analyst build && \
    pnpm --filter @nexus/code-repl build && \
    pnpm --filter @nexus/domain-forecast build && \
    pnpm --filter @nexus/geoip build && \
    pnpm --filter @nexus/hf-research build && \
    pnpm --filter @nexus/i18n build && \
    pnpm --filter @nexus/prediction-market build && \
    pnpm --filter @nexus/rlhf-pipeline build && \
    pnpm --filter @nexus/scenario-planner build && \
    pnpm --filter @nexus/scraping-mcp build && \
    pnpm --filter @nexus/session-sync build && \
    pnpm --filter @nexus/stealth-browser build && \
    pnpm --filter @nexus/stream-recovery build && \
    pnpm --filter @nexus/supervisor build && \
    pnpm --filter @nexus/think-parser build && \
    pnpm --filter @nexus/tool-registry build && \
    pnpm --filter @nexus/video-search build && \
    pnpm --filter @nexus/wiki build && \
    pnpm --filter @nexus/autotune build && \
    pnpm --filter @nexus/parseltongue build && \
    pnpm --filter @nexus/ragtime build && \
    pnpm --filter @nexus/ultraplinian build && \
    pnpm --filter @nexus/api build

# ─── Stage 3: pruner — pnpm deploy FROM builder so workspace dist/ files exist ─
# Critical: must base on builder, not deps. pnpm deploy copies workspace packages
# including their compiled dist/ — if based on deps, workspace dist/ is absent and
# node cannot resolve @nexus/* imports at runtime → container exits → update_failed.
FROM builder AS pruner
WORKDIR /app
RUN pnpm --filter @nexus/api deploy --prod /deploy

# ─── Stage 4: runner ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

# Non-root user for security
RUN addgroup -g 1001 nexus && adduser -u 1001 -G nexus -s /bin/sh -D nexus

# /deploy contains: dist/ (api compiled output) + node_modules/ (all runtime deps
# including workspace packages with their dist/ files intact — no symlinks)
COPY --from=pruner --chown=nexus:nexus /deploy ./

USER nexus

ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "dist/index.js"]
