# SPDX-License-Identifier: Apache-2.0
# SPECTRE — Vite SPA static build served by nginx
# Build: docker build -t nexus-spectre -f apps/spectre/Dockerfile .
# Run:   docker run -p 5174:80 \
#          -e VITE_API_URL=https://api.your-nexus.com \
#          -e VITE_API_KEY=your-key \
#          nexus-spectre

# ─── Stage 1: builder ────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

RUN npm install -g pnpm@9.14.4 --no-fund --no-audit

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./

# Only the packages spectre depends on
COPY packages/client/package.json        ./packages/client/
COPY packages/parseltongue/package.json  ./packages/parseltongue/
COPY apps/spectre/package.json           ./apps/spectre/

RUN pnpm install --frozen-lockfile \
    --filter @nexus/spectre \
    --filter @nexus/client \
    --filter @nexus/parseltongue

COPY packages/client/     ./packages/client/
COPY packages/parseltongue/ ./packages/parseltongue/
COPY apps/spectre/        ./apps/spectre/

# Build deps first, then spectre
# (vite aliases bypass this, but tsc still needs dist for type checking)
RUN pnpm --filter @nexus/client build && \
    pnpm --filter @nexus/parseltongue build && \
    pnpm --filter @nexus/spectre build

# ─── Stage 2: runner — nginx serving the static dist ─────────────────────────
FROM nginx:1.27-alpine AS runner

# Custom nginx config: SPA routing (all paths → index.html)
RUN printf 'server {\n\
  listen 80;\n\
  root /usr/share/nginx/html;\n\
  index index.html;\n\
  gzip on;\n\
  gzip_types text/html text/css application/javascript application/json;\n\
  location / {\n\
    try_files $uri $uri/ /index.html;\n\
  }\n\
  location /health {\n\
    return 200 "ok";\n\
    add_header Content-Type text/plain;\n\
  }\n\
}\n' > /etc/nginx/conf.d/default.conf

COPY --from=builder /app/apps/spectre/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost/health || exit 1
