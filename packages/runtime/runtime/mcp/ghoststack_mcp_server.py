#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
ghoststack_mcp_server.py — GhostStack composite MCP server (FastMCP backend).

Exposes GhostStack's orchestration API as MCP tools over the
streamable-HTTP transport (POST /mcp).  McpServerHost spawns this
script and polls GET /health until the port responds before routing
tool calls.

Exposed tools
-------------
deliberate      Submit a proposal for council deliberation
submit_task     Enqueue a task in the GhostStack runtime
get_signal      Retrieve a signal by UUID
list_signals    List recent signals (paginated)
health          Probe GhostStack API liveness

Configuration (env vars)
------------------------
GHOSTSTACK_API_URL           Base URL of the GhostStack API   (default: http://127.0.0.1:3000)
GHOSTSTACK_API_KEY           Bearer token for the GhostStack API (default: "")
GHOSTSTACK_MCP_PORT          Port for this MCP server          (default: 8100)

Auth (at least one must be set for production; leave all empty to disable auth in dev):
GHOSTSTACK_MCP_AUTH_TOKEN    Static shared secret — simple constant-time comparison
GHOSTSTACK_MCP_HMAC_SECRET   HMAC-SHA256 secret — verifies signed tokens of the form
                             "<timestamp>.<nonce>.<hmac>" with 5-minute replay window
GHOSTSTACK_MCP_VERIFY_VIA_API  When "true", forward the Bearer token to the GhostStack
                             API (/api/v1/auth/verify-key) to validate it against the
                             billing API key table

Auth priority: HMAC_SECRET > VERIFY_VIA_API > AUTH_TOKEN > (open)
Multiple modes may be active simultaneously — all enabled checks must pass.

Dependencies
------------
    pip install "mcp[cli]" httpx uvicorn

FastMCP (part of the MCP Python SDK) handles protocol negotiation,
capabilities, batching, and SSE streaming — no manual JSON-RPC plumbing.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any

import httpx
from mcp.server.fastmcp import FastMCP, Context  # type: ignore[import]
from starlette.applications import Starlette
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

logger = logging.getLogger("ghoststack_mcp_server")
logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(name)s  %(message)s")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_API_URL: str = os.environ.get("GHOSTSTACK_API_URL", "http://127.0.0.1:3000")
_API_KEY: str = os.environ.get("GHOSTSTACK_API_KEY", "")
_MCP_PORT: int = int(os.environ.get("GHOSTSTACK_MCP_PORT", "8100"))
_MCP_AUTH_TOKEN: str = os.environ.get("GHOSTSTACK_MCP_AUTH_TOKEN", "")
_MCP_HMAC_SECRET: str = os.environ.get("GHOSTSTACK_MCP_HMAC_SECRET", "")
_MCP_VERIFY_VIA_API: bool = os.environ.get("GHOSTSTACK_MCP_VERIFY_VIA_API", "").lower() == "true"
_HMAC_REPLAY_WINDOW_SECS: int = int(os.environ.get("GHOSTSTACK_MCP_HMAC_REPLAY_WINDOW", "300"))

# In-process nonce cache for HMAC replay prevention
# Maps nonce → expiry timestamp.  Pruned on each auth check.
_used_nonces: dict[str, float] = {}

# ---------------------------------------------------------------------------
# API client helpers
# ---------------------------------------------------------------------------


def _headers() -> dict[str, str]:
    h: dict[str, str] = {"Content-Type": "application/json"}
    if _API_KEY:
        h["Authorization"] = f"Bearer {_API_KEY}"
    return h


async def _api_get(path: str) -> Any:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{_API_URL}{path}", headers=_headers())
        resp.raise_for_status()
        return resp.json()


async def _api_post(path: str, body: dict[str, Any]) -> Any:
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(f"{_API_URL}{path}", json=body, headers=_headers())
        resp.raise_for_status()
        return resp.json()


# ---------------------------------------------------------------------------
# Bearer-token auth middleware
# ---------------------------------------------------------------------------


def _purge_expired_nonces() -> None:
    """Remove expired entries from the in-process nonce cache."""
    now = time.time()
    expired = [n for n, exp in _used_nonces.items() if exp < now]
    for n in expired:
        del _used_nonces[n]


def _verify_hmac_token(token: str) -> bool:
    """
    Verify a token of the form ``<timestamp>.<nonce>.<hmac>``.

    The HMAC covers the string ``<timestamp>.<nonce>`` signed with
    GHOSTSTACK_MCP_HMAC_SECRET using HMAC-SHA256.  Timestamp must be
    within GHOSTSTACK_MCP_HMAC_REPLAY_WINDOW seconds of now.
    Nonces are tracked in-process to prevent replay within the window.
    """
    parts = token.split(".", 2)
    if len(parts) != 3:
        return False
    ts_str, nonce, given_sig = parts

    try:
        ts = int(ts_str)
    except ValueError:
        return False

    now = int(time.time())
    if abs(now - ts) > _HMAC_REPLAY_WINDOW_SECS:
        return False

    # Replay check
    _purge_expired_nonces()
    if nonce in _used_nonces:
        return False

    # Signature check (constant-time)
    signed_payload = f"{ts_str}.{nonce}".encode()
    expected_sig = hmac.new(
        _MCP_HMAC_SECRET.encode(),
        signed_payload,
        hashlib.sha256,
    ).hexdigest()

    if not secrets.compare_digest(expected_sig, given_sig):
        return False

    # Mark nonce as used
    _used_nonces[nonce] = now + _HMAC_REPLAY_WINDOW_SECS
    return True


async def _verify_via_api(raw_key: str) -> bool:
    """
    Validate a bearer token against the GhostStack billing API key table.
    Returns True iff the API responds with 200.
    """
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"{_API_URL}/api/v1/auth/verify-key",
                headers={"Authorization": f"Bearer {raw_key}"},
            )
            return resp.status_code == 200
    except Exception:  # noqa: BLE001
        return False


class BearerAuthMiddleware(BaseHTTPMiddleware):
    """
    Multi-mode auth middleware for the MCP server.

    Auth modes (checked in priority order, all enabled modes must pass):
      1. HMAC-SHA256 signed token  (GHOSTSTACK_MCP_HMAC_SECRET)
      2. API key passthrough       (GHOSTSTACK_MCP_VERIFY_VIA_API=true)
      3. Static shared secret      (GHOSTSTACK_MCP_AUTH_TOKEN)

    Set none of the above to run without auth (development only).
    /health is always unauthenticated.
    """

    async def dispatch(self, request: Request, call_next: Any) -> Response:
        # Health probe is always open
        if request.url.path == "/health":
            return await call_next(request)

        # If no auth mode is configured, allow all (dev mode)
        auth_disabled = not (_MCP_AUTH_TOKEN or _MCP_HMAC_SECRET or _MCP_VERIFY_VIA_API)
        if auth_disabled:
            return await call_next(request)

        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return self._reject(request, "Missing Authorization: Bearer header")
        raw_token = auth_header[7:]

        # ── Mode 1: HMAC-SHA256 token verification ─────────────────────────
        if _MCP_HMAC_SECRET:
            if not _verify_hmac_token(raw_token):
                return self._reject(request, "HMAC token invalid or expired")

        # ── Mode 2: API key passthrough ────────────────────────────────────
        if _MCP_VERIFY_VIA_API:
            if not await _verify_via_api(raw_token):
                return self._reject(request, "API key rejected by GhostStack")

        # ── Mode 3: Static token (only checked when HMAC/API not active) ──
        if _MCP_AUTH_TOKEN and not (_MCP_HMAC_SECRET or _MCP_VERIFY_VIA_API):
            if not secrets.compare_digest(_MCP_AUTH_TOKEN.encode(), raw_token.encode()):
                return self._reject(request, "Invalid bearer token")

        return await call_next(request)

    @staticmethod
    def _reject(request: Request, reason: str) -> JSONResponse:
        logger.warning(
            "MCP auth rejected from %s — %s",
            request.client.host if request.client else "unknown",
            reason,
        )
        return JSONResponse({"error": f"Unauthorized — {reason}"}, status_code=401)


# ---------------------------------------------------------------------------
# FastMCP instance + lifespan
# ---------------------------------------------------------------------------


@asynccontextmanager
async def _lifespan(server: FastMCP) -> AsyncIterator[None]:  # noqa: ARG001
    logger.info(
        "GhostStack MCP server ready — API: %s  auth: %s",
        _API_URL,
        "enabled" if _MCP_AUTH_TOKEN else "disabled",
    )
    yield
    logger.info("GhostStack MCP server shutting down")


mcp = FastMCP(
    "GhostStack MCP",
    description=(
        "Exposes GhostStack orchestration primitives — council deliberation, "
        "task submission, and signal inspection — as MCP tools."
    ),
    lifespan=_lifespan,
)

# ---------------------------------------------------------------------------
# Tool: deliberate
# ---------------------------------------------------------------------------


@mcp.tool()
async def deliberate(
    proposal: Annotated[str, "Proposal text to submit for multi-model council deliberation"],
    ctx: Context,
    budget_usd: Annotated[float, "Maximum LLM cost budget in USD"] = 1.0,
    timeout_ms: Annotated[int, "Deliberation timeout in milliseconds"] = 30_000,
    signal_id: Annotated[str, "Optional parent signal UUID to attach the verdict to"] = "",
) -> str:
    """
    Submit a proposal to the GhostStack council for multi-model deliberation.

    The council runs the proposal through multiple LLM archetypes and returns
    a consensus verdict (approve / reject / defer) with a confidence score
    and rationale.

    Uses tool elicitation to prompt the caller for missing context when
    the proposal is very short and no signal_id is provided.
    """
    # Tool elicitation hook — ask caller for more context when proposal is thin.
    if len(proposal.strip()) < 20 and not signal_id:
        elicited = await ctx.elicit(
            message="The proposal is very short. Please provide additional context.",
            schema={
                "type": "object",
                "properties": {
                    "context": {
                        "type": "string",
                        "description": "Additional context or rationale for the proposal",
                    }
                },
                "required": ["context"],
            },
        )
        if elicited and isinstance(elicited, dict) and elicited.get("context"):
            proposal = f"{proposal}\n\nContext: {elicited['context']}"

    body: dict[str, Any] = {
        "proposal": proposal,
        "budgetUsd": budget_usd,
        "timeoutMs": timeout_ms,
    }
    if signal_id:
        body["signal_id"] = signal_id

    await ctx.info(f"Submitting proposal for deliberation (budget: ${budget_usd:.2f})")
    result = await _api_post("/council/deliberate", body)
    return _fmt(result)


# ---------------------------------------------------------------------------
# Tool: submit_task
# ---------------------------------------------------------------------------


@mcp.tool()
async def submit_task(
    task_type: Annotated[str, "Task type (e.g. 'browser', 'floci', 'scraping')"],
    payload: Annotated[dict[str, Any], "Task-specific payload object"],
    ctx: Context,
    priority: Annotated[str, "Task priority: 'high' | 'medium' | 'low'"] = "medium",
) -> str:
    """
    Enqueue a task for execution by the GhostStack runtime.

    The runtime routes the task to the appropriate execution adapter
    (browser, Floci/AWS emulator, scraping, code agent, etc.) based on
    the task_type.
    """
    await ctx.info(f"Submitting {task_type!r} task (priority: {priority})")
    result = await _api_post(
        "/tasks",
        {"taskType": task_type, "payload": payload, "priority": priority},
    )
    return _fmt(result)


# ---------------------------------------------------------------------------
# Tool: get_signal
# ---------------------------------------------------------------------------


@mcp.tool()
async def get_signal(
    signal_id: Annotated[str, "UUID of the signal to retrieve"],
    ctx: Context,
) -> str:
    """
    Retrieve a GhostStack signal by its UUID.

    Returns the signal's type, status, severity, source, metadata, and any
    attached council verdicts.
    """
    await ctx.info(f"Fetching signal {signal_id}")
    result = await _api_get(f"/signals/{signal_id}")
    return _fmt(result)


# ---------------------------------------------------------------------------
# Tool: list_signals
# ---------------------------------------------------------------------------


@mcp.tool()
async def list_signals(
    ctx: Context,
    limit: Annotated[int, "Maximum number of signals to return"] = 20,
    status: Annotated[str, "Filter by status (e.g. 'pending', 'resolved')"] = "",
) -> str:
    """
    List recent GhostStack signals, newest first.

    Optionally filter by status.  Returns signal IDs, types, severities,
    and short summaries.
    """
    path = f"/signals?limit={limit}"
    if status:
        path += f"&status={status}"
    await ctx.info(f"Listing signals (limit={limit}, status={status!r})")
    result = await _api_get(path)
    return _fmt(result)


# ---------------------------------------------------------------------------
# Tool: health
# ---------------------------------------------------------------------------


@mcp.tool()
async def health(ctx: Context) -> str:
    """
    Probe GhostStack API liveness.

    Returns the API version, uptime, and whether all subsystems are healthy.
    """
    await ctx.info("Probing GhostStack API health")
    result = await _api_get("/health")
    return _fmt(result)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fmt(obj: Any) -> str:
    """Pretty-print any JSON-serialisable value as a string."""
    import json

    return json.dumps(obj, indent=2, default=str)


# ---------------------------------------------------------------------------
# ASGI app — wrap FastMCP with auth middleware + /health probe route
# ---------------------------------------------------------------------------


async def _health_probe(request: Request) -> JSONResponse:  # noqa: ARG001
    return JSONResponse({"status": "ok", "api": _API_URL})


def build_asgi_app() -> Any:
    """
    Compose the final ASGI app:
      /health  — unauthenticated liveness probe for McpServerHost
      /mcp     — FastMCP streamable-HTTP endpoint (bearer-auth enforced)
    """
    # FastMCP's underlying Starlette/FastAPI app
    mcp_asgi = mcp.streamable_http_app()

    # Mount FastMCP sub-app at /mcp, then layer auth middleware over everything
    from starlette.middleware import Middleware
    from starlette.routing import Mount

    app = Starlette(
        routes=[
            Route("/health", _health_probe, methods=["GET"]),
            Mount("/mcp", app=mcp_asgi),
        ],
        middleware=[Middleware(BearerAuthMiddleware)],
    )
    return app


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    import argparse

    import uvicorn  # type: ignore[import]

    parser = argparse.ArgumentParser(description="GhostStack MCP server (FastMCP)")
    parser.add_argument("--port", type=int, default=_MCP_PORT, help="Listen port")
    parser.add_argument("--host", default="127.0.0.1", help="Listen host")
    args = parser.parse_args()

    logger.info(
        "Starting GhostStack MCP server on %s:%d  (API: %s  auth: %s)",
        args.host,
        args.port,
        _API_URL,
        "enabled" if _MCP_AUTH_TOKEN else "disabled (set GHOSTSTACK_MCP_AUTH_TOKEN)",
    )
    uvicorn.run(build_asgi_app(), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
