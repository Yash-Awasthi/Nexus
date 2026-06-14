# SPDX-License-Identifier: Apache-2.0
# @nexus/api — multi-stage Docker build
# Build: docker build -t nexus-api -f apps/api/Dockerfile .
# Run:   docker run -p 3000:3000 --env-file .env nexus-api

# ─── Stage 1: deps ────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.14.4 --activate

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
COPY packages/runtime/package.json ./packages/runtime/
COPY packages/council/package.json ./packages/council/
COPY packages/telemetry/package.json ./packages/telemetry/
COPY apps/api/package.json ./apps/api/

RUN pnpm install --frozen-lockfile --filter @nexus/api --filter @nexus/auth \
    --filter @nexus/shared --filter @nexus/contracts --filter @nexus/db \
    --filter @nexus/governance --filter @nexus/memory \
    --filter @nexus/runtime --filter @nexus/council --filter @nexus/telemetry

# ─── Stage 2: development — hot-reload via tsx (no compiled dist needed) ─────
FROM deps AS development
WORKDIR /app

# Install devDependencies (tsx + TypeScript compiler)
RUN pnpm install --frozen-lockfile \
    --filter @nexus/api --filter @nexus/auth \
    --filter @nexus/shared --filter @nexus/contracts --filter @nexus/db \
    --filter @nexus/governance --filter @nexus/memory \
    --filter @nexus/runtime --filter @nexus/council --filter @nexus/telemetry

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
    pnpm --filter @nexus/runtime build && \
    pnpm --filter @nexus/council build && \
    pnpm --filter @nexus/auth build && \
    pnpm --filter @nexus/api build

# ─── Stage 3: pruner — production-only node_modules (eliminates devDep CVEs) ──
FROM deps AS pruner
WORKDIR /app
RUN pnpm install --frozen-lockfile --prod \
    --filter @nexus/api --filter @nexus/auth --filter @nexus/shared \
    --filter @nexus/contracts --filter @nexus/db --filter @nexus/governance \
    --filter @nexus/memory --filter @nexus/runtime --filter @nexus/council \
    --filter @nexus/telemetry

# ─── Stage 4: runner ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
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
COPY --from=builder --chown=nexus:nexus /app/packages/runtime/dist ./packages/runtime/dist
COPY --from=builder --chown=nexus:nexus /app/packages/council/dist ./packages/council/dist
COPY --from=builder --chown=nexus:nexus /app/packages/telemetry/dist ./packages/telemetry/dist
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
