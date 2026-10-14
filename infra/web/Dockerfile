# SPDX-License-Identifier: Apache-2.0
# Single-origin image: the API serving the built web UI.
# Build: docker build -t nexus-web -f infra/web/Dockerfile .
FROM node:26-alpine AS build
RUN apk add --no-cache python3 make g++ && npm install -g pnpm@12.11.2 --no-fund --no-audit
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter "@nexus/api..." --filter "@nexus/ui..." \
 && pnpm --filter @nexus/ui build \
 && mkdir -p apps/api/public && cp -r apps/ui/build/client/. apps/api/public/ \
 && pnpm install --frozen-lockfile --prod --filter "@nexus/api..." \
 && rm -rf apps/ui packages/*/tests apps/*/tests

FROM node:26-alpine
WORKDIR /app
RUN addgroup -g 1001 nexus && adduser -u 1001 -G nexus -s /bin/sh -D nexus \
 && mkdir -p /tmp/nexus/drives && chown -R nexus:nexus /tmp/nexus
# The API runs from source (Node 26 strips types); workspace links must stay
# symlinks into packages/ because Node will not strip types under node_modules.
COPY --from=build --chown=nexus:nexus /src ./
USER nexus
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    NEXUS_SPA_DIR=/app/apps/api/public \
    NEXUS_DATA_DIR=/tmp/nexus \
    NEXUS_DRIVE_ROOT=/tmp/nexus/drives \
    NODE_OPTIONS=--max-old-space-size=384
EXPOSE 10000
WORKDIR /app/apps/api
# Additive migrations first (ledger-tracked, idempotent); the API still starts if the database is down.
CMD ["sh", "-c", "node src/migrate.ts; exec node src/index.ts"]
