# SPDX-License-Identifier: Apache-2.0
# @nexus/api — multi-stage Docker build
# Build: docker build -t nexus-api -f apps/api/Dockerfile .
# Run:   docker run -p 3000:3000 --env-file .env nexus-api
#
# No compile step: Node 26 strips TypeScript types natively and every @nexus/*
# package exports its source, so the image runs apps/api/src directly.

# ─── Stage 1: deps ────────────────────────────────────────────────────────────
FROM node:26-alpine AS deps
WORKDIR /app

# python3/make/g++ are needed to compile node-pty's native extension during
# pnpm install (no prebuilt binary for alpine/musl).
RUN apk add --no-cache python3 make g++ \
 && npm install -g pnpm@12.11.2 --no-fund --no-audit

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# The whole packages tree (as the worker image does): --filter "@nexus/api..." then installs
# exactly the API's dependency closure, so no list here goes stale. The API runs the worker's
# agent loop in-process when there is no queue, so the worker is in that closure.
COPY packages/ ./packages/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/

RUN pnpm install --frozen-lockfile --filter "@nexus/api..."

# ─── Stage 2: development — source is bind-mounted at runtime ────────────────
FROM deps AS development
WORKDIR /app
ENV NODE_ENV=development
EXPOSE 3000 9229
CMD ["node", "--inspect=0.0.0.0:9229", "--watch", "apps/api/src/index.ts"]

# ─── Stage 3: production dependencies ────────────────────────────────────────
FROM deps AS prod
WORKDIR /app
COPY apps/api/ ./apps/api/
COPY apps/worker/ ./apps/worker/
# Workspace links stay symlinks into /app/packages: Node refuses to strip types
# under node_modules, so `pnpm deploy` copies would not load.
RUN pnpm install --frozen-lockfile --prod --filter "@nexus/api..." \
 && rm -rf packages/*/tests packages/*/dist apps/*/tests

# ─── Stage 4: runner ─────────────────────────────────────────────────────────
FROM node:26-alpine AS runner
WORKDIR /app

# Non-root user for security
RUN addgroup -g 1001 nexus && adduser -u 1001 -G nexus -s /bin/sh -D nexus \
  && mkdir -p /data/drives && chown nexus:nexus /data/drives

COPY --from=prod --chown=nexus:nexus /app ./

USER nexus

ENV NODE_ENV=production
ENV PORT=10000
ENV HOST=0.0.0.0

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

WORKDIR /app/apps/api
CMD ["node", "src/index.ts"]
