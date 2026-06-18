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
COPY packages/autotune/package.json ./packages/autotune/
COPY packages/parseltongue/package.json ./packages/parseltongue/
COPY packages/sft-tagger/package.json ./packages/sft-tagger/
COPY packages/runtime/package.json ./packages/runtime/
COPY packages/council/package.json ./packages/council/
COPY packages/telemetry/package.json ./packages/telemetry/
COPY packages/adaptive-scraper/package.json ./packages/adaptive-scraper/
COPY packages/researcher/package.json ./packages/researcher/
COPY packages/image-gen/package.json ./packages/image-gen/
COPY packages/knowledge-graph/package.json ./packages/knowledge-graph/
COPY packages/llm-drivers/package.json ./packages/llm-drivers/
COPY packages/ultraplinian/package.json ./packages/ultraplinian/
COPY packages/ghoststack/package.json ./packages/ghoststack/
COPY apps/api/package.json ./apps/api/

RUN pnpm install --frozen-lockfile --filter @nexus/api --filter @nexus/auth \
    --filter @nexus/shared --filter @nexus/contracts --filter @nexus/db \
    --filter @nexus/governance --filter @nexus/memory \
    --filter @nexus/drift --filter @nexus/redteam --filter @nexus/sft-tagger \
    --filter @nexus/runtime --filter @nexus/council --filter @nexus/telemetry \
    --filter @nexus/adaptive-scraper --filter @nexus/researcher \
    --filter @nexus/image-gen --filter @nexus/knowledge-graph \
    --filter @nexus/llm-drivers --filter @nexus/gauntlet \
    --filter @nexus/conductor

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
    --filter @nexus/llm-drivers --filter @nexus/gauntlet \
    --filter @nexus/conductor

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
    pnpm --filter @nexus/api build

# ─── Stage 3: pruner — production-only node_modules (eliminates devDep CVEs) ──
FROM deps AS pruner
WORKDIR /app
RUN pnpm install --frozen-lockfile --prod \
    --filter @nexus/api --filter @nexus/auth --filter @nexus/shared \
    --filter @nexus/contracts --filter @nexus/db --filter @nexus/governance \
    --filter @nexus/memory --filter @nexus/drift --filter @nexus/redteam \
    --filter @nexus/sft-tagger --filter @nexus/runtime --filter @nexus/council \
    --filter @nexus/telemetry --filter @nexus/adaptive-scraper \
    --filter @nexus/researcher --filter @nexus/image-gen \
    --filter @nexus/knowledge-graph --filter @nexus/llm-drivers \
    --filter @nexus/gauntlet \
    --filter @nexus/conductor

# ─── Stage 4: runner ─────────────────────────────────────────────────────────
FROM node:26-alpine AS runner
WORKDIR /app

# Non-root user for security
RUN addgroup -g 1001 nexus && adduser -u 1001 -G nexus -s /bin/sh -D nexus

# Use prod-only node_modules from pruner (no esbuild, vitest, vite, etc.)
COPY --from=pruner --chown=nexus:nexus /app/node_modules ./node_modules
COPY --from=builder --chown=nexus:nexus /app/packages/auth/dist ./packages/auth/dist
COPY --from=builder --chown=nexus:nexus /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=nexus:nexus /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder --chown=nexus:nexus /app/packages/db/dist ./packages/db/dist
COPY --from=builder --chown=nexus:nexus /app/packages/governance/dist ./packages/governance/dist
COPY --from=builder --chown=nexus:nexus /app/packages/memory/dist ./packages/memory/dist
COPY --from=builder --chown=nexus:nexus /app/packages/autotune/dist ./packages/autotune/dist
COPY --from=builder --chown=nexus:nexus /app/packages/parseltongue/dist ./packages/parseltongue/dist
COPY --from=builder --chown=nexus:nexus /app/packages/sft-tagger/dist ./packages/sft-tagger/dist
COPY --from=builder --chown=nexus:nexus /app/packages/runtime/dist ./packages/runtime/dist
COPY --from=builder --chown=nexus:nexus /app/packages/council/dist ./packages/council/dist
COPY --from=builder --chown=nexus:nexus /app/packages/telemetry/dist ./packages/telemetry/dist
COPY --from=builder --chown=nexus:nexus /app/packages/adaptive-scraper/dist ./packages/adaptive-scraper/dist
COPY --from=builder --chown=nexus:nexus /app/packages/researcher/dist ./packages/researcher/dist
COPY --from=builder --chown=nexus:nexus /app/packages/image-gen/dist ./packages/image-gen/dist
COPY --from=builder --chown=nexus:nexus /app/packages/knowledge-graph/dist ./packages/knowledge-graph/dist
COPY --from=builder --chown=nexus:nexus /app/packages/llm-drivers/dist ./packages/llm-drivers/dist
COPY --from=builder --chown=nexus:nexus /app/packages/ultraplinian/dist ./packages/ultraplinian/dist
COPY --from=builder --chown=nexus:nexus /app/packages/ghoststack/dist ./packages/ghoststack/dist
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
