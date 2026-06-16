# SPDX-License-Identifier: Apache-2.0
# @nexus/worker — multi-stage Docker build
# Build: docker build -t nexus-worker -f apps/worker/Dockerfile .

FROM node:26-alpine AS deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.14.4 --activate

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
COPY apps/worker/package.json ./apps/worker/

RUN pnpm install --frozen-lockfile --filter @nexus/worker --filter @nexus/shared \
    --filter @nexus/contracts --filter @nexus/db --filter @nexus/governance \
    --filter @nexus/memory --filter @nexus/pipeline-signal \
    --filter @nexus/runtime --filter @nexus/council --filter @nexus/telemetry

# ─── Stage 2: development — hot-reload via tsx ───────────────────────────────
FROM deps AS development
WORKDIR /app

RUN pnpm install --frozen-lockfile \
    --filter @nexus/worker --filter @nexus/shared \
    --filter @nexus/contracts --filter @nexus/db --filter @nexus/governance \
    --filter @nexus/memory --filter @nexus/pipeline-signal \
    --filter @nexus/runtime --filter @nexus/council --filter @nexus/telemetry

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
    pnpm --filter @nexus/pipeline-signal build && \
    pnpm --filter @nexus/runtime build && \
    pnpm --filter @nexus/council build && \
    pnpm --filter @nexus/worker build

# ─── Stage 3: pruner — production-only node_modules (eliminates devDep CVEs) ──
FROM deps AS pruner
WORKDIR /app
RUN pnpm install --frozen-lockfile --prod \
    --filter @nexus/worker --filter @nexus/shared \
    --filter @nexus/contracts --filter @nexus/db --filter @nexus/governance \
    --filter @nexus/memory --filter @nexus/pipeline-signal \
    --filter @nexus/runtime --filter @nexus/council --filter @nexus/telemetry

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
COPY --from=builder --chown=nexus:nexus /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder --chown=nexus:nexus /app/apps/worker/package.json ./apps/worker/

USER nexus

ENV NODE_ENV=production

# Worker doesn't serve HTTP — no EXPOSE
# Graceful shutdown on SIGTERM
STOPSIGNAL SIGTERM

CMD ["node", "apps/worker/dist/index.js"]
