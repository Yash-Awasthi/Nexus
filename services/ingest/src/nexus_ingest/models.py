# SPDX-License-Identifier: Apache-2.0
"""nexus-ingest — Pydantic request/response models.

These are the canonical wire types for the ingest service REST API.
They mirror @nexus/contracts scrape.ts so TypeScript clients get matching types.
"""
from __future__ import annotations

from enum import Enum
from typing import Any, Optional
from pydantic import BaseModel, Field

# ── Scrape sources ─────────────────────────────────────────────────────────────

class ScrapeSource(str, Enum):
    BLOOMBERG = "bloomberg"
    REUTERS = "reuters"
    EDGAR = "edgar"
    YAHOO = "yahoo"
    CNBC = "cnbc"
    FT = "ft"
    BENZINGA = "benzinga"
    GOOGLE_NEWS = "google_news"
    GOOGLE_SERP = "google_serp"
    INVESTINGCOM = "investingcom"
    MARKETWATCH = "marketwatch"
    RSS = "rss"
    SEEKINGALPHA = "seekingalpha"

# ── Requests ───────────────────────────────────────────────────────────────────

class ScrapeRequest(BaseModel):
    max_articles: int = Field(20, ge=1, le=200, description="Max articles to return")
    max_age_hours: float = Field(2.0, ge=0.0, le=168.0, description="Max article age in hours")

class BatchScrapeRequest(BaseModel):
    sources: list[ScrapeSource] = Field(..., min_length=1, max_length=13)
    max_articles: int = Field(20, ge=1, le=200)
    max_age_hours: float = Field(2.0, ge=0.0, le=168.0)

# ── Article output ─────────────────────────────────────────────────────────────

class ArticleOut(BaseModel):
    url: str
    title: str
    text: str
    source: str
    published_at: Optional[str] = None
    age_hours: Optional[float] = None
    raw_tickers: list[str] = Field(default_factory=list)

# ── Financial event output ─────────────────────────────────────────────────────

class Verdict(str, Enum):
    INVEST = "INVEST"
    OBSERVE = "OBSERVE"
    CAUTIOUS = "CAUTIOUS"
    PULL_OUT = "PULL_OUT"

class FinEventOut(BaseModel):
    subject: str
    event_type: str
    tickers: list[str]
    impact_direction: str
    signal_score: int
    confidence: float
    verdict: str
    heuristic_impact: float = 0.0
    divergence_flag: bool = False
    sources: list[str] = Field(default_factory=list)
    articles: list[str] = Field(default_factory=list)
    timestamp: str
    reasoning: str = ""
    magnitude: str = "medium"
    novelty: str = "standard"
    actionability: str = "medium"
    affected_entities: list[Any] = Field(default_factory=list)
    second_order_effects: list[Any] = Field(default_factory=list)
    sector_impact: str = ""
    key_metrics: dict[str, Any] = Field(default_factory=dict)

# ── Responses ─────────────────────────────────────────────────────────────────

class ScrapeResponse(BaseModel):
    source: ScrapeSource
    articles: list[ArticleOut]
    events: list[FinEventOut]
    duration_ms: float
    scraped_at: str

class BatchScrapeResponse(BaseModel):
    results: list[ScrapeResponse]
    total_articles: int
    total_events: int
    duration_ms: float
    scraped_at: str

# ── Health ────────────────────────────────────────────────────────────────────

class HealthResponse(BaseModel):
    status: str = "ok"
    version: str
    scrapers: list[str]
