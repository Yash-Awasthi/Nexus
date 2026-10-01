# SPDX-License-Identifier: Apache-2.0
"""
nexus-ingest auth middleware.

Uses a simple Bearer token scheme — the expected token is read from the
NEXUS_INGEST_API_KEY env var.  In production this is set via Doppler.

For unauthenticated routes (e.g. /health, /metrics, /docs) use the
`public_route` dependency instead, which is a no-op.
"""
from __future__ import annotations

import os
from typing import Annotated

from fastapi import Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

_bearer = HTTPBearer(auto_error=True)


def verify_token(
    credentials: Annotated[HTTPAuthorizationCredentials, Security(_bearer)],
) -> str:
    """FastAPI dependency — validates Bearer token against NEXUS_INGEST_API_KEY."""
    expected = os.getenv("NEXUS_INGEST_API_KEY", "")
    if not expected:
        # If env var is not set, auth is disabled (useful for local dev)
        return "anonymous"
    if credentials.credentials != expected:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return credentials.credentials


# Convenience type alias
AuthDep = Annotated[str, Depends(verify_token)]
