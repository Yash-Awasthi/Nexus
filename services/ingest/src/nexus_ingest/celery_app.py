# SPDX-License-Identifier: Apache-2.0
"""
nexus-ingest Celery application.

Provides an async background task queue for the Python ingest service.
The TypeScript worker (BullMQ) handles Node.js jobs; Celery handles Python-
native heavy tasks: document indexing, URL crawling, and LLM inference.

Configuration
─────────────
All settings come from environment variables (12-factor):

  REDIS_URL          — Celery broker + result backend (default: redis://localhost:6379/0)
  CELERY_CONCURRENCY — Worker concurrency (default: 4)
  CELERY_QUEUE       — Default queue name (default: nexus-python)

Task categories
───────────────
  index_document   — chunk + embed a document and write to vector store
  crawl_url        — fetch a URL, extract main content, trigger doc indexing
  run_inference    — run an LLM inference call (heavy / long-running)
  purge_expired    — periodic cleanup of expired memory entries

Usage (dispatch from API)
──────────────────────────
  from nexus_ingest.tasks import index_document
  task = index_document.delay(doc_id="abc", content="...", metadata={})
  result = task.get(timeout=30)  # or fire-and-forget with .delay()

Beat schedule (periodic tasks)
──────────────────────────────
  purge_expired runs every 6 hours.
"""
from __future__ import annotations

import logging
import os

from celery import Celery
from celery.schedules import crontab

logger = logging.getLogger(__name__)

# ── Redis URL ─────────────────────────────────────────────────────────────────

REDIS_URL: str = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

# ── Celery app factory ────────────────────────────────────────────────────────


def create_celery_app(broker: str = REDIS_URL, backend: str = REDIS_URL) -> Celery:
    """
    Create and configure the Celery application.
    Accepts injectable broker/backend for testing.
    """
    app = Celery(
        "nexus-ingest",
        broker=broker,
        backend=backend,
        include=[
            "nexus_ingest.tasks.index_document",
            "nexus_ingest.tasks.crawl_url",
            "nexus_ingest.tasks.run_inference",
        ],
    )

    app.conf.update(
        # Serialisation
        task_serializer="json",
        result_serializer="json",
        accept_content=["json"],
        # Time limits
        task_soft_time_limit=120,   # SIGTERM after 2 min (task can clean up)
        task_time_limit=180,        # SIGKILL after 3 min (hard cap)
        # Result retention
        result_expires=3600,        # 1 hour
        # Retry behaviour
        task_acks_late=True,        # Re-queue on worker crash
        task_reject_on_worker_lost=True,
        # Concurrency
        worker_concurrency=int(os.environ.get("CELERY_CONCURRENCY", "4")),
        worker_prefetch_multiplier=1,   # Fair distribution
        # Queue routing
        task_default_queue=os.environ.get("CELERY_QUEUE", "nexus-python"),
        task_routes={
            "nexus_ingest.tasks.index_document.*": {"queue": "nexus-python-index"},
            "nexus_ingest.tasks.crawl_url.*": {"queue": "nexus-python-crawl"},
            "nexus_ingest.tasks.run_inference.*": {"queue": "nexus-python-inference"},
        },
        # Beat periodic schedule
        beat_schedule={
            "purge-expired-every-6h": {
                "task": "nexus_ingest.tasks.index_document.purge_expired",
                "schedule": crontab(minute=0, hour="*/6"),
            },
        },
        timezone="UTC",
        enable_utc=True,
    )

    return app


# Module-level singleton (used by workers and task imports)
celery_app: Celery = create_celery_app()
