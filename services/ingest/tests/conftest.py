# SPDX-License-Identifier: Apache-2.0
"""
Shared pytest fixtures for nexus-ingest.

All external I/O (DB, Redis, finscrape) is patched out so tests run
without any real infrastructure.  The FastAPI app is constructed fresh
for each test session via the ``app`` fixture.
"""
from __future__ import annotations

import os
from typing import AsyncIterator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient


# ---------------------------------------------------------------------------
# Environment setup — must happen before app import
# ---------------------------------------------------------------------------

os.environ.setdefault("NEXUS_INGEST_API_KEY", "test-token")
os.environ.setdefault("DATABASE_URL", "")   # prevents psycopg from connecting
os.environ.setdefault("REDIS_URL", "")      # prevents redis from connecting


# ---------------------------------------------------------------------------
# App fixture — patches lifespan I/O then imports create_app
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def app():
    """Return the FastAPI app with lifespan I/O stubbed out."""
    with (
        patch("nexus_ingest.api.warm_registry", return_value={"bloomberg": False}),
        patch("nexus_ingest.api.close_pool", new_callable=AsyncMock),
        patch("nexus_ingest.api.close_redis", new_callable=AsyncMock),
    ):
        from nexus_ingest.api import create_app
        return create_app()


@pytest_asyncio.fixture()
async def client(app) -> AsyncIterator[AsyncClient]:
    """Async HTTP client wired to the FastAPI app under test."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture()
def auth_headers() -> dict[str, str]:
    """Valid Bearer token headers matching NEXUS_INGEST_API_KEY."""
    return {"Authorization": "Bearer test-token"}


@pytest.fixture()
def bad_auth_headers() -> dict[str, str]:
    """Bearer token that does NOT match NEXUS_INGEST_API_KEY."""
    return {"Authorization": "Bearer wrong-token"}
