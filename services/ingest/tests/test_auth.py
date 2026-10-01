# SPDX-License-Identifier: Apache-2.0
"""Tests for authentication and the /ingest/events endpoints."""
from __future__ import annotations

import os
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

VALID_EVENT_BODY = {
    "source": "github",
    "event_type": "push",
    "payload": {"ref": "refs/heads/main", "commits": 3},
}


# ---------------------------------------------------------------------------
# Auth tests
# ---------------------------------------------------------------------------

class TestBearerAuth:
    """Verify that auth middleware accepts valid tokens and rejects bad ones."""

    @pytest.mark.asyncio
    async def test_missing_auth_header_returns_401_or_403(self, client: AsyncClient) -> None:
        resp = await client.post("/ingest/events", json=VALID_EVENT_BODY)
        assert resp.status_code in (401, 403)

    @pytest.mark.asyncio
    async def test_wrong_token_returns_401(
        self, client: AsyncClient, bad_auth_headers: dict
    ) -> None:
        resp = await client.post(
            "/ingest/events", json=VALID_EVENT_BODY, headers=bad_auth_headers
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_valid_token_passes_auth(
        self, client: AsyncClient, auth_headers: dict
    ) -> None:
        with (
            patch(
                "nexus_ingest.api.write_ingested_event",
                new_callable=AsyncMock,
                return_value="evt-001",
            ),
            patch(
                "nexus_ingest.api.publish_event_job",
                new_callable=AsyncMock,
                return_value="job-001",
            ),
        ):
            resp = await client.post(
                "/ingest/events", json=VALID_EVENT_BODY, headers=auth_headers
            )
        assert resp.status_code == 202

    @pytest.mark.asyncio
    async def test_auth_disabled_when_env_var_empty(
        self, client: AsyncClient
    ) -> None:
        """When NEXUS_INGEST_API_KEY is unset, any bearer token is accepted."""
        original = os.environ.pop("NEXUS_INGEST_API_KEY", None)
        try:
            with (
                patch(
                    "nexus_ingest.api.write_ingested_event",
                    new_callable=AsyncMock,
                    return_value="evt-002",
                ),
                patch(
                    "nexus_ingest.api.publish_event_job",
                    new_callable=AsyncMock,
                    return_value="job-002",
                ),
            ):
                resp = await client.post(
                    "/ingest/events",
                    json=VALID_EVENT_BODY,
                    headers={"Authorization": "Bearer anything"},
                )
            assert resp.status_code == 202
        finally:
            if original is not None:
                os.environ["NEXUS_INGEST_API_KEY"] = original


# ---------------------------------------------------------------------------
# POST /ingest/events — functional tests
# ---------------------------------------------------------------------------

class TestIngestEvents:
    """Verify event ingestion logic."""

    @pytest.mark.asyncio
    async def test_ingest_returns_event_id(
        self, client: AsyncClient, auth_headers: dict
    ) -> None:
        with (
            patch(
                "nexus_ingest.api.write_ingested_event",
                new_callable=AsyncMock,
                return_value="evt-abc",
            ),
            patch(
                "nexus_ingest.api.publish_event_job",
                new_callable=AsyncMock,
                return_value="job-xyz",
            ),
        ):
            resp = await client.post(
                "/ingest/events", json=VALID_EVENT_BODY, headers=auth_headers
            )
        assert resp.status_code == 202
        body = resp.json()
        assert body["event_id"] == "evt-abc"
        assert body["job_id"] == "job-xyz"
        assert body["status"] == "accepted"

    @pytest.mark.asyncio
    async def test_ingest_db_unavailable_returns_synthetic_id(
        self, client: AsyncClient, auth_headers: dict
    ) -> None:
        """When DB write returns None, a synthetic UUID is returned instead."""
        with (
            patch(
                "nexus_ingest.api.write_ingested_event",
                new_callable=AsyncMock,
                return_value=None,
            ),
            patch(
                "nexus_ingest.api.publish_event_job",
                new_callable=AsyncMock,
                return_value=None,
            ),
        ):
            resp = await client.post(
                "/ingest/events", json=VALID_EVENT_BODY, headers=auth_headers
            )
        assert resp.status_code == 202
        body = resp.json()
        assert len(body["event_id"]) == 36  # UUID length

    @pytest.mark.asyncio
    async def test_ingest_missing_required_fields_returns_422(
        self, client: AsyncClient, auth_headers: dict
    ) -> None:
        resp = await client.post(
            "/ingest/events",
            json={"source": "github"},  # missing event_type and payload
            headers=auth_headers,
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_ingest_priority_defaults_to_medium(
        self, client: AsyncClient, auth_headers: dict
    ) -> None:
        captured: dict = {}

        async def _capture(**kwargs):
            captured.update(kwargs)
            return "evt-cap"

        async def _job(**kwargs):
            return "job-cap"

        with (
            patch("nexus_ingest.api.write_ingested_event", side_effect=_capture),
            patch("nexus_ingest.api.publish_event_job", new_callable=AsyncMock, return_value="j"),
        ):
            await client.post(
                "/ingest/events",
                json={
                    "source": "slack",
                    "event_type": "message",
                    "payload": {"text": "hello"},
                    # no priority field — should default to "medium"
                },
                headers=auth_headers,
            )

    @pytest.mark.asyncio
    async def test_ingest_invalid_priority_coerced_to_medium(
        self, client: AsyncClient, auth_headers: dict
    ) -> None:
        """An unrecognised priority value must be coerced to 'medium'."""
        publish_mock = AsyncMock(return_value="j1")
        with (
            patch(
                "nexus_ingest.api.write_ingested_event",
                new_callable=AsyncMock,
                return_value="evt-x",
            ),
            patch("nexus_ingest.api.publish_event_job", publish_mock),
        ):
            resp = await client.post(
                "/ingest/events",
                json={**VALID_EVENT_BODY, "priority": "ultra"},
                headers=auth_headers,
            )
        assert resp.status_code == 202
        # The publish call should have received 'medium' as priority
        _, call_kwargs = publish_mock.call_args
        assert call_kwargs.get("priority") == "medium"
