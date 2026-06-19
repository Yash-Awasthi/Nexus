# SPDX-License-Identifier: Apache-2.0
# @nexus/api — multi-stage Docker build
# Build: docker build -t nexus-api -f apps/api/Dockerfile .
# Run:   docker run -p 3000:3000 --env-file .env nexus-api

# ─── Stage 1: deps ────────────────────────────────────────────────────────────
FROM node:26-alpine AS deps
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
    --filter @nexus/image-transformations

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
    --filter @nexus/image-transformations

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
    pnpm --filter @nexus/api build

# ─── Stage 3: pruner — self-contained prod deploy via pnpm deploy ─────────────
FROM deps AS pruner
WORKDIR /app
RUN pnpm --filter @nexus/api deploy --prod /deploy

# ─── Stage 4: runner ─────────────────────────────────────────────────────────
FROM node:26-alpine AS runner
WORKDIR /app

# Non-root user for security
RUN addgroup -g 1001 nexus && adduser -u 1001 -G nexus -s /bin/sh -D nexus

# Use prod-only node_modules from pruner (no esbuild, vitest, vite, etc.)
COPY --from=pruner --chown=nexus:nexus /deploy/node_modules ./node_modules
COPY --from=builder --chown=nexus:nexus /app/packages/auth/dist ./packages/auth/dist
COPY --from=builder --chown=nexus:nexus /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=nexus:nexus /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder --chown=nexus:nexus /app/packages/db/dist ./packages/db/dist
COPY --from=builder --chown=nexus:nexus /app/packages/governance/dist ./packages/governance/dist
COPY --from=builder --chown=nexus:nexus /app/packages/memory/dist ./packages/memory/dist
COPY --from=builder --chown=nexus:nexus /app/packages/sft-tagger/dist ./packages/sft-tagger/dist
COPY --from=builder --chown=nexus:nexus /app/packages/runtime/dist ./packages/runtime/dist
COPY --from=builder --chown=nexus:nexus /app/packages/council/dist ./packages/council/dist
COPY --from=builder --chown=nexus:nexus /app/packages/telemetry/dist ./packages/telemetry/dist
COPY --from=builder --chown=nexus:nexus /app/packages/adaptive-scraper/dist ./packages/adaptive-scraper/dist
COPY --from=builder --chown=nexus:nexus /app/packages/researcher/dist ./packages/researcher/dist
COPY --from=builder --chown=nexus:nexus /app/packages/image-gen/dist ./packages/image-gen/dist
COPY --from=builder --chown=nexus:nexus /app/packages/knowledge-graph/dist ./packages/knowledge-graph/dist
COPY --from=builder --chown=nexus:nexus /app/packages/llm-drivers/dist ./packages/llm-drivers/dist
COPY --from=builder --chown=nexus:nexus /app/packages/kv/dist ./packages/kv/dist
COPY --from=builder --chown=nexus:nexus /app/packages/tier-gate/dist ./packages/tier-gate/dist
COPY --from=builder --chown=nexus:nexus /app/packages/admin-gateway/dist ./packages/admin-gateway/dist
COPY --from=builder --chown=nexus:nexus /app/packages/agents/dist ./packages/agents/dist
COPY --from=builder --chown=nexus:nexus /app/packages/hooks/dist ./packages/hooks/dist
COPY --from=builder --chown=nexus:nexus /app/packages/alerts/dist ./packages/alerts/dist
COPY --from=builder --chown=nexus:nexus /app/packages/gateway/dist ./packages/gateway/dist
COPY --from=builder --chown=nexus:nexus /app/packages/plugin-sdk/dist ./packages/plugin-sdk/dist
COPY --from=builder --chown=nexus:nexus /app/packages/token-budget/dist ./packages/token-budget/dist
COPY --from=builder --chown=nexus:nexus /app/packages/billing/dist ./packages/billing/dist
COPY --from=builder --chown=nexus:nexus /app/packages/bots/dist ./packages/bots/dist
COPY --from=builder --chown=nexus:nexus /app/packages/connectors/dist ./packages/connectors/dist
COPY --from=builder --chown=nexus:nexus /app/packages/context-pack/dist ./packages/context-pack/dist
COPY --from=builder --chown=nexus:nexus /app/packages/context-pruner/dist ./packages/context-pruner/dist
COPY --from=builder --chown=nexus:nexus /app/packages/doc-pipeline/dist ./packages/doc-pipeline/dist
COPY --from=builder --chown=nexus:nexus /app/packages/evals/dist ./packages/evals/dist
COPY --from=builder --chown=nexus:nexus /app/packages/feature-flags/dist ./packages/feature-flags/dist
COPY --from=builder --chown=nexus:nexus /app/packages/gateway-log/dist ./packages/gateway-log/dist
COPY --from=builder --chown=nexus:nexus /app/packages/lens/dist ./packages/lens/dist
COPY --from=builder --chown=nexus:nexus /app/packages/llm-router/dist ./packages/llm-router/dist
COPY --from=builder --chown=nexus:nexus /app/packages/mail-ingest/dist ./packages/mail-ingest/dist
COPY --from=builder --chown=nexus:nexus /app/packages/nlp-utils/dist ./packages/nlp-utils/dist
COPY --from=builder --chown=nexus:nexus /app/packages/reranker/dist ./packages/reranker/dist
COPY --from=builder --chown=nexus:nexus /app/packages/retrieval/dist ./packages/retrieval/dist
COPY --from=builder --chown=nexus:nexus /app/packages/run-cost/dist ./packages/run-cost/dist
COPY --from=builder --chown=nexus:nexus /app/packages/sse/dist ./packages/sse/dist
COPY --from=builder --chown=nexus:nexus /app/packages/voice/dist ./packages/voice/dist
COPY --from=builder --chown=nexus:nexus /app/packages/domain-feeds/dist ./packages/domain-feeds/dist
COPY --from=builder --chown=nexus:nexus /app/packages/obs-providers/dist ./packages/obs-providers/dist
COPY --from=builder --chown=nexus:nexus /app/packages/wiki-updater/dist ./packages/wiki-updater/dist
COPY --from=builder --chown=nexus:nexus /app/packages/image-transformations/dist ./packages/image-transformations/dist
COPY --from=builder --chown=nexus:nexus /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=nexus:nexus /app/apps/api/package.json ./apps/api/

USER nexus

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "apps/api/dist/index.js"]
