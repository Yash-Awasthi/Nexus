# SPDX-License-Identifier: Apache-2.0
# @nexus/worker — multi-stage Docker build
# Build: docker build -t nexus-worker -f apps/worker/Dockerfile .

# Debian rather than Alpine: the browser agent's Chromium needs glibc.
FROM node:26-bookworm-slim AS deps
WORKDIR /app

# python3/make/g++ compile node-pty's native extension during pnpm install.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@9.14.4 --no-fund --no-audit

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY turbo.json ./

COPY packages/ ./packages/
COPY apps/worker/package.json ./apps/worker/

RUN pnpm install --frozen-lockfile

# ─── Stage 2: development — hot-reload via tsx ───────────────────────────────
FROM deps AS development
WORKDIR /app

RUN pnpm install --frozen-lockfile

ENV NODE_ENV=development
EXPOSE 9229
CMD ["node", "--inspect=0.0.0.0:9229", \
     "--import", "tsx/esm", \
     "--watch", "apps/worker/src/index.ts"]

# ─── Stage 3: builder — compile worker + all its workspace deps (topo order) ─
FROM deps AS builder
WORKDIR /app

COPY tsconfig.base.json ./
COPY apps/worker/ ./apps/worker/

RUN pnpm --filter "@nexus/worker..." build

# ─── Stage 4: pruner — pnpm deploy copies worker + all workspace deps' dist ──
FROM builder AS pruner
WORKDIR /app
RUN pnpm --filter @nexus/worker deploy --prod /deploy

# ─── Stage 5: runner ─────────────────────────────────────────────────────────
FROM node:26-bookworm-slim AS runner
WORKDIR /app

RUN groupadd -g 1001 nexus && useradd -u 1001 -g nexus -s /bin/sh -m nexus \
  && mkdir -p /data/drives && chown nexus:nexus /data/drives

COPY --from=pruner --chown=nexus:nexus /deploy ./

# Chromium for browser.task jobs, at the build patchright expects, with its system libraries.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN node "$(find node_modules/.pnpm -path '*/node_modules/patchright/cli.js' | head -1)" \
      install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

USER nexus

ENV NODE_ENV=production

# Worker doesn't serve HTTP — no EXPOSE
STOPSIGNAL SIGTERM

# Workspace packages point `main` at TypeScript source, as in the API image, so the tsx loader runs.
CMD ["node", "--import", "tsx", "dist/index.js"]
