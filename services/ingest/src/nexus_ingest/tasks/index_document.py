# SPDX-License-Identifier: Apache-2.0
"""
Document indexing task.

Accepts raw document content, chunks it, embeds each chunk, and stores the
results in the vector database.  Heavy CPU+IO — runs in a background worker.

Task inputs (all JSON-serializable)
────────────────────────────────────
  doc_id    : str  — unique document identifier
  content   : str  — plain-text document content
  metadata  : dict — caller-supplied metadata (source, tags, format, …)
  chunk_size: int  — maximum tokens per chunk (default: 256)
  overlap   : int  — token overlap between chunks (default: 32)

Task output
───────────
  {"doc_id": str, "chunks_indexed": int, "status": "ok" | "error", "error": str?}
"""
from __future__ import annotations

import logging
import math
import os
import time
from typing import Any

from nexus_ingest.celery_app import celery_app

logger = logging.getLogger(__name__)

CHARS_PER_TOKEN = 4  # heuristic

# ── Chunk helper (pure, no I/O) ───────────────────────────────────────────────


def chunk_text(text: str, chunk_size: int = 256, overlap: int = 32) -> list[str]:
    """
    Split text into overlapping fixed-size token windows.
    Estimation: 1 token ≈ CHARS_PER_TOKEN characters.
    """
    char_limit = chunk_size * CHARS_PER_TOKEN
    overlap_chars = overlap * CHARS_PER_TOKEN

    if len(text) <= char_limit:
        return [text]

    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + char_limit, len(text))
        chunks.append(text[start:end])
        next_start = end - overlap_chars
        start = max(next_start, start + 1)  # ensure progress
    return chunks


# ── Stub embedder (override in production) ───────────────────────────────────

def _default_embedder(text: str) -> list[float]:
    """
    Deterministic stub embedding for CI / dev (no API key required).
    Replace with a real embedder in production via NEXUS_EMBED_PROVIDER env.
    """
    dims = 256
    vec = [0.0] * dims
    for i, ch in enumerate(text):
        vec[ord(ch) % dims] += 1.0
    # L2 normalise
    mag = math.sqrt(sum(v * v for v in vec))
    if mag > 0:
        vec = [v / mag for v in vec]
    return vec


# ── Task ─────────────────────────────────────────────────────────────────────

@celery_app.task(
    name="nexus_ingest.tasks.index_document.index_document",
    bind=True,
    max_retries=3,
    default_retry_delay=5,
)
def index_document(
    self: Any,
    doc_id: str,
    content: str,
    metadata: dict[str, Any] | None = None,
    chunk_size: int = 256,
    overlap: int = 32,
) -> dict[str, Any]:
    """
    Chunk, embed, and store a document.

    This is the primary indexing task.  It is idempotent: re-indexing the
    same doc_id overwrites existing chunks in the vector store.
    """
    t0 = time.time()
    metadata = metadata or {}
    logger.info("index_document start: doc_id=%s len=%d", doc_id, len(content))

    try:
        chunks = chunk_text(content, chunk_size=chunk_size, overlap=overlap)
        embedder = _get_embedder()
        stored = 0

        for i, chunk in enumerate(chunks):
            embedding = embedder(chunk)
            _store_chunk(
                doc_id=doc_id,
                chunk_index=i,
                text=chunk,
                embedding=embedding,
                metadata={**metadata, "chunk_index": i, "total_chunks": len(chunks)},
            )
            stored += 1

        elapsed = time.time() - t0
        logger.info(
            "index_document done: doc_id=%s chunks=%d elapsed=%.2fs",
            doc_id, stored, elapsed,
        )
        return {"doc_id": doc_id, "chunks_indexed": stored, "status": "ok", "elapsed_s": round(elapsed, 3)}

    except Exception as exc:
        logger.exception("index_document failed: doc_id=%s error=%s", doc_id, exc)
        raise self.retry(exc=exc) from exc


def _get_embedder():  # type: ignore[return]
    """
    Return the active embedder function.
    Production: reads NEXUS_EMBED_PROVIDER env to select an API embedder.
    Dev/CI: falls back to the stub.
    """
    provider = os.environ.get("NEXUS_EMBED_PROVIDER", "stub")
    if provider == "stub":
        return _default_embedder
    # Real providers would be imported here (e.g. openai, voyageai).
    # Deferred import avoids hard dep in CI.
    raise NotImplementedError(f"Embed provider '{provider}' not yet wired")


def _store_chunk(
    doc_id: str,
    chunk_index: int,
    text: str,
    embedding: list[float],
    metadata: dict[str, Any],
) -> None:
    """
    Persist an embedded chunk.
    In production: write to pgvector via the shared DB connection.
    In CI/stub mode: no-op (can be monkey-patched in tests).
    """
    store_backend = os.environ.get("NEXUS_VECTOR_BACKEND", "stub")
    if store_backend == "stub":
        return  # no-op
    # Real backend would write to pgvector here.
    raise NotImplementedError(f"Vector backend '{store_backend}' not wired")


# ── Periodic cleanup task ─────────────────────────────────────────────────────

@celery_app.task(name="nexus_ingest.tasks.index_document.purge_expired")
def purge_expired() -> dict[str, Any]:
    """
    Periodic task: purge expired memory entries from the vector store.
    Runs every 6 hours (configured in celery_app beat_schedule).
    """
    backend = os.environ.get("NEXUS_VECTOR_BACKEND", "stub")
    if backend == "stub":
        logger.info("purge_expired: stub backend, nothing to purge")
        return {"purged": 0, "backend": "stub"}
    # Real implementation would delete rows where expires_at < NOW().
    raise NotImplementedError(f"Vector backend '{backend}' not wired")
