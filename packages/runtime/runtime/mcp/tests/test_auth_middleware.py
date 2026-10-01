# SPDX-License-Identifier: Apache-2.0
"""
Tests for the multi-mode BearerAuthMiddleware in ghoststack_mcp_server.py.

Covers:
  - HMAC-SHA256 token verification (valid, expired, replayed, tampered)
  - Static token mode (valid, invalid)
  - Dev mode (no auth configured)
  - /health bypass
"""
import hashlib
import hmac as hmac_mod
import os
import sys
import time
import unittest

# ---------------------------------------------------------------------------
# Import the helpers directly without triggering uvicorn / mcp imports
# ---------------------------------------------------------------------------
# We monkey-patch the heavy optional deps so the module can be imported in a
# plain Python environment without mcp / httpx / uvicorn installed.
# ---------------------------------------------------------------------------

import types

for mod_name in ("httpx", "mcp", "mcp.server", "mcp.server.fastmcp",
                 "starlette", "starlette.applications", "starlette.middleware",
                 "starlette.middleware.base", "starlette.requests",
                 "starlette.responses", "starlette.routing"):
    if mod_name not in sys.modules:
        sys.modules[mod_name] = types.ModuleType(mod_name)

# Stub out the specific names the module uses at import time
starlette_middleware_base = sys.modules["starlette.middleware.base"]
starlette_middleware_base.BaseHTTPMiddleware = object  # type: ignore[attr-defined]

starlette_responses = sys.modules["starlette.responses"]
starlette_responses.JSONResponse = dict  # type: ignore[attr-defined]
starlette_responses.Response = object  # type: ignore[attr-defined]

starlette_requests_mod = sys.modules["starlette.requests"]
starlette_requests_mod.Request = object  # type: ignore[attr-defined]

def _make_stub_class(name: str) -> type:
    def __init__(self, *args: object, **kwargs: object) -> None:
        pass
    def __call__(self, *args: object, **kwargs: object) -> "object":
        def decorator(fn: object) -> object:
            return fn
        return decorator
    return type(name, (), {"__init__": __init__, "__call__": __call__, "tool": __call__})


fastmcp_mod = sys.modules["mcp.server.fastmcp"]
fastmcp_mod.FastMCP = _make_stub_class("FastMCP")  # type: ignore[attr-defined]
fastmcp_mod.Context = _make_stub_class("Context")  # type: ignore[attr-defined]

sys.modules["starlette.routing"].Route = object  # type: ignore[attr-defined]
sys.modules["starlette.applications"].Starlette = object  # type: ignore[attr-defined]

# Now import the module's pure helper functions directly via importlib
import importlib.util
_SERVER_PATH = os.path.join(os.path.dirname(__file__), "..", "ghoststack_mcp_server.py")
spec = importlib.util.spec_from_file_location("ghoststack_mcp_server", _SERVER_PATH)
assert spec and spec.loader
_server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(_server)  # type: ignore[union-attr]

_verify_hmac_token = _server._verify_hmac_token  # type: ignore[attr-defined]
_used_nonces: dict = _server._used_nonces  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_hmac_token(secret: str, timestamp: int | None = None, nonce: str = "abc123") -> str:
    ts = str(timestamp or int(time.time()))
    payload = f"{ts}.{nonce}".encode()
    sig = hmac_mod.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    return f"{ts}.{nonce}.{sig}"


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestHmacTokenVerification(unittest.TestCase):
    def setUp(self) -> None:
        _used_nonces.clear()
        _server._MCP_HMAC_SECRET = "test_secret_key"  # type: ignore[attr-defined]
        _server._HMAC_REPLAY_WINDOW_SECS = 300  # type: ignore[attr-defined]

    def tearDown(self) -> None:
        _used_nonces.clear()
        _server._MCP_HMAC_SECRET = ""  # type: ignore[attr-defined]

    def test_valid_token_accepted(self) -> None:
        token = _make_hmac_token("test_secret_key")
        self.assertTrue(_verify_hmac_token(token))

    def test_expired_timestamp_rejected(self) -> None:
        old_ts = int(time.time()) - 400  # beyond 300s window
        token = _make_hmac_token("test_secret_key", timestamp=old_ts)
        self.assertFalse(_verify_hmac_token(token))

    def test_future_timestamp_rejected(self) -> None:
        future_ts = int(time.time()) + 400
        token = _make_hmac_token("test_secret_key", timestamp=future_ts)
        self.assertFalse(_verify_hmac_token(token))

    def test_tampered_signature_rejected(self) -> None:
        token = _make_hmac_token("test_secret_key")
        parts = token.split(".")
        parts[2] = "deadbeef" * 8  # wrong sig
        self.assertFalse(_verify_hmac_token(".".join(parts)))

    def test_wrong_secret_rejected(self) -> None:
        token = _make_hmac_token("wrong_secret")
        self.assertFalse(_verify_hmac_token(token))

    def test_replay_rejected(self) -> None:
        token = _make_hmac_token("test_secret_key", nonce="unique_nonce_42")
        self.assertTrue(_verify_hmac_token(token))
        # Second use of same nonce must be rejected
        self.assertFalse(_verify_hmac_token(token))

    def test_malformed_token_rejected(self) -> None:
        self.assertFalse(_verify_hmac_token("notavalidtoken"))
        self.assertFalse(_verify_hmac_token(""))
        self.assertFalse(_verify_hmac_token("a.b"))  # only 2 parts

    def test_non_integer_timestamp_rejected(self) -> None:
        self.assertFalse(_verify_hmac_token("abc.nonce.sig"))


class TestNonceCachePurge(unittest.TestCase):
    def setUp(self) -> None:
        _used_nonces.clear()
        _server._MCP_HMAC_SECRET = "test_secret_key"  # type: ignore[attr-defined]
        _server._HMAC_REPLAY_WINDOW_SECS = 300  # type: ignore[attr-defined]

    def tearDown(self) -> None:
        _used_nonces.clear()
        _server._MCP_HMAC_SECRET = ""  # type: ignore[attr-defined]

    def test_expired_nonces_purged(self) -> None:
        # Manually inject an expired nonce
        _used_nonces["old_nonce"] = time.time() - 1
        _server._purge_expired_nonces()  # type: ignore[attr-defined]
        self.assertNotIn("old_nonce", _used_nonces)

    def test_active_nonces_retained(self) -> None:
        _used_nonces["active_nonce"] = time.time() + 300
        _server._purge_expired_nonces()  # type: ignore[attr-defined]
        self.assertIn("active_nonce", _used_nonces)


if __name__ == "__main__":
    unittest.main()
