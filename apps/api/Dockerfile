# SPDX-License-Identifier: Apache-2.0
# @nexus/api — multi-stage Docker build
# Build: docker build -t nexus-api -f apps/api/Dockerfile .
# Run:   docker run -p 3000:3000 --env-file .env nexus-api

# ─── Stage 1: deps ────────────────────────────────────────────────────────────
FROM node:26-alpine AS deps
WORKDIR /app

# python3/make/g++ are needed to compile node-pty's native extension during
# pnpm install (no prebuilt binary for alpine/musl).
RUN apk add --no-cache python3 make g++ \
 && npm install -g pnpm@9.14.4 --no-fund --no-audit

# Copy workspace manifests (needed for pnpm workspaces)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY turbo.json ./

# The whole packages tree (as the worker image does): --filter "@nexus/api..." then installs
# exactly the API's dependency closure, so no list here goes stale. The API runs the worker's
# agent loop in-process when there is no queue, so the worker is in that closure.
COPY packages/ ./packages/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/

RUN pnpm install --frozen-lockfile --prod=false --filter "@nexus/api..."

# ─── Stage 2: development — hot-reload via tsx (no compiled dist needed) ─────
FROM deps AS development
WORKDIR /app

# Source is bind-mounted at runtime — no COPY here
ENV NODE_ENV=development
EXPOSE 3000 9229
CMD ["node", "--inspect=0.0.0.0:9229", \
     "--import", "tsx/esm", \
     "--watch", "apps/api/src/index.ts"]

# ─── Stage 3: builder ────────────────────────────────────────────────────────
FROM deps AS builder
WORKDIR /app

COPY apps/api/ ./apps/api/
COPY apps/worker/ ./apps/worker/
COPY tsconfig.base.json ./

RUN pnpm --filter "@nexus/api..." build

# ─── Stage 3: pruner — pnpm deploy FROM builder so workspace dist/ files exist ─
# Critical: must base on builder, not deps. pnpm deploy copies workspace packages
# including their compiled dist/ — if based on deps, workspace dist/ is absent and
# node cannot resolve @nexus/* imports at runtime → container exits → update_failed.
FROM builder AS pruner
WORKDIR /app
RUN pnpm --filter @nexus/api deploy --prod /deploy

# ─── Stage 4: runner ─────────────────────────────────────────────────────────
FROM node:26-alpine AS runner
WORKDIR /app

# Non-root user for security
RUN addgroup -g 1001 nexus && adduser -u 1001 -G nexus -s /bin/sh -D nexus \
  && mkdir -p /data/drives && chown nexus:nexus /data/drives

# /deploy contains: dist/ (api compiled output) + node_modules/ (all runtime deps
# including workspace packages with their dist/ files intact — no symlinks)
COPY --from=pruner --chown=nexus:nexus /deploy ./

USER nexus

ENV NODE_ENV=production
ENV PORT=10000
ENV HOST=0.0.0.0

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

# Three workspace packages in the API's dependency closure (@nexus/agent-engine,
# @nexus/escalation-breaker, @nexus/pty) point `main` at TypeScript source, and
# Node's built-in stripping rejects the parameter properties they use. The tsx
# loader is what the dev stage above and the desktop child process already run.
CMD ["node", "--import", "tsx/esm", "dist/index.js"]
