# SPDX-License-Identifier: Apache-2.0
# Nexus UI — multi-stage build
#
# Stage 1: build the React Router 7 SPA
# Stage 2: nginx serves static files + proxies /api/* to nexus-api

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@9

# Copy workspace config
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/ packages/
COPY apps/ui/ apps/ui/

# Install deps (frozen lockfile for reproducible CI)
RUN pnpm install --frozen-lockfile

# Build the SPA
RUN pnpm --filter @nexus/ui build

# ── Stage 2: nginx ────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runner

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy nginx config (SPA routing + /api/* proxy)
COPY apps/ui/nginx.conf /etc/nginx/conf.d/nexus-ui.conf

# Copy built SPA
COPY --from=builder /app/apps/ui/build/client /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
