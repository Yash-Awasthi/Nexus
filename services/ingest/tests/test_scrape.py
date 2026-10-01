# SPDX-License-Identifier: Apache-2.0
"""Tests for /scrape/* endpoints."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from httpx import AsyncClient


class TestListSources:
    """GET /scrape/sources"""

    @pytest.mark.asyncio
    async def test_list_sources_returns_200(self, client: AsyncClient) -> None:
        resp = await client.get("/scrape/sources")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_list_sources_schema(self, client: AsyncClient) -> None:
        resp = await client.get("/scrape/sources")
        body = resp.json()
        assert "sources" in body
        assert isinstance(body["sources"], list)


class TestSingleScrape:
    """POST /scrape/{source}"""

    @pytest.mark.asyncio
    async def test_unknown_source_returns_422(self, client: AsyncClient) -> None:
        """Completely unknown source (not in the ScrapeSource enum) should fail validation."""
        resp = await client.post("/scrape/not_a_real_source", json={})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_valid_source_no_scraper_returns_404(self, client: AsyncClient) -> None:
        """A valid enum source with no registered scraper should return 404."""
        with patch(
            "nexus_ingest.routes.scrape.get_scraper_class",
            return_value=None,
        ):
            resp = await client.post("/scrape/bloomberg", json={})
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_valid_source_with_scraper_returns_200(self, client: AsyncClient) -> None:
        """When a scraper is available, the route should return a ScrapeResponse."""
        mock_article = MagicMock()
        mock_article.url = "https://example.com/article"
        mock_article.title = "Test Article"
        mock_article.text = "Body text"
        mock_article.source = "bloomberg"
        mock_article.published_at = None
        mock_article.age_hours = 0.5
        mock_article.raw_tickers = ["AAPL"]

        mock_scraper_cls = MagicMock()
        mock_scraper_cls.return_value.scrape_news.return_value = [mock_article]

        with patch(
            "nexus_ingest.routes.scrape.get_scraper_class",
            return_value=mock_scraper_cls,
        ):
            resp = await client.post("/scrape/bloomberg", json={"max_articles": 5})

        assert resp.status_code == 200
        body = resp.json()
        assert body["source"] == "bloomberg"
        assert isinstance(body["articles"], list)
        assert len(body["articles"]) == 1
        assert body["articles"][0]["title"] == "Test Article"
        assert isinstance(body["events"], list)
        assert "duration_ms" in body
        assert "scraped_at" in body

    @pytest.mark.asyncio
    async def test_scraper_exception_returns_502(self, client: AsyncClient) -> None:
        """A scraper that raises an exception should return HTTP 502."""
        mock_scraper_cls = MagicMock()
        mock_scraper_cls.return_value.scrape_news.side_effect = RuntimeError("network error")

        with patch(
            "nexus_ingest.routes.scrape.get_scraper_class",
            return_value=mock_scraper_cls,
        ):
            resp = await client.post("/scrape/reuters", json={})

        assert resp.status_code == 502

    @pytest.mark.asyncio
    async def test_scrape_request_max_articles_default(self, client: AsyncClient) -> None:
        """Default ScrapeRequest should be accepted (no body required)."""
        with patch(
            "nexus_ingest.routes.scrape.get_scraper_class",
            return_value=None,
        ):
            resp = await client.post("/scrape/bloomberg")
        # 404 because scraper not registered — but request was valid
        assert resp.status_code in (200, 404)


class TestBatchScrape:
    """POST /scrape/batch"""

    @pytest.mark.asyncio
    async def test_batch_missing_body_returns_422(self, client: AsyncClient) -> None:
        resp = await client.post("/scrape/batch", json={})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_batch_empty_sources_returns_422(self, client: AsyncClient) -> None:
        resp = await client.post("/scrape/batch", json={"sources": []})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_batch_valid_returns_200(self, client: AsyncClient) -> None:
        """Batch scrape with all scrapers absent should still succeed (empty results)."""
        with patch(
            "nexus_ingest.routes.scrape.get_scraper_class",
            return_value=None,
        ):
            resp = await client.post(
                "/scrape/batch",
                json={"sources": ["bloomberg", "reuters"]},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert "results" in body
        assert "total_articles" in body
        assert "total_events" in body
        assert len(body["results"]) == 2

    @pytest.mark.asyncio
    async def test_batch_partial_failure_still_returns_200(self, client: AsyncClient) -> None:
        """A batch where one scraper fails should still return 200 (partial results)."""
        good_article = MagicMock()
        good_article.url = "https://example.com"
        good_article.title = "Good"
        good_article.text = "ok"
        good_article.source = "bloomberg"
        good_article.published_at = None
        good_article.age_hours = 1.0
        good_article.raw_tickers = []

        good_scraper = MagicMock()
        good_scraper.return_value.scrape_news.return_value = [good_article]

        bad_scraper = MagicMock()
        bad_scraper.return_value.scrape_news.side_effect = RuntimeError("fail")

        call_count = 0

        def _scraper_factory(source):
            nonlocal call_count
            call_count += 1
            return good_scraper if source.value == "bloomberg" else bad_scraper

        with patch(
            "nexus_ingest.routes.scrape.get_scraper_class",
            side_effect=_scraper_factory,
        ):
            resp = await client.post(
                "/scrape/batch",
                json={"sources": ["bloomberg", "reuters"]},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert len(body["results"]) == 2
