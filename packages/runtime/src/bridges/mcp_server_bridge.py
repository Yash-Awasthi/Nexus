#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
mcp_server_bridge.py — GhostStack MCP server bridge (port 7704).

Proxies tool calls from the TypeScript runtime to a local MCP server
(e.g. a Claude Desktop-compatible server running on stdin/stdout).

Endpoints
---------
GET  /health    — liveness probe
POST /call      — invoke a named MCP tool with args; returns the tool result

Configuration
-------------
    MCP_SERVER_CMD   — shell command to start the MCP server subprocess
                       (default: "python3 -m mcp_server")
    MCP_TOOL_TIMEOUT — per-call timeout in seconds (default: 30)

The bridge spawns the MCP server on first /call request and keeps it alive,
routing calls over stdin/stdout using the MCP JSON-RPC protocol.  If the
subprocess crashes it is restarted on the next request.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logger = logging.getLogger("mcp_server_bridge")
logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(name)s  %(message)s")

MCP_SERVER_CMD: str = os.environ.get("MCP_SERVER_CMD", "python3 -m mcp_server")
MCP_TOOL_TIMEOUT: float = float(os.environ.get("MCP_TOOL_TIMEOUT", "30"))

# ---------------------------------------------------------------------------
# Subprocess lifecycle
# ---------------------------------------------------------------------------

_proc: asyncio.subprocess.Process | None = None
_proc_lock = asyncio.Lock()
_msg_id = 0


async def _get_proc() -> asyncio.subprocess.Process:
    global _proc
    async with _proc_lock:
        if _proc is None or _proc.returncode is not None:
            logger.info("Spawning MCP server: %s", MCP_SERVER_CMD)
            _proc = await asyncio.create_subprocess_shell(
                MCP_SERVER_CMD,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        return _proc


async def _call_mcp_tool(tool: str, args: dict[str, Any]) -> dict[str, Any]:
    """Send a tools/call JSON-RPC request to the MCP server subprocess."""
    global _msg_id
    _msg_id += 1
    request = {
        "jsonrpc": "2.0",
        "id": _msg_id,
        "method": "tools/call",
        "params": {"name": tool, "arguments": args},
    }
    proc = await _get_proc()
    assert proc.stdin and proc.stdout

    line = json.dumps(request) + "\n"
    proc.stdin.write(line.encode())
    await proc.stdin.drain()

    raw = await asyncio.wait_for(proc.stdout.readline(), timeout=MCP_TOOL_TIMEOUT)
    response: dict[str, Any] = json.loads(raw.decode().strip())

    if "error" in response:
        raise RuntimeError(f"MCP error {response['error']['code']}: {response['error']['message']}")

    return response.get("result", {})


# ---------------------------------------------------------------------------
# Request model
# ---------------------------------------------------------------------------

class ToolCallRequest(BaseModel):
    tool: str
    args: dict[str, Any] = {}


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------

def create_app() -> FastAPI:
    app = FastAPI(title="GhostStack MCP Server Bridge")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        proc_alive = _proc is not None and _proc.returncode is None
        return {"status": "ok", "mcp_proc_alive": proc_alive}

    @app.post("/call")
    async def call_tool(req: ToolCallRequest) -> JSONResponse:
        try:
            result = await _call_mcp_tool(req.tool, req.args)
            return JSONResponse({"success": True, "result": result, "error": ""})
        except FileNotFoundError:
            return JSONResponse({
                "success": False, "result": None,
                "error": f"MCP server command not found: {MCP_SERVER_CMD!r}. "
                         "Set MCP_SERVER_CMD env var to the correct start command.",
            })
        except asyncio.TimeoutError:
            return JSONResponse({
                "success": False, "result": None,
                "error": f"MCP tool call timed out after {MCP_TOOL_TIMEOUT}s",
            })
        except Exception as exc:
            logger.error("MCP tool call failed: %s", exc)
            return JSONResponse({"success": False, "result": None, "error": "Tool call failed — check server logs"})

    return app


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    import uvicorn  # type: ignore[import]
    parser = argparse.ArgumentParser(description="GhostStack MCP server bridge")
    parser.add_argument("--port", type=int, default=7704, help="Listen port (default: 7704)")
    parser.add_argument("--host", default="127.0.0.1", help="Listen host (default: 127.0.0.1)")
    args = parser.parse_args()
    logger.info("Starting MCP server bridge on %s:%d", args.host, args.port)
    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
