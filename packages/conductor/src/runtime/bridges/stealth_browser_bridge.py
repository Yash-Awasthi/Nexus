# SPDX-License-Identifier: Apache-2.0
"""
GhostStack stealth browser bridge.

Stealth Chromium automation that bypasses bot-detection systems
(Cloudflare, FingerprintJS, reCAPTCHA v3). Exposed as a local FastAPI
server on port 7701.

Endpoints:
  POST /browse        — navigate, extract HTML, optionally screenshot
  POST /screenshot    — capture full-page PNG as base64
  POST /interact      — navigate + execute action sequence (click/type/scroll)
  GET  /health        — liveness probe
"""

from __future__ import annotations

import argparse
import base64
import io
import sys
import traceback
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# ── Conditional import: graceful degradation when stealth engine not installed ──
try:
    from cloakbrowser import launch_async as cb_launch_async
    _STEALTH_AVAILABLE = True
except ImportError:
    _STEALTH_AVAILABLE = False

app = FastAPI(title="stealth-browser-bridge", version="1.0.0")


# ── Request / response models ──────────────────────────────────────────────────

class BrowseRequest(BaseModel):
    url: str
    headless: bool = True
    humanize: bool = False
    solve_cloudflare: bool = False
    wait_selector: str | None = None
    timeout_ms: int = Field(default=30_000, ge=1_000, le=120_000)
    proxy: str | None = None
    disable_resources: bool = True

class InteractAction(BaseModel):
    type: str          # "click" | "type" | "scroll" | "wait" | "navigate"
    selector: str | None = None
    value: str | None = None
    delay_ms: int = 0

class InteractRequest(BaseModel):
    url: str
    actions: list[InteractAction] = []
    headless: bool = True
    humanize: bool = True
    timeout_ms: int = Field(default=30_000, ge=1_000, le=120_000)
    proxy: str | None = None

class BrowseResponse(BaseModel):
    success: bool
    html: str = ""
    title: str = ""
    final_url: str = ""
    screenshot_b64: str = ""
    error: str = ""

class ScreenshotRequest(BaseModel):
    url: str
    headless: bool = True
    full_page: bool = True
    timeout_ms: int = Field(default=30_000, ge=1_000, le=120_000)
    proxy: str | None = None


# ── Helpers ────────────────────────────────────────────────────────────────────

async def _fetch_with_cloak(req: BrowseRequest, capture_screenshot: bool = False) -> BrowseResponse:
    """Stealth Chromium navigation with full bot-bypass."""
    import asyncio

    async with await cb_launch_async(
        headless=req.headless,
        humanize=req.humanize,
        proxy=req.proxy,
        disable_resources=req.disable_resources,
    ) as browser:
        context = await browser.new_context()
        page = await context.new_page()

        try:
            await page.goto(req.url, timeout=req.timeout_ms)

            if req.solve_cloudflare:
                # Give Cloudflare challenge time to resolve
                await asyncio.sleep(3)

            if req.wait_selector:
                await page.wait_for_selector(req.wait_selector, timeout=req.timeout_ms)

            html = await page.content()
            title = await page.title()
            final_url = page.url

            screenshot_b64 = ""
            if capture_screenshot:
                buf = await page.screenshot(full_page=True)
                screenshot_b64 = base64.b64encode(buf).decode()

            return BrowseResponse(
                success=True,
                html=html,
                title=title,
                final_url=final_url,
                screenshot_b64=screenshot_b64,
            )
        except Exception as exc:
            return BrowseResponse(success=False, error=str(exc))
        finally:
            await context.close()


async def _interact_with_cloak(req: InteractRequest) -> BrowseResponse:
    """Navigate and execute an action sequence with stealth Chromium."""
    async with await cb_launch_async(
        headless=req.headless,
        humanize=req.humanize,
        proxy=req.proxy,
    ) as browser:
        context = await browser.new_context()
        page = await context.new_page()
        import asyncio

        try:
            await page.goto(req.url, timeout=req.timeout_ms)

            for action in req.actions:
                if action.delay_ms > 0:
                    await asyncio.sleep(action.delay_ms / 1000)

                if action.type == "click" and action.selector:
                    await page.click(action.selector)
                elif action.type == "type" and action.selector and action.value:
                    await page.fill(action.selector, action.value)
                elif action.type == "scroll":
                    await page.evaluate("window.scrollBy(0, window.innerHeight)")
                elif action.type == "wait" and action.selector:
                    await page.wait_for_selector(action.selector, timeout=req.timeout_ms)
                elif action.type == "navigate" and action.value:
                    await page.goto(action.value, timeout=req.timeout_ms)

            html = await page.content()
            title = await page.title()
            return BrowseResponse(
                success=True, html=html, title=title, final_url=page.url
            )
        except Exception as exc:
            return BrowseResponse(success=False, error=str(exc))
        finally:
            await context.close()


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "stealth_available": _STEALTH_AVAILABLE}


@app.post("/browse", response_model=BrowseResponse)
async def browse(req: BrowseRequest):
    if not _STEALTH_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="Stealth browser unavailable: engine not installed. Run: pip install cloakbrowser"
        )
    try:
        return await _fetch_with_cloak(req)
    except Exception:
        raise HTTPException(status_code=500, detail=traceback.format_exc())


@app.post("/screenshot", response_model=BrowseResponse)
async def screenshot(req: ScreenshotRequest):
    if not _STEALTH_AVAILABLE:
        raise HTTPException(status_code=503, detail="Stealth browser unavailable")
    browse_req = BrowseRequest(
        url=req.url,
        headless=req.headless,
        timeout_ms=req.timeout_ms,
        proxy=req.proxy,
    )
    try:
        return await _fetch_with_cloak(browse_req, capture_screenshot=True)
    except Exception:
        raise HTTPException(status_code=500, detail=traceback.format_exc())


@app.post("/interact", response_model=BrowseResponse)
async def interact(req: InteractRequest):
    if not _STEALTH_AVAILABLE:
        raise HTTPException(status_code=503, detail="Stealth browser unavailable")
    try:
        return await _interact_with_cloak(req)
    except Exception:
        raise HTTPException(status_code=500, detail=traceback.format_exc())


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=7701)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
