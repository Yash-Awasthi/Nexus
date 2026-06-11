# SPDX-License-Identifier: Apache-2.0
"""
nexus-ingest — FastAPI application.

Financial scraping service: promotes fin-scrape scrapers to production REST
endpoints with concurrent batch support, OpenTelemetry instrumentation, and
Prometheus metrics.

Architecture:
  POST /scrape/{source}  — single source scrape → ScrapeResponse
  POST /scrape/batch     — multi-source concurrent scrape → BatchScrapeResponse
  GET  /scrape/sources   — list registered scrapers
  GET  /health           — liveness + readiness
  GET  /metrics          — Prometheus metrics (if prometheus-client installed)
"""
from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from nexus_ingest.models import HealthResponse
from nexus_ingest.routes.scrape import router as scrape_router
from nexus_ingest.scrapers.registry import warm_registry
from nexus_ingest.settings import get_settings

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Startup: warm scraper registry. Shutdown: clean up."""
    settings = get_settings()
    logger.info("nexus-ingest starting (env=%s)", settings.app_env)

    # Warm the scraper registry so import errors surface at startup
    scraper_status = warm_registry()
    available = [k for k, v in scraper_status.items() if v]
    unavailable = [k for k, v in scraper_status.items() if not v]

    logger.info("Scrapers available (%d): %s", len(available), ", ".join(available))
    if unavailable:
        logger.warning("Scrapers unavailable (%d): %s", len(unavailable), ", ".join(unavailable))

    # Instrument with OpenTelemetry if endpoint is configured
    if settings.otel_exporter_otlp_endpoint:
        try:
            from opentelemetry import trace
            from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
            from opentelemetry.sdk.trace import TracerProvider
            from opentelemetry.sdk.trace.export import BatchSpanProcessor
            from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor  # type: ignore[import]

            provider = TracerProvider()
            provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
            trace.set_tracer_provider(provider)
            FastAPIInstrumentor.instrument_app(app)
            logger.info("OpenTelemetry instrumentation active")
        except ImportError:
            logger.debug("opentelemetry-instrumentation-fastapi not installed, skipping")

    yield

    logger.info("nexus-ingest shutdown complete")


# ── App ───────────────────────────────────────────────────────────────────────

def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="nexus-ingest",
        version="0.1.0",
        description="Financial news scraping service — part of the NEXUS platform",
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
        lifespan=lifespan,
    )

    # CORS — open for now, tighten in production via ALLOWED_ORIGINS env var
    allowed_origins = os.getenv("ALLOWED_ORIGINS", "*").split(",")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── Routes ────────────────────────────────────────────────────────────────

    app.include_router(scrape_router)

    @app.get("/health", response_model=HealthResponse, tags=["meta"])
    async def health() -> HealthResponse:
        """Liveness and readiness probe."""
        from nexus_ingest.scrapers.registry import SCRAPER_REGISTRY
        return HealthResponse(
            status="ok",
            version="0.1.0",
            scrapers=list(SCRAPER_REGISTRY.keys()),
        )

    # Prometheus metrics endpoint (optional)
    try:
        from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
        from fastapi.responses import Response

        @app.get("/metrics", tags=["meta"], include_in_schema=False)
        async def metrics() -> Response:
            return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)

    except ImportError:
        pass

    return app


app = create_app()
