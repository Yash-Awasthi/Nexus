# SPDX-License-Identifier: Apache-2.0
"""
URL crawling task.

Fetches a URL, extracts the main text content, and dispatches an
index_document task for the result.  Runs in a background worker to avoid
blocking the request thread.

Task inputs
───────────
  url      : str  — URL to fetch
  metadata : dict — caller metadata merged with extracted content metadata

Task output
───────────
  {"url": str, "content_length": int, "index_task_id": str | None, "status": "ok" | "error"}
"""
from __future__ import annotations

import logging
import os
import re
import time
import uuid
from typing import Any
from urllib.parse import urlparse

from nexus_ingest.celery_app import celery_app
from nexus_ingest.tasks.index_document import index_document

logger = logging.getLogger(__name__)

# ── HTML stripping ────────────────────────────────────────────────────────────

_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s{2,}")


def strip_html(html: str) -> str:
    """Very lightweight HTML → plain-text (no external deps required)."""
    # Remove script/style blocks entirely
    text = re.sub(r"<(?:script|style)[^>]*>[\s\S]*?</(?:script|style)>", "", html, flags=re.IGNORECASE)
    text = _TAG_RE.sub(" ", text)
    # Decode common entities
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">") \
               .replace("&quot;", '"').replace("&#39;", "'").replace("&nbsp;", " ")
    text = _WHITESPACE_RE.sub(" ", text).strip()
    return text


# ── HTTP fetch ────────────────────────────────────────────────────────────────

def _fetch_url(url: str, timeout: int = 20) -> tuple[str, str]:
    """
    Fetch a URL and return (content_type, body).
    Uses httpx if available; falls back to urllib.
    """
    try:
        import httpx  # type: ignore[import]
        resp = httpx.get(url, timeout=timeout, follow_redirects=True,
                         headers={"User-Agent": "nexus-ingest/0.0.0 (+https://nexus.ai)"})
        resp.raise_for_status()
        return resp.headers.get("content-type", ""), resp.text
    except ImportError:
        import urllib.request
        req = urllib.request.Request(
            url, headers={"User-Agent": "nexus-ingest/0.0.0 (+https://nexus.ai)"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            content_type = r.headers.get("Content-Type", "")
            body = r.read().decode("utf-8", errors="replace")
        return content_type, body


# ── Task ─────────────────────────────────────────────────────────────────────

@celery_app.task(
    name="nexus_ingest.tasks.crawl_url.crawl_url",
    bind=True,
    max_retries=2,
    default_retry_delay=10,
)
def crawl_url(
    self: Any,
    url: str,
    metadata: dict[str, Any] | None = None,
    trigger_index: bool = True,
) -> dict[str, Any]:
    """
    Fetch a URL, extract text, and optionally enqueue an index_document task.

    Parameters
    ──────────
    url           : URL to crawl
    metadata      : merged into the downstream index task's metadata
    trigger_index : if True (default), dispatch index_document for the content
    """
    t0 = time.time()
    metadata = metadata or {}
    parsed = urlparse(url)
    logger.info("crawl_url start: %s", url)

    if not parsed.scheme.startswith("http"):
        return {"url": url, "content_length": 0, "status": "error", "error": "Invalid URL scheme"}

    try:
        content_type, body = _fetch_url(url)

        if "html" in content_type.lower() or "html" in body[:200].lower():
            text = strip_html(body)
        else:
            text = body

        doc_id = str(uuid.uuid5(uuid.NAMESPACE_URL, url))
        doc_metadata = {
            **metadata,
            "source_url": url,
            "content_type": content_type,
            "crawled_at": time.time(),
        }

        index_task_id: str | None = None
        if trigger_index and text.strip():
            task = index_document.delay(
                doc_id=doc_id,
                content=text,
                metadata=doc_metadata,
            )
            index_task_id = task.id

        elapsed = time.time() - t0
        logger.info("crawl_url done: %s len=%d elapsed=%.2fs", url, len(text), elapsed)

        return {
            "url": url,
            "doc_id": doc_id,
            "content_length": len(text),
            "index_task_id": index_task_id,
            "status": "ok",
            "elapsed_s": round(elapsed, 3),
        }

    except Exception as exc:
        logger.exception("crawl_url failed: url=%s error=%s", url, exc)
        raise self.retry(exc=exc) from exc
