#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
web_scraping_bridge.py — GhostStack web scraping bridge (port 7702).

Endpoints
---------
GET  /health        — liveness probe
POST /fetch         — HTTP GET + CSS selector extraction (standard headers)
POST /fetch_stealth — same but with browser-like User-Agent / Accept headers

Dependencies
------------
    pip install fastapi uvicorn httpx beautifulsoup4 lxml

httpx and beautifulsoup4 are optional — if absent the server starts but
all fetch calls return {"success": false, "error": "<dep> not available"}.
"""
from __future__ import annotations

import argparse
import logging
from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logger = logging.getLogger("web_scraping_bridge")
logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(name)s  %(message)s")

# ---------------------------------------------------------------------------
# Optional deps
# ---------------------------------------------------------------------------
try:
    import httpx  # type: ignore[import]
    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False
    logger.warning("httpx not installed — fetch requests will return errors. "
                   "Run: pip install httpx")

try:
    from bs4 import BeautifulSoup  # type: ignore[import]
    BS4_AVAILABLE = True
except ImportError:
    BS4_AVAILABLE = False
    logger.warning("beautifulsoup4 not installed — selector extraction disabled. "
                   "Run: pip install beautifulsoup4 lxml")

# ---------------------------------------------------------------------------
# Headers presets
# ---------------------------------------------------------------------------

_DEFAULT_HEADERS: dict[str, str] = {
    "User-Agent": "GhostStack/1.0 (+https://nexus.dev/ghoststack)",
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
}

_STEALTH_HEADERS: dict[str, str] = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "DNT": "1",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
}

# ---------------------------------------------------------------------------
# Request model
# ---------------------------------------------------------------------------

class FetchRequest(BaseModel):
    url: str
    selectors: list[str] = []
    timeout: int = 30_000          # milliseconds
    disable_resources: bool = True
    block_ads: bool = True


# ---------------------------------------------------------------------------
# Core fetch logic
# ---------------------------------------------------------------------------

def _extract_selectors(html: str, selectors: list[str]) -> dict[str, str]:
    """Extract text for each CSS selector from the HTML."""
    if not BS4_AVAILABLE or not selectors:
        return {}
    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception:
        soup = BeautifulSoup(html, "html.parser")
    result: dict[str, str] = {}
    for sel in selectors:
        try:
            el = soup.select_one(sel)
            result[sel] = el.get_text(separator=" ", strip=True) if el else ""
        except Exception:
            result[sel] = ""
    return result


async def _do_fetch(
    url: str,
    selectors: list[str],
    timeout_ms: int,
    headers: dict[str, str],
) -> dict[str, Any]:
    if not HTTPX_AVAILABLE:
        return {
            "success": False, "url": url, "status_code": 0,
            "html": "", "text": "", "extracted": {},
            "pages_crawled": 0, "bytes_fetched": 0,
            "error": "httpx not available — run: pip install httpx",
        }
    try:
        timeout_sec = timeout_ms / 1000.0
        async with httpx.AsyncClient(
            headers=headers,
            follow_redirects=True,
            timeout=timeout_sec,
        ) as client:
            resp = await client.get(url)

        html = resp.text
        text_content = ""
        extracted: dict[str, str] = {}

        if BS4_AVAILABLE:
            try:
                soup = BeautifulSoup(html, "lxml")
            except Exception:
                soup = BeautifulSoup(html, "html.parser")
            text_content = soup.get_text(separator=" ", strip=True)
            extracted = _extract_selectors(html, selectors)
        else:
            # Fallback: return raw HTML slice as text
            text_content = html[:50_000]
            extracted = {sel: "" for sel in selectors}

        bytes_fetched = len(resp.content)
        success = resp.status_code < 400

        return {
            "success": success,
            "url": str(resp.url),
            "status_code": resp.status_code,
            "html": html,
            "text": text_content,
            "extracted": extracted,
            "pages_crawled": 1,
            "bytes_fetched": bytes_fetched,
            "error": "" if success else f"HTTP {resp.status_code}",
        }
    except Exception as exc:
        logger.error("Fetch failed for %s: %s", url, exc)
        return {
            "success": False, "url": url, "status_code": 0,
            "html": "", "text": "", "extracted": {},
            "pages_crawled": 0, "bytes_fetched": 0,
            "error": str(exc),
        }


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------

def create_app() -> FastAPI:
    app = FastAPI(title="GhostStack Web Scraping Bridge")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"status": "ok", "httpx": HTTPX_AVAILABLE, "bs4": BS4_AVAILABLE}

    @app.post("/fetch")
    async def fetch(req: FetchRequest) -> JSONResponse:
        result = await _do_fetch(req.url, req.selectors, req.timeout, _DEFAULT_HEADERS)
        return JSONResponse(result)

    @app.post("/fetch_stealth")
    async def fetch_stealth(req: FetchRequest) -> JSONResponse:
        result = await _do_fetch(req.url, req.selectors, req.timeout, _STEALTH_HEADERS)
        return JSONResponse(result)

    return app


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    import uvicorn  # type: ignore[import]
    parser = argparse.ArgumentParser(description="GhostStack web scraping bridge")
    parser.add_argument("--port", type=int, default=7702, help="Listen port (default: 7702)")
    parser.add_argument("--host", default="127.0.0.1", help="Listen host (default: 127.0.0.1)")
    args = parser.parse_args()
    logger.info("Starting web scraping bridge on %s:%d", args.host, args.port)
    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
