# SPDX-License-Identifier: Apache-2.0
# nexus-ingest — production Dockerfile
# Multi-stage: builder installs deps, final image is minimal

ARG PYTHON_VERSION=3.11

# ── Builder stage ─────────────────────────────────────────────────────────────
FROM python:${PYTHON_VERSION}-slim AS builder

WORKDIR /build

# Install build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libpq-dev git \
    && rm -rf /var/lib/apt/lists/*

# Copy project manifests
COPY services/ingest/pyproject.toml services/ingest/

# Install production deps into /venv (same path as final stage so console-script
# shebangs stay valid after COPY — a venv is not relocatable).
# finscrape is an optional [finscrape] extra (local sibling repo); not included in the
# Docker image — scrapers degrade gracefully when finscrape is absent.
RUN python -m venv /venv
ENV PATH="/venv/bin:$PATH"

# Copy the rest of the ingest service
COPY services/ingest/ /build/services/ingest/

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -e /build/services/ingest/

# ── Final stage ───────────────────────────────────────────────────────────────
FROM python:${PYTHON_VERSION}-slim AS final

WORKDIR /app

# Runtime system deps (libpq for asyncpg)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 curl \
    && rm -rf /var/lib/apt/lists/*

# Copy venv and service source from builder
COPY --from=builder /venv /venv
COPY --from=builder /build/services/ingest /app

ENV PATH="/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    APP_ENV=production

# Non-root user
RUN useradd -r -u 1001 -s /sbin/nologin nexus
USER nexus

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:8000/health || exit 1

CMD ["uvicorn", "nexus_ingest.api:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "2", \
     "--log-level", "info"]
