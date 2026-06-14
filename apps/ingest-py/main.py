# SPDX-License-Identifier: Apache-2.0
"""
ingest-py — Thin FastAPI bridge between fin-scrape output and the Nexus ingest API.

Reads structured signal payloads from the fin-scrape output directory (or from an
in-process watcher) and POSTs them to POST /api/v1/ingest/events with bearer auth.

Endpoints:
  GET  /health          — liveness probe
  POST /push            — accept a payload and forward to Nexus ingest immediately
  POST /scan            — scan the fin-scrape output directory and flush all pending files
  GET  /status          — last-push stats

Environment variables:
  NEXUS_API_URL         — base URL of the Nexus API  (default: http://localhost:3000)
  NEXUS_INGEST_API_KEY  — bearer token for the Nexus API  (required)
  FINSCRAPE_OUTPUT_DIR  — directory where fin-scrape writes JSON files (default: /data/finscrape)
  FINSCRAPE_DONE_DIR    — directory to move processed files into (default: /data/finscrape/done)
  BRIDGE_PORT           — port to listen on (default: 8001)
  LOG_LEVEL             — uvicorn log level (default: info)
"""

from __future__ import annotations

import json
import logging
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

# ── Config ────────────────────────────────────────────────────────────────────

NEXUS_API_URL: str        = os.getenv("NEXUS_API_URL", "http://localhost:3000")
NEXUS_INGEST_API_KEY: str = os.getenv("NEXUS_INGEST_API_KEY", "")
FINSCRAPE_OUTPUT_DIR: Path = Path(os.getenv("FINSCRAPE_OUTPUT_DIR", "/data/finscrape"))
FINSCRAPE_DONE_DIR: Path   = Path(os.getenv("FINSCRAPE_DONE_DIR", "/data/finscrape/done"))
BRIDGE_API_KEY: str        = os.getenv("BRIDGE_API_KEY", "")  # optional: secure the bridge itself

log = logging.getLogger("ingest-py")

# ── FastAPI app ───────────────────────────────────────────────────────────────

app = FastAPI(
    title="Nexus Ingest Bridge",
    description="Forwards fin-scrape signals to the Nexus ingest API",
    version="0.1.0",
)

security = HTTPBearer(auto_error=False)

# ── Runtime state (in-memory; stateless restart is fine) ─────────────────────

_stats: dict[str, Any] = {
    "pushed": 0,
    "failed": 0,
    "last_push_at": None,
    "last_error": None,
}

# ── Nexus API client ──────────────────────────────────────────────────────────

def _nexus_headers() -> dict[str, str]:
    if not NEXUS_INGEST_API_KEY:
        raise RuntimeError("NEXUS_INGEST_API_KEY is not set")
    return {
        "Authorization": f"Bearer {NEXUS_INGEST_API_KEY}",
        "Content-Type": "application/json",
    }


async def _push_event(source: str, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    """POST one event to POST /api/v1/ingest/events on the Nexus API."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{NEXUS_API_URL}/api/v1/ingest/events",
            headers=_nexus_headers(),
            json={
                "source": source,
                "event_type": event_type,
                "payload": payload,
            },
        )
        resp.raise_for_status()
        return resp.json()


# ── Auth guard (optional) ─────────────────────────────────────────────────────

def _check_bridge_auth(creds: HTTPAuthorizationCredentials | None) -> None:
    """Validate the bridge's own API key if BRIDGE_API_KEY is configured."""
    if not BRIDGE_API_KEY:
        return  # bridge auth disabled
    if creds is None or creds.credentials != BRIDGE_API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")


# ── Request models ────────────────────────────────────────────────────────────

class PushRequest(BaseModel):
    source: str = "finscrape"
    event_type: str
    payload: dict[str, Any]


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@app.get("/status")
async def status(creds: HTTPAuthorizationCredentials | None = Security(security)) -> dict[str, Any]:
    _check_bridge_auth(creds)
    return {**_stats, "nexus_api_url": NEXUS_API_URL}


@app.post("/push")
async def push(
    body: PushRequest,
    creds: HTTPAuthorizationCredentials | None = Security(security),
) -> dict[str, Any]:
    """Accept a single event payload and forward it immediately to Nexus."""
    _check_bridge_auth(creds)
    try:
        result = await _push_event(body.source, body.event_type, body.payload)
        _stats["pushed"] += 1
        _stats["last_push_at"] = datetime.now(timezone.utc).isoformat()
        return {"ok": True, "event_id": result.get("event_id"), "status": result.get("status")}
    except Exception as exc:
        _stats["failed"] += 1
        _stats["last_error"] = str(exc)
        log.exception("Failed to push event to Nexus: %s", exc)
        raise HTTPException(status_code=502, detail=f"Nexus ingest failed: {exc}") from exc


@app.post("/scan")
async def scan(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Security(security),
) -> dict[str, Any]:
    """
    Scan FINSCRAPE_OUTPUT_DIR for *.json files and push each one to Nexus.

    Each file must be a JSON object with keys:
      source      (str)  — e.g. "finscrape"
      event_type  (str)  — e.g. "market.ticker"
      payload     (dict) — arbitrary signal data

    Successfully processed files are moved to FINSCRAPE_DONE_DIR.
    """
    _check_bridge_auth(creds)

    FINSCRAPE_DONE_DIR.mkdir(parents=True, exist_ok=True)

    pushed, failed, skipped = 0, 0, 0
    errors: list[str] = []

    for json_file in sorted(FINSCRAPE_OUTPUT_DIR.glob("*.json")):
        try:
            data = json.loads(json_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            log.warning("Skipping unreadable file %s: %s", json_file.name, exc)
            skipped += 1
            continue

        source     = data.get("source", "finscrape")
        event_type = data.get("event_type")
        payload    = data.get("payload", data)  # fallback: treat whole object as payload

        if not event_type:
            log.warning("Skipping %s: missing event_type", json_file.name)
            skipped += 1
            continue

        try:
            await _push_event(source, event_type, payload)
            shutil.move(str(json_file), str(FINSCRAPE_DONE_DIR / json_file.name))
            pushed += 1
            _stats["pushed"] += 1
            _stats["last_push_at"] = datetime.now(timezone.utc).isoformat()
        except Exception as exc:
            failed += 1
            _stats["failed"] += 1
            _stats["last_error"] = str(exc)
            err_msg = f"{json_file.name}: {exc}"
            errors.append(err_msg)
            log.error("Failed to push %s: %s", json_file.name, exc)

    return {
        "scanned": pushed + failed + skipped,
        "pushed": pushed,
        "failed": failed,
        "skipped": skipped,
        "errors": errors,
        "scanned_at": datetime.now(timezone.utc).isoformat(),
    }


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn  # type: ignore[import]
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("BRIDGE_PORT", "8001")),
        log_level=os.getenv("LOG_LEVEL", "info"),
    )
