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
 && npm install -g pnpm@12.11.2 --no-fund --no-audit

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

COPY packages/ ./packages/
COPY apps/worker/package.json ./apps/worker/

RUN pnpm install --frozen-lockfile --filter "@nexus/worker..."

# ─── Stage 2: development — source is bind-mounted at runtime ────────────────
FROM deps AS development
WORKDIR /app
ENV NODE_ENV=development
EXPOSE 9229
CMD ["node", "--inspect=0.0.0.0:9229", "--watch", "apps/worker/src/index.ts"]

# ─── Stage 3: production dependencies ────────────────────────────────────────
# No compile step: Node 26 strips types natively and @nexus/* packages export
# source. Workspace links stay symlinks because Node will not strip types
# under node_modules, so `pnpm deploy` copies would not load.
FROM deps AS prod
WORKDIR /app
COPY apps/worker/ ./apps/worker/
RUN pnpm install --frozen-lockfile --prod --filter "@nexus/worker..." \
 && rm -rf packages/*/tests packages/*/dist apps/*/tests

# ─── Stage 4: runner ─────────────────────────────────────────────────────────
FROM node:26-bookworm-slim AS runner
WORKDIR /app

RUN groupadd -g 1001 nexus && useradd -u 1001 -g nexus -s /bin/sh -m nexus \
  && mkdir -p /data/drives && chown nexus:nexus /data/drives

COPY --from=prod --chown=nexus:nexus /app ./

# Chromium for browser.task jobs, at the build patchright expects, with its system libraries.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN node "$(find node_modules/.pnpm -path '*/node_modules/patchright/cli.js' | head -1)" \
      install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

USER nexus

ENV NODE_ENV=production

# Worker doesn't serve HTTP — no EXPOSE
STOPSIGNAL SIGTERM

WORKDIR /app/apps/worker
CMD ["node", "src/index.ts"]
