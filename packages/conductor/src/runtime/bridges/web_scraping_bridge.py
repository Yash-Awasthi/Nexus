# SPDX-License-Identifier: Apache-2.0
"""
GhostStack web scraping bridge.

Adaptive, anti-detection scraping engine with multiple fetcher backends:
HTTP (curl_cffi), stealth Chromium, and regular Chromium for
JavaScript-heavy targets. Exposed as a local FastAPI server on port 7702.

Endpoints:
  POST /fetch         — fetch a URL with the standard HTTP fetcher
  POST /fetch_stealth — fetch with full stealth Chromium (anti-bot bypass)
  POST /fetch_js      — fetch with regular Chromium for JS-rendered pages
  POST /spider        — multi-page crawl up to maxDepth/maxPages
  GET  /health        — liveness probe
"""

from __future__ import annotations

import argparse
import traceback
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# ── Conditional imports ───────────────────────────────────────────────────────
try:
    from scrapling.fetchers import Fetcher, StealthyFetcher
    _SCRAPLING_AVAILABLE = True
except ImportError:
    _SCRAPLING_AVAILABLE = False

try:
    from scrapling.fetchers import PlayWrightFetcher as _JsFetcher  # availability check only
    _JS_FETCHER_AVAILABLE = True
except ImportError:
    _JS_FETCHER_AVAILABLE = False

app = FastAPI(title="scraping-bridge", version="1.0.0")


# ── Models ─────────────────────────────────────────────────────────────────────

class FetchRequest(BaseModel):
    url: str
    selectors: list[str] = []
    timeout: int = Field(default=30_000, ge=1_000, le=120_000)
    proxy: str | None = None
    headless: bool = True
    disable_resources: bool = True
    google_search: bool = True
    block_ads: bool = True

class SpiderRequest(BaseModel):
    url: str
    selectors: list[str] = []
    max_depth: int = Field(default=2, ge=1, le=5)
    max_pages: int = Field(default=10, ge=1, le=50)
    timeout: int = Field(default=30_000, ge=1_000, le=120_000)
    proxy: str | None = None

class FetchResponse(BaseModel):
    success: bool
    url: str
    status_code: int = 0
    html: str = ""
    text: str = ""
    extracted: dict[str, str] = {}
    pages_crawled: int = 1
    bytes_fetched: int = 0
    error: str = ""


# ── Helpers ────────────────────────────────────────────────────────────────────

def _extract_selectors(response: Any, selectors: list[str]) -> dict[str, str]:
    """Extract CSS selector results from a parsed response."""
    extracted: dict[str, str] = {}
    if not selectors:
        return extracted
    try:
        page = response.html_parser
        for sel in selectors:
            try:
                elements = page.css(sel)
                extracted[sel] = " | ".join(el.text for el in elements if el.text)
            except Exception:  # selector not found in page — return empty
                extracted[sel] = ""
    except Exception:
        pass
    return extracted


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "scraping_available": _SCRAPLING_AVAILABLE,
        "js_fetcher_available": _JS_FETCHER_AVAILABLE,
    }


@app.post("/fetch", response_model=FetchResponse)
async def fetch(req: FetchRequest):
    if not _SCRAPLING_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="Scraping engine not installed. Run: pip install scrapling"
        )
    try:
        kwargs: dict[str, Any] = {
            "timeout": req.timeout,
            "google_search": req.google_search,
        }
        if req.proxy:
            kwargs["proxy"] = req.proxy

        response = Fetcher.get(req.url, **kwargs)
        html = str(response.body or "")
        text = response.get_all_text(separator="\n") if hasattr(response, "get_all_text") else html
        extracted = _extract_selectors(response, req.selectors)

        return FetchResponse(
            success=True,
            url=req.url,
            status_code=response.status or 200,
            html=html,
            text=text[:50_000],  # cap at 50KB text
            extracted=extracted,
            bytes_fetched=len(html.encode("utf-8")),
        )
    except Exception:
        return FetchResponse(success=False, url=req.url, error=traceback.format_exc())


@app.post("/fetch_stealth", response_model=FetchResponse)
async def fetch_stealth(req: FetchRequest):
    if not _SCRAPLING_AVAILABLE:
        raise HTTPException(status_code=503, detail="Scraping engine not installed")
    try:
        kwargs: dict[str, Any] = {
            "headless": req.headless,
            "disable_resources": req.disable_resources,
            "block_ads": req.block_ads,
            "timeout": req.timeout,
        }
        if req.proxy:
            kwargs["proxy"] = req.proxy

        response = StealthyFetcher.fetch(req.url, **kwargs)
        html = str(response.body or "")
        text = response.get_all_text(separator="\n") if hasattr(response, "get_all_text") else html
        extracted = _extract_selectors(response, req.selectors)

        return FetchResponse(
            success=True,
            url=req.url,
            status_code=response.status or 200,
            html=html,
            text=text[:50_000],
            extracted=extracted,
            bytes_fetched=len(html.encode("utf-8")),
        )
    except Exception:
        return FetchResponse(success=False, url=req.url, error=traceback.format_exc())


@app.post("/spider", response_model=FetchResponse)
async def spider(req: SpiderRequest):
    """Simple multi-page BFS crawler using the standard HTTP fetcher."""
    if not _SCRAPLING_AVAILABLE:
        raise HTTPException(status_code=503, detail="Scraping engine not installed")

    from urllib.parse import urljoin, urlparse

    visited: set[str] = set()
    queue: list[tuple[str, int]] = [(req.url, 0)]
    all_text: list[str] = []
    all_extracted: dict[str, list[str]] = {s: [] for s in req.selectors}
    pages_crawled = 0
    bytes_total = 0
    base_domain = urlparse(req.url).netloc

    try:
        while queue and pages_crawled < req.max_pages:
            url, depth = queue.pop(0)
            if url in visited:
                continue
            visited.add(url)

            try:
                response = Fetcher.get(url, timeout=req.timeout)
                html = str(response.body or "")
                bytes_total += len(html.encode("utf-8"))
                pages_crawled += 1

                if hasattr(response, "get_all_text"):
                    all_text.append(response.get_all_text(separator="\n"))

                for sel in req.selectors:
                    try:
                        page = response.html_parser
                        elems = page.css(sel)
                        all_extracted[sel].extend(el.text for el in elems if el.text)
                    except Exception:  # CSS selector extraction failed — skip this selector
                        pass

                if depth < req.max_depth:
                    try:
                        page = response.html_parser
                        for link in page.css("a[href]"):
                            href = link.attrib.get("href", "")
                            full = urljoin(url, href)
                            if urlparse(full).netloc == base_domain and full not in visited:
                                queue.append((full, depth + 1))
                    except Exception:  # link extraction failed — skip this page
                        pass
            except Exception:  # page fetch failed — continue with next URL
                continue

        merged_extracted = {k: " | ".join(v) for k, v in all_extracted.items()}
        return FetchResponse(
            success=True,
            url=req.url,
            html="",
            text="\n---\n".join(all_text)[:100_000],
            extracted=merged_extracted,
            pages_crawled=pages_crawled,
            bytes_fetched=bytes_total,
        )
    except Exception:
        return FetchResponse(success=False, url=req.url, error=traceback.format_exc())


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=7702)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
