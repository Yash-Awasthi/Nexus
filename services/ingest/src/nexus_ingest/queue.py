# SPDX-License-Identifier: Apache-2.0
"""
nexus-ingest queue publisher — enqueues jobs into the Nexus Redis queue.

Uses redis-py (async) to push BullMQ-compatible job payloads.  Jobs land on
the `nexus-medium` queue by default; high-priority signals use `nexus-high`.

BullMQ job format (simplified — compatible with BullMQ v5):
  HMSET bull:{queue}:{jobId}  id name data opts timestamp
  ZADD  bull:{queue}:wait   0 {jobId}
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Literal, Optional
from uuid import uuid4

logger = logging.getLogger(__name__)

_redis: Any = None

QueueTier = Literal["high", "medium", "low"]

QUEUE_NAMES: dict[QueueTier, str] = {
    "high": "nexus-high",
    "medium": "nexus-medium",
    "low": "nexus-low",
}


async def _get_redis() -> Any:
    global _redis
    if _redis is not None:
        return _redis
    try:
        import redis.asyncio as aioredis  # type: ignore[import]

        redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
        _redis = aioredis.from_url(redis_url, decode_responses=True)
        logger.info("Redis connection established: %s", redis_url.split("@")[-1])
    except ImportError:
        logger.warning("redis-py not installed — queue publishes disabled")
    except Exception as exc:
        logger.error("Failed to connect to Redis: %s", exc)
    return _redis


async def publish_event_job(
    event_id: str,
    source: str,
    event_type: str,
    payload: dict[str, Any],
    priority: QueueTier = "medium",
) -> Optional[str]:
    """
    Push an ingest event job to the appropriate BullMQ queue tier.

    Returns the job ID string, or None if Redis is unavailable.
    """
    redis = await _get_redis()
    if redis is None:
        return None

    queue_name = QUEUE_NAMES[priority]
    job_id = str(uuid4())
    now_ms = int(time.time() * 1000)

    job_data = {
        "eventId": event_id,
        "source": source,
        "eventType": event_type,
        "payload": payload,
    }

    job_opts = {
        "attempts": 3,
        "backoff": {"type": "exponential", "delay": 1000},
        "removeOnComplete": 100,
        "removeOnFail": 50,
    }

    try:
        pipe = redis.pipeline()
        # Store job hash
        key = f"bull:{queue_name}:{job_id}"
        pipe.hset(key, mapping={
            "id": job_id,
            "name": "ingest:event",
            "data": json.dumps(job_data),
            "opts": json.dumps(job_opts),
            "timestamp": str(now_ms),
            "delay": "0",
            "attempts": "0",
            "priority": "0",
        })
        # Add to wait list (BullMQ v4/v5 wait key)
        pipe.lpush(f"bull:{queue_name}:wait", job_id)
        await pipe.execute()
        logger.debug("Published job %s to queue %s", job_id, queue_name)
        return job_id
    except Exception as exc:
        logger.error("publish_event_job failed: %s", exc)
        return None


async def close_redis() -> None:
    """Gracefully close Redis connection on shutdown."""
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None
