# SPDX-License-Identifier: Apache-2.0
"""
Scraper registry.

Maps each ScrapeSource value to the corresponding finscrape scraper class.
Imports are lazy so the service starts even if a scraper's optional deps are missing.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from nexus_ingest.models import ScrapeSource

logger = logging.getLogger(__name__)

# ── Lazy imports ───────────────────────────────────────────────────────────────
# Each entry maps source name → (module_path, class_name)
_SCRAPER_MAP: dict[str, tuple[str, str]] = {
    ScrapeSource.BLOOMBERG: ("finscrape.scrapers.bloomberg", "BloombergScraper"),
    ScrapeSource.REUTERS: ("finscrape.scrapers.reuters", "ReutersScraper"),
    ScrapeSource.EDGAR: ("finscrape.scrapers.edgar", "EdgarScraper"),
    ScrapeSource.YAHOO: ("finscrape.scrapers.yahoo", "YahooScraper"),
    ScrapeSource.CNBC: ("finscrape.scrapers.cnbc", "CNBCScraper"),
    ScrapeSource.FT: ("finscrape.scrapers.ft", "FTScraper"),
    ScrapeSource.BENZINGA: ("finscrape.scrapers.benzinga", "BenzingaScraper"),
    ScrapeSource.GOOGLE_NEWS: ("finscrape.scrapers.google_news", "GoogleNewsScraper"),
    ScrapeSource.GOOGLE_SERP: ("finscrape.scrapers.google_serp", "GoogleSerpScraper"),
    ScrapeSource.INVESTINGCOM: ("finscrape.scrapers.investingcom", "InvestingComScraper"),
    ScrapeSource.MARKETWATCH: ("finscrape.scrapers.marketwatch", "MarketWatchScraper"),
    ScrapeSource.RSS: ("finscrape.scrapers.rss", "RSSScraper"),
    ScrapeSource.SEEKINGALPHA: ("finscrape.scrapers.seekingalpha", "SeekingAlphaScraper"),
}

# Populated on first call to get_scraper_class
SCRAPER_REGISTRY: dict[str, Any] = {}


def get_scraper_class(source: ScrapeSource) -> Optional[Any]:
    """
    Lazily import and return the scraper class for the given source.
    Returns None if the scraper is unavailable (missing dep, import error).
    """
    key = source.value
    if key in SCRAPER_REGISTRY:
        return SCRAPER_REGISTRY[key]

    entry = _SCRAPER_MAP.get(source)
    if entry is None:
        logger.warning("No scraper mapping for source: %s", source)
        return None

    module_path, class_name = entry
    try:
        import importlib
        module = importlib.import_module(module_path)
        cls = getattr(module, class_name)
        SCRAPER_REGISTRY[key] = cls
        logger.debug("Loaded scraper %s from %s", class_name, module_path)
        return cls
    except ImportError as exc:
        logger.warning("Cannot load scraper %s: %s", source, exc)
        return None


def warm_registry() -> dict[str, bool]:
    """
    Pre-load all scraper classes and return a status map.
    Called at startup to surface import issues early.
    """
    status: dict[str, bool] = {}
    for source in ScrapeSource:
        cls = get_scraper_class(source)
        status[source.value] = cls is not None
    return status
