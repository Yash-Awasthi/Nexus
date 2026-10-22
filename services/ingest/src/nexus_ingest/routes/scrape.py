# SPDX-License-Identifier: Apache-2.0
"""nexus-ingest — /scrape/* routes.

Each route invokes a FinScrape scraper, converts the output to our wire types,
and returns ScrapeResponse or BatchScrapeResponse.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path

from nexus_ingest.auth import verify_token
from nexus_ingest.models import (
    ArticleOut,
    BatchScrapeRequest,
    BatchScrapeResponse,
    ScrapeRequest,
    ScrapeResponse,
    ScrapeSource,
)
from nexus_ingest.settings import get_settings
from nexus_ingest.scrapers.registry import SCRAPER_REGISTRY, get_scraper_class

router = APIRouter(prefix="/scrape", tags=["scrape"], dependencies=[Depends(verify_token)])
logger = logging.getLogger(__name__)


def _article_to_out(article: Any) -> ArticleOut:
    """Convert a finscrape ScrapedArticle to our wire type."""
    return ArticleOut(
        url=article.url,
        title=article.title,
        text=article.text,
        source=article.source,
        published_at=article.published_at,
        age_hours=article.age_hours,
        raw_tickers=article.raw_tickers or [],
    )


async def _run_scraper(source: ScrapeSource, max_articles: int, max_age_hours: float) -> ScrapeResponse:
    """Run a single scraper in a thread pool (scrapers are sync)."""
    scraper_cls = get_scraper_class(source)
    if scraper_cls is None:
        raise HTTPException(status_code=404, detail=f"No scraper registered for source: {source}")

    import os
    os.environ["FINSCRAPE_MAX_AGE_HOURS"] = str(max_age_hours)

    start = time.monotonic()

    try:
        # Run the blocking scraper in a thread pool
        loop = asyncio.get_event_loop()
        scraper = scraper_cls(max_articles=max_articles)
        articles = await loop.run_in_executor(None, scraper.scrape_news)
    except Exception as exc:
        # Sanitize source value to prevent log injection via newline chars
        safe_source = str(source.value).replace("\n", "\\n").replace("\r", "\\r")
        logger.error("Scraper %s failed: %s", safe_source, exc, exc_info=True)
        raise HTTPException(status_code=502, detail=f"Scraper {source} failed: {exc}") from exc

    duration_ms = (time.monotonic() - start) * 1000
    articles_out = [_article_to_out(a) for a in articles]

    return ScrapeResponse(
        source=source,
        articles=articles_out,
        # Analysis needs an LLM and an event store; it runs in FinScrape's worker, not here.
        events=[],
        duration_ms=round(duration_ms, 1),
        scraped_at=datetime.now(timezone.utc).isoformat(),
    )


@router.post("/batch", response_model=BatchScrapeResponse, summary="Scrape multiple sources concurrently")
async def scrape_batch(body: BatchScrapeRequest) -> BatchScrapeResponse:
    """
    Trigger concurrent scrapes for multiple sources.

    Runs all scrapers in parallel; failed individual sources return empty results
    rather than failing the whole batch.
    """
    settings = get_settings()
    start = time.monotonic()

    tasks = [
        _run_scraper(source, body.max_articles or settings.max_articles, body.max_age_hours or settings.max_age_hours)
        for source in body.sources
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    scrape_responses: list[ScrapeResponse] = []
    for i, result in enumerate(results):
        if isinstance(result, Exception):
            safe_src = str(body.sources[i].value).replace("\n", "\\n").replace("\r", "\\r")
            logger.error("Batch scraper %s failed: %s", safe_src, result)
            # Return empty result for failed source
            scrape_responses.append(ScrapeResponse(
                source=body.sources[i],
                articles=[],
                events=[],
                duration_ms=0.0,
                scraped_at=datetime.now(timezone.utc).isoformat(),
            ))
        else:
            scrape_responses.append(result)

    total_duration = (time.monotonic() - start) * 1000
    return BatchScrapeResponse(
        results=scrape_responses,
        total_articles=sum(len(r.articles) for r in scrape_responses),
        total_events=sum(len(r.events) for r in scrape_responses),
        duration_ms=round(total_duration, 1),
        scraped_at=datetime.now(timezone.utc).isoformat(),
    )


@router.get("/sources", summary="List available scraper sources")
async def list_sources() -> dict[str, list[str]]:
    """Return the list of registered scraper source names."""
    return {"sources": list(SCRAPER_REGISTRY.keys())}


@router.post("/{source}", response_model=ScrapeResponse, summary="Scrape a single source")
async def scrape_source(
    source: ScrapeSource = Path(..., description="Financial data source to scrape"),
    body: ScrapeRequest = ScrapeRequest(),
) -> ScrapeResponse:
    """
    Trigger a scrape for the given source.

    Returns articles and (if the pipeline is available) analysed financial events.
    """
    settings = get_settings()
    return await _run_scraper(
        source,
        max_articles=body.max_articles or settings.max_articles,
        max_age_hours=body.max_age_hours or settings.max_age_hours,
    )
