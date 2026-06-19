# SPDX-License-Identifier: Apache-2.0
# @nexus/worker — multi-stage Docker build
# Build: docker build -t nexus-worker -f apps/worker/Dockerfile .

FROM node:26-alpine AS deps
WORKDIR /app

RUN npm install -g pnpm@9.14.4 --no-fund --no-audit

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY turbo.json ./

COPY packages/shared/package.json ./packages/shared/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/db/package.json ./packages/db/
COPY packages/governance/package.json ./packages/governance/
COPY packages/memory/package.json ./packages/memory/
COPY packages/pipeline-signal/package.json ./packages/pipeline-signal/
COPY packages/runtime/package.json ./packages/runtime/
COPY packages/council/package.json ./packages/council/
COPY packages/telemetry/package.json ./packages/telemetry/
COPY packages/corpus-builder/package.json ./packages/corpus-builder/
COPY packages/domain-feeds/package.json ./packages/domain-feeds/
COPY packages/hybrid-search/package.json ./packages/hybrid-search/
COPY packages/llm-drivers/package.json ./packages/llm-drivers/
COPY packages/obs-providers/package.json ./packages/obs-providers/
COPY packages/search-orchestrator/package.json ./packages/search-orchestrator/
COPY packages/wiki-updater/package.json ./packages/wiki-updater/
COPY apps/worker/package.json ./apps/worker/

RUN pnpm install --frozen-lockfile --filter @nexus/worker --filter @nexus/shared \
    --filter @nexus/contracts --filter @nexus/db --filter @nexus/governance \
    --filter @nexus/memory --filter @nexus/pipeline-signal \
    --filter @nexus/runtime --filter @nexus/council --filter @nexus/telemetry \
    --filter @nexus/corpus-builder --filter @nexus/domain-feeds \
    --filter @nexus/hybrid-search --filter @nexus/llm-drivers \
    --filter @nexus/obs-providers --filter @nexus/search-orchestrator \
    --filter @nexus/wiki-updater

# ─── Stage 2: development — hot-reload via tsx ───────────────────────────────
FROM deps AS development
WORKDIR /app

RUN pnpm install --frozen-lockfile \
    --filter @nexus/worker --filter @nexus/shared \
    --filter @nexus/contracts --filter @nexus/db --filter @nexus/governance \
    --filter @nexus/memory --filter @nexus/pipeline-signal \
    --filter @nexus/runtime --filter @nexus/council --filter @nexus/telemetry \
    --filter @nexus/corpus-builder --filter @nexus/domain-feeds \
    --filter @nexus/hybrid-search --filter @nexus/llm-drivers \
    --filter @nexus/obs-providers --filter @nexus/search-orchestrator \
    --filter @nexus/wiki-updater

ENV NODE_ENV=development
EXPOSE 9229
CMD ["node", "--inspect=0.0.0.0:9229", \
     "--import", "tsx/esm", \
     "--watch", "apps/worker/src/index.ts"]

# ─── Stage 3: builder ────────────────────────────────────────────────────────
FROM deps AS builder
WORKDIR /app

COPY packages/ ./packages/
COPY apps/worker/ ./apps/worker/
COPY tsconfig.base.json ./

RUN pnpm --filter @nexus/shared build && \
    pnpm --filter @nexus/contracts build && \
    pnpm --filter @nexus/db build && \
    pnpm --filter @nexus/telemetry build && \
    pnpm --filter @nexus/governance build && \
    pnpm --filter @nexus/memory build && \
    pnpm --filter @nexus/hybrid-search build && \
    pnpm --filter @nexus/llm-drivers build && \
    pnpm --filter @nexus/pipeline-signal build && \
    pnpm --filter @nexus/runtime build && \
    pnpm --filter @nexus/council build && \
    pnpm --filter @nexus/corpus-builder build && \
    pnpm --filter @nexus/domain-feeds build && \
    pnpm --filter @nexus/obs-providers build && \
    pnpm --filter @nexus/search-orchestrator build && \
    pnpm --filter @nexus/wiki-updater build && \
    pnpm --filter @nexus/worker build

# ─── Stage 3: pruner — production-only node_modules (eliminates devDep CVEs) ──
FROM deps AS pruner
WORKDIR /app
RUN pnpm install --frozen-lockfile --prod \
    --filter @nexus/worker --filter @nexus/shared \
    --filter @nexus/contracts --filter @nexus/db --filter @nexus/governance \
    --filter @nexus/memory --filter @nexus/pipeline-signal \
    --filter @nexus/runtime --filter @nexus/council --filter @nexus/telemetry \
    --filter @nexus/corpus-builder --filter @nexus/domain-feeds \
    --filter @nexus/hybrid-search --filter @nexus/llm-drivers \
    --filter @nexus/obs-providers --filter @nexus/search-orchestrator \
    --filter @nexus/wiki-updater

# ─── Stage 4: runner ─────────────────────────────────────────────────────────
FROM node:26-alpine AS runner
WORKDIR /app

RUN addgroup -g 1001 nexus && adduser -u 1001 -G nexus -s /bin/sh -D nexus

# Use prod-only node_modules from pruner (no esbuild, vitest, vite, etc.)
COPY --from=pruner --chown=nexus:nexus /app/node_modules ./node_modules
COPY --from=builder --chown=nexus:nexus /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=nexus:nexus /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder --chown=nexus:nexus /app/packages/db/dist ./packages/db/dist
COPY --from=builder --chown=nexus:nexus /app/packages/governance/dist ./packages/governance/dist
COPY --from=builder --chown=nexus:nexus /app/packages/memory/dist ./packages/memory/dist
COPY --from=builder --chown=nexus:nexus /app/packages/pipeline-signal/dist ./packages/pipeline-signal/dist
COPY --from=builder --chown=nexus:nexus /app/packages/runtime/dist ./packages/runtime/dist
COPY --from=builder --chown=nexus:nexus /app/packages/council/dist ./packages/council/dist
COPY --from=builder --chown=nexus:nexus /app/packages/telemetry/dist ./packages/telemetry/dist
COPY --from=builder --chown=nexus:nexus /app/packages/corpus-builder/dist ./packages/corpus-builder/dist
COPY --from=builder --chown=nexus:nexus /app/packages/domain-feeds/dist ./packages/domain-feeds/dist
COPY --from=builder --chown=nexus:nexus /app/packages/hybrid-search/dist ./packages/hybrid-search/dist
COPY --from=builder --chown=nexus:nexus /app/packages/llm-drivers/dist ./packages/llm-drivers/dist
COPY --from=builder --chown=nexus:nexus /app/packages/obs-providers/dist ./packages/obs-providers/dist
COPY --from=builder --chown=nexus:nexus /app/packages/search-orchestrator/dist ./packages/search-orchestrator/dist
COPY --from=builder --chown=nexus:nexus /app/packages/wiki-updater/dist ./packages/wiki-updater/dist
COPY --from=builder --chown=nexus:nexus /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder --chown=nexus:nexus /app/apps/worker/package.json ./apps/worker/

USER nexus

ENV NODE_ENV=production

# Worker doesn't serve HTTP — no EXPOSE
# Graceful shutdown on SIGTERM
STOPSIGNAL SIGTERM

CMD ["node", "apps/worker/dist/index.js"]
