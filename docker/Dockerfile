# ============================================================================
# GhostStack Runtime Container
# Build: docker build -f docker/Dockerfile -t ghoststack:latest .
# Run:   docker run -p 3000:3000 -e GHOSTSTACK_FLOCI_URL=http://host.docker.internal:4566 ghoststack:latest
# ============================================================================

# ---- Build Stage ----
FROM node:20-alpine AS builder

WORKDIR /app

# Install build deps first (leverages Docker cache)
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source
COPY tsconfig.json ./
COPY orchestration/ ./orchestration/
COPY runtime/ ./runtime/
COPY schemas/ ./schemas/
COPY ghoststack.config.json ./
COPY specs/ ./specs/

# Build TypeScript
RUN npx tsc --project tsconfig.json --outDir dist

# ---- Runtime Stage ----
FROM node:20-alpine AS runtime

WORKDIR /app

# Install Python for FastMCP server, plus curl for healthcheck
RUN apk add --no-cache python3 py3-pip curl && \
    pip3 install --no-cache-dir mcp && \
    rm -rf /root/.cache

# Install only production deps
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev

# Copy compiled output + config + schemas + specs
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/schemas ./schemas
COPY --from=builder /app/specs ./specs
COPY --from=builder /app/ghoststack.config.json ./

# Runtime YAML configs
COPY runtime/*.yaml ./runtime/

# FastMCP Python server
COPY runtime/mcp/ ./runtime/mcp/

# Create data directory
RUN mkdir -p /app/data-runtime

ENV NODE_ENV=production
ENV GHOSTSTACK_DATA_DIR=/app/data-runtime
ENV GHOSTSTACK_API_PORT=3000
ENV GHOSTSTACK_OFFLINE_MODE=true

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node dist/runtime/healthcheck.js || exit 1

CMD ["node", "dist/runtime/server.js"]
