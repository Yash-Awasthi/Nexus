# SPDX-License-Identifier: Apache-2.0
"""
nexus-ingest DB writer — persists IngestedEvent rows via asyncpg.

Uses a connection pool initialised at startup.  In a serverless / short-lived
process, fall back to single-use connections.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Optional
from uuid import uuid4

logger = logging.getLogger(__name__)

# Lazy pool — created on first call; avoids startup cost when DB is not used
_pool: Any = None


async def _get_pool() -> Any:
    global _pool
    if _pool is not None:
        return _pool
    try:
        import asyncpg  # type: ignore[import]
        dsn = os.environ.get("DATABASE_URL", "")
        if not dsn:
            logger.warning("DATABASE_URL not set — DB writes disabled")
            return None
        _pool = await asyncpg.create_pool(dsn, min_size=1, max_size=5)
        logger.info("asyncpg pool created")
    except ImportError:
        logger.warning("asyncpg not installed — DB writes disabled")
    except Exception as exc:  # pragma: no cover
        logger.error("Failed to create asyncpg pool: %s", exc)
    return _pool


async def write_ingested_event(
    source: str,
    event_type: str,
    payload: dict[str, Any],
    metadata: Optional[dict[str, Any]] = None,
    idempotency_key: Optional[str] = None,
) -> Optional[str]:
    """
    Insert a row into ingested_events.

    Returns the new row's UUID string, or None if DB is unavailable.
    Idempotency: if idempotency_key already exists, returns its existing id
    rather than raising.
    """
    pool = await _get_pool()
    if pool is None:
        return None

    row_id = str(uuid4())
    try:
        async with pool.acquire() as conn:
            result = await conn.fetchrow(
                """
                INSERT INTO ingested_events
                    (id, source, event_type, payload, metadata, idempotency_key)
                VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
                ON CONFLICT (idempotency_key) DO UPDATE
                    SET id = ingested_events.id
                RETURNING id
                """,
                row_id,
                source,
                event_type,
                json.dumps(payload),
                json.dumps(metadata) if metadata else None,
                idempotency_key,
            )
            return str(result["id"])
    except Exception as exc:
        logger.error("write_ingested_event failed: %s", exc)
        return None


async def mark_event_processed(event_id: str) -> None:
    """Set processed_at timestamp for a given ingested_event id."""
    pool = await _get_pool()
    if pool is None:
        return
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE ingested_events SET processed_at = NOW() WHERE id = $1",
                event_id,
            )
    except Exception as exc:
        logger.error("mark_event_processed failed: %s", exc)


async def close_pool() -> None:
    """Gracefully close the connection pool on shutdown."""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
