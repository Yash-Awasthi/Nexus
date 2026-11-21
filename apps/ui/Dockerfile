# SPDX-License-Identifier: Apache-2.0
# Nexus UI — multi-stage build
#
# Stage 1: build the React Router 7 SPA
# Stage 2: nginx serves static files + proxies /api/* to nexus-api

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS builder

WORKDIR /app

# python3/make/g++ are needed to compile node-pty's native extension during
# pnpm install (no prebuilt binary for alpine/musl).
RUN apk add --no-cache python3 make g++ \
 && npm install -g pnpm@12.21.0

# Copy workspace config
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ui/ apps/ui/

# Install the UI's dependency closure (frozen lockfile for reproducible CI)
RUN pnpm install --frozen-lockfile --filter "@nexus/ui..."

# Workspace packages export TypeScript source, which Vite bundles directly.
RUN pnpm --filter @nexus/ui build

# ── Stage 2: nginx ────────────────────────────────────────────────────────────
FROM nginx:1.31-alpine@sha256:fb4658584bd9a916ffb6f6e365f97c25cfdb2923801f551ea08356e695f14ff7 AS runner

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Install nginx config as an envsubst template. The official nginx image runs
# envsubst over /etc/nginx/templates/*.template at startup, writing the result
# to /etc/nginx/conf.d/. Only env vars that are actually set are substituted,
# so nginx's own $host / $remote_addr are left intact.
COPY apps/ui/nginx.conf /etc/nginx/templates/nexus-ui.conf.template

# Copy built SPA
COPY --from=builder /app/apps/ui/build/client /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ > /dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
