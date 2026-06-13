#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
stealth_browser_bridge.py — GhostStack stealth browser bridge (port 7701).

Backend: CloakBrowser (production anti-detection, human mouse/keyboard).
Extraction layer: Scrapling (adaptive CSS/XPath, auto-selector healing).

Endpoints
---------
GET  /health    — liveness probe; reports CloakBrowser + Scrapling availability
POST /browse    — navigate to URL, return HTML / title / screenshot + extracted
POST /interact  — navigate + execute action sequence, return same payload

Env vars
--------
CLOAKBROWSER_PATH   Absolute path to the CloakBrowser executable.
                    CloakBrowser is not installed as a Python package — it is
                    a binary that the Python SDK wraps.  Required for live
                    browser tasks; bridge starts without it but returns errors.

Dependencies
------------
    pip install cloakbrowser scrapling fastapi uvicorn

If either dependency is missing the server still starts; affected endpoints
return {"success": false, "error": "…"}.
"""
from __future__ import annotations

import argparse
import base64
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logger = logging.getLogger("stealth_browser_bridge")
logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(name)s  %(message)s")

_CLOAKBROWSER_PATH: str = os.environ.get("CLOAKBROWSER_PATH", "")

# ---------------------------------------------------------------------------
# Optional deps
# ---------------------------------------------------------------------------

try:
    from cloakbrowser import CloakBrowser, HumanMouse, HumanKeyboard  # type: ignore[import]

    CLOAKBROWSER_AVAILABLE = True
    logger.info("CloakBrowser SDK loaded (binary: %s)", _CLOAKBROWSER_PATH or "auto-detect")
except ImportError:
    CLOAKBROWSER_AVAILABLE = False
    logger.warning(
        "cloakbrowser not installed — live browser tasks will return errors. "
        "Run: pip install cloakbrowser && set CLOAKBROWSER_PATH=/path/to/binary"
    )

try:
    from scrapling import Adaptor  # type: ignore[import]

    SCRAPLING_AVAILABLE = True
    logger.info("Scrapling loaded — adaptive extraction enabled")
except ImportError:
    SCRAPLING_AVAILABLE = False
    logger.warning(
        "scrapling not installed — extraction layer disabled. "
        "Run: pip install scrapling"
    )

# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class BrowserAction(BaseModel):
    type: str               # navigate | click | type | wait | scroll
    selector: str | None = None
    value: str | None = None


class BrowseRequest(BaseModel):
    url: str
    headless: bool = True
    humanize: bool = True   # Use human mouse/keyboard simulation (CloakBrowser feature)
    timeout_ms: int = 30_000
    disable_resources: bool = False
    extract_selectors: list[str] = []   # CSS selectors to extract via Scrapling


class InteractRequest(BrowseRequest):
    actions: list[BrowserAction] = []


# ---------------------------------------------------------------------------
# Scrapling extraction helper
# ---------------------------------------------------------------------------


def _scrapling_extract(
    html: str,
    url: str,
    selectors: list[str],
) -> dict[str, list[str]]:
    """
    Run Scrapling's adaptive CSS extraction over already-fetched HTML.

    Returns a dict mapping each selector to the list of matched text values.
    Gracefully returns empty lists when Scrapling is unavailable or a
    selector errors out.
    """
    if not SCRAPLING_AVAILABLE or not selectors:
        return {}
    results: dict[str, list[str]] = {}
    try:
        page = Adaptor(html, url=url)
        for sel in selectors:
            try:
                matched = page.css(sel).getall()
                results[sel] = [str(m) for m in matched if m is not None]
            except Exception as exc:
                logger.debug("Scrapling selector %r failed: %s", sel, exc)
                results[sel] = []
    except Exception as exc:
        logger.warning("Scrapling extraction failed: %s", exc)
    return results


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------


def create_app() -> FastAPI:
    _browser: Any = None

    @asynccontextmanager
    async def lifespan(_app: FastAPI):  # noqa: ANN001
        nonlocal _browser
        if CLOAKBROWSER_AVAILABLE:
            cb = CloakBrowser(
                executable=_CLOAKBROWSER_PATH if _CLOAKBROWSER_PATH else None,
                headless=True,
            )
            await cb.launch()
            _browser = cb
            logger.info("CloakBrowser launched")
        yield
        if _browser is not None:
            try:
                await _browser.close()
            except Exception:
                pass
        logger.info("Browser bridge shut down")

    app = FastAPI(
        title="GhostStack Stealth Browser Bridge",
        description="CloakBrowser + Scrapling — anti-detection browsing with adaptive extraction",
        version="2.0.0",
        lifespan=lifespan,
    )

    # ── core navigation helper ──────────────────────────────────────────────

    async def _run_session(
        url: str,
        actions: list[BrowserAction],
        timeout_ms: int,
        humanize: bool,
        extract_selectors: list[str],
    ) -> dict[str, Any]:
        if not CLOAKBROWSER_AVAILABLE or _browser is None:
            return {
                "success": False,
                "html": "",
                "title": "",
                "final_url": url,
                "screenshot_b64": "",
                "extracted": {},
                "error": (
                    "cloakbrowser not available — "
                    "install it and set CLOAKBROWSER_PATH"
                ),
            }

        page = await _browser.new_page()
        mouse = HumanMouse(page) if humanize else None
        keyboard = HumanKeyboard(page) if humanize else None

        try:
            await page.goto(url, timeout=timeout_ms)

            for action in actions:
                atype = action.type

                if atype == "navigate" and action.value:
                    await page.goto(action.value, timeout=timeout_ms)

                elif atype == "click" and action.selector:
                    if mouse is not None:
                        # CloakBrowser: bezier-curve mouse movement to element
                        await mouse.click(action.selector)
                    else:
                        await page.click(action.selector, timeout=timeout_ms)

                elif atype == "type" and action.selector and action.value:
                    if keyboard is not None:
                        # CloakBrowser: per-keystroke random timing jitter
                        await keyboard.type(action.selector, action.value)
                    else:
                        await page.fill(action.selector, action.value)

                elif atype == "wait" and action.selector:
                    await page.wait_for_selector(action.selector, timeout=timeout_ms)

                elif atype == "scroll":
                    # Gentle human-speed scroll
                    await page.evaluate(
                        "window.scrollBy({top: window.innerHeight, behavior: 'smooth'})"
                    )

            html: str = await page.content()
            title: str = await page.title()
            final_url: str = page.url
            screenshot_bytes: bytes = await page.screenshot(type="png")
            screenshot_b64 = base64.b64encode(screenshot_bytes).decode()

            # Scrapling extraction layer — runs on already-fetched HTML
            extracted = _scrapling_extract(html, final_url, extract_selectors)

            return {
                "success": True,
                "html": html,
                "title": title,
                "final_url": final_url,
                "screenshot_b64": screenshot_b64,
                "extracted": extracted,
                "error": "",
            }

        except Exception as exc:
            logger.error("Browser session failed: %s", exc)
            return {
                "success": False,
                "html": "",
                "title": "",
                "final_url": url,
                "screenshot_b64": "",
                "extracted": {},
                "error": str(exc),
            }
        finally:
            await page.close()

    # ── routes ──────────────────────────────────────────────────────────────

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "backend": "cloakbrowser",
            "cloakbrowser_available": CLOAKBROWSER_AVAILABLE,
            "scrapling_available": SCRAPLING_AVAILABLE,
            "binary_path": _CLOAKBROWSER_PATH or "(auto-detect)",
            "browser_active": _browser is not None,
        }

    @app.post("/browse")
    async def browse(req: BrowseRequest) -> JSONResponse:
        result = await _run_session(
            url=req.url,
            actions=[],
            timeout_ms=req.timeout_ms,
            humanize=req.humanize,
            extract_selectors=req.extract_selectors,
        )
        return JSONResponse(result)

    @app.post("/interact")
    async def interact(req: InteractRequest) -> JSONResponse:
        result = await _run_session(
            url=req.url,
            actions=req.actions,
            timeout_ms=req.timeout_ms,
            humanize=req.humanize,
            extract_selectors=req.extract_selectors,
        )
        return JSONResponse(result)

    return app


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    import uvicorn  # type: ignore[import]

    parser = argparse.ArgumentParser(description="GhostStack stealth browser bridge")
    parser.add_argument("--port", type=int, default=7701, help="Listen port (default: 7701)")
    parser.add_argument("--host", default="127.0.0.1", help="Listen host (default: 127.0.0.1)")
    args = parser.parse_args()

    logger.info(
        "Starting stealth browser bridge on %s:%d  (CloakBrowser: %s  Scrapling: %s)",
        args.host,
        args.port,
        "yes" if CLOAKBROWSER_AVAILABLE else "no",
        "yes" if SCRAPLING_AVAILABLE else "no",
    )
    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
