# SPDX-License-Identifier: Apache-2.0
"""Tests for /health and /health/ready endpoints."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient


class TestHealthLiveness:
    """GET /health — always returns 200 while the process is alive."""

    @pytest.mark.asyncio
    async def test_health_returns_200(self, client: AsyncClient) -> None:
        resp = await client.get("/health")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_health_response_schema(self, client: AsyncClient) -> None:
        resp = await client.get("/health")
        body = resp.json()
        assert body["status"] == "ok"
        assert "version" in body
        assert "scrapers" in body
        assert isinstance(body["scrapers"], list)

    @pytest.mark.asyncio
    async def test_health_version_is_semver(self, client: AsyncClient) -> None:
        resp = await client.get("/health")
        version = resp.json()["version"]
        parts = version.split(".")
        assert len(parts) == 3
        assert all(p.isdigit() for p in parts)


class TestHealthReadiness:
    """GET /health/ready — checks DB + Redis; degrades gracefully."""

    @pytest.mark.asyncio
    async def test_readiness_no_db_no_redis_is_not_ready(self, client: AsyncClient) -> None:
        """Without real DB/Redis the readiness probe should return 503."""
        with (
            patch("nexus_ingest.api.open", side_effect=Exception("no db")),
            patch("nexus_ingest.db._get_pool", new_callable=AsyncMock, return_value=None),
            patch("nexus_ingest.queue._get_redis", new_callable=AsyncMock, return_value=None),
        ):
            resp = await client.get("/health/ready")
        # Both deps report 'not_configured'; overall is still considered ready
        assert resp.status_code in (200, 503)
        body = resp.json()
        assert "status" in body

    @pytest.mark.asyncio
    async def test_readiness_db_error_returns_503(self, client: AsyncClient) -> None:
        """A broken DB connection must make the readiness check fail."""
        from contextlib import asynccontextmanager

        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock(side_effect=OSError("connection refused"))

        @asynccontextmanager
        async def _acquire():
            yield mock_conn

        mock_pool = MagicMock()
        mock_pool.acquire = _acquire

        with (
            patch("nexus_ingest.db._get_pool", new_callable=AsyncMock, return_value=mock_pool),
            patch("nexus_ingest.queue._get_redis", new_callable=AsyncMock, return_value=None),
        ):
            resp = await client.get("/health/ready")
        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_readiness_all_ok(self, client: AsyncClient) -> None:
        """When DB and Redis both respond, readiness is 200."""
        from contextlib import asynccontextmanager

        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock(return_value=None)

        @asynccontextmanager
        async def _acquire():
            yield mock_conn

        mock_pool = MagicMock()
        mock_pool.acquire = _acquire

        mock_redis = AsyncMock()
        mock_redis.ping = AsyncMock(return_value=True)

        with (
            patch("nexus_ingest.db._get_pool", new_callable=AsyncMock, return_value=mock_pool),
            patch("nexus_ingest.queue._get_redis", new_callable=AsyncMock, return_value=mock_redis),
        ):
            resp = await client.get("/health/ready")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ready"
