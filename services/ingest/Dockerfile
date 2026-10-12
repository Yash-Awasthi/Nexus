# SPDX-License-Identifier: Apache-2.0
# nexus-ingest — production Dockerfile
# Multi-stage: builder installs the locked deps with uv, final image is minimal

ARG PYTHON_VERSION=3.14

# ── Builder stage ─────────────────────────────────────────────────────────────
FROM python:${PYTHON_VERSION}-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:0.13.0 /uv /bin/uv

# The venv lives at /venv, the same path as in the final stage, so console-script
# shebangs stay valid after COPY (a venv is not relocatable).
ENV UV_PROJECT_ENVIRONMENT=/venv \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /build/services/ingest

# Dependencies first so source edits reuse this layer. finscrape (a local
# sibling repo) is not in the lock; scrapers degrade gracefully without it.
COPY services/ingest/pyproject.toml services/ingest/uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

COPY services/ingest/ ./
RUN uv sync --locked --no-dev --no-editable

# ── Final stage ───────────────────────────────────────────────────────────────
FROM python:${PYTHON_VERSION}-slim AS final

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

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
