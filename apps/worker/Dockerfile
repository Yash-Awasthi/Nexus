# SPDX-License-Identifier: Apache-2.0
# @nexus/worker — multi-stage Docker build
# Build: docker build -t nexus-worker -f apps/worker/Dockerfile .

FROM node:26-alpine AS deps
WORKDIR /app

RUN npm install -g pnpm@9.14.4 --no-fund --no-audit

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

# ─── Stage 3: pruner — pnpm deploy copies worker + all workspace deps' dist ──
FROM builder AS pruner
WORKDIR /app
RUN pnpm --filter @nexus/worker deploy --prod /deploy

# ─── Stage 4: runner ─────────────────────────────────────────────────────────
FROM node:26-alpine AS runner
WORKDIR /app

RUN addgroup -g 1001 nexus && adduser -u 1001 -G nexus -s /bin/sh -D nexus

COPY --from=pruner --chown=nexus:nexus /deploy ./

USER nexus

ENV NODE_ENV=production

# Worker doesn't serve HTTP — no EXPOSE
STOPSIGNAL SIGTERM

CMD ["node", "dist/index.js"]
