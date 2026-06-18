"""
GhostStack MCP server bridge.

Exposes GhostStack capabilities as MCP tools over HTTP.
Runs on port 7704.

Tools:
  - queue_task    — submit a task to the execution queue
  - get_status    — query orchestrator status (queue length, DLQ, metrics)
  - run_workflow  — execute a workflow spec by path
  - search_web    — run a web search query
  - recall_memory — query the memory store
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.request
from typing import Any

import uvicorn

# ── MCP server conditional import ─────────────────────────────────────────────
try:
    from fastmcp import FastMCP
    _MCP_AVAILABLE = True
except ImportError:
    _MCP_AVAILABLE = False
    # Fallback: expose a minimal FastAPI liveness endpoint so health checks pass
    from fastapi import FastAPI as FastMCP  # type: ignore[assignment]

# ── GhostStack API base ───────────────────────────────────────────────────────
GS_API_BASE = os.environ.get("GHOSTSTACK_API_URL", "http://localhost:3000")


def _gs_get(path: str) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(f"{GS_API_BASE}{path}", timeout=5) as r:
            return json.loads(r.read())
    except Exception as exc:
        return {"error": str(exc)}


def _gs_post(path: str, body: dict[str, Any]) -> dict[str, Any]:
    try:
        data = json.dumps(body).encode()
        req = urllib.request.Request(
            f"{GS_API_BASE}{path}",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception as exc:
        return {"error": str(exc)}


if _MCP_AVAILABLE:
    mcp = FastMCP("ghoststack", instructions="GhostStack orchestration engine MCP interface")

    @mcp.tool
    def queue_task(
        task_type: str,
        payload: str,
        priority: str = "medium",
    ) -> str:
        """Submit a task to the GhostStack execution queue.

        Args:
            task_type: Type of task (e.g. "search", "code_edit", "browse", "scrape", "inference")
            payload: JSON string with task payload
            priority: Task priority — "low", "medium", "high", "critical"
        """
        try:
            parsed_payload = json.loads(payload)
        except json.JSONDecodeError:
            parsed_payload = {"input": payload}

        result = _gs_post("/api/queue/submit", {
            "type": task_type,
            "payload": parsed_payload,
            "priority": priority,
        })
        return json.dumps(result)

    @mcp.tool
    def get_status() -> str:
        """Get the current GhostStack orchestrator status including queue depth, DLQ entries, and active services."""
        result = _gs_get("/api/status")
        return json.dumps(result)

    @mcp.tool
    def run_workflow(spec_path: str) -> str:
        """Execute a GhostStack workflow spec file.

        Args:
            spec_path: Absolute or relative path to a .yaml or .json workflow spec
        """
        result = _gs_post("/api/workflows/run", {"specPath": spec_path})
        return json.dumps(result)

    @mcp.tool
    def search_web(
        query: str,
        mode: str = "balanced",
    ) -> str:
        """Perform a web search and return an AI-synthesised answer with cited sources.

        Args:
            query: Natural language search query
            mode: Search depth — "speed", "balanced", or "quality"
        """
        result = _gs_post("/api/search", {"query": query, "mode": mode})
        return json.dumps(result)

    @mcp.tool
    def recall_memory(
        key_prefix: str = "",
        tags: str = "",
        limit: int = 10,
    ) -> str:
        """Query the GhostStack memory store for stored observations and decisions.

        Args:
            key_prefix: Optional key prefix filter
            tags: Comma-separated tag filters
            limit: Maximum number of entries to return
        """
        params: dict[str, Any] = {"limit": limit}
        if key_prefix:
            params["keyPrefix"] = key_prefix
        if tags:
            params["tags"] = [t.strip() for t in tags.split(",") if t.strip()]

        result = _gs_post("/api/memory/query", params)
        return json.dumps(result)

    app = mcp

else:
    # MCP package not installed — serve a minimal health endpoint
    from fastapi import FastAPI
    app = FastAPI(title="ghoststack-mcp-bridge-fallback")

    @app.get("/health")
    async def health():
        return {"status": "ok", "mcp_available": False}


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=7704)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--transport", default="streamable-http",
                        choices=["streamable-http", "sse", "stdio"])
    args = parser.parse_args()

    if _MCP_AVAILABLE and args.transport != "streamable-http":
        # Run via native MCP runner for stdio/sse transports
        mcp.run(transport=args.transport)
    else:
        # HTTP transport via uvicorn
        uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
