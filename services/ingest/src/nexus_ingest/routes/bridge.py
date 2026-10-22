# SPDX-License-Identifier: Apache-2.0
"""nexus-ingest — FinScrape bridge routes.

Forwards FinScrape signal payloads to the Nexus API's POST /api/v1/ingest/events.

  POST /push    — forward one payload immediately
  POST /scan    — push every *.json file in FINSCRAPE_OUTPUT_DIR, then move it to FINSCRAPE_DONE_DIR
  GET  /status  — push counters since start
"""

from __future__ import annotations

import json
import logging
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from nexus_ingest.auth import AuthDep
from nexus_ingest.settings import get_settings

router = APIRouter(tags=["bridge"])
logger = logging.getLogger(__name__)

# What a push can raise: unconfigured target, transport/HTTP status errors, file moves.
_PUSH_ERRORS = (RuntimeError, httpx.HTTPError, OSError)

# In-memory counters; a restart resets them, which /status callers accept.
_stats: dict[str, Any] = {"pushed": 0, "failed": 0, "last_push_at": None, "last_error": None}


class PushRequest(BaseModel):
    source: str = "finscrape"
    event_type: str
    payload: dict[str, Any]


def _now() -> str:
    return datetime.now(UTC).isoformat()


async def push_event(source: str, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    """POST one event to the Nexus API's ingest endpoint."""
    settings = get_settings()
    if not settings.nexus_api_url or not settings.nexus_api_secret:
        raise RuntimeError("NEXUS_API_URL and NEXUS_API_SECRET must be set to push to Nexus")
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{settings.nexus_api_url}/api/v1/ingest/events",
            headers={"Authorization": f"Bearer {settings.nexus_api_secret}"},
            json={"source": source, "event_type": event_type, "payload": payload},
        )
        resp.raise_for_status()
        result: dict[str, Any] = resp.json()
        return result


def _record_push() -> None:
    _stats["pushed"] += 1
    _stats["last_push_at"] = _now()


@router.get("/status")
async def status(_token: AuthDep) -> dict[str, Any]:
    return {**_stats, "nexus_api_url": get_settings().nexus_api_url}


@router.post("/push")
async def push(body: PushRequest, _token: AuthDep) -> dict[str, Any]:
    try:
        result = await push_event(body.source, body.event_type, body.payload)
    except _PUSH_ERRORS as exc:
        _stats["failed"] += 1
        _stats["last_error"] = str(exc)
        logger.exception("Failed to push event to Nexus")
        raise HTTPException(status_code=502, detail="Nexus ingest failed") from exc
    _record_push()
    return {"ok": True, "event_id": result.get("event_id"), "status": result.get("status")}


@router.post("/scan")
async def scan(_token: AuthDep) -> dict[str, Any]:
    """Each file is a JSON object with event_type, and optionally source and payload."""
    settings = get_settings()
    output_dir = Path(settings.finscrape_output_dir)
    done_dir = Path(settings.finscrape_done_dir)
    done_dir.mkdir(parents=True, exist_ok=True)

    pushed = failed = skipped = 0
    errors: list[str] = []
    for json_file in sorted(output_dir.glob("*.json")):
        try:
            data = json.loads(json_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Skipping unreadable file %s: %s", json_file.name, exc)
            skipped += 1
            continue
        event_type = data.get("event_type")
        if not event_type:
            logger.warning("Skipping %s: missing event_type", json_file.name)
            skipped += 1
            continue
        try:
            await push_event(data.get("source", "finscrape"), event_type, data.get("payload", data))
            shutil.move(str(json_file), str(done_dir / json_file.name))
        except _PUSH_ERRORS as exc:
            failed += 1
            _stats["failed"] += 1
            _stats["last_error"] = "push failed"
            logger.error("Failed to push %s: %s", json_file.name, exc)
            errors.append(json_file.name)  # never expose exc detail to the caller
            continue
        pushed += 1
        _record_push()

    return {
        "scanned": pushed + failed + skipped,
        "pushed": pushed,
        "failed": failed,
        "skipped": skipped,
        "errors": errors,
        "scanned_at": _now(),
    }
