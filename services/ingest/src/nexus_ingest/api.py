# SPDX-License-Identifier: Apache-2.0
"""
nexus-ingest — FastAPI application.

Routes:
  POST /ingest/events          — receive raw event from adapter (auth required)
  GET  /ingest/events/{id}     — retrieve event by id (auth required)
  POST /scrape/{source}        — single source scrape
  POST /scrape/batch           — multi-source concurrent scrape
  GET  /scrape/sources         — list registered scrapers
  GET  /health                 — liveness + readiness (includes DB check)
  GET  /metrics                — Prometheus metrics (optional)
"""
from __future__ import annotations

import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Optional

from fastapi import FastAPI, HTTPException, Path
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from nexus_ingest.auth import AuthDep
from nexus_ingest.db import close_pool, write_ingested_event
from nexus_ingest.models import HealthResponse
from nexus_ingest.queue import close_redis, publish_event_job
from nexus_ingest.routes.scrape import router as scrape_router
from nexus_ingest.scrapers.registry import warm_registry
from nexus_ingest.settings import get_settings

logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s — %(message)s",
)


# ── Request / Response models ─────────────────────────────────────────────────

class IngestEventRequest(BaseModel):
    source: str = Field(..., description="Adapter source identifier, e.g. 'gmail', 'github'")
    event_type: str = Field(..., description="Structured event type, e.g. 'email.received'")
    payload: dict[str, Any] = Field(..., description="Raw event payload")
    metadata: Optional[dict[str, Any]] = Field(None, description="Optional adapter metadata")
    idempotency_key: Optional[str] = Field(None, description="Optional deduplication key")
    priority: Optional[str] = Field("medium", description="Queue tier: high, medium, or low")


class IngestEventResponse(BaseModel):
    event_id: str
    job_id: Optional[str] = None
    status: str = "accepted"


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    logger.info("nexus-ingest starting (env=%s)", settings.app_env)

    scraper_status = warm_registry()
    available = [k for k, v in scraper_status.items() if v]
    unavailable = [k for k, v in scraper_status.items() if not v]
    logger.info("Scrapers available (%d): %s", len(available), ", ".join(available))
    if unavailable:
        logger.warning("Scrapers unavailable (%d): %s", len(unavailable), ", ".join(unavailable))

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
            logger.debug("opentelemetry-instrumentation-fastapi not installed")

    yield

    await close_pool()
    await close_redis()
    logger.info("nexus-ingest shutdown complete")


# ── App factory ───────────────────────────────────────────────────────────────

def create_app() -> FastAPI:
    app = FastAPI(
        title="nexus-ingest",
        version="0.1.0",
        description="Financial scraping + event ingestion — part of the NEXUS platform",
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
        lifespan=lifespan,
    )

    allowed_origins = os.getenv("ALLOWED_ORIGINS", "*").split(",")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── Scrape routes (existing) ───────────────────────────────────────────────
    app.include_router(scrape_router)

    # ── Ingest routes ──────────────────────────────────────────────────────────

    @app.post("/ingest/events", response_model=IngestEventResponse, status_code=202, tags=["ingest"])
    async def ingest_event(body: IngestEventRequest, _token: AuthDep) -> IngestEventResponse:
        """
        Accept a raw event from any adapter and queue it for processing.

        - Writes an `ingested_events` row (idempotency-safe via idempotency_key)
        - Publishes a BullMQ-compatible job to the appropriate Redis tier
        """
        priority = body.priority if body.priority in ("high", "medium", "low") else "medium"

        event_id = await write_ingested_event(
            source=body.source,
            event_type=body.event_type,
            payload=body.payload,
            metadata=body.metadata,
            idempotency_key=body.idempotency_key,
        )

        if event_id is None:
            # DB unavailable — still generate a synthetic ID so callers aren't blocked
            event_id = str(uuid.uuid4())
            logger.warning("DB write skipped — returning synthetic event_id %s", event_id)

        job_id = await publish_event_job(
            event_id=event_id,
            source=body.source,
            event_type=body.event_type,
            payload=body.payload,
            priority=priority,  # type: ignore[arg-type]
        )

        return IngestEventResponse(event_id=event_id, job_id=job_id)

    @app.get("/ingest/events/{event_id}", tags=["ingest"])
    async def get_event(
        event_id: str = Path(..., description="UUID of the ingested event"),
        _token: AuthDep = None,
    ) -> dict[str, Any]:
        """
        Retrieve a previously ingested event by ID.
        Queries the DB directly; returns 404 if not found.
        """
        from nexus_ingest.db import _get_pool
        pool = await _get_pool()
        if pool is None:
            raise HTTPException(status_code=503, detail="Database unavailable")
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM ingested_events WHERE id = $1", event_id
            )
        if row is None:
            raise HTTPException(status_code=404, detail=f"Event {event_id} not found")
        return dict(row)

    # ── Health ─────────────────────────────────────────────────────────────────

    @app.get("/health", response_model=HealthResponse, tags=["meta"])
    async def health() -> HealthResponse:
        """Liveness probe — always returns 200 if the process is alive."""
        from nexus_ingest.scrapers.registry import SCRAPER_REGISTRY
        return HealthResponse(
            status="ok",
            version="0.1.0",
            scrapers=list(SCRAPER_REGISTRY.keys()),
        )

    @app.get("/health/ready", tags=["meta"])
    async def readiness() -> dict[str, Any]:
        """
        Readiness probe — checks DB + Redis connectivity.
        Returns 200 if all deps are reachable, 503 otherwise.
        """
        checks: dict[str, str] = {}
        overall_ok = True

        # DB check
        try:
            from nexus_ingest.db import _get_pool
            pool = await _get_pool()
            if pool:
                async with pool.acquire() as conn:
                    await conn.execute("SELECT 1")
                checks["db"] = "ok"
            else:
                checks["db"] = "not_configured"
        except Exception as exc:
            checks["db"] = f"error: {exc}"
            overall_ok = False

        # Redis check
        try:
            from nexus_ingest.queue import _get_redis
            redis = await _get_redis()
            if redis:
                await redis.ping()
                checks["redis"] = "ok"
            else:
                checks["redis"] = "not_configured"
        except Exception as exc:
            checks["redis"] = f"error: {exc}"
            overall_ok = False

        if not overall_ok:
            from fastapi.responses import JSONResponse
            return JSONResponse(
                status_code=503,
                content={"status": "not_ready", "checks": checks},
            )

        return {"status": "ready", "checks": checks}

    # ── Metrics (optional) ─────────────────────────────────────────────────────
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
