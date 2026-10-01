# SPDX-License-Identifier: Apache-2.0
"""
LLM inference task.

Runs a heavy / long-running LLM call in a background worker instead of
blocking the request thread.  Results are stored in the Celery result
backend and can be polled by the caller or pushed via webhook.

Task inputs
───────────
  messages      : list[dict] — [{"role": "user", "content": "..."}]
  model         : str        — model identifier (e.g. "groq/llama3-70b")
  provider      : str        — "groq" | "openai" | "stub"
  max_tokens    : int        — default 1024
  temperature   : float      — default 0.7
  webhook_url   : str | None — optional: POST result to this URL when done
  request_id    : str | None — correlation ID for the caller

Task output
───────────
  {"request_id": str, "content": str, "model": str, "tokens": int, "status": "ok" | "error"}
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any

from nexus_ingest.celery_app import celery_app

logger = logging.getLogger(__name__)


# ── Provider dispatch ─────────────────────────────────────────────────────────

def _call_groq(messages: list[dict[str, str]], model: str, max_tokens: int, temperature: float) -> dict[str, Any]:
    """Call Groq Chat Completions API."""
    try:
        import httpx  # type: ignore[import]
    except ImportError:
        raise RuntimeError("httpx is required for Groq provider")

    api_key = os.environ["GROQ_API_KEY"]
    resp = httpx.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        },
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    choice = data["choices"][0]
    usage = data.get("usage", {})
    return {
        "content": choice["message"]["content"],
        "model": data.get("model", model),
        "tokens": usage.get("total_tokens", 0),
    }


def _call_openai(messages: list[dict[str, str]], model: str, max_tokens: int, temperature: float) -> dict[str, Any]:
    """Call OpenAI Chat Completions API."""
    try:
        import httpx  # type: ignore[import]
    except ImportError:
        raise RuntimeError("httpx is required for OpenAI provider")

    api_key = os.environ["OPENAI_API_KEY"]
    resp = httpx.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        },
        timeout=90,
    )
    resp.raise_for_status()
    data = resp.json()
    choice = data["choices"][0]
    usage = data.get("usage", {})
    return {
        "content": choice["message"]["content"],
        "model": data.get("model", model),
        "tokens": usage.get("total_tokens", 0),
    }


def _call_stub(messages: list[dict[str, str]], model: str, max_tokens: int, temperature: float) -> dict[str, Any]:
    """Deterministic stub for tests/CI (no API key required)."""
    last_user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
    content = f"[stub:{model}] Echo: {last_user[:80]}"
    return {"content": content, "model": model, "tokens": len(content.split())}


PROVIDERS = {
    "groq": _call_groq,
    "openai": _call_openai,
    "stub": _call_stub,
}


# ── Webhook helper ────────────────────────────────────────────────────────────

def _send_webhook(url: str, payload: dict[str, Any]) -> None:
    try:
        import httpx  # type: ignore[import]
        httpx.post(url, json=payload, timeout=10)
    except Exception as exc:
        logger.warning("Webhook delivery failed: %s — %s", url, exc)


# ── Task ─────────────────────────────────────────────────────────────────────

@celery_app.task(
    name="nexus_ingest.tasks.run_inference.run_inference",
    bind=True,
    max_retries=2,
    default_retry_delay=5,
    soft_time_limit=90,
    time_limit=120,
)
def run_inference(
    self: Any,
    messages: list[dict[str, str]],
    model: str = "llama-3.1-8b-instant",
    provider: str = "stub",
    max_tokens: int = 1024,
    temperature: float = 0.7,
    webhook_url: str | None = None,
    request_id: str | None = None,
) -> dict[str, Any]:
    """
    Run an LLM inference call in a background worker.

    Use this for long completions (>5s), batch requests, or calls that
    must not block an HTTP request thread.
    """
    t0 = time.time()
    request_id = request_id or self.request.id or "unknown"
    logger.info(
        "run_inference start: request_id=%s provider=%s model=%s",
        request_id, provider, model,
    )

    provider_fn = PROVIDERS.get(provider)
    if provider_fn is None:
        return {
            "request_id": request_id,
            "content": "",
            "model": model,
            "tokens": 0,
            "status": "error",
            "error": f"Unknown provider: {provider}",
        }

    try:
        result = provider_fn(messages, model, max_tokens, temperature)
        elapsed = time.time() - t0

        payload: dict[str, Any] = {
            "request_id": request_id,
            "content": result["content"],
            "model": result["model"],
            "tokens": result["tokens"],
            "status": "ok",
            "elapsed_s": round(elapsed, 3),
        }

        if webhook_url:
            _send_webhook(webhook_url, payload)

        logger.info(
            "run_inference done: request_id=%s tokens=%d elapsed=%.2fs",
            request_id, result["tokens"], elapsed,
        )
        return payload

    except Exception as exc:
        logger.exception("run_inference failed: request_id=%s error=%s", request_id, exc)
        error_payload: dict[str, Any] = {
            "request_id": request_id,
            "content": "",
            "model": model,
            "tokens": 0,
            "status": "error",
            "error": str(exc),
        }
        if webhook_url:
            _send_webhook(webhook_url, error_payload)
        raise self.retry(exc=exc) from exc
