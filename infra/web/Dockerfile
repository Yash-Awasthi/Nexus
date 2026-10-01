# SPDX-License-Identifier: Apache-2.0
# Single-origin image: the API serving the built web UI.
# Build: docker build -t nexus-web -f infra/web/Dockerfile .
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++ && npm install -g pnpm@9.14.4 --no-fund --no-audit
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter "@nexus/api..." --filter "@nexus/ui..."
RUN pnpm --filter "@nexus/api..." --filter "@nexus/ui..." build \
 && pnpm --filter @nexus/api deploy --prod /deploy \
 && cp -r apps/ui/build/client /deploy/public

FROM node:22-alpine
WORKDIR /app
RUN addgroup -g 1001 nexus && adduser -u 1001 -G nexus -s /bin/sh -D nexus \
 && mkdir -p /tmp/nexus/drives && chown -R nexus:nexus /tmp/nexus
COPY --from=build --chown=nexus:nexus /deploy ./
USER nexus
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    NEXUS_SPA_DIR=/app/public \
    NEXUS_DATA_DIR=/tmp/nexus \
    NEXUS_DRIVE_ROOT=/tmp/nexus/drives \
    NODE_OPTIONS=--max-old-space-size=384
EXPOSE 10000
CMD ["node", "--import", "tsx/esm", "dist/index.js"]
