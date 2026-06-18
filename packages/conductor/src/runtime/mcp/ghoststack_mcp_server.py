"""
GhostStack MCP Server
=====================================
Exposes GhostStack runtime capabilities as MCP tools via HTTP transport.

Communicates with the GhostStack HTTP API (default http://127.0.0.1:3000).
Serves on GHOSTSTACK_MCP_PORT (default 8100) at /mcp.

Usage:
    python runtime/mcp/ghoststack_mcp_server.py
"""

import json
import os
import sys
import urllib.request
import urllib.error
from typing import Any

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    print(
        "Error: 'mcp' package not found. Install with: pip install mcp",
        file=sys.stderr,
    )
    sys.exit(1)

GHOSTSTACK_API_URL = os.environ.get("GHOSTSTACK_API_URL", "http://127.0.0.1:3000")
MCP_PORT = int(os.environ.get("GHOSTSTACK_MCP_PORT", "8100"))

mcp = FastMCP("ghoststack", port=MCP_PORT)


def _api_get(path: str) -> dict[str, Any]:
    """Make a GET request to the GhostStack HTTP API."""
    url = f"{GHOSTSTACK_API_URL}{path}"
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return {"error": f"HTTP {e.code}: {body}"}
    except urllib.error.URLError as e:
        return {"error": f"Connection failed: {e.reason}"}
    except Exception as e:
        return {"error": str(e)}


def _api_post(path: str, body: dict[str, Any]) -> dict[str, Any]:
    """Make a POST request to the GhostStack HTTP API."""
    url = f"{GHOSTSTACK_API_URL}{path}"
    data = json.dumps(body).encode("utf-8")
    try:
        req = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        resp_body = e.read().decode("utf-8", errors="replace")
        return {"error": f"HTTP {e.code}: {resp_body}"}
    except urllib.error.URLError as e:
        return {"error": f"Connection failed: {e.reason}"}
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# MCP Tools
# ---------------------------------------------------------------------------


@mcp.tool()
def ghoststack_health() -> str:
    """Get GhostStack runtime health status."""
    return json.dumps(_api_get("/health"), indent=2)


@mcp.tool()
def ghoststack_runtime_snapshot() -> str:
    """Get a full runtime snapshot (metrics, queues, services, events, tasks)."""
    return json.dumps(_api_get("/runtime/snapshots"), indent=2)


@mcp.tool()
def ghoststack_list_workflows() -> str:
    """List all registered workflow definitions."""
    return json.dumps(_api_get("/runtime/workflows"), indent=2)


@mcp.tool()
def ghoststack_execute_workflow(workflow_id: str, execution_id: str = "") -> str:
    """Execute a registered workflow by its ID."""
    body = {"workflowId": workflow_id}
    if execution_id:
        body["executionId"] = execution_id
    return json.dumps(_api_post("/runtime/workflows/execute", body), indent=2)


@mcp.tool()
def ghoststack_floci_execute(action: str, **kwargs: Any) -> str:
    """Execute a Floci action (e.g., create_s3_bucket, invoke_lambda)."""
    body = {"action": action, **kwargs}
    return json.dumps(_api_post("/runtime/floci/execute", body), indent=2)


@mcp.tool()
def ghoststack_run_e2e(strict: bool = True, cleanup: bool = True) -> str:
    """Run the federation E2E test (S3 -> Lambda -> invoke)."""
    body = {"strict": strict, "cleanup": cleanup}
    return json.dumps(_api_post("/runtime/e2e/federation", body), indent=2)


@mcp.tool()
def ghoststack_metrics_prometheus() -> str:
    """Get Prometheus-formatted metrics."""
    url = f"{GHOSTSTACK_API_URL}/metrics/prometheus"
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.read().decode("utf-8")
    except Exception as e:
        return f"Error: {e}"


def main() -> None:
    print(
        f"[mcp-server] GhostStack MCP server starting on port {MCP_PORT}",
        flush=True,
    )
    print(
        f"[mcp-server] API target: {GHOSTSTACK_API_URL}",
        flush=True,
    )
    mcp.run(transport="streamable-http")


if __name__ == "__main__":
    main()
